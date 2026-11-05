import type Database from "better-sqlite3";
import {
  type DocumentType,
  type IdentityProvider,
  type IdentityRowStatus,
  type Liveness,
  REVIEW_REASON_CODES,
  type ReviewReasonCode,
  type Watchlist,
} from "../identity/types";
import { sqliteUtcTimestamp } from "../util/sqliteTime";

/**
 * THE GUARDIAN'S IDENTITY RECORD, append-only: every attempt and every operator decision taken on
 * a row is a new row, and the latest row of a tenant is what its state is derived from, by the
 * caller. Every row is written with the event that says who wrote it and why, in one transaction.
 * The tables, and the guards the database itself holds (no delete, no replace, the only update the
 * erasure of the names, what a passed or a failed row must carry), are `guardian_identity_checks`
 * and `identity_check_events` in db.ts.
 *
 * `append` checks the SHAPE of a row before writing it. Whether a row may be written at all (the
 * tenant's latest row, a stale view, a duplicate identity) is the caller's decision.
 */

/** One name field as stored: AES-256-GCM ciphertext and its 12-byte IV. */
export interface EncryptedName {
  ciphertext: Buffer;
  iv: Buffer;
}

export interface GuardianIdentityCheck {
  checkId: number;
  /** The guardian action nullifier of the tenant's World row; null once World ID is optional. */
  nullifier: string | null;
  tenantId: string;
  provider: IdentityProvider;
  /** The provider's own id of the attempt. */
  providerRef: string;
  subject: string | null;
  status: IdentityRowStatus;
  /** The row this one is a decision on: an acceptance, a refusal, a revocation, a correction. */
  supersedesCheckId: number | null;
  /** Unix milliseconds, as are the other times of a row. */
  startedAt: number;
  completedAt: number | null;
  /** When re-verification is due. */
  expiresAt: number | null;
  /** The names of record, encrypted together under one key; null on a row that keeps none. */
  names: {
    first: EncryptedName;
    last: EncryptedName;
    full: EncryptedName | null;
    keyId: string;
  } | null;
  /** HMAC-SHA256 of the normalised name, 64 lower-case hex digits: equality without decryption. */
  nameHmac: string | null;
  namesErasedAt: number | null;
  /** ISO 3166-1 alpha-3, upper case. */
  documentCountry: string | null;
  documentType: DocumentType | null;
  documentExpired: boolean | null;
  liveness: Liveness | null;
  watchlist: Watchlist | null;
  /** The reason codes of a review; empty when there are none. */
  reviewReasons: ReviewReasonCode[];
  environment: "sandbox" | "production";
  synthetic: boolean;
  /** The operator who wrote the row; null when a provider adapter did (I-A). */
  operator: string | null;
  operatorOsUser: string | null;
}

export type NewGuardianIdentityCheck = Omit<GuardianIdentityCheck, "checkId" | "namesErasedAt">;

export interface IdentityEvent extends NewIdentityEvent {
  eventId: number;
  checkId: number;
}

export interface NewIdentityEvent {
  kind: "recorded" | "accepted" | "refused" | "revoked" | "name_corrected" | "names_erased";
  at: number;
  /** An operator's name, or `system`. */
  actor: string;
  actorOsUser: string | null;
  reasonCode: string | null;
  /** The operator's reason: ids and facts, never a person's name. */
  reason: string | null;
  /** The provider and its event id, for a provider's event applied once. Absent when not set. */
  provider?: string;
  providerEventId?: string;
}

export type ErasureRule = "superseded" | "abandoned" | "unused";

export interface IdentityRepository {
  /**
   * Validates the shape of the row and throws on a bad one, before writing anything; the message
   * names the field and the rule, never the value. Then, in one transaction, the row and the event
   * with the row's check id. Returns the stored row.
   */
  append(check: NewGuardianIdentityCheck, event: NewIdentityEvent): GuardianIdentityCheck;
  /** The tenant's row with the highest check id. */
  latest(tenantId: string): GuardianIdentityCheck | undefined;
  /** Oldest first. */
  list(tenantId: string): GuardianIdentityCheck[];
  /** Oldest first. */
  events(checkId: number): IdentityEvent[];
  findById(checkId: number): GuardianIdentityCheck | undefined;
  /** Check ids, oldest first, of OTHER tenants whose LATEST row passed with this hmac and country. */
  passedElsewhere(nameHmac: string, documentCountry: string, exceptTenantId: string): number[];
  /**
   * The erasure of a row's names and its `names_erased` event, in one transaction. False, writing
   * nothing, when there is no such row or its names were erased already.
   */
  eraseNames(checkId: number, at: number, event: NewIdentityEvent): boolean;
  /** The rows whose names are due for erasure, oldest first (the rules at the statement). */
  erasureCandidates(
    nowMs: number,
    failedAfterMs: number,
    unusedAfterMs: number,
  ): { checkId: number; rule: ErasureRule }[];
  /** An IMMEDIATE transaction; `append` and `eraseNames` inside it join it. */
  transaction<T>(fn: () => T): T;
}

interface Row {
  check_id: number;
  nullifier: string | null;
  tenant_id: string;
  provider: IdentityProvider;
  provider_ref: string;
  subject: string | null;
  status: IdentityRowStatus;
  supersedes_check_id: number | null;
  started_at: number;
  completed_at: number | null;
  expires_at: number | null;
  name_first_ciphertext: Buffer | null;
  name_first_iv: Buffer | null;
  name_last_ciphertext: Buffer | null;
  name_last_iv: Buffer | null;
  name_full_ciphertext: Buffer | null;
  name_full_iv: Buffer | null;
  name_key_id: string | null;
  name_hmac: string | null;
  names_erased_at: number | null;
  document_country: string | null;
  document_type: DocumentType | null;
  document_expired: number | null;
  liveness: Liveness | null;
  watchlist: Watchlist | null;
  review_reasons: string | null;
  environment: "sandbox" | "production";
  synthetic: number;
  operator: string | null;
  operator_os_user: string | null;
}

interface EventRow {
  event_id: number;
  check_id: number;
  kind: NewIdentityEvent["kind"];
  at: number;
  actor: string;
  actor_os_user: string | null;
  reason_code: string | null;
  reason: string | null;
  provider: string | null;
  provider_event_id: string | null;
}

/** A row holds names while its first-name ciphertext is set, the column the table's CHECKs read. */
function namesOf(r: Row): GuardianIdentityCheck["names"] {
  if (r.name_first_ciphertext === null) return null;
  return {
    first: { ciphertext: r.name_first_ciphertext, iv: r.name_first_iv as Buffer },
    last: { ciphertext: r.name_last_ciphertext as Buffer, iv: r.name_last_iv as Buffer },
    full:
      r.name_full_ciphertext === null
        ? null
        : { ciphertext: r.name_full_ciphertext, iv: r.name_full_iv as Buffer },
    keyId: r.name_key_id as string,
  };
}

/** A JSON array of codes; NULL, and anything unreadable, is no reasons. */
function parseReviewReasons(raw: string | null): ReviewReasonCode[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReviewReasonCode[]) : [];
  } catch {
    return [];
  }
}

function toCheck(r: Row): GuardianIdentityCheck {
  return {
    checkId: r.check_id,
    nullifier: r.nullifier,
    tenantId: r.tenant_id,
    provider: r.provider,
    providerRef: r.provider_ref,
    subject: r.subject,
    status: r.status,
    supersedesCheckId: r.supersedes_check_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    expiresAt: r.expires_at,
    names: namesOf(r),
    nameHmac: r.name_hmac,
    namesErasedAt: r.names_erased_at,
    documentCountry: r.document_country,
    documentType: r.document_type,
    documentExpired: r.document_expired === null ? null : r.document_expired === 1,
    liveness: r.liveness,
    watchlist: r.watchlist,
    reviewReasons: parseReviewReasons(r.review_reasons),
    environment: r.environment,
    synthetic: r.synthetic === 1,
    operator: r.operator,
    operatorOsUser: r.operator_os_user,
  };
}

function toEvent(e: EventRow): IdentityEvent {
  return {
    eventId: e.event_id,
    checkId: e.check_id,
    kind: e.kind,
    at: e.at,
    actor: e.actor,
    actorOsUser: e.actor_os_user,
    reasonCode: e.reason_code,
    reason: e.reason,
    // A NULL column leaves its key out, as the type has it.
    ...(e.provider === null ? {} : { provider: e.provider }),
    ...(e.provider_event_id === null ? {} : { providerEventId: e.provider_event_id }),
  };
}

const STATUSES: readonly IdentityRowStatus[] = [
  "started",
  "passed",
  "failed",
  "needs_review",
  "revoked",
];
const PROVIDERS: readonly IdentityProvider[] = ["stripe", "persona", "sumsub", "sandbox"];
const DOCUMENT_TYPES: readonly DocumentType[] = ["passport", "identity_card", "driving_licence"];
const LIVENESS: readonly Liveness[] = ["passed", "failed", "not_run"];
const WATCHLIST: readonly Watchlist[] = ["clear", "hit", "not_run"];
const ENVIRONMENTS: readonly ("sandbox" | "production")[] = ["sandbox", "production"];

const OPERATOR_NAME = /^[a-z0-9._-]{2,40}$/;
/** One spelling per hmac, so a stored hmac compares as text with the same hmac from anywhere. */
const NAME_HMAC = /^[0-9a-f]{64}$/;
const COUNTRY = /^[A-Z]{3}$/;
const IV_BYTES = 12;
const MAX_TEXT_CODE_POINTS = 300;
/** Control, format, surrogate, private-use and unassigned characters. */
const OTHER_CHARACTER = /\p{C}/u;
/** Unix milliseconds from 1973 to year 5138: a time in seconds is below the floor for millennia. */
const MIN_UNIX_MS = 100_000_000_000;
const MAX_UNIX_MS = 99_999_999_999_999;
/** The shortest retention window `erasureCandidates` takes: a window in days, not ms, is refused. */
const MIN_WINDOW_MS = 86_400_000;

/** A refusal names the field and the rule, never the value: a row's values identify a person. */
function refuse(field: string, rule: string): never {
  throw new Error(`identity check: ${field} ${rule}`);
}

function requiredText(field: string, value: unknown): string {
  const text = optionalText(field, value);
  if (text === null) refuse(field, "is required");
  return text;
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

function optionalOneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  return value === null ? null : oneOf(field, value, allowed);
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

function optionalBoolean(field: string, value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") refuse(field, "must be true, false or null");
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

function namesShape(value: unknown): NewGuardianIdentityCheck["names"] {
  if (value === null) return null;
  const v = value as Partial<NonNullable<NewGuardianIdentityCheck["names"]>>;
  if (typeof v !== "object") refuse("names", "must be the encrypted names or null");
  return {
    first: encryptedName("names.first", v.first),
    last: encryptedName("names.last", v.last),
    full: v.full === null ? null : encryptedName("names.full", v.full),
    keyId: requiredText("names.keyId", v.keyId),
  };
}

function reviewReasonsShape(value: unknown): ReviewReasonCode[] {
  if (!Array.isArray(value)) refuse("reviewReasons", "must be a list");
  for (const code of value)
    if (!REVIEW_REASON_CODES.includes(code))
      refuse("reviewReasons", `must each be one of ${REVIEW_REASON_CODES.join(", ")}`);
  return [...(value as ReviewReasonCode[])];
}

/**
 * The row as it is stored: every field validated, and nothing a caller added besides. Throws, as
 * `append` does, on a bad shape: the field shapes of `guardian_identity_checks`, and its rules on
 * what a passed, failed or revoked row carries. Exported so a caller can refuse a bad row before
 * it writes anything, the operator's dry run among them.
 */
export function validateIdentityCheck(c: NewGuardianIdentityCheck): NewGuardianIdentityCheck {
  const operator = c.operator;
  if (operator !== null && (typeof operator !== "string" || !OPERATOR_NAME.test(operator)))
    refuse("operator", `must match ${OPERATOR_NAME.source}`);
  const nameHmac = c.nameHmac;
  if (nameHmac !== null && (typeof nameHmac !== "string" || !NAME_HMAC.test(nameHmac)))
    refuse("nameHmac", "must be 64 lower-case hex digits");
  const country = c.documentCountry;
  if (country !== null && (typeof country !== "string" || !COUNTRY.test(country)))
    refuse("documentCountry", "must be three upper-case letters (ISO 3166-1 alpha-3)");
  const supersedes = c.supersedesCheckId;
  if (supersedes !== null && (!Number.isSafeInteger(supersedes) || supersedes < 1))
    refuse("supersedesCheckId", "must be a positive whole number");
  if (typeof c.synthetic !== "boolean") refuse("synthetic", "must be true or false");

  const v: NewGuardianIdentityCheck = {
    nullifier: optionalText("nullifier", c.nullifier),
    tenantId: requiredText("tenantId", c.tenantId),
    provider: oneOf("provider", c.provider, PROVIDERS),
    providerRef: requiredText("providerRef", c.providerRef),
    subject: optionalText("subject", c.subject),
    status: oneOf("status", c.status, STATUSES),
    supersedesCheckId: supersedes,
    startedAt: unixMs("startedAt", c.startedAt),
    completedAt: optionalUnixMs("completedAt", c.completedAt),
    expiresAt: optionalUnixMs("expiresAt", c.expiresAt),
    names: namesShape(c.names),
    nameHmac,
    documentCountry: country,
    documentType: optionalOneOf("documentType", c.documentType, DOCUMENT_TYPES),
    documentExpired: optionalBoolean("documentExpired", c.documentExpired),
    liveness: optionalOneOf("liveness", c.liveness, LIVENESS),
    watchlist: optionalOneOf("watchlist", c.watchlist, WATCHLIST),
    reviewReasons: reviewReasonsShape(c.reviewReasons),
    environment: oneOf("environment", c.environment, ENVIRONMENTS),
    synthetic: c.synthetic,
    operator,
    operatorOsUser: optionalText("operatorOsUser", c.operatorOsUser),
  };

  // The table's rules, in its words. A new row has no erasure behind it, so a passed one holds names.
  const completed = v.status === "passed" || v.status === "failed" || v.status === "needs_review";
  if (completed && v.completedAt === null)
    refuse("completedAt", "is required on a passed, failed or needs_review row");
  if (v.status === "passed") {
    if (v.expiresAt === null) refuse("expiresAt", "is required on a passed row");
    if (v.documentCountry === null) refuse("documentCountry", "is required on a passed row");
    if (v.watchlist === null) refuse("watchlist", "is required on a passed row");
    if (v.nameHmac === null) refuse("nameHmac", "is required on a passed row");
    if (v.names === null) refuse("names", "are required on a passed row");
  }
  if ((v.status === "failed" || v.status === "revoked") && v.names !== null)
    refuse("names", "are not kept on a failed or revoked row");
  return v;
}

// Fragments of the queries below, over a row aliased `g`.
/** The names are still there: any of the three ciphertexts. */
const HOLDS_NAMES = `(g.name_first_ciphertext IS NOT NULL OR g.name_last_ciphertext IS NOT NULL
                      OR g.name_full_ciphertext IS NOT NULL)`;
/** The tenant has a live company: one not abandoned, or a declaration whose data is not erased. */
const NO_LIVE_COMPANY = `NOT EXISTS (SELECT 1 FROM companies co
                         WHERE co.tenant_id = g.tenant_id AND co.status <> 'abandoned')
     AND NOT EXISTS (SELECT 1 FROM company_declarations d
                      WHERE d.tenant_id = g.tenant_id AND d.pii_erased_at IS NULL)`;
const IS_LATEST = `g.check_id = (SELECT MAX(l.check_id) FROM guardian_identity_checks l
                                  WHERE l.tenant_id = g.tenant_id)`;

export class SqliteIdentityRepository implements IdentityRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      append: db.prepare(
        `INSERT INTO guardian_identity_checks
           (nullifier, tenant_id, provider, provider_ref, subject, status, supersedes_check_id,
            started_at, completed_at, expires_at,
            name_first_ciphertext, name_first_iv, name_last_ciphertext, name_last_iv,
            name_full_ciphertext, name_full_iv, name_key_id, name_hmac,
            document_country, document_type, document_expired, liveness, watchlist,
            review_reasons, environment, synthetic, operator, operator_os_user)
         VALUES (@nullifier, @tenant_id, @provider, @provider_ref, @subject, @status,
                 @supersedes_check_id, @started_at, @completed_at, @expires_at,
                 @name_first_ciphertext, @name_first_iv, @name_last_ciphertext, @name_last_iv,
                 @name_full_ciphertext, @name_full_iv, @name_key_id, @name_hmac,
                 @document_country, @document_type, @document_expired, @liveness, @watchlist,
                 @review_reasons, @environment, @synthetic, @operator, @operator_os_user)
         RETURNING *`,
      ),
      appendEvent: db.prepare(
        `INSERT INTO identity_check_events
           (check_id, kind, at, actor, actor_os_user, reason_code, reason, provider, provider_event_id)
         VALUES (@check_id, @kind, @at, @actor, @actor_os_user, @reason_code, @reason, @provider,
                 @provider_event_id)`,
      ),
      latest: db.prepare(
        "SELECT * FROM guardian_identity_checks WHERE tenant_id = ? ORDER BY check_id DESC LIMIT 1",
      ),
      list: db.prepare(
        "SELECT * FROM guardian_identity_checks WHERE tenant_id = ? ORDER BY check_id",
      ),
      events: db.prepare(
        "SELECT * FROM identity_check_events WHERE check_id = ? ORDER BY event_id",
      ),
      findById: db.prepare("SELECT * FROM guardian_identity_checks WHERE check_id = ?"),
      // A tenant counts only while the passed row carrying the hmac is its latest: one revoked,
      // corrected or re-verified since does not hold the identity any more.
      passedElsewhere: db.prepare(
        `SELECT g.check_id AS check_id FROM guardian_identity_checks g
          WHERE g.name_hmac = @name_hmac
            AND g.document_country = @document_country
            AND g.status = 'passed'
            AND g.tenant_id <> @except_tenant_id
            AND ${IS_LATEST}
          ORDER BY g.check_id`,
      ),
      // The erase-only trigger allows exactly this update, once: `names_erased_at IS NULL` makes a
      // second erasure change nothing rather than meet the trigger.
      eraseNames: db.prepare(
        `UPDATE guardian_identity_checks
            SET names_erased_at = @at, name_first_ciphertext = NULL,
                name_last_ciphertext = NULL, name_full_ciphertext = NULL
          WHERE check_id = @check_id AND names_erased_at IS NULL`,
      ),
      // Identity design 9, over the rows whose names are not erased yet:
      //  - superseded: not its tenant's latest, still holding names, written (`created_at`) before
      //    the failed window;
      //  - abandoned: the latest, `started`, begun (`started_at`) before the failed window, whether
      //    or not it holds names: its erasure is then the record that the attempt was swept;
      //  - unused: the latest, `passed`, holding names, completed before the unused window.
      // Over all three, the rule that outranks them: no row of a tenant with a live company. A
      // needs_review row is never a candidate: it waits for the operator, whose refusal appends a
      // failed row and makes it superseded. `created_at` is SQLite UTC text, so its bound is too
      // (`sqliteUtcTimestamp`); the other times are ms.
      erasureCandidates: db.prepare(
        `SELECT g.check_id AS check_id, 'superseded' AS rule FROM guardian_identity_checks g
          WHERE NOT (${IS_LATEST})
            AND g.names_erased_at IS NULL AND ${HOLDS_NAMES}
            AND g.created_at < @failed_before_utc
            AND ${NO_LIVE_COMPANY}
         UNION ALL
         SELECT g.check_id, 'abandoned' FROM guardian_identity_checks g
          WHERE ${IS_LATEST}
            AND g.status = 'started' AND g.names_erased_at IS NULL
            AND g.started_at < @failed_before_ms
            AND ${NO_LIVE_COMPANY}
         UNION ALL
         SELECT g.check_id, 'unused' FROM guardian_identity_checks g
          WHERE ${IS_LATEST}
            AND g.status = 'passed' AND g.names_erased_at IS NULL AND ${HOLDS_NAMES}
            AND g.completed_at < @unused_before_ms
            AND ${NO_LIVE_COMPANY}
         ORDER BY check_id`,
      ),
    };
  }

  append(check: NewGuardianIdentityCheck, event: NewIdentityEvent): GuardianIdentityCheck {
    const v = validateIdentityCheck(check);
    return this.db.transaction(() => {
      const row = this.stmts.append.get({
        nullifier: v.nullifier,
        tenant_id: v.tenantId,
        provider: v.provider,
        provider_ref: v.providerRef,
        subject: v.subject,
        status: v.status,
        supersedes_check_id: v.supersedesCheckId,
        started_at: v.startedAt,
        completed_at: v.completedAt,
        expires_at: v.expiresAt,
        name_first_ciphertext: v.names?.first.ciphertext ?? null,
        name_first_iv: v.names?.first.iv ?? null,
        name_last_ciphertext: v.names?.last.ciphertext ?? null,
        name_last_iv: v.names?.last.iv ?? null,
        name_full_ciphertext: v.names?.full?.ciphertext ?? null,
        name_full_iv: v.names?.full?.iv ?? null,
        name_key_id: v.names?.keyId ?? null,
        name_hmac: v.nameHmac,
        document_country: v.documentCountry,
        document_type: v.documentType,
        document_expired: v.documentExpired === null ? null : v.documentExpired ? 1 : 0,
        liveness: v.liveness,
        watchlist: v.watchlist,
        review_reasons: v.reviewReasons.length === 0 ? null : JSON.stringify(v.reviewReasons),
        environment: v.environment,
        synthetic: v.synthetic ? 1 : 0,
        operator: v.operator,
        operator_os_user: v.operatorOsUser,
      }) as Row;
      this.insertEvent(row.check_id, event);
      return toCheck(row);
    })();
  }

  latest(tenantId: string): GuardianIdentityCheck | undefined {
    const r = this.stmts.latest.get(tenantId) as Row | undefined;
    return r ? toCheck(r) : undefined;
  }

  list(tenantId: string): GuardianIdentityCheck[] {
    return (this.stmts.list.all(tenantId) as Row[]).map(toCheck);
  }

  events(checkId: number): IdentityEvent[] {
    return (this.stmts.events.all(checkId) as EventRow[]).map(toEvent);
  }

  findById(checkId: number): GuardianIdentityCheck | undefined {
    const r = this.stmts.findById.get(checkId) as Row | undefined;
    return r ? toCheck(r) : undefined;
  }

  passedElsewhere(nameHmac: string, documentCountry: string, exceptTenantId: string): number[] {
    return (
      this.stmts.passedElsewhere.all({
        name_hmac: nameHmac,
        document_country: documentCountry,
        except_tenant_id: exceptTenantId,
      }) as { check_id: number }[]
    ).map((r) => r.check_id);
  }

  eraseNames(checkId: number, at: number, event: NewIdentityEvent): boolean {
    if (event.kind !== "names_erased")
      throw new Error("identity check: an erasure is recorded by a names_erased event");
    const erasedAt = unixMs("namesErasedAt", at);
    return this.db.transaction(() => {
      if (this.stmts.eraseNames.run({ check_id: checkId, at: erasedAt }).changes === 0)
        return false;
      this.insertEvent(checkId, event);
      return true;
    })();
  }

  erasureCandidates(
    nowMs: number,
    failedAfterMs: number,
    unusedAfterMs: number,
  ): { checkId: number; rule: ErasureRule }[] {
    const now = unixMs("nowMs", nowMs);
    for (const [field, window] of [
      ["failedAfterMs", failedAfterMs],
      ["unusedAfterMs", unusedAfterMs],
    ] as const)
      if (!Number.isSafeInteger(window) || window < MIN_WINDOW_MS)
        refuse(
          field,
          `must be a whole number of milliseconds, at least one day (${MIN_WINDOW_MS})`,
        );
    return (
      this.stmts.erasureCandidates.all({
        failed_before_utc: sqliteUtcTimestamp(now - failedAfterMs),
        failed_before_ms: now - failedAfterMs,
        unused_before_ms: now - unusedAfterMs,
      }) as { check_id: number; rule: ErasureRule }[]
    ).map((r) => ({ checkId: r.check_id, rule: r.rule }));
  }

  transaction<T>(fn: () => T): T {
    // IMMEDIATE, as `SqliteLegalBodyRepository.transaction` and for its reason: a deferred
    // transaction that read first fails at its first write if another connection wrote since.
    return this.db.transaction(fn).immediate();
  }

  private insertEvent(checkId: number, e: NewIdentityEvent): void {
    this.stmts.appendEvent.run({
      check_id: checkId,
      kind: e.kind,
      at: e.at,
      actor: e.actor,
      actor_os_user: e.actorOsUser,
      reason_code: e.reasonCode,
      reason: e.reason,
      provider: e.provider ?? null,
      provider_event_id: e.providerEventId ?? null,
    });
  }
}
