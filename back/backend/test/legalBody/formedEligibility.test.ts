/**
 * A company formed for a legal body stands behind one once the state has filed it: the order door
 * takes a formed company whose filing is confirmed and whose row carries the filed name and the
 * filing number, and its agreement prints those two facts, as the row holds them. A filed name the
 * agreement cannot print as it stands is refused with its own sentence, never cleaned; a company
 * formed for agents never stands behind a legal body. A declared company is read as before.
 *
 * The database is real (in memory); the chain is never called. Every name, company and filing
 * number is an invention, and every key is one of anvil's published test accounts.
 */
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import { ApiError } from "../../src/errors";
import { companyNameOptions } from "../../src/formation/intake";
import { agreementDocNames, buildAgreement } from "../../src/legalBody/agreement";
import {
  type LegalBodyOrderDeps,
  companyEligible,
  companyNamesForOrder,
  createOrder,
} from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "../../src/legalBody/texts/operatingAgreement";
import type { CompanyCheckResult } from "../../src/persistence/companyCheckRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import {
  ANVIL_ACCOUNT_2,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { seedCompany } from "../helpers/formationFakes";
import {
  type LegalBodyStores,
  REGISTRY,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

const tenant: Address = ANVIL_ACCOUNT_2.address;
/** The full legal name the State's record prints, as the processor stores it for a legal-body
 *  company: the matched option (the intake stores options without the entity ending) followed by
 *  the ending, "LLC". And the number the state gave it. */
const FILED_NAME = "Lantern Works LLC";
const FILING_NUMBER = "2026-000451207";
/** Unix seconds, at UTC midnight, as the processor writes `filed_at`. */
const FILED_AT = 1_793_664_000;

let s: LegalBodyStores;
let requests: SqliteFormationRepository;
let n = 0;

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  requests = new SqliteFormationRepository(db);
  recordHuman(s.store, tenant, "3101", Date.now());
});
afterEach(() => {
  s.db.close();
});

function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, {
    chain: {} as LegalBodyChainPort,
    maxOpenPerTenant: 20,
    maxOrdersPerTenantPerDay: 20,
    ...over,
  });
}

/**
 * A company formed through doola for `tenant`, its formation steps opened and `create_provider`
 * confirmed, as the saga leaves them. `filing` says how far the state got: `confirmed` writes the
 * filing facts the processor writes when it confirms `await_filing`; `submitted` leaves the step
 * waiting on the state, with the facts written anyway, so only the step tells the two apart;
 * `none` leaves the step pending with no facts.
 */
function formedCompany(
  opts: {
    purposeKind?: "agent" | "legal_body";
    filing?: "confirmed" | "submitted" | "none";
    legalNameFiled?: string | null;
    filingNumber?: string | null;
  } = {},
): string {
  const companyId = seedCompany(s.companies, {
    companyId: `formed-${++n}`,
    tenantId: tenant,
    purposeKind: opts.purposeKind ?? "legal_body",
    nameOptions: companyNameOptions(FILED_NAME, "Lantern Works Two LLC"),
    businessPurpose: "Software services.",
  });
  expect(requests.claimAllSteps(companyId)).toBe(true);
  expect(
    requests.transition(companyId, "create_provider", "pending", "confirmed", {
      providerRef: `doola-${companyId}`,
    }),
  ).toBe(true);
  const filing = opts.filing ?? "confirmed";
  if (filing === "none") return companyId;
  expect(requests.transition(companyId, "await_filing", "pending", filing)).toBe(true);
  s.companies.recordFilingFacts(companyId, {
    filedAt: FILED_AT,
    filingNumber: opts.filingNumber === undefined ? FILING_NUMBER : opts.filingNumber,
    legalNameFiled: opts.legalNameFiled === undefined ? FILED_NAME : opts.legalNameFiled,
  });
  return companyId;
}

/** A company the tenant declared, with the checks given (one pass unless told otherwise). */
function declaredCompany(opts: { checks?: CompanyCheckResult[]; filingNumber?: string } = {}) {
  return customerCompany(s, tenant, { humanNullifier: "3101", ...opts });
}

function refusalOf(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("no refusal");
}

/** The agreement an order for `names` must carry: built from the same fields `createOrder` uses. */
function expectedAgreement(names: { legalName: string; filingNumber: string }) {
  return buildAgreement(
    {
      companyName: names.legalName,
      filingNumber: names.filingNumber,
      jurisdiction: "WY",
      guardian: tenant,
      amendmentDelaySeconds: 172_800,
      chainId: CHAIN_ID,
      factory: FACTORY,
      identityRegistry: REGISTRY,
    },
    LEGAL_BODY_OPERATING_AGREEMENT,
  );
}

const rowCount = (): number =>
  (s.db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get() as { n: number }).n;

describe("a company formed for a legal body", () => {
  test("filed, with its filed name and number on the row: eligible, and its agreement prints both as the row holds them", () => {
    const deps = orderDeps();
    const companyId = formedCompany();

    // The rule reads only the companies, the checks and the formation steps.
    const narrow = {
      companies: deps.companies,
      checks: deps.checks,
      formationSteps: deps.formationSteps,
    };
    expect(companyEligible(narrow, companyId)).toBe(true);
    expect(companyNamesForOrder(deps, companyId)).toEqual({
      legalName: FILED_NAME,
      filingNumber: FILING_NUMBER,
    });

    const view = createOrder(deps, tenant, { companyId });
    expect(view.state).toBe("draft");
    expect(view.companyId).toBe(companyId);

    const expected = expectedAgreement({ legalName: FILED_NAME, filingNumber: FILING_NUMBER });
    expect(view.agreement).toEqual({ hash: expected.manifestHash, version: 1 });
    const terms = s.docStore.get(agreementDocNames(view.id).terms);
    expect(terms).toBe(expected.termsDoc);
    expect(terms).toContain(`# Operating Agreement of "${FILED_NAME}"`);
    expect(terms).toContain(`with filing number "${FILING_NUMBER}"`);
  });

  test("not yet filed by the state: not eligible, whatever facts the row already carries", () => {
    const deps = orderDeps();
    const cases = {
      pendingWithNoFacts: formedCompany({ filing: "none" }),
      submittedWithFacts: formedCompany({ filing: "submitted" }),
    };
    for (const [name, companyId] of Object.entries(cases)) {
      expect(companyEligible(deps, companyId), name).toBe(false);
      const err = refusalOf(() => createOrder(deps, tenant, { companyId }));
      expect(err.code, name).toBe("company_not_eligible");
      expect(err.status, name).toBe(409);
      expect(err.message, name).toBe(LEGAL_BODY_SENTENCES.company_not_eligible);
    }
    expect(rowCount()).toBe(0);
  });

  test("filed, but the row lacks its filed name or its filing number: not eligible, and no names", () => {
    const deps = orderDeps();
    const cases = {
      // The processor writes no name when doola's reported name matches none of the options.
      noFiledName: formedCompany({ legalNameFiled: null }),
      noFilingNumber: formedCompany({ filingNumber: null }),
    };
    for (const [name, companyId] of Object.entries(cases)) {
      expect(companyEligible(deps, companyId), name).toBe(false);
      expect(companyNamesForOrder(deps, companyId), name).toBeNull();
      const err = refusalOf(() => createOrder(deps, tenant, { companyId }));
      expect(err.code, name).toBe("company_not_eligible");
      expect(err.status, name).toBe(409);
    }
    expect(rowCount()).toBe(0);
  });

  test("a filed name or number the agreement cannot print as it stands: 409 company_name_unusable, and nothing is written", () => {
    const deps = orderDeps();
    const cases = {
      doubleQuote: formedCompany({ legalNameFiled: 'Lantern "Works"' }),
      placeholder: formedCompany({ legalNameFiled: "Lantern {guardian} Works" }),
      curlyQuote: formedCompany({ legalNameFiled: "Lantern “Works”" }),
      control: formedCompany({ legalNameFiled: "Lantern​Works" }),
      accented: formedCompany({ legalNameFiled: "Lantern Café" }),
      doubleSpace: formedCompany({ legalNameFiled: "Lantern  Works" }),
      numberWithQuote: formedCompany({ filingNumber: '2026-"451207"' }),
    };
    for (const [name, companyId] of Object.entries(cases)) {
      // Eligible: the state filed it and the row carries both facts. Only their text is wrong.
      expect(companyEligible(deps, companyId), name).toBe(true);
      const err = refusalOf(() => createOrder(deps, tenant, { companyId }));
      expect(err.code, name).toBe("company_name_unusable");
      expect(err.status, name).toBe(409);
      expect(err.message, name).toBe(
        "The filed company name or filing number cannot be printed in the agreement as it stands: an operator must set it.",
      );
      expect(err.message, name).toBe(LEGAL_BODY_SENTENCES.company_name_unusable);
    }
    expect(rowCount()).toBe(0);
    expect(s.docStore.files.size).toBe(0);
  });

  test("abandoned: not eligible", () => {
    const deps = orderDeps();
    const companyId = formedCompany();
    expect(s.companies.setStatus(companyId, "ready", "abandoned")).toBe(true);
    expect(companyEligible(deps, companyId)).toBe(false);
    expect(refusalOf(() => createOrder(deps, tenant, { companyId })).code).toBe(
      "company_not_eligible",
    );
  });
});

describe("a company formed for agents", () => {
  test("filed, with both facts: never eligible", () => {
    const deps = orderDeps();
    const companyId = formedCompany({ purposeKind: "agent" });
    expect(companyEligible(deps, companyId)).toBe(false);
    const err = refusalOf(() => createOrder(deps, tenant, { companyId }));
    expect(err.code).toBe("company_not_eligible");
    expect(err.status).toBe(409);
    expect(rowCount()).toBe(0);
  });
});

describe("a declared company, as before", () => {
  test("eligible on a passed check, its formation steps never read, and its agreement prints the declared names", () => {
    const steps: string[] = [];
    const deps = orderDeps({
      formationSteps: (companyId) => {
        steps.push(companyId);
        return [];
      },
    });
    const companyId = declaredCompany();
    expect(companyEligible(deps, companyId)).toBe(true);
    expect(companyNamesForOrder(deps, companyId)).toEqual({
      legalName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
    });
    const view = createOrder(deps, tenant, { companyId });
    expect(view.agreement?.hash).toBe(
      expectedAgreement({ legalName: "Example Holdings LLC", filingNumber: "TEST-0001" })
        .manifestHash,
    );
    expect(steps).toEqual([]);
  });

  test("not checked: not eligible, and no names", () => {
    const deps = orderDeps();
    const companyId = declaredCompany({ checks: [], filingNumber: "TEST-0002" });
    expect(companyEligible(deps, companyId)).toBe(false);
    expect(companyNamesForOrder(deps, companyId)).toBeNull();
  });
});
