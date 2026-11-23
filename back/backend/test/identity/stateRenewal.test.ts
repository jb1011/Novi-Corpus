/**
 * The renewal rule (Martin, 6 November, with I-A): a renewal attempt on top of a still-valid pass
 * keeps the pass counting. While the tenant's latest row is `started`, `failed`, or a review whose
 * reasons are neither a sanctions hit nor a blocked country, its latest pass reads `verified` and
 * is the current record, held to every rule a latest pass is held to (its expiry, its erased
 * names, a test record on production). A revocation, or a review that found a sanctions hit or a
 * blocked country, decides, and ends that pass for good. The gate and the `/me` block follow the
 * pass, and the retention sweep keeps its names as it keeps a latest pass's.
 *
 * The database is real (in memory). Every name is a made-up fixture, every tenant an invented
 * address, and the PII key a constant test key.
 */
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { ApiError } from "../../src/errors";
import { type PiiKeyring, encryptText, parsePiiKey } from "../../src/formation/pii";
import { IDENTITY_AAD } from "../../src/identity/names";
import {
  type IdentityDeps,
  assertIdentityVerified,
  currentRecord,
  identityState,
  identityView,
} from "../../src/identity/state";
import type { IdentityRowStatus, ReviewReasonCode } from "../../src/identity/types";
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
/** The clock the state is read at: a month after the pass. */
const NOW = T0 + 30 * DAY;
const RING: PiiKeyring = {
  current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY"),
};
const FIRST = "Jean";
const LAST = "Dupont";
const FULL = "Jean Pierre Dupont";
/** A tenant id as the session spells it: EIP-55 checksummed. */
const tenant = (n: number): Address =>
  getAddress(`0x${"ce".repeat(18)}${n.toString(16).padStart(4, "0")}`);

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

function sealedNames(tenantId: string) {
  const seal = (field: "first" | "last" | "full", value: string) => {
    const { ciphertext, iv } = encryptText(RING, value, IDENTITY_AAD(tenantId, field));
    return { ciphertext, iv };
  };
  return {
    first: seal("first", FIRST),
    last: seal("last", LAST),
    full: seal("full", FULL),
    keyId: RING.current.id,
  };
}

/** A row of the tenant, its nullifier the one of the World row `verifiedGuardian` records. */
function row(
  tenantId: string,
  status: IdentityRowStatus,
  over: Partial<NewGuardianIdentityCheck> = {},
): NewGuardianIdentityCheck {
  const holdsNames = status === "passed" || status === "needs_review";
  return {
    nullifier: `0xnullifier-${tenantId}`,
    tenantId,
    provider: "stripe",
    providerRef: "vs_example",
    subject: null,
    status,
    supersedesCheckId: null,
    startedAt: T0,
    completedAt: T0,
    expiresAt: status === "passed" || status === "needs_review" ? T0 + THREE_YEARS : null,
    names: holdsNames ? sealedNames(tenantId) : null,
    nameHmac: holdsNames ? "e".repeat(64) : null,
    documentCountry: "FRA",
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: "clear",
    reviewReasons: [],
    environment: "production",
    synthetic: false,
    operator: "ops.example",
    operatorOsUser: "ops",
    ...over,
  };
}

const passed = (tenantId: string, over: Partial<NewGuardianIdentityCheck> = {}) =>
  row(tenantId, "passed", over);

/** A renewal attempt begun, as the automatic check writes it when a session opens: no names and
 *  no result yet. */
const started = (tenantId: string, over: Partial<NewGuardianIdentityCheck> = {}) =>
  row(tenantId, "started", {
    providerRef: "vs_renewal",
    subject: "session-example",
    startedAt: NOW - DAY,
    completedAt: null,
    documentCountry: null,
    documentType: null,
    documentExpired: null,
    liveness: null,
    watchlist: null,
    operator: null,
    operatorOsUser: null,
    ...over,
  });

/** The renewal's result, gone to review for these reasons. */
const review = (
  tenantId: string,
  reviewReasons: ReviewReasonCode[],
  over: Partial<NewGuardianIdentityCheck> = {},
) =>
  row(tenantId, "needs_review", {
    providerRef: "vs_renewal",
    startedAt: NOW - DAY,
    completedAt: NOW - DAY,
    expiresAt: NOW - DAY + THREE_YEARS,
    watchlist: reviewReasons.includes("watchlist_hit") ? "hit" : "clear",
    reviewReasons,
    operator: null,
    operatorOsUser: null,
    ...over,
  });

/** The renewal's result, failed. */
const failed = (tenantId: string, over: Partial<NewGuardianIdentityCheck> = {}) =>
  row(tenantId, "failed", {
    providerRef: "vs_renewal",
    startedAt: NOW - DAY,
    completedAt: NOW - DAY,
    liveness: "failed",
    watchlist: null,
    operator: null,
    operatorOsUser: null,
    ...over,
  });

const revoked = (tenantId: string, supersedesCheckId: number) =>
  row(tenantId, "revoked", { supersedesCheckId });

const event = (over: Partial<NewIdentityEvent> = {}): NewIdentityEvent => ({
  kind: "recorded",
  at: T0,
  actor: "ops.example",
  actorOsUser: "ops",
  reasonCode: null,
  reason: null,
  ...over,
});
const SYSTEM = event({ actor: "system", actorOsUser: null });

function append(check: NewGuardianIdentityCheck, e: NewIdentityEvent = SYSTEM) {
  return repo.append(check, e);
}
const revoke = (tenantId: string, pass: GuardianIdentityCheck) =>
  append(
    revoked(tenantId, pass.checkId),
    event({ kind: "revoked", reasonCode: "fraud", reason: `check ${pass.checkId} revoked` }),
  );
const refuse = (tenantId: string, reviewed: GuardianIdentityCheck, code: string) =>
  append(
    failed(tenantId, { supersedesCheckId: reviewed.checkId, operator: "ops.example" }),
    event({ kind: "refused", reasonCode: code, reason: `check ${reviewed.checkId} refused` }),
  );

/** A passed record of the tenant, its World row beside it: the guardian the doors let through. */
function verifiedGuardian(tenantId: Address, over: Partial<NewGuardianIdentityCheck> = {}) {
  recordHuman(store, tenantId, `0xnullifier-${tenantId}`, T0);
  return append(passed(tenantId, over), event());
}

function erase(check: GuardianIdentityCheck, at: number): void {
  expect(
    repo.eraseNames(check.checkId, at, {
      kind: "names_erased",
      at,
      actor: "system",
      actorOsUser: null,
      reasonCode: "unused",
      reason: null,
    }),
  ).toBe(true);
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

const ENVIRONMENTS = [undefined, "sandbox", "production"] as const;

describe("identityState and currentRecord: a renewal over a still-valid pass", () => {
  test("a started renewal over a valid pass reads verified, and the current record is the pass", () => {
    const pass = append(passed(tenant(1)), event());
    append(started(tenant(1)));
    for (const environment of ENVIRONMENTS) {
      expect(identityState(repo, tenant(1), NOW, environment), `${environment}`).toBe("verified");
      expect(currentRecord(repo, tenant(1), NOW, environment), `${environment}`).toEqual(pass);
    }
  });

  test("a review over a valid pass whose reasons are neither a sanctions hit nor a blocked country reads verified", () => {
    const cases: ReviewReasonCode[][] = [
      ["name_mismatch"],
      ["duplicate_identity"],
      ["document_expired"],
      ["provider_flag"],
      ["name_rule_failed"],
      ["name_mismatch", "duplicate_identity"],
    ];
    cases.forEach((reasons, i) => {
      const pass = append(passed(tenant(i + 1)), event());
      append(started(tenant(i + 1)));
      append(review(tenant(i + 1), reasons));
      expect(identityState(repo, tenant(i + 1), NOW, "production"), reasons.join()).toBe(
        "verified",
      );
      expect(currentRecord(repo, tenant(i + 1), NOW, "production"), reasons.join()).toEqual(pass);
    });
  });

  test("a review that found a sanctions hit or a blocked country decides: needs_review, and no current record", () => {
    const cases: ReviewReasonCode[][] = [
      ["watchlist_hit"],
      ["country_blocked"],
      ["name_mismatch", "watchlist_hit"],
      ["duplicate_identity", "country_blocked"],
    ];
    cases.forEach((reasons, i) => {
      append(passed(tenant(i + 1)), event());
      append(started(tenant(i + 1)));
      append(review(tenant(i + 1), reasons));
      for (const environment of ENVIRONMENTS) {
        const label = `${reasons.join()} ${environment}`;
        expect(identityState(repo, tenant(i + 1), NOW, environment), label).toBe("needs_review");
        expect(currentRecord(repo, tenant(i + 1), NOW, environment), label).toBeUndefined();
      }
    });
  });

  test("a failed renewal attempt over a still-valid pass reads verified", () => {
    const pass = append(passed(tenant(1)), event());
    append(started(tenant(1)));
    append(failed(tenant(1)));
    // A second attempt, failed as well.
    append(started(tenant(1), { startedAt: NOW - 1000 }));
    const last = append(failed(tenant(1), { completedAt: NOW - 1000 }));
    expect(repo.latest(tenant(1))).toEqual(last);
    for (const environment of ENVIRONMENTS) {
      expect(identityState(repo, tenant(1), NOW, environment), `${environment}`).toBe("verified");
      expect(currentRecord(repo, tenant(1), NOW, environment), `${environment}`).toEqual(pass);
    }
  });

  test("a failed row with no still-valid pass under it reads failed", () => {
    // No pass at all.
    append(failed(tenant(1)));
    // A pass whose re-verification fell due at this very instant.
    append(passed(tenant(2), { expiresAt: NOW }), event());
    append(started(tenant(2)));
    append(failed(tenant(2)));
    // A pass whose names were erased: it names nobody.
    erase(append(passed(tenant(3)), event()), NOW);
    append(started(tenant(3)));
    append(failed(tenant(3)));

    for (const n of [1, 2, 3]) {
      expect(identityState(repo, tenant(n), NOW), `${n}`).toBe("failed");
      expect(currentRecord(repo, tenant(n), NOW), `${n}`).toBeUndefined();
    }
    // A millisecond earlier, the pass that fell due was still in date, and counted.
    expect(identityState(repo, tenant(2), NOW - 1)).toBe("verified");
  });

  test("a revoked row over a valid pass reads revoked", () => {
    const pass = append(passed(tenant(1)), event());
    revoke(tenant(1), pass);
    for (const environment of ENVIRONMENTS) {
      expect(identityState(repo, tenant(1), NOW, environment), `${environment}`).toBe("revoked");
      expect(currentRecord(repo, tenant(1), NOW, environment), `${environment}`).toBeUndefined();
    }
  });

  test("an expired pass, or one whose names were erased, under a started row reads pending", () => {
    append(passed(tenant(1), { expiresAt: NOW }), event());
    append(started(tenant(1)));
    erase(append(passed(tenant(2)), event()), NOW);
    append(started(tenant(2)));

    for (const n of [1, 2]) {
      expect(identityState(repo, tenant(n), NOW), `${n}`).toBe("pending");
      expect(currentRecord(repo, tenant(n), NOW), `${n}`).toBeUndefined();
    }
  });

  test("on production a test pass under a started row reads pending; on a sandbox it counts", () => {
    // Written on a sandbox.
    const sandboxPass = append(
      passed(tenant(1), { environment: "sandbox", synthetic: true }),
      event(),
    );
    append(started(tenant(1), { environment: "sandbox", synthetic: true }));
    // Synthetic.
    const syntheticPass = append(passed(tenant(2), { synthetic: true }), event());
    append(started(tenant(2)));

    for (const [n, pass] of [
      [1, sandboxPass],
      [2, syntheticPass],
    ] as const) {
      expect(identityState(repo, tenant(n), NOW, "production"), `${n}`).toBe("pending");
      expect(currentRecord(repo, tenant(n), NOW, "production"), `${n}`).toBeUndefined();
      expect(identityState(repo, tenant(n), NOW, "sandbox"), `${n}`).toBe("verified");
      expect(currentRecord(repo, tenant(n), NOW, "sandbox"), `${n}`).toEqual(pass);
      expect(identityState(repo, tenant(n), NOW), `${n}`).toBe("verified");
    }
  });

  test("a revocation, or a review that found a sanctions hit or a blocked country, ends the pass for good", () => {
    // Revoked, then a new attempt begun.
    revoke(tenant(1), append(passed(tenant(1)), event()));
    append(started(tenant(1)));
    // A renewal whose review found a sanctions hit, refused as confirmed.
    append(passed(tenant(2)), event());
    append(started(tenant(2)));
    refuse(tenant(2), append(review(tenant(2), ["watchlist_hit"])), "watchlist_confirmed");
    expect(identityState(repo, tenant(2), NOW)).toBe("failed");
    // Then another attempt begun.
    append(started(tenant(2), { startedAt: NOW - 1000 }));
    // A renewal from a blocked country, refused.
    append(passed(tenant(3)), event());
    append(started(tenant(3)));
    refuse(tenant(3), append(review(tenant(3), ["country_blocked"])), "country_blocked");

    for (const [n, state] of [
      [1, "pending"],
      [2, "pending"],
      [3, "failed"],
    ] as const)
      for (const environment of ENVIRONMENTS) {
        expect(identityState(repo, tenant(n), NOW, environment), `${n} ${environment}`).toBe(state);
        expect(
          currentRecord(repo, tenant(n), NOW, environment),
          `${n} ${environment}`,
        ).toBeUndefined();
      }
  });

  test("the pass renewed is the latest passed row: an older pass never stands in for it", () => {
    // In date for three years.
    append(passed(tenant(1)), event());
    // A newer pass, due at this very instant.
    append(passed(tenant(1), { expiresAt: NOW }), event());
    append(started(tenant(1)));
    expect(identityState(repo, tenant(1), NOW)).toBe("pending");
    expect(currentRecord(repo, tenant(1), NOW)).toBeUndefined();
  });
});

describe("the gate and the /me block follow the pass", () => {
  test("on production the gate lets the guardian through on the pass while a renewal is under way, and refuses once a review found a sanctions hit", () => {
    const pass = verifiedGuardian(tenant(1));
    append(started(tenant(1)));
    expect(assertIdentityVerified(identity, world, tenant(1), "production")).toEqual(pass);
    append(review(tenant(1), ["name_mismatch"]));
    expect(assertIdentityVerified(identity, world, tenant(1), "production")).toEqual(pass);

    verifiedGuardian(tenant(2));
    append(started(tenant(2)));
    append(review(tenant(2), ["watchlist_hit"]));
    const e = refusalOf(() => assertIdentityVerified(identity, world, tenant(2), "production"));
    expect([e.code, e.status]).toEqual(["guardian_identity_not_verified", 403]);
  });

  test("/me reads verified on the pass while a renewal is under way, with the pass's names and dates", () => {
    const pass = verifiedGuardian(tenant(1));
    append(started(tenant(1)));
    expect(identityView(identity, world, tenant(1), "production")).toEqual({
      required: true,
      automatic: false,
      state: "verified",
      firstName: FIRST,
      lastName: LAST,
      verifiedAt: pass.completedAt,
      expiresAt: pass.expiresAt,
    });
    // The renewal's review keeps it so, and still carries the pass's own dates.
    append(review(tenant(1), ["name_mismatch"]));
    expect(identityView(identity, world, tenant(1), "production")).toMatchObject({
      state: "verified",
      verifiedAt: pass.completedAt,
      expiresAt: pass.expiresAt,
    });
  });

  test("a pass of another person than the account's current World row is not renewed: the latest row's own state, and no names", () => {
    verifiedGuardian(tenant(1));
    // A second person verified World ID on the account since, and began a check of their own.
    recordHuman(store, tenant(1), "0xnullifier-second-human", T0 + DAY);
    append(started(tenant(1), { nullifier: "0xnullifier-second-human" }));

    expect(identityView(identity, world, tenant(1), "production")).toEqual({
      required: true,
      automatic: false,
      state: "pending",
    });
    const e = refusalOf(() => assertIdentityVerified(identity, world, tenant(1), "production"));
    expect([e.code, e.status]).toEqual(["guardian_identity_not_verified", 403]);
  });

  test("the /me block says whether the check is automatic: true when the deps say so, false otherwise", () => {
    expect(identityView({ ...identity, automatic: true }, world, tenant(1), "production")).toEqual({
      required: true,
      automatic: true,
      state: "none",
    });
    expect(identityView({ ...identity, automatic: true }, world, tenant(1), "sandbox")).toEqual({
      required: false,
      automatic: true,
      state: "none",
    });
    expect(
      identityView({ ...identity, automatic: false }, world, tenant(1), "production").automatic,
    ).toBe(false);
    // Absent reads false, and so does a deployment without the identity record wired.
    expect(identityView(identity, world, tenant(1), "production").automatic).toBe(false);
    expect(identityView(undefined, world, tenant(1), "production")).toEqual({
      required: true,
      automatic: false,
      state: "none",
    });
  });
});

describe("the retention sweep keeps the names of the pass the renewal rule counts", () => {
  // `created_at` is the database's own clock, so the windows are read against the real time.
  const WINDOWS = [30 * DAY, 365 * DAY] as const;

  /** A pass completed at `completedAt`, in date for three years from then. */
  const passAt = (
    tenantId: string,
    completedAt: number,
    over: Partial<NewGuardianIdentityCheck> = {},
  ) =>
    append(
      passed(tenantId, {
        startedAt: completedAt,
        completedAt,
        expiresAt: completedAt + THREE_YEARS,
        ...over,
      }),
      event(),
    );

  test("a pass under a started, a failed or a reviewed renewal, no company, 31 days on: not a candidate", () => {
    const real = Date.now();
    const later = real + 31 * DAY;
    passAt(tenant(1), real);
    append(started(tenant(1), { startedAt: real }));
    passAt(tenant(2), real);
    append(started(tenant(2), { startedAt: real }));
    append(failed(tenant(2), { startedAt: real, completedAt: real }));
    passAt(tenant(3), real);
    append(started(tenant(3), { startedAt: real }));
    append(
      review(tenant(3), ["name_mismatch"], {
        startedAt: real,
        completedAt: real,
        expiresAt: real + THREE_YEARS,
      }),
    );

    for (const n of [1, 2, 3])
      expect(identityState(repo, tenant(n), later), `${n}`).toBe("verified");
    expect(repo.erasureCandidates(later, ...WINDOWS)).toEqual([]);
  });

  test("the same pass 366 days after its completion: an unused candidate, as a latest pass is", () => {
    const real = Date.now();
    const pass = passAt(tenant(1), real);
    append(started(tenant(1), { startedAt: real }));
    expect(repo.erasureCandidates(real + 366 * DAY, ...WINDOWS)).toEqual([
      { checkId: pass.checkId, rule: "unused" },
    ]);
  });

  test("a pass under a revoked row, no company, 31 days on: superseded", () => {
    const real = Date.now();
    const pass = passAt(tenant(1), real);
    revoke(tenant(1), pass);
    expect(repo.erasureCandidates(real + 31 * DAY, ...WINDOWS)).toEqual([
      { checkId: pass.checkId, rule: "superseded" },
    ]);
  });

  test("a pass the rule does not count is superseded as before: revoked then renewed, under a sanctions review, expired, a test pass on production; a sandbox's own pass is kept", () => {
    const real = Date.now();
    const later = real + 31 * DAY;
    // Revoked, then a new attempt begun.
    const p1 = passAt(tenant(1), real);
    revoke(tenant(1), p1);
    append(started(tenant(1), { startedAt: real }));
    // Under a review that found a sanctions hit.
    const p2 = passAt(tenant(2), real);
    append(
      review(tenant(2), ["watchlist_hit"], {
        startedAt: real,
        completedAt: real,
        expiresAt: real + THREE_YEARS,
      }),
    );
    // Expired before the sweep runs.
    const p3 = passAt(tenant(3), real, { expiresAt: real + 10 * DAY });
    append(started(tenant(3), { startedAt: real }));
    // A synthetic pass under a renewal begun on a production deployment.
    const p4 = passAt(tenant(4), real, { synthetic: true });
    append(started(tenant(4), { startedAt: real }));
    // A sandbox deployment's own pass under a renewal begun there: the sandbox counts it.
    passAt(tenant(5), real, { environment: "sandbox", synthetic: true });
    append(started(tenant(5), { startedAt: real, environment: "sandbox", synthetic: true }));

    // The sweep agrees with the state each deployment reads.
    expect(identityState(repo, tenant(1), later)).toBe("pending");
    expect(identityState(repo, tenant(2), later)).toBe("needs_review");
    expect(identityState(repo, tenant(3), later)).toBe("pending");
    expect(identityState(repo, tenant(4), later, "production")).toBe("pending");
    expect(identityState(repo, tenant(5), later, "sandbox")).toBe("verified");
    expect(repo.erasureCandidates(later, ...WINDOWS)).toEqual([
      { checkId: p1.checkId, rule: "superseded" },
      { checkId: p2.checkId, rule: "superseded" },
      { checkId: p3.checkId, rule: "superseded" },
      { checkId: p4.checkId, rule: "superseded" },
    ]);
  });
});
