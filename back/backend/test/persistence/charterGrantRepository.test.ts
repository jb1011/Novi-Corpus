/**
 * The table of grants: one row per version of an order's grant, holding the grant's canonical form,
 * its fingerprint and the id of the Schedule A wording it was written in, append-only.
 *
 * A real in-memory database, and an order placed through the order door for a checked company.
 * Every key is one of anvil's published test accounts, every name, company and filing number an
 * invention, and every amount of the grants a made-up fixture (`grantFixtures.ts`).
 */
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Grant, buildGrant, grantFromCanonical } from "../../src/legalBody/grant";
import { createOrder } from "../../src/legalBody/orders";
import { migrate, openDatabase } from "../../src/persistence/db";
import { LegalBodyInputError } from "../../src/persistence/legalBodyInput";
import { ANVIL_ACCOUNT_2, recordHuman } from "../helpers/customerCompanyFixtures";
import { A, B } from "../helpers/grantFixtures";
import {
  type LegalBodyStores,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

const guardian = ANVIL_ACCOUNT_2;
/** A legal body id of the right shape that no order holds. */
const NO_ORDER = "lb_00000000-0000-4000-8000-000000000000";
const IN_ORDER = "charter_grants is append-only: a row comes after the order's latest, in order";
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const grantA = buildGrant(A, { number: 1, version: 1 });
const grantB = buildGrant(B, { number: 1, version: 1 });

let db: Database.Database;
let s: LegalBodyStores;
let id: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, guardian.address, "3001", Date.now());
  const companyId = customerCompany(s, guardian.address);
  id = createOrder(legalBodyOrderDeps(s), guardian.address, { companyId }).id;
});
afterEach(() => db.close());

/** What a row says of `grant`, but its time. */
const rowOf = (grant: Grant) => ({
  legalBodyId: id,
  number: grant.value.number,
  version: grant.value.version,
  canonical: grant.canonical,
  digest: grant.digest,
  wording: "2026-11-draft-4",
});

describe("charter_grants", () => {
  test("a grant is stored as its canonical form and its fingerprint, and read back", () => {
    s.grants.insert(id, grantA);
    const rows = s.grants.list(id);
    expect(rows).toEqual([{ ...rowOf(grantA), createdAt: expect.stringMatching(SQLITE_UTC) }]);
    const [row] = rows;
    if (row === undefined) throw new Error("no row");
    expect(grantFromCanonical(row.canonical)).toEqual(grantA);
    expect(s.grants.list(NO_ORDER)).toEqual([]);
  });

  test("a second row of the same number and version is refused", () => {
    s.grants.insert(id, grantA);
    expect(() => s.grants.insert(id, grantB)).toThrow(IN_ORDER);
    expect(s.grants.list(id).map(({ createdAt: _, ...row }) => row)).toEqual([rowOf(grantA)]);
  });

  test("rows come in order", () => {
    const oneTwo = buildGrant(B, { number: 1, version: 2 });
    const twoOne = buildGrant(A, { number: 2, version: 1 });
    s.grants.insert(id, grantA);
    s.grants.insert(id, oneTwo);
    expect(() => s.grants.insert(id, grantA)).toThrow(IN_ORDER);
    s.grants.insert(id, twoOne);
    // A key no row holds, but before the order's latest.
    expect(() => s.grants.insert(id, buildGrant(B, { number: 1, version: 3 }))).toThrow(IN_ORDER);
    expect(s.grants.list(id).map(({ createdAt: _, ...row }) => row)).toEqual([
      rowOf(grantA),
      rowOf(oneTwo),
      rowOf(twoOne),
    ]);
  });

  test("a row is never changed or removed", () => {
    s.grants.insert(id, grantA);
    const stored = s.grants.list(id);
    expect(() => db.prepare("UPDATE charter_grants SET wording = 'x'").run()).toThrow(
      "charter_grants is append-only",
    );
    expect(() => db.prepare("DELETE FROM charter_grants").run()).toThrow(
      "charter_grants is append-only",
    );
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO charter_grants
             (legal_body_id, grant_number, grant_version, canonical, digest, wording)
           SELECT legal_body_id, grant_number, grant_version, canonical, digest, 'x'
             FROM charter_grants`,
        )
        .run(),
    ).toThrow(IN_ORDER);
    expect(s.grants.list(id)).toEqual(stored);
  });

  test("an order that does not exist has no grant", () => {
    expect(() => s.grants.insert(NO_ORDER, grantA)).toThrow(/FOREIGN KEY/);
    expect(s.grants.list(NO_ORDER)).toEqual([]);
  });

  test("the database refuses a shape the repository never writes", () => {
    const insert = (over: Record<string, unknown>) =>
      db
        .prepare(
          `INSERT INTO charter_grants
             (legal_body_id, grant_number, grant_version, canonical, digest, wording)
           VALUES (@legal_body_id, @grant_number, @grant_version, @canonical, @digest, @wording)`,
        )
        .run({
          legal_body_id: id,
          grant_number: 1,
          grant_version: 1,
          canonical: grantA.canonical,
          digest: grantA.digest,
          wording: "2026-11-draft-4",
          ...over,
        });
    for (const over of [
      { grant_number: 0 },
      { digest: grantA.digest.toUpperCase().replace("0X", "0x") },
      { canonical: "" },
    ])
      expect(() => insert(over), JSON.stringify(over)).toThrow(/CHECK constraint failed/);
    expect(s.grants.list(id)).toEqual([]);
    // The same row with every value in shape is taken.
    insert({});
    expect(s.grants.list(id)).toHaveLength(1);
  });

  test("a value no row may hold is refused before anything is written", () => {
    for (const [legalBodyId, grant] of [
      ["", grantA],
      [id, { ...grantA, value: { ...grantA.value, number: 0 } }],
      [id, { ...grantA, value: { ...grantA.value, version: 1.5 } }],
      [id, { ...grantA, canonical: `${grantA.canonical.slice(0, -1)}é}` }],
      [id, { ...grantA, digest: "0x01" as Hex }],
    ] as const)
      expect(() => s.grants.insert(legalBodyId, grant)).toThrow(LegalBodyInputError);
    expect(s.grants.list(id)).toEqual([]);
    // Each value in shape, but the key or the fingerprint is not the one the canonical form states.
    const lastDigit = grantA.digest.slice(-1) === "0" ? "1" : "0";
    for (const grant of [
      { ...grantA, value: { ...grantA.value, version: 7 } },
      { ...grantA, digest: `${grantA.digest.slice(0, -1)}${lastDigit}` as Hex },
    ]) {
      expect(grantFromCanonical(grant.canonical)?.value.version).toBe(1);
      let caught: unknown;
      try {
        s.grants.insert(id, grant);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LegalBodyInputError);
      expect((caught as Error).message).toBe("grant must be the grant its canonical form states");
    }
    expect(s.grants.list(id)).toEqual([]);
  });
});
