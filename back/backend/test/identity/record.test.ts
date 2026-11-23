/**
 * The rules that turn a check's result into an identity row (`src/identity/record.ts`), shared by
 * the operator's `identity:record` and the automatic adapter: the renewal, the review reasons in
 * the record's order, the status, the sealed names and their fingerprint, and the production pass.
 *
 * Every name is a made-up fixture, the PII key and the fingerprint key constant test keys, and
 * every tenant one of anvil's published test accounts, never a real wallet.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { decryptText, nameHmac } from "../../src/formation/pii";
import { IDENTITY_AAD } from "../../src/identity/names";
import {
  type CheckInput,
  CheckRefused,
  addUtcYears,
  assertProductionPass,
  fullNameOfRecord,
  namesAgree,
  planCheck,
  sealNames,
} from "../../src/identity/record";
import type { ReviewReasonCode } from "../../src/identity/types";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type EncryptedName,
  type GuardianIdentityCheck,
  type NewGuardianIdentityCheck,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  NAMES_OF_RECORD,
  TEST_PII_RING,
  passedIdentityRow,
} from "../helpers/customerCompanyFixtures";

const DAY = 86_400_000;
/** The name fingerprint's own secret: a constant test key. */
const FINGERPRINT_KEY = Buffer.alloc(32, 5);
/** 20 November 2026, 12:00 UTC: the clock of every plan. */
const NOW = Date.UTC(2026, 10, 20, 12);
/** 10 November 2026, 12:00 UTC: when the check completed. */
const COMPLETED = Date.UTC(2026, 10, 10, 12);
const FIRST = NAMES_OF_RECORD.first;
const LAST = NAMES_OF_RECORD.last;
const HMAC = nameHmac(FINGERPRINT_KEY, FIRST, LAST);

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const guardian = ANVIL_ACCOUNT_2.address;
const other = ANVIL_ACCOUNT_3.address;

let db: Database.Database;
let repo: SqliteIdentityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteIdentityRepository(db);
});
afterEach(() => db.close());

const deps = (over: { nowMs?: number; blockedCountries?: ReadonlySet<string> } = {}) => ({
  repo,
  pii: TEST_PII_RING,
  nameHmacKey: FINGERPRINT_KEY,
  reverifyYears: 3,
  blockedCountries: over.blockedCountries ?? new Set(["PRK"]),
  nowMs: over.nowMs ?? NOW,
});

/** A clean pass on a sandbox, as the command hands it over; `over` changes any field. */
const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  tenantId: guardian,
  nullifier: "1001",
  provider: "stripe",
  providerRef: "vs_test_0001",
  subject: null,
  result: "passed",
  names: { first: FIRST, last: LAST, full: null },
  nameMismatch: false,
  country: "FRA",
  documentType: "passport",
  documentExpired: false,
  liveness: "passed",
  watchlist: "clear",
  startedAt: COMPLETED - 60_000,
  completedAt: COMPLETED,
  environment: "sandbox",
  synthetic: true,
  operator: "ops.example",
  operatorOsUser: "ops",
  ...over,
});

/** A row appended with its `recorded` event, as a writer would. */
function appended(row: NewGuardianIdentityCheck): GuardianIdentityCheck {
  return repo.append(row, {
    kind: "recorded",
    at: row.completedAt ?? row.startedAt,
    actor: "ops.example",
    actorOsUser: "ops",
    reasonCode: null,
    reason: null,
  });
}

/** A tenant's current pass holding `country` and a name fingerprint, the fixture's by default. */
function passOf(
  tenantId: string,
  country: string,
  at = COMPLETED - 30 * DAY,
  hmac = HMAC,
): GuardianIdentityCheck {
  return appended({
    ...passedIdentityRow(tenantId, { at, expiresAt: addUtcYears(at, 3) }),
    nameHmac: hmac,
    documentCountry: country,
  });
}

/** The CheckRefused `fn` throws, as its message. */
function refusedBy(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CheckRefused);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

const opened = (
  tenantId: string,
  field: "first" | "last" | "full",
  name: EncryptedName,
  keyId: string,
) => decryptText(TEST_PII_RING, { ...name, keyId }, IDENTITY_AAD(tenantId, field));

// ── a pass ──────────────────────────────────────────────────────────────────────────────────

describe("planCheck", () => {
  test("a clean pass plans a passed row: expiry three UTC years from the completion, names sealed to the tenant, the name's fingerprint", () => {
    const plan = planCheck(
      deps(),
      input({ names: { first: FIRST, last: LAST, full: "Ada M Example" } }),
    );

    expect(plan.duplicateOf).toEqual([]);
    expect(plan.renews).toBeUndefined();
    expect(plan.row).toMatchObject({
      tenantId: guardian,
      nullifier: "1001",
      provider: "stripe",
      providerRef: "vs_test_0001",
      subject: null,
      status: "passed",
      supersedesCheckId: null,
      startedAt: COMPLETED - 60_000,
      completedAt: COMPLETED,
      // 10 November 2026 stays 10 November, three years on.
      expiresAt: Date.UTC(2029, 10, 10, 12),
      nameHmac: HMAC,
      documentCountry: "FRA",
      documentType: "passport",
      documentExpired: false,
      liveness: "passed",
      watchlist: "clear",
      reviewReasons: [],
      environment: "sandbox",
      synthetic: true,
      operator: "ops.example",
      operatorOsUser: "ops",
    });
    const names = plan.row.names;
    if (names === null) throw new Error("a passed row holds its names");
    expect(names.keyId).toBe(TEST_PII_RING.current.id);
    expect(opened(guardian, "first", names.first, names.keyId)).toBe(FIRST);
    expect(opened(guardian, "last", names.last, names.keyId)).toBe(LAST);
    expect(opened(guardian, "full", names.full as EncryptedName, names.keyId)).toBe(
      "Ada M Example",
    );
    // Bound to the tenant and the field: moved, they do not open.
    expect(() => opened(other, "first", names.first, names.keyId)).toThrow();
    expect(() => opened(guardian, "last", names.first, names.keyId)).toThrow();
  });

  test("it plans and writes nothing: the caller appends the row", () => {
    planCheck(deps(), input());

    expect(repo.list(guardian)).toEqual([]);
  });

  test("a failed result plans a failed row with no names, no fingerprint, no expiry and no review reason, whatever it was handed", () => {
    const plan = planCheck(
      deps(),
      input({ result: "failed", nameMismatch: true, watchlist: "hit", documentExpired: true }),
    );

    expect(plan.row).toMatchObject({
      status: "failed",
      names: null,
      nameHmac: null,
      expiresAt: null,
      reviewReasons: [],
    });
    expect(plan.duplicateOf).toEqual([]);
  });

  // ── the review reasons ──────────────────────────────────────────────────────────────────────

  test.each<[string, Partial<CheckInput>, ReviewReasonCode]>([
    ["the provider's own review", { result: "needs_review" }, "provider_flag"],
    ["a sanctions hit", { watchlist: "hit" }, "watchlist_hit"],
    ["an out-of-date document", { documentExpired: true }, "document_expired"],
    ["a blocked country", { country: "PRK" }, "country_blocked"],
    [
      "a name outside the Latin script",
      { names: { first: "伟", last: "王", full: null } },
      "name_rule_failed",
    ],
    ["an empty first name", { names: { first: "", last: LAST, full: null } }, "name_rule_failed"],
    ["a name that differs from the document's", { nameMismatch: true }, "name_mismatch"],
  ])("%s lands the check in review with its one reason", (_what, over, reason) => {
    const plan = planCheck(deps(), input(over));

    expect(plan.row.status).toBe("needs_review");
    expect(plan.row.reviewReasons).toEqual([reason]);
    // A review keeps its names and its expiry, for the decision.
    expect(plan.row.names).not.toBeNull();
    expect(plan.row.expiresAt).toBe(Date.UTC(2029, 10, 10, 12));
  });

  test("every reason at once comes in the record's order, the duplicate last", () => {
    // Another account's current pass under the same name and country.
    const held = passOf(other, "PRK", COMPLETED - 30 * DAY, nameHmac(FINGERPRINT_KEY, "伟", "王"));

    const plan = planCheck(
      deps(),
      input({
        result: "needs_review",
        watchlist: "hit",
        documentExpired: true,
        country: "PRK",
        names: { first: "伟", last: "王", full: null },
        nameMismatch: true,
      }),
    );

    expect(plan.row.reviewReasons).toEqual([
      "provider_flag",
      "watchlist_hit",
      "document_expired",
      "country_blocked",
      "name_rule_failed",
      "name_mismatch",
      "duplicate_identity",
    ]);
    expect(plan.duplicateOf).toEqual([held.checkId]);
  });

  test("a country is blocked only when the deployment lists it", () => {
    expect(
      planCheck(deps({ blockedCountries: new Set() }), input({ country: "PRK" })).row,
    ).toMatchObject({
      status: "passed",
      reviewReasons: [],
    });
  });

  // ── the duplicate ───────────────────────────────────────────────────────────────────────────

  test("another tenant's current pass with the same fingerprint and country is a duplicate, by check id", () => {
    const held = passOf(other, "FRA");

    const plan = planCheck(deps(), input());

    expect(plan.duplicateOf).toEqual([held.checkId]);
    expect(plan.row).toMatchObject({
      status: "needs_review",
      reviewReasons: ["duplicate_identity"],
    });
  });

  test("the same fingerprint under another country, or another tenant's pass since revoked, is no duplicate", () => {
    passOf(other, "DEU");
    expect(planCheck(deps(), input()).duplicateOf).toEqual([]);

    const held = passOf(other, "FRA");
    const { checkId: _checkId, namesErasedAt: _erased, ...facts } = held;
    appended({
      ...facts,
      status: "revoked",
      supersedesCheckId: held.checkId,
      expiresAt: null,
      names: null,
      nameHmac: null,
    });
    expect(planCheck(deps(), input()).duplicateOf).toEqual([]);
  });

  // ── the renewal ─────────────────────────────────────────────────────────────────────────────

  test("a pass over the tenant's pass is a renewal: it names the pass, and its expiry runs from its own completion", () => {
    const current = passOf(guardian, "FRA", COMPLETED - 30 * DAY);

    const plan = planCheck(deps(), input());

    expect(plan.renews?.checkId).toBe(current.checkId);
    expect(plan.row).toMatchObject({
      status: "passed",
      supersedesCheckId: current.checkId,
      expiresAt: Date.UTC(2029, 10, 10, 12),
    });
    // The tenant's own pass is never its duplicate.
    expect(plan.duplicateOf).toEqual([]);
  });

  test("a renewal must complete after the current pass: the same time or an earlier one is refused", () => {
    passOf(guardian, "FRA", COMPLETED);
    const AFTER = `a renewal must complete after the current pass (${new Date(COMPLETED).toISOString()})`;

    for (const completedAt of [COMPLETED, COMPLETED - DAY])
      expect(
        refusedBy(() => planCheck(deps(), input({ completedAt }))),
        String(completedAt),
      ).toBe(AFTER);
    expect(planCheck(deps(), input({ completedAt: COMPLETED + 1 })).renews).toBeDefined();
  });

  test("a review or a failure over a pass renews nothing", () => {
    passOf(guardian, "FRA", COMPLETED - 30 * DAY);

    for (const over of [{ result: "needs_review" }, { result: "failed" }] as const) {
      const plan = planCheck(deps(), input(over));
      expect(plan.renews).toBeUndefined();
      expect(plan.row.supersedesCheckId).toBeNull();
    }
  });

  test("no pass is planned already expired: a completion three UTC years or more before now is refused, whatever the pass lands as", () => {
    const EXPIRED = "--completed-at is so old that this pass would already be expired";
    const now = { nowMs: Date.UTC(2029, 10, 10, 12) };

    expect(refusedBy(() => planCheck(deps(now), input()))).toBe(EXPIRED);
    expect(refusedBy(() => planCheck(deps(now), input({ watchlist: "hit" })))).toBe(EXPIRED);
    // A millisecond later the pass is in date for a millisecond.
    expect(planCheck(deps(now), input({ completedAt: COMPLETED + 1 })).row.status).toBe("passed");
    // A failure has no expiry to be past.
    expect(planCheck(deps(now), input({ result: "failed" })).row.status).toBe("failed");
  });

  // ── the production pass ─────────────────────────────────────────────────────────────────────

  test("on production a passed result needs the sanctions search and the face match, in the command's sentences; a review does not", () => {
    const production = { environment: "production", synthetic: false } as const;

    expect(refusedBy(() => planCheck(deps(), input({ ...production, watchlist: "not_run" })))).toBe(
      "on production a passed check needs the sanctions search: --watchlist clear or hit",
    );
    for (const liveness of [null, "failed", "not_run"] as const)
      expect(
        refusedBy(() => planCheck(deps(), input({ ...production, liveness }))),
        String(liveness),
      ).toBe("on production a passed check needs --liveness passed");
    // Without a search result at all, the row's own rule refuses it.
    expect(refusedBy(() => planCheck(deps(), input({ ...production, watchlist: null })))).toBe(
      "on production a passed check needs the sanctions search (--watchlist clear or hit), and this check has none: refuse it with identity:refuse and record a new check",
    );

    const review = planCheck(
      deps(),
      input({ ...production, result: "needs_review", liveness: "not_run", watchlist: "not_run" }),
    );
    expect(review.row).toMatchObject({
      status: "needs_review",
      reviewReasons: ["provider_flag"],
      environment: "production",
      synthetic: false,
    });
    expect(planCheck(deps(), input(production)).row.status).toBe("passed");
  });

  test("on a sandbox a pass needs neither", () => {
    expect(planCheck(deps(), input({ liveness: null, watchlist: "not_run" })).row).toMatchObject({
      status: "passed",
      reviewReasons: [],
    });
  });
});

// ── the helpers ───────────────────────────────────────────────────────────────────────────────

test("CheckRefused is an Error carrying the refusal's sentence, with no prefix", () => {
  const err = new CheckRefused("a sentence");

  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("CheckRefused");
  expect(err.message).toBe("a sentence");
});

test("assertProductionPass holds a production passed row to the face match, the search and the name rule; a sandbox row or a review to none", () => {
  const at = COMPLETED;
  const row = passedIdentityRow(guardian, { at, expiresAt: addUtcYears(at, 3) });
  const names = { first: FIRST, last: LAST };

  expect(() => assertProductionPass(row, names)).not.toThrow();
  expect(refusedBy(() => assertProductionPass({ ...row, liveness: "not_run" }, names))).toBe(
    "on production a passed check needs the face match (--liveness passed), and this check has none: refuse it with identity:refuse and record a new check",
  );
  expect(refusedBy(() => assertProductionPass({ ...row, watchlist: "not_run" }, names))).toBe(
    "on production a passed check needs the sanctions search (--watchlist clear or hit), and this check has none: refuse it with identity:refuse and record a new check",
  );
  expect(refusedBy(() => assertProductionPass(row, { first: "伟", last: "王" }))).toBe(
    "on production a passed check needs a name that passes the name rule (name must be written in the Latin script): correct it with identity:correct-name first",
  );
  expect(() =>
    assertProductionPass({ ...row, environment: "sandbox", liveness: "not_run" }, null),
  ).not.toThrow();
  expect(() =>
    assertProductionPass({ ...row, status: "needs_review", liveness: "not_run" }, null),
  ).not.toThrow();
});

test("addUtcYears adds whole UTC calendar years: 10 November stays 10 November", () => {
  expect(addUtcYears(Date.UTC(2026, 10, 10, 12), 3)).toBe(Date.UTC(2029, 10, 10, 12));
  expect(addUtcYears(Date.UTC(2026, 0, 1, 0, 0, 0, 1), 1)).toBe(Date.UTC(2027, 0, 1, 0, 0, 0, 1));
});

test("sealNames seals each name under the current key, bound to the tenant and its field; no full name seals none", () => {
  const sealed = sealNames(TEST_PII_RING, guardian, { first: FIRST, last: LAST, full: null });

  expect(sealed.keyId).toBe(TEST_PII_RING.current.id);
  expect(sealed.full).toBeNull();
  expect(opened(guardian, "first", sealed.first, sealed.keyId)).toBe(FIRST);
  expect(opened(guardian, "last", sealed.last, sealed.keyId)).toBe(LAST);
});

test("fullNameOfRecord: absent, empty or blank is no full name; else the name of record", () => {
  expect(fullNameOfRecord(undefined)).toBeNull();
  expect(fullNameOfRecord("")).toBeNull();
  expect(fullNameOfRecord("   ")).toBeNull();
  expect(fullNameOfRecord(" ADA  M EXAMPLE ")).toBe("Ada M Example");
});

describe("namesAgree", () => {
  const agree = (a: string, b: string) =>
    namesAgree({ first: a, last: LAST }, { first: b, last: LAST });

  test("case and spacing aside, as the name of record reads them", () => {
    expect(namesAgree({ first: FIRST, last: "DUPONT" }, { first: FIRST, last: "Dupont" })).toBe(
      true,
    );
    expect(agree(" Élodie ", "élodie")).toBe(true);
    expect(agree("Ada  Mae", "ada mae")).toBe(true);
  });

  test("one spelling: a decomposed name agrees with its composed form, the lower-casing composed again", () => {
    expect(agree("Élodie", "Élodie")).toBe(true);
    // A J with a caron has no capital composed form: lower-cased, it is composed again.
    expect(agree("AJ̌a", "aǰa")).toBe(true);
  });

  test("a different name, first or last, does not agree", () => {
    expect(agree("Jean-Pierre", "Jean")).toBe(false);
    expect(namesAgree({ first: FIRST, last: LAST }, { first: FIRST, last: "Exemple" })).toBe(false);
    expect(namesAgree({ first: FIRST, last: LAST }, { first: LAST, last: FIRST })).toBe(false);
  });
});
