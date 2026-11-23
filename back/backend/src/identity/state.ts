import type { WorldIdDeps } from "../api/routes/worldId";
import { ApiError } from "../errors";
import { type EncryptedText, type PiiKeyring, decryptText } from "../formation/pii";
import { opsLog } from "../observability/opsLog";
import type {
  EncryptedName,
  GuardianIdentityCheck,
  IdentityRepository,
} from "../persistence/identityRepository";
import { IDENTITY_AAD } from "./names";
import { DECISION_EVENT_KINDS, type IdentityState, PASS_ENDING_REVIEW_REASONS } from "./types";

/**
 * THE GUARDIAN'S IDENTITY STATE, AND THE GATE ON IT. What a tenant's identity rows add up to
 * (derived from its latest row, and while a renewal is under way from the pass it renews; never
 * stored), the gate a production door calls right after `assertRealHuman`, the one reader of the
 * encrypted names outside the operator's commands, and the `identity` block of `GET /world-id/me`.
 *
 * World ID proves one real person; the identity check says who.
 */

export type { IdentityState } from "./types";

export interface IdentityDeps {
  repo: IdentityRepository;
  pii: PiiKeyring;
  // Carried for the formed-door writers; the CLI reads `cfg.identity`.
  reverifyYears: number;
  blockedCountries: ReadonlySet<string>;
  /** Unix milliseconds; `Date.now` when absent. */
  now?: () => number;
  /** Whether the identity check runs automatically on this deployment (the Stripe block is
   *  configured); absent reads false, the operator's path alone. */
  automatic?: boolean;
}

/** The `identity` block of `GET /world-id/me`: never the full name, the provider, the country or
 *  a reason. The names and the dates are there only when the state is `verified`. */
export interface IdentityView {
  required: boolean;
  /** Whether the check runs automatically here: the browser offers it rather than waiting for an
   *  operator. */
  automatic: boolean;
  state: IdentityState;
  firstName?: string;
  lastName?: string;
  verifiedAt?: number;
  expiresAt?: number;
}

/** The message of `guardian_identity_not_verified`, for a reader outside the gate; the gate
 *  writes it out as a literal, and a test holds the two equal. */
export const IDENTITY_NOT_VERIFIED_MESSAGE =
  "the guardian must complete identity verification first, in the browser";

const nowOf = (identity: IdentityDeps): number => (identity.now ?? Date.now)();

/** The deployment a row is read on; absent, the row is read as it is, wherever it was written. */
type ReadOn = "sandbox" | "production" | undefined;

/** The state of one row read by itself, as the latest, at `nowMs`, as a deployment of
 *  `environment` reads it. */
function stateOf(
  latest: GuardianIdentityCheck | undefined,
  nowMs: number,
  environment: ReadOn,
): IdentityState {
  if (latest === undefined) return "none";
  switch (latest.status) {
    case "started":
      return "pending";
    case "needs_review":
      return "needs_review";
    case "failed":
      return "failed";
    case "revoked":
      return "revoked";
    case "passed":
      // On production a test record never counts: a pass written on a sandbox, or synthetic, names
      // nobody a production door may write into a filing. It reads as no record at all.
      if (environment === "production" && (latest.environment !== "production" || latest.synthetic))
        return "none";
      // Identity design 9: a passed record unused for a year loses its names, and then names nobody.
      if (latest.names === null || latest.namesErasedAt !== null) return "expired";
      return latest.expiresAt !== null && latest.expiresAt > nowMs ? "verified" : "expired";
    default: {
      // A status added to the type without its case here stops this line compiling.
      const unreachable: never = latest.status;
      throw new Error(`unhandled identity row status ${String(unreachable)}`);
    }
  }
}

/**
 * A row that ends the pass before it for good: its revocation, or a review that found a sanctions
 * hit or a blocked country, refused since or not (decided 6 November); or any row an operator's
 * decision wrote since the pass (`DECISION_EVENT_KINDS`), on the pass itself (a correction of it)
 * or on a renewal attempt over it (a refusal of the attempt, a correction of its review): a
 * renewal an operator settled ends the old pass, which is what a decision means. Whatever is
 * written after it, that pass is never renewed again; only a new pass counts.
 */
function endsEarlierPass(repo: IdentityRepository, row: GuardianIdentityCheck): boolean {
  return (
    row.status === "revoked" ||
    (row.status === "needs_review" &&
      row.reviewReasons.some((code) => PASS_ENDING_REVIEW_REASONS.includes(code))) ||
    repo.events(row.checkId).some((e) => DECISION_EVENT_KINDS.includes(e.kind))
  );
}

/** A latest row that may leave the pass before it counting: a renewal attempt begun, failed, or
 *  under a review. A pass decides by itself; a revocation ends. Whether the attempts since the
 *  pass are new ones is `endsEarlierPass`'s question. */
function isRenewalAttempt(latest: GuardianIdentityCheck): boolean {
  return (
    latest.status === "started" || latest.status === "failed" || latest.status === "needs_review"
  );
}

/**
 * THE RENEWAL RULE (decided 6 November, with I-A): a renewal under way keeps the earlier pass
 * counting, and only a new attempt does. Under a latest row that is a renewal attempt
 * (`isRenewalAttempt`), the tenant's latest passed row counts while it reads `verified` by itself,
 * at `nowMs`, on `environment` (in date, its names held, and on production not a test record), and
 * no row written since it ends it (`endsEarlierPass`). The rows that leave it counting are new
 * attempts only: the adapter's `started` row and the completion of that session (a failed attempt,
 * or a review without a sanctions hit or a blocked country), and an operator's `identity:record`.
 * An operator's decision since the pass (a correction of it, a refusal of an attempt) ends it, as
 * do a revocation and a review that found a sanctions hit or a blocked country: the gate is never
 * looser than the latest row alone would make it, but for a new attempt. Undefined when no pass
 * counts.
 */
function renewedPass(
  repo: IdentityRepository,
  tenantId: string,
  latest: GuardianIdentityCheck,
  nowMs: number,
  environment: ReadOn,
): GuardianIdentityCheck | undefined {
  if (!isRenewalAttempt(latest)) return undefined;
  const pass = repo.latestPassed(tenantId);
  if (pass === undefined || stateOf(pass, nowMs, environment) !== "verified") return undefined;
  const since = repo.list(tenantId).filter((row) => row.checkId > pass.checkId);
  return since.some((row) => endsEarlierPass(repo, row)) ? undefined : pass;
}

/**
 * What the tenant's rows add up to at `nowMs`, read on `environment`, and the row a `verified`
 * rests on: the pass a renewal under way keeps counting (`renewedPass`), else the latest row by
 * itself. `counts` holds a row to one more rule, the `/me` view's (`agreesWithWorld`): a pass it
 * refuses is not renewed, and a latest row it refuses reads as no record at all.
 */
function standing(
  repo: IdentityRepository,
  tenantId: string,
  nowMs: number,
  environment: ReadOn,
  counts: (row: GuardianIdentityCheck) => boolean = () => true,
): { state: IdentityState; record: GuardianIdentityCheck | undefined } {
  const latest = repo.latest(tenantId);
  if (latest === undefined) return { state: "none", record: undefined };
  const pass = renewedPass(repo, tenantId, latest, nowMs, environment);
  if (pass !== undefined && counts(pass)) return { state: "verified", record: pass };
  if (!counts(latest)) return { state: "none", record: undefined };
  const state = stateOf(latest, nowMs, environment);
  return { state, record: state === "verified" ? latest : undefined };
}

/**
 * What the tenant's rows add up to at `nowMs`: its latest row decides, except under a renewal
 * under way, where the pass it renews still counts (`renewedPass`: a new attempt, a `started` or
 * `failed` row or a review whose reasons are neither `watchlist_hit` nor `country_blocked`, on top
 * of a pass that is still valid and that no operator's decision has settled since, reads
 * `verified`). With `environment` "production", a passed row written on
 * a sandbox or synthetic reads `none`, and is never renewed; without it, a row reads as it is. The
 * operator's writers read it without the environment; `identity:show` reads it as the deployment
 * does.
 */
export function identityState(
  repo: IdentityRepository,
  tenantId: string,
  nowMs: number,
  environment?: "sandbox" | "production",
): IdentityState {
  return standing(repo, tenantId, nowMs, environment).state;
}

/**
 * Identity design 6.9, the record and the World row must agree: a row that copied a World ID
 * nullifier counts only while that nullifier is the one of the tenant's current World row for the
 * guardian action (`findByTenant`, the newest). A second person who verified World ID on the
 * account since holds the current row, and the first person's record is not theirs. A row without
 * a nullifier (World ID optional, later) is held to its own state alone. The gate, the `/me` view
 * and the by-agent lookup's unsigned fact all hold the record to it.
 */
export function agreesWithWorld(
  record: GuardianIdentityCheck,
  world: WorldIdDeps | undefined,
  tenantId: string,
): boolean {
  if (record.nullifier === null) return true;
  return world?.store.findByTenant(tenantId, world.cfg.action)?.nullifier === record.nullifier;
}

/** The passed row the tenant's `verified` rests on, only while `identityState` (read on
 *  `environment`) is `verified`; else undefined. The latest row, or while a renewal is under way
 *  the pass it renews (`renewedPass`): the names and the dates of record are that pass's. */
export function currentRecord(
  repo: IdentityRepository,
  tenantId: string,
  nowMs: number,
  environment?: "sandbox" | "production",
): GuardianIdentityCheck | undefined {
  return standing(repo, tenantId, nowMs, environment).record;
}

/**
 * A guardian whose identity is verified, on production. Returns the current record; on a sandbox
 * deployment returns undefined and reads nothing. Any environment but `sandbox` is held to the
 * production rule.
 *
 * The checks, in order: the identity record is wired (else 503 `identity_unavailable`); the tenant
 * has a World row for the guardian action (else 403 `guardian_not_verified`, the sentence
 * `assertRealHuman` answers, so the doors keep one message); its identity state, read as production
 * (a test record reads `none`), is `verified` and the record (`currentRecord`: the latest row, or
 * the pass a renewal under way renews) is that World row's person, its nullifier the row's when it
 * holds one (else 403 `guardian_identity_not_verified`). The doors
 * call `assertRealHuman` first, which holds the World row to its credential and environment; this
 * one reads the row for its existence and nullifier.
 *
 * Each refusal is written out here, its message one string literal: the doors answer it and the
 * legal-body tools pass it on as it is, and a test reads this function to hold every refusal to
 * that form.
 */
export function assertIdentityVerified(
  identity: IdentityDeps | undefined,
  world: WorldIdDeps | undefined,
  tenantId: string,
  environment: "sandbox" | "production",
): GuardianIdentityCheck | undefined {
  if (environment === "sandbox") return undefined;
  if (identity === undefined)
    throw new ApiError(
      "identity_unavailable",
      503,
      "identity verification is not configured on this deployment",
    );
  const worldRow = world?.store.findByTenant(tenantId, world.cfg.action);
  if (worldRow === undefined)
    throw new ApiError(
      "guardian_not_verified",
      403,
      "the guardian must complete World ID verification first",
    );
  // Read as production whatever the spelling: every environment but a sandbox is held to its rule.
  const record = currentRecord(identity.repo, tenantId, nowOf(identity), "production");
  // The record and the World row must agree (`agreesWithWorld`), read from the row in hand.
  if (
    record === undefined ||
    (record.nullifier !== null && record.nullifier !== worldRow.nullifier)
  )
    throw new ApiError(
      "guardian_identity_not_verified",
      403,
      "the guardian must complete identity verification first, in the browser",
    );
  return record;
}

/**
 * The names of record, decrypted: the only reader of the ciphertexts outside the operator's
 * commands. The three fields share the row's one key id. Throws on a record without names, an
 * erased one among them: a current verified record always holds them (`identityState` reads an
 * erased one as `expired`), so the throw is that invariant's alarm.
 */
export function namesOfRecord(
  identity: IdentityDeps,
  record: GuardianIdentityCheck,
): { first: string; last: string; full: string | null } {
  const names = record.names;
  if (names === null || record.namesErasedAt !== null)
    throw new Error("identity record has no names");
  const read = (field: "first" | "last" | "full", name: EncryptedName): string => {
    const enc: EncryptedText = { ...name, keyId: names.keyId };
    return decryptText(identity.pii, enc, IDENTITY_AAD(record.tenantId, field));
  };
  return {
    first: read("first", names.first),
    last: read("last", names.last),
    full: names.full === null ? null : read("full", names.full),
  };
}

/**
 * The names of record, as a door reads them: a record whose names cannot be read (sealed under a
 * key this deployment no longer holds, or damaged) writes one CRITICAL ops line, with ids only and
 * never a name, and is answered 503 `identity_unavailable` rather than a bare 500. `GET
 * /world-id/me` and the declared doors read the names through it.
 */
export function namesOfRecordAtDoor(
  identity: IdentityDeps,
  record: GuardianIdentityCheck,
): { first: string; last: string; full: string | null } {
  try {
    return namesOfRecord(identity, record);
  } catch {
    opsLog("identity_names_unreadable", {
      level: "error",
      severity: "CRITICAL",
      checkId: record.checkId,
      keyId: record.names?.keyId ?? null,
      tenant: record.tenantId.slice(0, 10),
    });
    throw new ApiError(
      "identity_unavailable",
      503,
      "identity verification is unavailable on this deployment at the moment",
    );
  }
}

/**
 * The `identity` block of `GET /world-id/me`. Required on production; `automatic` where the
 * deployment runs the check itself (`IdentityDeps.automatic`), false without the record wired. The
 * state is `none` when the tenant has no record, when the record is not wired, when the latest
 * record is another person's than the account's current World row (`agreesWithWorld`), and on
 * production when it is a test record (a pass written on a sandbox, or synthetic). While a renewal
 * is under way the pass it renews decides, as the gate reads it (`currentRecord`), when that pass
 * is the World row's person; else the latest row by itself. On `verified` it carries the first and
 * last names and the dates of the record that counts, and never the full name, the provider, the
 * country or a reason. A verified record whose names cannot be read is answered 503
 * (`namesOfRecordAtDoor`).
 */
export function identityView(
  identity: IdentityDeps | undefined,
  world: WorldIdDeps | undefined,
  tenantId: string,
  environment: "sandbox" | "production",
): IdentityView {
  const required = environment === "production";
  const automatic = identity?.automatic === true;
  if (identity === undefined) return { required, automatic, state: "none" };
  const { state, record } = standing(identity.repo, tenantId, nowOf(identity), environment, (row) =>
    agreesWithWorld(row, world, tenantId),
  );
  if (state !== "verified" || record === undefined) return { required, automatic, state };
  const names = namesOfRecordAtDoor(identity, record);
  return {
    required,
    automatic,
    state,
    firstName: names.first,
    lastName: names.last,
    // A passed row always has both: the table's CHECK and `validateIdentityCheck` require them.
    verifiedAt: record.completedAt ?? undefined,
    expiresAt: record.expiresAt ?? undefined,
  };
}
