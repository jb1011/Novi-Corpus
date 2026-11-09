/**
 * The two adoption doors on REST: the typed data a guardian signs to adopt the operating agreement
 * frozen for its order, and the signed adoption, stored once. Mounted with the other order doors,
 * under the session protection, each starting with the real-human check.
 *
 * The database is real (in memory); no door here reads the chain. Every name, company and filing
 * number is an invention, and every key is one of anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { ADOPTION_DOMAIN_NAME, ADOPTION_PRIMARY_TYPE } from "../../src/legalBody/adoption";
import { agreementDocNames, buildAgreement, storeAgreement } from "../../src/legalBody/agreement";
import { type LegalBodyOrderDeps, createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "../../src/legalBody/texts/operatingAgreement";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  type Signer,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  DAY_MS,
  JWT_SECRET,
  type Json,
  type LegalBodyStores,
  OTHER_FACTORY,
  REGISTRY,
  answerOf,
  appendCheck,
  call,
  customerCompany,
  legalBodyOrderDeps,
  noChain,
  openLegalBodyStores,
  sessionOf,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. The guardian and a
 *  stranger are verified humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;

const messagePath = (id: string) => `/legal-body-orders/${id}/adoption-message`;
const adoptionPath = (id: string) => `/legal-body-orders/${id}/adoption`;
const orderPath = (id: string) => `/legal-body-orders/${id}`;

/** The server's clock, in milliseconds: each test moves it. It starts at the real time, which is
 *  the one a draft's `createdAt` is stamped with, so a draft is linkable until a test moves it. */
let nowMs: number;
let db: Database.Database;
let s: LegalBodyStores;
let lines: string[];

beforeEach(() => {
  nowMs = Date.now();
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  recordHuman(s.store, guardian.address, "3001", Date.now());
  recordHuman(s.store, stranger.address, "3002", Date.now());
  recordHuman(s.store, waived.address, "3003", Date.now(), "waiver");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors of a sandbox deployment on this test's clock; no door here reads the chain. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: noChain, now: () => nowMs, ...over });
}

function makeApp(legalBodyOrders: LegalBodyOrderDeps = orderDeps()) {
  const requests = new SqliteFormationRepository(db);
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: s.declarations,
      checks: s.checks,
      hasLinkedLegalBody: (companyId) => s.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders,
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof makeApp>;

let filings = 0;
/** A draft of `who` for a checked company of its own, as the order door makes one. */
async function ordered(app: App, who: Signer = guardian): Promise<LegalBodyRecord> {
  const companyId = customerCompany(s, who.address, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const res = await answerOf(
    await call(app, "POST", "/legal-body-orders", await sessionOf(who), { companyId }),
  );
  expect(res.status).toBe(201);
  const row = s.repo.findById(res.body.id);
  if (!row) throw new Error("the order is not stored");
  return row;
}

/** The served adoption message for the order, signed as it arrives by `signer`. */
async function servedAndSigned(
  app: App,
  id: string,
  signer: Signer = guardian,
): Promise<{ issuedAt: string; signature: Hex; typedData: Json }> {
  const served = await answerOf(
    await call(app, "POST", messagePath(id), await sessionOf(guardian), {}),
  );
  expect(served.status).toBe(200);
  return {
    issuedAt: served.body.issuedAt,
    typedData: served.body.typedData,
    signature: (await signer.signTypedData(served.body.typedData)) as Hex,
  };
}

async function adopt(app: App, id: string, body: object, who: Signer = guardian) {
  return answerOf(await call(app, "POST", adoptionPath(id), await sessionOf(who), body));
}

/** Every adoption row and every event, to show that a call wrote nothing. */
function snapshot() {
  return {
    adoptions: db.prepare("SELECT * FROM agreement_adoptions ORDER BY legal_body_id").all(),
    events: db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
  };
}

function adoptionEvents(id: string) {
  return s.repo.listEvents(id).filter((e) => e.kind === "agreement_adopted");
}

const expectRefusal = (res: { status: number; body: Json }, code: string, status: number) => {
  expect(res.status, code).toBe(status);
  expect(res.body).toEqual({ error: { code, message: LEGAL_BODY_SENTENCES[code] } });
};

describe("POST /legal-body-orders/:id/adoption-message", () => {
  test("serves the OperatingAgreementAdoption typed data of the order's frozen agreement, issued on the server's clock, and writes nothing", async () => {
    const app = makeApp();
    const row = await ordered(app);
    const agreement = await answerOf(
      await call(app, "GET", `${orderPath(row.legalBodyId)}/agreement`, await sessionOf(guardian)),
    );
    const before = snapshot();

    const res = await answerOf(
      await call(app, "POST", messagePath(row.legalBodyId), await sessionOf(guardian), {}),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["issuedAt", "typedData"]);
    const issuedAt = String(Math.floor(nowMs / 1000));
    expect(res.body.issuedAt).toBe(issuedAt);
    expect(res.body.typedData).toMatchObject({
      domain: {
        name: ADOPTION_DOMAIN_NAME,
        version: "1",
        chainId: CHAIN_ID,
        verifyingContract: FACTORY,
      },
      primaryType: ADOPTION_PRIMARY_TYPE,
      message: {
        orderId: row.legalBodyId,
        manifestHash: row.oaManifestHash,
        textId: agreement.body.textId,
        textVersion: agreement.body.textVersion,
        guardian: getAddress(guardian.address),
        issuedAt,
      },
    });
    expect(Object.keys(res.body.typedData.types).sort()).toEqual([
      "EIP712Domain",
      "OperatingAgreementAdoption",
    ]);
    expect(snapshot()).toEqual(before);
  });
});

describe("POST /legal-body-orders/:id/adoption", () => {
  test("stores the guardian's signed adoption once, with its event, and answers its time", async () => {
    const app = makeApp();
    const row = await ordered(app);
    const id = row.legalBodyId;
    const { issuedAt, signature } = await servedAndSigned(app, id);
    nowMs += 30_000;

    const res = await adopt(app, id, { issuedAt, signature });
    expect(res.status).toBe(200);
    const adoptedAt = Math.floor(nowMs / 1000);
    expect(res.body).toEqual({ adoptedAt });

    const stored = s.adoptions.find(id);
    expect(stored).toMatchObject({
      legalBodyId: id,
      manifestHash: row.oaManifestHash,
      guardian: getAddress(guardian.address),
      issuedAt: Number(issuedAt),
      signature: signature.toLowerCase(),
      adoptedAt,
    });
    const events = adoptionEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "agreement_adopted",
      actor: "tenant",
      txHash: null,
      detail: { digest: stored?.digest },
    });
    // The event says which signature adopted the agreement, and nothing about who signed it.
    expect(Object.keys((events[0]?.detail ?? {}) as object)).toEqual(["digest"]);
  });

  test("a second adoption of the same order answers the stored time, 200, and writes nothing", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const first = await adopt(app, id, await servedAndSigned(app, id));
    expect(first.status).toBe(200);
    const before = snapshot();

    nowMs += 120_000;
    const second = await adopt(app, id, await servedAndSigned(app, id));
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(snapshot()).toEqual(before);
    expect(adoptionEvents(id)).toHaveLength(1);
  });

  test("the order's view carries adoptedAt: null until the adoption, then its time, in the read and the list", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const token = await sessionOf(guardian);
    const read = async () => (await answerOf(await call(app, "GET", orderPath(id), token))).body;
    const list = async () =>
      (await answerOf(await call(app, "GET", "/legal-body-orders", token))).body.orders[0];
    expect((await read()).adoptedAt).toBeNull();
    expect((await list()).adoptedAt).toBeNull();

    const adopted = await adopt(app, id, await servedAndSigned(app, id));
    expect((await read()).adoptedAt).toBe(adopted.body.adoptedAt);
    expect((await list()).adoptedAt).toBe(adopted.body.adoptedAt);
  });

  test("an issuedAt older than the deployment's window, or ahead of the clock, is a 400 adoption_stale, and nothing is stored", async () => {
    const app = makeApp(orderDeps({ adoptionMaxAgeSeconds: 300 }));
    const id = (await ordered(app)).legalBodyId;
    const signedNow = await servedAndSigned(app, id);
    const before = snapshot();

    nowMs += 301_000;
    expectRefusal(await adopt(app, id, signedNow), "adoption_stale", 400);
    nowMs -= 301_000 + 61_000;
    expectRefusal(await adopt(app, id, signedNow), "adoption_stale", 400);
    expect(snapshot()).toEqual(before);
  });

  test("another wallet's signature, a tampered issuedAt or a malformed body is a 400 adoption_not_valid, and nothing is stored", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const byStranger = await servedAndSigned(app, id, stranger);
    const own = await servedAndSigned(app, id);
    const before = snapshot();

    expectRefusal(await adopt(app, id, byStranger), "adoption_not_valid", 400);
    expectRefusal(
      await adopt(app, id, {
        issuedAt: String(Number(own.issuedAt) - 1),
        signature: own.signature,
      }),
      "adoption_not_valid",
      400,
    );
    for (const body of [
      {},
      { issuedAt: own.issuedAt },
      { signature: own.signature },
      { issuedAt: Number(own.issuedAt), signature: own.signature },
      { issuedAt: own.issuedAt, signature: "0x01" },
    ])
      expectRefusal(await adopt(app, id, body), "adoption_not_valid", 400);
    expect(snapshot()).toEqual(before);
  });
});

describe("the throttle", () => {
  test("the adoption takes a token from the tenant's bucket and the doors' budget, as the link doors do: either empty is a 429 rate_limited, and nothing is stored", async () => {
    const empty = { take: () => false };
    for (const over of [{ tenantBucket: () => empty }, { doorBudget: empty }]) {
      const app = makeApp(orderDeps(over));
      const id = (await ordered(app)).legalBodyId;
      // The message writes nothing, and is free, as the agreement's read is.
      const signedNow = await servedAndSigned(app, id);
      const before = snapshot();
      expectRefusal(await adopt(app, id, signedNow), "rate_limited", 429);
      expect(snapshot()).toEqual(before);
      expect(s.adoptions.find(id)).toBeUndefined();
    }
  });

  test("the bucket is asked only once the tenant is a real human", async () => {
    let asked = 0;
    const app = makeApp(
      orderDeps({
        tenantBucket: () => ({
          take: () => {
            asked += 1;
            return true;
          },
        }),
      }),
    );
    const id = (await ordered(app)).legalBodyId;
    const waiver = await adopt(app, id, {}, waived);
    expect(waiver.status).toBe(403);
    expect(asked).toBe(0);
    await adopt(app, id, await servedAndSigned(app, id));
    expect(asked).toBe(1);
  });
});

describe("the preconditions both doors share", () => {
  test("an order that is not the tenant's is the uniform 404 on both doors", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const token = await sessionOf(stranger);
    for (const path of [messagePath(id), adoptionPath(id), messagePath("lb_missing")])
      expectRefusal(await answerOf(await call(app, "POST", path, token, {})), "not_found", 404);
  });

  test("an order that is no longer a draft is a 409 order_closed on both doors", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const own = await servedAndSigned(app, id);
    const token = await sessionOf(guardian);
    expect((await call(app, "POST", `${orderPath(id)}/abandon`, token)).status).toBe(200);
    const before = snapshot();
    expectRefusal(
      await answerOf(await call(app, "POST", messagePath(id), token, {})),
      "order_closed",
      409,
    );
    expectRefusal(await adopt(app, id, own), "order_closed", 409);
    expect(snapshot()).toEqual(before);
  });

  test("a stored agreement that no longer reads back is a 500 agreement_unreadable on both doors", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const own = await servedAndSigned(app, id);
    const names = agreementDocNames(id);
    const bytes = Buffer.from(s.docStore.getBytes(names.manifest));
    bytes.writeUInt8(bytes.readUInt8(10) ^ 0x01, 10);
    s.docStore.putBytes(names.manifest, bytes);
    const token = await sessionOf(guardian);
    expectRefusal(
      await answerOf(await call(app, "POST", messagePath(id), token, {})),
      "agreement_unreadable",
      500,
    );
    expectRefusal(await adopt(app, id, own), "agreement_unreadable", 500);
    expect(s.adoptions.find(id)).toBeUndefined();
  });

  test("a tenant with a waiver, or with no session, is refused before anything is read", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    for (const path of [messagePath(id), adoptionPath(id)]) {
      const waiver = await answerOf(await call(app, "POST", path, await sessionOf(waived), {}));
      expect(waiver.status).toBe(403);
      expect(waiver.body.error.code).toBe("waiver_not_accepted");
      expect((await call(app, "POST", path, undefined, {})).status).toBe(401);
    }
  });

  test("no line the doors write names the company, the guardian or the signature", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    const own = await servedAndSigned(app, id);
    await adopt(app, id, own);
    await adopt(app, id, await servedAndSigned(app, id, stranger));
    const written = lines.join("\n");
    expect(written).not.toContain("Example Holdings");
    expect(written.toLowerCase()).not.toContain(guardian.address.toLowerCase());
    expect(written).not.toContain(own.signature.slice(2, 40));
  });
});

describe("the adoption doors accept no draft the link would refuse", () => {
  /** Both doors on the order, with a body of the right shape: each refusal comes before the
   *  signature is read. */
  async function bothDoors(app: App, id: string) {
    const token = await sessionOf(guardian);
    const body = { issuedAt: String(Math.floor(nowMs / 1000)), signature: `0x${"11".repeat(65)}` };
    return [
      await answerOf(await call(app, "POST", messagePath(id), token, {})),
      await answerOf(await call(app, "POST", adoptionPath(id), token, body)),
    ];
  }

  async function refusedOnBoth(app: App, id: string, code: string, status: number) {
    const before = snapshot();
    for (const res of await bothDoors(app, id)) expectRefusal(res, code, status);
    expect(snapshot()).toEqual(before);
    expect(s.adoptions.find(id)).toBeUndefined();
  }

  test("an order frozen on an older version of the wording is a 409 agreement_outdated on both doors, and no row is written", async () => {
    const app = makeApp();
    const companyId = customerCompany(s, guardian.address, { filingNumber: "TEST-0800" });
    const created = s.repo.create({
      tenantId: guardian.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const built = buildAgreement(
      {
        companyName: "Example Holdings LLC",
        filingNumber: "TEST-0800",
        jurisdiction: "WY",
        guardian: guardian.address,
        amendmentDelaySeconds: 172_800,
        chainId: CHAIN_ID,
        factory: FACTORY,
        identityRegistry: REGISTRY,
      },
      { ...LEGAL_BODY_OPERATING_AGREEMENT, version: "2026-09-draft-0" },
      { source: "customer" },
    );
    storeAgreement(s.docStore, created.legalBodyId, built);
    expect(
      s.repo.freezeAgreement(created.legalBodyId, { hash: built.manifestHash, version: 1 }),
    ).toBe(true);
    await refusedOnBoth(app, created.legalBodyId, "agreement_outdated", 409);
  });

  test("a production deployment, which does not serve the draft wording, answers agreement_outdated on both doors", async () => {
    const id = (await ordered(makeApp())).legalBodyId;
    await refusedOnBoth(
      makeApp(orderDeps({ environment: "production" })),
      id,
      "agreement_outdated",
      409,
    );
  });

  test("a draft placed more than 24 hours ago is a 409 order_expired on both doors", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    // A day and a second after the draft was placed, read from the real clock AFTER placing it:
    // its createdAt is stamped by the real clock at the insert, so a clock read in beforeEach can
    // trail it by the setup's time, which under load passes a second.
    nowMs = Date.now() + DAY_MS + 1_000;
    await refusedOnBoth(app, id, "order_expired", 409);
  });

  test("a draft the operator revoked is a 409 order_revoked on both doors", async () => {
    const app = makeApp();
    const id = (await ordered(app)).legalBodyId;
    s.repo.recordEvent(id, "revoked", "operator:ops.example", null, {
      reason: "Recorded for a test.",
    });
    await refusedOnBoth(app, id, "order_revoked", 409);
  });

  test("a draft whose company is no longer eligible is a 409 company_not_eligible on both doors", async () => {
    const app = makeApp();
    const row = await ordered(app);
    appendCheck(s.checks, row.companyId, "revoked");
    await refusedOnBoth(app, row.legalBodyId, "company_not_eligible", 409);
  });

  test("an order made under another factory or chain is a 409 other_deployment on both doors", async () => {
    const companyId = customerCompany(s, guardian.address, { filingNumber: "TEST-0700" });
    for (const deployment of [
      { chainId: CHAIN_ID, factory: OTHER_FACTORY },
      { chainId: CHAIN_ID + 1, factory: FACTORY },
    ]) {
      const elsewhere = createOrder(orderDeps({ deployment }), guardian.address, { companyId });
      await refusedOnBoth(makeApp(), elsewhere.id, "other_deployment", 409);
    }
  });
});
