import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { IdentityRowStatus } from "../../src/identity/types";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type EncryptedName,
  type NewGuardianIdentityCheck,
  type NewIdentityEvent,
  SqliteIdentityRepository,
  validateIdentityCheck,
} from "../../src/persistence/identityRepository";

const DAY = 86_400_000;
/** 10 November 2026, 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 10, 12);
const THREE_YEARS = Date.UTC(2029, 10, 10, 12) - T0;
const HMAC_A = "a".repeat(64);
const HMAC_B = "b".repeat(64);
/** A tenant id as the session spells it: EIP-55 checksummed, with letters for the checksum to case. */
const tenant = (n: number) => getAddress(`0x${"ab".repeat(18)}${n.toString(16).padStart(4, "0")}`);

/** Ciphertext and IV bytes only: no fixture here holds a readable name. */
const sealed = (byte: number): EncryptedName => ({
  ciphertext: Buffer.alloc(24, byte),
  iv: Buffer.alloc(12, byte),
});
const NAMES = { first: sealed(1), last: sealed(2), full: null, keyId: "k1" };

let db: Database.Database;
let repo: SqliteIdentityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteIdentityRepository(db);
});
afterEach(() => db.close());

function row(
  tenantId: string,
  status: IdentityRowStatus,
  over: Partial<NewGuardianIdentityCheck> = {},
): NewGuardianIdentityCheck {
  const holdsNames = status !== "failed" && status !== "revoked";
  return {
    nullifier: "0xnullifier",
    tenantId,
    provider: "sandbox",
    providerRef: "ref_1",
    subject: null,
    status,
    supersedesCheckId: null,
    startedAt: T0,
    completedAt: status === "started" ? null : T0,
    expiresAt: status === "started" ? null : T0 + THREE_YEARS,
    names: holdsNames ? NAMES : null,
    nameHmac: HMAC_A,
    documentCountry: "FRA",
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: "clear",
    reviewReasons: status === "needs_review" ? ["watchlist_hit"] : [],
    environment: "sandbox",
    synthetic: true,
    operator: "ops.example",
    operatorOsUser: "ops",
    ...over,
  };
}

const event = (kind: NewIdentityEvent["kind"], over: Partial<NewIdentityEvent> = {}) => ({
  kind,
  at: T0,
  actor: "ops.example",
  actorOsUser: "ops",
  reasonCode: null,
  reason: null,
  ...over,
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("SqliteIdentityRepository", () => {
  test("append writes the row and the event in one transaction", () => {
    const full = { ...NAMES, full: sealed(3) };
    const c = repo.append(
      row(tenant(1), "passed", { names: full, documentExpired: null }),
      event("recorded", { provider: "sandbox", providerEventId: "evt_1" }),
    );
    expect(c).toEqual({
      ...row(tenant(1), "passed", { names: full, documentExpired: null }),
      checkId: 1,
      namesErasedAt: null,
    });
    expect(repo.events(c.checkId)).toEqual([
      {
        ...event("recorded", { provider: "sandbox", providerEventId: "evt_1" }),
        eventId: 1,
        checkId: 1,
      },
    ]);

    // The event is refused by the database (its kind), after the row was inserted: both go.
    const bad = { ...event("recorded"), kind: "guessed" as NewIdentityEvent["kind"] };
    expect(() => repo.append(row(tenant(2), "passed"), bad)).toThrow(/CHECK/);
    expect(repo.latest(tenant(2))).toBeUndefined();
    expect(count("guardian_identity_checks")).toBe(1);
    expect(count("identity_check_events")).toBe(1);

    // Inside a caller's transaction, a later throw takes the appended row and event with it.
    expect(() =>
      repo.transaction(() => {
        repo.append(row(tenant(3), "passed"), event("recorded"));
        throw new Error("the caller's rule failed");
      }),
    ).toThrow(/the caller's rule failed/);
    expect(repo.latest(tenant(3))).toBeUndefined();
    expect(count("identity_check_events")).toBe(1);
  });

  test("an event without a provider reads without the provider keys", () => {
    const c = repo.append(row(tenant(1), "started"), event("recorded"));
    const [e] = repo.events(c.checkId);
    expect(e).toEqual({ ...event("recorded"), eventId: 1, checkId: c.checkId });
    expect(e && "provider" in e).toBe(false);
    expect(e && "providerEventId" in e).toBe(false);
  });

  test("latest returns the highest check_id of the tenant", () => {
    repo.append(row(tenant(1), "needs_review"), event("recorded"));
    repo.append(row(tenant(2), "passed"), event("recorded"));
    repo.append(
      row(tenant(1), "passed", { supersedesCheckId: 1, reviewReasons: [] }),
      event("accepted", { reasonCode: "watchlist_false_positive", reason: "checked by hand" }),
    );

    expect(repo.latest(tenant(1))).toMatchObject({
      checkId: 3,
      status: "passed",
      supersedesCheckId: 1,
    });
    expect(repo.latest(tenant(2))?.checkId).toBe(2);
    expect(repo.latest(tenant(9))).toBeUndefined();
    expect(repo.list(tenant(1)).map((c) => [c.checkId, c.status])).toEqual([
      [1, "needs_review"],
      [3, "passed"],
    ]);
    expect(repo.list(tenant(1))[0]?.reviewReasons).toEqual(["watchlist_hit"]);
    expect(repo.findById(2)?.tenantId).toBe(tenant(2));
    expect(repo.findById(99)).toBeUndefined();
    expect(repo.events(3).map((e) => [e.kind, e.reasonCode])).toEqual([
      ["accepted", "watchlist_false_positive"],
    ]);
  });

  test("passedElsewhere finds another tenant's latest passed row with the same hmac and country, and ignores a superseded one", () => {
    repo.append(row(tenant(1), "passed"), event("recorded")); // 1: latest, passed
    repo.append(row(tenant(2), "passed"), event("recorded")); // 2: superseded by 3
    repo.append(
      row(tenant(2), "revoked", { supersedesCheckId: 2 }),
      event("revoked", { reasonCode: "fraud", reason: "provider report" }),
    ); // 3
    repo.append(row(tenant(3), "passed", { documentCountry: "DEU" }), event("recorded")); // 4
    repo.append(row(tenant(4), "passed", { nameHmac: HMAC_B }), event("recorded")); // 5
    repo.append(row(tenant(5), "needs_review"), event("recorded")); // 6: not passed

    expect(repo.passedElsewhere([HMAC_A], "FRA", tenant(9))).toEqual([1]);
    expect(repo.passedElsewhere([HMAC_A], "FRA", tenant(1))).toEqual([]);
    expect(repo.passedElsewhere([HMAC_A], "DEU", tenant(1))).toEqual([4]);
    expect(repo.passedElsewhere([HMAC_B], "FRA", tenant(1))).toEqual([5]);

    // A second account of the same person: both are found from a third.
    repo.append(row(tenant(6), "passed"), event("recorded")); // 7
    expect(repo.passedElsewhere([HMAC_A], "FRA", tenant(9))).toEqual([1, 7]);
  });

  test("passedElsewhere matches any of the digests it is handed, as a key rotation hands two, and none for an empty list", () => {
    repo.append(row(tenant(1), "passed"), event("recorded")); // 1: HMAC_A
    repo.append(row(tenant(2), "passed", { nameHmac: HMAC_B }), event("recorded")); // 2

    expect(repo.passedElsewhere([HMAC_B, HMAC_A], "FRA", tenant(9))).toEqual([1, 2]);
    expect(repo.passedElsewhere([HMAC_B, HMAC_A], "FRA", tenant(2))).toEqual([1]);
    expect(repo.passedElsewhere([`${"c".repeat(64)}`, HMAC_A], "FRA", tenant(9))).toEqual([1]);
    expect(repo.passedElsewhere([], "FRA", tenant(9))).toEqual([]);
  });

  test("eraseNames clears the three ciphertexts, sets names_erased_at and appends a names_erased event", () => {
    repo.append(
      row(tenant(1), "passed", { names: { ...NAMES, full: sealed(3) } }),
      event("recorded"),
    );
    const erased = event("names_erased", {
      actor: "system",
      actorOsUser: null,
      reasonCode: "unused",
    });

    expect(repo.eraseNames(1, T0 + DAY, erased)).toBe(true);
    expect(repo.findById(1)).toMatchObject({
      names: null,
      namesErasedAt: T0 + DAY,
      status: "passed",
      nameHmac: HMAC_A,
      documentCountry: "FRA",
    });
    const stored = db
      .prepare(
        "SELECT name_first_ciphertext AS f, name_last_ciphertext AS l, name_full_ciphertext AS x FROM guardian_identity_checks WHERE check_id = 1",
      )
      .get();
    expect(stored).toEqual({ f: null, l: null, x: null });
    expect(repo.events(1).map((e) => [e.kind, e.actor, e.reasonCode])).toEqual([
      ["recorded", "ops.example", null],
      ["names_erased", "system", "unused"],
    ]);

    // Once: a second erasure, or one of an unknown row, changes nothing and records nothing.
    expect(repo.eraseNames(1, T0 + 2 * DAY, erased)).toBe(false);
    expect(repo.eraseNames(99, T0 + 2 * DAY, erased)).toBe(false);
    expect(repo.findById(1)?.namesErasedAt).toBe(T0 + DAY);
    expect(count("identity_check_events")).toBe(2);

    // An erasure is recorded as what it is.
    repo.append(row(tenant(2), "passed"), event("recorded"));
    expect(() => repo.eraseNames(2, T0 + DAY, event("revoked"))).toThrow(/names_erased/);
    expect(repo.findById(2)?.names).not.toBeNull();
  });

  test("erasureCandidates: superseded, abandoned, unused, and never a tenant with a live company", () => {
    // created_at is the database's own clock, so the window is read against the real time.
    const real = Date.now();
    const later = real + 31 * DAY;
    const old = { startedAt: real - 400 * DAY, completedAt: real - 400 * DAY };
    const recorded = event("recorded");

    // Superseded: a review, then its refusal. The review row still holds the names.
    repo.append(row(tenant(1), "needs_review"), recorded); // 1
    repo.append(
      row(tenant(1), "failed", { supersedesCheckId: 1, reviewReasons: [] }),
      event("refused", { reasonCode: "watchlist_confirmed", reason: "confirmed" }),
    ); // 2
    // Abandoned: a started attempt that never completed.
    repo.append(row(tenant(2), "started", { startedAt: real }), recorded); // 3
    // Unused: passed long ago; its only company was abandoned, which does not hold it.
    repo.append(row(tenant(3), "passed", old), recorded); // 4
    const companies = new SqliteCompanyRepository(db);
    const company = (tenantId: string) =>
      companies.create({
        tenantId,
        status: "draft",
        provider: "customer",
        environment: "sandbox",
        synthetic: true,
        nameOptions: [{ name: "Example Holdings", entityTypeEnding: "DAO LLC", position: 1 }],
        businessPurpose: "placeholder",
        industryLabel: "placeholder",
        intakeSynthesized: false,
      });
    expect(companies.setStatus(company(tenant(3)), "draft", "abandoned")).toBe(true);
    // Passed, but too recently to be unused.
    repo.append(row(tenant(4), "passed", { completedAt: real - 10 * DAY }), recorded); // 5
    // A review waits for the operator, however old.
    repo.append(row(tenant(5), "needs_review", old), recorded); // 6
    // A live company holds every row of its tenant: superseded, and the old passed one.
    repo.append(row(tenant(6), "needs_review", old), recorded); // 7
    repo.append(row(tenant(6), "passed", { ...old, supersedesCheckId: 7 }), event("accepted")); // 8
    company(tenant(6));
    // The same for an abandoned attempt.
    repo.append(row(tenant(7), "started", { startedAt: real - 400 * DAY }), recorded); // 9
    company(tenant(7));
    // An abandoned attempt that never held names has nothing to erase.
    repo.append(row(tenant(8), "started", { startedAt: real - 400 * DAY, names: null }), recorded); // 10

    expect(repo.erasureCandidates(later, 30 * DAY, 365 * DAY)).toEqual([
      { checkId: 1, rule: "superseded" },
      { checkId: 3, rule: "abandoned" },
      { checkId: 4, rule: "unused" },
    ]);
    // At the real time, nothing written today is old enough yet; the unused row is.
    expect(repo.erasureCandidates(real, 30 * DAY, 365 * DAY)).toEqual([
      { checkId: 4, rule: "unused" },
    ]);

    // An erased row is not a candidate again.
    const sweep = event("names_erased", { actor: "system", actorOsUser: null });
    for (const c of repo.erasureCandidates(later, 30 * DAY, 365 * DAY))
      expect(repo.eraseNames(c.checkId, later, { ...sweep, reasonCode: c.rule })).toBe(true);
    expect(repo.erasureCandidates(later, 30 * DAY, 365 * DAY)).toEqual([]);
    expect(repo.findById(6)?.names).not.toBeNull();
    expect(repo.findById(8)?.names).not.toBeNull();
  });

  test("erasureCandidates: a declaration not yet erased holds its tenant's rows, and stops once erased", () => {
    const real = Date.now();
    const owner = tenant(1);
    repo.append(
      row(owner, "passed", { startedAt: real - 400 * DAY, completedAt: real - 400 * DAY }),
      event("recorded"),
    );
    const companies = new SqliteCompanyRepository(db);
    const companyId = companies.create({
      tenantId: owner,
      status: "draft",
      provider: "customer",
      environment: "sandbox",
      synthetic: true,
      nameOptions: [{ name: "Example Holdings", entityTypeEnding: "DAO LLC", position: 1 }],
      businessPurpose: "placeholder",
      industryLabel: "placeholder",
      intakeSynthesized: false,
    });
    const declarations = new SqliteCompanyDeclarationRepository(db);
    declarations.insert({
      companyId,
      tenantId: owner,
      humanNullifier: "0xnullifier",
      declarantName: "Example Declarant",
      declarantTitle: "Manager",
      statementText: "Example statement of authority, written for tests.",
      statementHash: `0x${"a1".repeat(32)}`,
      statementDigest: `0x${"d1".repeat(32)}`,
      signature: `0x${"1b".repeat(65)}`,
      companyName: "Example Holdings DAO LLC",
      jurisdiction: "WY",
      filingNumber: "TEST-0001",
      wordingVersion: "1",
      chainId: 5042002,
      factory: getAddress(tenant(0xf1)),
      issuedAt: 1_790_000_000,
      synthetic: true,
    });
    // The company is abandoned, but its declaration still holds the declarant's data.
    expect(companies.setStatus(companyId, "draft", "abandoned")).toBe(true);
    expect(repo.erasureCandidates(real, 30 * DAY, 365 * DAY)).toEqual([]);

    expect(declarations.erasePii(companyId, Math.floor(real / 1000))).toBe(true);
    expect(repo.erasureCandidates(real, 30 * DAY, 365 * DAY)).toEqual([
      { checkId: 1, rule: "unused" },
    ]);
  });

  test("erasureCandidates refuses a retention window shorter than a day, a window in days among them", () => {
    expect(() => repo.erasureCandidates(Date.now(), 30, 365 * DAY)).toThrow(
      /^identity check: failedAfterMs must be a whole number of milliseconds, at least one day/,
    );
    expect(() => repo.erasureCandidates(Date.now(), 30 * DAY, 365)).toThrow(/unusedAfterMs/);
  });

  test("a tenant id is refused unless spelled as the session spells it, checksummed", () => {
    const lower = tenant(1).toLowerCase();
    expect(lower).not.toBe(tenant(1)); // the fixture's checksum cases at least one letter
    repo.append(row(tenant(1), "passed"), event("recorded"));

    const checksummed = /^identity check: tenantId must be an EIP-55 checksummed address$/;
    expect(() => repo.append(row(lower, "passed"), event("recorded"))).toThrow(checksummed);
    expect(() => repo.latest(lower)).toThrow(checksummed);
    expect(() => repo.list(lower)).toThrow(checksummed);
    expect(() => repo.passedElsewhere([HMAC_A], "FRA", lower)).toThrow(
      /^identity check: exceptTenantId must be an EIP-55 checksummed address$/,
    );
    expect(() => repo.latest("not an address")).toThrow(checksummed);
    expect(count("guardian_identity_checks")).toBe(1);
    expect(repo.latest(tenant(1))?.checkId).toBe(1);
  });

  test("validateIdentityCheck refuses a passed row without a country, a failed row with names, a lower-case country, a status outside the union", () => {
    expect(validateIdentityCheck(row(tenant(1), "passed"))).toEqual(row(tenant(1), "passed"));

    expect(() =>
      validateIdentityCheck(row(tenant(1), "passed", { documentCountry: null })),
    ).toThrow("identity check: documentCountry is required on a passed row");
    expect(() => validateIdentityCheck(row(tenant(1), "failed", { names: NAMES }))).toThrow(
      "identity check: names are not kept on a failed or revoked row",
    );
    expect(() =>
      validateIdentityCheck(row(tenant(1), "passed", { documentCountry: "fra" })),
    ).toThrow(/^identity check: documentCountry must be three upper-case letters/);
    expect(() =>
      validateIdentityCheck(row(tenant(1), "passed", { status: "expired" as IdentityRowStatus })),
    ).toThrow(/^identity check: status must be one of /);

    // The refusal comes before SQLite, and the message never repeats the value.
    let message = "";
    try {
      repo.append(row(tenant(1), "passed", { documentCountry: "fra" }), event("recorded"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^identity check: /);
    expect(message).not.toContain("fra");
    expect(count("guardian_identity_checks")).toBe(0);
  });

  test("validateIdentityCheck refuses the other shapes the table forbids", () => {
    const refused = (
      over: Partial<NewGuardianIdentityCheck>,
      status: IdentityRowStatus = "passed",
    ) =>
      expect(
        () => validateIdentityCheck(row(tenant(1), status, over)),
        JSON.stringify(Object.keys(over)),
      );
    refused({ provider: "other" as "stripe" }).toThrow(/provider must be one of/);
    refused({ completedAt: null }).toThrow(/completedAt is required/);
    refused({ completedAt: null }, "needs_review").toThrow(/completedAt is required/);
    refused({ expiresAt: null }).toThrow(/expiresAt is required on a passed row/);
    refused({ watchlist: null }).toThrow(/watchlist is required on a passed row/);
    refused({ nameHmac: null }).toThrow(/nameHmac is required on a passed row/);
    refused({ names: null }).toThrow(/names are required on a passed row/);
    refused({ names: NAMES }, "revoked").toThrow(/names are not kept/);
    refused({ nameHmac: "AB".repeat(32) }).toThrow(/nameHmac must be 64 lower-case hex digits/);
    refused({ startedAt: 1_790_000_000 }).toThrow(
      /startedAt must be a whole number of unix milliseconds/,
    );
    refused({ reviewReasons: ["guessed" as "provider_flag"] }).toThrow(
      /reviewReasons must each be one of/,
    );
    refused({
      names: { ...NAMES, first: { ciphertext: Buffer.alloc(8), iv: Buffer.alloc(8) } },
    }).toThrow(/names.first.iv must be 12 bytes/);
    refused({ operator: "Ops Example" }).toThrow(/operator must match/);
    refused({ tenantId: "" }).toThrow(/tenantId must be an EIP-55 checksummed address/);
    refused({ environment: "staging" as "sandbox" }).toThrow(/environment must be one of/);

    // What the table allows, the validation allows: a started row with no completion or names.
    expect(validateIdentityCheck(row(tenant(1), "started", { names: null })).status).toBe(
      "started",
    );
    expect(validateIdentityCheck(row(tenant(1), "failed")).names).toBeNull();
  });
});
