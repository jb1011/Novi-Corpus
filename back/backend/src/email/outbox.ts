import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Config } from "../config/env";
import { opsLog } from "../observability/opsLog";
import {
  type DeliveryState,
  type DueEmail,
  type OutboxFilter,
  type OutboxKind,
  type OutboxRow,
  SqliteEmailOutboxRepository,
} from "../persistence/emailOutboxRepository";
import { ResendEmailSender } from "./resend";
import { ConsoleEmailSender, EmailSendError, type EmailSender } from "./sender";

export {
  DELIVERY_STATES,
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
} from "../persistence/emailOutboxRepository";
export type {
  DeliveryState,
  OutboxFilter,
  OutboxKind,
  OutboxRow,
  OutboxStatus,
} from "../persistence/emailOutboxRepository";

/**
 * THE EMAIL OUTBOX: every email the product sends is a row in `email_outbox` first, and leaves it
 * through one path, the scheduler's `email_deliver` job, which hands each row to the deployment's
 * sender (`EmailSender`, the provider or the console). A caller never sends: it enqueues, once per
 * idempotency key, and the job delivers. The provider's delivery webhook records what happened to
 * a sent email (`recordDeliveryEvent`: src/api/routes/emailWebhook.ts); the operator's
 * commands (src/cli/email.ts) list the rows, re-queue a failed one, and queue the beta's
 * identity link.
 *
 * The delivery rules, each held by test/email/deliverJob.test.ts:
 *  - every 30 seconds, the pending rows that are due, the longest-due first, at most 20 a run, one
 *    at a time (never in parallel: the provider's rate limit and the shutdown drain stay bounded);
 *  - a run takes no new row once 45 seconds have passed in it, or once the scheduler's stop signal
 *    is set (the shutdown waits at most 20 seconds, and one send may take 10): the row going
 *    finishes, the rest wait for the next run;
 *  - each send carries the row's idempotency key, so a send whose answer was lost, retried, is
 *    not sent twice; a contact write (`contact_upsert`) goes to `upsertContact`, which is keyed by
 *    the address itself;
 *  - a success: `sent`, with the provider's id and the time, and the address, the text and the
 *    HTML cleared (they hold codes, tokens and links meant for one person). The same transaction
 *    applies the delivery events that arrived for that id before the row held it (the orphans:
 *    a send whose answer was lost, an `email.suppressed` that raced the send), by the same
 *    ordering rules as the webhook's, and an undelivered end state writes its `email_bounced`
 *    WARN line then. A send another process recorded first is not counted: an
 *    `email_sent_unrecorded` warning;
 *  - every run deletes the orphans older than 7 days: events for emails this outbox never sent
 *    (campaign emails from the same provider account reach the same webhook);
 *  - a retryable error: one more attempt counted, the next one `min(2^attempts, 60)` minutes
 *    later (2, 4, 8, 16, 32, 60, 60, 60), and an `email_retry` warning; the ninth failure, or a
 *    refusal (not retryable) at once, fails the row with a CRITICAL `email_failed` line. A failed
 *    row keeps its address and content, so `email:resend` can put it back;
 *  - every line carries ids, the kind, counts, the HTTP status and the provider's code (a 429
 *    `daily_quota_exceeded` will not clear with backoff, so the operator must see it), never an
 *    address, a body or a provider's message.
 *
 * On a deployment with the console sender the "delivery" is its ops line, and the row still ends
 * `sent`.
 */

/** The job's interval. */
export const EMAIL_DELIVER_EVERY_MS = 30_000;
/** The most rows one run sends. */
export const EMAIL_DELIVER_LIMIT = 20;
/** A run takes no new row after this long: 1.5 times its interval, so a slow provider cannot
 *  pile up skipped ticks or hold the shutdown. */
export const EMAIL_DELIVER_BUDGET_MS = 45_000;
/** How long a delivery event no sent row claims is kept (ms): 7 days, past any retry of a row
 *  whose answer was lost and any `email:resend` of it within the week. */
export const EMAIL_ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Retryable failures that are retried; the next one fails the row. */
export const EMAIL_MAX_RETRIES = 8;
/** The longest wait between two attempts, in minutes. */
const MAX_RETRY_WAIT_MINUTES = 60;
const MINUTE_MS = 60_000;

/**
 * What the API process holds of the email system, present only where `cfg.email` is (the email
 * system is wired only when configured; the testnet box configures none of it).
 */
export interface EmailDeps {
  sender: EmailSender;
  outbox: EmailOutbox;
  /** The app's public origin, no trailing slash: every link in an email is built on it. */
  publicAppUrl: string;
  /** One line, printed at the foot of every email. */
  postalAddress: string;
  /** The marketing segment contacts are added to; absent, contact writes are skipped. */
  marketingSegmentId?: string;
  /** The provider's delivery-webhook signing secret (`whsec_` and base64), present only with the
   *  provider's sender; absent, the webhook route is not mounted. A secret: never logged. */
  webhookSecret?: string;
}

/** What one run did: the job's counts on its `job_ran` line. */
export type DeliverCounts = { sent: number; retried: number; failed: number };

export interface DeliverOptions {
  /** The scheduler's stop signal: once set, the run takes no new row. */
  signal?: AbortSignal;
}

export interface EmailOutbox {
  /** Written once per key: a second enqueue with the same key writes nothing and answers the
   *  first row's id with `inserted: false`. A contact write has no subject and no body; every
   *  other kind has all three. Subjects carry no personal data, and keys never hold an address,
   *  a code or a token. */
  enqueue(e: {
    kind: OutboxKind;
    subjectRef: string | null;
    idempotencyKey: string;
    to: string;
    subject?: string;
    text?: string;
    html?: string;
  }): { emailId: string; inserted: boolean };
  /** One run of the job: the rules in this file's header. */
  deliverDue(
    sender: EmailSender,
    nowMs: number,
    limit?: number,
    opts?: DeliverOptions,
  ): Promise<DeliverCounts>;
  /** The provider's delivery event, on the sent email it names, at the event's own time; false
   *  when nothing was written: no sent email has that id, an event at the same time or later is
   *  recorded already, or the event is `delayed` and the row holds a final state. */
  recordDelivery(providerMessageId: string, state: DeliveryState, atMs: number): boolean;
  /**
   * The webhook's path, in one immediate transaction: the event recorded on the sent email its
   * id names (`recorded` as `recordDelivery` answers it), or, where no sent email has the id,
   * kept as an orphan (`row` undefined) until a row is sent with it, or for 7 days. The one
   * transaction leaves no gap between the lookup and the write for the delivery job's own.
   */
  recordDeliveryEvent(
    providerMessageId: string,
    state: DeliveryState,
    atMs: number,
  ): { row: OutboxRow; recorded: boolean } | { row: undefined };
  /** The sent email a provider id names, as anyone may read it (never the address or the
   *  content); undefined for an unknown id, a row not sent, or a contact write's id. */
  findSent(providerMessageId: string): OutboxRow | undefined;
  /** A failed row back to pending, due now, with its attempts counted from zero and the address
   *  the caller supplies (re-read from the row the email is about); false for any other row. */
  requeue(emailId: string, to: string): boolean;
  /** The oldest first (with `limit`, the newest that many); never the address, the text or the
   *  HTML. */
  list(filter: OutboxFilter): OutboxRow[];
  /** The row an email id names, in any state, as anyone may read it; undefined for none. */
  find(emailId: string): OutboxRow | undefined;
  /** The row an idempotency key names, in any state, as anyone may read it; undefined for none. */
  findByKey(idempotencyKey: string): OutboxRow | undefined;
}

/** The wait after a retryable failure, `attempts` being the failures counted with this one. */
export function retryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts, MAX_RETRY_WAIT_MINUTES) * MINUTE_MS;
}

/** A failure as the row and the lines keep it: an HTTP status and a code, never a message. */
function describeFailure(err: unknown): {
  status: number | null;
  code: string;
  retryable: boolean;
} {
  if (err instanceof EmailSendError)
    return { status: err.status, code: err.code, retryable: err.retryable };
  // Not the sender's own error: nothing says whether the email left, and a retry with the same
  // key is safe either way. Its message is dropped: it may quote what it was handed.
  return { status: null, code: "unexpected_error", retryable: true };
}

/** The delivery states an operator must act on the same day: the email did not reach the
 *  customer, or the customer refused it. */
export const WARN_DELIVERY_STATES: ReadonlySet<DeliveryState> = new Set([
  "bounced",
  "complained",
  "failed",
  "suppressed",
]);

/** A tenant id is a wallet address: a line carries its first ten characters, as every line that
 *  names a tenant does (`truncateTenant`). The other refs are our own ids and hashes. Every line
 *  that names a row's subject prints it through this. */
export function subjectRefForLog(row: Pick<OutboxRow, "kind" | "subjectRef">): string | null {
  return row.kind === "identity_link" && row.subjectRef !== null
    ? `${row.subjectRef.slice(0, 10)}…`
    : row.subjectRef;
}

/** The WARN line of a recorded undelivered state (`WARN_DELIVERY_STATES`); nothing for another
 *  state. One shape, from the webhook and from the delivery job's late orphans alike. */
export function warnIfUndelivered(
  row: Pick<OutboxRow, "emailId" | "kind" | "subjectRef">,
  state: DeliveryState,
): void {
  if (!WARN_DELIVERY_STATES.has(state)) return;
  opsLog("email_bounced", {
    level: "warn",
    severity: "WARN",
    emailId: row.emailId,
    kind: row.kind,
    subjectRef: subjectRefForLog(row),
    state,
  });
}

export class SqliteEmailOutbox implements EmailOutbox {
  private readonly db: Database.Database;
  private readonly repo: SqliteEmailOutboxRepository;
  private readonly now: () => number;
  private readonly marketingSegmentId: string | undefined;

  constructor(
    db: Database.Database,
    opts: {
      /** The clock of every time the outbox writes, and of a run's 45 seconds. */
      now?: () => number;
      /** Where a contact write adds the address; absent, the sender skips it. */
      marketingSegmentId?: string;
    } = {},
  ) {
    this.db = db;
    this.repo = new SqliteEmailOutboxRepository(db);
    this.now = opts.now ?? Date.now;
    this.marketingSegmentId = opts.marketingSegmentId;
  }

  enqueue(e: Parameters<EmailOutbox["enqueue"]>[0]): { emailId: string; inserted: boolean } {
    const emailId = `em_${randomUUID()}`;
    const inserted = this.repo.insert({
      emailId,
      kind: e.kind,
      subjectRef: e.subjectRef,
      idempotencyKey: e.idempotencyKey,
      to: e.to,
      subject: e.subject ?? null,
      text: e.text ?? null,
      html: e.html ?? null,
      createdAt: this.now(),
    });
    if (inserted) return { emailId, inserted: true };
    const existing = this.repo.findIdByKey(e.idempotencyKey);
    if (existing === undefined)
      throw new Error("email outbox: the enqueue was neither written nor found by its key");
    return { emailId: existing, inserted: false };
  }

  async deliverDue(
    sender: EmailSender,
    nowMs: number,
    limit: number = EMAIL_DELIVER_LIMIT,
    opts: DeliverOptions = {},
  ): Promise<DeliverCounts> {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error(`email outbox: the limit must be a positive whole number, not ${limit}`);
    const counts: DeliverCounts = { sent: 0, retried: 0, failed: 0 };
    if (opts.signal?.aborted) return counts;
    this.repo.deleteOrphansReceivedBefore(this.now() - EMAIL_ORPHAN_KEEP_MS);
    const startedAt = this.now();
    for (const row of this.repo.listDue(nowMs, limit)) {
      if (opts.signal?.aborted || this.now() - startedAt >= EMAIL_DELIVER_BUDGET_MS) break;
      let providerMessageId: string;
      try {
        providerMessageId = await this.deliverOne(sender, row);
      } catch (err) {
        const moved = this.recordFailure(row, err);
        if (moved !== null) counts[moved] += 1;
        continue;
      }
      // Outside the catch: a write that fails here is the run's failure (`job_failed`), not the
      // send's. The row stays pending, and the next run's send, with the same key, is answered
      // with this one's id.
      if (this.markSent(row, providerMessageId)) {
        counts.sent += 1;
      } else {
        // Another process (a manual `scheduler:run`) recorded the row first: its send is the one
        // counted, and the provider answered this one, under the same key, with the same email.
        opsLog("email_sent_unrecorded", { level: "warn", emailId: row.emailId, kind: row.kind });
      }
    }
    return counts;
  }

  recordDelivery(providerMessageId: string, state: DeliveryState, atMs: number): boolean {
    return this.repo.recordDelivery(providerMessageId, state, atMs);
  }

  recordDeliveryEvent(
    providerMessageId: string,
    state: DeliveryState,
    atMs: number,
  ): { row: OutboxRow; recorded: boolean } | { row: undefined } {
    return this.db
      .transaction(() => {
        const row = this.repo.findSent(providerMessageId);
        if (row === undefined) {
          this.repo.keepOrphan(providerMessageId, state, atMs, this.now());
          return { row: undefined };
        }
        return { row, recorded: this.repo.recordDelivery(providerMessageId, state, atMs) };
      })
      .immediate();
  }

  findSent(providerMessageId: string): OutboxRow | undefined {
    return this.repo.findSent(providerMessageId);
  }

  requeue(emailId: string, to: string): boolean {
    return this.repo.requeue(emailId, to, this.now());
  }

  list(filter: OutboxFilter): OutboxRow[] {
    return this.repo.list(filter);
  }

  find(emailId: string): OutboxRow | undefined {
    return this.repo.find(emailId);
  }

  findByKey(idempotencyKey: string): OutboxRow | undefined {
    return this.repo.findByKey(idempotencyKey);
  }

  /**
   * The row sent, and the delivery events kept for its id applied in the same transaction, the
   * oldest first, through `recordDelivery`'s rules (the newest wins, `delayed` never overwrites
   * an outcome), then deleted. Once it has committed, an undelivered end state writes its WARN
   * line. False, with nothing applied, when the row was no longer pending.
   */
  private markSent(row: DueEmail, providerMessageId: string): boolean {
    const outcome = this.db
      .transaction(() => {
        if (!this.repo.markSent(row.emailId, providerMessageId, this.now())) return undefined;
        let recorded = false;
        for (const orphan of this.repo.takeOrphans(providerMessageId))
          if (this.repo.recordDelivery(providerMessageId, orphan.state, orphan.eventAt))
            recorded = true;
        return { state: recorded ? (this.repo.find(row.emailId)?.deliveryState ?? null) : null };
      })
      .immediate();
    if (outcome === undefined) return false;
    if (outcome.state !== null) warnIfUndelivered(row, outcome.state);
    return true;
  }

  /** The provider's id for the email (or the contact). */
  private async deliverOne(sender: EmailSender, row: DueEmail): Promise<string> {
    // Without a segment the sender skips the write and answers `skipped`, and the row ends sent:
    // the consent itself stays proven in our tables.
    if (row.kind === "contact_upsert") {
      const { providerContactId } = await sender.upsertContact({
        email: row.to,
        ...(this.marketingSegmentId ? { segmentId: this.marketingSegmentId } : {}),
      });
      return providerContactId;
    }
    // The table refuses an email without its content; a row read without it is refused here too.
    if (row.content === null) throw new EmailSendError(null, "missing_content", false);
    const { providerMessageId } = await sender.send({
      to: row.to,
      subject: row.content.subject,
      text: row.content.text,
      html: row.content.html,
      idempotencyKey: row.idempotencyKey,
    });
    return providerMessageId;
  }

  /**
   * The failure, on the row and in its line; which count it adds to. Null when the row was no
   * longer pending (another process, a manual `scheduler:run`, settled it while this send was
   * going): it is left as it is, with no line, since a CRITICAL line for a sent email is noise.
   */
  private recordFailure(row: DueEmail, err: unknown): "retried" | "failed" | null {
    const { status, code, retryable } = describeFailure(err);
    const attempts = row.attempts + 1;
    const lastError = status === null ? code : `${status} ${code}`;
    if (retryable && attempts <= EMAIL_MAX_RETRIES) {
      const nextAttemptAt = this.now() + retryDelayMs(attempts);
      if (!this.repo.markRetry(row.emailId, attempts, nextAttemptAt, lastError)) return null;
      opsLog("email_retry", {
        level: "warn",
        emailId: row.emailId,
        kind: row.kind,
        attempts,
        status,
        code,
        nextAttemptAt,
      });
      return "retried";
    }
    if (!this.repo.markFailed(row.emailId, attempts, lastError)) return null;
    opsLog("email_failed", {
      level: "error",
      severity: "CRITICAL",
      emailId: row.emailId,
      kind: row.kind,
      subjectRef: subjectRefForLog(row),
      status,
      code,
      attempts,
    });
    return "failed";
  }
}

/** A contact write's key: a digest of the trimmed, lower-cased address, never the address. */
export function contactIdempotencyKey(address: string): string {
  return `contact:${createHash("sha256").update(address.trim().toLowerCase()).digest("hex")}`;
}

/**
 * A consenting address, for the provider's marketing segment: one `contact_upsert` row per address
 * (its key is the address's digest, so a second consent writes nothing), its source as the
 * subject ref. The consent itself is proven in our tables (the waitlist's confirmed entry).
 */
export function enqueueContactUpsert(
  email: EmailDeps,
  input: { email: string; source: "waitlist" | "formation_party" },
): void {
  email.outbox.enqueue({
    kind: "contact_upsert",
    subjectRef: input.source,
    idempotencyKey: contactIdempotencyKey(input.email),
    to: input.email.trim(),
  });
}

/**
 * The email system of this deployment, or undefined where it is not configured (`cfg.email` is
 * absent without PUBLIC_APP_URL; the testnet box sets none of it). The API process builds it once
 * and hands the same one to its routes and to the job list; an operator's `scheduler:*` command
 * builds its own from the same configuration.
 */
export function buildEmailDeps(db: Database.Database, cfg: Config): EmailDeps | undefined {
  const c = cfg.email;
  if (c === undefined) return undefined;
  return {
    sender:
      c.provider === "resend"
        ? new ResendEmailSender({ apiKey: c.apiKey, from: c.from, replyTo: c.replyTo })
        : new ConsoleEmailSender({ showBody: c.consoleShowBody }),
    outbox: new SqliteEmailOutbox(db, { marketingSegmentId: c.marketingSegmentId }),
    publicAppUrl: c.publicAppUrl,
    postalAddress: c.postalAddress,
    marketingSegmentId: c.marketingSegmentId,
    // The console sender has no webhook secret (the boot refuses one there), so a console box
    // mounts no delivery webhook.
    ...(c.provider === "resend" ? { webhookSecret: c.webhookSecret } : {}),
  };
}
