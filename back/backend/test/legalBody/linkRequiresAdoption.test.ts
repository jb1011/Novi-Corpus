/**
 * The link requires the adoption: until the guardian has signed the adoption of the operating
 * agreement frozen for its order, both link functions refuse 409 `agreement_not_adopted`, on a
 * sandbox and on a production deployment, through the REST doors and through the agent's tools,
 * and change nothing. Once the adoption is recorded, the link goes on as before. The refusal comes
 * after every other check of rule 1, `agreement_outdated` included.
 *
 * The agreement's wording is held approved in this file, so that a production deployment serves
 * it and its link door reaches the adoption check; the wording's status is the only change.
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers. Every
 * name, company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import type Database from "better-sqlite3";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { bucketsByKey } from "../../src/api/routes/legalBodyOrders";
import { ApiError } from "../../src/errors";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { agreementDocNames, buildAgreement, storeAgreement } from "../../src/legalBody/agreement";
import { type AfterReserve, linkMessage, submitLink } from "../../src/legalBody/linkDoor";
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
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  type FakeLinkChainMembers,
  H,
  JWT_SECRET,
  type Json,
  type LegalBodyStores,
  PLACEHOLDER_ADOPTION_SIGNATURE,
  REGISTRY,
  adoptFor,
  answerOf,
  asChainPort,
  call,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  sessionOf,
  signedLink,
} from "../helpers/legalBodyFixtures";
import { startMcpTestClient } from "../mcp/helpers";

vi.mock("../../src/legalBody/texts/operatingAgreement", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/legalBody/texts/operatingAgreement")>();
  return {
    ...actual,
    LEGAL_BODY_OPERATING_AGREEMENT: {
      ...actual.LEGAL_BODY_OPERATING_AGREEMENT,
      status: "approved",
    },
  };
});

/** anvil's published account #2: a test key, never a real wallet. A verified human. */
const guardian = ANVIL_ACCOUNT_2;
const tenant: Address = guardian.address;
const CODE = "agreement_not_adopted";

let db: Database.Database;
let s: LegalBodyStores;
let chain: FakeLinkChainMembers;
let filings = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  chain = fakeLinkChainMembers();
  recordHuman(s.store, tenant, "3001", Date.now());
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function deps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, { chain: asChainPort(chain), ...over });
}

function rowOf(id: string): LegalBodyRecord {
  const row = s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

/** A draft of the guardian, placed through the order door; not adopted. */
function draft(): LegalBodyRecord {
  const companyId = customerCompany(s, tenant, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  return rowOf(createOrder(deps(), tenant, { companyId }).id);
}

/** A create that is never reached: a test that gets past the reserve fails loudly. */
const neverCreate: AfterReserve = {
  create: async () => {
    throw new Error("the create was reached");
  },
};

/** The reserve's hand-on, answered with the reserved row as it is. */
const reservedAnswer: AfterReserve = {
  create: async (row) => ({
    status: "reserved",
    order: { id: row.legalBodyId, state: row.bindingState } as never,
  }),
};

/** Both functions on one order, each with a well-formed request. */
function bothFunctions(d: LegalBodyOrderDeps, row: LegalBodyRecord, after = neverCreate) {
  return [
    { name: "linkMessage", run: () => linkMessage(d, tenant, row.legalBodyId, { agentId: "42" }) },
    {
      name: "submitLink",
      run: async () =>
        submitLink(d, tenant, row.legalBodyId, await signedLink(linkFor(row)), after),
    },
  ];
}

async function refusedWith(
  run: () => Promise<unknown>,
  code: string,
  status: number,
  name: string,
) {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `${name}: expected the refusal ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect(err.code, name).toBe(code);
  expect(err.status, name).toBe(status);
  expect(err.message, name).toBe(LEGAL_BODY_SENTENCES[code]);
}

/** Every row, event and adoption, to show that a call wrote nothing. */
function snapshot() {
  return {
    rows: db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all(),
    events: db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
    adoptions: db.prepare("SELECT * FROM agreement_adoptions ORDER BY legal_body_id").all(),
  };
}

/** How many times the fake chain was read. */
function chainReads(): number {
  let reads = 0;
  for (const member of Object.values(chain))
    if (vi.isMockFunction(member)) reads += member.mock.calls.length;
  return reads;
}

describe("the link functions refuse an order whose agreement was not adopted", () => {
  test.each(["sandbox", "production"] as const)(
    "on a %s deployment, linkMessage and submitLink answer 409 agreement_not_adopted, read no chain and change nothing",
    async (environment) => {
      const row = draft();
      const before = snapshot();
      for (const fn of bothFunctions(deps({ environment }), row))
        await refusedWith(fn.run, CODE, 409, fn.name);
      expect(snapshot()).toEqual(before);
      expect(chainReads()).toBe(0);
      expect(rowOf(row.legalBodyId).bindingState).toBe("draft");
    },
  );

  test.each(["sandbox", "production"] as const)(
    "on a %s deployment, once the adoption is recorded, linkMessage serves the link and submitLink reserves the identity, as before",
    async (environment) => {
      const row = draft();
      adoptFor(s, row);
      const d = deps({ environment });
      const served = await linkMessage(d, tenant, row.legalBodyId, { agentId: "42" });
      expect(served.typedData.message.operatingAgreementHash).toBe(row.oaManifestHash);
      const submitted = await submitLink(
        d,
        tenant,
        row.legalBodyId,
        await signedLink(linkFor(row)),
        reservedAnswer,
      );
      expect(submitted.status).toBe("reserved");
      expect(rowOf(row.legalBodyId).bindingState).toBe("reserved");
    },
  );

  test("the sentence tells an agent the guardian adopts the agreement in the web app first", () => {
    expect(LEGAL_BODY_SENTENCES[CODE]).toBe(
      "The operating agreement has not been adopted yet: the guardian reads it and signs the adoption in the web app first.",
    );
  });
});

describe("the adoption must name the order's own agreement", () => {
  test("an adoption row whose manifest hash is not the order's opens nothing: both functions answer 409 agreement_not_adopted, on both deployments", async () => {
    const row = draft();
    // Written by hand, as no door would: the right order, another agreement.
    s.adoptions.insert({
      legalBodyId: row.legalBodyId,
      manifestHash: H("e"),
      textId: LEGAL_BODY_OPERATING_AGREEMENT.id,
      textVersion: LEGAL_BODY_OPERATING_AGREEMENT.version,
      guardian: tenant,
      issuedAt: Math.floor(Date.now() / 1000),
      signature: PLACEHOLDER_ADOPTION_SIGNATURE,
      digest: H("d"),
      adoptedAt: Math.floor(Date.now() / 1000),
    });
    expect(H("e")).not.toBe(row.oaManifestHash);
    const before = snapshot();
    for (const environment of ["sandbox", "production"] as const)
      for (const fn of bothFunctions(deps({ environment }), row))
        await refusedWith(fn.run, CODE, 409, fn.name);
    expect(snapshot()).toEqual(before);
    expect(chainReads()).toBe(0);
  });
});

describe("agreement_not_adopted comes after every other check of rule 1", () => {
  test("an unadopted order on a superseded text answers agreement_outdated", async () => {
    const companyId = customerCompany(s, tenant, { filingNumber: "TEST-0900" });
    const created = s.repo.create({
      tenantId: tenant,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const built = buildAgreement(
      {
        companyName: "Example Holdings LLC",
        filingNumber: "TEST-0900",
        jurisdiction: "WY",
        guardian: tenant,
        amendmentDelaySeconds: 172_800,
        chainId: CHAIN_ID,
        factory: FACTORY,
        identityRegistry: REGISTRY,
      },
      { ...LEGAL_BODY_OPERATING_AGREEMENT, version: "2026-09-draft-0" },
      { source: "customer" },
    );
    storeAgreement(s.docStore, created.legalBodyId, built);
    s.repo.freezeAgreement(created.legalBodyId, { hash: built.manifestHash, version: 1 });
    for (const fn of bothFunctions(deps(), rowOf(created.legalBodyId)))
      await refusedWith(fn.run, "agreement_outdated", 409, fn.name);
  });

  test("an unadopted order whose agreement no longer reads back answers agreement_unreadable, and an abandoned one order_closed", async () => {
    const unreadable = draft();
    const names = agreementDocNames(unreadable.legalBodyId);
    const bytes = Buffer.from(s.docStore.getBytes(names.manifest));
    bytes.writeUInt8(bytes.readUInt8(10) ^ 0x01, 10);
    s.docStore.putBytes(names.manifest, bytes);
    for (const fn of bothFunctions(deps(), unreadable))
      await refusedWith(fn.run, "agreement_unreadable", 500, fn.name);

    const abandoned = draft();
    expect(s.repo.abandon(abandoned.legalBodyId, "tenant_request", "tenant")).toBe(true);
    await refusedWith(
      () => linkMessage(deps(), tenant, abandoned.legalBodyId, { agentId: "42" }),
      "order_closed",
      409,
      "linkMessage",
    );
  });
});

// ── The REST doors and the agent's tools ────────────────────────────────────────────────────

function appOver(
  database: Database.Database,
  stores: LegalBodyStores,
  over: Partial<LegalBodyOrderDeps> = {},
) {
  const requests = new SqliteFormationRepository(database);
  const apiDeps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(database),
    companies: stores.companies,
    docStore: stores.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: stores.declarations,
      checks: stores.checks,
      hasLinkedLegalBody: (companyId) => stores.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders: legalBodyOrderDeps(stores, { chain: asChainPort(chain), ...over }),
    apiKeys: new SqliteApiKeyStore(database),
    passkeys: new SqlitePasskeyStore(database),
    jobs: new SqliteJobRepository(database),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(apiDeps as ApiDeps);
}

async function callTool(
  app: ReturnType<typeof appOver>,
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: Json }> {
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const out = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { isError: out.isError === true, body: JSON.parse(out.content[0]?.text ?? "null") };
  } finally {
    await close();
  }
}

describe("the doors and the tools answer the same code and sentence", () => {
  test("POST link-message and POST link answer 409 agreement_not_adopted with its sentence", async () => {
    const app = appOver(db, s);
    const row = draft();
    const token = await sessionOf(guardian);
    const message = await answerOf(
      await call(app, "POST", `/legal-body-orders/${row.legalBodyId}/link-message`, token, {
        agentId: "42",
      }),
    );
    const link = await answerOf(
      await call(
        app,
        "POST",
        `/legal-body-orders/${row.legalBodyId}/link`,
        token,
        await signedLink(linkFor(row)),
      ),
    );
    for (const res of [message, link]) {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: CODE, message: LEGAL_BODY_SENTENCES[CODE] } });
    }
    expect(chainReads()).toBe(0);
  });

  test("get_link_message and submit_link answer agreement_not_adopted with the same sentence, both descriptions name the step, and there is no adoption tool", async () => {
    const app = appOver(db, s);
    const row = draft();
    const key = new SqliteApiKeyStore(db).mint(tenant, { capability: "provision" }).key;
    const message = await callTool(app, key, "get_link_message", {
      orderId: row.legalBodyId,
      agentId: "42",
    });
    const link = await callTool(app, key, "submit_link", {
      orderId: row.legalBodyId,
      ...(await signedLink(linkFor(row))),
    });
    for (const answer of [message, link]) {
      expect(answer.isError).toBe(true);
      expect(answer.body).toEqual({ code: CODE, message: LEGAL_BODY_SENTENCES[CODE] });
    }
    expect(chainReads()).toBe(0);
    // The adoption is the guardian's own signature, made in the web app: no tool makes one.
    const { client, close } = await startMcpTestClient(app, key);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).filter((name) => /adopt/i.test(name))).toEqual([]);
      // The agent learns of the step before it is refused, from either tool: the guardian adopts
      // in the web app.
      for (const name of ["get_link_message", "submit_link"]) {
        const description = tools.find((t) => t.name === name)?.description ?? "";
        expect(description, name).toContain(
          "Before the link, the order's guardian adopts its operating agreement in the web app: until then this answers agreement_not_adopted.",
        );
      }
    } finally {
      await close();
    }
  });
});

describe("the guardian's whole path fits the doors' throttles", () => {
  test("with the buckets the deployment wires, the adoption, the link message and the link all pass, and the tenant's bucket still has room", async () => {
    // As the composition root builds them: 5 tokens per tenant, one back every 10 seconds; 20 for
    // all the doors, one back every second.
    const tenantBucket = bucketsByKey(5, 1 / 10);
    const app = appOver(db, s, { tenantBucket, doorBudget: new TokenBucket(20, 1) });
    const row = draft();
    const id = row.legalBodyId;
    const token = await sessionOf(guardian);

    const served = await answerOf(
      await call(app, "POST", `/legal-body-orders/${id}/adoption-message`, token, {}),
    );
    expect(served.status).toBe(200);
    const adopted = await answerOf(
      await call(app, "POST", `/legal-body-orders/${id}/adoption`, token, {
        issuedAt: served.body.issuedAt,
        signature: await guardian.signTypedData(served.body.typedData),
      }),
    );
    expect(adopted.status).toBe(200);
    const message = await answerOf(
      await call(app, "POST", `/legal-body-orders/${id}/link-message`, token, { agentId: "42" }),
    );
    expect(message.status).toBe(200);
    const link = await answerOf(
      await call(
        app,
        "POST",
        `/legal-body-orders/${id}/link`,
        token,
        await signedLink(linkFor(row)),
      ),
    );
    expect(link.status).toBe(202);
    expect(link.body).toMatchObject({ id, state: "reserved" });
    // Three tokens of five: a retry or a refresh of the binding still finds one.
    expect(tenantBucket(tenant).take()).toBe(true);
  });
});
