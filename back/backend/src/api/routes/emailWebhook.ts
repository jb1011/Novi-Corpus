import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { type DeliveryState, type EmailDeps, warnIfUndelivered } from "../../email/outbox";
import {
  SVIX_ID_HEADER,
  SVIX_SIGNATURE_HEADER,
  SVIX_TIMESTAMP_HEADER,
  svixSigningKey,
  verifySvixSignature,
} from "../../email/svix";
import { opsLog } from "../../observability/opsLog";
import { readCappedBody } from "../cappedBody";

/**
 * `POST /email/webhook/resend`: the email provider's delivery webhook, Svix-signed
 * (src/email/svix.ts), recording what happened to a sent email on its outbox row
 * (`EmailOutbox.recordDelivery`).
 *
 * The order of the checks, and what each answers:
 *  1. the raw body, read under a 16 KiB cap through the webhooks' capped reader: over it, 413
 *     (a size refusal is not a signature verdict);
 *  2. the Svix signature over that raw body, with the three `svix-*` headers: a missing header, a
 *     timestamp more than five minutes from now (either way) or no matching candidate is the same
 *     401, which writes nothing; the ops line carries the refusal's code, never the signature;
 *  3. from here the event is PROVEN to be the provider's, so every answer is a 200. The provider
 *     retries a failed delivery eight times over about a day, and a retry cannot teach us an id we
 *     never sent: an event we do not record, or a body we cannot read, is answered 200 and
 *     written nowhere. A delivery event for an id no sent email carries is kept as an orphan
 *     (`recordDeliveryEvent`): the row may still be pending, its send's answer lost and retried
 *     under the same key, or the event raced the send; the delivery job applies it when it writes
 *     that id on the row, and deletes it after 7 days otherwise (a campaign email from the same
 *     provider account never matches).
 *
 * The six delivery events record their state on the row (`RESEND_DELIVERY_EVENTS`) at the
 * EVENT'S OWN TIME, the signed body's top-level `created_at` (`eventTimeMs`): never the
 * `svix-timestamp`, which is re-signed on every retry, so a retried old event would pass for a new
 * one. The outbox keeps the newest event and never lets `delayed` overwrite an outcome
 * (`recordDelivery`). Every state but `delivered` and `delayed` (a bounce, a complaint, a failure,
 * a suppression) also writes the `email_bounced` WARN line when it is recorded (for an orphan,
 * when the delivery job records it), so an operator looks the same day: an undelivered filing
 * email means the customer has no way back, and the runbook says to reach them another way; an
 * event the outbox ignores (older, or redelivered) writes none. Every line carries ids, the kind, the state and codes; never the body (it holds the
 * recipient's address and the subject), an address, a signature or the secret, and an identity
 * link's subject (a tenant id) is cut to its first ten characters, as the outbox's own lines do.
 *
 * Every answer is `Cache-Control: no-store`.
 *
 * Mounted on the PUBLIC side, before `protect()`: the provider authenticates with the signature,
 * not with our session. Mounted only where the email system is wired with the provider's sender
 * (`ApiDeps.email.webhookSecret`); elsewhere the path is not mounted (404), the testnet box
 * included. The provider is pointed at the backend's own origin, never at the web proxy, which
 * does not forward the signature headers (the doola webhook's lesson).
 */

export const RESEND_WEBHOOK_PATH = "/email/webhook/resend";

/** The body cap. A delivery event is a few hundred bytes; 16 KiB clears any we record. */
export const EMAIL_WEBHOOK_MAX_BODY_BYTES = 16 * 1024;

/** The provider's delivery events, and the state each records. A Map, not an object literal: an
 *  event type is the sender's text, and `"constructor"` must not find `Object`'s. */
export const RESEND_DELIVERY_EVENTS: ReadonlyMap<string, DeliveryState> = new Map([
  ["email.delivered", "delivered"],
  ["email.delivery_delayed", "delayed"],
  ["email.bounced", "bounced"],
  ["email.complained", "complained"],
  ["email.failed", "failed"],
  ["email.suppressed", "suppressed"],
]);

/** An ISO 8601 date and time, as the provider writes `created_at`; checked before `Date.parse`,
 *  which also reads a bare "7" as a date in 2001. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * The time an event is recorded at: its own `created_at`, when it reads as an ISO date and time;
 * otherwise now. A time ahead of now (a skewed clock, ours or theirs) is clamped to now, so an
 * event cannot reserve the row against the events that follow it.
 */
export function eventTimeMs(createdAt: string | null, nowMs: number): number {
  const t =
    createdAt !== null && ISO_DATE_TIME.test(createdAt) ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(t) ? Math.min(t, nowMs) : nowMs;
}

/** The longest provider id we read: the provider's are UUIDs. */
const MAX_EMAIL_ID_LENGTH = 256;

const UNAUTHORIZED_BODY = { error: { code: "unauthorized", message: "invalid signature" } };
const TOO_LARGE_BODY = { error: { code: "payload_too_large", message: "payload too large" } };
const OK_BODY = { ok: true };

/**
 * The three things this route reads out of a VERIFIED body: the event's type, its own time (the
 * top-level `created_at`; `data.created_at` is the email's, the same for all its events) and, for
 * a delivery event, the provider's id of the email. `undefined` when the body is not an event;
 * `emailId` or `createdAt` null when the event carries no usable one. Nothing else is read: the
 * rest of the body is the recipient's address, the subject and the provider's own text.
 */
export function parseResendEvent(
  rawBody: string,
): { type: string; emailId: string | null; createdAt: string | null } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const e = parsed as Record<string, unknown>;
  if (typeof e.type !== "string") return undefined;
  const data = e.data;
  const id =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>).email_id : null;
  const emailId =
    typeof id === "string" && id.trim().length > 0 && id.length <= MAX_EMAIL_ID_LENGTH
      ? id.trim()
      : null;
  const createdAt = typeof e.created_at === "string" ? e.created_at : null;
  return { type: e.type, emailId, createdAt };
}

/**
 * Mount the route. Called from the PUBLIC block of `buildApiApp`, only where `email.webhookSecret`
 * is set (the provider's sender); the key is decoded here once, and a malformed secret fails the
 * boot rather than every delivery.
 */
export function mountEmailWebhookRoutes(
  app: Hono<{ Variables: AuthVars }>,
  email: EmailDeps & { webhookSecret: string },
  now: () => number,
) {
  const key = svixSigningKey(email.webhookSecret);

  // On every answer, the route's own and an error's: set after the handler has answered.
  app.use(RESEND_WEBHOOK_PATH, async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.post(RESEND_WEBHOOK_PATH, async (c) => {
    // ── 1. Size, before anything is verified or parsed.
    const raw = await readCappedBody(c, EMAIL_WEBHOOK_MAX_BODY_BYTES);
    if (raw === undefined) {
      opsLog("email_webhook_oversize", { level: "warn" });
      return c.json(TOO_LARGE_BODY, 413);
    }

    // ── 2. The signature over the RAW body. One 401 for every refusal; the code is for the line.
    const verdict = verifySvixSignature(
      key,
      raw,
      {
        id: c.req.header(SVIX_ID_HEADER),
        timestamp: c.req.header(SVIX_TIMESTAMP_HEADER),
        signature: c.req.header(SVIX_SIGNATURE_HEADER),
      },
      now(),
    );
    if (verdict !== "verified") {
      opsLog("email_webhook_unauthorized", { level: "warn", reason: verdict });
      return c.json(UNAUTHORIZED_BODY, 401);
    }

    // ── 3. The provider's event: every answer from here is a 200.
    const event = parseResendEvent(raw);
    if (event === undefined) {
      opsLog("email_webhook_unparsable", { level: "warn" });
      return c.json(OK_BODY, 200);
    }
    const state = RESEND_DELIVERY_EVENTS.get(event.type);
    // Not a delivery event (sent, opened, clicked, ...): nothing to record.
    if (state === undefined) return c.json(OK_BODY, 200);
    if (event.emailId === null) {
      opsLog("email_webhook_unparsable", { level: "warn", type: event.type });
      return c.json(OK_BODY, 200);
    }

    const result = email.outbox.recordDeliveryEvent(
      event.emailId,
      state,
      eventTimeMs(event.createdAt, now()),
    );
    if (result.row === undefined) {
      // No sent email has the id yet: kept, for a row still pending or one being sent; or never
      // ours (another sender on the provider's account, a campaign, a contact).
      opsLog("email_delivery_unmatched", {
        level: "info",
        providerMessageId: event.emailId,
        type: event.type,
      });
      return c.json(OK_BODY, 200);
    }
    // Only an event the outbox recorded warns: an older one, or the same one redelivered, is not
    // news to the operator.
    if (result.recorded) warnIfUndelivered(result.row, state);
    return c.json(OK_BODY, 200);
  });
}
