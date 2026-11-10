/**
 * The two MCP party tools on production: the responsible person's names are written from the
 * guardian's verified identity record, never typed, exactly as on REST.
 *
 * On a production deployment, `create_formation_party` and `update_company_party` answer
 * `party_name_is_written_by_novi` (its code and its fixed sentence, as one JSON object) before
 * anything else when a name argument is present, at the ssn refusal's position; the World and
 * identity gates answer their own code and message the same way. Without a name, the party's
 * names are the record's, and the edit leaves them as they are. A sandbox deployment is as before.
 *
 * Every tenant, name and id here is an invention, the PII key a constant test key.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  NAMES_OF_RECORD,
  identityOver,
  recordHuman,
  recordIdentity,
  worldFor,
} from "../helpers/customerCompanyFixtures";
import { startMcpTestClient } from "./helpers";

const TENANT = getAddress("0x00000000000000000000000000000000000000f1");
const NULLIFIER = "5001";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A party as a production caller sends it: everything but the names. */
const PARTY = {
  email: "person@example.com",
  phone: "+12125550100",
  address: {
    line1: "1 Example Way",
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
  },
};
const EDIT = { ...PARTY, email: "other@example.com" };

let db: Database.Database;
let parties: SqliteFormationPartyRepository;
let companies: SqliteCompanyRepository;
let apiKeys: SqliteApiKeyStore;
let store: SqliteWorldStore;
let identityRepo: SqliteIdentityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
  companies = new SqliteCompanyRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  store = new SqliteWorldStore(db);
  identityRepo = new SqliteIdentityRepository(db);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The API with formation on: production unless told otherwise. A sandbox here takes test
 *  bodies (no synthetic rule), so a name argument reaches the edit tool's schema. */
function buildTestApp(environment: "sandbox" | "production" = "production") {
  const requests = new SqliteFormationRepository(db);
  const pin = { provider: "doola", environment } as const;
  const companyDeps = {
    companies,
    parties,
    requests,
    pin,
    legalBodyEnvironment: environment,
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    world: worldFor(store),
    identity: identityOver(identityRepo, () => Date.now()),
  };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: "wizard.local",
    chainId: 5042002,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo: new SqliteEntityRepository(db),
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    platformManagerAddress: "0x000000000000000000000000000000000000000E",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: true,
    turnkeyCustodyAvailable: true,
    formation: {
      environment,
      required: true,
      sandboxSyntheticPii: false,
      maxPerTenant: 3,
      dailyCeiling: 10,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin,
      companyDeps,
      feeUsdc: 399,
    },
    companies,
  };
  return buildApiApp(deps as ApiDeps);
}

/** The guardian is a real human with a passed identity record holding NAMES_OF_RECORD. */
function verified(): void {
  recordHuman(store, TENANT, NULLIFIER, Date.now() - DAY_MS);
  recordIdentity(identityRepo, TENANT, {
    at: Date.now() - 30 * DAY_MS,
    expiresAt: Date.now() + 3 * 365 * DAY_MS,
    nullifier: NULLIFIER,
  });
}

/** A ready formed legal-body company of the tenant, its party bound and named from the record. */
function formedCompany(): { companyId: string; partyId: string } {
  const partyId = parties.create({
    tenantId: TENANT,
    legalFirstName: NAMES_OF_RECORD.first,
    legalLastName: NAMES_OF_RECORD.last,
    email: PARTY.email,
    phone: PARTY.phone,
    line1: PARTY.address.line1,
    line2: null,
    city: PARTY.address.city,
    region: PARTY.address.region,
    postalCode: PARTY.address.postalCode,
    country: PARTY.address.country,
    synthetic: false,
  });
  const companyId = companies.create({
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Example Works", "Example Labs", "Example Studio"),
    businessPurpose: "Operating software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
  expect(parties.bindToCompany(partyId, companyId, TENANT)).toBe(true);
  return { companyId, partyId };
}

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]?.text ?? "";
const isError = (res: unknown) => (res as { isError?: boolean }).isError === true;
const partyRows = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM formation_parties").get() as { n: number }).n;

async function withClient<T>(
  app: ReturnType<typeof buildTestApp>,
  fn: (c: Awaited<ReturnType<typeof startMcpTestClient>>["client"]) => Promise<T>,
): Promise<T> {
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(app, key);
  try {
    return await fn(client);
  } finally {
    await close();
  }
}

/** The refusal of a name argument: the code and its fixed sentence, as one JSON object. */
const NAME_REFUSAL = {
  code: "party_name_is_written_by_novi",
  message: LEGAL_BODY_SENTENCES.party_name_is_written_by_novi,
};

describe("create_formation_party on production", () => {
  test("a name argument is refused with the code and its sentence before anything else, the gates included", async () => {
    // No World row and no record: the name refusal still comes first, at the ssn refusal's place.
    await withClient(buildTestApp(), async (c) => {
      for (const names of [
        { legalFirstName: "Someone" },
        { legalLastName: "Else" },
        { legalFirstName: "Someone", legalLastName: "Else" },
      ]) {
        const res = await c.callTool({
          name: "create_formation_party",
          arguments: { ...PARTY, ...names },
        });
        expect(isError(res)).toBe(true);
        expect(JSON.parse(textOf(res))).toEqual(NAME_REFUSAL);
      }
    });
    expect(partyRows()).toBe(0);
  });

  test("the World and identity gates answer their code and message, as the doors do", async () => {
    const app = buildTestApp();
    const noWorld = await withClient(app, (c) =>
      c.callTool({ name: "create_formation_party", arguments: PARTY }),
    );
    expect(isError(noWorld)).toBe(true);
    expect(JSON.parse(textOf(noWorld))).toEqual({
      code: "guardian_not_verified",
      message: "the guardian must complete World ID verification first",
    });

    recordHuman(store, TENANT, NULLIFIER, Date.now() - DAY_MS);
    const noRecord = await withClient(app, (c) =>
      c.callTool({ name: "create_formation_party", arguments: PARTY }),
    );
    expect(JSON.parse(textOf(noRecord))).toEqual({
      code: "guardian_identity_not_verified",
      message: "the guardian must complete identity verification first, in the browser",
    });
    expect(partyRows()).toBe(0);
  });

  test("without names, the party holds the record's names, and the answer is the handle alone", async () => {
    verified();
    const res = await withClient(buildTestApp(), (c) =>
      c.callTool({
        name: "create_formation_party",
        arguments: { ...PARTY, marketingConsent: true },
      }),
    );
    expect(isError(res)).toBe(false);
    const body = JSON.parse(textOf(res)) as { partyId: string };
    expect(Object.keys(body)).toEqual(["partyId"]);
    const row = parties.findOwned(TENANT, body.partyId)!;
    expect(row).toMatchObject({
      legalFirstName: NAMES_OF_RECORD.first,
      legalLastName: NAMES_OF_RECORD.last,
      email: PARTY.email,
    });
    expect(row.marketingConsentAt).not.toBeNull();
  });
});

describe("update_company_party on production", () => {
  test("a name argument is refused with the code and its sentence, and nothing moves", async () => {
    verified();
    const { companyId, partyId } = formedCompany();
    const res = await withClient(buildTestApp(), (c) =>
      c.callTool({
        name: "update_company_party",
        arguments: { companyId, ...EDIT, legalFirstName: "Someone" },
      }),
    );
    expect(isError(res)).toBe(true);
    expect(JSON.parse(textOf(res))).toEqual(NAME_REFUSAL);
    expect(parties.findOwned(TENANT, partyId)!.email).toBe(PARTY.email);
  });

  test("without names the other fields move and the names stay; the name arguments are optional", async () => {
    verified();
    const { companyId, partyId } = formedCompany();
    const app = buildTestApp();
    await withClient(app, async (c) => {
      const tool = (await c.listTools()).tools.find((t) => t.name === "update_company_party")!;
      expect(tool.inputSchema.required ?? []).not.toContain("legalFirstName");
      expect(tool.inputSchema.required ?? []).not.toContain("legalLastName");

      const res = await c.callTool({
        name: "update_company_party",
        arguments: { companyId, ...EDIT },
      });
      expect(isError(res)).toBe(false);
      expect(JSON.parse(textOf(res))).toEqual({ partyId });
    });
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      email: EDIT.email,
      legalFirstName: NAMES_OF_RECORD.first,
      legalLastName: NAMES_OF_RECORD.last,
    });
  });

  test("without a World row the gate answers its code and message, and nothing moves", async () => {
    const { companyId, partyId } = formedCompany();
    const res = await withClient(buildTestApp(), (c) =>
      c.callTool({ name: "update_company_party", arguments: { companyId, ...EDIT } }),
    );
    expect(JSON.parse(textOf(res))).toEqual({
      code: "guardian_not_verified",
      message: "the guardian must complete World ID verification first",
    });
    expect(parties.findOwned(TENANT, partyId)!.email).toBe(PARTY.email);
  });
});

describe("a sandbox that takes test bodies", () => {
  test("create_formation_party writes the typed names, with no World and no record", async () => {
    const res = await withClient(buildTestApp("sandbox"), (c) =>
      c.callTool({
        name: "create_formation_party",
        arguments: { ...PARTY, legalFirstName: "Someone", legalLastName: "Else" },
      }),
    );
    expect(isError(res)).toBe(false);
    const { partyId } = JSON.parse(textOf(res)) as { partyId: string };
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      legalFirstName: "Someone",
      legalLastName: "Else",
      marketingConsentAt: null,
    });
  });

  test("update_company_party refuses a name argument, naming it, and moves nothing", async () => {
    const { companyId, partyId } = formedCompany();
    const res = await withClient(buildTestApp("sandbox"), (c) =>
      c.callTool({
        name: "update_company_party",
        arguments: { companyId, ...EDIT, legalLastName: "Else" },
      }),
    );
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain("legalLastName");
    expect(parties.findOwned(TENANT, partyId)!.email).toBe(PARTY.email);
  });
});
