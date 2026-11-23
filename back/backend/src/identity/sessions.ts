import { randomBytes } from "node:crypto";
import {
  type IdentityProviderClient,
  StripeError,
  StripeKeyRejected,
  StripeNotFound,
  StripeUnavailable,
} from "../adapters/stripe/identityClient";
import {
  type ProviderOutcome,
  type ProviderSession,
  UnreadableSession,
  outcomeOf,
} from "../adapters/stripe/mapSession";
import { type WorldIdDeps, realHumanState } from "../api/routes/worldId";
import { ApiError } from "../errors";
import { type PiiKeyring, decryptText, encryptText } from "../formation/pii";
import { opsLog } from "../observability/opsLog";
import type {
  GuardianIdentityCheck,
  NewGuardianIdentityCheck,
  NewIdentityEvent,
} from "../persistence/identityRepository";
import {
  type IdentitySession,
  type IdentitySessionRepository,
  RETURN_PATH,
  type SessionRead,
  type TypedNames,
} from "../persistence/identitySessionRepository";
import type { PersonScreener } from "../screening/personScreener";
import type { TaskTracker } from "../util/taskTracker";
import { nameOfRecord } from "./names";
import { type CheckDeps, CheckRefused, namesAgree, planCheck } from "./record";
import { type IdentityDeps, agreesWithWorld, currentRecord, identityState } from "./state";
import { SYSTEM_ACTOR } from "./sweep";
import type { FailureReasonCode, IdentityState, Watchlist } from "./types";

/**
 * THE AUTOMATIC IDENTITY CHECK (identity check plan, Task 7): a guardian starts a check, is sent
 * to the provider, and the server writes the identity record itself from the provider's result,
 * read back over TLS with our key, after screening the person against the sanctions lists; later
 * it asks the provider to delete the session.
 *
 * World ID proves one real person; the identity check says who.
 *
 * Four entry points: `startSession` (the guardian's request), `sessionView` (what the card
 * shows), `syncSession` (a read of one session: the return from the provider, the card's check,
 * the webhook's wake-up), and `sweepSessions` (the scheduler: sessions nobody read lately, the
 * abandoned ones, the redactions due).
 *
 * The rules a provider result obeys to become a row are `identity/record.ts`'s (`planCheck`),
 * shared with the operator's `identity:record`. What is this module's own:
 *
 * - The name of record is the guardian's own: typed at the start, sealed in the session row
 *   (under the PII keyring, bound to the session and the field), compared with the document's at
 *   the completion (`namesAgree`; a difference is `name_mismatch`), and recorded as typed. The
 *   provider's extracted names are compared and dropped.
 * - The sanctions screen runs on the typed name and the birth date, which is read once, handed to
 *   the screen, and never stored or logged. A screen that errors is not a result: the session
 *   waits and the sweep reads it again.
 * - A session is read as the deployment's mode, under our reference: a read in the other mode, or
 *   naming another session, is dropped. A session under redaction has no outcome.
 * - Three failed attempts, a final code, a cancellation or the session's days running out write a
 *   failed row and close the session; a completion closes it with its row. A closed session takes
 *   no write: two reads racing to close one session leave one row, the other answering
 *   `unchanged`.
 * - An operator's row written while a session is open stands: the session's next completion,
 *   failure, abandon or reuse closes it without a row of its own (`writtenOver`), its redaction due
 *   as usual. The adapter never writes over an operator's row.
 * - A revocation is never undone without an operator: a result for a tenant whose latest pass has
 *   a revocation after it lands in review (`provider_flag`), never `passed`; the start stays open.
 * - The provider is asked to delete a session `redactAfterDays` after its row, or after the
 *   operator's decision when the row went to review.
 *
 * What never leaves this module: a name, a birth date, an email, a nullifier, the provider's
 * session id in an answer, or the provider's error sentence. An ops line carries our session id,
 * the tenant as its first ten characters, statuses and codes. A refusal is an `ApiError` whose
 * message is one string literal in its throwing function. The rows carry `operator: null` and
 * their events `actor: system`.
 *
 * The identity record and the sessions table must share one database: a completion writes the
 * row and closes the session in one transaction.
 */

export interface IdentitySessionDeps {
  identity: IdentityDeps & { nameHmacKey: Buffer };
  world: WorldIdDeps | undefined;
  sessions: IdentitySessionRepository;
  provider: IdentityProviderClient;
  /** Always set on production (the boot rule); absent on a sandbox, the search is not run. */
  screener: PersonScreener | undefined;
  environment: "sandbox" | "production";
  /** The provider's verification flow the sessions are created under (`STRIPE_IDENTITY_FLOW_ID`). */
  flowId: string;
  /** Our site's origin: the person comes back to a path on it. */
  webOrigin: string;
  limits: {
    sessionDays: number;
    maxPerDay: number;
    attemptsPerSession: number;
    redactAfterDays: number;
  };
  /** The background tasks a webhook starts (the receiver's), carried with the service. */
  tasks: TaskTracker;
  /** Unix milliseconds; `Date.now` when absent. */
  now?: () => number;
}

export type SessionView =
  | { status: "none" }
  | {
      status: "open";
      sessionId: string;
      startedAt: number;
      attemptsLeft: number;
      lastErrorCode: string | null;
      /** The provider has the person's attempt and its result is being read. */
      reading: boolean;
    };

export type SyncOutcome =
  | "unchanged"
  | "processing"
  | "attempt_failed"
  | "completed"
  | "closed"
  | "screen_pending"
  | "redacted"
  | "dropped";

export interface StartedSession {
  /** Ours, never the provider's. */
  sessionId: string;
  /** The provider's page the person is sent to. */
  url: string;
  expiresAt: number;
}

export interface SweepCounts {
  synced: number;
  abandoned: number;
  redactRequested: number;
  redacted: number;
  errors: number;
}

/** The AAD of one typed name in the sessions table: the session and the field, so a ciphertext
 *  moved to another session or another field fails to decrypt. */
export const IDENTITY_SESSION_AAD = (sessionId: string, field: "first" | "last") =>
  `identity-session|${sessionId}|${field}`;

const DAY_MS = 86_400_000;
/** How long the provider's page stays open for the person, as the answer states it. */
const URL_LIFETIME_MS = 48 * 3_600_000;
/** A verified guardian may renew within this window before the expiry. */
const RENEWAL_WINDOW_MS = 90 * DAY_MS;
/** The window of the daily cap on sessions started. */
const DAILY_WINDOW_MS = DAY_MS;
/** The sweep reads again an open session nobody read for this long. */
const REREAD_AFTER_MS = 2 * 60_000;
const SWEEP_BATCH = 50;
/** Reviews waiting for a decision are few (an operator decides each); read many at once. */
const DECISION_BATCH = 500;
const NAME_MAX_CODE_POINTS = 100;
/** Control, format, surrogate, private-use and unassigned characters. */
const OTHER_CHARACTER = /\p{C}/u;
const DEFAULT_RETURN_PATH = "/legal-body";
/** The decisions that settle a review: the operator's acceptance, refusal or name correction. */
const DECISIONS: ReadonlySet<NewIdentityEvent["kind"]> = new Set([
  "accepted",
  "refused",
  "name_corrected",
]);

const clockOf = (deps: IdentitySessionDeps): number => (deps.now ?? Date.now)();
const tenantTag = (tenantId: string): string => tenantId.slice(0, 10);
const days = (n: number): number => n * DAY_MS;
/** The provider's mode a session of this deployment must read. */
const livemodeOf = (deps: IdentitySessionDeps): boolean => deps.environment === "production";

// ── the refusals ────────────────────────────────────────────────────────────────────────────

function alreadyVerified(): never {
  throw new ApiError(
    "identity_already_verified",
    409,
    "the guardian's identity is already verified: a renewal opens 90 days before it is due",
  );
}

function underReview(): never {
  throw new ApiError(
    "identity_under_review",
    409,
    "the guardian's identity check is being reviewed: the result will show here once it is decided",
  );
}

function providerUnavailable(): never {
  throw new ApiError(
    "identity_provider_unavailable",
    503,
    "identity verification is unavailable at the moment: try again in a few minutes",
  );
}

type ProviderOp = "create" | "retrieve" | "cancel" | "redact";

/**
 * A provider call that failed: one ops line by its class (a refused key CRITICAL), with the HTTP
 * status, the provider's machine code and its request id, never its sentence; then 503. Anything
 * that is not the provider's error is thrown on as it is.
 */
function providerFailed(op: ProviderOp, err: unknown, ids: Record<string, string>): never {
  if (!(err instanceof StripeError)) throw err;
  const fields = { op, status: err.status, code: err.code, requestId: err.requestId, ...ids };
  if (err instanceof StripeKeyRejected)
    opsLog("identity_provider_key_rejected", { level: "error", severity: "CRITICAL", ...fields });
  else if (err instanceof StripeUnavailable)
    opsLog("identity_provider_unavailable", { level: "warn", ...fields });
  else opsLog("identity_provider_error", { level: "error", ...fields });
  providerUnavailable();
}

// ── the guardian ────────────────────────────────────────────────────────────────────────────

/**
 * The guardian's World row for the guardian action, whose nullifier the session and its rows
 * copy. On production it must be a real human's (`realHumanState`); a sandbox takes any row. Else
 * 403 with the gate's sentence.
 */
function guardianNullifier(deps: IdentitySessionDeps, tenantId: string): string {
  if (deps.environment === "production") {
    const state = realHumanState(deps.world, tenantId, "production");
    if (state.ok) return state.verification.nullifier;
  } else {
    const row = deps.world?.store.findByTenant(tenantId, deps.world.cfg.action);
    if (row !== undefined) return row.nullifier;
  }
  throw new ApiError(
    "guardian_not_verified",
    403,
    "the guardian must complete World ID verification first",
  );
}

/**
 * The tenant's identity as a start reads it: as the deployment reads it, and as `/me` shows it,
 * so a record of another person than the account's current World row (`agreesWithWorld`) reads
 * as none and does not stand in the way of the account's own check. The expiry is the counting
 * pass's, when verified.
 */
function standingAtStart(
  deps: IdentitySessionDeps,
  tenantId: string,
  now: number,
): { state: IdentityState; expiresAt: number | null } {
  const { repo } = deps.identity;
  const state = identityState(repo, tenantId, now, deps.environment);
  const record =
    state === "verified"
      ? currentRecord(repo, tenantId, now, deps.environment)
      : repo.latest(tenantId);
  if (record !== undefined && !agreesWithWorld(record, deps.world, tenantId))
    return { state: "none", expiresAt: null };
  return { state, expiresAt: state === "verified" ? (record?.expiresAt ?? null) : null };
}

// ── the typed names ─────────────────────────────────────────────────────────────────────────

/** One typed name: trimmed, 1 to 100 code points, no character of class `\p{C}`. */
function typedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > NAME_MAX_CODE_POINTS || OTHER_CHARACTER.test(trimmed))
    return undefined;
  return trimmed;
}

function typedNamesOf(input: { firstName: string; lastName: string }): {
  first: string;
  last: string;
} {
  const first = typedName(input.firstName);
  const last = typedName(input.lastName);
  if (first === undefined || last === undefined)
    throw new ApiError(
      "validation_error",
      400,
      "the first and the last name must each be 1 to 100 characters, as printed on the document, with no control or invisible character",
    );
  return { first, last };
}

function returnPathOf(value: string | undefined): string {
  const path = value ?? DEFAULT_RETURN_PATH;
  if (typeof path !== "string" || !RETURN_PATH.test(path))
    throw new ApiError(
      "validation_error",
      400,
      "returnPath must be a path on this site: a / then up to 200 letters, digits, -, _ or /",
    );
  return path;
}

function sealTyped(
  pii: PiiKeyring,
  sessionId: string,
  names: { first: string; last: string },
): TypedNames {
  const seal = (field: "first" | "last", value: string) => {
    const { ciphertext, iv } = encryptText(pii, value, IDENTITY_SESSION_AAD(sessionId, field));
    return { ciphertext, iv };
  };
  return {
    first: seal("first", names.first),
    last: seal("last", names.last),
    keyId: pii.current.id,
  };
}

/**
 * The session's typed names, decrypted; null when it holds none. Names that cannot be read (a key
 * this deployment no longer holds, or damaged) write one CRITICAL ops line, ids only, and answer
 * 503 rather than a bare 500.
 */
function openTyped(
  deps: IdentitySessionDeps,
  session: IdentitySession,
): { first: string; last: string } | null {
  const sealed = session.typedNames;
  if (sealed === null) return null;
  const { pii } = deps.identity;
  try {
    const open = (field: "first" | "last") =>
      decryptText(
        pii,
        { ...sealed[field], keyId: sealed.keyId },
        IDENTITY_SESSION_AAD(session.sessionId, field),
      );
    return { first: open("first"), last: open("last") };
  } catch {
    opsLog("identity_session_names_unreadable", {
      level: "error",
      severity: "CRITICAL",
      sessionId: session.sessionId,
      keyId: sealed.keyId,
    });
    throw new ApiError(
      "identity_unavailable",
      503,
      "identity verification is unavailable on this deployment at the moment",
    );
  }
}

/** The same sealed names: a person who started again in between typed new ones. */
function sameSealed(a: TypedNames | null, b: TypedNames | null): boolean {
  if (a === null || b === null) return false;
  return (
    a.keyId === b.keyId &&
    a.first.ciphertext.equals(b.first.ciphertext) &&
    a.last.ciphertext.equals(b.last.ciphertext)
  );
}

// ── start ───────────────────────────────────────────────────────────────────────────────────

/**
 * Starts the guardian's identity check, or reuses the one under way. The rules, numbered as the
 * plan numbers them (rule 5 is checked before rule 3, which may seal the names):
 *
 * 1. A World row for the guardian action (on production a real human's), else 403
 *    `guardian_not_verified`.
 * 2. Verified with more than 90 days left: 409 `identity_already_verified`; under review: 409
 *    `identity_under_review`; anything else goes on.
 * 3. An open session: past its days, or canceled or redacted at the provider, it is closed as
 *    abandoned and a new one opens; a result that has come is read first (409
 *    `identity_already_verified` on a pass, 409 `identity_under_review` on a review or a result
 *    still being read); a session waiting for the person, under the attempt limit once its last
 *    attempt is counted, takes the new typed names and answers its fresh URL.
 * 4. The daily cap, closed sessions counted: 429 `identity_session_limit`.
 * 5. The names (each trimmed, 1 to 100 code points, no `\p{C}` character) and the return path (a
 *    path on our site, `/legal-body` by default), else 400 `validation_error`.
 * 6. The provider session, created under our session id (its reference and idempotency key): a
 *    mode that is not the deployment's, an unavailable provider or a refused key answer 503.
 * 7. In one transaction, the `started` row by the system and the session, the typed names sealed
 *    to it. A session another start opened meanwhile is reused instead, and the provider session
 *    just created is canceled.
 * 8. Our session id, the provider's URL and its expiry 48 hours on.
 */
export function startSession(
  deps: IdentitySessionDeps,
  tenantId: string,
  input: { firstName: string; lastName: string; returnPath?: string },
): Promise<StartedSession> {
  return start(deps, tenantId, input, true);
}

async function start(
  deps: IdentitySessionDeps,
  tenantId: string,
  input: { firstName: string; lastName: string; returnPath?: string },
  mayRetry: boolean,
): Promise<StartedSession> {
  const now = clockOf(deps);
  const nullifier = guardianNullifier(deps, tenantId);
  const standing = standingAtStart(deps, tenantId, now);
  if (standing.state === "verified" && (standing.expiresAt ?? 0) - now > RENEWAL_WINDOW_MS)
    alreadyVerified();
  if (standing.state === "needs_review") underReview();
  const typed = typedNamesOf(input);
  const returnPath = returnPathOf(input.returnPath);

  const open = deps.sessions.openForTenant(tenantId);
  if (open !== undefined) {
    const reused = await reuseOpen(deps, open, typed, now);
    if (reused !== undefined) return reused;
  }

  if (deps.sessions.countCreatedSince(tenantId, now - DAILY_WINDOW_MS) >= deps.limits.maxPerDay)
    throw new ApiError(
      "identity_session_limit",
      429,
      "too many identity checks were started on this account today: try again tomorrow",
    );

  const sessionId = randomBytes(16).toString("hex");
  const origin = deps.webOrigin.replace(/\/+$/, "");
  const created = await createAtProvider(
    deps,
    tenantId,
    sessionId,
    `${origin}${returnPath}?identityCheck=returned`,
  );

  const { repo } = deps.identity;
  const opened = repo.transaction(() => {
    // Another start of this tenant may have opened a session while the provider answered.
    if (deps.sessions.openForTenant(tenantId) !== undefined) return false;
    const startedRow = repo.append(
      {
        nullifier,
        tenantId,
        provider: "stripe",
        providerRef: created.providerRef,
        subject: sessionId,
        status: "started",
        supersedesCheckId: null,
        startedAt: now,
        completedAt: null,
        expiresAt: null,
        names: null,
        nameHmac: null,
        documentCountry: null,
        documentType: null,
        documentExpired: null,
        liveness: null,
        watchlist: null,
        reviewReasons: [],
        environment: deps.environment,
        synthetic: deps.environment === "sandbox",
        operator: null,
        operatorOsUser: null,
      },
      {
        kind: "recorded",
        at: now,
        actor: SYSTEM_ACTOR,
        actorOsUser: null,
        reasonCode: "session_started",
        reason: null,
      },
    );
    deps.sessions.insert({
      sessionId,
      tenantId,
      nullifier,
      provider: "stripe",
      providerRef: created.providerRef,
      environment: deps.environment,
      livemode: livemodeOf(deps),
      returnPath,
      createdAt: now,
      startedCheckId: startedRow.checkId,
      typedNames: sealTyped(deps.identity.pii, sessionId, typed),
    });
    return true;
  });
  if (!opened) {
    await cancelOrphan(deps, created.providerRef, sessionId);
    if (mayRetry) return start(deps, tenantId, input, false);
    providerUnavailable();
  }
  opsLog("identity_session_started", { tenant: tenantTag(tenantId), sessionId });
  return { sessionId, url: created.url, expiresAt: now + URL_LIFETIME_MS };
}

async function createAtProvider(
  deps: IdentitySessionDeps,
  tenantId: string,
  sessionId: string,
  returnUrl: string,
): Promise<{ providerRef: string; url: string; livemode: boolean }> {
  const ids = { tenant: tenantTag(tenantId), sessionId };
  let created: { providerRef: string; url: string; livemode: boolean };
  try {
    created = await deps.provider.createSession({
      flowId: deps.flowId,
      clientReferenceId: sessionId,
      returnUrl,
      idempotencyKey: sessionId,
    });
  } catch (e) {
    providerFailed("create", e, ids);
  }
  // The boot rules hold the key to the deployment's mode; a session in the other mode means they
  // did not, and nothing is written from it.
  if (created.livemode !== livemodeOf(deps)) {
    opsLog("identity_provider_mode_mismatch", {
      level: "error",
      severity: "CRITICAL",
      ...ids,
      livemode: created.livemode,
      environment: deps.environment,
    });
    providerUnavailable();
  }
  return created;
}

/** A provider session no row points at (a start lost the race to another): canceled, best effort. */
async function cancelOrphan(
  deps: IdentitySessionDeps,
  providerRef: string,
  sessionId: string,
): Promise<void> {
  try {
    await deps.provider.cancelSession(providerRef);
  } catch (e) {
    opsLog("identity_session_orphan_not_canceled", {
      level: "warn",
      sessionId,
      status: e instanceof StripeError ? e.status : null,
    });
  }
}

/**
 * Start rule 3, an open session: the answer that reuses it, or undefined once it is closed and a
 * new session may open. Throws the refusals a result read here decides (ruling R6).
 */
async function reuseOpen(
  deps: IdentitySessionDeps,
  open: IdentitySession,
  typed: { first: string; last: string },
  now: number,
): Promise<StartedSession | undefined> {
  const { sessionId } = open;
  if (now - open.createdAt >= days(deps.limits.sessionDays)) {
    const redactionRequested = await endAtProvider(deps, open);
    closeAbandoned(deps, open, now, "expired");
    if (redactionRequested) deps.sessions.markRedactionRequested(sessionId, now);
    return undefined;
  }
  // An operator's row written over the session closes it: a new session opens.
  if (closedIfWrittenOver(deps, sessionId, now)) return undefined;
  // The read that finds the session waiting needs no birth date.
  const read = await retrieved(deps, open, { withDob: false });
  if (read.redaction === null && (read.status === "verified" || read.status === "processing")) {
    // A result has come: it is read as a sync reads it, with the birth date for the screen.
    if ((await syncAt(deps, sessionId, now)) === "dropped") providerUnavailable();
    const fresh = deps.sessions.byId(sessionId);
    if (fresh !== undefined && fresh.closedAt === null) underReview();
    const { state } = standingAtStart(deps, open.tenantId, now);
    if (state === "verified") alreadyVerified();
    if (state === "needs_review") underReview();
    return undefined;
  }
  // Waiting for the person, canceled, or redacted: the read counts an attempt not yet counted and
  // may close the session (the limit reached, a final code, a cancellation).
  const outcome = await applyRead(deps, open, read, false, now);
  if (outcome === "dropped") providerUnavailable();
  if (outcome === "redacted") {
    closeAbandoned(deps, open, now, "redacted");
    return undefined;
  }
  const fresh = deps.sessions.byId(sessionId);
  if (fresh === undefined || fresh.closedAt !== null) return undefined;
  if (read.url === null) providerUnavailable();
  const replaced = deps.identity.repo.transaction(() => {
    const current = deps.sessions.byId(sessionId);
    if (current === undefined || current.closedAt !== null) return false;
    deps.sessions.setTypedNames(sessionId, sealTyped(deps.identity.pii, sessionId, typed), now);
    return true;
  });
  if (!replaced) return undefined;
  opsLog("identity_session_reused", { tenant: tenantTag(open.tenantId), sessionId });
  return { sessionId, url: read.url, expiresAt: now + URL_LIFETIME_MS };
}

// ── view ────────────────────────────────────────────────────────────────────────────────────

/** What the card shows: the tenant's open session, ids and counts only, or none. */
export function sessionView(deps: IdentitySessionDeps, tenantId: string): SessionView {
  const open = deps.sessions.openForTenant(tenantId);
  if (open === undefined) return { status: "none" };
  return {
    status: "open",
    sessionId: open.sessionId,
    startedAt: open.createdAt,
    attemptsLeft: Math.max(0, deps.limits.attemptsPerSession - open.failedAttempts),
    lastErrorCode: open.lastErrorCode,
    reading: open.lastStatus === "processing" || open.lastStatus === "verified",
  };
}

// ── sync ────────────────────────────────────────────────────────────────────────────────────

/**
 * Reads one session at the provider and acts on what it finds:
 *
 * - closed already, or unknown: `unchanged`, nothing read;
 * - under redaction: `redacted` (marked once the provider says it is), nothing recorded;
 * - in the other mode, or naming another session: `dropped`, one ops line, nothing written;
 * - waiting, or being read: `processing`;
 * - a failed attempt: counted once per provider report (ruling R5), `attempt_failed`; the one
 *   that reaches the limit, or a final code, writes the failed row and closes: `closed`;
 * - canceled: the failed row, abandoned, `closed`;
 * - verified: the screen, then the row (`completed`), or `screen_pending` when the screen errored
 *   (no row; the sweep reads it again). A result the record's rules refuse leaves the session
 *   open for an operator, with one ops line: `unchanged`;
 * - an operator's row written since the session's `started` row, met where the session would
 *   write its own (a completion, the failure that closes, a cancellation): the session closes
 *   without a row, its redaction due, one ops line (`identity_session_superseded`): `closed`.
 *
 * The provider's errors answer 503 `identity_provider_unavailable` after their ops line.
 */
export function syncSession(deps: IdentitySessionDeps, sessionId: string): Promise<SyncOutcome> {
  return syncAt(deps, sessionId, clockOf(deps));
}

async function syncAt(
  deps: IdentitySessionDeps,
  sessionId: string,
  now: number,
): Promise<SyncOutcome> {
  const session = deps.sessions.byId(sessionId);
  if (session === undefined || session.closedAt !== null) return "unchanged";
  if (waitsForOperator(session) && !rowWrittenSince(deps, session, session.lastReadAt as number))
    return lookedAt(deps, session, now);
  const { read, dobRefused } = await readWithDob(deps, session);
  return applyRead(deps, session, read, dobRefused, now);
}

/**
 * A verified result the record's rules refused (or one without typed names) waits for an
 * operator: open, its last read verified, no screen pending. A verified session is final at the
 * provider, so nothing there can change the plan; only an operator's row can (`rowWrittenSince`),
 * and the read it wakes closes the session without a row (`writtenOver`).
 */
function waitsForOperator(session: IdentitySession): boolean {
  return (
    session.lastStatus === "verified" &&
    session.screenPendingSince === null &&
    session.lastReadAt !== null
  );
}

/**
 * Whether a row of the tenant was written after the session's `started` row, with an event since
 * `sinceMs`: the system writes no other row for a tenant while its session is open, so this is an
 * operator's.
 */
function rowWrittenSince(
  deps: IdentitySessionDeps,
  session: IdentitySession,
  sinceMs: number,
): boolean {
  const { repo } = deps.identity;
  return repo
    .list(session.tenantId)
    .some(
      (row) =>
        row.checkId > session.startedCheckId &&
        repo.events(row.checkId).some((e) => e.at > sinceMs),
    );
}

/**
 * A session waiting for an operator, looked at and not read: no provider read, no birth date, no
 * screen, no ops line. Its read time moves to now, so the sweep's queue (least recently read
 * first) moves past it, and an operator's row written after this look is the next look's signal.
 */
function lookedAt(deps: IdentitySessionDeps, session: IdentitySession, now: number): SyncOutcome {
  onOpenSession(deps, session.sessionId, (fresh) => {
    deps.sessions.recordRead(fresh.sessionId, {
      at: now,
      status: fresh.lastStatus ?? "verified",
      lastErrorCode: fresh.lastErrorCode,
      failedAttempts: fresh.failedAttempts,
      reportId: fresh.reportId,
    });
  });
  return "unchanged";
}

/** One read at the provider; its failure is the provider's (`providerFailed`). */
async function retrieved(
  deps: IdentitySessionDeps,
  session: IdentitySession,
  opts: { withDob: boolean },
): Promise<ProviderSession> {
  try {
    return await deps.provider.retrieveSession(session.providerRef, opts);
  } catch (e) {
    providerFailed("retrieve", e, { sessionId: session.sessionId });
  }
}

/**
 * The read with the birth date (rulings R3 and R11): the provider serves it only under the recent
 * detailed results permission and within 48 hours of processing, and refuses the read otherwise
 * (400, or 403 as a refused key). A refusal is read again once without it, and the key is
 * reported CRITICAL only if that read is refused too.
 */
async function readWithDob(
  deps: IdentitySessionDeps,
  session: IdentitySession,
): Promise<{ read: ProviderSession; dobRefused: boolean }> {
  try {
    return {
      read: await deps.provider.retrieveSession(session.providerRef, { withDob: true }),
      dobRefused: false,
    };
  } catch (e) {
    if (!(e instanceof StripeError) || (e.status !== 400 && e.status !== 403))
      providerFailed("retrieve", e, { sessionId: session.sessionId });
  }
  return { read: await retrieved(deps, session, { withDob: false }), dobRefused: true };
}

/**
 * `fn` over the session as it stands, in one transaction of the identity record and the sessions
 * table: a session closed meanwhile (another read completed it) is left as it is, `unchanged`.
 */
function onOpenSession<T>(
  deps: IdentitySessionDeps,
  sessionId: string,
  fn: (fresh: IdentitySession) => T,
): T | "unchanged" {
  return deps.identity.repo.transaction(() => {
    const fresh = deps.sessions.byId(sessionId);
    if (fresh === undefined || fresh.closedAt !== null) return "unchanged";
    return fn(fresh);
  });
}

/**
 * Whether a row of the tenant was written over the session while it was open, by someone else
 * than this session: a row newer than its `started` row that is not the session's own (the
 * session's rows carry `operator: null` and its id as their subject, and it writes no other row
 * before it closes), so an operator's. Such a session writes no row of its own any more: the
 * operator's row stands, and the adapter never writes over it.
 */
function writtenOver(deps: IdentitySessionDeps, session: IdentitySession): boolean {
  return deps.identity.repo
    .list(session.tenantId)
    .some(
      (row) =>
        row.checkId > session.startedCheckId &&
        !(row.operator === null && row.subject === session.sessionId),
    );
}

/**
 * Inside the caller's transaction, on a session `writtenOver`: closed without a row (its typed
 * names erased with the close), its redaction due as after a row of its own. The caller writes
 * the ops line (`logSuperseded`) once the transaction is done.
 */
function closeSuperseded(
  deps: IdentitySessionDeps,
  fresh: IdentitySession,
  now: number,
  reportId: string | null,
): "superseded" {
  deps.sessions.close(fresh.sessionId, {
    at: now,
    completedCheckId: null,
    reportId,
    redactDueAt: now + days(deps.limits.redactAfterDays),
  });
  return "superseded";
}

function logSuperseded(sessionId: string): void {
  opsLog("identity_session_superseded", { sessionId });
}

/**
 * The session closed without a row when an operator's row was written over it (`writtenOver`), in
 * a transaction of its own: true when it closed so here.
 */
function closedIfWrittenOver(
  deps: IdentitySessionDeps,
  sessionId: string,
  now: number,
  reportId?: string | null,
): boolean {
  const result = onOpenSession(deps, sessionId, (fresh) =>
    writtenOver(deps, fresh)
      ? closeSuperseded(deps, fresh, now, reportId === undefined ? fresh.reportId : reportId)
      : ("open" as const),
  );
  if (result !== "superseded") return false;
  logSuperseded(sessionId);
  return true;
}

/**
 * The read as the sessions table records it. The report id stays the stored one: it moves only
 * with a failed attempt counted (`attemptFailed`) and with the completion, so a report a read
 * names while its attempt is still being processed is counted once that attempt fails, and never
 * twice.
 */
function readOf(
  fresh: IdentitySession,
  read: ProviderSession,
  now: number,
  dobNotRead: boolean,
): SessionRead {
  return {
    at: now,
    status: read.status,
    lastErrorCode: read.lastErrorCode,
    failedAttempts: fresh.failedAttempts,
    reportId: fresh.reportId,
    ...(dobNotRead ? { dobUnavailable: true } : {}),
  };
}

function outcomeFor(read: ProviderSession, sessionId: string): ProviderOutcome {
  try {
    return outcomeOf(read);
  } catch (e) {
    if (!(e instanceof UnreadableSession)) throw e;
    opsLog("identity_session_unreadable", { level: "error", sessionId, field: e.field });
    providerUnavailable();
  }
}

async function applyRead(
  deps: IdentitySessionDeps,
  session: IdentitySession,
  read: ProviderSession,
  dobRefused: boolean,
  now: number,
): Promise<SyncOutcome> {
  const { sessionId } = session;
  if (read.redaction !== null) {
    if (read.redaction === "redacted") deps.sessions.markRedacted(sessionId, now);
    return "redacted";
  }
  const dropped =
    read.livemode !== livemodeOf(deps)
      ? "mode"
      : read.clientReferenceId !== sessionId || read.id !== session.providerRef
        ? "reference"
        : null;
  if (dropped !== null) {
    opsLog("identity_session_dropped", { sessionId, reason: dropped });
    return "dropped";
  }
  const outcome = outcomeFor(read, sessionId);
  // The screen then runs on the name alone; said once per session.
  const dobNotRead = dobRefused || (outcome.kind === "verified" && outcome.dob === null);
  if (dobNotRead && !session.dobUnavailable) opsLog("identity_dob_not_read", { sessionId });

  switch (outcome.kind) {
    case "pending":
      return onOpenSession(deps, sessionId, (fresh) => {
        deps.sessions.recordRead(sessionId, readOf(fresh, read, now, dobNotRead));
        return "processing" as const;
      });
    case "canceled": {
      const closed = closeAbandoned(deps, session, now, "canceled", (fresh) =>
        readOf(fresh, read, now, dobNotRead),
      );
      return closed === "superseded" ? "closed" : closed;
    }
    case "attempt_failed":
      return attemptFailed(deps, session, read, outcome, dobNotRead, now);
    case "verified":
      return completeVerified(deps, session, read, outcome, dobNotRead, now);
  }
}

/** The failed row's reason code, by the operator's table (I-0) for the provider's codes. */
function failureReasonOf(code: string): FailureReasonCode {
  if (code === "consent_declined") return "consent_declined";
  if (code === "document_expired") return "document_expired";
  if (code.startsWith("document_")) return "document_unverified";
  if (code.startsWith("selfie_")) return "selfie_mismatch";
  return "other";
}

function attemptFailed(
  deps: IdentitySessionDeps,
  session: IdentitySession,
  read: ProviderSession,
  outcome: Extract<ProviderOutcome, { kind: "attempt_failed" }>,
  dobNotRead: boolean,
  now: number,
): SyncOutcome {
  const reasonCode = failureReasonOf(outcome.code);
  const result = onOpenSession(deps, session.sessionId, (fresh) => {
    // Each attempt makes a new report: a report already counted is the same failure read again.
    const reportId = read.report?.id ?? null;
    const counted = reportId !== null && reportId !== fresh.reportId;
    const attempts = fresh.failedAttempts + (counted ? 1 : 0);
    deps.sessions.recordRead(session.sessionId, {
      ...readOf(fresh, read, now, dobNotRead),
      failedAttempts: attempts,
      reportId: reportId ?? fresh.reportId,
    });
    if (!outcome.final && attempts < deps.limits.attemptsPerSession)
      return "attempt_failed" as const;
    if (writtenOver(deps, fresh))
      return closeSuperseded(deps, fresh, now, reportId ?? fresh.reportId);
    writeFailed(deps, fresh, now, reportId ?? fresh.reportId, {
      reasonCode,
      reason: `stripe requires_input: ${outcome.code}`,
      providerEventId: `${fresh.providerRef}:failed:${attempts}`,
    });
    return "closed" as const;
  });
  if (result === "superseded") {
    logSuperseded(session.sessionId);
    return "closed";
  }
  if (result === "closed") logClosed(session, reasonCode);
  return result;
}

async function completeVerified(
  deps: IdentitySessionDeps,
  session: IdentitySession,
  read: ProviderSession,
  outcome: Extract<ProviderOutcome, { kind: "verified" }>,
  dobNotRead: boolean,
  now: number,
): Promise<SyncOutcome> {
  const { sessionId } = session;
  const typed = openTyped(deps, session);
  if (typed === null) {
    // An open session always holds them; without them there is no name of record to write.
    const result = onOpenSession(deps, sessionId, (fresh) => {
      deps.sessions.recordRead(sessionId, readOf(fresh, read, now, dobNotRead));
      return "unchanged" as const;
    });
    opsLog("identity_session_refused", { sessionId, reason: "no_typed_names" });
    return result;
  }
  // An operator's row written over the session stands: nobody is screened for a row not written.
  if (closedIfWrittenOver(deps, sessionId, now, outcome.reportId)) return "closed";
  const names = { first: nameOfRecord(typed.first), last: nameOfRecord(typed.last) };
  const watchlist = await screen(deps, names, outcome.dob);
  if (watchlist === "error") {
    const result = onOpenSession(deps, sessionId, (fresh) => {
      deps.sessions.recordRead(sessionId, {
        ...readOf(fresh, read, now, dobNotRead),
        screenPendingSince: fresh.screenPendingSince ?? now,
      });
      return "screen_pending" as const;
    });
    if (result === "screen_pending") opsLog("identity_screen_pending", { sessionId });
    return result;
  }

  const result = onOpenSession(deps, sessionId, (fresh) => {
    // An operator's row written while the screen ran stands as well.
    if (writtenOver(deps, fresh)) return closeSuperseded(deps, fresh, now, outcome.reportId);
    // The name screened is the name recorded: names typed again since are read on the next sync.
    if (!sameSealed(fresh.typedNames, session.typedNames)) return "unchanged" as const;
    deps.sessions.recordRead(sessionId, {
      ...readOf(fresh, read, now, false),
      reportId: outcome.reportId,
      screenPendingSince: null,
      dobUnavailable: dobNotRead,
    });
    let row: NewGuardianIdentityCheck;
    try {
      row = planCheck(checkDeps(deps, now), {
        ...checkBase(deps, fresh),
        // A country outside ISO 3166-1 cannot pass (ruling R12), nor a result after a revocation
        // (`revokedSinceLastPass`): an operator reviews it (`provider_flag`).
        result:
          outcome.country === null || revokedSinceLastPass(deps, fresh.tenantId)
            ? "needs_review"
            : "passed",
        names: { ...names, full: null },
        nameMismatch: !namesAgree(typed, outcome.names),
        country: outcome.country,
        documentType: outcome.documentType,
        documentExpired: false,
        liveness: outcome.liveness,
        watchlist,
        completedAt: outcome.completedAt,
      }).row;
    } catch (e) {
      // The rules' sentences name the operator's flags: they stay out of every answer and line.
      if (e instanceof CheckRefused) return "refused" as const;
      throw e;
    }
    const check = deps.identity.repo.append(
      row,
      systemEvent(now, { reasonCode: null, reason: null, providerEventId: outcome.reportId }),
    );
    deps.sessions.close(sessionId, {
      at: now,
      completedCheckId: check.checkId,
      reportId: outcome.reportId,
      // A review is redacted once the operator has decided it (`sweepSessions`).
      redactDueAt: check.status === "needs_review" ? null : now + days(deps.limits.redactAfterDays),
    });
    return check;
  });
  if (result === "unchanged") return "unchanged";
  if (result === "superseded") {
    logSuperseded(sessionId);
    return "closed";
  }
  if (result === "refused") {
    opsLog("identity_session_refused", { sessionId, reason: "plan_refused" });
    return "unchanged";
  }
  opsLog("identity_session_completed", {
    tenant: tenantTag(session.tenantId),
    sessionId,
    status: result.status,
    reviewReasons: result.reviewReasons,
  });
  return "completed";
}

/**
 * Whether the tenant holds a revocation newer than its last pass (Martin to confirm: the
 * controller's ruling F3). A revocation, for fraud or a court order, is never undone without an
 * operator: a result after it lands in review with `provider_flag`, never `passed`, and the start
 * stays open (the person may try; an operator decides). A pass written after the revocation, an
 * operator's, lifts it.
 */
function revokedSinceLastPass(deps: IdentitySessionDeps, tenantId: string): boolean {
  const { repo } = deps.identity;
  const lastPass = repo.latestPassed(tenantId)?.checkId ?? 0;
  return repo.list(tenantId).some((row) => row.status === "revoked" && row.checkId > lastPass);
}

/** The sanctions screen on the name of record and the birth date; `not_run` without a screener
 *  (a sandbox), `error` when no verdict came. */
async function screen(
  deps: IdentitySessionDeps,
  names: { first: string; last: string },
  birthDate: string | null,
): Promise<Watchlist | "error"> {
  if (deps.screener === undefined) return "not_run";
  try {
    return await deps.screener.screenPerson({ name: `${names.first} ${names.last}`, birthDate });
  } catch {
    // The screener answers its errors; a throw is no verdict either.
    return "error";
  }
}

function checkDeps(deps: IdentitySessionDeps, now: number): CheckDeps {
  const { repo, pii, nameHmacKey, reverifyYears, blockedCountries } = deps.identity;
  return { repo, pii, nameHmacKey, reverifyYears, blockedCountries, nowMs: now };
}

/** What every row of a session carries: the system wrote it, from the session. */
function checkBase(deps: IdentitySessionDeps, session: IdentitySession) {
  return {
    tenantId: session.tenantId,
    nullifier: session.nullifier,
    provider: "stripe" as const,
    providerRef: session.providerRef,
    subject: session.sessionId,
    startedAt: session.createdAt,
    environment: deps.environment,
    synthetic: deps.environment === "sandbox",
    operator: null,
    operatorOsUser: null,
  };
}

function systemEvent(
  now: number,
  e: { reasonCode: string | null; reason: string | null; providerEventId: string },
): NewIdentityEvent {
  return {
    kind: "recorded",
    at: now,
    actor: SYSTEM_ACTOR,
    actorOsUser: null,
    reasonCode: e.reasonCode,
    reason: e.reason,
    provider: "stripe",
    providerEventId: e.providerEventId,
  };
}

interface Failure {
  reasonCode: FailureReasonCode;
  /** Ids and codes, never a person's data. */
  reason: string;
  providerEventId: string;
}

/** Inside the caller's transaction: the failed row by the system, and the session closed with it,
 *  its redaction due. */
function writeFailed(
  deps: IdentitySessionDeps,
  fresh: IdentitySession,
  now: number,
  reportId: string | null,
  failure: Failure,
): GuardianIdentityCheck {
  const { row } = planCheck(checkDeps(deps, now), {
    ...checkBase(deps, fresh),
    result: "failed",
    names: null,
    nameMismatch: false,
    country: null,
    documentType: null,
    documentExpired: false,
    liveness: null,
    watchlist: null,
    completedAt: now,
  });
  const check = deps.identity.repo.append(row, systemEvent(now, failure));
  deps.sessions.close(fresh.sessionId, {
    at: now,
    completedCheckId: check.checkId,
    reportId,
    redactDueAt: now + days(deps.limits.redactAfterDays),
  });
  return check;
}

/** Why a session is abandoned: its days ran out, or the provider canceled or redacted it. */
type Abandon = "expired" | "canceled" | "redacted";

/**
 * The session closed with a failed row, `abandoned`; with `readFirst`, the read recorded too. A
 * session an operator's row was written over (`writtenOver`) closes without a row of its own:
 * `superseded`.
 */
function closeAbandoned(
  deps: IdentitySessionDeps,
  session: IdentitySession,
  now: number,
  why: Abandon,
  readFirst?: (fresh: IdentitySession) => SessionRead,
): "closed" | "superseded" | "unchanged" {
  const ref = session.providerRef;
  const failure: Failure =
    why === "canceled"
      ? { reasonCode: "abandoned", reason: "stripe canceled", providerEventId: `${ref}:canceled` }
      : why === "redacted"
        ? {
            reasonCode: "abandoned",
            reason: "stripe redacted the session before a result",
            providerEventId: `${ref}:redacted`,
          }
        : {
            reasonCode: "abandoned",
            reason: `no result within ${deps.limits.sessionDays} days`,
            providerEventId: `${ref}:abandoned`,
          };
  const result = onOpenSession(deps, session.sessionId, (fresh) => {
    if (readFirst !== undefined) deps.sessions.recordRead(fresh.sessionId, readFirst(fresh));
    if (writtenOver(deps, fresh)) return closeSuperseded(deps, fresh, now, fresh.reportId);
    writeFailed(deps, fresh, now, fresh.reportId, failure);
    return "closed" as const;
  });
  if (result === "superseded") logSuperseded(session.sessionId);
  if (result === "closed") logClosed(session, failure.reasonCode);
  return result;
}

function logClosed(session: IdentitySession, reasonCode: FailureReasonCode): void {
  opsLog("identity_session_closed", {
    tenant: tenantTag(session.tenantId),
    sessionId: session.sessionId,
    reasonCode,
  });
}

/**
 * A refusal about this session that asking again will not change: 404, or a 4xx other than 429.
 * A refused key (401, 403) is the deployment's, not the session's: it stays an error, CRITICAL.
 */
function refusedForGood(e: unknown): e is StripeError {
  if (!(e instanceof StripeError) || e instanceof StripeKeyRejected) return false;
  if (e instanceof StripeUnavailable || e.status === null) return false;
  return e.status >= 400 && e.status < 500 && e.status !== 429;
}

function redactionRefused(op: "retrieve" | "redact", e: StripeError, sessionId: string): void {
  opsLog("identity_redaction_refused", {
    level: "warn",
    sessionId,
    op,
    status: e.status,
    code: e.code,
  });
}

/**
 * Ends a session at the provider before it is abandoned; true when its redaction was requested.
 * A session the provider redacts (waiting for the person, `requires_input`, which a session never
 * read still is; or verified) is redacted, which cancels a waiting one too. Any other, or one whose
 * redaction is refused (its status moved since the last read), is canceled. One the provider no
 * longer has, or can no longer cancel (a 400), closes all the same; one already redacted is not
 * asked.
 */
async function endAtProvider(
  deps: IdentitySessionDeps,
  session: IdentitySession,
): Promise<boolean> {
  if (session.redactedAt !== null) return false;
  const ids = { sessionId: session.sessionId };
  const { lastStatus } = session;
  if (lastStatus === null || lastStatus === "requires_input" || lastStatus === "verified") {
    try {
      await deps.provider.redactSession(session.providerRef);
      return true;
    } catch (e) {
      if (!refusedForGood(e)) providerFailed("redact", e, ids);
      redactionRefused("redact", e, session.sessionId);
    }
  }
  try {
    await deps.provider.cancelSession(session.providerRef);
  } catch (e) {
    if (e instanceof StripeNotFound || (e instanceof StripeError && e.status === 400)) return false;
    providerFailed("cancel", e, ids);
  }
  return false;
}

/**
 * One redaction due: `redacted` when the provider says so; else the provider is asked,
 * `requested`. A refusal for good (`refusedForGood`) at the read or at the request is `refused`,
 * with one ops line: the caller marks it requested all the same, so it is asked again only a week
 * later and never holds the batch. Any other failure throws (`providerFailed`).
 */
async function requestRedaction(
  deps: IdentitySessionDeps,
  session: IdentitySession,
): Promise<"redacted" | "requested" | "refused"> {
  const ids = { sessionId: session.sessionId };
  let read: ProviderSession;
  try {
    read = await deps.provider.retrieveSession(session.providerRef, { withDob: false });
  } catch (e) {
    if (!refusedForGood(e)) providerFailed("retrieve", e, ids);
    redactionRefused("retrieve", e, session.sessionId);
    return "refused";
  }
  if (read.redaction === "redacted") return "redacted";
  try {
    await deps.provider.redactSession(session.providerRef);
  } catch (e) {
    if (!refusedForGood(e)) providerFailed("redact", e, ids);
    redactionRefused("redact", e, session.sessionId);
    return "refused";
  }
  return "requested";
}

// ── sweep ───────────────────────────────────────────────────────────────────────────────────

/**
 * The scheduler's pass over the sessions, at `nowMs`:
 *
 * 1. Open sessions nobody read for two minutes (50 at a time): past their days, ended at the
 *    provider (redacted, or canceled when redaction does not take them: `endAtProvider`) and
 *    closed as abandoned, or without a row when an operator's row was written over them
 *    (`writtenOver`); else read (`syncSession`; a refused result waiting for an operator is only
 *    looked at).
 * 2. Closed sessions whose row went to review: once the operator has decided the review (an
 *    acceptance, a refusal, or a name correction that settles it), their redaction falls due.
 * 3. Sessions due for redaction (50 at a time): marked redacted when the provider says so, else
 *    the provider is asked (again, a week after a request it did not complete). A refusal for good
 *    counts as a request made: it is asked again a week later, and the batch moves on.
 *
 * Returns the counts. An error on one session is counted and logged, never thrown: the job's own
 * failure line is for a broken dependency, not one session.
 */
export async function sweepSessions(
  deps: IdentitySessionDeps,
  nowMs: number,
): Promise<SweepCounts> {
  const counts: SweepCounts = {
    synced: 0,
    abandoned: 0,
    redactRequested: 0,
    redacted: 0,
    errors: 0,
  };
  const failed = (step: string, sessionId: string, e: unknown) => {
    counts.errors += 1;
    opsLog("identity_sessions_sweep_error", {
      level: "warn",
      step,
      sessionId,
      // The class or the refusal's code, never a message.
      failure: e instanceof ApiError ? e.code : e instanceof Error ? e.name : "unknown",
    });
  };

  for (const session of deps.sessions.openOlderThan(nowMs - REREAD_AFTER_MS, SWEEP_BATCH)) {
    try {
      if (nowMs - session.createdAt >= days(deps.limits.sessionDays)) {
        const redactionRequested = await endAtProvider(deps, session);
        if (closeAbandoned(deps, session, nowMs, "expired") === "closed") counts.abandoned += 1;
        if (redactionRequested) {
          deps.sessions.markRedactionRequested(session.sessionId, nowMs);
          counts.redactRequested += 1;
        }
      } else {
        await syncAt(deps, session.sessionId, nowMs);
        counts.synced += 1;
      }
    } catch (e) {
      failed("sync", session.sessionId, e);
    }
  }

  for (const session of deps.sessions.awaitingDecision(DECISION_BATCH)) {
    try {
      if (reviewDecided(deps, session))
        deps.sessions.setRedactDue(session.sessionId, nowMs + days(deps.limits.redactAfterDays));
    } catch (e) {
      failed("decision", session.sessionId, e);
    }
  }

  for (const session of deps.sessions.redactionDue(nowMs, SWEEP_BATCH)) {
    try {
      if ((await requestRedaction(deps, session)) === "redacted") {
        deps.sessions.markRedacted(session.sessionId, nowMs);
        counts.redacted += 1;
        continue;
      }
      deps.sessions.markRedactionRequested(session.sessionId, nowMs);
      counts.redactRequested += 1;
    } catch (e) {
      failed("redact", session.sessionId, e);
    }
  }
  return counts;
}

/**
 * Whether the operator has decided the review a session completed with: a later row that
 * supersedes it under a decision (accepted, refused, name_corrected), followed through a
 * correction that left it in review, until a row that is not a review. A completion row that is
 * not a review needs no decision.
 */
function reviewDecided(deps: IdentitySessionDeps, session: IdentitySession): boolean {
  const { repo } = deps.identity;
  const reviewId = session.completedCheckId;
  if (reviewId === null) return false;
  const review = repo.findById(reviewId);
  if (review === undefined) return false;
  if (review.status !== "needs_review") return true;
  let under = reviewId;
  // Oldest first: each decision follows the row it supersedes.
  for (const row of repo.list(session.tenantId)) {
    if (row.checkId <= under || row.supersedesCheckId !== under) continue;
    if (!repo.events(row.checkId).some((e) => DECISIONS.has(e.kind))) continue;
    if (row.status !== "needs_review") return true;
    under = row.checkId;
  }
  return false;
}
