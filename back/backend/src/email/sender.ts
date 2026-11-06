import { opsLog } from "../observability/opsLog";

/**
 * THE EMAIL SENDER: the one interface every email in the product goes out through (the outbox's
 * delivery job calls it; nothing else does). Two implementations: the provider adapter beside
 * this file and the console sender below, which stands in for it on a deployment that sends
 * nothing (the staging instance) and writes one ops line per email instead.
 *
 * What neither sender ever does: print an address or a body. An ops line carries ids, states and
 * codes (the global rule for this codebase's logs), and an email's body carries links meant for
 * one person only.
 */

/** One email, as the outbox hands it over. */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** 1 to 256 characters. The provider keeps it 24 hours: a second send with the same key and the
   *  same payload sends nothing new and answers the first send's id, which is what makes a retry
   *  after a lost answer safe. The same key with a different payload is refused. */
  idempotencyKey: string;
  tags?: { name: string; value: string }[];
}

export interface EmailSender {
  readonly kind: "resend" | "console";
  /** Throws `EmailSendError` (status, code, retryable). */
  send(e: OutboundEmail): Promise<{ providerMessageId: string }>;
  /** Adds the address to the marketing segment. Without `segmentId` it is a no-op that logs
   *  `contact_upsert_skipped` and answers `CONTACT_UPSERT_SKIPPED`. Throws `EmailSendError`. */
  upsertContact(c: {
    email: string;
    unsubscribed?: boolean;
    segmentId?: string;
  }): Promise<{ providerContactId: string }>;
}

/**
 * A send or a contact write that did not happen.
 *
 * `retryable` is the one thing the delivery job branches on: a timeout, a network error, a 429 or a
 * 5xx is worth another attempt (with the same idempotency key, so a send whose answer was lost is
 * not sent twice); any other refusal is not, and the row fails at once.
 *
 * `status` is the HTTP status, or null when no answer arrived (a timeout, a network error) or the
 * request was refused before it was sent. `code` is a short machine code (the provider's error
 * name, `http_<status>`, or one of ours: `timeout`, `network_error`, `invalid_response`,
 * `invalid_idempotency_key`). The message is built from those two alone, never from a body the
 * provider wrote: a validation message can quote the address it refused.
 */
export class EmailSendError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`email provider call failed: ${status ?? "no answer"} ${code}`);
    this.name = "EmailSendError";
  }
}

/** What `upsertContact` answers when there is no segment to add the address to. */
export const CONTACT_UPSERT_SKIPPED = "skipped";

/** The provider's bounds on an idempotency key, checked by both senders: a key the provider would
 *  refuse is caught on the console sender too, on staging, before it reaches production. */
export function assertIdempotencyKey(key: string): void {
  if (key.length < 1 || key.length > 256)
    throw new EmailSendError(null, "invalid_idempotency_key", false);
}

/**
 * The sender of a deployment that sends nothing: each email becomes one `email_console` ops line
 * with the sender's kind, the subject and the idempotency key. The outbox row still ends `sent`,
 * with `console:<key>` as its message id.
 *
 * With `showBody` (EMAIL_CONSOLE_SHOW_BODY, which production refuses at boot) the line also
 * carries the text body, so a staging tester can follow the link an email holds. Never the HTML,
 * and never the address: wherever the recipient's address appears in the subject or the body it
 * is printed as `<recipient>`.
 */
export class ConsoleEmailSender implements EmailSender {
  readonly kind = "console" as const;
  private readonly showBody: boolean;

  constructor(opts: { showBody?: boolean } = {}) {
    this.showBody = opts.showBody ?? false;
  }

  async send(e: OutboundEmail): Promise<{ providerMessageId: string }> {
    assertIdempotencyKey(e.idempotencyKey);
    opsLog("email_console", {
      kind: this.kind,
      subject: withoutAddress(e.subject, e.to),
      idempotencyKey: e.idempotencyKey,
      ...(this.showBody ? { text: withoutAddress(e.text, e.to) } : {}),
    });
    return { providerMessageId: `console:${e.idempotencyKey}` };
  }

  async upsertContact(c: {
    email: string;
    unsubscribed?: boolean;
    segmentId?: string;
  }): Promise<{ providerContactId: string }> {
    if (!c.segmentId) {
      opsLog("contact_upsert_skipped", { kind: this.kind });
      return { providerContactId: CONTACT_UPSERT_SKIPPED };
    }
    opsLog("email_console_contact", { kind: this.kind, segmentId: c.segmentId });
    return { providerContactId: "console:contact" };
  }
}

/** `text` with every occurrence of `address` (in any case) replaced by `<recipient>`. */
function withoutAddress(text: string, address: string): string {
  if (address === "") return text;
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), "<recipient>");
}

/**
 * What the API process holds of the email system, present only where `cfg.email` is (the email
 * system is wired only when configured; the testnet box configures none of it).
 *
 * These are the fields the sender task can fill. Task 12b moves this interface into
 * `src/email/outbox.ts`, beside the outbox it adds as `outbox: EmailOutbox`, which is where the
 * plan's contract places it and where its consumers import it from.
 */
export interface EmailDeps {
  sender: EmailSender;
  /** The app's public origin, no trailing slash: every link in an email is built on it. */
  publicAppUrl: string;
  /** One line, printed at the foot of every email. */
  postalAddress: string;
  /** The marketing segment contacts are added to; absent, contact writes are skipped. */
  marketingSegmentId?: string;
}
