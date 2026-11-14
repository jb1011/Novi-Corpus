/**
 * `POST /companies/:companyId/abandon` dispatches by the company's provider.
 *
 * The route reads the tenant's own company (unknown and another tenant's are one 404). A customer's
 * own declared company goes to `abandonCustomerCompany`, exactly as before; a company formed
 * through doola for a legal body goes to `abandonFormedCompany`; anything else is a 409. The
 * formed abandon runs in the entity repository's transaction, the one the formed create takes, which
 * takes the write lock at BEGIN (IMMEDIATE).
 *
 * The database is real (in memory). The keys are anvil's published test accounts; every name and
 * company is an invention.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import type { CreateCompanyDeps } from "../../src/formation/company";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { CustomerCompanyDeps } from "../../src/legalBody/customerCompany";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import {
  type CompanyPurposeKind,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  type Signer,
  customerCompanyDeps,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import { paymentCfg } from "../helpers/formationPayment";

const owner = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";

const TYPED = {
  declarantTitle: "Authorised Signatory",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
};
const NOT_THIS_WAY =
  "only a declared company, or a company formed for a legal body, can be abandoned this way";

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let store: SqliteWorldStore;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;
let nowMs: number;
/** How many transactions the entity repository, the formed door's deps, was asked for. */
let opened: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  store = new SqliteWorldStore(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  opened = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(store, owner.address, "1001", nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The API with the customer company doors, and formation unless `formation` is false. */
function makeApp(opts: { formation?: boolean } = {}) {
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new DeletableMemoryDocumentStore();
  const customer: CustomerCompanyDeps = customerCompanyDeps(
    { db, companies, declarations, checks, store },
    () => nowMs,
  );
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
    payment: paymentCfg(payments),
  };
  // The entity repository's transactions, counted: the formed abandon must take the lock, and the
  // entity repository's transaction is the one that takes it at BEGIN.
  const counted = Object.assign(Object.create(repo), {
    transaction: <T>(fn: () => T): T => {
      opened += 1;
      return repo.transaction(fn);
    },
  }) as SqliteEntityRepository;
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: customer.chainId,
    repo: counted,
    companies,
    documents,
    docStore,
    customerFacts: { declarations, checks },
    customerCompanies: { ...customer, documents, docStore },
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
    formation:
      opts.formation === false
        ? undefined
        : {
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
            feeUsdc: 399,
          },
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof makeApp>;

async function sessionOf(who: Signer): Promise<string> {
  const { token } = await signSession(who.address, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

async function post(app: App, path: string, token: string, body?: object): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const abandon = (app: App, companyId: string, token: string) =>
  post(app, `/companies/${companyId}/abandon`, token);

/** A customer company declared through its doors: the statement asked, signed, and sent back. */
async function declared(app: App, token: string): Promise<string> {
  const asked = await post(app, "/companies/customer/statement-message", token, TYPED);
  expect(asked.status).toBe(200);
  const { typedData } = await asked.json();
  const signature = await owner.signTypedData(typedData);
  const res = await post(app, "/companies/customer", token, {
    ...TYPED,
    issuedAt: typedData.message.issuedAt,
    signature,
  });
  expect(res.status).toBe(201);
  return (await res.json()).companyId;
}

/** A ready doola company of the owner, its party bound: for a legal body unless told otherwise. */
function doolaCompany(purposeKind: CompanyPurposeKind = "legal_body"): {
  companyId: string;
  partyId: string;
} {
  const partyId = parties.create({
    tenantId: owner.address,
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
  const companyId = companies.create({
    tenantId: owner.address,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Example Works", "Example Labs", "Example Studio"),
    businessPurpose: "Operating software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind,
  });
  expect(parties.bindToCompany(partyId, companyId, owner.address)).toBe(true);
  return { companyId, partyId };
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = await res.json();
  return { status: res.status, code: body.error?.code, message: body.error?.message };
}

describe("the abandon door dispatches by provider", () => {
  test("a customer's own company still goes to the customer abandon: its declarant is erased", async () => {
    const app = makeApp();
    const token = await sessionOf(owner);
    const companyId = await declared(app, token);

    const res = await abandon(app, companyId, token);
    expect(res.status).toBe(204);
    expect(companies.find(companyId)!.status).toBe("abandoned");
    expect(declarations.find(companyId)!.declarantName).toBeNull();
    // The customer abandon runs in its own deps' transaction, not the formed door's.
    expect(opened).toBe(0);
  });

  test("a company formed for a legal body goes to the formed abandon, in the write lock's transaction", async () => {
    const app = makeApp();
    const token = await sessionOf(owner);
    const { companyId, partyId } = doolaCompany();

    const res = await abandon(app, companyId, token);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(companies.find(companyId)!.status).toBe("abandoned");
    expect(parties.findByCompanyId(companyId)).toBeUndefined();
    expect(parties.findOwned(owner.address, partyId)).toBeUndefined();
    expect(opened).toBe(1);
  });

  test("the formed abandon's refusals reach the caller: a filing being sent is a 409", async () => {
    const app = makeApp();
    const token = await sessionOf(owner);
    const { companyId } = doolaCompany();
    requests.claimAllSteps(companyId);
    requests.transition(companyId, "create_provider", "pending", "submitted");

    expect(await errorOf(await abandon(app, companyId, token))).toEqual({
      status: 409,
      code: "conflict",
      message: "the filing is being sent: try again in a minute",
    });
    expect(companies.find(companyId)!.status).toBe("ready");
  });

  test("a doola company for agents is a 409, and nothing moves", async () => {
    const app = makeApp();
    const token = await sessionOf(owner);
    const { companyId } = doolaCompany("agent");
    expect(await errorOf(await abandon(app, companyId, token))).toEqual({
      status: 409,
      code: "conflict",
      message: NOT_THIS_WAY,
    });
    expect(companies.find(companyId)!.status).toBe("ready");
    expect(parties.findByCompanyId(companyId)).toBeDefined();
  });

  test("an unknown company and another tenant's get one 404, whatever their provider", async () => {
    const app = makeApp();
    const { companyId } = doolaCompany();
    const theirs = await errorOf(await abandon(app, companyId, await sessionOf(stranger)));
    const unknown = await errorOf(await abandon(app, "no-such-company", await sessionOf(owner)));
    expect(theirs).toMatchObject({ status: 404, code: "not_found" });
    expect(theirs).toEqual(unknown);
    expect(companies.find(companyId)!.status).toBe("ready");
  });

  test("a deployment that forms nothing answers 503 for a formed company, and moves nothing", async () => {
    const app = makeApp({ formation: false });
    const token = await sessionOf(owner);
    const { companyId } = doolaCompany();
    const refused = await errorOf(await abandon(app, companyId, token));
    expect(refused).toMatchObject({ status: 503, code: "unavailable" });
    expect(companies.find(companyId)!.status).toBe("ready");
    expect(parties.findByCompanyId(companyId)).toBeDefined();
  });
});
