/**
 * A deployment that changes the declaration it serves, on a factory it keeps.
 *
 * A declaration is never rewritten, so a company declared under another version of the wording
 * than the one served takes no new order (`declaration_outdated`). On a sandbox such a company
 * also takes no place under its tenant's cap on open declared companies, so the tenant can declare
 * a new one. The rule is read at the cap, from the declaration served, on the company's own
 * environment, and writes nothing: served again, the earlier wording makes its companies count
 * again. The company keeps everything else: its status, its declaration, its test number, its
 * legal bodies, and its place under the human's cap.
 *
 * The database is real (in memory). Every name, company and filing number here is an invention,
 * and the keys are anvil's published test accounts.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/errors";
import {
  CUSTOMER_COMPANY_PLACEHOLDER,
  CUSTOMER_PROVIDER,
  type CustomerCompanyDeps,
  type CustomerCompanyInput,
  type CustomerStatementInput,
  abandonCustomerCompany,
  createCustomerCompany,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import { createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import type { LegalText } from "../../src/legalBody/texts/index";
import { CHARTER_LEGAL_TEXTS, octoberLegalTexts } from "../../src/legalBody/texts/sets";
import type { StatementFields } from "../../src/legalBody/texts/statementOfAuthority";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  ANVIL_ACCOUNT_2,
  SANDBOX_TYPED,
  customerCompanyDeps,
  recordHuman,
  sandboxCustomerCompanyDeps,
  worldFor,
} from "../helpers/customerCompanyFixtures";
import {
  type LegalBodyStores,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** anvil's published account #2: a test key, never a real wallet. */
const owner = ANVIL_ACCOUNT_2;

/** The two declarations a deployment can serve: the October pair's and the Charter pair's. */
const EARLIER = octoberLegalTexts().declaration;
const LATER = CHARTER_LEGAL_TEXTS.declaration;
const approved = (text: LegalText<StatementFields>): LegalText<StatementFields> => ({
  ...text,
  status: "approved",
});

const DAY_MS = 24 * 60 * 60 * 1000;
const AT_THE_CAP = "this tenant already has 3 declared companies open (max 3)";

let db: Database.Database;
let s: LegalBodyStores;
let nowMs: number;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  nowMs = Math.floor(Date.now() / 1000) * 1000;
  // A created company writes an ops line: kept off the test's output.
  vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(s.store, owner.address, "1001", nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The doors of a sandbox deployment that does not charge and serves `text`, on the test's clock. */
const sandbox = (text: LegalText<StatementFields>, over: Partial<CustomerCompanyDeps> = {}) =>
  sandboxCustomerCompanyDeps(s, () => nowMs, { paymentRequired: false, text, ...over });
/** The doors of a production deployment that charges and serves `text`, approved. */
const production = (text: LegalText<StatementFields>, over: Partial<CustomerCompanyDeps> = {}) =>
  customerCompanyDeps(s, () => nowMs, { text: approved(text), ...over });

/** A sandbox declaration of test number `n`, and a production one. */
const sandboxTyped = (n: number): CustomerStatementInput => ({
  ...SANDBOX_TYPED,
  filingNumber: `TEST-000${n}`,
});
const productionTyped = (n: number): CustomerStatementInput => ({
  declarantTitle: "Member",
  companyName: "Example Holdings LLC",
  filingNumber: `EX-000${n}`,
});

/** The body a client sends once the owner's wallet signed the statement the door served. */
async function signed(
  deps: CustomerCompanyDeps,
  typed: CustomerStatementInput,
): Promise<CustomerCompanyInput> {
  const { fields } = prepareCustomerStatement(deps, owner.address, typed);
  const issuedAt = BigInt(Math.floor((deps.now ?? Date.now)() / 1000));
  const served = statementTypedDataWire(
    deps.chainId,
    deps.factory,
    buildStatementMessage(fields, deps.text, issuedAt),
  );
  const signature = await owner.signTypedData(JSON.parse(JSON.stringify(served)));
  return { ...typed, issuedAt: served.message.issuedAt, signature };
}

/** Declares through the doors of `deps`, and answers the new company's id. */
async function declare(deps: CustomerCompanyDeps, typed: CustomerStatementInput): Promise<string> {
  const answer = await createCustomerCompany(deps, owner.address, await signed(deps, typed));
  expect(answer.created).toBe(true);
  return answer.companyId;
}

/** What a client reads of the refusal `run` ends in. Any other throw, or none, fails the test. */
async function refusalOf(run: () => unknown): Promise<{
  code: string;
  status: number;
  message: string;
  details: unknown;
}> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { code: err.code, status: err.status, message: err.message, details: err.details };
  }
  throw new Error("no refusal");
}

/** The tenant's places taken under the cap where `text` is the declaration served. */
const placesTaken = (text: LegalText<StatementFields>): number =>
  s.companies.countCustomerOpenByTenant(owner.address, text.version);

/** Every company row, as it would read had nothing touched it since its creation. */
const untouched = (companyIds: string[]): void => {
  for (const companyId of companyIds) {
    expect(s.companies.find(companyId)?.status).toBe("ready");
    expect(s.declarations.find(companyId)).toMatchObject({
      wordingVersion: EARLIER.version,
      piiErasedAt: null,
    });
    expect(s.checks.list(companyId)).toHaveLength(1);
  }
};

describe("a sandbox tenant at its cap, after the deployment changes its declaration", () => {
  /** Three companies declared under the earlier wording: the tenant's cap of three is reached. */
  async function atTheCapUnderTheEarlierWording(): Promise<string[]> {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push(await declare(sandbox(EARLIER), sandboxTyped(n)));
    expect(
      await refusalOf(async () =>
        createCustomerCompany(
          sandbox(EARLIER),
          owner.address,
          await signed(sandbox(EARLIER), sandboxTyped(4)),
        ),
      ),
    ).toMatchObject({ code: "customer_company_cap", status: 409, message: AT_THE_CAP });
    // The declarations of the next day are outside the 24 hours the rate counts.
    nowMs += DAY_MS + 60 * 60 * 1000;
    return ids;
  }

  test("declares a new company, and nothing is written to the earlier ones", async () => {
    const earlier = await atTheCapUnderTheEarlierWording();
    expect(placesTaken(EARLIER)).toBe(3);
    expect(placesTaken(LATER)).toBe(0);

    const again = await declare(sandbox(LATER), sandboxTyped(4));
    expect(s.declarations.find(again)?.wordingVersion).toBe(LATER.version);
    expect(placesTaken(LATER)).toBe(1);
    untouched(earlier);
    expect(db.prepare("SELECT COUNT(*) AS n FROM companies").get()).toEqual({ n: 4 });
  });

  test("the cap holds among the companies declared under the wording served", async () => {
    await atTheCapUnderTheEarlierWording();
    for (const n of [4, 5, 6]) await declare(sandbox(LATER), sandboxTyped(n));
    expect(placesTaken(LATER)).toBe(3);
    expect(
      await refusalOf(async () =>
        createCustomerCompany(
          sandbox(LATER),
          owner.address,
          await signed(sandbox(LATER), sandboxTyped(7)),
        ),
      ),
    ).toMatchObject({ code: "customer_company_cap", status: 409, message: AT_THE_CAP });
  });

  test("served again, the earlier wording makes its companies count again", async () => {
    const earlier = await atTheCapUnderTheEarlierWording();
    await declare(sandbox(LATER), sandboxTyped(4));

    expect(placesTaken(EARLIER)).toBe(3);
    expect(
      await refusalOf(async () =>
        createCustomerCompany(
          sandbox(EARLIER),
          owner.address,
          await signed(sandbox(EARLIER), sandboxTyped(5)),
        ),
      ),
    ).toMatchObject({ code: "customer_company_cap", status: 409, message: AT_THE_CAP });
    untouched(earlier);
  });

  test("a test number stays with the company that declared it, whatever wording is served", async () => {
    await atTheCapUnderTheEarlierWording();
    const held = {
      code: "validation_error",
      status: 400,
      message: "some fields of the declaration are not valid",
      details: [
        {
          field: "filingNumber",
          problem: "is already declared on this deployment: choose another test number",
        },
      ],
    };
    expect(
      await refusalOf(() =>
        prepareCustomerStatement(sandbox(LATER), owner.address, sandboxTyped(1)),
      ),
    ).toEqual(held);
    // In another spelling too: the number is compared by its key.
    expect(
      await refusalOf(() =>
        prepareCustomerStatement(sandbox(LATER), owner.address, {
          ...SANDBOX_TYPED,
          filingNumber: "test-00-01",
        }),
      ),
    ).toMatchObject({ code: "validation_error", status: 400 });
  });

  test("a company left out of the cap is still kept by an open legal body of this factory", async () => {
    const [first = ""] = await atTheCapUnderTheEarlierWording();
    const kept = sandbox(LATER, {
      hasOpenLegalBody: () => true,
      hasOpenLegalBodyHere: () => true,
    });
    expect(await refusalOf(() => abandonCustomerCompany(kept, owner.address, first))).toMatchObject(
      { code: "conflict", status: 409, message: "this company stands behind an open legal body" },
    );
    untouched([first]);
  });

  test("the human's company cap still counts it", async () => {
    await atTheCapUnderTheEarlierWording();
    const capped = sandbox(LATER, {
      world: worldFor(s.store, { environment: "staging", maxCompaniesPerHuman: 3 }),
    });
    expect(
      await refusalOf(async () =>
        createCustomerCompany(capped, owner.address, await signed(capped, sandboxTyped(4))),
      ),
    ).toMatchObject({
      code: "guardian_company_cap",
      status: 403,
      message: "this human already controls 3 companies (max 3)",
    });
  });
});

describe("which companies the cap leaves out", () => {
  test("exactly the sandbox company the order door refuses for its declaration", async () => {
    const companyId = await declare(sandbox(EARLIER), sandboxTyped(1));

    // Where the later declaration is served: no order, and no place taken.
    expect(
      await refusalOf(() =>
        createOrder(legalBodyOrderDeps(s, { texts: CHARTER_LEGAL_TEXTS }), owner.address, {
          companyId,
        }),
      ),
    ).toMatchObject({
      code: "declaration_outdated",
      status: 409,
      message: LEGAL_BODY_SENTENCES.declaration_outdated,
    });
    expect(placesTaken(LATER)).toBe(0);

    // Where its own declaration is served: an order, and a place taken.
    expect(createOrder(legalBodyOrderDeps(s), owner.address, { companyId }).state).toBe("draft");
    expect(placesTaken(EARLIER)).toBe(1);
  });

  test("a company that is not a sandbox one keeps its place, whatever its declaration and whatever the deployment", async () => {
    for (const n of [1, 2, 3]) await declare(production(EARLIER), productionTyped(n));
    nowMs += DAY_MS + 60 * 60 * 1000;
    expect(placesTaken(LATER)).toBe(3);

    // A production deployment that serves the later declaration, then a sandbox one.
    expect(
      await refusalOf(async () =>
        createCustomerCompany(
          production(LATER),
          owner.address,
          await signed(production(LATER), productionTyped(4)),
        ),
      ),
    ).toMatchObject({ code: "customer_company_cap", status: 409, message: AT_THE_CAP });
    expect(
      await refusalOf(async () =>
        createCustomerCompany(
          sandbox(LATER),
          owner.address,
          await signed(sandbox(LATER), sandboxTyped(4)),
        ),
      ),
    ).toMatchObject({ code: "customer_company_cap", status: 409, message: AT_THE_CAP });
  });

  test("a sandbox company is left out on its own environment, never the deployment's", async () => {
    for (const n of [1, 2, 3]) await declare(sandbox(EARLIER), sandboxTyped(n));
    nowMs += DAY_MS + 60 * 60 * 1000;

    // A production deployment that serves the later declaration: the three take no place there.
    const created = await declare(production(LATER), productionTyped(4));
    expect(s.companies.find(created)?.environment).toBe("production");
    expect(placesTaken(LATER)).toBe(1);
  });

  test("a customer's company with no declaration keeps its place", () => {
    for (const environment of ["sandbox", "production"] as const)
      s.companies.create({
        tenantId: owner.address,
        status: "ready",
        provider: CUSTOMER_PROVIDER,
        environment,
        synthetic: environment === "sandbox",
        nameOptions: [{ name: "Example Test Holdings LLC", entityTypeEnding: "", position: 1 }],
        businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
        industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
        intakeSynthesized: false,
        purposeKind: "legal_body",
      });
    expect(placesTaken(EARLIER)).toBe(2);
    expect(placesTaken(LATER)).toBe(2);
  });
});
