/**
 * The total cap at the doors, over a real WAL database file: the formed create's transaction, and
 * the two doors that re-quote a company.
 *
 * The formed create's mint reads before it writes (the cap's re-check), so it runs in an
 * IMMEDIATE transaction: the write lock is taken at BEGIN, and another connection's write (the
 * payments authority, an operator command) is waited for, up to the busy timeout. A deferred
 * transaction that reads first cannot wait for that lock and fails at once with SQLITE_BUSY. The
 * other connection runs in a worker thread, because a connection on this thread could not let go
 * of its lock while this one waits.
 *
 * A re-quote brings an expired draft back into the count, so on production it is refused at the
 * cap with the create's own code and sentence, at the REST door and the MCP tool alike.
 *
 * The operating agreement module is replaced by an approved copy. Every name, address and
 * nullifier is an invention, the keys constant test keys.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type DatabaseType from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import type { CreateCompanyDeps } from "../../src/formation/company";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import type { LegalTextStatus } from "../../src/legalBody/texts/index";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  TEST_PII_RING,
  identityOver,
  recordHuman,
  recordIdentity,
  worldFor,
} from "../helpers/customerCompanyFixtures";
import { fakeChain, paymentCfg } from "../helpers/formationPayment";
import { startMcpTestClient } from "../mcp/helpers";

const texts = vi.hoisted(() => ({ agreement: "approved" as LegalTextStatus }));

vi.mock("../../src/legalBody/texts/operatingAgreement", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/legalBody/texts/operatingAgreement")>();
  return {
    ...actual,
    get LEGAL_BODY_OPERATING_AGREEMENT() {
      return { ...actual.LEGAL_BODY_OPERATING_AGREEMENT, status: texts.agreement };
    },
  };
});

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const TENANT = getAddress("0x00000000000000000000000000000000000000c1");
const NULLIFIER = "3001";
const DAY_MS = 24 * 60 * 60 * 1000;
const SENTENCE =
  "The early-access formations are all taken: join the waitlist and we will write to you when a place opens.";

/** How long the other connection holds the write lock. */
const HOLD_MS = 300;

let dir: string;
let path: string;
let db: DatabaseType.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;
let apiKeys: SqliteApiKeyStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "formed-cap-doors-"));
  path = join(dir, "novi.db");
  db = openDatabase(path);
  migrate(db);
  // A table only the other connection writes, so its write takes the lock and touches nothing
  // the create reads.
  db.exec("CREATE TABLE lock_probe (n INTEGER NOT NULL)");
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  texts.agreement = "approved";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A production deployment that charges, with every gate of the formed door passing for TENANT
 *  (a real human with a passed identity record, the approved agreement, invites required) and a
 *  total cap of `maxTotal`. */
function app(maxTotal: number) {
  const store = new SqliteWorldStore(db);
  const identityRepo = new SqliteIdentityRepository(db);
  const now = Date.now();
  recordHuman(store, TENANT, NULLIFIER, now - DAY_MS);
  recordIdentity(identityRepo, TENANT, {
    at: now - 30 * DAY_MS,
    expiresAt: now + 3 * 365 * DAY_MS,
    nullifier: NULLIFIER,
  });
  const payment = paymentCfg(payments);
  const pin = { provider: "doola", environment: "production" } as const;
  const companyDeps: Omit<CreateCompanyDeps, "transaction"> = {
    companies,
    parties,
    requests,
    pin,
    legalBodyEnvironment: "production",
    sandboxSyntheticPii: false,
    maxPerTenant: 10,
    dailyCeiling: 100,
    maxTotal,
    pii: TEST_PII_RING,
    world: worldFor(store),
    identity: identityOver(identityRepo, () => Date.now()),
    invites: { required: true },
    payment,
  };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    apiKeys,
    formationSteps: (id: string) => requests.stepsOf(id),
    company: (id: string) => companies.find(id),
    companyAgents: companies,
    formation: {
      environment: "production",
      required: true,
      sandboxSyntheticPii: false,
      maxPerTenant: 10,
      dailyCeiling: 100,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin,
      companyDeps,
      payment,
      feeUsdc: 399,
      paymentExecutor: fakeChain().executor,
    },
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof app>;

async function post(application: App, route: string, body: unknown = {}): Promise<Response> {
  const { token } = await signSession(TENANT, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return application.request(route, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function newParty(): string {
  return parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Example",
    email: "person@example.com",
    phone: "+12125550100",
    line1: "1 Example Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
}

const formedIntake = (partyId: string) => ({
  partyId,
  names: ["Example Works", "Example Labs", "Example Studio"],
  businessPurpose: "Operating software agents.",
  industryLabel: DEFAULT_INDUSTRY,
  for: "legal_body",
});

/** A formed legal-body company of another person that takes a place: ready. */
function anotherPersonsCompany(n: number): string {
  return companies.create({
    tenantId: getAddress(`0x${(0xd0 + n).toString(16).padStart(40, "0")}`),
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions(`Sample ${n} Works`, `Sample ${n} Labs`, `Sample ${n} Studio`),
    businessPurpose: "Another person's company.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
}

/**
 * Another connection to the same file, in a worker thread, that takes the write lock
 * (BEGIN IMMEDIATE), writes, holds the lock for HOLD_MS and commits. Resolves once the lock is
 * held; `released()` once the worker has committed and exited.
 */
function holdWriteLock(): { flag: Int32Array; released: () => Promise<void> } {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const driver = createRequire(import.meta.url).resolve("better-sqlite3");
  const worker = new Worker(
    `
    const { workerData } = require("node:worker_threads");
    const Database = require(workerData.driver);
    const flag = new Int32Array(workerData.flag);
    const db = new Database(workerData.path);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO lock_probe (n) VALUES (1)").run();
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    Atomics.wait(flag, 1, 0, workerData.holdMs);
    db.exec("COMMIT");
    Atomics.store(flag, 0, 2);
    db.close();
    `,
    { eval: true, workerData: { driver, path, flag: flag.buffer, holdMs: HOLD_MS } },
  );
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", () => resolve());
  });
  // Block this thread until the worker holds the lock (or five seconds pass).
  Atomics.wait(flag, 0, 0, 5000);
  return { flag, released: () => exited };
}

// ── the formed create's transaction ──────────────────────────────────────────────────────────

describe("the formed create takes the write lock first", () => {
  test("while another connection holds a write, POST /companies for a legal body waits for it and creates, rather than failing with SQLITE_BUSY", async () => {
    const application = app(10);
    const partyId = newParty();

    const lock = holdWriteLock();
    expect(Atomics.load(lock.flag, 0)).toBe(1);
    const started = Date.now();
    const res = await post(application, "/companies", formedIntake(partyId));
    const waited = Date.now() - started;
    await lock.released();

    expect(res.status).toBe(201);
    const { companyId } = (await res.json()) as { companyId: string };
    expect(companies.find(companyId)).toMatchObject({ purposeKind: "legal_body", status: "draft" });
    // It waited for the other connection's commit, which landed too.
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(Atomics.load(lock.flag, 0)).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lock_probe").get()).toEqual({ n: 1 });
  });

  test("inside an outer transaction the immediate variant is a savepoint: it commits with the outer one, and a failure rolls back only its own writes", () => {
    const rows = () =>
      (db.prepare("SELECT n FROM lock_probe ORDER BY n").all() as { n: number }[]).map((r) => r.n);
    repo.transaction(() => {
      repo.immediateTransaction(() => db.prepare("INSERT INTO lock_probe (n) VALUES (1)").run());
      expect(() =>
        repo.immediateTransaction(() => {
          db.prepare("INSERT INTO lock_probe (n) VALUES (2)").run();
          throw new Error("the inner write fails");
        }),
      ).toThrow("the inner write fails");
      db.prepare("INSERT INTO lock_probe (n) VALUES (3)").run();
    });
    expect(rows()).toEqual([1, 3]);
  });
});

// ── the re-quote doors ───────────────────────────────────────────────────────────────────────

describe("a re-quote at the cap, at both doors", () => {
  /** TENANT's formed draft whose quote expired, at a cap of two now taken by two others. */
  async function expiredDraftAtTheCap(application: App): Promise<string> {
    const res = await post(application, "/companies", formedIntake(newParty()));
    expect(res.status).toBe(201);
    const { companyId } = (await res.json()) as { companyId: string };
    const quote = payments.findLive(companyId, "formation")!;
    expect(payments.markExpired(quote.paymentId, "quoted")).toBe(true);
    anotherPersonsCompany(1);
    anotherPersonsCompany(2);
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);
    return companyId;
  }

  test("REST: POST /companies/:id/payment/requote answers 409 formation_cap_reached and writes no quote", async () => {
    const application = app(2);
    const companyId = await expiredDraftAtTheCap(application);
    const res = await post(application, `/companies/${companyId}/payment/requote`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "formation_cap_reached", message: SENTENCE },
    });
    expect(payments.findLive(companyId, "formation")).toBeUndefined();
    expect(payments.listByCompany(companyId)).toHaveLength(1);
  });

  test("MCP: requote_company_payment answers the same sentence and writes no quote", async () => {
    const application = app(2);
    const companyId = await expiredDraftAtTheCap(application);
    const mcp = await startMcpTestClient(
      application,
      apiKeys.mint(TENANT, { capability: "provision" }).key,
    );
    try {
      const out = (await mcp.client.callTool({
        name: "requote_company_payment",
        arguments: { companyId },
      })) as { content: { text: string }[]; isError?: boolean };
      expect({ text: out.content[0]!.text, isError: Boolean(out.isError) }).toEqual({
        text: SENTENCE,
        isError: true,
      });
    } finally {
      await mcp.close();
    }
    expect(payments.findLive(companyId, "formation")).toBeUndefined();
    expect(payments.listByCompany(companyId)).toHaveLength(1);
  });
});
