/**
 * FORMATION_MAX_TOTAL: the lifetime cap on formed legal-body companies, the early-access beta's
 * limit.
 *
 * The cap counts the formed legal-body companies that take a place (`countChargeableFormedLegalBodies`:
 * `ready`, or a draft with a live quote), over every tenant. It is a production rule: on
 * production a legal-body create past it answers 409 `formation_cap_reached`; a sandbox forms demo
 * companies without number. A company for agents is never counted and never refused. The create
 * door checks the cap twice: after the per-tenant quota, and again inside the mint transaction,
 * so a create that passed the first count while another person's create minted in between is
 * refused with nothing written. `/config.legalBodies.formedDoor` reads the same rule
 * (`formedCapReached`), so the door and what the deployment advertises cannot disagree.
 *
 * The database is real (in memory). The two legal-text modules are replaced by copies whose
 * status is approved, so a production deployment can be shown offering the door. Every name,
 * address and nullifier is an invention, the PII key a constant test key.
 */
import type DatabaseType from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, legalBodyConfigOf } from "../../src/api/app";
import { ApiError } from "../../src/api/errors";
import { formationQuotaExhaustedMessage } from "../../src/formation";
import {
  type CreateCompanyDeps,
  type CreateCompanyResult,
  createCompany,
} from "../../src/formation/company";
import { formedCapReached } from "../../src/formation/formedDoor";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import type { IdentityDeps } from "../../src/identity/state";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import type { LegalTextStatus } from "../../src/legalBody/texts/index";
import type { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import type { Address } from "../../src/types";
import { formationPaymentDeps, requoteFormationPayment } from "../../src/workflow/formationPayment";
import {
  TEST_PII_RING,
  identityOver,
  recordHuman,
  recordIdentity,
  worldFor,
} from "../helpers/customerCompanyFixtures";
import { fakeChain, paymentCfg } from "../helpers/formationPayment";
import {
  type LegalBodyStores,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** The status each of the two texts reads as: approved, so production can offer the door. */
const texts = vi.hoisted(() => ({
  agreement: "approved" as LegalTextStatus,
  statement: "approved" as LegalTextStatus,
}));

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

vi.mock("../../src/legalBody/texts/statementOfAuthority", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/legalBody/texts/statementOfAuthority")>();
  return {
    ...actual,
    get STATEMENT_OF_AUTHORITY() {
      return { ...actual.STATEMENT_OF_AUTHORITY, status: texts.statement };
    },
  };
});

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Four guardians, each a different person: a tenant and its World nullifier. */
const ADA = { tenant: getAddress("0x00000000000000000000000000000000000000b1"), nullifier: "2001" };
const BEA = { tenant: getAddress("0x00000000000000000000000000000000000000b2"), nullifier: "2002" };
const CAL = { tenant: getAddress("0x00000000000000000000000000000000000000b3"), nullifier: "2003" };
const DEE = { tenant: getAddress("0x00000000000000000000000000000000000000b4"), nullifier: "2004" };
type Guardian = typeof ADA;

const NAMES = ["Example Works", "Example Labs", "Example Studio"];

let db: DatabaseType.Database;
let s: LegalBodyStores;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;
let identityRepo: SqliteIdentityRepository;
let identity: IdentityDeps;
/** Every console line written in the test. */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  companies = s.companies;
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  identityRepo = new SqliteIdentityRepository(db);
  identity = identityOver(identityRepo, () => NOW);
  texts.agreement = "approved";
  texts.statement = "approved";
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

/** A sandbox deployment: doola's sandbox, the testnet network, World wired, no identity record,
 *  no payment. */
function sandboxDeps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    legalBodyEnvironment: "sandbox",
    sandboxSyntheticPii: false,
    maxPerTenant: 10,
    dailyCeiling: 100,
    world: worldFor(s.store, { environment: "staging" }),
    transaction: (fn) => db.transaction(fn)(),
    now: () => NOW,
    ...over,
  };
}

/** A production deployment with every gate of the formed door passing (World, the identity
 *  record, the approved agreement, invites required) and a total cap of two. No payment unless a
 *  test passes it: each company then lands `ready`. */
function prodDeps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return sandboxDeps({
    pin: { provider: "doola", environment: "production" },
    legalBodyEnvironment: "production",
    pii: TEST_PII_RING,
    world: worldFor(s.store),
    identity,
    invites: { required: true },
    maxTotal: 2,
    ...over,
  });
}

/** The guardian is a real human with a passed identity record. */
function verified(g: Guardian): Guardian {
  recordHuman(s.store, g.tenant, g.nullifier, NOW - DAY_MS);
  recordIdentity(identityRepo, g.tenant, {
    at: NOW - 30 * DAY_MS,
    expiresAt: NOW + 3 * 365 * DAY_MS,
    nullifier: g.nullifier,
  });
  return g;
}

function newParty(g: Guardian): string {
  return parties.create({
    tenantId: g.tenant,
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

const intake = (partyId: string, purpose: "legal_body" | "agent" = "legal_body") => ({
  partyId,
  names: NAMES,
  businessPurpose: "Operating software agents.",
  industryLabel: DEFAULT_INDUSTRY,
  for: purpose === "legal_body" ? ("legal_body" as const) : undefined,
});

/** A legal-body create for the guardian with a party of its own. */
const formLegalBody = (deps: CreateCompanyDeps, g: Guardian): CreateCompanyResult =>
  createCompany(deps, g.tenant, intake(newParty(g)));

/** A company for agents for the guardian with a party of its own. */
const formForAgents = (deps: CreateCompanyDeps, g: Guardian): CreateCompanyResult =>
  createCompany(deps, g.tenant, intake(newParty(g), "agent"));

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

const idOf = (result: CreateCompanyResult): string => {
  if ("error" in result) throw new Error(result.error);
  return result.companyId;
};

const paymentRows = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM formation_payments").get() as { n: number }).n;

/** The refusal of the total cap, in its one sentence. */
const CAP_REFUSAL = {
  code: "formation_cap_reached",
  status: 409,
  message: LEGAL_BODY_SENTENCES.formation_cap_reached,
};

/** A ready formed legal-body company of another person, written straight through the
 *  repository: what another create that minted in between leaves behind. */
function anotherPersonsCompany(tenantId: Address = DEE.tenant): string {
  return companies.create({
    tenantId,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Sample Works", "Sample Labs", "Sample Studio"),
    businessPurpose: "Another person's company.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
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

/** Every `formation_cap_reached` ops line printed in the test, as printed. */
const capLines = (): string[] =>
  printed.filter((line) => opslogOf(line) === "formation_cap_reached");

/** The refused create of `fn`, and what it left: the error, the payment rows before it, whether
 *  it printed a `company_created` line, and the `formation_cap_reached` lines it printed. */
function refusedCreate(fn: () => unknown): {
  err: ApiError | null;
  paymentsBefore: number;
  printedCreated: boolean;
  capLines: string[];
} {
  const paymentsBefore = paymentRows();
  const mark = printed.length;
  const err = thrown(fn);
  const lines = printed.slice(mark);
  return {
    err,
    paymentsBefore,
    printedCreated: lines.some((line) => opslogOf(line) === "company_created"),
    capLines: lines.filter((line) => opslogOf(line) === "formation_cap_reached"),
  };
}

/**
 * The refusal printed exactly one `formation_cap_reached` line: a warning that says which check
 * refused (`count`, after the quota; `mint`, inside the transaction; `requote`, at a re-quote),
 * with the cap and the count
 * and nothing else. No tenant, no name, no address, and the line's own timestamp intact.
 */
function oneCapLine(
  refused: ReturnType<typeof refusedCreate>,
  check: "count" | "mint" | "requote",
  counted: number,
  g: Guardian,
): void {
  expect(refused.capLines).toHaveLength(1);
  const raw = refused.capLines[0] as string;
  const line = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.keys(line).sort()).toEqual([
    "at",
    "check",
    "counted",
    "level",
    "maxTotal",
    "opslog",
  ]);
  expect(line).toMatchObject({
    opslog: "formation_cap_reached",
    level: "warn",
    check,
    maxTotal: 2,
    counted,
  });
  // `at` is the ops line's own timestamp, which a field of the same name would overwrite.
  expect(line.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  for (const personal of [
    g.tenant,
    g.tenant.toLowerCase(),
    g.nullifier,
    "Example",
    "person@example.com",
    "Cheyenne",
  ])
    expect(raw, personal).not.toContain(personal);
}

/** The refusal of the total cap, with nothing written for the guardian's create: no company, the
 *  party still unbound, no payment row, no `company_created` line. */
function refusedWithNothingWritten(
  refused: ReturnType<typeof refusedCreate>,
  g: Guardian,
  partyId: string,
): void {
  expect(refused.err).toMatchObject(CAP_REFUSAL);
  expect(companies.listByTenant(g.tenant)).toHaveLength(0);
  expect(parties.findOwned(g.tenant, partyId)!.companyId).toBeNull();
  expect(paymentRows()).toBe(refused.paymentsBefore);
  expect(refused.printedCreated).toBe(false);
}

/** `/config.legalBodies.formedDoor` of a deployment whose create door runs on `companyDeps`,
 *  wired as the composition root wires it: the cap is read from those deps, nowhere else. */
function formedDoorServed(
  companyDeps: CreateCompanyDeps,
  extra: { identity?: IdentityDeps; invites?: { required: boolean } } = {},
): string | undefined {
  const { transaction: _transaction, ...rest } = companyDeps;
  const environment = companyDeps.pin.environment as "sandbox" | "production";
  const formation: NonNullable<ApiDeps["formation"]> = {
    environment,
    required: true,
    sandboxSyntheticPii: companyDeps.sandboxSyntheticPii,
    maxPerTenant: companyDeps.maxPerTenant,
    dailyCeiling: companyDeps.dailyCeiling,
    maxAgentsPerCompany: 10,
    parties,
    requests,
    companies,
    pin: { provider: "doola", environment },
    companyDeps: rest,
    payment: companyDeps.payment,
    feeUsdc: 399,
  };
  const config = legalBodyConfigOf({
    legalBodyOrders: legalBodyOrderDeps(s, {
      environment: companyDeps.legalBodyEnvironment ?? environment,
    }),
    formation,
    identity: extra.identity,
    invites: extra.invites,
  });
  return config.available ? config.formedDoor : undefined;
}

// ── formedCapReached ─────────────────────────────────────────────────────────────────────────

describe("formedCapReached", () => {
  const counting = (n: number) => ({ countChargeableFormedLegalBodies: () => n });
  const unreadable = {
    countChargeableFormedLegalBodies: (): number => {
      throw new Error("the count was read");
    },
  };

  test("on production: reached at or past the cap, not below it", () => {
    expect(formedCapReached(counting(0), 2, "production")).toBe(false);
    expect(formedCapReached(counting(1), 2, "production")).toBe(false);
    expect(formedCapReached(counting(2), 2, "production")).toBe(true);
    // A cap lowered under what is already formed.
    expect(formedCapReached(counting(5), 2, "production")).toBe(true);
  });

  test("a sandbox is never capped, and its count is never read", () => {
    expect(formedCapReached(unreadable, 1, "sandbox")).toBe(false);
    expect(formedCapReached(unreadable, undefined, "sandbox")).toBe(false);
  });

  test("no cap given: never reached, and the count is never read", () => {
    expect(formedCapReached(unreadable, undefined, "production")).toBe(false);
  });
});

// ── the create door on production ────────────────────────────────────────────────────────────

describe("the total cap at the formed door on production", () => {
  test("at a cap of two, the third person's legal-body create answers formation_cap_reached 409 and writes nothing, while a company for agents still creates", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps();
    for (const g of [ADA, BEA])
      expect(companies.find(idOf(formLegalBody(deps, g)))).toMatchObject({
        purposeKind: "legal_body",
        status: "ready",
      });
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);

    expect(capLines()).toHaveLength(0);

    const partyId = newParty(CAL);
    const refused = refusedCreate(() => createCompany(deps, CAL.tenant, intake(partyId)));
    refusedWithNothingWritten(refused, CAL, partyId);
    oneCapLine(refused, "count", 2, CAL);

    // The same person, the same party, the same deps: a company for agents is not capped.
    const agent = createCompany(deps, CAL.tenant, intake(partyId, "agent"));
    expect(companies.find(idOf(agent))!.purposeKind).toBe("agent");
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);
    expect(capLines()).toHaveLength(1);
  });

  test("companies for agents take no place: they are neither counted nor refused, and never read the count", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps();
    for (let i = 0; i < 3; i++) idOf(formForAgents(deps, ADA));
    expect(companies.countChargeableFormedLegalBodies()).toBe(0);
    // Two legal-body companies still fit under the cap of two.
    for (const g of [BEA, CAL]) idOf(formLegalBody(deps, g));
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);

    const count = vi.spyOn(companies, "countChargeableFormedLegalBodies");
    idOf(formForAgents(deps, ADA));
    expect(count).not.toHaveBeenCalled();
  });

  test("a draft with a quoted payment takes a place (payment on)", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps({ payment: paymentCfg(payments) });
    for (const g of [ADA, BEA]) {
      const result = formLegalBody(deps, g);
      expect(companies.find(idOf(result))!.status).toBe("draft");
      expect("quote" in result && result.quote !== undefined).toBe(true);
    }
    expect(paymentRows()).toBe(2);
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);

    const partyId = newParty(CAL);
    const refused = refusedCreate(() => createCompany(deps, CAL.tenant, intake(partyId)));
    refusedWithNothingWritten(refused, CAL, partyId);
    oneCapLine(refused, "count", 2, CAL);
    expect(paymentRows()).toBe(2);
  });

  test("abandoning a company frees its place", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps();
    const first = idOf(formLegalBody(deps, ADA));
    idOf(formLegalBody(deps, BEA));
    const partyId = newParty(CAL);
    expect(thrown(() => createCompany(deps, CAL.tenant, intake(partyId)))).toMatchObject(
      CAP_REFUSAL,
    );

    expect(companies.setStatus(first, "ready", "abandoned")).toBe(true);
    expect(companies.countChargeableFormedLegalBodies()).toBe(1);
    const created = createCompany(deps, CAL.tenant, intake(partyId));
    expect(companies.find(idOf(created))!.purposeKind).toBe("legal_body");
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);
  });

  test("the re-check inside the mint: a create that passed the first count while another person's create minted in between answers formation_cap_reached and writes nothing", () => {
    for (const g of [ADA, CAL]) verified(g);
    const payment = paymentCfg(payments);
    // One place left of two: Ada's draft, owing its fee.
    idOf(formLegalBody(prodDeps({ payment }), ADA));
    expect(companies.countChargeableFormedLegalBodies()).toBe(1);
    expect(paymentRows()).toBe(1);

    // Cal's create passes the first count; before its mint runs, another person's create mints
    // the last place.
    let interleaved = 0;
    const deps = prodDeps({
      payment,
      transaction: (fn) => {
        interleaved += 1;
        anotherPersonsCompany();
        return db.transaction(fn)();
      },
    });
    const partyId = newParty(CAL);
    const refused = refusedCreate(() => createCompany(deps, CAL.tenant, intake(partyId)));
    // The mint was reached, so the first count let the create through.
    expect(interleaved).toBe(1);
    refusedWithNothingWritten(refused, CAL, partyId);
    // One line, from the re-check inside the mint: the first count let the create through.
    oneCapLine(refused, "mint", 2, CAL);
    expect(paymentRows()).toBe(1);
    // Two places taken, never three: Ada's and the one minted in between.
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);
    expect(companies.listByTenant(DEE.tenant)).toHaveLength(1);
  });

  test("the cap is asked right after the per-tenant quota: the quota answers first, and the cap before the daily ceiling and the intake checks, without opening the mint", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    for (const g of [ADA, BEA]) idOf(formLegalBody(prodDeps(), g));
    let opened = 0;
    const deps = prodDeps({
      transaction: (fn) => {
        opened += 1;
        return db.transaction(fn)();
      },
    });

    // A tenant at its own quota hears the quota, not the cap.
    expect(createCompany(prodDeps({ maxPerTenant: 1 }), ADA.tenant, intake(newParty(ADA)))).toEqual(
      { error: formationQuotaExhaustedMessage(1) },
    );

    // Past the quota, the cap: before the daily ceiling (exhausted here) and before the names.
    const partyId = newParty(CAL);
    const refused = refusedCreate(() =>
      createCompany({ ...deps, dailyCeiling: 0 }, CAL.tenant, {
        ...intake(partyId),
        names: ["", "", ""],
      }),
    );
    refusedWithNothingWritten(refused, CAL, partyId);
    oneCapLine(refused, "count", 2, CAL);
    expect(opened).toBe(0);
  });

  test("with no cap given, production forms without number", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps({ maxTotal: undefined });
    for (const g of [ADA, BEA, CAL]) idOf(formLegalBody(deps, g));
    expect(companies.countChargeableFormedLegalBodies()).toBe(3);
  });
});

// ── a sandbox ────────────────────────────────────────────────────────────────────────────────

describe("a sandbox is never capped", () => {
  test("with a cap of one, a second legal-body company still creates, the count is never read, and /config.formedDoor reads offered", () => {
    for (const g of [ADA, BEA]) recordHuman(s.store, g.tenant, g.nullifier, NOW - DAY_MS);
    const deps = sandboxDeps({ maxTotal: 1 });
    const count = vi.spyOn(companies, "countChargeableFormedLegalBodies");
    for (const g of [ADA, BEA])
      expect(companies.find(idOf(formLegalBody(deps, g)))).toMatchObject({
        purposeKind: "legal_body",
        environment: "sandbox",
        status: "ready",
      });
    expect(count).not.toHaveBeenCalled();
    count.mockRestore();
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);
    expect(capLines()).toHaveLength(0);
    expect(formedDoorServed(deps)).toBe("offered");
  });
});

// ── one rule for both readers ────────────────────────────────────────────────────────────────

describe("the create door and /config.formedDoor read one rule", () => {
  test("on production they agree below the cap, at it, and once a place is freed", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    // The deployment the door is offered on: every gate, a deployment that charges.
    const deps = prodDeps({ payment: paymentCfg(payments) });
    const served = () => formedDoorServed(deps, { identity, invites: { required: true } });

    expect(served()).toBe("offered");
    const first = idOf(formLegalBody(deps, ADA));
    expect(served()).toBe("offered");
    idOf(formLegalBody(deps, BEA));

    expect(served()).toBe("cap_reached");
    const partyId = newParty(CAL);
    expect(thrown(() => createCompany(deps, CAL.tenant, intake(partyId)))).toMatchObject(
      CAP_REFUSAL,
    );

    // Ada's quote expires and her draft is abandoned: one place is free again, for both readers.
    const quote = payments.findLive(first, "formation")!;
    expect(payments.markExpired(quote.paymentId, "quoted")).toBe(true);
    expect(companies.setStatus(first, "draft", "abandoned")).toBe(true);
    expect(served()).toBe("offered");
    idOf(createCompany(deps, CAL.tenant, intake(partyId)));
    expect(served()).toBe("cap_reached");
  });
});

// ── a re-quote ───────────────────────────────────────────────────────────────────────────────

describe("a re-quote respects the cap", () => {
  /** The payment doors' deps of a deployment whose create door runs on `companyDeps`, built by
   *  the one builder both doors use (`formationPaymentDeps`): the cap and the door's environment
   *  come from those deps, as the create reads them. */
  function paymentDoors(companyDeps: CreateCompanyDeps) {
    const { transaction: _transaction, ...rest } = companyDeps;
    const built = formationPaymentDeps({
      companies,
      repo: new SqliteEntityRepository(db),
      formation: {
        payment: companyDeps.payment,
        paymentExecutor: fakeChain().executor,
        companyDeps: rest,
      },
      now: () => NOW,
    });
    if (!built) throw new Error("this deployment does not take payments");
    return built;
  }

  /** The company's live quote expires: it leaves the count until it is quoted again. */
  function expireQuote(companyId: string): void {
    const quote = payments.findLive(companyId, "formation")!;
    expect(payments.markExpired(quote.paymentId, "quoted")).toBe(true);
  }

  const requote = (companyDeps: CreateCompanyDeps, companyId: string) =>
    requoteFormationPayment(paymentDoors(companyDeps), companies.find(companyId)!);

  test("at a cap of two: Ada's quote expires, Cal takes the place, and Ada's re-quote answers formation_cap_reached 409 with no quote written", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps({ payment: paymentCfg(payments) });
    const ada = idOf(formLegalBody(deps, ADA));
    idOf(formLegalBody(deps, BEA));
    expireQuote(ada);
    idOf(formLegalBody(deps, CAL));
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);

    const refused = refusedCreate(() => requote(deps, ada));
    expect(refused.err).toMatchObject(CAP_REFUSAL);
    expect(payments.findLive(ada, "formation")).toBeUndefined();
    expect(paymentRows()).toBe(refused.paymentsBefore);
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);
    oneCapLine(refused, "requote", 2, ADA);
  });

  test("with room, a re-quote works as before, and the company takes its place again", () => {
    verified(ADA);
    const deps = prodDeps({ payment: paymentCfg(payments) });
    const ada = idOf(formLegalBody(deps, ADA));
    expireQuote(ada);
    expect(companies.countChargeableFormedLegalBodies()).toBe(0);

    const result = requote(deps, ada);
    expect(result).toMatchObject({ ok: true });
    expect(payments.findLive(ada, "formation")?.status).toBe("quoted");
    expect(companies.countChargeableFormedLegalBodies()).toBe(1);
    expect(capLines()).toHaveLength(0);
  });

  test("a company for agents is never capped at a re-quote, and never reads the count", () => {
    for (const g of [ADA, BEA, CAL]) verified(g);
    const deps = prodDeps({ payment: paymentCfg(payments) });
    const agent = idOf(formForAgents(deps, CAL));
    for (const g of [ADA, BEA]) idOf(formLegalBody(deps, g));
    expireQuote(agent);
    expect(companies.countChargeableFormedLegalBodies()).toBe(2);

    const count = vi.spyOn(companies, "countChargeableFormedLegalBodies");
    expect(requote(deps, agent)).toMatchObject({ ok: true });
    expect(count).not.toHaveBeenCalled();
    expect(payments.findLive(agent, "formation")?.status).toBe("quoted");
    expect(capLines()).toHaveLength(0);
  });

  test("a sandbox is never capped at a re-quote, and never reads the count", () => {
    for (const g of [ADA, BEA]) recordHuman(s.store, g.tenant, g.nullifier, NOW - DAY_MS);
    const deps = sandboxDeps({ payment: paymentCfg(payments), maxTotal: 1 });
    const ada = idOf(formLegalBody(deps, ADA));
    idOf(formLegalBody(deps, BEA));
    expireQuote(ada);

    const count = vi.spyOn(companies, "countChargeableFormedLegalBodies");
    expect(requote(deps, ada)).toMatchObject({ ok: true });
    expect(count).not.toHaveBeenCalled();
    expect(payments.findLive(ada, "formation")?.status).toBe("quoted");
    expect(capLines()).toHaveLength(0);
  });
});
