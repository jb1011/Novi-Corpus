import type { Context, Hono } from "hono";
import { verifyStripeSignature } from "../../adapters/stripe/identityClient";
import type { AuthVars } from "../../auth/middleware";
import { ApiError } from "../../errors";
import type { Secret } from "../../formation/pii";
import { type IdentitySessionDeps, syncSession } from "../../identity/sessions";
import { opsLog } from "../../observability/opsLog";
import { readCappedText } from "../../util/readStreamCapped";

/**
 * `POST /webhooks/stripe-identity/{sandbox|production}`: Stripe's call when an identity session
 * changes (identity check plan, Task 10). Public, and authenticated by Stripe's signature alone,
 * so it is a security boundary. It follows the doola receiver (`doolaWebhook.ts`) on every point
 * that receiver settled:
 *
 *  1. **A webhook is a wake-up signal, never a source of facts** (audit H2). This module reads
 *     exactly five things out of a verified event: its `id`, its `type`, `livemode`, and the
 *     session object's `id` (the provider's `vs_` id) and `client_reference_id` (ours). Nothing
 *     else in the payload is read, kept or logged: not its status, not its error, not an output.
 *     The session service reads the session back from Stripe over TLS with our key
 *     (`syncSession`), and every fact it writes comes from that read. A leaked signing secret
 *     therefore buys an attacker a redundant read of a session we already hold, not a fact.
 *  2. **The endpoint must be hard to disable.** Stripe retries a failed delivery for days and
 *     warns, then may disable, an endpoint that keeps failing. So once the signature has matched
 *     every exit is a 200: a stale event (a clock-skewed box), an event of another type, another
 *     mode or another session. Nothing is lost by it: the scheduler's sweep reads every open
 *     session again within minutes, webhook or not. A `timingSafeEqual` length mismatch, which
 *     throws, is checked for in `verifyStripeSignature` rather than allowed to become a 500.
 *
 * Per-environment paths (audit M4), so a rotation or the mainnet flip never mixes signature
 * domains: a request whose path environment is not this deployment's is a 404, before any
 * signature work. Stripe's test and live modes have separate endpoints and separate secrets, and
 * this deployment's mode is its environment's (`livemode` is true on production only).
 *
 * The route is mounted on the public side, before the session protection, and Stripe is pointed
 * at the backend origin directly (`PUBLIC_API_URL`): the Vercel proxy drops the signature header.
 *
 * What an ops line of this module may carry: the environment, Stripe's event id and type, our
 * session id once the event is proven to be about it, a reason, a code. Never the payload, never
 * the provider's `vs_` id, never the signature, never a secret.
 */

/** Stripe's signature header (`t=<unix seconds>,v1=<hex>`); Hono matches it case-insensitively. */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** The body-size control. An identity session event is a few kilobytes. */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * How far `t` may be from our clock, either way, in seconds: Stripe's own default. Stripe signs
 * every delivery afresh, a retry included, so a retry days later still arrives within it; only a
 * replay or a skewed clock falls outside it.
 */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

/** The events that wake a read: every change of an identity session, and no other type. */
const SESSION_EVENT_PREFIX = "identity.verification_session.";

/** One body for every signature failure, so no failure is distinguishable from another. */
const UNAUTHORIZED_BODY = { error: { code: "unauthorized", message: "invalid signature" } };
const NOT_FOUND_BODY = { error: { code: "not_found", message: "not found" } };
const TOO_LARGE_BODY = { error: { code: "payload_too_large", message: "payload too large" } };
const OK_BODY = { ok: true };

/** The webhook's settings (`cfg.stripeIdentity`'s signing secrets) and this deployment's environment. */
export interface StripeIdentityWebhookDeps {
  webhookSecret: Secret;
  /** Set during a rotation window; both are verified, so a rotation drops nothing. */
  webhookSecretPrevious?: Secret;
  environment: "sandbox" | "production";
}

/** A verified event, reduced to the five fields a wake-up may carry. */
export interface StripeIdentityEvent {
  eventId: string;
  type: string;
  livemode: boolean;
  /** `data.object.id`: the provider's session id (`vs_`) on a session event; null when absent. */
  providerRef: string | null;
  /** `data.object.client_reference_id`: our session id, as we gave it at the creation. */
  clientReferenceId: string | null;
}

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const objectOf = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * Parse a verified body. Returns null when it is not an event: not JSON, no id, no type, or a
 * `livemode` that is not a boolean (the mode check cannot judge what is not there, so it does not
 * guess). The session object's two ids are null when absent: that is for the session check to
 * refuse, not the parse.
 */
export function parseStripeEvent(rawBody: string): StripeIdentityEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const e = objectOf(parsed);
  if (e === null) return null;
  const eventId = nonEmptyString(e.id);
  const type = nonEmptyString(e.type);
  if (eventId === null || type === null || typeof e.livemode !== "boolean") return null;
  const object = objectOf(objectOf(e.data)?.object);
  return {
    eventId,
    type,
    livemode: e.livemode,
    providerRef: nonEmptyString(object?.id),
    clientReferenceId: nonEmptyString(object?.client_reference_id),
  };
}

/** The receiver's own overflow signal. Never leaves this module: the route turns it into a 413. */
class WebhookTooLargeError extends Error {}

/**
 * Read the body under a running byte cap, on the shared capped reader (M4). Read as text, before
 * any parse: the signature covers the raw bytes. `undefined` when the cap is exceeded.
 */
async function readCappedBody(c: Context, max: number): Promise<string | undefined> {
  try {
    return await readCappedText(
      {
        body: c.req.raw.body as ReadableStream<Uint8Array> | null | undefined,
        contentLength: c.req.header("content-length"),
        // No stream (an empty body, or a hand-rolled Request in a test): read it, and let the
        // shared reader check the result.
        readAll: async () => Buffer.from(await c.req.text(), "utf8"),
      },
      max,
      { declared: () => new WebhookTooLargeError(), streamed: () => new WebhookTooLargeError() },
    );
  } catch (e) {
    if (e instanceof WebhookTooLargeError) return undefined;
    throw e;
  }
}

/** One event's wake-up, as a coalesced read batches it: ids only, never the payload. */
interface WakeUp {
  eventId: string;
  type: string;
}

/** What a failed read is logged as: the refusal's code, or the error's class, never a message. */
const failureOf = (e: unknown): string =>
  e instanceof ApiError ? e.code : e instanceof Error ? e.name : "unknown";

/**
 * Mount the receiver. Called from the public block of `buildApiApp`, only where both the identity
 * check and the Stripe block are wired: a deployment without them has no such route, and answers
 * 404.
 *
 * Throws when the two blocks name different environments: the path and the mode check would
 * follow one and the session service's reads the other, so every event would be dropped.
 */
export function mountStripeIdentityWebhookRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: { identityCheck: IdentitySessionDeps; stripeIdentity: StripeIdentityWebhookDeps },
): void {
  const check = deps.identityCheck;
  const d = deps.stripeIdentity;
  if (d.environment !== check.environment)
    throw new Error(
      `the Stripe Identity webhook's environment (${d.environment}) is not the identity check's (${check.environment})`,
    );
  const environment = d.environment;
  const livemode = environment === "production";
  const nowSeconds = () => Math.floor((check.now ?? Date.now)() / 1000);

  app.post("/webhooks/stripe-identity/:environment", async (c) => {
    // ── 0. Environment path (audit M4). The cheapest refusal, and a Stripe endpoint pointed at
    //       the wrong deployment must look like a wrong URL, not like a secret problem.
    if (c.req.param("environment") !== environment) return c.json(NOT_FOUND_BODY, 404);

    // ── 1. Size. 413 rather than the constant 401: a size refusal is not a signature verdict.
    const raw = await readCappedBody(c, STRIPE_WEBHOOK_MAX_BODY_BYTES);
    if (raw === undefined) {
      opsLog("identity_webhook_oversize", { level: "warn", environment });
      return c.json(TOO_LARGE_BODY, 413);
    }

    // ── 2. Signature over the raw body, both secrets, on the deps' clock. Every failure (no
    //       header, no `t`, an unreadable or wrong `v1`) is the same 401, and none is a 500. The
    //       secrets leave their wrappers here, for the HMAC, and go nowhere else.
    const verdict = verifyStripeSignature(
      raw,
      c.req.header(STRIPE_SIGNATURE_HEADER),
      [d.webhookSecret.reveal(), d.webhookSecretPrevious?.reveal()],
      nowSeconds(),
      STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    );
    if (verdict === "bad") {
      // No detail: which check failed is what a prober wants, and the runbook has the answer.
      opsLog("identity_webhook_unauthorized", { level: "warn", environment });
      return c.json(UNAUTHORIZED_BODY, 401);
    }

    // ── 3. From here the body is proven to be Stripe's, so every exit is a 200.
    const event = parseStripeEvent(raw);

    // Stale: authentic, but outside the tolerance. Never a 4xx, which would only teach Stripe to
    // retry, and then to disable, an endpoint behind a skewed clock. The id names the event an
    // operator can resend from the dashboard once the clock is fixed.
    if (verdict === "stale") {
      opsLog("identity_webhook_stale", {
        level: "warn",
        environment,
        eventId: event?.eventId ?? null,
        type: event?.type ?? null,
      });
      return c.json(OK_BODY, 200);
    }
    if (event === null) {
      opsLog("identity_webhook_unparsable", { level: "warn", environment });
      return c.json(OK_BODY, 200);
    }

    // Another type: the endpoint was subscribed to more than it needs. Nothing to do.
    if (!event.type.startsWith(SESSION_EVENT_PREFIX)) return c.json(OK_BODY, 200);

    const ids = { environment, eventId: event.eventId, type: event.type };

    // ── 4. The mode. A test-mode event on production, or a live one on a sandbox, is about no
    //       session of this deployment, whatever its ids say.
    if (event.livemode !== livemode) {
      opsLog("identity_webhook_dropped", { level: "warn", ...ids, reason: "mode" });
      return c.json(OK_BODY, 200);
    }

    // ── 5. The session: found by the provider's id, and only if the event's reference is the
    //       one we gave that session. A session of another deployment sharing the Stripe
    //       account, or one made in the dashboard, is not ours. Our id is not logged here: the
    //       event has not proven it is about our session.
    const session =
      event.providerRef === null ? undefined : check.sessions.byProviderRef(event.providerRef);
    if (session === undefined || session.sessionId !== event.clientReferenceId) {
      opsLog("identity_webhook_dropped", { ...ids, reason: "unknown_session" });
      return c.json(OK_BODY, 200);
    }
    const { sessionId } = session;
    opsLog("identity_webhook_received", { ...ids, sessionId });

    // ── 6. Ack now, read after. The task is tracked so SIGTERM can drain it and tests can join
    //       it. A read of a session already closed reads nothing (`unchanged`), so a redelivery
    //       is harmless. A failed read is the service's to log in full; here it is one line with
    //       its code, caught, so the tracker's own failure line (which carries an error's
    //       message) is never reached. The sweep reads the session again.
    //
    //       COALESCED per session (ruling R25, the doola receiver's M5). Stripe sends
    //       `processing` then `verified` within moments, and two reads at once would each read
    //       the birth date and screen the person. So one read runs at a time per session: an
    //       event that arrives while one runs joins one further read after it, never lost (that
    //       read may have begun before the change the event tells of), and every event arriving
    //       meanwhile joins the same one. After a completion that further read finds the session
    //       closed and reads nothing.
    check.tasks.trackCoalesced<WakeUp>(
      `identity_session:${sessionId}`,
      { eventId: event.eventId, type: event.type },
      async (batch) => {
        // The newest wake-up names the read in its ops line: it is the one a stale read missed.
        const lead = batch[batch.length - 1] ?? { eventId: event.eventId, type: event.type };
        try {
          await syncSession(check, sessionId);
        } catch (e) {
          opsLog("identity_webhook_sync_failed", {
            level: "warn",
            environment,
            ...lead,
            sessionId,
            failure: failureOf(e),
          });
        }
      },
    );
    return c.json(OK_BODY, 200);
  });
}
