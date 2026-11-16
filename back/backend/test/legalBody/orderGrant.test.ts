/**
 * An order on the Charter takes the guardian's grant: the grant is held to the form's rules and to
 * what the product offers, written into the Charter's Schedule A, and kept beside the order, all in
 * the order's one transaction. Where the agreement takes no grant, a grant is refused, and an order
 * without one is placed as before. On either pair, a company the guardian declared is ordered only
 * when it was declared under the pair's declaration.
 *
 * The database is real (in memory). Every amount and date here is a made-up fixture; every name,
 * company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import type Database from "better-sqlite3";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiError } from "../../src/errors";
import { companyNameOptions } from "../../src/formation/intake";
import { readVerifiedAgreement } from "../../src/legalBody/agreement";
import { CUSTOMER_COMPANY_PLACEHOLDER } from "../../src/legalBody/customerCompany";
import { buildGrant } from "../../src/legalBody/grant";
import { GRANT_HEAVY_MODES_OFFERED, grantOfferProblems } from "../../src/legalBody/orderGrant";
import {
  type LegalBodyOrderDeps,
  type LegalBodyOrderView,
  createOrder,
} from "../../src/legalBody/orders";
import { CUSTOMER_PROVIDER } from "../../src/legalBody/provider";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import type { FieldProblem } from "../../src/legalBody/textRules";
import { CHARTER_LEGAL_TEXTS } from "../../src/legalBody/texts/sets";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { ANVIL_ACCOUNT_2, recordHuman } from "../helpers/customerCompanyFixtures";
import { seedCompany } from "../helpers/formationFakes";
import { A, B } from "../helpers/grantFixtures";
import {
  type LegalBodyStores,
  appendCheck,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

const guardian: Address = ANVIL_ACCOUNT_2.address;
/** A fixed moment, 12:00 UTC on 14 November 2026, for the tests that read the day. */
const NOON_14_NOVEMBER = Date.UTC(2026, 10, 14, 12);

const grantA = buildGrant(A, { number: 1, version: 1 });
/** Fixture `B` with every line not allowed: no kind of section 5.2 and no act of section 5.6. */
const none = structuredClone(B);
none.acts.provideServices = { allowed: false };
none.acts.pay = { allowed: false };
none.heavyActs.employ = { mode: "not_allowed" };
none.heavyActs.borrow = { mode: "not_allowed" };
none.heavyActs.guarantee = { mode: "not_allowed" };
none.heavyActs.transferProperty = { mode: "not_allowed" };

let db: Database.Database;
let s: LegalBodyStores;
let filings = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  recordHuman(s.store, guardian, "3001", Date.now());
});
afterEach(() => db.close());

/** The order deps of a sandbox deployment that serves the Charter pair. */
const charterDeps = (over: Partial<LegalBodyOrderDeps> = {}) =>
  legalBodyOrderDeps(s, { texts: CHARTER_LEGAL_TEXTS, ...over });

/** A checked company of the guardian, with a filing number no other company of the test holds. */
const company = (opts: Parameters<typeof customerCompany>[2] = {}) =>
  customerCompany(s, guardian, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
    ...opts,
  });

/** The `ApiError` `run` throws. Any other throw, or none, fails the test. */
function refusedWith(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("no refusal");
}

/** What a client reads of a refusal. */
const answerOf = (err: ApiError) => ({
  code: err.code,
  status: err.status,
  message: err.message,
  details: err.details,
});

/** The refusal of a grant the order does not take, with its problems. */
const notValid = (details: FieldProblem[]) => ({
  code: "grant_not_valid",
  status: 400,
  message: LEGAL_BODY_SENTENCES.grant_not_valid,
  details,
});

/** The grant rows the database holds, for every order. */
const grantRows = () => db.prepare("SELECT COUNT(*) AS n FROM charter_grants").get();
/** The order rows the database holds, for every tenant. */
const orderRows = () => db.prepare("SELECT COUNT(*) AS n FROM legal_bodies").get();

/** The order's stored agreement, re-verified. */
function storedTermsOf(view: LegalBodyOrderView) {
  if (view.agreement === null) throw new Error(`order ${view.id} has no agreement`);
  const verified = readVerifiedAgreement(s.docStore, view.id, view.agreement.hash);
  if (verified === undefined) throw new Error(`order ${view.id}: unreadable agreement`);
  return verified;
}

describe("an order on the Charter", () => {
  test("an order on the Charter freezes a Charter that states its grant, and keeps the grant", () => {
    const view = createOrder(charterDeps(), guardian, {
      companyId: company({ wordingVersion: "2026-11-draft-2" }),
      grant: structuredClone(A),
    });
    expect(view.state).toBe("draft");
    expect(view.agreement).not.toBeNull();

    const stored = storedTermsOf(view);
    expect(stored.terms.textVersion).toBe("2026-11-draft-5");
    expect(stored.termsDoc).toContain(
      `## Schedule A. Grants in force\n\n${grantA.scheduleA}\n\n## Schedule B.`,
    );

    expect(s.grants.list(view.id)).toEqual([
      {
        legalBodyId: view.id,
        number: 1,
        version: 1,
        canonical: grantA.canonical,
        digest: "0xb88cefedad48bffc885596dc29fb3c8f935774498147ed74e48395e110eb4dc1",
        wording: "2026-11-draft-4",
        createdAt: expect.any(String),
      },
    ]);

    const october = createOrder(legalBodyOrderDeps(s), guardian, { companyId: company() });
    expect(Object.keys(view)).toEqual(Object.keys(october));
  });

  test("an order on the Charter with no grant is refused, and nothing is written", () => {
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
      }),
    );
    expect(answerOf(err)).toEqual(notValid([{ field: "grant", problem: "must be an object" }]));
    expect(s.repo.listByTenant(guardian)).toEqual([]);
    expect(grantRows()).toEqual({ n: 0 });
    expect(s.docStore.files.size).toBe(0);
  });

  test("choices that allow nothing are refused", () => {
    // On a fixed day, so the end day of fixture B stays after today.
    const deps = charterDeps({ now: () => NOON_14_NOVEMBER });
    const err = refusedWith(() =>
      createOrder(deps, guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: structuredClone(none),
      }),
    );
    expect(answerOf(err)).toEqual(
      notValid([{ field: "grant", problem: "must allow at least one act" }]),
    );
    expect(grantRows()).toEqual({ n: 0 });
  });

  test.each([["employ"], ["transferProperty"]] as const)(
    "a heavy act the product does not leave to the agent alone is refused: %s",
    (act) => {
      const choices = structuredClone(A);
      choices.heavyActs[act] = { mode: "alone", perAct: 100 };
      const err = refusedWith(() =>
        createOrder(charterDeps(), guardian, {
          companyId: company({ wordingVersion: "2026-11-draft-2" }),
          grant: choices,
        }),
      );
      expect(answerOf(err)).toEqual(
        notValid([
          { field: `heavyActs.${act}.mode`, problem: "must be not_allowed or guardian_signature" },
        ]),
      );
    },
  );

  test.each([["borrow"], ["guarantee"]] as const)(
    "a heavy act the product leaves to the agent alone is taken: %s",
    (act) => {
      const choices = structuredClone(A);
      choices.heavyActs[act] = { mode: "alone", perAct: 100 };
      const view = createOrder(charterDeps(), guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: choices,
      });
      expect(view.state).toBe("draft");
      expect(s.grants.list(view.id)).toHaveLength(1);
    },
  );

  test("a shape problem is reported before the product's rules, and alone", () => {
    const raw = {
      ...structuredClone(A),
      acts: { ...structuredClone(A.acts), buy: { ...A.acts.buy, perAct: "200" } },
      heavyActs: { ...structuredClone(A.heavyActs), employ: { mode: "alone", perAct: 100 } },
    };
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: raw,
      }),
    );
    expect(answerOf(err)).toEqual(
      notValid([
        {
          field: "acts.buy.perAct",
          problem: "must be a whole number of US dollars from 1 to 1,000,000,000",
        },
      ]),
    );
  });

  test("two acts the product does not offer alone are both named", () => {
    const choices = structuredClone(A);
    choices.heavyActs.transferProperty = { mode: "alone", perAct: 100 };
    choices.heavyActs.employ = { mode: "alone", perAct: 100 };
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: choices,
      }),
    );
    expect(answerOf(err)).toEqual(
      notValid([
        { field: "heavyActs.employ.mode", problem: "must be not_allowed or guardian_signature" },
        {
          field: "heavyActs.transferProperty.mode",
          problem: "must be not_allowed or guardian_signature",
        },
      ]),
    );
  });

  test("an end today is refused at the order", () => {
    const deps = charterDeps({ now: () => NOON_14_NOVEMBER });
    const err = refusedWith(() =>
      createOrder(deps, guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: { ...structuredClone(A), endsOn: "2026-11-14" },
      }),
    );
    expect(answerOf(err)).toEqual(
      notValid([{ field: "endsOn", problem: "must be after today (UTC)" }]),
    );

    const view = createOrder(deps, guardian, {
      companyId: company({ wordingVersion: "2026-11-draft-2" }),
      grant: { ...structuredClone(A), endsOn: "2026-11-15" },
    });
    expect(view.state).toBe("draft");
    expect(s.grants.list(view.id)).toHaveLength(1);
  });

  test("a hostile grant is answered with at most 21 problems", () => {
    const raw: Record<string, unknown> = structuredClone(A);
    for (let i = 0; i < 50; i++) raw[`unknown${i}`] = i;
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: raw,
      }),
    );
    expect(err.code).toBe("grant_not_valid");
    expect(err.details).toHaveLength(21);
  });
});

describe("where the agreement takes no grant", () => {
  test("on the October pair a grant is refused, and an order without one is placed as before", () => {
    const deps = legalBodyOrderDeps(s);
    const companyId = company();
    for (const grant of [structuredClone(A), null]) {
      const err = refusedWith(() => createOrder(deps, guardian, { companyId, grant }));
      expect(answerOf(err)).toEqual({
        code: "grant_not_taken",
        status: 400,
        message: LEGAL_BODY_SENTENCES.grant_not_taken,
        details: undefined,
      });
    }
    expect(s.repo.listByTenant(guardian)).toEqual([]);

    const view = createOrder(deps, guardian, { companyId });
    expect(view.state).toBe("draft");
    expect(storedTermsOf(view).terms.textVersion).toBe("2026-10-draft-1");
    expect(grantRows()).toEqual({ n: 0 });
  });
});

describe("when the grant is read", () => {
  test("the grant is read only for a caller who could order", () => {
    for (const deps of [charterDeps(), legalBodyOrderDeps(s)]) {
      expect(
        refusedWith(() => createOrder(deps, guardian, { companyId: "co_unknown", grant: "x" })),
      ).toMatchObject({ code: "not_found", status: 404 });
      const failed = company({ checks: ["failed"] });
      expect(
        refusedWith(() => createOrder(deps, guardian, { companyId: failed, grant: "x" })),
      ).toMatchObject({ code: "company_not_eligible", status: 409 });
    }
  });

  test("a refusal inside the transaction leaves no grant", () => {
    const err = refusedWith(() =>
      createOrder(charterDeps({ maxOpenPerTenant: 0 }), guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: structuredClone(A),
      }),
    );
    expect(err).toMatchObject({ code: "legal_body_cap", status: 409 });
    expect(grantRows()).toEqual({ n: 0 });
  });

  test("a throw once the grant is written rolls back the row, its frozen agreement and the grant together", () => {
    const failing = new Error("the step after the grant failed");
    const deps = charterDeps({
      grants: {
        insert: (legalBodyId, grant) => {
          s.grants.insert(legalBodyId, grant);
          // The grant is written inside the order's transaction, so the row is there to read.
          expect(s.grants.list(legalBodyId)).toHaveLength(1);
          throw failing;
        },
        list: (legalBodyId) => s.grants.list(legalBodyId),
      },
    });
    expect(() =>
      createOrder(deps, guardian, {
        companyId: company({ wordingVersion: "2026-11-draft-2" }),
        grant: structuredClone(A),
      }),
    ).toThrow(failing);
    expect(s.repo.listByTenant(guardian)).toEqual([]);
    expect(grantRows()).toEqual({ n: 0 });
  });
});

describe("the declaration of a declared company", () => {
  /** The refusal of a company declared under another wording than the pair's declaration. */
  const outdated = {
    code: "declaration_outdated",
    status: 409,
    message: LEGAL_BODY_SENTENCES.declaration_outdated,
    details: undefined,
  };

  test("a company declared under the pair's declaration is ordered on the Charter", () => {
    const view = createOrder(charterDeps(), guardian, {
      companyId: company({ wordingVersion: "2026-11-draft-2" }),
      grant: structuredClone(A),
    });
    expect(view.state).toBe("draft");
    expect(storedTermsOf(view).terms.textVersion).toBe("2026-11-draft-5");
    expect(s.grants.list(view.id)).toHaveLength(1);
  });

  test("a company declared under another wording is refused, and nothing is written", () => {
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, { companyId: company(), grant: structuredClone(A) }),
    );
    expect(answerOf(err)).toEqual(outdated);
    expect(orderRows()).toEqual({ n: 0 });
    expect(grantRows()).toEqual({ n: 0 });
    expect(s.docStore.files.size).toBe(0);
  });

  test("the declaration is read before the grant", () => {
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, { companyId: company(), grant: "x" }),
    );
    expect(answerOf(err)).toEqual(outdated);

    // The same grant, for a company declared under the pair's declaration, is the grant's refusal.
    const declared = company({ wordingVersion: "2026-11-draft-2" });
    expect(
      refusedWith(() => createOrder(charterDeps(), guardian, { companyId: declared, grant: "x" })),
    ).toMatchObject({ code: "grant_not_valid", status: 400 });
  });

  test("eligibility is read before the declaration", () => {
    const err = refusedWith(() =>
      createOrder(charterDeps(), guardian, {
        companyId: company({ checks: ["failed"] }),
        grant: structuredClone(A),
      }),
    );
    expect(err).toMatchObject({ code: "company_not_eligible", status: 409 });
  });

  test("a customer's company with no declaration is not eligible, on either pair", () => {
    const companyId = s.companies.create({
      tenantId: guardian,
      status: "ready",
      provider: CUSTOMER_PROVIDER,
      environment: "sandbox",
      synthetic: true,
      nameOptions: [{ name: "Example Holdings LLC", entityTypeEnding: "", position: 1 }],
      businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
      industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
      intakeSynthesized: false,
      purposeKind: "legal_body",
    });
    appendCheck(s.checks, companyId, "passed");
    expect(s.declarations.find(companyId)).toBeUndefined();

    const onOctober = refusedWith(() =>
      createOrder(legalBodyOrderDeps(s), guardian, { companyId }),
    );
    const onCharter = refusedWith(() =>
      createOrder(charterDeps(), guardian, { companyId, grant: structuredClone(A) }),
    );
    for (const err of [onOctober, onCharter])
      expect(err).toMatchObject({ code: "company_not_eligible", status: 409 });
    expect(orderRows()).toEqual({ n: 0 });
  });

  test("the rule is the same on the October pair", () => {
    const deps = legalBodyOrderDeps(s);
    const err = refusedWith(() =>
      createOrder(deps, guardian, { companyId: company({ wordingVersion: "2026-11-draft-2" }) }),
    );
    expect(answerOf(err)).toEqual(outdated);
    expect(orderRows()).toEqual({ n: 0 });

    const view = createOrder(deps, guardian, { companyId: company() });
    expect(view.state).toBe("draft");
    expect(storedTermsOf(view).terms.textVersion).toBe("2026-10-draft-1");
  });

  test("a company filed through formation has no declaration to compare", () => {
    // Formed for the guardian, its formation steps opened, the provider's step confirmed and the
    // filing confirmed with the facts the processor writes then.
    const requests = new SqliteFormationRepository(db);
    const companyId = seedCompany(s.companies, {
      companyId: "formed-1",
      tenantId: guardian,
      purposeKind: "legal_body",
      nameOptions: companyNameOptions("Lantern Works LLC"),
      businessPurpose: "Software services.",
    });
    expect(requests.claimAllSteps(companyId)).toBe(true);
    expect(
      requests.transition(companyId, "create_provider", "pending", "confirmed", {
        providerRef: `ref-${companyId}`,
      }),
    ).toBe(true);
    expect(requests.transition(companyId, "await_filing", "pending", "confirmed")).toBe(true);
    s.companies.recordFilingFacts(companyId, {
      filedAt: 1_793_664_000,
      filingNumber: "2026-000451207",
      legalNameFiled: "Lantern Works LLC",
    });
    expect(s.declarations.find(companyId)).toBeUndefined();

    const view = createOrder(legalBodyOrderDeps(s), guardian, { companyId });
    expect(view.state).toBe("draft");
    expect(view.companyName).toBe("Lantern Works LLC");
  });
});

describe("what the product offers", () => {
  test("what the product offers", () => {
    expect(GRANT_HEAVY_MODES_OFFERED).toEqual({
      employ: ["not_allowed", "guardian_signature"],
      borrow: ["not_allowed", "guardian_signature", "alone"],
      guarantee: ["not_allowed", "guardian_signature", "alone"],
      transferProperty: ["not_allowed", "guardian_signature"],
    });
    expect(grantOfferProblems(A)).toEqual([]);
  });
});
