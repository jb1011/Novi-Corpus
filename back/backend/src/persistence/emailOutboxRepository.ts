import type Database from "better-sqlite3";

/**
 * THE EMAIL OUTBOX TABLE (`email_outbox`, see `EMAIL_OUTBOX_DDL` in db.ts): the rows and their
 * moves, in SQL. The rules of delivery (what is due, how long a retry waits, when a row fails)
 * are `src/email/outbox.ts`'s; this file only reads and writes rows.
 *
 * Two shapes leave it. `OutboxRow` is a row as anyone may read it: never the address, the text or
 * the HTML, which hold what an email carries for one person (an invite code, a token, a link).
 * `DueEmail` is a row as the delivery job sends it, with the address and the content, and only
 * `listDue` answers it. Every move from `pending` is guarded on `status = 'pending'`, so a row
 * another process has already settled is left as it is.
 */

export const OUTBOX_KINDS = [
  "filing_landed",
  "waitlist_confirm",
  "invite_code",
  "identity_link",
  "contact_upsert",
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATUSES = ["pending", "sent", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/** What the provider's delivery events say happened to a sent email. */
export const DELIVERY_STATES = [
  "delivered",
  "delayed",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** A row as anyone may read it: never the address, the text or the HTML. */
export interface OutboxRow {
  emailId: string;
  kind: OutboxKind;
  /** A company id, a waitlist entry id, an invite hash, a tenant id; a contact write's source. */
  subjectRef: string | null;
  idempotencyKey: string;
  /** Null for a contact write. Subjects carry no personal data. */
  subject: string | null;
  status: OutboxStatus;
  /** The attempts that failed. */
  attempts: number;
  /** Set while pending: when the row is next due (ms). */
  nextAttemptAt: number | null;
  /** The provider's id for the sent email (or contact), `console:<key>` on the console sender. */
  providerMessageId: string | null;
  deliveryState: DeliveryState | null;
  deliveryAt: number | null;
  /** The last failure: an HTTP status and a code, never a body. */
  lastError: string | null;
  createdAt: number;
  sentAt: number | null;
}

/** A due row as the delivery job sends it: the address and, but for a contact write, the content. */
export interface DueEmail extends OutboxRow {
  to: string;
  content: { subject: string; text: string; html: string } | null;
}

export interface NewOutboxEmail {
  emailId: string;
  kind: OutboxKind;
  subjectRef: string | null;
  idempotencyKey: string;
  to: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  /** Also its first due time. */
  createdAt: number;
}

export interface OutboxFilter {
  status?: OutboxStatus;
  kind?: OutboxKind;
  /** Rows created at or after this time (ms). */
  sinceMs?: number;
  /** At most this many: the newest ones, still answered oldest first. Absent, every row. */
  limit?: number;
}

/** Every column but the address and the content, which no reader but the job receives. */
const PUBLIC_COLUMNS = `email_id, kind, subject_ref, idempotency_key, subject, status, attempts,
  next_attempt_at, provider_message_id, delivery_state, delivery_at, last_error, created_at, sent_at`;

interface PublicRow {
  email_id: string;
  kind: OutboxKind;
  subject_ref: string | null;
  idempotency_key: string;
  subject: string | null;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: number | null;
  provider_message_id: string | null;
  delivery_state: DeliveryState | null;
  delivery_at: number | null;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

interface DueRow extends PublicRow {
  to_address: string;
  text: string | null;
  html: string | null;
}

const toOutboxRow = (r: PublicRow): OutboxRow => ({
  emailId: r.email_id,
  kind: r.kind,
  subjectRef: r.subject_ref,
  idempotencyKey: r.idempotency_key,
  subject: r.subject,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  providerMessageId: r.provider_message_id,
  deliveryState: r.delivery_state,
  deliveryAt: r.delivery_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  sentAt: r.sent_at,
});

const toDueEmail = (r: DueRow): DueEmail => ({
  ...toOutboxRow(r),
  to: r.to_address,
  content:
    r.subject !== null && r.text !== null && r.html !== null
      ? { subject: r.subject, text: r.text, html: r.html }
      : null,
});

export class SqliteEmailOutboxRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      // On the key only: a row the CHECKs refuse still throws, rather than passing for a duplicate
      // (`INSERT OR IGNORE` would skip it silently).
      insert: db.prepare(
        `INSERT INTO email_outbox (email_id, kind, subject_ref, idempotency_key, to_address,
           subject, text, html, status, attempts, next_attempt_at, created_at)
         VALUES (@emailId, @kind, @subjectRef, @idempotencyKey, @to, @subject, @text, @html,
           'pending', 0, @createdAt, @createdAt)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ),
      idByKey: db.prepare("SELECT email_id FROM email_outbox WHERE idempotency_key = ?"),
      find: db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM email_outbox WHERE email_id = ?`),
      findByKey: db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM email_outbox WHERE idempotency_key = ?`),
      due: db.prepare(
        `SELECT ${PUBLIC_COLUMNS}, to_address, text, html FROM email_outbox
          WHERE status = 'pending' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at, email_id LIMIT ?`,
      ),
      markSent: db.prepare(
        `UPDATE email_outbox SET status = 'sent', provider_message_id = @providerMessageId,
           sent_at = @at, next_attempt_at = NULL, to_address = NULL, text = NULL, html = NULL
         WHERE email_id = @emailId AND status = 'pending'`,
      ),
      markRetry: db.prepare(
        `UPDATE email_outbox SET attempts = @attempts, next_attempt_at = @nextAttemptAt,
           last_error = @lastError
         WHERE email_id = @emailId AND status = 'pending'`,
      ),
      markFailed: db.prepare(
        `UPDATE email_outbox SET status = 'failed', attempts = @attempts, next_attempt_at = NULL,
           last_error = @lastError
         WHERE email_id = @emailId AND status = 'pending'`,
      ),
      // A contact write's id names a contact, not an email: no delivery event is about it. `@at`
      // is the event's own time, and the row keeps the newest event:
      //  - an event older than the one recorded, or AT THE SAME TIME, leaves the row as it is (a
      //    redelivered event changes nothing, so its route writes no second line);
      //  - `delayed` never overwrites a final state (delivered, bounced, complained, failed,
      //    suppressed), even when it is newer: a delay reported after the outcome is stale news.
      recordDelivery: db.prepare(
        `UPDATE email_outbox SET delivery_state = @state, delivery_at = @at
         WHERE provider_message_id = @providerMessageId AND status = 'sent'
           AND kind != 'contact_upsert'
           AND (delivery_at IS NULL OR delivery_at < @at)
           AND NOT (@state = 'delayed' AND delivery_state IS NOT NULL
                    AND delivery_state != 'delayed')`,
      ),
      // The same rows `recordDelivery` writes: a sent email, never a contact write.
      findSent: db.prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM email_outbox
          WHERE provider_message_id = ? AND status = 'sent' AND kind != 'contact_upsert'
          ORDER BY created_at, email_id LIMIT 1`,
      ),
      requeue: db.prepare(
        `UPDATE email_outbox SET status = 'pending', to_address = @to, attempts = 0,
           next_attempt_at = @at
         WHERE email_id = @emailId AND status = 'failed'`,
      ),
      // The newest first, so a limit keeps the newest rows (a negative LIMIT is none); `list`
      // turns them back into the oldest first.
      list: db.prepare(
        `SELECT ${PUBLIC_COLUMNS} FROM email_outbox
          WHERE (@status IS NULL OR status = @status)
            AND (@kind IS NULL OR kind = @kind)
            AND (@sinceMs IS NULL OR created_at >= @sinceMs)
          ORDER BY created_at DESC, email_id DESC
          LIMIT @limit`,
      ),
    };
  }

  /** False when a row with the key exists already: then nothing is written. */
  insert(e: NewOutboxEmail): boolean {
    return this.stmts.insert.run(e).changes === 1;
  }

  findIdByKey(idempotencyKey: string): string | undefined {
    return (this.stmts.idByKey.get(idempotencyKey) as { email_id: string } | undefined)?.email_id;
  }

  /** The row an email id names, as anyone may read it. */
  find(emailId: string): OutboxRow | undefined {
    const r = this.stmts.find.get(emailId) as PublicRow | undefined;
    return r === undefined ? undefined : toOutboxRow(r);
  }

  /** The row an idempotency key names, as anyone may read it. */
  findByKey(idempotencyKey: string): OutboxRow | undefined {
    const r = this.stmts.findByKey.get(idempotencyKey) as PublicRow | undefined;
    return r === undefined ? undefined : toOutboxRow(r);
  }

  /** The pending rows due at `nowMs`, the longest-due first, at most `limit`. */
  listDue(nowMs: number, limit: number): DueEmail[] {
    return (this.stmts.due.all(nowMs, limit) as DueRow[]).map(toDueEmail);
  }

  /** Sent: the provider's id and the time kept, the address and the content cleared. */
  markSent(emailId: string, providerMessageId: string, at: number): boolean {
    return this.stmts.markSent.run({ emailId, providerMessageId, at }).changes === 1;
  }

  /** Still pending, due again at `nextAttemptAt`. */
  markRetry(emailId: string, attempts: number, nextAttemptAt: number, lastError: string): boolean {
    return this.stmts.markRetry.run({ emailId, attempts, nextAttemptAt, lastError }).changes === 1;
  }

  /** Failed: the address and the content kept, for `email:resend`. */
  markFailed(emailId: string, attempts: number, lastError: string): boolean {
    return this.stmts.markFailed.run({ emailId, attempts, lastError }).changes === 1;
  }

  /** False when nothing was written: no sent email has the id, a newer or same-time event is
   *  recorded, or the event is `delayed` and the row holds a final state. */
  recordDelivery(providerMessageId: string, state: DeliveryState, at: number): boolean {
    return this.stmts.recordDelivery.run({ providerMessageId, state, at }).changes > 0;
  }

  /** The sent email (never a contact write) the provider's id names, as anyone may read it. */
  findSent(providerMessageId: string): OutboxRow | undefined {
    const r = this.stmts.findSent.get(providerMessageId) as PublicRow | undefined;
    return r === undefined ? undefined : toOutboxRow(r);
  }

  /** A failed row back to pending, due at `at`, its attempts counted from zero again. */
  requeue(emailId: string, to: string, at: number): boolean {
    return this.stmts.requeue.run({ emailId, to, at }).changes === 1;
  }

  /** The rows the filter keeps, the oldest first; with a limit, the newest that many of them. */
  list(filter: OutboxFilter): OutboxRow[] {
    if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1))
      throw new Error(
        `email outbox: the limit must be a positive whole number, not ${filter.limit}`,
      );
    return (
      this.stmts.list.all({
        status: filter.status ?? null,
        kind: filter.kind ?? null,
        sinceMs: filter.sinceMs ?? null,
        limit: filter.limit ?? -1,
      }) as PublicRow[]
    )
      .map(toOutboxRow)
      .reverse();
  }
}
