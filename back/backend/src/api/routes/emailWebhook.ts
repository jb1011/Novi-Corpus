import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { type DeliveryState, type EmailDeps, subjectRefForLog } from "../../email/outbox";
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
 *     never sent: an event we do not record, an id no sent email carries, or a body we cannot
 *     read is answered 200 and written nowhere.
 *
 * The six delivery events record their state on the row (`RESEND_DELIVERY_EVENTS`); a bounce and
 * a complaint also write the `email_bounced` WARN line, so an operator looks the same day: a
 * bounced filing email means the customer has no way back, and the runbook says to reach them
 * another way. Every line carries ids, the kind, the state and codes; never the body (it holds the
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

/** The states an operator must act on the same day. */
const WARN_STATES: ReadonlySet<DeliveryState> = new Set(["bounced", "complained"]);

/** The longest provider id we read: the provider's are UUIDs. */
const MAX_EMAIL_ID_LENGTH = 256;

const UNAUTHORIZED_BODY = { error: { code: "unauthorized", message: "invalid signature" } };
const TOO_LARGE_BODY = { error: { code: "payload_too_large", message: "payload too large" } };
const OK_BODY = { ok: true };

/**
 * The two things this route reads out of a VERIFIED body: the event's type and, for a delivery
 * event, the provider's id of the email. `undefined` when the body is not an event; `emailId` null
 * when the event carries no usable id. Nothing else is read: the rest of the body is the
 * recipient's address, the subject and the provider's own text.
 */
export function parseResendEvent(
  rawBody: string,
): { type: string; emailId: string | null } | undefined {
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
  return { type: e.type, emailId };
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

    const row = email.outbox.findSent(event.emailId);
    if (row === undefined) {
      // Not an email this outbox sent: another sender on the provider's account, or a contact.
      opsLog("email_delivery_unmatched", {
        level: "info",
        providerMessageId: event.emailId,
        type: event.type,
      });
      return c.json(OK_BODY, 200);
    }
    email.outbox.recordDelivery(event.emailId, state, now());
    if (WARN_STATES.has(state))
      opsLog("email_bounced", {
        level: "warn",
        severity: "WARN",
        emailId: row.emailId,
        kind: row.kind,
        subjectRef: subjectRefForLog(row),
        state,
      });
    return c.json(OK_BODY, 200);
  });
}
