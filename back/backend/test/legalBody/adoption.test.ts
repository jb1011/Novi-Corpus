/**
 * The operating agreement adoption as EIP-712 typed data: what a guardian signs to adopt the
 * agreement frozen for its order, and how that signature is checked. The message is built by the
 * server from the order and the agreement it was frozen with, never taken from the client, and the
 * signature is checked by local ECDSA recovery against the signed-in wallet.
 *
 * The database is real (in memory). Every name, company and filing number is an invention, and
 * every key is one of anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { type Address, type Hex, getAddress, hashTypedData } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiError } from "../../src/errors";
import {
  ADOPTION_DOMAIN_NAME,
  ADOPTION_DOMAIN_VERSION,
  ADOPTION_FIELDS,
  ADOPTION_PRIMARY_TYPE,
  type AdoptionMessage,
  adoptAgreement,
  adoptionDigest,
  adoptionDomain,
  adoptionMessage,
  adoptionTypedDataWire,
  buildAdoptionMessage,
  verifyAdoption,
} from "../../src/legalBody/adoption";
import { readVerifiedAgreement } from "../../src/legalBody/agreement";
import { createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { STATEMENT_DOMAIN_NAME } from "../../src/legalBody/statement";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "../../src/legalBody/texts/operatingAgreement";
import { migrate, openDatabase } from "../../src/persistence/db";
import { LegalBodyInputError } from "../../src/persistence/legalBodyInput";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  CHAIN_ID,
  FACTORY,
  type Signer,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  H,
  type LegalBodyStores,
  OTHER_FACTORY,
  PLACEHOLDER_ADOPTION_SIGNATURE,
  adoptFor,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** The guardian, and a second verified human who is not its signer. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
/** The server's clock in these tests, in unix seconds, and the adoption's greatest age. */
const NOW = 1_800_000_000;
const MAX_AGE = 600;

let db: Database.Database;
let s: LegalBodyStores;
let filings = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, guardian.address, "3001", Date.now());
  recordHuman(s.store, stranger.address, "3002", Date.now());
});
afterEach(() => db.close());

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of the guardian, placed through the order door for a checked company of its own. */
function draft(): LegalBodyRecord {
  const companyId = customerCompany(s, guardian.address, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  return rowOf(createOrder(legalBodyOrderDeps(s), guardian.address, { companyId }).id);
}

/** The text id and version the order's stored agreement was frozen with. */
function frozenOf(row: LegalBodyRecord): { textId: string; textVersion: string } {
  if (row.oaManifestHash === null) throw new Error("no agreement");
  const verified = readVerifiedAgreement(s.docStore, row.legalBodyId, row.oaManifestHash);
  if (verified === undefined) throw new Error("unreadable agreement");
  return verified.terms;
}

/** The wire form as a wallet receives it: JSON, signed as it arrives. */
const asReceived = (wire: object) => JSON.parse(JSON.stringify(wire));

/** The adoption of `row` at `issuedAt`, as a wallet signs the served typed data. */
async function signed(
  row: LegalBodyRecord,
  issuedAt: bigint,
  signer: Signer = guardian,
  domain: { chainId: number; factory: Address } = { chainId: CHAIN_ID, factory: FACTORY },
): Promise<{ message: AdoptionMessage; signature: Hex }> {
  const message = buildAdoptionMessage(row, frozenOf(row), issuedAt);
  const wire = adoptionTypedDataWire(domain.chainId, domain.factory, message);
  return { message, signature: (await signer.signTypedData(asReceived(wire))) as Hex };
}

/** `verifyAdoption` of `row` on this test's deployment and clock, with the given parts. */
function verify(
  row: LegalBodyRecord,
  issuedAt: string,
  signature: Hex,
  over: Partial<Parameters<typeof verifyAdoption>[0]> = {},
) {
  return verifyAdoption({
    chainId: CHAIN_ID,
    factory: FACTORY,
    tenantId: guardian.address,
    order: row,
    terms: row.oaManifestHash === null ? { textId: "", textVersion: "" } : frozenOf(row),
    issuedAt,
    signature,
    nowSec: NOW,
    maxAgeSec: MAX_AGE,
    ...over,
  });
}

async function refused(run: () => Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected the refusal ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect(err.code).toBe(code);
  expect(err.status).toBe(400);
  expect(err.message).toBe(LEGAL_BODY_SENTENCES[code]);
}

describe("the typed data", () => {
  test("the domain, the primary type and the fields are the adoption's own", () => {
    expect(ADOPTION_DOMAIN_NAME).toBe("Novi Corpus Operating Agreement Adoption");
    expect(ADOPTION_DOMAIN_NAME).not.toBe(STATEMENT_DOMAIN_NAME);
    expect(ADOPTION_DOMAIN_VERSION).toBe("1");
    expect(ADOPTION_PRIMARY_TYPE).toBe("OperatingAgreementAdoption");
    // The order is the type string's: a field moved changes the digest a wallet signs.
    expect(ADOPTION_FIELDS).toEqual([
      { name: "orderId", type: "string" },
      { name: "manifestHash", type: "bytes32" },
      { name: "textId", type: "string" },
      { name: "textVersion", type: "string" },
      { name: "guardian", type: "address" },
      { name: "issuedAt", type: "uint256" },
    ]);
    expect(adoptionDomain(CHAIN_ID, FACTORY)).toEqual({
      name: ADOPTION_DOMAIN_NAME,
      version: ADOPTION_DOMAIN_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: FACTORY,
    });
  });

  test("the message is the order's: its id, its frozen manifest hash, its agreement's text id and version, its guardian", () => {
    const row = draft();
    const m = buildAdoptionMessage(row, frozenOf(row), BigInt(NOW));
    expect(m).toEqual({
      orderId: row.legalBodyId,
      manifestHash: row.oaManifestHash,
      textId: LEGAL_BODY_OPERATING_AGREEMENT.id,
      textVersion: LEGAL_BODY_OPERATING_AGREEMENT.version,
      guardian: getAddress(guardian.address),
      issuedAt: BigInt(NOW),
    });
  });

  test("the wire form is JSON-safe, declares EIP712Domain, and a wallet signing it as it arrives signs adoptionDigest", () => {
    const row = draft();
    const m = buildAdoptionMessage(row, frozenOf(row), BigInt(NOW));
    const wire = adoptionTypedDataWire(CHAIN_ID, FACTORY, m);
    expect(wire.primaryType).toBe(ADOPTION_PRIMARY_TYPE);
    expect(wire.types.OperatingAgreementAdoption).toEqual(ADOPTION_FIELDS);
    expect(wire.types.EIP712Domain.map((f) => f.name)).toEqual([
      "name",
      "version",
      "chainId",
      "verifyingContract",
    ]);
    expect(wire.message.issuedAt).toBe(String(NOW));
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(hashTypedData(asReceived(wire))).toBe(adoptionDigest(CHAIN_ID, FACTORY, m));
  });
});

describe("verifyAdoption", () => {
  test("a round trip: the guardian signs the typed data with its wallet, and the check answers the digest", async () => {
    const row = draft();
    const { message, signature } = await signed(row, BigInt(NOW));
    expect(await verify(row, String(NOW), signature)).toEqual({
      digest: adoptionDigest(CHAIN_ID, FACTORY, message),
    });
  });

  test("issuedAt is accepted from maxAge seconds before the server's clock to 60 seconds after it, and is stale outside", async () => {
    const row = draft();
    for (const at of [NOW - MAX_AGE, NOW, NOW + 60]) {
      const { signature } = await signed(row, BigInt(at));
      await expect(verify(row, String(at), signature)).resolves.toHaveProperty("digest");
    }
    for (const at of [NOW - MAX_AGE - 1, NOW + 61, 1]) {
      const { signature } = await signed(row, BigInt(at));
      await refused(() => verify(row, String(at), signature), "adoption_stale");
    }
    // The age is the deployment's setting.
    const { signature } = await signed(row, BigInt(NOW - 700));
    await refused(() => verify(row, String(NOW - 700), signature), "adoption_stale");
    await expect(
      verify(row, String(NOW - 700), signature, { maxAgeSec: 700 }),
    ).resolves.toHaveProperty("digest");
  });

  test("another signer's signature of the same message is not valid", async () => {
    const row = draft();
    const { signature } = await signed(row, BigInt(NOW), stranger);
    await refused(() => verify(row, String(NOW), signature), "adoption_not_valid");
    // Nor is the guardian's own signature checked for another tenant.
    const own = await signed(row, BigInt(NOW));
    await refused(
      () => verify(row, String(NOW), own.signature, { tenantId: stranger.address }),
      "adoption_not_valid",
    );
  });

  test("a signature over another order, chain or factory is not valid", async () => {
    const row = draft();
    const other = draft();
    const forOther = await signed(other, BigInt(NOW));
    await refused(() => verify(row, String(NOW), forOther.signature), "adoption_not_valid");
    const otherChain = await signed(row, BigInt(NOW), guardian, {
      chainId: CHAIN_ID + 1,
      factory: FACTORY,
    });
    await refused(() => verify(row, String(NOW), otherChain.signature), "adoption_not_valid");
    const otherFactory = await signed(row, BigInt(NOW), guardian, {
      chainId: CHAIN_ID,
      factory: OTHER_FACTORY,
    });
    await refused(() => verify(row, String(NOW), otherFactory.signature), "adoption_not_valid");
  });

  test("a signature over another text version than the one the order was frozen with is not valid", async () => {
    const row = draft();
    const message = { ...buildAdoptionMessage(row, frozenOf(row), BigInt(NOW)), textVersion: "x" };
    const signature = (await guardian.signTypedData(
      asReceived(adoptionTypedDataWire(CHAIN_ID, FACTORY, message)),
    )) as Hex;
    await refused(() => verify(row, String(NOW), signature), "adoption_not_valid");
  });

  test("a signature that is not 65 bytes of hex is not valid", async () => {
    const row = draft();
    const { signature } = await signed(row, BigInt(NOW));
    for (const bad of [
      "0x",
      signature.slice(0, -2),
      `${signature}00`,
      `0x${"zz".repeat(65)}`,
      signature.slice(2),
      // r and s out of range: 65 bytes that recover nothing.
      `0x${"ff".repeat(64)}1b`,
    ])
      await refused(() => verify(row, String(NOW), bad as Hex), "adoption_not_valid");
    await refused(() => verify(row, String(NOW), 42 as unknown as Hex), "adoption_not_valid");
  });

  test("an issuedAt that is not a whole number of seconds in canonical decimal is not valid", async () => {
    const row = draft();
    const { signature } = await signed(row, BigInt(NOW));
    for (const bad of ["", "0x6b49d200", `0${NOW}`, `${NOW}.0`, `-${NOW}`, ` ${NOW}`, "1e9"])
      await refused(() => verify(row, bad, signature), "adoption_not_valid");
    await refused(() => verify(row, NOW as unknown as string, signature), "adoption_not_valid");
  });

  test("an order with no frozen agreement has nothing to adopt", async () => {
    const companyId = customerCompany(s, guardian.address, { filingNumber: "TEST-0900" });
    const unfrozen = s.repo.create({
      tenantId: guardian.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    await refused(
      () => verify(unfrozen, String(NOW), `0x${"11".repeat(65)}`),
      "adoption_not_valid",
    );
  });
});

describe("the adoption door's write", () => {
  test("a draft abandoned between the check of the signature and the write is refused order_closed by the read under the lock, and no row is written", async () => {
    const row = draft();
    const served = adoptionMessage(legalBodyOrderDeps(s), guardian.address, row.legalBodyId);
    const signature = (await guardian.signTypedData(asReceived(served.typedData))) as Hex;
    // The adoption's one transaction is its write: the draft is abandoned just before it opens,
    // after the signature was checked against the draft as it stood.
    let abandoned = false;
    const deps = legalBodyOrderDeps(s, {
      transaction: (fn) => {
        if (!abandoned) {
          abandoned = true;
          expect(s.repo.abandon(row.legalBodyId, "tenant_request", "tenant")).toBe(true);
        }
        return s.repo.transaction(fn);
      },
    });

    let caught: unknown;
    try {
      await adoptAgreement(deps, guardian.address, row.legalBodyId, {
        issuedAt: served.issuedAt,
        signature,
      });
    } catch (err) {
      caught = err;
    }
    expect(abandoned).toBe(true);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe("order_closed");
    expect((caught as ApiError).status).toBe(409);
    expect(s.adoptions.find(row.legalBodyId)).toBeUndefined();
    expect(
      s.repo.listEvents(row.legalBodyId).filter((e) => e.kind === "agreement_adopted"),
    ).toEqual([]);
  });

  test("the same adoption, with nothing in between, is stored", async () => {
    const row = draft();
    const served = adoptionMessage(legalBodyOrderDeps(s), guardian.address, row.legalBodyId);
    const signature = (await guardian.signTypedData(asReceived(served.typedData))) as Hex;
    const { adoptedAt } = await adoptAgreement(
      legalBodyOrderDeps(s),
      guardian.address,
      row.legalBodyId,
      { issuedAt: served.issuedAt, signature },
    );
    expect(s.adoptions.find(row.legalBodyId)?.adoptedAt).toBe(adoptedAt);
  });
});

describe("the stored adoption is written once", () => {
  test("one row per order: a second insert, an update, a delete and a replace are all refused, and the event is written once", () => {
    const row = draft();
    const adoptedAt = adoptFor(s, row);
    const stored = s.adoptions.find(row.legalBodyId);
    expect(stored).toMatchObject({ legalBodyId: row.legalBodyId, adoptedAt });
    // Written through the adoption's own path a second time, the first one stays.
    expect(adoptFor(s, row, (adoptedAt + 100) * 1000)).toBe(adoptedAt);
    expect(
      s.repo.listEvents(row.legalBodyId).filter((e) => e.kind === "agreement_adopted"),
    ).toHaveLength(1);

    if (stored === undefined) throw new Error("no adoption");
    const { createdAt: _, ...fresh } = stored;
    expect(() => s.adoptions.insert(fresh)).toThrow();
    expect(() =>
      db.prepare("UPDATE agreement_adoptions SET adopted_at = adopted_at + 1").run(),
    ).toThrow(/written once/);
    expect(() => db.prepare("DELETE FROM agreement_adoptions").run()).toThrow(/written once/);
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO agreement_adoptions
             (legal_body_id, manifest_hash, text_id, text_version, guardian, issued_at, signature,
              digest, adopted_at)
           SELECT legal_body_id, manifest_hash, text_id, text_version, guardian, issued_at,
                  signature, digest, adopted_at + 1
             FROM agreement_adoptions`,
        )
        .run(),
    ).toThrow(/written once/);
    expect(s.adoptions.find(row.legalBodyId)).toEqual(stored);
  });

  test("a value no row may hold is refused before anything is written, and the database holds the shapes too", () => {
    const row = draft();
    const valid = {
      legalBodyId: row.legalBodyId,
      manifestHash: row.oaManifestHash as Hex,
      textId: LEGAL_BODY_OPERATING_AGREEMENT.id,
      textVersion: LEGAL_BODY_OPERATING_AGREEMENT.version,
      guardian: guardian.address,
      issuedAt: NOW,
      signature: PLACEHOLDER_ADOPTION_SIGNATURE,
      digest: `0x${"d".repeat(64)}` as Hex,
      adoptedAt: NOW,
    };
    for (const bad of [
      { signature: "0x01" as Hex },
      { manifestHash: "0x01" as Hex },
      { digest: "0x01" as Hex },
      { guardian: "0x01" as Address },
      { issuedAt: NOW * 1000 * 1000 },
      { adoptedAt: 0 },
      { textId: "" },
    ])
      expect(() => s.adoptions.insert({ ...valid, ...bad }), JSON.stringify(bad)).toThrow(
        LegalBodyInputError,
      );
    // An order that does not exist holds no adoption.
    expect(() => s.adoptions.insert({ ...valid, legalBodyId: "lb_missing" })).toThrow();
    // A signature in upper case is stored in the one spelling.
    s.adoptions.insert({
      ...valid,
      signature: valid.signature.toUpperCase().replace("0X", "0x") as Hex,
    });
    expect(s.adoptions.find(row.legalBodyId)?.signature).toBe(PLACEHOLDER_ADOPTION_SIGNATURE);
    expect(() =>
      db
        .prepare("INSERT INTO agreement_adoptions VALUES (?, ?, 't', 'v', ?, 1, '0x01', ?, 1, 'x')")
        .run(draft().legalBodyId, H("a"), guardian.address, H("b")),
    ).toThrow(/CHECK/);
  });
});
