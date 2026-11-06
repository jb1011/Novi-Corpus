/**
 * The guardian identity record's state, the production gate the doors call, the one reader of the
 * names, and the `/me` block: what a tenant's rows add up to and what each answer may carry.
 *
 * The database is real (in memory). Every name is a made-up fixture, every tenant an invented
 * address, and the PII key a constant test key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { ApiError } from "../../src/errors";
import { type PiiKeyring, encryptText, parsePiiKey } from "../../src/formation/pii";
import { IDENTITY_AAD } from "../../src/identity/names";
import {
  IDENTITY_NOT_VERIFIED_MESSAGE,
  type IdentityDeps,
  assertIdentityVerified,
  currentRecord,
  identityState,
  identityView,
  namesOfRecord,
} from "../../src/identity/state";
import type { IdentityRowStatus } from "../../src/identity/types";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type GuardianIdentityCheck,
  type NewGuardianIdentityCheck,
  type NewIdentityEvent,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { recordHuman, worldFor } from "../helpers/customerCompanyFixtures";

const DAY = 86_400_000;
/** 10 November 2026, 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 10, 12);
const THREE_YEARS = Date.UTC(2029, 10, 10, 12) - T0;
/** The clock every check reads: a month after the rows were written. */
const NOW = T0 + 30 * DAY;
const RING: PiiKeyring = {
  current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY"),
};
const FIRST = "Jean";
const LAST = "Dupont";
const FULL = "Jean Pierre Dupont";
/** A tenant id as the session spells it: EIP-55 checksummed. */
const tenant = (n: number): Address =>
  getAddress(`0x${"cd".repeat(18)}${n.toString(16).padStart(4, "0")}`);

let db: Database.Database;
let repo: SqliteIdentityRepository;
let store: SqliteWorldStore;
let world: WorldIdDeps;
let identity: IdentityDeps;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteIdentityRepository(db);
  store = new SqliteWorldStore(db);
  world = worldFor(store);
  identity = {
    repo,
    pii: RING,
    reverifyYears: 3,
    blockedCountries: new Set(["CUB", "IRN", "PRK"]),
    now: () => NOW,
  };
});
afterEach(() => db.close());

/** The names of record of a tenant, encrypted as the operator's command encrypts them. */
function sealedNames(tenantId: string, full: string | null = FULL) {
  const seal = (field: "first" | "last" | "full", value: string) => {
    const { ciphertext, iv } = encryptText(RING, value, IDENTITY_AAD(tenantId, field));
    return { ciphertext, iv };
  };
  return {
    first: seal("first", FIRST),
    last: seal("last", LAST),
    full: full === null ? null : seal("full", full),
    keyId: RING.current.id,
  };
}

function row(
  tenantId: string,
  status: IdentityRowStatus,
  over: Partial<NewGuardianIdentityCheck> = {},
): NewGuardianIdentityCheck {
  const holdsNames = status !== "failed" && status !== "revoked";
  return {
    // The nullifier of the World row `verifiedGuardian` records beside it: the record and the World
    // row agree.
    nullifier: `0xnullifier-${tenantId}`,
    tenantId,
    provider: "stripe",
    providerRef: "vs_example",
    subject: null,
    status,
    supersedesCheckId: null,
    startedAt: T0,
    completedAt: status === "started" ? null : T0,
    expiresAt: status === "started" ? null : T0 + THREE_YEARS,
    names: holdsNames ? sealedNames(tenantId) : null,
    nameHmac: "e".repeat(64),
    documentCountry: "FRA",
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: "clear",
    reviewReasons: status === "needs_review" ? ["watchlist_hit"] : [],
    environment: "production",
    synthetic: false,
    operator: "ops.example",
    operatorOsUser: "ops",
    ...over,
  };
}

const recorded: NewIdentityEvent = {
  kind: "recorded",
  at: T0,
  actor: "ops.example",
  actorOsUser: "ops",
  reasonCode: null,
  reason: null,
};

/** A passed record of the tenant, its World row beside it: the guardian the doors let through. */
function verifiedGuardian(tenantId: Address, over: Partial<NewGuardianIdentityCheck> = {}) {
  recordHuman(store, tenantId, `0xnullifier-${tenantId}`, T0);
  return repo.append(row(tenantId, "passed", over), recorded);
}

/** A passed record that sat unused: its names erased by the retention sweep's `unused` rule. */
function erasedUnused(tenantId: Address): GuardianIdentityCheck {
  const passed = verifiedGuardian(tenantId);
  const erased = repo.eraseNames(passed.checkId, NOW, {
    kind: "names_erased",
    at: NOW,
    actor: "system",
    actorOsUser: null,
    reasonCode: "unused",
    reason: null,
  });
  expect(erased).toBe(true);
  return repo.findById(passed.checkId) as GuardianIdentityCheck;
}

/** Anything read from it throws: proof that a path reads nothing. */
function untouchable<T>(what: string): T {
  return new Proxy(
    {},
    {
      get(_, key) {
        throw new Error(`${what} was read (${String(key)})`);
      },
    },
  ) as T;
}

function refusalOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("identityState", () => {
  test("the latest row decides: seven states, and an erased passed row reads expired", () => {
    // none: no row at all.
    // pending: an attempt begun.
    repo.append(row(tenant(2), "started"), recorded);
    // needs_review: the check went to the operator.
    repo.append(row(tenant(3), "needs_review"), recorded);
    // failed: the check failed.
    repo.append(row(tenant(4), "failed", { reviewReasons: [] }), recorded);
    // verified: passed, and re-verification is not due yet.
    repo.append(row(tenant(5), "passed"), recorded);
    // expired: passed, and re-verification fell due at this very instant.
    repo.append(row(tenant(6), "passed", { expiresAt: NOW }), recorded);
    // revoked: a passed record, then its revocation.
    const passed = repo.append(row(tenant(7), "passed"), recorded);
    repo.append(row(tenant(7), "revoked", { supersedesCheckId: passed.checkId }), {
      ...recorded,
      kind: "revoked",
      reasonCode: "fraud",
      reason: "check 1 revoked",
    });
    // expired: passed and still in date, but its names were erased as unused: it names nobody.
    const erased = erasedUnused(tenant(8));
    expect(erased.expiresAt).toBeGreaterThan(NOW);

    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => identityState(repo, tenant(n), NOW))).toEqual([
      "none",
      "pending",
      "needs_review",
      "failed",
      "verified",
      "expired",
      "revoked",
      "expired",
    ]);
    // A millisecond earlier, the record that fell due was still in date.
    expect(identityState(repo, tenant(6), NOW - 1)).toBe("verified");
  });

  test("on production a test record never counts: a passed row written on a sandbox, or synthetic, reads none", () => {
    repo.append(row(tenant(1), "passed", { environment: "sandbox", synthetic: true }), recorded);
    repo.append(row(tenant(2), "passed", { environment: "sandbox", synthetic: false }), recorded);
    repo.append(row(tenant(3), "passed", { environment: "production", synthetic: true }), recorded);
    const real = repo.append(row(tenant(4), "passed"), recorded);

    for (const n of [1, 2, 3]) {
      expect(identityState(repo, tenant(n), NOW, "production"), `${n}`).toBe("none");
      expect(currentRecord(repo, tenant(n), NOW, "production"), `${n}`).toBeUndefined();
      // Without the environment, or on a sandbox, the row reads as today.
      expect(identityState(repo, tenant(n), NOW), `${n}`).toBe("verified");
      expect(identityState(repo, tenant(n), NOW, "sandbox"), `${n}`).toBe("verified");
    }
    expect(identityState(repo, tenant(4), NOW, "production")).toBe("verified");
    expect(currentRecord(repo, tenant(4), NOW, "production")).toEqual(real);
  });

  test("currentRecord is the latest row only while the state is verified", () => {
    const passed = repo.append(row(tenant(1), "passed"), recorded);
    repo.append(row(tenant(2), "passed", { expiresAt: NOW }), recorded);
    repo.append(row(tenant(3), "needs_review"), recorded);
    erasedUnused(tenant(4));

    expect(currentRecord(repo, tenant(1), NOW)).toEqual(passed);
    for (const n of [2, 3, 4, 5])
      expect(currentRecord(repo, tenant(n), NOW), `${n}`).toBeUndefined();
  });
});

describe("assertIdentityVerified", () => {
  test("on sandbox it returns undefined and reads nothing", () => {
    expect(
      assertIdentityVerified(
        untouchable<IdentityDeps>("the identity record"),
        untouchable<WorldIdDeps>("World ID"),
        tenant(1),
        "sandbox",
      ),
    ).toBeUndefined();
    expect(assertIdentityVerified(undefined, undefined, tenant(1), "sandbox")).toBeUndefined();
  });

  test("on production without the identity record wired: 503 identity_unavailable", () => {
    const e = refusalOf(() => assertIdentityVerified(undefined, world, tenant(1), "production"));
    expect([e.code, e.status, e.message]).toEqual([
      "identity_unavailable",
      503,
      "identity verification is not configured on this deployment",
    ]);
  });

  test("on production without a World row: 403 guardian_not_verified, the sentence the World check answers", () => {
    repo.append(row(tenant(1), "passed"), recorded);
    for (const w of [world, undefined]) {
      const e = refusalOf(() => assertIdentityVerified(identity, w, tenant(1), "production"));
      expect([e.code, e.status, e.message]).toEqual([
        "guardian_not_verified",
        403,
        "the guardian must complete World ID verification first",
      ]);
    }
  });

  test("on production, a record that is not verified: 403 guardian_identity_not_verified", () => {
    expect(IDENTITY_NOT_VERIFIED_MESSAGE).toBe(
      "the guardian must complete identity verification first, in the browser",
    );
    // Expired.
    verifiedGuardian(tenant(1), { expiresAt: NOW });
    // No record at all.
    recordHuman(store, tenant(2), "0xnullifier-2", T0);
    // In review.
    recordHuman(store, tenant(3), "0xnullifier-3", T0);
    repo.append(row(tenant(3), "needs_review"), recorded);
    // Erased as unused.
    erasedUnused(tenant(4));

    for (const n of [1, 2, 3, 4]) {
      const e = refusalOf(() => assertIdentityVerified(identity, world, tenant(n), "production"));
      expect([e.code, e.status, e.message], `${n}`).toEqual([
        "guardian_identity_not_verified",
        403,
        IDENTITY_NOT_VERIFIED_MESSAGE,
      ]);
    }
  });

  test("on production, a verified guardian: the record", () => {
    const passed = verifiedGuardian(tenant(1));
    expect(assertIdentityVerified(identity, world, tenant(1), "production")).toEqual(passed);
  });

  test("on production, a record of another human than the account's current World row: 403 guardian_identity_not_verified", () => {
    verifiedGuardian(tenant(1));
    // A second person verified World ID on the account since: the newer row is theirs.
    recordHuman(store, tenant(1), "0xnullifier-second-human", T0 + DAY);
    const e = refusalOf(() => assertIdentityVerified(identity, world, tenant(1), "production"));
    expect([e.code, e.status, e.message]).toEqual([
      "guardian_identity_not_verified",
      403,
      IDENTITY_NOT_VERIFIED_MESSAGE,
    ]);
  });

  test("on production, the same human verifying World ID again keeps the record; a record without a nullifier is held to its state alone", () => {
    const passed = verifiedGuardian(tenant(1));
    recordHuman(store, tenant(1), `0xnullifier-${tenant(1)}`, T0 + DAY);
    expect(assertIdentityVerified(identity, world, tenant(1), "production")).toEqual(passed);

    recordHuman(store, tenant(2), "0xnullifier-2", T0);
    const unbound = repo.append(row(tenant(2), "passed", { nullifier: null }), recorded);
    expect(assertIdentityVerified(identity, world, tenant(2), "production")).toEqual(unbound);
  });

  test("on production, a test record (written on a sandbox, or synthetic): 403 guardian_identity_not_verified", () => {
    verifiedGuardian(tenant(1), { environment: "sandbox", synthetic: true });
    verifiedGuardian(tenant(2), { synthetic: true });
    for (const n of [1, 2]) {
      const e = refusalOf(() => assertIdentityVerified(identity, world, tenant(n), "production"));
      expect([e.code, e.status, e.message], `${n}`).toEqual([
        "guardian_identity_not_verified",
        403,
        IDENTITY_NOT_VERIFIED_MESSAGE,
      ]);
    }
  });

  test("every refusal it throws is one of its three codes, its message one string literal", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "..", "src", "identity", "state.ts"),
      "utf8",
    );
    const start = source.indexOf("export function assertIdentityVerified(");
    expect(start).toBeGreaterThan(-1);
    const check = source.slice(start, source.indexOf("\n}\n", start));
    const refusals = check.match(/throw new ApiError\(/g) ?? [];
    const literal = [
      ...check.matchAll(/throw new ApiError\(\s*"([a-z_]+)",\s*\d{3},\s*"[^"\\\n]*",?\s*\)/g),
    ];
    expect(refusals).toHaveLength(3);
    expect(literal, "a refusal whose message is not one string literal").toHaveLength(
      refusals.length,
    );
    expect(literal.map((m) => m[1]).sort()).toEqual([
      "guardian_identity_not_verified",
      "guardian_not_verified",
      "identity_unavailable",
    ]);
  });
});

describe("namesOfRecord", () => {
  test("decrypts the first, last and full names", () => {
    const passed = repo.append(row(tenant(1), "passed"), recorded);
    expect(namesOfRecord(identity, passed)).toEqual({ first: FIRST, last: LAST, full: FULL });
  });

  test("a record kept without a full name reads its full name as null", () => {
    const passed = repo.append(
      row(tenant(1), "passed", { names: sealedNames(tenant(1), null) }),
      recorded,
    );
    expect(namesOfRecord(identity, passed)).toEqual({ first: FIRST, last: LAST, full: null });
  });

  test("a record written under the previous key reads after a rotation", () => {
    const passed = repo.append(row(tenant(1), "passed"), recorded);
    const rotated: IdentityDeps = {
      ...identity,
      pii: {
        current: parsePiiKey(Buffer.alloc(32, 9).toString("base64"), "FORMATION_PII_KEY"),
        previous: RING.current,
      },
    };
    expect(namesOfRecord(rotated, passed)).toEqual({ first: FIRST, last: LAST, full: FULL });
  });

  test("an erased record throws", () => {
    const erased = erasedUnused(tenant(1));
    expect(() => namesOfRecord(identity, erased)).toThrow("identity record has no names");
  });
});

describe("identityView", () => {
  test("verified: the state, the first and last names, the dates, and nothing else", () => {
    const passed = verifiedGuardian(tenant(1));
    const view = identityView(identity, world, tenant(1), "production");
    expect(Object.keys(view)).toEqual([
      "required",
      "state",
      "firstName",
      "lastName",
      "verifiedAt",
      "expiresAt",
    ]);
    expect(view).toEqual({
      required: true,
      state: "verified",
      firstName: FIRST,
      lastName: LAST,
      verifiedAt: passed.completedAt,
      expiresAt: passed.expiresAt,
    });
    // Never the full name, the provider, the country or a reason.
    const text = JSON.stringify(view);
    for (const never of [FULL, "stripe", "FRA", "watchlist", "reason"])
      expect(text, never).not.toContain(never);
  });

  test("no record: only required and the state", () => {
    const view = identityView(identity, world, tenant(1), "production");
    expect(Object.keys(view)).toEqual(["required", "state"]);
    expect(view).toEqual({ required: true, state: "none" });
  });

  test("a state other than verified carries no name and no date", () => {
    recordHuman(store, tenant(1), `0xnullifier-${tenant(1)}`, T0);
    repo.append(row(tenant(1), "needs_review"), recorded);
    verifiedGuardian(tenant(2), { expiresAt: NOW });
    erasedUnused(tenant(3));
    expect(identityView(identity, world, tenant(1), "production")).toEqual({
      required: true,
      state: "needs_review",
    });
    expect(identityView(identity, world, tenant(2), "production")).toEqual({
      required: true,
      state: "expired",
    });
    expect(identityView(identity, world, tenant(3), "production")).toEqual({
      required: true,
      state: "expired",
    });
  });

  test("a record of another human than the account's current World row reads none, whatever its state", () => {
    verifiedGuardian(tenant(1));
    recordHuman(store, tenant(1), "0xnullifier-second-human", T0 + DAY);
    recordHuman(store, tenant(2), `0xnullifier-${tenant(2)}`, T0);
    repo.append(row(tenant(2), "needs_review"), recorded);
    recordHuman(store, tenant(2), "0xnullifier-second-human-2", T0 + DAY);
    for (const n of [1, 2])
      expect(identityView(identity, world, tenant(n), "production"), `${n}`).toEqual({
        required: true,
        state: "none",
      });
    // A record without a nullifier reads its own state.
    recordHuman(store, tenant(3), "0xnullifier-3", T0);
    repo.append(row(tenant(3), "passed", { nullifier: null }), recorded);
    expect(identityView(identity, world, tenant(3), "production")).toMatchObject({
      state: "verified",
      firstName: FIRST,
    });
  });

  test("on production a test record reads none; on a sandbox the same row reads verified", () => {
    verifiedGuardian(tenant(1), { environment: "sandbox", synthetic: true });
    verifiedGuardian(tenant(2), { synthetic: true });
    for (const n of [1, 2])
      expect(identityView(identity, world, tenant(n), "production"), `${n}`).toEqual({
        required: true,
        state: "none",
      });
    expect(identityView(identity, world, tenant(1), "sandbox")).toMatchObject({
      required: false,
      state: "verified",
    });
  });

  test("required only on production; no identity record wired reads none", () => {
    expect(identityView(identity, world, tenant(1), "sandbox")).toEqual({
      required: false,
      state: "none",
    });
    expect(identityView(undefined, world, tenant(1), "production")).toEqual({
      required: true,
      state: "none",
    });
    expect(identityView(undefined, undefined, tenant(1), "sandbox")).toEqual({
      required: false,
      state: "none",
    });
  });
});
