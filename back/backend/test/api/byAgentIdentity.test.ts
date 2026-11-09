/**
 * GET /legal-bodies/by-agent/:agentId and the guardian identity record: an unsigned fact beside
 * the signed statement.
 *
 * On production a body answer carries `guardianIdentityVerified`, a top-level key: true while the
 * guardian's identity record is verified at the statement's issue, false for an expired record, for
 * a tenant with no record, and where the record is not wired. The signed statement is untouched:
 * the same 33 fields under domain version "2", and the same signature whatever the fact says.
 * Statement v3, after Demo Day, signs the fact and removes this key. On a sandbox the key is absent
 * and the record is never read. The statement log's evidence records the fact as `identityVerified`.
 *
 * The statement service over a real in-memory database and a fake chain, on a fixed clock. Every
 * key is one of anvil's published test accounts, every other address a placeholder, every name and
 * filing number an invention, and the PII key a constant test key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import type { IdentityDeps } from "../../src/identity/state";
import {
  LEGAL_BODY_STATEMENT_TYPES,
  LEGAL_BODY_STATEMENT_TYPE_STRING,
  PUBLIC_STATEMENT_DOMAIN_VERSION,
  verifyPublicStatement,
} from "../../src/legalBody/publicStatement";
import { type LegalBodyStatementDeps, statementForAgent } from "../../src/legalBody/statements";
import {
  type IdentityRepository,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import {
  CHAIN_ID,
  TEST_PII_RING,
  identityOver,
  passedIdentityRow,
  recordHuman,
  recordIdentity,
} from "../helpers/customerCompanyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FakeStatementChain,
  type StatementStores,
  TENANT,
  TEST_ATTESTOR,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The 33 field names of the signed statement, in the type's order. */
const SIGNED_FIELDS = LEGAL_BODY_STATEMENT_TYPES.LegalBodyStatement.map((f) => f.name);

let s: StatementStores;
let chain: FakeStatementChain;
let identityRepo: SqliteIdentityRepository;
let identity: IdentityDeps;

beforeEach(() => {
  s = openStatementStores();
  chain = new FakeStatementChain();
  identityRepo = new SqliteIdentityRepository(s.db);
  // The statement reads the record on its own clock; this one is never consulted by it.
  identity = identityOver(identityRepo, () => CLOCK_MS);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** A passed identity record of the guardian, completed a month before the clock and due for
 *  renewal at `expiresAt`, written through the repository as the operator's command writes one. */
function passedRecord(expiresAt: number): void {
  recordIdentity(identityRepo, TENANT, { at: CLOCK_MS - 30 * DAY_MS, expiresAt });
}

/** A verified guardian: a passed record due for renewal in three years. */
const verified = (): void => passedRecord(CLOCK_MS + 3 * 365 * DAY_MS);

/** A linked row of a ready company whose check passed, for agent 42, linked on chain too. */
function linkedBody(): LegalBodyRecord {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  const row = bodyIn("linked", s, companyId);
  chain.link(row);
  return row;
}

/** The statement service of a production deployment, the identity record wired. */
const production = (over: Partial<LegalBodyStatementDeps> = {}): LegalBodyStatementDeps =>
  statementDeps(s, chain, { environment: "production", identity, ...over });

/** The API with the statement route only, over `deps`. */
const appOver = (deps: LegalBodyStatementDeps) =>
  buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: "s",
    now: () => CLOCK_MS,
    legalBodyStatements: deps,
  } as never);

// biome-ignore lint/suspicious/noExplicitAny: a JSON answer, read field by field
type Json = Record<string, any>;

async function answerOf(deps: LegalBodyStatementDeps, agentId = "42"): Promise<Json> {
  const res = await appOver(deps).request(`/legal-bodies/by-agent/${agentId}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("on production the body answer states guardianIdentityVerified, unsigned", () => {
  test("a verified guardian: true, a top-level key beside the statement, which is untouched", async () => {
    linkedBody();
    verified();
    const body = await answerOf(production());
    expect(body.guardianIdentityVerified).toBe(true);
    expect(Object.keys(body)).toEqual([
      "agentId",
      "legalBody",
      "standing",
      "publicId",
      "network",
      "links",
      "checkedAt",
      "guardianIdentityVerified",
      "statement",
      "treasury",
    ]);

    // The signed statement: its 33 fields, none of them the new fact, under domain version "2".
    expect(SIGNED_FIELDS).toHaveLength(33);
    expect(Object.keys(body.statement.message)).toEqual(SIGNED_FIELDS);
    expect("guardianIdentityVerified" in body.statement.message).toBe(false);
    expect(LEGAL_BODY_STATEMENT_TYPE_STRING).not.toContain("guardianIdentityVerified");
    expect(PUBLIC_STATEMENT_DOMAIN_VERSION).toBe("2");
    expect(body.statement.domain.version).toBe("2");
    expect(Object.keys(body.statement)).toEqual([
      "domain",
      "primaryType",
      "message",
      "attestor",
      "signature",
    ]);
    expect(body.statement.message.environment).toBe("production");
    await expect(
      verifyPublicStatement(body.statement, {
        attestor: TEST_ATTESTOR.address,
        expectedChainId: CHAIN_ID,
        nowSeconds: CLOCK_S,
      }),
    ).resolves.toBe(true);
  });

  test("an expired record: false", async () => {
    linkedBody();
    passedRecord(CLOCK_MS - DAY_MS);
    expect((await answerOf(production())).guardianIdentityVerified).toBe(false);
  });

  test("a guardian with no identity record: false", async () => {
    linkedBody();
    expect((await answerOf(production())).guardianIdentityVerified).toBe(false);
  });

  test("a body row whose tenant id an older version kept in lower case: the record is read under the checksummed spelling", async () => {
    const row = linkedBody();
    verified();
    // An older version could store a tenant id unchecksummed; the column is write-once now, so the
    // test lifts that guard to make the legacy row.
    s.db.exec("DROP TRIGGER trg_legal_bodies_write_once");
    s.db
      .prepare(
        "UPDATE legal_bodies SET tenant_id = lower(tenant_id), guardian = lower(guardian) WHERE legal_body_id = ?",
      )
      .run(row.legalBodyId);
    expect(TENANT.toLowerCase()).not.toBe(TENANT);

    expect((await answerOf(production())).guardianIdentityVerified).toBe(true);
  });

  test("a second human who verified World ID on the account since is not the record's person: false; the same human again: true", async () => {
    linkedBody();
    // The record copies the nullifier of the World row the fixture records for the tenant.
    recordIdentity(identityRepo, TENANT, {
      at: CLOCK_MS - 30 * DAY_MS,
      expiresAt: CLOCK_MS + 3 * 365 * DAY_MS,
      nullifier: `nullifier-${TENANT.toLowerCase()}`,
    });
    expect((await answerOf(production())).guardianIdentityVerified).toBe(true);

    // The same human verifying again: the same nullifier, a newer row.
    recordHuman(s.store, TENANT, `nullifier-${TENANT.toLowerCase()}`, CLOCK_MS - 30_000);
    expect((await answerOf(production())).guardianIdentityVerified).toBe(true);

    // Another person's World ID verification on the same account, newer still.
    recordHuman(s.store, TENANT, "nullifier-second-human", CLOCK_MS - 10_000);
    expect((await answerOf(production())).guardianIdentityVerified).toBe(false);
  });

  test("a test record on production, written on a sandbox or synthetic: false", async () => {
    linkedBody();
    const at = CLOCK_MS - 30 * DAY_MS;
    const expiresAt = CLOCK_MS + 3 * 365 * DAY_MS;
    const event = {
      kind: "recorded" as const,
      at,
      actor: "ops.example",
      actorOsUser: "ops",
      reasonCode: null,
      reason: null,
    };
    identityRepo.append(
      { ...passedIdentityRow(TENANT, { at, expiresAt }), environment: "sandbox", synthetic: true },
      event,
    );
    expect((await answerOf(production())).guardianIdentityVerified).toBe(false);
    identityRepo.append(
      { ...passedIdentityRow(TENANT, { at, expiresAt }), synthetic: true },
      event,
    );
    expect((await answerOf(production())).guardianIdentityVerified).toBe(false);
  });

  test("the identity record not wired: false", async () => {
    linkedBody();
    verified();
    expect((await answerOf(production({ identity: undefined }))).guardianIdentityVerified).toBe(
      false,
    );
  });

  test("the signed statement is the same, signature and all, whether the guardian's identity is verified or not", async () => {
    linkedBody();
    const unverifiedOut = await statementForAgent(production(), "42");
    verified();
    const verifiedOut = await statementForAgent(production(), "42");
    if (unverifiedOut.kind !== "statement" || verifiedOut.kind !== "statement")
      throw new Error("expected two statements");
    expect(unverifiedOut.guardianIdentityVerified).toBe(false);
    expect(verifiedOut.guardianIdentityVerified).toBe(true);
    expect(verifiedOut.statement).toEqual(unverifiedOut.statement);
  });

  test("the statement log's evidence records the fact as identityVerified", async () => {
    const row = linkedBody();
    verified();
    await answerOf(production());
    expect(s.statements.latest(row.legalBodyId)?.evidence).toMatchObject({
      humanVerified: true,
      identityVerified: true,
    });
  });

  test("an answer with no legal body carries no such key", async () => {
    const body = await answerOf(production(), "7");
    expect(body).toMatchObject({ agentId: "7", legalBody: false });
    expect("guardianIdentityVerified" in body).toBe(false);
  });
});

describe("on a sandbox the key is absent and the identity record is never read", () => {
  test("no guardianIdentityVerified in the body answer, without one identity read; the evidence records false", async () => {
    const row = linkedBody();
    let reads = 0;
    const refuse = (): never => {
      reads += 1;
      throw new Error("a sandbox statement read the identity record");
    };
    const repo: IdentityRepository = {
      append: refuse,
      latest: refuse,
      list: refuse,
      events: refuse,
      findById: refuse,
      passedElsewhere: refuse,
      eraseNames: refuse,
      erasureCandidates: refuse,
      transaction: refuse,
    };
    const untouchable: IdentityDeps = {
      repo,
      pii: TEST_PII_RING,
      reverifyYears: 3,
      blockedCountries: new Set(),
      now: refuse,
    };
    const body = await answerOf(statementDeps(s, chain, { identity: untouchable }));
    expect(body.legalBody).toBe(true);
    expect("guardianIdentityVerified" in body).toBe(false);
    expect(Object.keys(body.statement.message)).toEqual(SIGNED_FIELDS);
    expect(reads).toBe(0);
    expect(s.statements.latest(row.legalBodyId)?.evidence).toMatchObject({
      identityVerified: false,
    });
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the other composition guards do: the statement is handed the identity record main.ts builds
 * where the PII key is set.
 */
test("the composition root hands the statement the identity record", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const at = main.indexOf("const legalBodyStatements: LegalBodyStatementDeps | undefined =");
  expect(at, "the statement deps were not found").toBeGreaterThan(0);
  const statements = main.slice(at, main.indexOf(": undefined;", at));
  expect(statements).toMatch(/^ {10}identity,$/m);
  expect(main.indexOf("const identity: IdentityDeps | undefined = cfg.pii")).toBeLessThan(at);
});
