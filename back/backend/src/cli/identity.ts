import type Database from "better-sqlite3";
import type { Command } from "commander";
import { type WorldIdDeps, buildWorldIdDeps, realHumanState } from "../api/routes/worldId";
import { type Config, legalBodyEnvironment } from "../config/env";
import { type PiiKeyring, encryptText, nameHmac } from "../formation/pii";
import { IDENTITY_AAD, nameOfRecord, nameRuleProblem } from "../identity/names";
import {
  type IdentityDeps,
  agreesWithWorld,
  identityState,
  namesOfRecord,
} from "../identity/state";
import { SYSTEM_ACTOR, sweepIdentityNames } from "../identity/sweep";
import {
  ACCEPT_DECISION_CODES,
  type DocumentType,
  FAILURE_REASON_CODES,
  type IdentityProvider,
  type IdentityRowStatus,
  type Liveness,
  NAME_CORRECTION_CODES,
  REFUSE_DECISION_CODES,
  REVOKE_REASON_CODES,
  type ReviewReasonCode,
  type Watchlist,
} from "../identity/types";
import { opsLog } from "../observability/opsLog";
import {
  type GuardianIdentityCheck,
  type NewGuardianIdentityCheck,
  SqliteIdentityRepository,
  validateIdentityCheck,
} from "../persistence/identityRepository";
import { SqliteWorldStore } from "../persistence/worldStore";
import { readNames, withPromptedNames } from "./namesPrompt";
import {
  OPERATOR_NAME,
  oneOf,
  operatorConfig,
  osUser,
  parseExpectLatest,
  parseOperator,
  parseReason,
  parseTenant,
  print,
  refuse,
  withDatabase,
} from "./operator";

/**
 * THE OPERATOR'S COMMANDS over the guardian's identity record (slice I-0: the operator reads the
 * provider's dashboard and records what it shows, from the box): show a tenant's record, record a
 * check, decide a review (accept or refuse it), revoke a passed check, correct the name of record,
 * and erase the names the retention rules say are due.
 *
 * World ID proves one real person; the identity check says who.
 *
 * Every command opens the database itself, through the configuration, prints ONE JSON object on
 * success and throws on a refusal (the entry point prints the message and exits non-zero).
 *
 * The writing commands share the rules of `company:check` (`cli/companyChecks.ts`):
 *  - without `--yes` they print what they would write and write nothing;
 *  - `--expect-latest` names the tenant's latest check (or `none`), so a command typed against a
 *    view another operator has since changed, or replayed from the shell history, is refused;
 *  - the rules and the write run in ONE immediate transaction, so nothing lands between them;
 *  - each row written has one ops line, which carries ids, states, codes and the operator: never a
 *    name, the nullifier or a reason's text. `identity:show` writes no ops line at all, and is the
 *    only command that prints a name.
 *
 * Rows and events are kept for ever: a reason must hold no personal data, a name above all.
 */

const REASON_HELP =
  "why, at most 300 characters; kept for ever, so no personal data and never a name";
const EXPECT_LATEST_HELP =
  "the tenant's latest identity check id, as identity:show prints it, or none when it has none";
const EXPECT_CHECK_HELP = "the tenant's latest identity check id, as identity:show prints it";
const NEXT = "nothing was written: run the same command with --yes to record this";
const TENANT_HELP = "the guardian's account: its wallet address";
/** The sweep writes its erasures under `SYSTEM_ACTOR`, so no operator may type it. */
const RESERVED_OPERATOR = { name: SYSTEM_ACTOR, purpose: "the retention sweep's own erasures" };

const COUNTRY = /^[A-Za-z]{3}$/;
/** An ISO-8601 time with its zone, so its reading never depends on the box's own zone. */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The values the record's columns take, as the operator types them: `identity/types.ts` exports
// their types only (`identityRepository.ts` holds the same lists for the shape check).
const PROVIDERS = [
  "stripe",
  "persona",
  "sumsub",
  "sandbox",
] as const satisfies readonly IdentityProvider[];
const RESULTS = [
  "passed",
  "failed",
  "needs_review",
] as const satisfies readonly IdentityRowStatus[];
const DOCUMENT_TYPES = [
  "passport",
  "identity_card",
  "driving_licence",
] as const satisfies readonly DocumentType[];
const LIVENESS = ["passed", "failed", "not_run"] as const satisfies readonly Liveness[];
const WATCHLIST = ["clear", "hit", "not_run"] as const satisfies readonly Watchlist[];

// ── parsing ──────────────────────────────────────────────────────────────────────────────────

function optionalOneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | null {
  return value === undefined ? null : oneOf(flag, value, allowed);
}

/** ISO 3166-1 alpha-3, kept in upper case. */
function parseCountry(value: string): string {
  if (!COUNTRY.test(value))
    refuse("--country must be an ISO 3166-1 alpha-3 code, three letters (FRA, not FR)");
  return value.toUpperCase();
}

/** The time the provider shows the check completed: a real calendar date, not after now. */
function parseCompletedAt(value: string, nowMs: number): number {
  const parts = INSTANT.exec(value);
  const ms = parts === null ? Number.NaN : Date.parse(value);
  const [year, month, day] = (parts ?? []).slice(1, 4).map(Number) as [number, number, number];
  // Date.parse rolls 30 February over into March; a date that does not round-trip is a typo.
  const calendar = parts !== null && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (!Number.isFinite(ms) || !calendar)
    refuse(
      "--completed-at must be an ISO-8601 time with its zone, such as 2026-11-10T12:00:00Z, on a real calendar date",
    );
  if (ms > nowMs)
    refuse("--completed-at is in the future: copy the time the provider shows the check completed");
  return ms;
}

/** The PII keyring, which every command that encrypts or decrypts a name needs. */
function requirePii(cfg: Config): PiiKeyring {
  if (cfg.pii === undefined) refuse("FORMATION_PII_KEY is not set on this deployment");
  return cfg.pii;
}

/** The name fingerprint's secret, which every command that writes a name's digest needs. The boot
 *  refuses the PII key without it, so a loaded configuration always holds both. */
function requireNameHmacKey(cfg: Config): Buffer {
  if (cfg.identity.nameHmacKey === undefined)
    refuse("IDENTITY_NAME_HMAC_KEY is not set on this deployment");
  return cfg.identity.nameHmacKey;
}

/**
 * The configuration of a command that seals names, loaded as `withDatabase` loads it and held to
 * the two keys the command refuses without, before anything is read at the prompt: a broken
 * configuration is reported before the operator types a name.
 */
function sealingConfig(): Config {
  const cfg = operatorConfig();
  requirePii(cfg);
  requireNameHmacKey(cfg);
  return cfg;
}

// ── shared rules ─────────────────────────────────────────────────────────────────────────────

/** `completedAt` plus whole UTC calendar years: 10 November stays 10 November. */
function addUtcYears(ms: number, years: number): number {
  const date = new Date(ms);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** `--name-full` through `nameOfRecord`; absent, empty or blank, no full name (as at the prompt). */
function fullNameOfRecord(value: string | undefined): string | null {
  const full = value === undefined ? "" : nameOfRecord(value);
  return full === "" ? null : full;
}

interface Names {
  first: string;
  last: string;
  full: string | null;
}

/** The three names sealed under the current key, each bound to the tenant and its field. */
function sealNames(
  pii: PiiKeyring,
  tenantId: string,
  names: Names,
): NonNullable<NewGuardianIdentityCheck["names"]> {
  const seal = (field: "first" | "last" | "full", value: string) => {
    const { ciphertext, iv } = encryptText(pii, value, IDENTITY_AAD(tenantId, field));
    return { ciphertext, iv };
  };
  return {
    first: seal("first", names.first),
    last: seal("last", names.last),
    full: names.full === null ? null : seal("full", names.full),
    keyId: pii.current.id,
  };
}

function identityDeps(cfg: Config, repo: SqliteIdentityRepository, pii: PiiKeyring): IdentityDeps {
  return {
    repo,
    pii,
    reverifyYears: cfg.identity.reverifyYears,
    blockedCountries: cfg.identity.blockedCountries,
  };
}

const holdsNames = (row: GuardianIdentityCheck): boolean =>
  row.names !== null && row.namesErasedAt === null;

/** Refused once the row's names were erased: nothing is left to decide on or carry over. */
function assertNamesHeld(row: GuardianIdentityCheck): void {
  if (!holdsNames(row))
    refuse(`the names of check ${row.checkId} were erased: record a new check instead`);
}

/** The row's names, decrypted, while it still holds them. */
function heldNames(deps: IdentityDeps, row: GuardianIdentityCheck): Names {
  assertNamesHeld(row);
  return namesOfRecord(deps, row);
}

function assertExpectedLatest(
  tenantId: string,
  latest: GuardianIdentityCheck | undefined,
  expected: number | null,
): void {
  const actual = latest?.checkId ?? null;
  if (actual !== expected)
    refuse(
      `the latest identity check of ${tenantId} is ${actual ?? "none"}, not ${expected ?? "none"}: another operator has written since, or this command came from the shell history. Run identity:show ${tenantId} and decide again`,
    );
}

/** The repository's shape check, as a refusal: a dry run refuses whatever the append would. */
function shapeChecked(row: NewGuardianIdentityCheck): NewGuardianIdentityCheck {
  try {
    return validateIdentityCheck(row);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
}

/**
 * A row that will read `passed` on production rests on the face match, the sanctions search and
 * the name rule, however it was built: `identity:record`, `identity:accept` or
 * `identity:correct-name`. Each refusal names the way out. A sandbox row is held to none of it.
 */
function assertProductionPass(
  row: NewGuardianIdentityCheck,
  names: { first: string; last: string } | null,
): void {
  if (row.status !== "passed" || row.environment !== "production") return;
  if (row.liveness !== "passed")
    refuse(
      "on production a passed check needs the face match (--liveness passed), and this check has none: refuse it with identity:refuse and record a new check",
    );
  if (row.watchlist !== "clear" && row.watchlist !== "hit")
    refuse(
      "on production a passed check needs the sanctions search (--watchlist clear or hit), and this check has none: refuse it with identity:refuse and record a new check",
    );
  // A passed row always holds its names (the shape check); none reads as a name with neither part.
  const problem = nameRuleProblem(names?.first ?? "", names?.last ?? "");
  if (problem !== null)
    refuse(
      `on production a passed check needs a name that passes the name rule (${problem}): correct it with identity:correct-name first`,
    );
}

/** A decision lands no pass whose expiry, carried over from the check, has already come. */
function assertNotExpired(expiresAt: number | null, nowMs: number): void {
  if (expiresAt !== null && expiresAt <= nowMs)
    refuse("this check would already be expired: record a new check");
}

/** What a row would hold, for the dry run: never a name, the hmac or the nullifier. */
function planOf(row: NewGuardianIdentityCheck): Record<string, unknown> {
  return {
    tenantId: row.tenantId,
    status: row.status,
    supersedesCheckId: row.supersedesCheckId,
    reviewReasons: row.reviewReasons,
    provider: row.provider,
    providerRef: row.providerRef,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
    documentCountry: row.documentCountry,
    documentType: row.documentType,
    documentExpired: row.documentExpired,
    liveness: row.liveness,
    watchlist: row.watchlist,
    keepsNames: row.names !== null,
    environment: row.environment,
    synthetic: row.synthetic,
    operator: row.operator,
  };
}

/** What a written row is reported as. */
function writtenOf(row: GuardianIdentityCheck): Record<string, unknown> {
  return {
    recorded: true,
    checkId: row.checkId,
    tenantId: row.tenantId,
    status: row.status,
    supersedesCheckId: row.supersedesCheckId,
    reviewReasons: row.reviewReasons,
    expiresAt: row.expiresAt,
  };
}

/**
 * The guardian's World row for the guardian action, whose nullifier the record copies. On
 * production it must be a real human's (`realHumanState`: an accepted credential, recorded under
 * World's production environment); a sandbox deployment takes any row, a waiver among them.
 */
function guardianNullifier(
  world: WorldIdDeps | undefined,
  tenantId: string,
  environment: "sandbox" | "production",
): string {
  if (environment === "production") {
    const state = realHumanState(world, tenantId, environment);
    if (!state.ok) refuse("the account has no production World ID verification");
    return state.verification.nullifier;
  }
  if (world === undefined)
    refuse(
      "World ID is not configured on this deployment, and the record copies the guardian's World ID verification",
    );
  const row = world.store.findByTenant(tenantId, world.cfg.action);
  if (row === undefined) refuse("the account has no World ID verification");
  return row.nullifier;
}

// ── identity:record ──────────────────────────────────────────────────────────────────────────

export interface RecordOptions {
  provider: string;
  providerRef: string;
  result: string;
  nameFirst?: string;
  nameLast?: string;
  nameFull?: string;
  /** The guardian's name differs from the document's: the check waits for a review. */
  nameMismatch?: boolean;
  /** The names are read at a prompt (`namesPrompt.ts`); resolved before `recordIdentity`. */
  namesPrompt?: boolean;
  country?: string;
  documentType?: string;
  documentExpired?: boolean;
  liveness?: string;
  watchlist?: string;
  completedAt?: string;
  reasonCode?: string;
  reason?: string;
  operator: string;
  expectLatest: string;
  yes?: boolean;
}

type OptionTable = readonly (readonly [keyof RecordOptions, string])[];
/** What a failed check refuses: it keeps no name. */
const NAME_FLAGS: OptionTable = [
  ["nameFirst", "--name-first"],
  ["nameLast", "--name-last"],
  ["nameFull", "--name-full"],
  ["nameMismatch", "--name-mismatch"],
];
const KEPT_NEEDS: OptionTable = [
  ["nameFirst", "--name-first"],
  ["nameLast", "--name-last"],
  ["country", "--country"],
  ["watchlist", "--watchlist"],
];
const REASON_FLAGS: OptionTable = [
  ["reasonCode", "--reason-code"],
  ["reason", "--reason"],
];

/**
 * Records one check the operator read in the provider's dashboard. The names are the guardian's
 * own, as printed on the document, confirmed by the operator against the provider's verified names
 * and the document. A passed result is stored as `needs_review`, with its reasons, when the
 * watchlist search hit, the document was out of date, its country is blocked, the name breaks the
 * name rule, the guardian's name differs from the document's (`--name-mismatch`), or another
 * tenant's current passed check holds the same name and country (the other check ids are printed,
 * never the name). A provider's own review (`--result needs_review`) carries `provider_flag`
 * first. On a verified guardian only `--result passed` is taken: a renewal, or a new check after a
 * change of name, which supersedes the current pass and has its expiry from its own completion. A
 * pass recorded over a pass names it (`supersedesCheckId`) and must complete after it, so an
 * expiry never moves back; and no pass is recorded that would already be expired.
 */
export function recordIdentity(
  db: Database.Database,
  cfg: Config,
  tenantArg: string,
  opts: RecordOptions,
): Record<string, unknown> {
  const tenantId = parseTenant(tenantArg);
  const pii = requirePii(cfg);
  const fingerprintKey = requireNameHmacKey(cfg);
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const expected = parseExpectLatest(opts.expectLatest, true);
  const environment = legalBodyEnvironment(cfg);
  const provider = oneOf("--provider", opts.provider, PROVIDERS);
  if (environment === "production" && provider === "sandbox")
    refuse("--provider sandbox is not taken on production");
  const result = oneOf("--result", opts.result, RESULTS);
  const failed = result === "failed";
  const [needs, refused] = failed ? [REASON_FLAGS, NAME_FLAGS] : [KEPT_NEEDS, REASON_FLAGS];
  for (const [key, flag] of refused)
    if (opts[key] !== undefined)
      refuse(
        failed
          ? `${flag} is not taken with --result failed: a failed check keeps no name`
          : `${flag} is taken only with --result failed`,
      );
  const missing = needs.filter(([key]) => opts[key] === undefined).map(([, flag]) => flag);
  if (missing.length > 0) refuse(`--result ${result} needs ${missing.join(", ")}`);

  const nowMs = Date.now();
  const completedAt =
    opts.completedAt === undefined ? nowMs : parseCompletedAt(opts.completedAt, nowMs);
  if (result === "passed" && addUtcYears(completedAt, cfg.identity.reverifyYears) <= nowMs)
    refuse("--completed-at is so old that this pass would already be expired");
  const country = opts.country === undefined ? null : parseCountry(opts.country);
  const documentType = optionalOneOf("--document-type", opts.documentType, DOCUMENT_TYPES);
  const liveness = optionalOneOf("--liveness", opts.liveness, LIVENESS);
  const watchlist = optionalOneOf("--watchlist", opts.watchlist, WATCHLIST);
  // On production a pass rests on the face match and on the sanctions search, both of them run.
  if (environment === "production" && result === "passed") {
    if (watchlist === "not_run")
      refuse("on production a passed check needs the sanctions search: --watchlist clear or hit");
    if (liveness !== "passed") refuse("on production a passed check needs --liveness passed");
  }
  const documentExpired = opts.documentExpired === true;
  const reasonCode = failed ? oneOf("--reason-code", opts.reasonCode, FAILURE_REASON_CODES) : null;
  const reason = failed ? parseReason(opts.reason as string) : null;
  const names: Names | null = failed
    ? null
    : {
        first: nameOfRecord(opts.nameFirst as string),
        last: nameOfRecord(opts.nameLast as string),
        full: fullNameOfRecord(opts.nameFull),
      };
  const hmac = names === null ? null : nameHmac(fingerprintKey, names.first, names.last);
  // The reasons the flags alone decide, in the record's order; the duplicate is read below.
  const flagged: ReviewReasonCode[] = [];
  if (names !== null) {
    if (result === "needs_review") flagged.push("provider_flag");
    if (watchlist === "hit") flagged.push("watchlist_hit");
    if (documentExpired) flagged.push("document_expired");
    if (country !== null && cfg.identity.blockedCountries.has(country))
      flagged.push("country_blocked");
    if (nameRuleProblem(names.first, names.last) !== null) flagged.push("name_rule_failed");
    if (opts.nameMismatch === true) flagged.push("name_mismatch");
  }
  const operatorOsUser = osUser();
  const repo = new SqliteIdentityRepository(db);
  const world = cfg.world ? buildWorldIdDeps(cfg.world, new SqliteWorldStore(db)) : undefined;

  const found = repo.transaction(() => {
    const nullifier = guardianNullifier(world, tenantId, environment);
    const latest = repo.latest(tenantId);
    assertExpectedLatest(tenantId, latest, expected);
    // The latest row decides the state: a failed check or a review on top of a valid pass would
    // lock a verified guardian out of every production door. A pass is a renewal, or a new check
    // after a change of name: it supersedes the current one, under every rule of a pass below.
    if (
      result !== "passed" &&
      latest !== undefined &&
      identityState(repo, tenantId, nowMs) === "verified"
    )
      refuse(
        `the guardian is verified until ${isoDate(latest.expiresAt as number)}; a renewal records --result passed; use identity:correct-name for a name, or identity:revoke first for a failed check or a review`,
      );
    // A pass over a pass is a renewal: it names the pass it replaces, and completes after it, so
    // the expiry, counted from the completion, never moves back.
    const renews = result === "passed" && latest?.status === "passed" ? latest : undefined;
    // A passed row always says when it completed (the table's CHECK).
    if (renews !== undefined && completedAt <= (renews.completedAt as number))
      refuse(
        `a renewal must complete after the current pass (${new Date(renews.completedAt as number).toISOString()})`,
      );
    const duplicateOf =
      hmac !== null && country !== null ? repo.passedElsewhere(hmac, country, tenantId) : [];
    const reviewReasons: ReviewReasonCode[] =
      duplicateOf.length > 0 ? [...flagged, "duplicate_identity"] : flagged;
    const row = shapeChecked({
      nullifier,
      tenantId,
      provider,
      providerRef: opts.providerRef,
      subject: null,
      status: failed ? "failed" : reviewReasons.length > 0 ? "needs_review" : "passed",
      supersedesCheckId: renews?.checkId ?? null,
      // The operator records a completed attempt: as far as the record knows, it began then.
      startedAt: completedAt,
      completedAt,
      expiresAt: failed ? null : addUtcYears(completedAt, cfg.identity.reverifyYears),
      names: names === null ? null : sealNames(pii, tenantId, names),
      nameHmac: hmac,
      documentCountry: country,
      documentType,
      documentExpired,
      liveness,
      watchlist,
      reviewReasons,
      environment,
      synthetic: environment === "sandbox",
      operator,
      operatorOsUser,
    });
    assertProductionPass(row, names);
    if (opts.yes !== true) return { latest, duplicateOf, row, check: undefined };
    const check = repo.append(row, {
      kind: "recorded",
      at: nowMs,
      actor: operator,
      actorOsUser: operatorOsUser,
      reasonCode,
      reason,
    });
    return { latest, duplicateOf, row, check };
  });

  const duplicates = found.duplicateOf.length > 0 ? { duplicateOf: found.duplicateOf } : {};
  if (found.check === undefined)
    return {
      recorded: false,
      tenantId,
      latestCheckId: found.latest?.checkId ?? null,
      wouldRecord: planOf(found.row),
      ...duplicates,
      next: NEXT,
    };
  const check = found.check;
  opsLog("identity_recorded", {
    checkId: check.checkId,
    tenant: tenantId.slice(0, 10),
    provider: check.provider,
    status: check.status,
    watchlist: check.watchlist,
    country: check.documentCountry,
    operator,
  });
  return {
    recorded: true,
    checkId: check.checkId,
    tenantId,
    status: check.status,
    reviewReasons: check.reviewReasons,
    expiresAt: check.expiresAt,
    ...duplicates,
  };
}

// ── the decisions: accept, refuse, revoke, correct the name ──────────────────────────────────

export interface DecisionOptions {
  operator: string;
  expectLatest: string;
  reasonCode: string;
  reason: string;
  yes?: boolean;
}

export interface CorrectNameOptions extends DecisionOptions {
  /** Required, unless the names are read at a prompt (resolved before `correctIdentityName`). */
  nameFirst?: string;
  nameLast?: string;
  nameFull?: string;
  namesPrompt?: boolean;
}

/** What a decision row carries over from the row it decides: everything but the status, the
 *  expiry, the names and the review reasons. */
type Carried = Omit<
  NewGuardianIdentityCheck,
  "status" | "expiresAt" | "names" | "nameHmac" | "reviewReasons"
>;

function carriedFrom(
  latest: GuardianIdentityCheck,
  operator: string,
  operatorOsUser: string,
): Carried {
  return {
    nullifier: latest.nullifier,
    tenantId: latest.tenantId,
    provider: latest.provider,
    providerRef: latest.providerRef,
    subject: latest.subject,
    supersedesCheckId: latest.checkId,
    startedAt: latest.startedAt,
    completedAt: latest.completedAt,
    documentCountry: latest.documentCountry,
    documentType: latest.documentType,
    documentExpired: latest.documentExpired,
    liveness: latest.liveness,
    watchlist: latest.watchlist,
    environment: latest.environment,
    synthetic: latest.synthetic,
    operator,
    operatorOsUser,
  };
}

/** The row a decision appends, with the names it seals in plaintext (null when it keeps none). */
interface Built {
  row: NewGuardianIdentityCheck;
  names: Names | null;
}

interface Decision {
  kind: "accepted" | "refused" | "revoked" | "name_corrected";
  /** The ops line of a row written, spelled out so a grep finds its writer. */
  opsEvent: string;
  codes: readonly string[];
  /** The statuses the latest row may have, and the refusal of any other. */
  from: readonly IdentityRowStatus[];
  onlyFrom: string;
  /** The row appended over the latest, inside the transaction. May refuse. */
  build: (
    latest: GuardianIdentityCheck,
    carried: Carried,
    repo: SqliteIdentityRepository,
    nowMs: number,
  ) => Built;
}

/**
 * The shared body of the four decisions: in ONE immediate transaction, the latest row against
 * `--expect-latest`, its status against the decision's, the new row (a passed one held to the
 * production pass), and (with `--yes`) its append with the decision's event. Then one ops line and
 * the output.
 */
function decide(
  db: Database.Database,
  tenantId: string,
  opts: DecisionOptions,
  d: Decision,
): Record<string, unknown> {
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const expected = parseExpectLatest(opts.expectLatest, false);
  const reasonCode = oneOf("--reason-code", opts.reasonCode, d.codes);
  const reason = parseReason(opts.reason);
  const operatorOsUser = osUser();
  const nowMs = Date.now();
  const repo = new SqliteIdentityRepository(db);

  const found = repo.transaction(() => {
    const latest = repo.latest(tenantId);
    assertExpectedLatest(tenantId, latest, expected);
    if (latest === undefined || !d.from.includes(latest.status))
      refuse(
        `the latest identity check of ${tenantId} is ${latest?.status ?? "none"}: ${d.onlyFrom}`,
      );
    const built = d.build(latest, carriedFrom(latest, operator, operatorOsUser), repo, nowMs);
    const row = shapeChecked(built.row);
    assertProductionPass(row, built.names);
    if (opts.yes !== true) return { latest, row, check: undefined };
    const check = repo.append(row, {
      kind: d.kind,
      at: nowMs,
      actor: operator,
      actorOsUser: operatorOsUser,
      reasonCode,
      reason,
    });
    return { latest, row, check };
  });

  if (found.check === undefined)
    return {
      recorded: false,
      tenantId,
      latestCheckId: found.latest.checkId,
      wouldRecord: planOf(found.row),
      next: NEXT,
    };
  opsLog(d.opsEvent, {
    checkId: found.check.checkId,
    supersedes: found.latest.checkId,
    tenant: tenantId.slice(0, 10),
    status: found.check.status,
    reasonCode,
    operator,
  });
  return writtenOf(found.check);
}

/**
 * The operator's decision on a review, each with its own part of the decision codes. `accept`
 * appends a passed row carrying the review's facts and its names, sealed again under the current
 * PII key, with the name's fingerprint computed again from them under its own secret (the same
 * digest: the PII key takes no part in it); it is refused once the check's expiry has come (the
 * pass would already be expired), over a `name_mismatch` review, which `identity:correct-name`
 * settles, while another account's current passed check holds the same name and country, and on
 * production unless the check had the face match, the sanctions search and a name that passes the
 * name rule (`assertProductionPass`). `refuse` appends a failed row without names, over a review
 * or an attempt that never completed.
 */
export function reviewIdentity(
  db: Database.Database,
  cfg: Config,
  decision: "accept" | "refuse",
  tenantArg: string,
  opts: DecisionOptions,
): Record<string, unknown> {
  const tenantId = parseTenant(tenantArg);
  if (decision === "refuse")
    return decide(db, tenantId, opts, {
      kind: "refused",
      opsEvent: "identity_refused",
      codes: REFUSE_DECISION_CODES,
      from: ["needs_review", "started"],
      onlyFrom: "only a needs_review or started check is refused",
      build: (latest, carried, _repo, nowMs) => ({
        row: {
          ...carried,
          status: "failed",
          // An attempt that never completed is refused now.
          completedAt: latest.completedAt ?? nowMs,
          expiresAt: null,
          names: null,
          nameHmac: null,
          reviewReasons: [],
        },
        names: null,
      }),
    });
  const pii = requirePii(cfg);
  const fingerprintKey = requireNameHmacKey(cfg);
  return decide(db, tenantId, opts, {
    kind: "accepted",
    opsEvent: "identity_accepted",
    codes: ACCEPT_DECISION_CODES,
    from: ["needs_review"],
    onlyFrom: "only a needs_review check is accepted",
    build: (latest, carried, repo, nowMs) => {
      assertNotExpired(latest.expiresAt, nowMs);
      // The name differs from the document's: only the guardian can say which is right.
      if (latest.reviewReasons.includes("name_mismatch"))
        refuse(
          "a name_mismatch review is settled with identity:correct-name, after asking the guardian",
        );
      const names = heldNames(identityDeps(cfg, repo, pii), latest);
      const hmac = nameHmac(fingerprintKey, names.first, names.last);
      // Read again at the decision: another account may have passed with the same name and
      // country since the review was recorded.
      const elsewhere =
        latest.documentCountry === null
          ? []
          : repo.passedElsewhere(hmac, latest.documentCountry, tenantId);
      if (elsewhere.length > 0)
        refuse(
          `another account holds a verified identity with the same name and document country (checks ${elsewhere.join(", ")}): refuse this one with duplicate_identity, or revoke the other first`,
        );
      return {
        row: {
          ...carried,
          status: "passed",
          expiresAt: latest.expiresAt,
          names: sealNames(pii, tenantId, names),
          nameHmac: hmac,
          reviewReasons: [],
        },
        names,
      };
    },
  });
}

/**
 * Revokes a passed check: a revoked row without names. The identity side only: a live company
 * stays the company's to revoke (`company:revoke`).
 */
export function revokeIdentity(
  db: Database.Database,
  _cfg: Config,
  tenantArg: string,
  opts: DecisionOptions,
): Record<string, unknown> {
  return decide(db, parseTenant(tenantArg), opts, {
    kind: "revoked",
    opsEvent: "identity_revoked",
    codes: REVOKE_REASON_CODES,
    from: ["passed"],
    onlyFrom: "only a passed check is revoked",
    build: (_latest, carried) => ({
      row: {
        ...carried,
        status: "revoked",
        expiresAt: null,
        names: null,
        nameHmac: null,
        reviewReasons: [],
      },
      names: null,
    }),
  });
}

/**
 * Corrects the name of record of a passed check or a review: the new names through `nameOfRecord`
 * and the name rule (refused when they break it), the full name only when a new one is given (the
 * old one is never carried over a correction), all sealed under the current key with the new
 * name's fingerprint. The corrected name resolves `name_rule_failed` and `name_mismatch`.
 * The row passes when the review's reasons other than those two are none (on production,
 * only when the check had the face match and the sanctions search: `assertProductionPass`; and
 * never once the check's expiry has come, when the pass would already be expired); since the name
 * changed, another tenant's current passed check holding the new name and country adds
 * `duplicate_identity`, as `identity:record` would.
 */
export function correctIdentityName(
  db: Database.Database,
  cfg: Config,
  tenantArg: string,
  opts: CorrectNameOptions,
): Record<string, unknown> {
  const tenantId = parseTenant(tenantArg);
  const pii = requirePii(cfg);
  const fingerprintKey = requireNameHmacKey(cfg);
  if (opts.nameFirst === undefined || opts.nameLast === undefined)
    refuse("--name-first and --name-last are required, or --names-prompt");
  const first = nameOfRecord(opts.nameFirst);
  const last = nameOfRecord(opts.nameLast);
  const problem = nameRuleProblem(first, last);
  if (problem !== null) refuse(`the corrected name breaks the name rule: ${problem}`);
  return decide(db, tenantId, opts, {
    kind: "name_corrected",
    opsEvent: "identity_name_corrected",
    codes: NAME_CORRECTION_CODES,
    from: ["passed", "needs_review"],
    onlyFrom: "only a passed or needs_review check has its name corrected",
    build: (latest, carried, repo, nowMs) => {
      assertNamesHeld(latest);
      const names: Names = {
        first,
        last,
        full: fullNameOfRecord(opts.nameFull),
      };
      const hmac = nameHmac(fingerprintKey, first, last);
      // The corrected name resolves the name's own reasons, and only those.
      const remaining = latest.reviewReasons.filter(
        (code) => code !== "name_rule_failed" && code !== "name_mismatch",
      );
      const duplicate =
        latest.documentCountry !== null &&
        !remaining.includes("duplicate_identity") &&
        repo.passedElsewhere(hmac, latest.documentCountry, tenantId).length > 0;
      const reviewReasons: ReviewReasonCode[] = duplicate
        ? [...remaining, "duplicate_identity"]
        : remaining;
      if (reviewReasons.length === 0) assertNotExpired(latest.expiresAt, nowMs);
      return {
        row: {
          ...carried,
          status: reviewReasons.length === 0 ? "passed" : "needs_review",
          expiresAt: latest.expiresAt,
          names: sealNames(pii, tenantId, names),
          nameHmac: hmac,
          reviewReasons,
        },
        names,
      };
    },
  });
}

// ── identity:show ────────────────────────────────────────────────────────────────────────────

/**
 * The latest row's names as `identity:show` prints them: decrypted while the deployment holds the
 * key they were sealed under; else `names: null` with that key's id and a note, so the operator
 * sees the rest of the record instead of a crash.
 */
function shownNames(
  deps: IdentityDeps,
  row: GuardianIdentityCheck,
): { names: Names | null; nameKeyId?: string; namesNote?: string } {
  if (row.names === null || !holdsNames(row)) return { names: null };
  const keyId = row.names.keyId;
  if (deps.pii.current.id === keyId || deps.pii.previous?.id === keyId)
    return { names: namesOfRecord(deps, row) };
  return {
    names: null,
    nameKeyId: keyId,
    namesNote: `the names are sealed under key ${keyId}, which this deployment does not hold: configure it again (FORMATION_PII_KEY_PREVIOUS) to read them`,
  };
}

/**
 * What `identity:show` prints; it writes nothing, and no ops line:
 *  - `state`, read as this deployment's doors read it (on production a test record reads `none`);
 *  - `countsAtTheDoors`, whether the latest row is the person of the account's current World ID
 *    row (`agreesWithWorld`; a row without a nullifier always is): false once another person has
 *    verified World ID on the account since the record was written, for a row with a nullifier
 *    where World ID is not configured, and when there is no row;
 *  - the latest row with the names of record decrypted (the only output that holds a name;
 *    `names: null` with the key id and a note when the row's key is missing);
 *  - every row with its events.
 */
export function showIdentity(
  db: Database.Database,
  cfg: Config,
  tenantArg: string,
): Record<string, unknown> {
  const tenantId = parseTenant(tenantArg);
  const pii = requirePii(cfg);
  const repo = new SqliteIdentityRepository(db);
  const world = cfg.world ? buildWorldIdDeps(cfg.world, new SqliteWorldStore(db)) : undefined;
  const rows = repo.list(tenantId);
  const latest = rows.at(-1);
  return {
    tenantId,
    state: identityState(repo, tenantId, Date.now(), legalBodyEnvironment(cfg)),
    countsAtTheDoors: latest !== undefined && agreesWithWorld(latest, world, tenantId),
    latestCheckId: latest?.checkId ?? null,
    /** What the next writing command takes as `--expect-latest`. */
    expectLatest: latest === undefined ? "none" : String(latest.checkId),
    latest:
      latest === undefined
        ? null
        : {
            checkId: latest.checkId,
            status: latest.status,
            supersedesCheckId: latest.supersedesCheckId,
            reviewReasons: latest.reviewReasons,
            ...shownNames(identityDeps(cfg, repo, pii), latest),
            namesErasedAt: latest.namesErasedAt,
            provider: latest.provider,
            providerRef: latest.providerRef,
            completedAt: latest.completedAt,
            expiresAt: latest.expiresAt,
            documentCountry: latest.documentCountry,
            documentType: latest.documentType,
            documentExpired: latest.documentExpired,
            liveness: latest.liveness,
            watchlist: latest.watchlist,
            environment: latest.environment,
            synthetic: latest.synthetic,
            operator: latest.operator,
            operatorOsUser: latest.operatorOsUser,
          },
    history: rows.map((row) => ({
      checkId: row.checkId,
      status: row.status,
      supersedesCheckId: row.supersedesCheckId,
      reviewReasons: row.reviewReasons,
      completedAt: row.completedAt,
      expiresAt: row.expiresAt,
      namesErasedAt: row.namesErasedAt,
      operator: row.operator,
      events: repo.events(row.checkId).map((e) => ({
        eventId: e.eventId,
        kind: e.kind,
        at: e.at,
        actor: e.actor,
        reasonCode: e.reasonCode,
        reason: e.reason,
      })),
    })),
  };
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

const codesHelp = (codes: readonly string[]): string => codes.join(", ");

export function registerIdentityCommands(program: Command): void {
  program
    .command("identity:show")
    .argument("<tenantId>", TENANT_HELP)
    .description(
      "show a guardian's identity state, the latest check with its names (the only command that prints a name), and every check with its events. Writes no ops line",
    )
    .action((tenantId: string) =>
      withDatabase((db, _docStoreDir, cfg) => print(showIdentity(db, cfg, tenantId))),
    );

  program
    .command("identity:record")
    .argument("<tenantId>", TENANT_HELP)
    .description(
      "record an identity check read in the provider's dashboard. Rows are kept for ever: no personal data in a reason",
    )
    .requiredOption("--provider <stripe|persona|sumsub|sandbox>", "the provider that ran the check")
    .requiredOption("--provider-ref <id>", "the provider's id of the check, such as vs_…")
    .requiredOption("--result <passed|failed|needs_review>", "what the provider shows")
    .option(
      "--name-first <text>",
      "passed, needs_review: the first name as the guardian gave it, confirmed against the document",
    )
    .option(
      "--name-last <text>",
      "passed, needs_review: the last name as the guardian gave it, confirmed against the document",
    )
    .option(
      "--name-full <text>",
      "passed, needs_review, optional: the full name as the guardian gave it, confirmed against the document",
    )
    .option(
      "--names-prompt",
      "passed, needs_review: type the names at a prompt (or pipe them in, one per line: first, last, optional full) instead of the three name flags",
    )
    .option(
      "--name-mismatch",
      "passed, needs_review: the guardian's name differs from the document's; the check waits for review (resolve it with identity:correct-name)",
    )
    .option("--country <ISO-3>", "the document's issuing country, ISO 3166-1 alpha-3 (FRA)")
    .option("--document-type <passport|identity_card|driving_licence>", "the document checked")
    .option("--document-expired", "the document was out of date")
    .option(
      "--liveness <passed|failed|not_run>",
      "the selfie check; a pass on production needs passed",
    )
    .option(
      "--watchlist <clear|hit|not_run>",
      "passed, needs_review: your sanctions search; a pass on production needs clear or hit",
    )
    .option(
      "--completed-at <ISO-8601>",
      "when the provider shows the check completed, with its zone; default now",
    )
    .option("--reason-code <code>", `failed: ${codesHelp(FAILURE_REASON_CODES)}`)
    .option("--reason <text>", `failed: ${REASON_HELP}`)
    .requiredOption("--operator <name>", `who records: ${OPERATOR_NAME.source}`)
    .requiredOption("--expect-latest <checkId|none>", EXPECT_LATEST_HELP)
    .option("--yes", "confirm: record the check")
    .action(async (tenantId: string, opts: RecordOptions) => {
      // Refused before anything is read at the prompt, as is a configuration that refuses.
      if (opts.namesPrompt === true && opts.result === "failed")
        refuse("--names-prompt is not taken with --result failed: a failed check keeps no name");
      const loaded = sealingConfig();
      const withNames = await withPromptedNames(opts, () =>
        readNames(process.stdin, process.stderr),
      );
      withDatabase(
        (db, _docStoreDir, cfg) => print(recordIdentity(db, cfg, tenantId, withNames)),
        loaded,
      );
    });

  const decision = (
    name: string,
    description: string,
    codes: readonly string[],
    confirm: string,
  ): Command =>
    program
      .command(name)
      .argument("<tenantId>", TENANT_HELP)
      .description(`${description}. Rows are kept for ever: no personal data in the reason`)
      .requiredOption("--reason-code <code>", codesHelp(codes))
      .requiredOption("--reason <text>", REASON_HELP)
      .requiredOption("--operator <name>", `who decides: ${OPERATOR_NAME.source}`)
      .requiredOption("--expect-latest <checkId>", EXPECT_CHECK_HELP)
      .option("--yes", `confirm: ${confirm}`);

  decision(
    "identity:accept",
    "accept a check in review: a passed row with its names",
    ACCEPT_DECISION_CODES,
    "record the acceptance",
  ).action((tenantId: string, opts: DecisionOptions) =>
    withDatabase((db, _docStoreDir, cfg) =>
      print(reviewIdentity(db, cfg, "accept", tenantId, opts)),
    ),
  );

  decision(
    "identity:refuse",
    "refuse a check in review, or an attempt that never completed: a failed row without names",
    REFUSE_DECISION_CODES,
    "record the refusal",
  ).action((tenantId: string, opts: DecisionOptions) =>
    withDatabase((db, _docStoreDir, cfg) =>
      print(reviewIdentity(db, cfg, "refuse", tenantId, opts)),
    ),
  );

  decision(
    "identity:revoke",
    "revoke a passed check: a revoked row without names. The identity side only: a live company is revoked with company:revoke",
    REVOKE_REASON_CODES,
    "record the revocation",
  ).action((tenantId: string, opts: DecisionOptions) =>
    withDatabase((db, _docStoreDir, cfg) => print(revokeIdentity(db, cfg, tenantId, opts))),
  );

  decision(
    "identity:correct-name",
    "correct the name of record of a passed check or a review: a new row with the new names",
    NAME_CORRECTION_CODES,
    "record the correction",
  )
    .option(
      "--name-first <text>",
      "the first name as the guardian gave it, confirmed against the document, in Latin script",
    )
    .option(
      "--name-last <text>",
      "the last name as the guardian gave it, confirmed against the document, in Latin script",
    )
    .option(
      "--name-full <text>",
      "optional: the full name as the guardian gave it, confirmed against the document; without it the record keeps none",
    )
    .option(
      "--names-prompt",
      "type the names at a prompt (or pipe them in, one per line: first, last, optional full) instead of the three name flags",
    )
    .action(async (tenantId: string, opts: CorrectNameOptions) => {
      // A configuration that refuses is refused before anything is read at the prompt.
      const loaded = sealingConfig();
      const withNames = await withPromptedNames(opts, () =>
        readNames(process.stdin, process.stderr),
      );
      withDatabase(
        (db, _docStoreDir, cfg) => print(correctIdentityName(db, cfg, tenantId, withNames)),
        loaded,
      );
    });

  program
    .command("identity:sweep")
    .description(
      "erase the names the retention rules say are due (the scheduler runs this daily); without --yes, count them",
    )
    .option("--yes", "confirm: erase the names")
    .action((opts: { yes?: boolean }) =>
      withDatabase((db, _docStoreDir, cfg) => print(sweepIdentityNames(db, cfg, opts))),
    );
}
