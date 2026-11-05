import type { WorldIdDeps } from "../api/routes/worldId";
import { ApiError } from "../errors";
import { type EncryptedText, type PiiKeyring, decryptText } from "../formation/pii";
import type {
  EncryptedName,
  GuardianIdentityCheck,
  IdentityRepository,
} from "../persistence/identityRepository";
import { IDENTITY_AAD } from "./names";
import type { IdentityState } from "./types";

/**
 * THE GUARDIAN'S IDENTITY STATE, AND THE GATE ON IT. What a tenant's identity rows add up to
 * (derived from its latest row, never stored), the gate a production door calls right after
 * `assertRealHuman`, the one reader of the encrypted names outside the operator's commands, and
 * the `identity` block of `GET /world-id/me`.
 *
 * World ID proves one real person; the identity check says who.
 */

export type { IdentityState } from "./types";

export interface IdentityDeps {
  repo: IdentityRepository;
  pii: PiiKeyring;
  reverifyYears: number;
  blockedCountries: ReadonlySet<string>;
  /** Unix milliseconds; `Date.now` when absent. */
  now?: () => number;
}

/** The `identity` block of `GET /world-id/me`: never the full name, the provider, the country or
 *  a reason. The names and the dates are there only when the state is `verified`. */
export interface IdentityView {
  required: boolean;
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

/** The state of one latest row, at `nowMs`. */
function stateOf(latest: GuardianIdentityCheck | undefined, nowMs: number): IdentityState {
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

/** What the tenant's rows add up to at `nowMs`: its latest row decides. */
export function identityState(
  repo: IdentityRepository,
  tenantId: string,
  nowMs: number,
): IdentityState {
  return stateOf(repo.latest(tenantId), nowMs);
}

/** The tenant's latest row, only while `identityState` is `verified`; else undefined. One read. */
export function currentRecord(
  repo: IdentityRepository,
  tenantId: string,
  nowMs: number,
): GuardianIdentityCheck | undefined {
  const latest = repo.latest(tenantId);
  return stateOf(latest, nowMs) === "verified" ? latest : undefined;
}

/**
 * A guardian whose identity is verified, on production. Returns the current record; on a sandbox
 * deployment returns undefined and reads nothing. Any environment but `sandbox` is held to the
 * production rule.
 *
 * The checks, in order: the identity record is wired (else 503 `identity_unavailable`); the tenant
 * has a World row for the guardian action (else 403 `guardian_not_verified`, the sentence
 * `assertRealHuman` answers, so the doors keep one message); its identity state is `verified`
 * (else 403 `guardian_identity_not_verified`). The doors call `assertRealHuman` first, which holds
 * the World row to its credential and environment; this one only needs the row to exist.
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
  if (world?.store.findByTenant(tenantId, world.cfg.action) === undefined)
    throw new ApiError(
      "guardian_not_verified",
      403,
      "the guardian must complete World ID verification first",
    );
  const record = currentRecord(identity.repo, tenantId, nowOf(identity));
  if (record === undefined)
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
 * The `identity` block of `GET /world-id/me`. Required on production. The state is `none` when
 * the tenant has no record or the record is not wired; on `verified` it carries the first and last
 * names and the record's dates, and never the full name, the provider, the country or a reason.
 */
export function identityView(
  identity: IdentityDeps | undefined,
  // Unread today; part of the contract the formed-door slice consumes, for when World ID is optional.
  _world: WorldIdDeps | undefined,
  tenantId: string,
  environment: "sandbox" | "production",
): IdentityView {
  const required = environment === "production";
  if (identity === undefined) return { required, state: "none" };
  const latest = identity.repo.latest(tenantId);
  const state = stateOf(latest, nowOf(identity));
  if (state !== "verified" || latest === undefined) return { required, state };
  const names = namesOfRecord(identity, latest);
  return {
    required,
    state,
    firstName: names.first,
    lastName: names.last,
    // A passed row always has both: the table's CHECK and `validateIdentityCheck` require them.
    verifiedAt: latest.completedAt ?? undefined,
    expiresAt: latest.expiresAt ?? undefined,
  };
}
