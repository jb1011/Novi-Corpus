/**
 * The pot's notes: what the guardian of a legal body noted about the company's pot, append-only.
 * A `declared` note holds the address with the birth details it was recomputed from and the
 * version of the declaration the guardian ticked; a `removed` note takes the pot off the record.
 * The latest note says what is on the record; earlier declared notes are former pots.
 *
 * The repository over a real in-memory database. G, A and P are the real run's public addresses,
 * never a key; every other address is a placeholder and every company an invention.
 */
import { type Address, getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { LegalBodyInputError } from "../../src/persistence/legalBodyInput";
import {
  type PotBirthNote,
  SqliteLegalBodyPotRepository,
} from "../../src/persistence/legalBodyPotRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { CHAIN_ID, FACTORY } from "../helpers/customerCompanyFixtures";
import {
  type LegalBodyStores,
  customerCompany,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";
import { A, G, P, V3_ADDRESS } from "../helpers/potFixtures";

/** A time on the record, in unix seconds. */
const T = 1_795_000_000;
/** Another pot's address: a placeholder. */
const OTHER_POT = getAddress("0x00000000000000000000000000000000000b0771");

const BIRTH: PotBirthNote = { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" };

let s: LegalBodyStores;
let pots: SqliteLegalBodyPotRepository;

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  pots = new SqliteLegalBodyPotRepository(db);
});
afterEach(() => {
  s.db.close();
});

/** A draft legal body of G: the notes' foreign key needs a body, in any state. */
function body(): LegalBodyRecord {
  return s.repo.create({
    tenantId: G,
    companyId: customerCompany(s, G),
    chainId: CHAIN_ID,
    factory: FACTORY,
    amendmentDelay: 172_800,
  });
}

const declared = (legalBodyId: string, address: Address, at: number, birth = BIRTH) =>
  pots.append({
    legalBodyId,
    act: "declared",
    address,
    birth,
    declarationVersion: "pot-declaration-1",
    at,
  });
const removed = (legalBodyId: string, address: Address, at: number) =>
  pots.append({ legalBodyId, act: "removed", address, birth: null, declarationVersion: null, at });

const rows = () => s.db.prepare("SELECT * FROM pot_declarations").all();

describe("append, latest and list", () => {
  test("a declared note is stored with its birth details and the declaration's version, checksummed, declared by the guardian at the time given", () => {
    const b = body();
    const note = pots.append({
      legalBodyId: b.legalBodyId,
      act: "declared",
      address: V3_ADDRESS.toLowerCase() as Address,
      birth: { ...BIRTH, agentWallet: A.toLowerCase() as Address },
      declarationVersion: "pot-declaration-1",
      at: T,
    });
    const expected = {
      legalBodyId: b.legalBodyId,
      act: "declared",
      address: V3_ADDRESS,
      birth: BIRTH,
      declarationVersion: "pot-declaration-1",
      declaredBy: "guardian",
      declaredAt: T,
    };
    expect(note).toEqual(expected);
    expect(pots.latest(b.legalBodyId)).toEqual(expected);
    expect(pots.list(b.legalBodyId)).toEqual([expected]);
    expect(pots.latest(body().legalBodyId)).toBeUndefined();
  });

  test("a removed note holds no birth details and no version", () => {
    const b = body();
    declared(b.legalBodyId, V3_ADDRESS, T);
    const off = removed(b.legalBodyId, V3_ADDRESS, T + 5);
    expect(off).toEqual({
      legalBodyId: b.legalBodyId,
      act: "removed",
      address: V3_ADDRESS,
      birth: null,
      declarationVersion: null,
      declaredBy: "guardian",
      declaredAt: T + 5,
    });
    expect(pots.latest(b.legalBodyId)).toEqual(off);
  });

  test("two notes in one second, or after a clock that went back, are all kept, in the order they were made", () => {
    const b = body();
    const first = declared(b.legalBodyId, V3_ADDRESS, T);
    const second = removed(b.legalBodyId, V3_ADDRESS, T);
    const third = declared(b.legalBodyId, V3_ADDRESS, T - 3_600);
    expect([first.declaredAt, second.declaredAt, third.declaredAt]).toEqual([T, T + 1, T + 2]);
    expect(pots.list(b.legalBodyId).map((n) => [n.act, n.declaredAt])).toEqual([
      ["declared", T],
      ["removed", T + 1],
      ["declared", T + 2],
    ]);
    expect(pots.latest(b.legalBodyId)).toEqual(third);
  });

  test("the notes of one body are not another's", () => {
    const one = body();
    const two = body();
    declared(one.legalBodyId, V3_ADDRESS, T);
    declared(two.legalBodyId, OTHER_POT, T);
    expect(pots.list(one.legalBodyId).map((n) => n.address)).toEqual([V3_ADDRESS]);
    expect(pots.list(two.legalBodyId).map((n) => n.address)).toEqual([OTHER_POT]);
  });

  test("a value no note may hold is refused before anything is written", () => {
    const b = body();
    const id = b.legalBodyId;
    const base = {
      legalBodyId: id,
      act: "declared" as const,
      address: V3_ADDRESS,
      birth: BIRTH,
      declarationVersion: "pot-declaration-1",
      at: T,
    };
    for (const [label, bad] of [
      ["no body id", { legalBodyId: "" }],
      ["another act", { act: "replaced" }],
      ["an address that is not one", { address: "0x1234" }],
      ["the zero address", { address: zeroAddress }],
      ["a declared note without its birth", { birth: null }],
      ["a declared note without its version", { declarationVersion: null }],
      ["a version of 41 characters", { declarationVersion: "v".repeat(41) }],
      ["an empty version", { declarationVersion: "" }],
      ["a salt with a leading zero", { birth: { ...BIRTH, saltNonce: "01" } }],
      ["a salt above 2^256 - 1", { birth: { ...BIRTH, saltNonce: (2n ** 256n).toString() } }],
      ["a salt that is a number", { birth: { ...BIRTH, saltNonce: 1 } }],
      ["a ceiling of 0", { birth: { ...BIRTH, ceilingUnits: "0" } }],
      ["a ceiling with a leading zero", { birth: { ...BIRTH, ceilingUnits: "050000000" } }],
      ["a first key that is the zero address", { birth: { ...BIRTH, agentWallet: zeroAddress } }],
      ["a first key that is not an address", { birth: { ...BIRTH, agentWallet: "0xabc" } }],
      ["a removed note with a birth", { act: "removed" }],
      ["a removed note with a version", { act: "removed", birth: null }],
      ["a time in milliseconds", { at: T * 1000 }],
    ] as const)
      expect(() => pots.append({ ...base, ...bad } as never), label).toThrow(LegalBodyInputError);
    expect(rows()).toEqual([]);
  });
});

describe("the table holds itself", () => {
  test("an UPDATE and a DELETE are refused by the triggers, and so is a row that is not after the body's latest", () => {
    const b = body();
    declared(b.legalBodyId, V3_ADDRESS, T);
    expect(() =>
      s.db.prepare("UPDATE pot_declarations SET birth_ceiling_units = '1'").run(),
    ).toThrow(/append-only/);
    expect(() => s.db.prepare("DELETE FROM pot_declarations").run()).toThrow(/append-only/);
    const insert = (verb: string, at: number) =>
      s.db
        .prepare(
          `${verb} INTO pot_declarations (legal_body_id, act, address, declared_at) VALUES (?, 'removed', ?, ?)`,
        )
        .run(b.legalBodyId, V3_ADDRESS, at);
    for (const verb of ["INSERT", "INSERT OR REPLACE", "REPLACE"])
      for (const at of [T, T - 1])
        expect(() => insert(verb, at), `${verb} at ${at}`).toThrow(/in order|append-only/);
    expect(rows()).toHaveLength(1);
    expect(pots.latest(b.legalBodyId)?.act).toBe("declared");
  });

  test("a declared row without its birth details and a removed row with them are refused by the CHECK, as are the other shapes no note holds", () => {
    const b = body();
    const insert = (cols: Record<string, unknown>) =>
      s.db
        .prepare(
          `INSERT INTO pot_declarations
             (legal_body_id, act, address, salt_nonce, birth_agent_wallet, birth_ceiling_units,
              declaration_version, declared_by, declared_at)
           VALUES (@legal_body_id, @act, @address, @salt_nonce, @birth_agent_wallet,
                   @birth_ceiling_units, @declaration_version, @declared_by, @declared_at)`,
        )
        .run({
          legal_body_id: b.legalBodyId,
          act: "declared",
          address: V3_ADDRESS,
          salt_nonce: "1",
          birth_agent_wallet: A,
          birth_ceiling_units: "50000000",
          declaration_version: "pot-declaration-1",
          declared_by: "guardian",
          declared_at: T,
          ...cols,
        });
    const none = {
      salt_nonce: null,
      birth_agent_wallet: null,
      birth_ceiling_units: null,
      declaration_version: null,
    };
    for (const [label, cols] of [
      ["declared without its salt", { salt_nonce: null }],
      ["declared without its first key", { birth_agent_wallet: null }],
      ["declared without its ceiling", { birth_ceiling_units: null }],
      ["declared without its version", { declaration_version: null }],
      ["declared with none of the four", none],
      ["removed with all four", { act: "removed" }],
      ["removed with its salt", { ...none, act: "removed", salt_nonce: "1" }],
      ["removed with its first key", { ...none, act: "removed", birth_agent_wallet: A }],
      ["removed with its ceiling", { ...none, act: "removed", birth_ceiling_units: "1" }],
      ["removed with a version", { ...none, act: "removed", declaration_version: "v" }],
      ["another act", { act: "replaced" }],
      ["the zero address", { address: zeroAddress }],
      ["an address that is not one", { address: "0x1234" }],
      ["a first key that is the zero address", { birth_agent_wallet: zeroAddress }],
      ["a salt with a leading zero", { salt_nonce: "01" }],
      ["a salt of 79 digits", { salt_nonce: "1".repeat(79) }],
      ["a salt that is a number", { salt_nonce: 1 }],
      ["a ceiling of 0", { birth_ceiling_units: "0" }],
      ["a ceiling with a sign", { birth_ceiling_units: "-5" }],
      ["a version of 41 characters", { declaration_version: "v".repeat(41) }],
      ["an empty version", { declaration_version: "" }],
      ["another declarer", { declared_by: "operator" }],
      ["a time in milliseconds", { declared_at: T * 1000 }],
    ] as const)
      expect(() => insert(cols), label).toThrow(/CHECK constraint failed/);
    expect(() => insert({ legal_body_id: `lb_${"9".repeat(36)}` })).toThrow(/FOREIGN KEY/);
    expect(rows()).toEqual([]);
    insert({});
    insert({ ...none, act: "removed", declared_at: T + 1 });
    expect(rows()).toHaveLength(2);
    expect(s.db.prepare("PRAGMA foreign_key_list(pot_declarations)").all()).toMatchObject([
      { table: "legal_bodies", from: "legal_body_id", to: "legal_body_id" },
    ]);
  });
});

describe("legalBodyIdsByAddress", () => {
  test("finds a body by any declared note of the address, its latest or an older one, in any letter case, distinct, the newest note first", () => {
    const older = body();
    const newer = body();
    // The older body: the address, then another pot on the record in its place.
    declared(older.legalBodyId, V3_ADDRESS, T);
    removed(older.legalBodyId, V3_ADDRESS, T + 10);
    declared(older.legalBodyId, V3_ADDRESS, T + 20);
    declared(older.legalBodyId, OTHER_POT, T + 30);
    // The newer body: the address, declared later than any note of the older one.
    declared(newer.legalBodyId, V3_ADDRESS, T + 100);
    for (const spelling of [
      V3_ADDRESS,
      V3_ADDRESS.toLowerCase(),
      `0x${V3_ADDRESS.slice(2).toUpperCase()}`,
    ])
      expect(pots.legalBodyIdsByAddress(spelling as Address, 10), spelling).toEqual([
        newer.legalBodyId,
        older.legalBodyId,
      ]);
    expect(pots.legalBodyIdsByAddress(V3_ADDRESS, 1)).toEqual([newer.legalBodyId]);
    expect(pots.legalBodyIdsByAddress(OTHER_POT, 10)).toEqual([older.legalBodyId]);
  });

  test("a removed note alone finds nothing, and neither does an address no note holds or a value that is not an address", () => {
    const b = body();
    removed(b.legalBodyId, OTHER_POT, T);
    declared(b.legalBodyId, V3_ADDRESS, T + 1);
    expect(pots.legalBodyIdsByAddress(OTHER_POT, 10)).toEqual([]);
    expect(pots.legalBodyIdsByAddress(P, 10)).toEqual([]);
    expect(pots.legalBodyIdsByAddress("0x1234" as Address, 10)).toEqual([]);
  });

  test("the limit is a whole number from 1 to 100", () => {
    for (const limit of [0, 101, 1.5, Number.NaN])
      expect(() => pots.legalBodyIdsByAddress(V3_ADDRESS, limit), String(limit)).toThrow(
        LegalBodyInputError,
      );
  });
});
