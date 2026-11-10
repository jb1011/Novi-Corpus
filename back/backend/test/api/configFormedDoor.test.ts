/**
 * `/config.legalBodies.formedDoor` and `/config.legalBodies.filingWorkingDays`: whether the web app
 * shows the door that forms a company through doola, and how many working days its waiting screen
 * says a filing usually takes.
 *
 * `formedDoor` is one of three words. On a sandbox deployment the door is `offered` wherever doola
 * is configured and `hidden` otherwise. On a production deployment it is `offered` only when every
 * gate holds: doola pinned to production, a deployment that charges, both legal texts approved, the
 * guardian identity record wired, invite codes required, and the formed legal bodies below the total
 * cap. When the cap is the only gate that fails it reads `cap_reached`; otherwise `hidden`. Invite
 * codes are not wired yet (trust-and-access PR 2b), so on production the door stays hidden for now.
 *
 * Both legal texts are drafts today, so a production deployment that offers the door can only be
 * shown with them approved: the two text modules are replaced here by copies whose status each test
 * sets. The database is real (in memory); every address is a placeholder and every name an
 * invention.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DoolaEnvironment } from "../../src/adapters/doola/types";
import { type ApiDeps, buildApiApp, legalBodyConfigOf } from "../../src/api/app";
import { loadConfig } from "../../src/config/env";
import { companyNameOptions } from "../../src/formation/intake";
import { parsePiiKey } from "../../src/formation/pii";
import type { IdentityDeps } from "../../src/identity/state";
import type { LegalTextStatus } from "../../src/legalBody/texts/index";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import type { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import { paymentCfg } from "../helpers/formationPayment";
import {
  type LegalBodyStores,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** The status each of the two texts reads as in a test: approved unless the test says otherwise. */
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

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const TENANT = "0x00000000000000000000000000000000000000a1";
const OTHER_TENANT = "0x00000000000000000000000000000000000000a2";

/** A constant test key: the identity deps are only ever checked for presence here. */
const RING = { current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY") };

let db: Database.Database;
let s: LegalBodyStores;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  texts.agreement = "approved";
  texts.statement = "approved";
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

interface FormationOptions {
  /** The environment doola is pinned to. */
  pin: DoolaEnvironment;
  /** Whether the deployment charges. Absent: no payment config at all. */
  paymentRequired?: boolean;
  /** FORMATION_MAX_TOTAL. Absent: the setting does not exist yet, and nothing caps the door. */
  maxTotal?: number;
  /** FORMATION_FILING_WORKING_DAYS. */
  filingWorkingDays?: number;
}

/** The formation deps of a deployment where doola is configured, over this test's database. */
function formationDeps(o: FormationOptions): NonNullable<ApiDeps["formation"]> {
  const parties = new SqliteFormationPartyRepository(db);
  const requests = new SqliteFormationRepository(db);
  const payment =
    o.paymentRequired === undefined
      ? undefined
      : paymentCfg(new SqliteFormationPaymentRepository(db), { required: o.paymentRequired });
  const pin = { provider: "doola", environment: o.pin } as const;
  const limits = { maxPerTenant: 3, dailyCeiling: 10 };
  return {
    environment: o.pin,
    required: true,
    sandboxSyntheticPii: o.pin === "sandbox",
    ...limits,
    maxAgentsPerCompany: 10,
    parties,
    requests,
    companies: s.companies,
    pin,
    companyDeps: {
      companies: s.companies,
      parties,
      requests,
      pin,
      sandboxSyntheticPii: o.pin === "sandbox",
      ...limits,
      payment,
    },
    payment,
    feeUsdc: 399,
    ...(o.maxTotal === undefined ? {} : { maxTotal: o.maxTotal }),
    ...(o.filingWorkingDays === undefined ? {} : { filingWorkingDays: o.filingWorkingDays }),
  };
}

/** The guardian identity record's deps: wired wherever the PII key is set. */
function identityDeps(): IdentityDeps {
  return {
    repo: new SqliteIdentityRepository(db),
    pii: RING,
    reverifyYears: 3,
    blockedCountries: new Set(["CUB", "IRN", "PRK"]),
  };
}

interface Deployment {
  environment: "sandbox" | "production";
  formation?: NonNullable<ApiDeps["formation"]>;
  identity?: IdentityDeps;
  invites?: ApiDeps["invites"];
}

/** Every gate of a production deployment met: the starting point each production test takes one
 *  thing away from. */
function productionWithEveryGate(over: Partial<Deployment> = {}): Deployment {
  return {
    environment: "production",
    formation: formationDeps({ pin: "production", paymentRequired: true, maxTotal: 2 }),
    identity: identityDeps(),
    invites: { required: true },
    ...over,
  };
}

/** The API over this test's database with the legal-body feature on in `d.environment`. */
function makeApp(d: Deployment) {
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo: new SqliteEntityRepository(db),
    companies: s.companies,
    documents: new SqliteDocumentIndexRepository(db),
    docStore: new DeletableMemoryDocumentStore(),
    customerFacts: { declarations: s.declarations, checks: s.checks },
    legalBodyOrders: legalBodyOrderDeps(s, { environment: d.environment }),
    formation: d.formation,
    identity: d.identity,
    invites: d.invites,
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}

/** `/config.legalBodies` of the deployment, read without a session. */
async function legalBodiesOf(d: Deployment) {
  const res = await makeApp(d).request("/config", { method: "GET" });
  expect(res.status).toBe(200);
  return (await res.json()).legalBodies;
}

const formedDoorOf = async (d: Deployment) => (await legalBodiesOf(d)).formedDoor;

/** One formed legal-body company that takes a place under the total cap: provider doola, purpose
 *  legal_body, ready. */
function formedLegalBody(companies: SqliteCompanyRepository, tenantId = TENANT): string {
  return companies.create({
    tenantId,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Example Works", "Example Labs", "Example Studio"),
    businessPurpose: "Example purpose.",
    industryLabel: "Software development",
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
}

// ── formedDoor ───────────────────────────────────────────────────────────────────────────────

describe("formedDoor on a sandbox deployment", () => {
  test("offered where doola is configured, hidden where it is not", async () => {
    expect(
      await formedDoorOf({ environment: "sandbox", formation: formationDeps({ pin: "sandbox" }) }),
    ).toBe("offered");
    expect(await formedDoorOf({ environment: "sandbox" })).toBe("hidden");
  });

  test("a sandbox serves draft texts, takes no identity record nor invite, and reads no count", async () => {
    texts.agreement = "draft";
    texts.statement = "draft";
    const formation = formationDeps({ pin: "sandbox", maxTotal: 1 });
    formedLegalBody(s.companies);
    const count = vi.spyOn(s.companies, "countChargeableFormedLegalBodies");
    expect(await formedDoorOf({ environment: "sandbox", formation })).toBe("offered");
    expect(count).not.toHaveBeenCalled();
  });

  test("doola pinned to production on a sandbox network is held to the production rule (formedDoorEnvironment)", async () => {
    const productionPin = formationDeps({ pin: "production" });
    expect(await formedDoorOf({ environment: "sandbox", formation: productionPin })).toBe("hidden");
    // …the production rule, not a sandbox that hides: with every production gate met it is offered.
    expect(
      await formedDoorOf({
        ...productionWithEveryGate(),
        environment: "sandbox",
      }),
    ).toBe("offered");
  });
});

describe("formedDoor on a production deployment", () => {
  test("every gate met, below the cap: offered", async () => {
    formedLegalBody(s.companies);
    expect(await formedDoorOf(productionWithEveryGate())).toBe("offered");
  });

  test("a draft agreement or a draft statement of authority: hidden", async () => {
    texts.agreement = "draft";
    expect(await formedDoorOf(productionWithEveryGate())).toBe("hidden");
    texts.agreement = "approved";
    texts.statement = "draft";
    expect(await formedDoorOf(productionWithEveryGate())).toBe("hidden");
  });

  test("at the cap, with every other gate met: cap_reached", async () => {
    formedLegalBody(s.companies);
    formedLegalBody(s.companies, OTHER_TENANT);
    expect(await formedDoorOf(productionWithEveryGate())).toBe("cap_reached");
  });

  test("at the cap with another gate failing too: hidden, never cap_reached", async () => {
    formedLegalBody(s.companies);
    formedLegalBody(s.companies);
    texts.statement = "draft";
    expect(await formedDoorOf(productionWithEveryGate())).toBe("hidden");
  });

  test("without invite codes wired (trust-and-access PR 2b not built), every other gate met: hidden", async () => {
    expect(await formedDoorOf(productionWithEveryGate({ invites: undefined }))).toBe("hidden");
    expect(await formedDoorOf(productionWithEveryGate({ invites: { required: false } }))).toBe(
      "hidden",
    );
  });

  test("each other gate missing on its own: hidden", async () => {
    const missing: [gate: string, deployment: Deployment][] = [
      ["doola not configured", productionWithEveryGate({ formation: undefined })],
      [
        "doola pinned to its sandbox",
        productionWithEveryGate({
          formation: formationDeps({ pin: "sandbox", paymentRequired: true, maxTotal: 2 }),
        }),
      ],
      [
        "a deployment that does not charge",
        productionWithEveryGate({
          formation: formationDeps({ pin: "production", paymentRequired: false, maxTotal: 2 }),
        }),
      ],
      [
        "no payment config",
        productionWithEveryGate({
          formation: formationDeps({ pin: "production", maxTotal: 2 }),
        }),
      ],
      ["no identity record", productionWithEveryGate({ identity: undefined })],
    ];
    for (const [gate, deployment] of missing)
      expect(await formedDoorOf(deployment), gate).toBe("hidden");
  });

  test("the count is read only once every other gate holds", async () => {
    const count = vi.spyOn(s.companies, "countChargeableFormedLegalBodies");
    expect(await formedDoorOf(productionWithEveryGate({ identity: undefined }))).toBe("hidden");
    expect(count).not.toHaveBeenCalled();
    expect(await formedDoorOf(productionWithEveryGate())).toBe("offered");
    expect(count).toHaveBeenCalledTimes(1);
  });

  test("until FORMATION_MAX_TOTAL is set, nothing caps the door", async () => {
    for (let i = 0; i < 3; i++) formedLegalBody(s.companies);
    const uncapped = formationDeps({ pin: "production", paymentRequired: true });
    expect(await formedDoorOf(productionWithEveryGate({ formation: uncapped }))).toBe("offered");
  });

  test("legalBodyConfigOf is what /config serves", async () => {
    const d = productionWithEveryGate();
    expect(await legalBodiesOf(d)).toEqual(
      legalBodyConfigOf({
        legalBodyOrders: legalBodyOrderDeps(s, { environment: "production" }),
        formation: d.formation,
        identity: d.identity,
        invites: d.invites,
      }),
    );
  });
});

// ── filingWorkingDays ────────────────────────────────────────────────────────────────────────

describe("filingWorkingDays", () => {
  const BASE = {
    ARC_TESTNET_RPC_URL: "https://rpc.example",
    PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  };

  test("FORMATION_FILING_WORKING_DAYS is 5 unless set, and a whole number from 1 to 30", () => {
    expect(loadConfig(BASE).formation?.filingWorkingDays).toBe(5);
    expect(
      loadConfig({ ...BASE, FORMATION_FILING_WORKING_DAYS: "7" }).formation?.filingWorkingDays,
    ).toBe(7);
    expect(
      loadConfig({ ...BASE, FORMATION_FILING_WORKING_DAYS: "30" }).formation?.filingWorkingDays,
    ).toBe(30);
    for (const refused of ["0", "31", "2.5", "five"])
      expect(
        () => loadConfig({ ...BASE, FORMATION_FILING_WORKING_DAYS: refused }),
        refused,
      ).toThrow(/FORMATION_FILING_WORKING_DAYS/);
  });

  test("served from the setting where doola is configured", async () => {
    const formation = formationDeps({ pin: "sandbox", filingWorkingDays: 7 });
    expect((await legalBodiesOf({ environment: "sandbox", formation })).filingWorkingDays).toBe(7);
  });

  test("5 by default: with the setting not passed, and on a deployment with no doola", async () => {
    const formation = formationDeps({ pin: "sandbox" });
    expect((await legalBodiesOf({ environment: "sandbox", formation })).filingWorkingDays).toBe(5);
    expect((await legalBodiesOf({ environment: "sandbox" })).filingWorkingDays).toBe(5);
    expect((await legalBodiesOf(productionWithEveryGate())).filingWorkingDays).toBe(5);
  });
});
