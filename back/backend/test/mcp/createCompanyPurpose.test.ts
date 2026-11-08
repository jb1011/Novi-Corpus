/**
 * `create_company` over MCP always creates a company for agents (`purpose_kind = agent`).
 *
 * A legal-body company is asked for on `POST /companies` alone (`for: "legal_body"`), where the
 * legal-body gates run. The MCP tool has no `for` in its schema, and its schema is strict: a
 * caller that passes one gets a schema error and nothing is created, rather than a company for
 * agents it did not ask for.
 *
 * Every tenant, name and id here is an invention.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
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

/** The API with formation on a sandbox deployment that takes real (test) parties. */
function buildTestApp() {
  const requests = new SqliteFormationRepository(db);
  const pin = { provider: "doola" as const, environment: "sandbox" as const };
  const companyDeps = {
    companies,
    parties,
    requests,
    pin,
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
  };
  return buildApiApp({
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
      environment: "sandbox" as const,
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
    },
    companies,
  } as never);
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

test("the tool declares no `for`, and refuses unknown arguments", async () => {
  const tool = await withClient(
    async (c) => (await c.listTools()).tools.find((t) => t.name === "create_company")!,
  );
  expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("for");
  expect(tool.inputSchema.additionalProperties).toBe(false);
});

test("create_company with `for` answers a schema error, and nothing is created", async () => {
  const partyId = newParty();
  const res = await withClient((c) =>
    c.callTool({
      name: "create_company",
      arguments: { partyId, ...MCP_INTAKE, for: "legal_body" },
    }),
  );
  expect(isError(res)).toBe(true);
  expect(textOf(res)).toMatch(/Input validation error/);
  // The strict schema names the one key it does not know.
  expect(textOf(res)).toMatch(/"code": "unrecognized_keys"/);
  expect(textOf(res)).toMatch(/"keys": \[\s*"for"\s*\]/);
  expect(companies.listByTenant(TENANT)).toHaveLength(0);
  // The party is not spent: the same person can still be filed under a company.
  expect(parties.findOwned(TENANT, partyId)!.companyId).toBeNull();
});

test("create_company without `for` creates a company for agents", async () => {
  const partyId = newParty();
  const res = await withClient((c) =>
    c.callTool({ name: "create_company", arguments: { partyId, ...MCP_INTAKE } }),
  );
  expect(isError(res)).toBe(false);
  const { companyId } = JSON.parse(textOf(res)) as { companyId: string };
  expect(companies.find(companyId)!.purposeKind).toBe("agent");
});
