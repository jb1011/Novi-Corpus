import type Database from "better-sqlite3";
import { getAddress } from "viem";
import type { IdentityProvider } from "../identity/types";
import type { EncryptedName } from "./identityRepository";

/**
 * THE PROVIDER SESSIONS of the automatic identity check: one row per session opened at the
 * provider, updated as it moves (read, closed, redacted). Operational state, beside the identity
 * record and never instead of it: what a guardian's state is comes from `guardian_identity_checks`,
 * and a session points at its rows (`startedCheckId`, `completedCheckId`).
 *
 * The one personal data a row holds is the name the person typed, sealed under the PII keyring,
 * and only while the session is open: `close` erases it in the statement that closes the row.
 *
 * Every write checks its SHAPE before it writes, and a refusal names the field and the rule, never
 * the value. Whether a write is due at all (a read, a close, a redaction) is the caller's decision;
 * the one rule held here is that a tenant has at most one open session. Times are unix ms. The
 * table is `identity_sessions` in db.ts.
 */

/** The typed names of a session, sealed: first and last under one key. */
export interface TypedNames {
  first: EncryptedName;
  last: EncryptedName;
  keyId: string;
}

export type SessionProvider = Extract<IdentityProvider, "stripe">;
/** The provider's status of the session, as the last read found it. */
export type SessionStatus = "requires_input" | "processing" | "verified" | "canceled";

export interface IdentitySession {
  /** Our opaque id, 32 lower-case hex digits; the provider holds it as `client_reference_id`. */
  sessionId: string;
  /** The account, EIP-55 checksummed as the session spells it. */
  tenantId: string;
  nullifier: string | null;
  provider: SessionProvider;
  /** The provider's id of the session (`vs_`). */
  providerRef: string;
  environment: "sandbox" | "production";
  livemode: boolean;
  returnPath: string;
  createdAt: number;
  /** The `started` row of `guardian_identity_checks`. */
  startedCheckId: number;
  /** The passed, failed or needs_review row; null while open, and on an abandon without a row. */
  completedCheckId: number | null;
  closedAt: number | null;
  lastStatus: SessionStatus | null;
  /** The provider's error code of the last read (`last_error.code`), never its reason text. */
  lastErrorCode: string | null;
  lastReadAt: number | null;
  failedAttempts: number;
  /** The report (`vr_`) of the last read while open; the one `close` gives once closed. */
  reportId: string | null;
  /** A verified session whose screen errored, since when. */
  screenPendingSince: number | null;
  dobUnavailable: boolean;
  /** Null once erased: at the close, or by `eraseTypedNames`. */
  typedNames: TypedNames | null;
  typedErasedAt: number | null;
  redactDueAt: number | null;
  redactionRequestedAt: number | null;
  redactedAt: number | null;
  updatedAt: number;
}

/** A session opens with the typed names sealed: the completion's name of record is read from them. */
export type NewIdentitySession = Pick<
  IdentitySession,
  | "sessionId"
  | "tenantId"
  | "nullifier"
  | "provider"
  | "providerRef"
  | "environment"
  | "livemode"
  | "returnPath"
  | "createdAt"
  | "startedCheckId"
> & { typedNames: TypedNames };

export interface SessionRead {
  at: number;
  status: SessionStatus;
  lastErrorCode: string | null;
  failedAttempts: number;
  /** The report the read carries, stored as given: a later read's id replaces it (null too). */
  reportId: string | null;
  /** Absent leaves the stored value. */
  dobUnavailable?: boolean;
  /** Absent leaves the stored value; null clears it. */
  screenPendingSince?: number | null;
}

export interface SessionClose {
  at: number;
  completedCheckId: number | null;
  reportId: string | null;
  redactDueAt: number | null;
}

export interface IdentitySessionRepository {
  /**
   * Validates the shape and throws on a bad one, before writing anything. Refused while the tenant
   * has an open session, the check read in the same IMMEDIATE transaction as the write (inside the
   * caller's `transaction`, it joins it). Returns the stored row.
   */
  insert(s: NewIdentitySession): IdentitySession;
  byId(sessionId: string): IdentitySession | undefined;
  byProviderRef(providerRef: string): IdentitySession | undefined;
  /** The tenant's open session, the newest if there were ever two. */
  openForTenant(tenantId: string): IdentitySession | undefined;
  /** The tenant's newest session, open or closed (the operator's `identity:session`). */
  latestForTenant(tenantId: string): IdentitySession | undefined;
  /** The tenant's sessions created at or after `sinceMs`, closed ones included. */
  countCreatedSince(tenantId: string, sinceMs: number): number;
  /** The read of an open session; refused on a closed one, whose completion it would overwrite. */
  recordRead(sessionId: string, read: SessionRead): void;
  /** Replaces the sealed typed names of an open session; refused on a closed one. */
  setTypedNames(sessionId: string, names: TypedNames, at: number): void;
  /** Closes an open session and erases its typed names, in one statement; refused once closed. */
  close(sessionId: string, c: SessionClose): void;
  /** On a closed session only: an open one is still in the person's hands. */
  setRedactDue(sessionId: string, dueAt: number): void;
  /** The time of the latest request, a retry moving it. */
  markRedactionRequested(sessionId: string, at: number): void;
  /** The first redaction's time stands. Open or closed: the provider may redact on its own. */
  markRedacted(sessionId: string, at: number): void;
  /** Erases the typed names; the first erasure's time stands. */
  eraseTypedNames(sessionId: string, at: number): void;
  /** Open sessions not read since `readBeforeMs`, least recently read (or created) first. */
  openOlderThan(readBeforeMs: number, limit: number): IdentitySession[];
  /**
   * Sessions due for redaction and not redacted: never requested, or requested more than 7 days
   * before `nowMs` (a request the provider did not complete is sent again). Earliest due first.
   */
  redactionDue(nowMs: number, limit: number): IdentitySession[];
  /**
   * Closed sessions with a completion row and no redaction date, not redacted: the ones whose row
   * went to review, waiting for the operator's decision before a date is set. Earliest closed
   * first.
   */
  awaitingDecision(limit: number): IdentitySession[];
  /** An IMMEDIATE transaction; every write of this repository inside it joins it. */
  transaction<T>(fn: () => T): T;
}

interface Row {
  session_id: string;
  tenant_id: string;
  nullifier: string | null;
  provider: SessionProvider;
  provider_ref: string;
  environment: "sandbox" | "production";
  livemode: number;
  return_path: string;
  created_at: number;
  started_check_id: number;
  completed_check_id: number | null;
  closed_at: number | null;
  last_status: SessionStatus | null;
  last_error_code: string | null;
  last_read_at: number | null;
  failed_attempts: number;
  report_id: string | null;
  screen_pending_since: number | null;
  dob_unavailable: number;
  typed_first_ciphertext: Buffer | null;
  typed_first_iv: Buffer | null;
  typed_last_ciphertext: Buffer | null;
  typed_last_iv: Buffer | null;
  typed_key_id: string | null;
  typed_erased_at: number | null;
  redact_due_at: number | null;
  redaction_requested_at: number | null;
  redacted_at: number | null;
  updated_at: number;
}

/** A row holds typed names while its first-name ciphertext is set: the five are erased together. */
function typedNamesOf(r: Row): TypedNames | null {
  if (r.typed_first_ciphertext === null) return null;
  return {
    first: { ciphertext: r.typed_first_ciphertext, iv: r.typed_first_iv as Buffer },
    last: { ciphertext: r.typed_last_ciphertext as Buffer, iv: r.typed_last_iv as Buffer },
    keyId: r.typed_key_id as string,
  };
}

function toSession(r: Row): IdentitySession {
  return {
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    nullifier: r.nullifier,
    provider: r.provider,
    providerRef: r.provider_ref,
    environment: r.environment,
    livemode: r.livemode === 1,
    returnPath: r.return_path,
    createdAt: r.created_at,
    startedCheckId: r.started_check_id,
    completedCheckId: r.completed_check_id,
    closedAt: r.closed_at,
    lastStatus: r.last_status,
    lastErrorCode: r.last_error_code,
    lastReadAt: r.last_read_at,
    failedAttempts: r.failed_attempts,
    reportId: r.report_id,
    screenPendingSince: r.screen_pending_since,
    dobUnavailable: r.dob_unavailable === 1,
    typedNames: typedNamesOf(r),
    typedErasedAt: r.typed_erased_at,
    redactDueAt: r.redact_due_at,
    redactionRequestedAt: r.redaction_requested_at,
    redactedAt: r.redacted_at,
    updatedAt: r.updated_at,
  };
}

const PROVIDERS: readonly SessionProvider[] = ["stripe"];
const ENVIRONMENTS: readonly ("sandbox" | "production")[] = ["sandbox", "production"];
const STATUSES: readonly SessionStatus[] = ["requires_input", "processing", "verified", "canceled"];

const SESSION_ID = /^[0-9a-f]{32}$/;
/** The provider's ids as it spells them: the prefix, then letters, digits and underscores. */
const PROVIDER_REF = /^vs_[A-Za-z0-9_]{1,200}$/;
const REPORT_ID = /^vr_[A-Za-z0-9_]{1,200}$/;
/** A code, never the provider's reason text, which may quote the person's data. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,99}$/;
/** The path the person comes back to on our site, as the service takes it (and checks it). */
export const RETURN_PATH = /^\/[A-Za-z0-9\-_/]{0,200}$/;
const IV_BYTES = 12;
const MAX_TEXT_CODE_POINTS = 300;
/** Control, format, surrogate, private-use and unassigned characters. */
const OTHER_CHARACTER = /\p{C}/u;
/** Unix milliseconds from 1973 to year 5138: a time in seconds is below the floor for millennia. */
const MIN_UNIX_MS = 100_000_000_000;
const MAX_UNIX_MS = 99_999_999_999_999;
const MAX_LIMIT = 1_000;
/** How long a redaction request is given before it is sent again. */
const REDACTION_RETRY_MS = 7 * 86_400_000;

/** A refusal names the field and the rule, never the value: a row's values identify a person. */
function refuse(...words: string[]): never {
  throw new Error(`identity session: ${words.join(" ")}`);
}

/** The one spelling the session gives a tenant id (`auth/session.ts`), as the identity record. */
function tenantIdShape(value: unknown): string {
  let canonical = false;
  try {
    canonical = typeof value === "string" && getAddress(value) === value;
  } catch {
    // Not an address at all: refused below.
  }
  if (!canonical) refuse("tenantId", "must be an EIP-55 checksummed address");
  return value as string;
}

function matching(field: string, value: unknown, shape: RegExp, rule: string): string {
  if (typeof value !== "string" || !shape.test(value)) refuse(field, rule);
  return value as string;
}

function optionalMatching(field: string, value: unknown, shape: RegExp, rule: string) {
  return value === null ? null : matching(field, value, shape, rule);
}

/** Null, or text of 1 to 300 code points holding no character of class `\p{C}`. */
function optionalText(field: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") refuse(field, "must be text");
  if (value.length === 0) refuse(field, "must not be empty");
  if ([...value].length > MAX_TEXT_CODE_POINTS)
    refuse(field, `must be at most ${MAX_TEXT_CODE_POINTS} characters`);
  if (OTHER_CHARACTER.test(value))
    refuse(field, "must not hold a control, format or other invisible character");
  return value;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (!(allowed as readonly unknown[]).includes(value))
    refuse(field, `must be one of ${allowed.join(", ")}`);
  return value as T;
}

function unixMs(field: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_UNIX_MS ||
    value > MAX_UNIX_MS
  )
    refuse(field, `must be a whole number of unix milliseconds (${MIN_UNIX_MS} to ${MAX_UNIX_MS})`);
  return value;
}

function optionalUnixMs(field: string, value: unknown): number | null {
  return value === null ? null : unixMs(field, value);
}

function checkId(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    refuse(field, "must be a positive whole number");
  return value;
}

function limitShape(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT)
    refuse("limit", `must be a whole number from 1 to ${MAX_LIMIT}`);
  return value;
}

function encryptedName(field: string, value: unknown): EncryptedName {
  const v = value as Partial<EncryptedName> | null;
  if (typeof v !== "object" || v === null) refuse(field, "must be a ciphertext and its IV");
  if (!Buffer.isBuffer(v.ciphertext) || v.ciphertext.length === 0)
    refuse(`${field}.ciphertext`, "must be a non-empty Buffer");
  if (!Buffer.isBuffer(v.iv) || v.iv.length !== IV_BYTES)
    refuse(`${field}.iv`, `must be ${IV_BYTES} bytes`);
  return { ciphertext: v.ciphertext, iv: v.iv };
}

function typedNamesShape(value: unknown): TypedNames {
  const v = value as Partial<TypedNames> | null;
  if (typeof v !== "object" || v === null) refuse("typedNames", "must be the sealed typed names");
  const keyId = optionalText("typedNames.keyId", v.keyId);
  if (keyId === null) refuse("typedNames.keyId", "is required");
  return {
    first: encryptedName("typedNames.first", v.first),
    last: encryptedName("typedNames.last", v.last),
    keyId,
  };
}

function validateNewSession(s: NewIdentitySession): NewIdentitySession {
  const environment = oneOf("environment", s.environment, ENVIRONMENTS);
  if (s.livemode !== (environment === "production"))
    refuse("livemode", "must be true on production and false on a sandbox");
  return {
    sessionId: matching("sessionId", s.sessionId, SESSION_ID, "must be 32 lower-case hex digits"),
    tenantId: tenantIdShape(s.tenantId),
    nullifier: optionalText("nullifier", s.nullifier),
    provider: oneOf("provider", s.provider, PROVIDERS),
    providerRef: matching(
      "providerRef",
      s.providerRef,
      PROVIDER_REF,
      "must start with vs_ and hold only letters, digits and underscores",
    ),
    environment,
    livemode: s.livemode,
    returnPath: matching(
      "returnPath",
      s.returnPath,
      RETURN_PATH,
      "must be a path on our site: a / then up to 200 letters, digits, -, _ or /",
    ),
    createdAt: unixMs("createdAt", s.createdAt),
    startedCheckId: checkId("startedCheckId", s.startedCheckId),
    typedNames: typedNamesShape(s.typedNames),
  };
}

function validateRead(read: SessionRead): SessionRead {
  const failedAttempts = read.failedAttempts;
  if (
    typeof failedAttempts !== "number" ||
    !Number.isSafeInteger(failedAttempts) ||
    failedAttempts < 0
  )
    refuse("failedAttempts", "must be a whole number, zero or more");
  if (read.dobUnavailable !== undefined && typeof read.dobUnavailable !== "boolean")
    refuse("dobUnavailable", "must be true, false or absent");
  return {
    at: unixMs("at", read.at),
    status: oneOf("status", read.status, STATUSES),
    lastErrorCode: optionalMatching(
      "lastErrorCode",
      read.lastErrorCode,
      ERROR_CODE,
      "must be a code of lower-case letters, digits and underscores",
    ),
    failedAttempts,
    reportId: optionalMatching(
      "reportId",
      read.reportId,
      REPORT_ID,
      "must start with vr_ and hold only letters, digits and underscores",
    ),
    ...(read.dobUnavailable === undefined ? {} : { dobUnavailable: read.dobUnavailable }),
    ...(read.screenPendingSince === undefined
      ? {}
      : { screenPendingSince: optionalUnixMs("screenPendingSince", read.screenPendingSince) }),
  };
}

const SESSION_COLUMNS = `session_id, tenant_id, nullifier, provider, provider_ref, environment,
  livemode, return_path, created_at, started_check_id, typed_first_ciphertext, typed_first_iv,
  typed_last_ciphertext, typed_last_iv, typed_key_id, updated_at`;
/** The five typed columns erased, and the time of the first erasure kept. */
const ERASE_TYPED = `typed_first_ciphertext = NULL, typed_first_iv = NULL,
  typed_last_ciphertext = NULL, typed_last_iv = NULL, typed_key_id = NULL,
  typed_erased_at = COALESCE(typed_erased_at, @at)`;

export class SqliteIdentitySessionRepository implements IdentitySessionRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO identity_sessions (${SESSION_COLUMNS})
         VALUES (@session_id, @tenant_id, @nullifier, @provider, @provider_ref, @environment,
                 @livemode, @return_path, @created_at, @started_check_id, @typed_first_ciphertext,
                 @typed_first_iv, @typed_last_ciphertext, @typed_last_iv, @typed_key_id,
                 @created_at)
         RETURNING *`,
      ),
      byId: db.prepare("SELECT * FROM identity_sessions WHERE session_id = ?"),
      byProviderRef: db.prepare("SELECT * FROM identity_sessions WHERE provider_ref = ?"),
      // `idx_identity_sessions_tenant_open`; the rowid orders two sessions created in one ms.
      openForTenant: db.prepare(
        `SELECT * FROM identity_sessions WHERE tenant_id = ? AND closed_at IS NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ),
      // No index serves it (the tenant's index holds open sessions only): an operator's read, by
      // hand. The rowid orders two sessions created in one ms.
      latestForTenant: db.prepare(
        `SELECT * FROM identity_sessions WHERE tenant_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ),
      countCreatedSince: db.prepare(
        "SELECT COUNT(*) AS n FROM identity_sessions WHERE tenant_id = ? AND created_at >= ?",
      ),
      recordRead: db.prepare(
        `UPDATE identity_sessions
            SET last_read_at = @at, last_status = @status, last_error_code = @last_error_code,
                failed_attempts = @failed_attempts, report_id = @report_id,
                dob_unavailable = COALESCE(@dob_unavailable, dob_unavailable),
                screen_pending_since = CASE WHEN @set_screen_pending = 1
                                            THEN @screen_pending_since
                                            ELSE screen_pending_since END,
                updated_at = @at
          WHERE session_id = @session_id AND closed_at IS NULL`,
      ),
      setTypedNames: db.prepare(
        `UPDATE identity_sessions
            SET typed_first_ciphertext = @typed_first_ciphertext, typed_first_iv = @typed_first_iv,
                typed_last_ciphertext = @typed_last_ciphertext, typed_last_iv = @typed_last_iv,
                typed_key_id = @typed_key_id, typed_erased_at = NULL, updated_at = @at
          WHERE session_id = @session_id AND closed_at IS NULL`,
      ),
      // The close and the erasure of the typed names in one statement: no reader ever finds a
      // closed session still holding them.
      close: db.prepare(
        `UPDATE identity_sessions
            SET closed_at = @at, completed_check_id = @completed_check_id, report_id = @report_id,
                redact_due_at = @redact_due_at, ${ERASE_TYPED}, updated_at = @at
          WHERE session_id = @session_id AND closed_at IS NULL`,
      ),
      setRedactDue: db.prepare(
        `UPDATE identity_sessions SET redact_due_at = @due_at, updated_at = @updated_at
          WHERE session_id = @session_id AND closed_at IS NOT NULL`,
      ),
      markRedactionRequested: db.prepare(
        `UPDATE identity_sessions SET redaction_requested_at = @at, updated_at = @at
          WHERE session_id = @session_id`,
      ),
      markRedacted: db.prepare(
        `UPDATE identity_sessions SET redacted_at = COALESCE(redacted_at, @at), updated_at = @at
          WHERE session_id = @session_id`,
      ),
      eraseTypedNames: db.prepare(
        `UPDATE identity_sessions SET ${ERASE_TYPED}, updated_at = @at
          WHERE session_id = @session_id`,
      ),
      openOlderThan: db.prepare(
        `SELECT * FROM identity_sessions
          WHERE closed_at IS NULL AND (last_read_at IS NULL OR last_read_at < @read_before)
          ORDER BY COALESCE(last_read_at, created_at), rowid
          LIMIT @limit`,
      ),
      // The conditions of `idx_identity_sessions_redact`, so the index serves the query.
      redactionDue: db.prepare(
        `SELECT * FROM identity_sessions
          WHERE redact_due_at IS NOT NULL AND redacted_at IS NULL
            AND redact_due_at <= @now
            AND (redaction_requested_at IS NULL OR redaction_requested_at < @retry_before)
          ORDER BY redact_due_at, rowid
          LIMIT @limit`,
      ),
      awaitingDecision: db.prepare(
        `SELECT * FROM identity_sessions
          WHERE closed_at IS NOT NULL AND completed_check_id IS NOT NULL
            AND redact_due_at IS NULL AND redacted_at IS NULL
          ORDER BY closed_at, rowid
          LIMIT @limit`,
      ),
    };
  }

  insert(s: NewIdentitySession): IdentitySession {
    const v = validateNewSession(s);
    return this.db
      .transaction(() => {
        if (this.stmts.openForTenant.get(v.tenantId) !== undefined)
          refuse("an open session exists");
        const row = this.stmts.insert.get({
          session_id: v.sessionId,
          tenant_id: v.tenantId,
          nullifier: v.nullifier,
          provider: v.provider,
          provider_ref: v.providerRef,
          environment: v.environment,
          livemode: v.livemode ? 1 : 0,
          return_path: v.returnPath,
          created_at: v.createdAt,
          started_check_id: v.startedCheckId,
          typed_first_ciphertext: v.typedNames.first.ciphertext,
          typed_first_iv: v.typedNames.first.iv,
          typed_last_ciphertext: v.typedNames.last.ciphertext,
          typed_last_iv: v.typedNames.last.iv,
          typed_key_id: v.typedNames.keyId,
        }) as Row;
        return toSession(row);
      })
      .immediate();
  }

  byId(sessionId: string): IdentitySession | undefined {
    const r = this.stmts.byId.get(sessionId) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  byProviderRef(providerRef: string): IdentitySession | undefined {
    const r = this.stmts.byProviderRef.get(providerRef) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  openForTenant(tenantId: string): IdentitySession | undefined {
    const r = this.stmts.openForTenant.get(tenantIdShape(tenantId)) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  latestForTenant(tenantId: string): IdentitySession | undefined {
    const r = this.stmts.latestForTenant.get(tenantIdShape(tenantId)) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  countCreatedSince(tenantId: string, sinceMs: number): number {
    const since = unixMs("sinceMs", sinceMs);
    return (this.stmts.countCreatedSince.get(tenantIdShape(tenantId), since) as { n: number }).n;
  }

  recordRead(sessionId: string, read: SessionRead): void {
    const v = validateRead(read);
    const changes = this.stmts.recordRead.run({
      session_id: sessionId,
      at: v.at,
      status: v.status,
      last_error_code: v.lastErrorCode,
      failed_attempts: v.failedAttempts,
      report_id: v.reportId,
      dob_unavailable: v.dobUnavailable === undefined ? null : v.dobUnavailable ? 1 : 0,
      set_screen_pending: v.screenPendingSince === undefined ? 0 : 1,
      screen_pending_since: v.screenPendingSince ?? null,
    }).changes;
    this.changedOne(changes, sessionId, "a closed session takes no read");
  }

  setTypedNames(sessionId: string, names: TypedNames, at: number): void {
    const n = typedNamesShape(names);
    const changes = this.stmts.setTypedNames.run({
      session_id: sessionId,
      typed_first_ciphertext: n.first.ciphertext,
      typed_first_iv: n.first.iv,
      typed_last_ciphertext: n.last.ciphertext,
      typed_last_iv: n.last.iv,
      typed_key_id: n.keyId,
      at: unixMs("at", at),
    }).changes;
    this.changedOne(changes, sessionId, "the typed names of a closed session are not replaced");
  }

  close(sessionId: string, c: SessionClose): void {
    const changes = this.stmts.close.run({
      session_id: sessionId,
      at: unixMs("at", c.at),
      completed_check_id:
        c.completedCheckId === null ? null : checkId("completedCheckId", c.completedCheckId),
      report_id: optionalMatching(
        "reportId",
        c.reportId,
        REPORT_ID,
        "must start with vr_ and hold only letters, digits and underscores",
      ),
      redact_due_at: optionalUnixMs("redactDueAt", c.redactDueAt),
    }).changes;
    this.changedOne(changes, sessionId, "the session is closed already");
  }

  setRedactDue(sessionId: string, dueAt: number): void {
    const changes = this.stmts.setRedactDue.run({
      session_id: sessionId,
      due_at: unixMs("dueAt", dueAt),
      // The interface carries no time of the change; `updated_at` is bookkeeping no rule reads.
      updated_at: Date.now(),
    }).changes;
    this.changedOne(changes, sessionId, "a redaction is due only once the session is closed");
  }

  markRedactionRequested(sessionId: string, at: number): void {
    const changes = this.stmts.markRedactionRequested.run({
      session_id: sessionId,
      at: unixMs("at", at),
    }).changes;
    this.changedOne(changes, sessionId);
  }

  markRedacted(sessionId: string, at: number): void {
    const changes = this.stmts.markRedacted.run({
      session_id: sessionId,
      at: unixMs("at", at),
    }).changes;
    this.changedOne(changes, sessionId);
  }

  eraseTypedNames(sessionId: string, at: number): void {
    const changes = this.stmts.eraseTypedNames.run({
      session_id: sessionId,
      at: unixMs("at", at),
    }).changes;
    this.changedOne(changes, sessionId);
  }

  openOlderThan(readBeforeMs: number, limit: number): IdentitySession[] {
    return (
      this.stmts.openOlderThan.all({
        read_before: unixMs("readBeforeMs", readBeforeMs),
        limit: limitShape(limit),
      }) as Row[]
    ).map(toSession);
  }

  redactionDue(nowMs: number, limit: number): IdentitySession[] {
    const now = unixMs("nowMs", nowMs);
    return (
      this.stmts.redactionDue.all({
        now,
        retry_before: now - REDACTION_RETRY_MS,
        limit: limitShape(limit),
      }) as Row[]
    ).map(toSession);
  }

  awaitingDecision(limit: number): IdentitySession[] {
    return (this.stmts.awaitingDecision.all({ limit: limitShape(limit) }) as Row[]).map(toSession);
  }

  transaction<T>(fn: () => T): T {
    // IMMEDIATE, as `SqliteIdentityRepository.transaction` and for its reason: a deferred
    // transaction that read first fails at its first write if another connection wrote since.
    return this.db.transaction(fn).immediate();
  }

  /**
   * An update that changed no row is refused: no such session, or (`stateRule`) the session is
   * not in the state the update takes. The refusal names the rule, never the id.
   */
  private changedOne(changes: number, sessionId: string, stateRule?: string): void {
    if (changes === 1) return;
    if (stateRule === undefined || this.stmts.byId.get(sessionId) === undefined)
      refuse("sessionId", "names no session");
    refuse(stateRule);
  }
}
