/**
 * The tenant abandons its own formed legal-body company before anything reached doola.
 *
 * `abandonFormedCompany`, in one transaction: the company must be the tenant's (else 404, one
 * answer for unknown and not-yours), formed for a legal body, and `draft` or `ready`; a filing
 * being sent (`create_provider` `submitted`) is refused until it settles; a filing that has
 * started (a `confirmed` step, a provider ref, or a company body sent under the live key with its
 * answer lost) is refused for good; a payment being settled is refused until it settles. Else
 * every formation row moves to `abandoned`, a live `quoted` quote is expired, the company moves to
 * `abandoned` (its `updated_at` stamped), the party is erased, and one ops line names the company
 * and whether a settled payment stays to be refunded. A settled payment stays `settled`: the
 * operator records its refund with `formation:refund`.
 *
 * The database is real (in memory). Every name, address and id is an invention.
 */
import type DatabaseType from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/api/errors";
import { abandonFormedCompany } from "../../src/formation/abandonFormed";
import {
  type CreateCompanyDeps,
  type CreateCompanyResult,
  createCompany,
} from "../../src/formation/company";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import {
  type CompanyPurposeKind,
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import {
  type FormationStep,
  SqliteFormationRepository,
} from "../../src/persistence/formationRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { Hex } from "../../src/types";
import { abandonFormation } from "../../src/workflow/formationStep";
import { ACTION, recordHuman, worldFor } from "../helpers/customerCompanyFixtures";
import { paymentCfg } from "../helpers/formationPayment";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const TENANT = getAddress("0x00000000000000000000000000000000000000e1");
const OTHER = getAddress("0x00000000000000000000000000000000000000e2");
const OLD = "2026-01-01 00:00:00";

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;
let payment: FormationPaymentConfig;
/** Every console line written in the test. */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  payment = paymentCfg(payments);
  printed = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

type AbandonDeps = Parameters<typeof abandonFormedCompany>[0];

function deps(over: Partial<AbandonDeps> = {}): AbandonDeps {
  const base: Pick<
    CreateCompanyDeps,
    "companies" | "parties" | "requests" | "payment" | "transaction"
  > = {
    companies,
    parties,
    requests,
    payment,
    transaction: (fn) => db.transaction(fn)(),
  };
  return { ...base, ...over };
}

/** A company of `tenantId` with its party bound: formed for a legal body unless told otherwise.
 *  Its `updated_at` is set in the past, so a stamp is seen to move. */
function company(
  opts: {
    status?: CompanyStatus;
    tenantId?: string;
    provider?: string;
    purposeKind?: CompanyPurposeKind;
  } = {},
): { companyId: string; partyId: string } {
  const tenantId = opts.tenantId ?? TENANT;
  const partyId = parties.create({
    tenantId,
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
    marketingConsentAt: NOW - 1000,
  });
  const companyId = companies.create({
    tenantId,
    status: opts.status ?? "ready",
    provider: opts.provider ?? "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Example Works", "Example Labs", "Example Studio"),
    businessPurpose: "Operating software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: opts.purposeKind ?? "legal_body",
  });
  expect(parties.bindToCompany(partyId, companyId, tenantId)).toBe(true);
  db.prepare("UPDATE companies SET updated_at = ? WHERE company_id = ?").run(OLD, companyId);
  return { companyId, partyId };
}

let nonce = 0;
/** A `quoted` formation payment for the company; `settling` or `settled` when asked. */
function paymentFor(companyId: string, status: "quoted" | "settling" | "settled"): string {
  nonce += 1;
  const paymentId = payments.create({
    companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce: `0x${nonce.toString(16).padStart(64, "0")}` as Hex,
    validBefore: Math.floor(NOW / 1000) + 1800,
    payTo: payment.revenueAddress,
  });
  if (status === "quoted") return paymentId;
  expect(
    payments.markSettling(paymentId, {
      payerAddress: TENANT,
      signature: `0x${"11".repeat(65)}`,
    }),
  ).toBe(true);
  if (status === "settled")
    expect(payments.markSettled(paymentId, `0x${"cc".repeat(32)}`)).toBe(true);
  return paymentId;
}

/** The formation rows opened (all four `pending`), then `create_provider` shaped by `shape`. */
function stepsOpened(
  companyId: string,
  shape?:
    | "rejected"
    | "submitted"
    | "provider_ref"
    | "await_filing_confirmed"
    | "answer_lost"
    | "unreadable",
): void {
  requests.claimAllSteps(companyId);
  const attempt = requests.find(companyId, "create_provider")!.attempt;
  switch (shape) {
    case undefined:
      return;
    case "rejected":
      // doola looked at the company body and refused it (a name the state refused): the attempt
      // is burned, so the body sent sits under a key that is no longer live.
      expect(requests.bumpAttempt(companyId, "create_provider", "pending")).toBe(attempt + 1);
      expect(
        requests.transition(companyId, "create_provider", "pending", "failed", {
          detail: JSON.stringify({
            customerId: "cus-example",
            companySentAttempt: attempt,
            awaitingIntakeEdit: true,
          }),
          error: "E_VALIDATION_FAILED: the name was refused",
        }),
      ).toBe(true);
      return;
    case "submitted":
      expect(requests.transition(companyId, "create_provider", "pending", "submitted")).toBe(true);
      return;
    case "provider_ref":
      expect(
        requests.transition(companyId, "create_provider", "pending", "failed", {
          providerRef: "doola-company-example",
          error: "E_TIMEOUT",
        }),
      ).toBe(true);
      return;
    case "await_filing_confirmed":
      expect(requests.transition(companyId, "await_filing", "pending", "confirmed")).toBe(true);
      return;
    case "answer_lost":
      // The company body went out under the live key and no usable answer came back: the create
      // may have committed at doola.
      expect(
        requests.transition(companyId, "create_provider", "pending", "failed", {
          detail: JSON.stringify({ customerId: "cus-example", companySentAttempt: attempt }),
          error: "doola createCompany gave no usable answer",
        }),
      ).toBe(true);
      return;
    case "unreadable":
      db.prepare(
        "UPDATE formation_requests SET detail = '{oops' WHERE company_id = ? AND step = 'create_provider'",
      ).run(companyId);
      return;
  }
}

/** Everything the abandon could move for one company, as it stands. */
function snapshot(companyId: string) {
  return {
    company: db
      .prepare("SELECT status, updated_at FROM companies WHERE company_id = ?")
      .get(companyId),
    steps: db
      .prepare(
        "SELECT step, state, error, attempt FROM formation_requests WHERE company_id = ? ORDER BY step",
      )
      .all(companyId),
    payments: db
      .prepare(
        "SELECT payment_id, status FROM formation_payments WHERE company_id = ? ORDER BY payment_id",
      )
      .all(companyId),
    party: db
      .prepare(
        "SELECT legal_first_name, email, deleted_at FROM formation_parties WHERE company_id = ?",
      )
      .get(companyId),
  };
}

/** The ApiError a call throws, or null when it returns. */
function thrown(fn: () => unknown): ApiError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
}

/** A refusal that moved nothing: the error, and the company exactly as it stood. */
function refusedWithNothingMoved(
  companyId: string,
  expected: { code: string; status: number; message?: string },
): void {
  const before = snapshot(companyId);
  expect(thrown(() => abandonFormedCompany(deps(), TENANT, companyId))).toMatchObject(expected);
  expect(snapshot(companyId)).toEqual(before);
  expect(abandonLines()).toHaveLength(0);
}

/** The ops event a printed line carries, if it is an ops line. */
function opslogOf(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as { opslog?: unknown };
    return typeof parsed.opslog === "string" ? parsed.opslog : undefined;
  } catch {
    return undefined;
  }
}

const abandonLines = (): string[] =>
  printed.filter((line) => opslogOf(line) === "formation_abandoned_by_tenant");

/** The company's party row as stored, erased or not. */
const partyRow = (partyId: string) =>
  db.prepare("SELECT * FROM formation_parties WHERE party_id = ?").get(partyId) as Record<
    string,
    unknown
  >;

/** The party erased: every personal column NULL, the handle, the owner and the dates kept. */
function erased(partyId: string, companyId: string): void {
  const row = partyRow(partyId);
  for (const col of [
    "legal_first_name",
    "legal_last_name",
    "email",
    "phone",
    "line1",
    "line2",
    "city",
    "region",
    "postal_code",
    "country",
    "ssn_ciphertext",
    "marketing_consent_at",
  ])
    expect(row[col], col).toBeNull();
  expect(row.deleted_at).toBeTruthy();
  expect(row.tenant_id).toBe(TENANT);
  expect(parties.findByCompanyId(companyId)).toBeUndefined();
}

const stepStates = (companyId: string) =>
  Object.fromEntries(
    requests.stepsOf(companyId).map((r) => [r.step, [r.state, r.error]]),
  ) as Record<FormationStep, [string, string | null]>;

const CONFLICT = { code: "conflict", status: 409 };
const BEING_SENT = { ...CONFLICT, message: "the filing is being sent: try again in a minute" };
const STARTED = {
  ...CONFLICT,
  message: "the filing has started: no refund and no abandon; write to us",
};
const SETTLING = { ...CONFLICT, message: "a payment is being settled: try again in a minute" };

// ── what an abandon does ───────────────────────────────────────────────────────────────────────

describe("a formed company abandoned before doola", () => {
  test("a ready company with no step: abandoned, its party erased, both counts down by one, updated_at moved", () => {
    const { companyId, partyId } = company();
    const tenantBefore = companies.countChargeableByTenant(TENANT);
    const formedBefore = companies.countChargeableFormedLegalBodies();
    expect([tenantBefore, formedBefore]).toEqual([1, 1]);

    abandonFormedCompany(deps(), TENANT, companyId);

    expect(companies.find(companyId)).toMatchObject({ status: "abandoned" });
    expect(companies.find(companyId)!.updatedAt).not.toBe(OLD);
    expect(requests.stepsOf(companyId)).toEqual([]);
    erased(partyId, companyId);
    expect(companies.countChargeableByTenant(TENANT)).toBe(tenantBefore - 1);
    expect(companies.countChargeableFormedLegalBodies()).toBe(formedBefore - 1);
  });

  test("a draft with a live quote: the quote is expired, and the company leaves both counts", () => {
    const { companyId, partyId } = company({ status: "draft" });
    const paymentId = paymentFor(companyId, "quoted");
    expect(companies.countChargeableFormedLegalBodies()).toBe(1);

    abandonFormedCompany(deps(), TENANT, companyId);

    expect(payments.find(paymentId)!.status).toBe("expired");
    expect(companies.find(companyId)!.status).toBe("abandoned");
    erased(partyId, companyId);
    expect(companies.countChargeableByTenant(TENANT)).toBe(0);
    expect(companies.countChargeableFormedLegalBodies()).toBe(0);
  });

  test("a create doola refused, with no ref: every row moves to abandoned with tenant_abandoned", () => {
    const { companyId, partyId } = company();
    paymentFor(companyId, "settled");
    stepsOpened(companyId, "rejected");

    abandonFormedCompany(deps(), TENANT, companyId);

    expect(stepStates(companyId)).toEqual({
      create_provider: ["abandoned", "tenant_abandoned"],
      await_filing: ["abandoned", "tenant_abandoned"],
      fetch_documents: ["abandoned", "tenant_abandoned"],
      await_ein: ["abandoned", "tenant_abandoned"],
    });
    expect(companies.find(companyId)!.status).toBe("abandoned");
    erased(partyId, companyId);
  });

  test("a settled payment stays settled, and the one ops line says so with ids only", () => {
    const { companyId } = company();
    const paymentId = paymentFor(companyId, "settled");

    abandonFormedCompany(deps(), TENANT, companyId);

    expect(payments.find(paymentId)!.status).toBe("settled");
    const lines = abandonLines();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(["at", "companyId", "hadSettledPayment", "opslog"]);
    expect(line).toMatchObject({ companyId, hadSettledPayment: true });
    // No person in any line the abandon printed: no name, email, address or tenant.
    for (const personal of ["Ada", "Example Way", "person@example.com", "Cheyenne", TENANT])
      for (const printedLine of printed) expect(printedLine, personal).not.toContain(personal);
  });

  test("with nothing paid, the ops line says hadSettledPayment false", () => {
    const { companyId } = company();
    abandonFormedCompany(deps(), TENANT, companyId);
    expect(JSON.parse(abandonLines()[0] as string)).toMatchObject({
      companyId,
      hadSettledPayment: false,
    });
  });
});

// ── what an abandon refuses ────────────────────────────────────────────────────────────────────

describe("an abandon refused, with nothing moved", () => {
  test("a create being sent (submitted) is refused until it settles", () => {
    const { companyId } = company();
    stepsOpened(companyId, "submitted");
    refusedWithNothingMoved(companyId, BEING_SENT);
  });

  test("a step holding a provider ref is refused: the filing has started", () => {
    const { companyId } = company();
    stepsOpened(companyId, "provider_ref");
    refusedWithNothingMoved(companyId, STARTED);
  });

  test("a confirmed step is refused: the filing has started", () => {
    const { companyId } = company();
    stepsOpened(companyId, "await_filing_confirmed");
    refusedWithNothingMoved(companyId, STARTED);
  });

  test("a company body sent under the live key whose answer was lost is refused: it may be filed", () => {
    const { companyId } = company();
    stepsOpened(companyId, "answer_lost");
    refusedWithNothingMoved(companyId, STARTED);
  });

  test("an unreadable create row is refused: nothing proves the filing did not start", () => {
    const { companyId } = company();
    stepsOpened(companyId, "unreadable");
    refusedWithNothingMoved(companyId, STARTED);
  });

  test("a payment being settled is refused until it settles, and the payment stays settling", () => {
    const { companyId } = company({ status: "draft" });
    const paymentId = paymentFor(companyId, "settling");
    refusedWithNothingMoved(companyId, SETTLING);
    expect(payments.find(paymentId)!.status).toBe("settling");
  });

  test("an unknown company and another tenant's get one 404", () => {
    const theirs = company({ tenantId: OTHER });
    const unknown = thrown(() =>
      abandonFormedCompany(deps(), TENANT, "00000000-0000-4000-8000-000000000000"),
    );
    const foreign = thrown(() => abandonFormedCompany(deps(), TENANT, theirs.companyId));
    expect(unknown).toMatchObject({ code: "not_found", status: 404 });
    expect(foreign).toMatchObject({ code: "not_found", status: 404 });
    expect(foreign!.message).toBe(unknown!.message);
    expect(companies.find(theirs.companyId)!.status).toBe("ready");
  });

  test("an abandoned company is refused 409, and a second abandon moves nothing", () => {
    const { companyId } = company();
    abandonFormedCompany(deps(), TENANT, companyId);
    printed.length = 0;
    refusedWithNothingMoved(companyId, CONFLICT);
  });

  test("a company for agents, and a customer's own company, are not this function's", () => {
    for (const other of [
      company({ purposeKind: "agent" }),
      company({ provider: "customer", purposeKind: "legal_body" }),
    ])
      refusedWithNothingMoved(other.companyId, CONFLICT);
  });

  test("a failure inside the transaction rolls every write back", () => {
    const { companyId } = company({ status: "draft" });
    paymentFor(companyId, "quoted");
    stepsOpened(companyId);
    const before = snapshot(companyId);
    const failing = {
      ...parties,
      findByCompanyId: (id: string) => parties.findByCompanyId(id),
      erase: () => false,
    } as unknown as SqliteFormationPartyRepository;
    expect(() => abandonFormedCompany(deps({ parties: failing }), TENANT, companyId)).toThrow();
    expect(snapshot(companyId)).toEqual(before);
    expect(abandonLines()).toHaveLength(0);
  });
});

// ── the person's lifetime slot ─────────────────────────────────────────────────────────────────
//
// The per-human company cap (WORLD_MAX_COMPANIES_PER_HUMAN) counts every company the person's
// tenants own. A formed company abandoned with nothing at doola is left out, as a customer's
// declaration withdrawn before a check is: with a cap of 1, an abandon must not be a trap. One
// that reached doola, or may have, keeps counting, whoever abandoned it.

describe("the person's lifetime slot after an abandon", () => {
  const NULLIFIER = "4401";
  const DAY_MS = 24 * 60 * 60 * 1000;
  let store: SqliteWorldStore;

  beforeEach(() => {
    store = new SqliteWorldStore(db);
    recordHuman(store, TENANT, NULLIFIER, NOW - DAY_MS);
  });

  const counted = (): number => store.countCompaniesForNullifier(NULLIFIER, ACTION);

  /** The formed door of a sandbox deployment, with World wired and a cap of one company. */
  function formedDoor(): CreateCompanyDeps {
    return {
      companies,
      parties,
      requests,
      pin: { provider: "doola", environment: "sandbox" },
      legalBodyEnvironment: "sandbox",
      sandboxSyntheticPii: false,
      maxPerTenant: 10,
      dailyCeiling: 100,
      world: worldFor(store, { maxCompaniesPerHuman: 1 }),
      transaction: (fn) => db.transaction(fn)(),
      now: () => NOW,
    };
  }

  /** An unbound party of the tenant, for the formed door. */
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

  const formedCreate = (partyId: string, names: [string, string, string]) =>
    createCompany(formedDoor(), TENANT, {
      partyId,
      names,
      businessPurpose: "Operating software agents.",
      industryLabel: DEFAULT_INDUSTRY,
      for: "legal_body",
    });

  const idOf = (result: CreateCompanyResult): string => {
    if ("error" in result) throw new Error(result.error);
    return result.companyId;
  };

  const CAP = { code: "guardian_company_cap", status: 403 };

  /** The cap is reached: the count is one, and a second formed company is refused by it. */
  function slotTaken(): void {
    expect(counted()).toBe(1);
    const err = thrown(() =>
      formedCreate(newParty(), ["Sample Works", "Sample Labs", "Sample Studio"]),
    );
    expect(err).toMatchObject(CAP);
  }

  test("with a cap of one, a formed company abandoned with nothing at doola lets the same person create another", () => {
    const first = idOf(
      formedCreate(newParty(), ["Example Works", "Example Labs", "Example Studio"]),
    );
    slotTaken();

    abandonFormedCompany(deps(), TENANT, first);

    expect(counted()).toBe(0);
    const second = idOf(formedCreate(newParty(), ["Sample Works", "Sample Labs", "Sample Studio"]));
    expect(companies.find(second)).toMatchObject({ purposeKind: "legal_body", status: "ready" });
    expect(counted()).toBe(1);
  });

  test("a create doola refused, then abandoned by the tenant, frees the slot: the burned key filed nothing", () => {
    const { companyId } = company();
    stepsOpened(companyId, "rejected");
    expect(counted()).toBe(1);
    abandonFormedCompany(deps(), TENANT, companyId);
    expect(counted()).toBe(0);
  });

  test("a formed company abandoned with a provider_ref on create_provider still counts: doola filed it", () => {
    const { companyId } = company();
    stepsOpened(companyId, "provider_ref");
    // The tenant's door refuses it; the saga's verdict (the operator's escape writes the same)
    // abandons it with the ref kept.
    expect(
      abandonFormation(requests, companies, companyId, "operator abandon: test", {
        transaction: (fn) => db.transaction(fn)(),
        from: "failed",
      }),
    ).toBe(true);
    expect(companies.find(companyId)!.status).toBe("abandoned");
    expect(requests.find(companyId, "create_provider")).toMatchObject({
      state: "abandoned",
      providerRef: "doola-company-example",
    });
    slotTaken();
  });

  test.each([
    ["a create whose answer was lost under the live key", "answer_lost", "failed"],
    ["an unreadable create row", "unreadable", "pending"],
  ] as const)(
    "a formed company abandoned over %s still counts: doola may hold it",
    (_, shape, from) => {
      const { companyId } = company();
      stepsOpened(companyId, shape);
      expect(
        abandonFormation(requests, companies, companyId, "operator abandon: test", {
          transaction: (fn) => db.transaction(fn)(),
          from,
        }),
      ).toBe(true);
      expect(companies.find(companyId)!.status).toBe("abandoned");
      slotTaken();
    },
  );

  test("a ready formed company still counts", () => {
    company();
    slotTaken();
  });

  test("an abandoned company for agents still counts: the exemption is the formed door's", () => {
    company({ purposeKind: "agent", status: "abandoned" });
    slotTaken();
  });
});
