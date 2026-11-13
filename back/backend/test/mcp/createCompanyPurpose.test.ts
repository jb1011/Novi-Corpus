/**
 * `create_company` over MCP always creates a company for agents (`purpose_kind = agent`).
 *
 * A company for a legal body is asked for on `POST /companies` alone (`for: "legal_body"`). The
 * tool declares `for` only in order to refuse it by name, the way it declares `ssn`: an argument
 * the tool does not declare is stripped and the call goes on, as it always has, so a caller that
 * passed `for` undeclared would get back a company for agents it did not ask for.
 *
 * It also holds the purpose to doola's 50-character `description` limit, in the REST door's words.
 *
 * Every tenant, name and id here is an invention.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { businessPurposeTooLongMessage } from "../../src/formation";
import { PURPOSE_MAX_LENGTH } from "../../src/formation/intake";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";

const MCP_INTAKE = {
  names: ["Acme Robotics LLC", "Acme Automata", "Acme Mechanicals"],
  businessPurpose: "Operating software agents.",
  industryLabel: "Software development",
};

let db: Database.Database;
let parties: SqliteFormationPartyRepository;
let companies: SqliteCompanyRepository;
let apiKeys: SqliteApiKeyStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  parties = new SqliteFormationPartyRepository(db);
  companies = new SqliteCompanyRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
});
afterEach(() => db.close());

/** The API with formation on a sandbox deployment that takes real (test) parties: only the
 *  dependencies the MCP door reads, each of its declared type. */
function buildTestApp() {
  const requests = new SqliteFormationRepository(db);
  const pin = { provider: "doola", environment: "sandbox" } as const;
  const companyDeps = {
    companies,
    parties,
    requests,
    pin,
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
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
    fullProductAvailable: true,
    turnkeyCustodyAvailable: true,
    formation: {
      environment: "sandbox",
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

/** A responsible party of the tenant's, as `create_formation_party` would have registered it. */
function newParty(): string {
  return parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
}

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]?.text ?? "";
const isError = (res: unknown) => (res as { isError?: boolean }).isError === true;

async function withClient<T>(
  fn: (c: Awaited<ReturnType<typeof startMcpTestClient>>["client"]) => Promise<T>,
): Promise<T> {
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { client, close } = await startMcpTestClient(buildTestApp(), key);
  try {
    return await fn(client);
  } finally {
    await close();
  }
}

test("create_company refuses `for` by name, whatever its value, and creates nothing", async () => {
  const partyId = newParty();
  await withClient(async (c) => {
    for (const value of ["legal_body", "agent"]) {
      const res = await c.callTool({
        name: "create_company",
        arguments: { partyId, ...MCP_INTAKE, for: value },
      });
      expect(isError(res), value).toBe(true);
      // The refusal is the whole answer: the table's sentence, which says what this tool makes.
      expect(textOf(res), value).toBe(LEGAL_BODY_SENTENCES.create_company_agents_only);
    }
  });
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
  // The party is not spent: the same person can still be filed under a company.
  expect(parties.findOwned(TENANT, partyId)!.companyId).toBeNull();
});

test("create_company without `for` creates a company for agents, and an unknown argument is still let through", async () => {
  const plain = await withClient((c) =>
    c.callTool({ name: "create_company", arguments: { partyId: newParty(), ...MCP_INTAKE } }),
  );
  expect(isError(plain)).toBe(false);
  const { companyId } = JSON.parse(textOf(plain)) as { companyId: string };
  expect(companies.find(companyId)!.purposeKind).toBe("agent");

  // An argument the tool does not declare is dropped, as before this tool knew about purposes.
  const extra = await withClient((c) =>
    c.callTool({
      name: "create_company",
      arguments: {
        partyId: newParty(),
        ...MCP_INTAKE,
        names: ["Beta Works", "Beta Systems", "Beta Foundry"],
        nickname: "an argument the tool does not declare",
      },
    }),
  );
  expect(isError(extra)).toBe(false);
  const { companyId: extraId } = JSON.parse(textOf(extra)) as { companyId: string };
  expect(companies.find(extraId)!.purposeKind).toBe("agent");
});

test("create_company holds the purpose to doola's 50-character limit, says so, and refuses in the REST sentence", async () => {
  // The purpose is filed verbatim as doola's `description` (documented maximum 50). The tool's
  // description is an agent's only discovery surface for that rule, so it states the number, and
  // the refusal is the same sentence `POST /companies` gives, from the same domain function.
  await withClient(async (c) => {
    const { tools } = await c.listTools();
    const tool = tools.find((t) => t.name === "create_company")!;
    expect(tool.description).toContain(`at most ${PURPOSE_MAX_LENGTH} characters`);
    expect(PURPOSE_MAX_LENGTH).toBe(50);

    const refused = await c.callTool({
      name: "create_company",
      arguments: {
        partyId: newParty(),
        ...MCP_INTAKE,
        businessPurpose: "x".repeat(PURPOSE_MAX_LENGTH + 1),
      },
    });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toBe(businessPurposeTooLongMessage(PURPOSE_MAX_LENGTH));
    expect(textOf(refused)).toBe("businessPurpose is longer than 50 characters");
    expect(companies.listByTenant(TENANT)).toHaveLength(0);

    const exactly = "y".repeat(PURPOSE_MAX_LENGTH);
    const ok = await c.callTool({
      name: "create_company",
      arguments: { partyId: newParty(), ...MCP_INTAKE, businessPurpose: exactly },
    });
    expect(isError(ok)).toBe(false);
    const { companyId } = JSON.parse(textOf(ok)) as { companyId: string };
    expect(companies.find(companyId)!.businessPurpose).toBe(exactly);
  });
});
