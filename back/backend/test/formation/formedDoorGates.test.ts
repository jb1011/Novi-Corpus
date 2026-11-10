/**
 * The formed door's gates: what `createCompany` checks before it creates a company for a legal
 * body, the name rule that door adds, and the one rule that says which environment it runs under.
 *
 * The door runs under production when doola is pinned to production OR the network is the
 * production one (`formedDoorEnvironment`). There, in this order and before anything is written:
 * a real human (a waiver is refused), the per-human company cap, the guardian identity record, the
 * approved operating agreement, and last the invite gate, a placeholder that refuses with
 * `formed_door_not_offered` until the invite codes are built. A sandbox runs the same World gate
 * (a waiver is refused there too, and a box with no World block answers 503), skips the identity
 * record and serves a draft agreement. A company for agents keeps its own gate.
 *
 * A name option typed with its entity ending is refused at the formed door, at the create and at
 * the re-open alike, rather than filed with the ending twice; the agent door keeps stripping one.
 *
 * The database is real (in memory). The operating agreement module is replaced by a copy whose
 * status each test sets. Every name, address and nullifier is an invention, the PII key a constant
 * test key.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/api/errors";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { companyNameEndingRefusedMessage, companyNameTooLongMessage } from "../../src/formation";
import {
  type CreateCompanyDeps,
  type CreateCompanyResult,
  createCompany,
  updateCompanyIntake,
} from "../../src/formation/company";
import { formedDoorEnvironment } from "../../src/formation/formedDoor";
import {
  DEFAULT_INDUSTRY,
  NAME_MAX_LENGTH,
  companyNameOptions,
  hasEntityEnding,
  withEntityEnding,
} from "../../src/formation/intake";
import { parsePiiKey } from "../../src/formation/pii";
import type { IdentityDeps } from "../../src/identity/state";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import type { LegalTextStatus } from "../../src/legalBody/texts/index";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  identityOver,
  recordHuman,
  recordIdentity,
  worldFor,
} from "../helpers/customerCompanyFixtures";
import { paymentCfg } from "../helpers/formationPayment";

/** The status the operating agreement reads as in a test: approved unless the test says
 *  otherwise. */
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

const TENANT = "0x000000000000000000000000000000000000000A" as const;
const NULLIFIER = "1001";
const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const RING = { current: parsePiiKey(Buffer.alloc(32, 4).toString("base64"), "FORMATION_PII_KEY") };

/** Three name options without an entity ending, and a second set for the tests that mint twice. */
const NAMES = ["Example Works", "Example Labs", "Example Studio"];
const SECOND_NAMES = ["Sample Works", "Sample Labs", "Sample Studio"];

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;
let store: SqliteWorldStore;
let identityRepo: SqliteIdentityRepository;
let identity: IdentityDeps;
/** Every console line written in the test. */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  store = new SqliteWorldStore(db);
  identityRepo = new SqliteIdentityRepository(db);
  identity = identityOver(identityRepo, () => NOW);
  texts.agreement = "approved";
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

/** A sandbox deployment: doola's sandbox, the testnet network, no identity record, no payment. */
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
    transaction: (fn) => db.transaction(fn)(),
    now: () => NOW,
    ...over,
  };
}

/** A production deployment that charges, with World and the identity record wired. The invite
 *  placeholder is absent unless a test passes it. */
function prodDeps(over: Partial<CreateCompanyDeps> = {}): CreateCompanyDeps {
  return sandboxDeps({
    pin: { provider: "doola", environment: "production" },
    legalBodyEnvironment: "production",
    pii: RING,
    world: worldFor(store),
    identity,
    payment: paymentCfg(payments),
    ...over,
  });
}

function newParty(): string {
  return parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Example",
    email: "ada@example.com",
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

const intake = (partyId: string, over: Record<string, unknown> = {}) => ({
  partyId,
  names: NAMES,
  businessPurpose: "Operating software agents.",
  industryLabel: DEFAULT_INDUSTRY,
  for: "legal_body" as const,
  ...over,
});

/** The guardian's World row: a real credential unless a test records a waiver. */
const human = (credential = "proof_of_human"): void =>
  recordHuman(store, TENANT, NULLIFIER, NOW - DAY_MS, credential);

/** A passed identity record of the guardian, due for renewal in three years. */
const identified = (): void => {
  recordIdentity(identityRepo, TENANT, {
    at: NOW - 30 * DAY_MS,
    expiresAt: NOW + 3 * 365 * DAY_MS,
    nullifier: NULLIFIER,
  });
};

/** Every gate before the invite placeholder met. */
const everyGateMet = (): void => {
  human();
  identified();
};

/** A company the tenant already owns, as the per-human cap counts it. */
function ownedCompany(): string {
  return companies.create({
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions(...SECOND_NAMES),
    businessPurpose: "An earlier company.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: "agent",
  });
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

const idOf = (result: CreateCompanyResult): string => {
  if ("error" in result) throw new Error(result.error);
  return result.companyId;
};

const paymentRows = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM formation_payments").get() as { n: number }).n;

/** Nothing was written for the party: no company, no payment, the party still unbound. */
function nothingWritten(partyId: string): void {
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
  expect(paymentRows()).toBe(0);
  expect(parties.findOwned(TENANT, partyId)!.companyId).toBeNull();
  expect(printed.some((line) => line.includes("company_created"))).toBe(false);
}

// ── formedDoorEnvironment ────────────────────────────────────────────────────────────────────

describe("formedDoorEnvironment", () => {
  test("production when the doola pin or the network is production; sandbox only when both are", () => {
    expect(formedDoorEnvironment("production", "sandbox")).toBe("production");
    expect(formedDoorEnvironment("sandbox", "production")).toBe("production");
    expect(formedDoorEnvironment("production", "production")).toBe("production");
    expect(formedDoorEnvironment("sandbox", "sandbox")).toBe("sandbox");
  });

  test("either one production runs the production gates at createCompany", () => {
    // A real human with an identity record, and the agreement a draft, as it is today: a sandbox
    // serves the draft, production refuses it.
    texts.agreement = "draft";
    everyGateMet();
    const world = worldFor(store);
    const environments: ["sandbox" | "production", "sandbox" | "production"][] = [
      ["production", "sandbox"],
      ["sandbox", "production"],
    ];
    for (const [pin, network] of environments) {
      const partyId = newParty();
      const err = thrown(() =>
        createCompany(
          sandboxDeps({
            pin: { provider: "doola", environment: pin },
            legalBodyEnvironment: network,
            pii: RING,
            world,
            identity,
          }),
          TENANT,
          intake(partyId),
        ),
      );
      expect(err, `${pin} pin, ${network} network`).toMatchObject({
        code: "legal_text_not_approved",
        status: 503,
      });
      nothingWritten(partyId);
    }
    // Both sandbox: the door creates.
    const created = createCompany(sandboxDeps({ world, identity }), TENANT, intake(newParty()));
    expect(companies.find(idOf(created))!.purposeKind).toBe("legal_body");
  });

  test("the network's environment, when absent, reads as the pin's", () => {
    texts.agreement = "draft";
    everyGateMet();
    const partyId = newParty();
    const err = thrown(() =>
      createCompany(prodDeps({ legalBodyEnvironment: undefined }), TENANT, intake(partyId)),
    );
    expect(err).toMatchObject({ code: "legal_text_not_approved", status: 503 });
    const created = createCompany(
      sandboxDeps({ world: worldFor(store), legalBodyEnvironment: undefined }),
      TENANT,
      intake(partyId),
    );
    expect(companies.find(idOf(created))!.purposeKind).toBe("legal_body");
  });
});

// ── the gates on production, in order ────────────────────────────────────────────────────────

describe("the formed door on production, gate by gate", () => {
  test("1. no World row: guardian_not_verified", () => {
    // Every later gate would refuse too: no identity record, a draft agreement, no invite.
    texts.agreement = "draft";
    const partyId = newParty();
    const err = thrown(() => createCompany(prodDeps(), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "guardian_not_verified", status: 403 });
    nothingWritten(partyId);
  });

  test("2. a waiver row: waiver_not_accepted", () => {
    texts.agreement = "draft";
    human("waiver");
    const partyId = newParty();
    const err = thrown(() => createCompany(prodDeps(), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "waiver_not_accepted", status: 403 });
    nothingWritten(partyId);
  });

  test("3. the per-human cap: guardian_company_cap, whatever the enforcement switch says", () => {
    texts.agreement = "draft";
    human();
    ownedCompany();
    const world: WorldIdDeps = worldFor(store, { maxCompaniesPerHuman: 1 });
    // The enforcement switch is off in the fixture: the formed door applies the cap anyway.
    expect(world.requireGuardian).toBe(false);
    const partyId = newParty();
    const err = thrown(() => createCompany(prodDeps({ world }), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "guardian_company_cap", status: 403 });
    expect(parties.findOwned(TENANT, partyId)!.companyId).toBeNull();
    expect(companies.listByTenant(TENANT)).toHaveLength(1);
    expect(paymentRows()).toBe(0);

    // The agent door keeps its own rule: with enforcement off, it applies no cap.
    const agent = createCompany(prodDeps({ world }), TENANT, {
      ...intake(partyId),
      for: undefined,
    });
    expect(companies.find(idOf(agent))!.purposeKind).toBe("agent");
  });

  test("4. no identity record: guardian_identity_not_verified", () => {
    texts.agreement = "draft";
    human();
    const partyId = newParty();
    const err = thrown(() => createCompany(prodDeps(), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "guardian_identity_not_verified", status: 403 });
    nothingWritten(partyId);
  });

  test("5. the operating agreement a draft: legal_text_not_approved, 503", () => {
    texts.agreement = "draft";
    everyGateMet();
    const partyId = newParty();
    const err = thrown(() => createCompany(prodDeps(), TENANT, intake(partyId)));
    expect(err).toMatchObject({
      code: "legal_text_not_approved",
      status: 503,
      message: LEGAL_BODY_SENTENCES.legal_text_not_approved,
    });
    nothingWritten(partyId);
  });

  test("6. every gate met, the invite placeholder absent: formed_door_not_offered, 403, nothing written", () => {
    everyGateMet();
    const partyId = newParty();
    for (const invites of [undefined, { required: false }]) {
      const err = thrown(() => createCompany(prodDeps({ invites }), TENANT, intake(partyId)));
      expect(err).toMatchObject({
        code: "formed_door_not_offered",
        status: 403,
        message: LEGAL_BODY_SENTENCES.formed_door_not_offered,
      });
    }
    nothingWritten(partyId);
  });

  test("7. every gate met and invites required: the company is created on production", () => {
    everyGateMet();
    const partyId = newParty();
    const result = createCompany(
      prodDeps({ invites: { required: true } }),
      TENANT,
      intake(partyId),
    );
    const company = companies.find(idOf(result))!;
    expect(company).toMatchObject({
      purposeKind: "legal_body",
      environment: "production",
      // A deployment that charges lands the company owing its fee, with the quote returned.
      status: "draft",
    });
    expect("quote" in result && result.quote !== undefined).toBe(true);
    expect(parties.findOwned(TENANT, partyId)!.companyId).toBe(company.companyId);
  });
});

// ── the gates on a sandbox ───────────────────────────────────────────────────────────────────

describe("the formed door on a sandbox", () => {
  test("a waiver row is refused at the formed door, while the same deps create a company for agents", () => {
    human("waiver");
    // Enforcement on, as a box that gates its agent door: the waiver is what lets that door in.
    const world: WorldIdDeps = {
      ...worldFor(store, { environment: "staging" }),
      requireGuardian: true,
    };
    const partyId = newParty();
    const err = thrown(() => createCompany(sandboxDeps({ world }), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "waiver_not_accepted", status: 403 });
    nothingWritten(partyId);

    const agent = createCompany(sandboxDeps({ world }), TENANT, {
      ...intake(partyId),
      for: undefined,
    });
    expect(companies.find(idOf(agent))!.purposeKind).toBe("agent");
  });

  test("a box with no World block answers 503 rather than creating", () => {
    const partyId = newParty();
    const err = thrown(() => createCompany(sandboxDeps(), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "unavailable", status: 503 });
    nothingWritten(partyId);
  });

  test("a real World row creates, with a draft agreement and no identity record", () => {
    texts.agreement = "draft";
    human();
    const world = worldFor(store, { environment: "staging" });
    const partyId = newParty();
    const result = createCompany(
      sandboxDeps({ world, identity: undefined }),
      TENANT,
      intake(partyId),
    );
    expect(companies.find(idOf(result))).toMatchObject({
      purposeKind: "legal_body",
      environment: "sandbox",
      status: "ready",
    });
  });

  test("the per-human cap holds on a sandbox too", () => {
    human();
    ownedCompany();
    const world = worldFor(store, { maxCompaniesPerHuman: 1 });
    const partyId = newParty();
    const err = thrown(() => createCompany(sandboxDeps({ world }), TENANT, intake(partyId)));
    expect(err).toMatchObject({ code: "guardian_company_cap", status: 403 });
    expect(parties.findOwned(TENANT, partyId)!.companyId).toBeNull();
  });
});

// ── the entity ending ────────────────────────────────────────────────────────────────────────

describe("a name option typed with its entity ending", () => {
  const WITH_ENDING = ["Acme LLC", "Acme L.L.C.", "Acme Limited Liability Company"];
  const options = (first: string) => [first, "Acme Two", "Acme Three"];

  test("is refused at the formed door, naming the option, and nothing is written", () => {
    human();
    const world = worldFor(store);
    for (const first of WITH_ENDING) {
      const partyId = newParty();
      expect(
        createCompany(sandboxDeps({ world }), TENANT, intake(partyId, { names: options(first) })),
        first,
      ).toEqual({ error: companyNameEndingRefusedMessage(1) });
      expect(parties.findOwned(TENANT, partyId)!.companyId).toBeNull();
    }
    // The option's position is the one named.
    expect(
      createCompany(
        sandboxDeps({ world }),
        TENANT,
        intake(newParty(), { names: ["Acme One", "Acme Two LLC", "Acme Three"] }),
      ),
    ).toEqual({ error: companyNameEndingRefusedMessage(2) });
    expect(companies.listByTenant(TENANT)).toHaveLength(0);
  });

  test("the ending is checked before the length: a long option ending in LLC answers the ending refusal", () => {
    human();
    const world = worldFor(store);
    const long = `${"Acme ".repeat(30).trim()} LLC`;
    expect(long.length).toBeGreaterThan(NAME_MAX_LENGTH);
    expect(
      createCompany(sandboxDeps({ world }), TENANT, intake(newParty(), { names: options(long) })),
    ).toEqual({ error: companyNameEndingRefusedMessage(1) });
    // The agent door has no ending rule, so the length is what it refuses.
    expect(
      createCompany(sandboxDeps(), TENANT, {
        ...intake(newParty(), { names: options(long) }),
        for: undefined,
      }),
    ).toEqual({ error: companyNameTooLongMessage(1, NAME_MAX_LENGTH) });
  });

  test("every Wyoming LLC ending is refused at the formed door, in any case, spacing or periods", () => {
    human();
    const world = worldFor(store);
    const endings = [
      "Acme LC",
      "Acme L.C.",
      "Acme l.c",
      "Acme L. L. C.",
      "Acme, llc",
      "Acme  LLC",
      "Acme Limited Liability Co.",
      "Acme Ltd. Liability Co.",
      "Acme Ltd. Liability Company",
      "Acme ltd liability co",
      "Acme Limited  Liability   Company",
      // W.S. 17-29-108(a) also allows "limited company", with the same abbreviations.
      "Acme Limited Company",
      "Acme Ltd. Co.",
      // An option that is nothing but an ending.
      "LC",
    ];
    for (const first of endings)
      expect(
        createCompany(
          sandboxDeps({ world }),
          TENANT,
          intake(newParty(), { names: options(first) }),
        ),
        first,
      ).toEqual({ error: companyNameEndingRefusedMessage(1) });
    expect(companies.listByTenant(TENANT)).toHaveLength(0);
  });

  test("a word that merely ends in those letters is not an ending", () => {
    const words = ["Acme Kalc", "Acme Apollo", "Acme Metallic", "Calc", "Acme Unlimited Co."];
    // Nor is a word of an ending on its own.
    for (const name of [...words, "Acme Ltd.", "Acme Co.", "Acme Limited", "Acme Liability"])
      expect(hasEntityEnding(name), name).toBe(false);
    human();
    const world = worldFor(store);
    const names = ["Acme Kalc", "Acme Apollo", "Acme Metallic"];
    const created = createCompany(sandboxDeps({ world }), TENANT, intake(newParty(), { names }));
    expect(companies.find(idOf(created))!.nameOptions.map((o) => o.name)).toEqual(names);
  });

  test("the sentence says what to do", () => {
    expect(companyNameEndingRefusedMessage(1)).toBe(
      "company name option 1: leave out the entity ending (LLC, L.L.C., Limited Liability Company): it is added when the company is filed",
    );
  });

  test("still creates at the agent door, which strips one LLC ending as before", () => {
    // The strip and `withEntityEnding` read `stripEntityEnding`, not `hasEntityEnding`: unchanged.
    const stored = [...WITH_ENDING, "Acme LC"].map((first) => {
      const result = createCompany(sandboxDeps(), TENANT, {
        ...intake(newParty(), { names: options(first) }),
        for: undefined,
      });
      return companies.find(idOf(result))!.nameOptions[0]!.name;
    });
    expect(stored).toEqual(["Acme", "Acme", "Acme Limited Liability Company", "Acme LC"]);
    expect(withEntityEnding("Acme")).toBe("Acme LLC");
    expect(withEntityEnding("Acme LLC")).toBe("Acme LLC");
  });

  test("PATCH /companies/:id refuses it the same way on a legal-body company, and not on one for agents", () => {
    human();
    const world = worldFor(store);
    const legalBody = idOf(createCompany(sandboxDeps({ world }), TENANT, intake(newParty())));
    const agent = idOf(
      createCompany(sandboxDeps({ world }), TENANT, {
        ...intake(newParty(), { names: SECOND_NAMES }),
        for: undefined,
      }),
    );
    const edit = {
      names: options("Acme LLC"),
      businessPurpose: "Corrected purpose.",
      industryLabel: DEFAULT_INDUSTRY,
    };

    expect(updateCompanyIntake(sandboxDeps({ world }), TENANT, legalBody, edit)).toEqual({
      error: companyNameEndingRefusedMessage(1),
    });
    expect(companies.find(legalBody)!.nameOptions.map((o) => o.name)).toEqual(NAMES);

    expect(updateCompanyIntake(sandboxDeps({ world }), TENANT, agent, edit)).toEqual({
      companyId: agent,
    });
    expect(companies.find(agent)!.nameOptions.map((o) => o.name)).toEqual([
      "Acme",
      "Acme Two",
      "Acme Three",
    ]);
  });
});
