/**
 * The declared door and the guardian identity record: verified once, typed never.
 *
 * On production the declared door requires a verified identity record for the guardian, right
 * after the World row (step 1b, before the wording's check), and writes the declarant's name from
 * that record: the first name, a space, the last name. A typed `declarantName` is refused with its
 * own code, after the identity gate and the wording's check, so a guardian who is not verified is
 * told that first. The typed data the wallet signs carries the written name, and the signed create
 * stores it. The title stays typed.
 *
 * On a sandbox nothing changes: the declarant is the sandbox fixture, and the identity record is
 * never read (a repository that throws on every call proves it).
 *
 * The database is real (in memory). Every name, company and filing number is an invention, the PII
 * key a constant test key, and the guardians' keys anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { IDENTITY_NOT_VERIFIED_MESSAGE, type IdentityDeps } from "../../src/identity/state";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { type CustomerCompanyDeps, SYNTHETIC_DECLARANT } from "../../src/legalBody/customerCompany";
import { STATEMENT_OF_AUTHORITY } from "../../src/legalBody/texts/statementOfAuthority";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import {
  type IdentityRepository,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_2,
  APPROVED,
  CHAIN_ID,
  SANDBOX_TYPED,
  type Signer,
  TEST_PII_RING,
  customerCompanyDeps,
  identityOver,
  recordHuman,
  recordIdentity,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";

/** anvil's published account #2: a test key, never a real wallet. */
const guardian = ANVIL_ACCOUNT_2;

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const STATEMENT_MESSAGE = "/companies/customer/statement-message";
const CREATE = "/companies/customer";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The names of record: a made-up person. */
const FIRST = "Jean";
const LAST = "Dupont";
const FULL = "Jean Pierre Dupont";
/** The declarant's name the door writes from them. */
const WRITTEN = "Jean Dupont";

/** A declaration as a production client sends it now: no declarant name, the title typed. */
const DECLARED = {
  declarantTitle: "Managing Member",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
};

let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let store: SqliteWorldStore;
let identityRepo: SqliteIdentityRepository;
let identity: IdentityDeps;
/** The doors' clock, in milliseconds: the real time, so the database's own clock agrees with it. */
let nowMs: number;
/** Every console line written in the test (the create's ops line among them). */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  store = new SqliteWorldStore(db);
  identityRepo = new SqliteIdentityRepository(db);
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  identity = identityOver(identityRepo, () => nowMs);
  printed = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  recordHuman(store, guardian.address, "1001", nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** A passed identity record of the guardian, completed a month ago and due for renewal at
 *  `expiresAt`, written through the repository as the operator's command writes one. */
function passedRecord(
  expiresAt: number,
  names: { first: string; last: string } = { first: FIRST, last: LAST },
): void {
  recordIdentity(identityRepo, guardian.address, {
    at: nowMs - 30 * DAY_MS,
    expiresAt,
    names,
    full: FULL,
    nullifier: "1001",
  });
}

/** A verified guardian: a passed record due for renewal in three years. */
const verified = (): void => passedRecord(nowMs + 3 * 365 * DAY_MS);

const stores = () => ({ db, companies, declarations, checks, store });

/** The doors of a production deployment that charges, serving the approved wording, with the
 *  identity record wired. */
function doors(over: Partial<CustomerCompanyDeps> = {}): CustomerCompanyDeps {
  return customerCompanyDeps(stores(), () => nowMs, { identity, ...over });
}

/** The API over this test's database, with the customer doors given. */
function makeApp(customerCompanies: CustomerCompanyDeps) {
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new DeletableMemoryDocumentStore();
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies,
    documents,
    docStore,
    customerFacts: { declarations, checks },
    customerCompanies: { ...customerCompanies, documents, docStore },
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

async function sessionOf(who: Signer): Promise<string> {
  const { token } = await signSession(who.address, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

async function post(app: App, path: string, token: string, body: object): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** The refusal envelope, and the raw text, to show what it does not carry. */
async function refusalOf(
  res: Response,
): Promise<{ status: number; code: string; message: string; details: unknown; text: string }> {
  const text = await res.text();
  const body = JSON.parse(text);
  return {
    status: res.status,
    code: body.error?.code,
    message: body.error?.message,
    details: body.error?.details,
    text,
  };
}

const countRows = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** What the guardian's client does: ask for the statement, sign the typed data as it arrived, and
 *  send the declaration back with the signature. Answers the create's response. */
async function declare(app: App, token: string, body: object = DECLARED): Promise<Response> {
  const asked = await post(app, STATEMENT_MESSAGE, token, body);
  expect(asked.status).toBe(200);
  const { typedData } = await asked.json();
  const signature = await guardian.signTypedData(typedData);
  return post(app, CREATE, token, { ...body, issuedAt: typedData.message.issuedAt, signature });
}

// ── production ───────────────────────────────────────────────────────────────────────────────

describe("on production the declared door requires a verified guardian identity record", () => {
  test("a guardian with a World row and no identity record: 403 guardian_identity_not_verified at the statement door, and nothing written", async () => {
    const refused = await refusalOf(
      await post(makeApp(doors()), STATEMENT_MESSAGE, await sessionOf(guardian), DECLARED),
    );
    expect(refused).toMatchObject({
      status: 403,
      code: "guardian_identity_not_verified",
      message: IDENTITY_NOT_VERIFIED_MESSAGE,
    });
    expect(countRows("companies")).toBe(0);
    expect(countRows("company_declarations")).toBe(0);
  });

  test("an expired record: 403 guardian_identity_not_verified at the statement door", async () => {
    passedRecord(nowMs - DAY_MS);
    const refused = await refusalOf(
      await post(makeApp(doors()), STATEMENT_MESSAGE, await sessionOf(guardian), DECLARED),
    );
    expect(refused).toMatchObject({ status: 403, code: "guardian_identity_not_verified" });
  });

  test("the create door holds the guardian to the same record", async () => {
    const refused = await refusalOf(
      await post(makeApp(doors()), CREATE, await sessionOf(guardian), {
        ...DECLARED,
        issuedAt: String(Math.floor(nowMs / 1000)),
        signature: `0x${"ab".repeat(65)}`,
      }),
    );
    expect(refused).toMatchObject({ status: 403, code: "guardian_identity_not_verified" });
    expect(countRows("companies")).toBe(0);
  });

  test("the identity record not wired on production: 503 identity_unavailable", async () => {
    verified();
    const refused = await refusalOf(
      await post(
        makeApp(doors({ identity: undefined })),
        STATEMENT_MESSAGE,
        await sessionOf(guardian),
        DECLARED,
      ),
    );
    expect(refused).toMatchObject({ status: 503, code: "identity_unavailable" });
  });

  test("the identity gate comes before the wording's check: an unverified guardian on a draft wording is answered 403", async () => {
    const refused = await refusalOf(
      await post(
        makeApp(doors({ text: STATEMENT_OF_AUTHORITY })),
        STATEMENT_MESSAGE,
        await sessionOf(guardian),
        DECLARED,
      ),
    );
    expect(refused).toMatchObject({ status: 403, code: "guardian_identity_not_verified" });
  });
});

describe("on production the declarant's name is written from the record, never typed", () => {
  test("a verified guardian is served the statement with the name of record as the declarant, the title as typed", async () => {
    verified();
    const asked = await post(
      makeApp(doors()),
      STATEMENT_MESSAGE,
      await sessionOf(guardian),
      DECLARED,
    );
    expect(asked.status).toBe(200);
    const { typedData } = await asked.json();
    expect(typedData.message.declarantName).toBe(WRITTEN);
    expect(typedData.message.declarantTitle).toBe(DECLARED.declarantTitle);
    // The sentence the wallet signs names the written declarant.
    expect(typedData.message.statement).toBe(
      APPROVED.render({
        declarantName: WRITTEN,
        declarantTitle: DECLARED.declarantTitle,
        companyName: DECLARED.companyName,
        jurisdiction: "WY",
        filingNumber: DECLARED.filingNumber,
        guardian: guardian.address,
      }),
    );
    // Never the full name of record.
    expect(JSON.stringify(typedData)).not.toContain(FULL);
    expect(countRows("company_declarations")).toBe(0);
  });

  test("a typed declarantName: 400 declarant_name_is_written_by_novi, at both doors, and nothing written", async () => {
    verified();
    const app = makeApp(doors());
    const token = await sessionOf(guardian);
    const typed = { ...DECLARED, declarantName: WRITTEN };

    const atStatement = await refusalOf(await post(app, STATEMENT_MESSAGE, token, typed));
    expect(atStatement).toMatchObject({
      status: 400,
      code: "declarant_name_is_written_by_novi",
      message:
        "the declarant's name is written from the verified identity record: leave out declarantName",
    });
    const atCreate = await refusalOf(
      await post(app, CREATE, token, {
        ...typed,
        issuedAt: String(Math.floor(nowMs / 1000)),
        signature: `0x${"ab".repeat(65)}`,
      }),
    );
    expect(atCreate).toMatchObject({ status: 400, code: "declarant_name_is_written_by_novi" });
    // Whatever the value: an empty one, or one that is not text, is a typed name all the same.
    for (const declarantName of ["", null, 7])
      expect(
        (await refusalOf(await post(app, STATEMENT_MESSAGE, token, { ...DECLARED, declarantName })))
          .code,
        JSON.stringify(declarantName),
      ).toBe("declarant_name_is_written_by_novi");
    expect(countRows("companies")).toBe(0);
  });

  test("the gate comes before the typed-name refusal: an unverified guardian who types a name is answered 403", async () => {
    const refused = await refusalOf(
      await post(makeApp(doors()), STATEMENT_MESSAGE, await sessionOf(guardian), {
        ...DECLARED,
        declarantName: WRITTEN,
      }),
    );
    expect(refused).toMatchObject({ status: 403, code: "guardian_identity_not_verified" });
  });

  test("the wording's check comes before the typed-name refusal: a draft wording answers 503", async () => {
    verified();
    const refused = await refusalOf(
      await post(
        makeApp(doors({ text: STATEMENT_OF_AUTHORITY })),
        STATEMENT_MESSAGE,
        await sessionOf(guardian),
        { ...DECLARED, declarantName: WRITTEN },
      ),
    );
    expect(refused).toMatchObject({ status: 503, code: "legal_text_not_approved" });
  });

  test("the signed create stores the name of record as the declarant, and no console line carries it", async () => {
    verified();
    const app = makeApp(doors());
    const created = await declare(app, await sessionOf(guardian));
    expect(created.status).toBe(201);
    const { companyId } = await created.json();

    const row = db
      .prepare(
        "SELECT declarant_name, declarant_title FROM company_declarations WHERE company_id = ?",
      )
      .get(companyId) as { declarant_name: string; declarant_title: string };
    expect(row).toEqual({ declarant_name: WRITTEN, declarant_title: DECLARED.declarantTitle });
    expect(declarations.find(companyId)?.declarantName).toBe(WRITTEN);
    expect(companies.find(companyId)).toMatchObject({ provider: "customer", status: "draft" });
    // The create wrote its ops line, and no line names the person.
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) {
      expect(line).not.toContain(FIRST);
      expect(line).not.toContain(LAST);
    }
  });

  test("a name of record that breaks the declarant rule is answered as a field problem, not a crash", async () => {
    // Impossible through the operator's command, which holds the name to this rule before it
    // verifies a record; written straight into the table here.
    passedRecord(nowMs + 365 * DAY_MS, { first: FIRST, last: "Example 2" });
    const refused = await refusalOf(
      await post(makeApp(doors()), STATEMENT_MESSAGE, await sessionOf(guardian), DECLARED),
    );
    expect(refused).toMatchObject({
      status: 400,
      code: "validation_error",
      details: [
        {
          field: "declarantName",
          problem: "may hold only letters, spaces, apostrophes, hyphens and full stops",
        },
      ],
    });
    // The problem names the rule, never the value.
    expect(refused.text).not.toContain("Example 2");
  });
});

// ── sandbox ──────────────────────────────────────────────────────────────────────────────────

describe("on a sandbox nothing changes, and the identity record is never read", () => {
  /** An identity record that throws on every call, and counts them. */
  function untouchable(): { identity: IdentityDeps; reads: () => number } {
    let reads = 0;
    const refuse = (): never => {
      reads += 1;
      throw new Error("a sandbox door read the identity record");
    };
    const repo: IdentityRepository = {
      append: refuse,
      latest: refuse,
      list: refuse,
      events: refuse,
      findById: refuse,
      passedElsewhere: refuse,
      eraseNames: refuse,
      erasureCandidates: refuse,
      transaction: refuse,
    };
    return {
      identity: {
        repo,
        pii: TEST_PII_RING,
        reverifyYears: 3,
        blockedCountries: new Set(),
        now: refuse,
      },
      reads: () => reads,
    };
  }

  test("the synthetic declaration is served and created with the sandbox declarant, without one identity read", async () => {
    const stub = untouchable();
    const app = makeApp(
      sandboxCustomerCompanyDeps(stores(), () => nowMs, {
        identity: stub.identity,
        paymentRequired: false,
      }),
    );
    const token = await sessionOf(guardian);

    const asked = await post(app, STATEMENT_MESSAGE, token, SANDBOX_TYPED);
    expect(asked.status).toBe(200);
    expect((await asked.json()).typedData.message).toMatchObject({
      declarantName: SYNTHETIC_DECLARANT.name,
      declarantTitle: SYNTHETIC_DECLARANT.title,
    });
    const created = await declare(app, token, SANDBOX_TYPED);
    expect(created.status).toBe(201);
    const { companyId } = await created.json();
    expect(declarations.find(companyId)?.declarantName).toBe(SYNTHETIC_DECLARANT.name);

    // A typed name is still the sandbox's own refusal.
    const typed = await refusalOf(
      await post(app, STATEMENT_MESSAGE, token, { ...SANDBOX_TYPED, declarantName: WRITTEN }),
    );
    expect(typed).toMatchObject({ status: 400, code: "synthetic_declarant_only" });
    expect(stub.reads()).toBe(0);
  });
});
