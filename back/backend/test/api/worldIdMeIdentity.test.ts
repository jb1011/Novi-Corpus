import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { signSession } from "../../src/auth/session";
import { type PiiKeyring, encryptText, parsePiiKey } from "../../src/formation/pii";
import { IDENTITY_AAD } from "../../src/identity/names";
import type { IdentityDeps } from "../../src/identity/state";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import {
  type NewGuardianIdentityCheck,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import { customerCompanyDeps, recordHuman, worldFor } from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import {
  type Json,
  type LegalBodyStores,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/**
 * `GET /world-id/me` carries the guardian's own `identity` block, so the browser can show where the
 * identity check stands and, once verified, the names the declaration will carry; `GET /config`
 * says whether this deployment requires the check (`legalBodies.identityRequired`). The block is
 * answered under the same condition as `realHuman`: wherever a legal-body door gives the
 * deployment an environment. It never carries the full name, the provider or the country.
 *
 * The database is real (in memory). Every name is a made-up fixture, every tenant an invented
 * address, and the PII key a constant test key.
 */

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const DAY = 86_400_000;
/** 10 November 2026, 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 10, 12);
const EXPIRES = Date.UTC(2029, 10, 10, 12);
/** The clock the identity state reads: a month after the record was written. */
const NOW = T0 + 30 * DAY;
const RING: PiiKeyring = {
  current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY"),
};
const FIRST = "Jean";
const LAST = "Dupont";
const FULL = "Jean Pierre Dupont";
const COUNTRY = "FRA";
/** Tenant ids as the session spells them: EIP-55 checksummed. */
const VERIFIED = getAddress("0x00000000000000000000000000000000000000e1");
const OTHER = getAddress("0x00000000000000000000000000000000000000e2");

type Environment = "sandbox" | "production";
type Door = "legalBodyOrders" | "customerCompanies";

let db: Database.Database;
let s: LegalBodyStores;
let repo: SqliteIdentityRepository;
let identity: IdentityDeps;
let world: WorldIdDeps;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  repo = new SqliteIdentityRepository(db);
  identity = {
    repo,
    pii: RING,
    reverifyYears: 3,
    blockedCountries: new Set(["CUB", "IRN", "PRK"]),
    now: () => NOW,
  };
  world = worldFor(s.store);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The tenant's names of record, encrypted as the operator's command encrypts them. */
function sealedNames(tenantId: string) {
  const seal = (field: "first" | "last" | "full", value: string) => {
    const { ciphertext, iv } = encryptText(RING, value, IDENTITY_AAD(tenantId, field));
    return { ciphertext, iv };
  };
  return {
    first: seal("first", FIRST),
    last: seal("last", LAST),
    full: seal("full", FULL),
    keyId: RING.current.id,
  };
}

/** A passed identity record of the tenant, its World row beside it. */
function verifiedGuardian(tenantId: Address, over: Partial<NewGuardianIdentityCheck> = {}): void {
  recordHuman(s.store, tenantId, `0xnullifier-${tenantId}`, T0);
  const check: NewGuardianIdentityCheck = {
    nullifier: `0xnullifier-${tenantId}`,
    tenantId,
    provider: "stripe",
    providerRef: "vs_example",
    subject: null,
    status: "passed",
    supersedesCheckId: null,
    startedAt: T0,
    completedAt: T0,
    expiresAt: EXPIRES,
    names: sealedNames(tenantId),
    nameHmac: "e".repeat(64),
    documentCountry: COUNTRY,
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: "clear",
    reviewReasons: [],
    environment: "production",
    synthetic: false,
    operator: "ops.example",
    operatorOsUser: "ops",
    ...over,
  };
  repo.append(check, {
    kind: "recorded",
    at: T0,
    actor: "ops.example",
    actorOsUser: "ops",
    reasonCode: null,
    reason: null,
  });
}

/** The API over this test's database: World ID, the identity record unless `identityDeps` is
 *  null, and the one door named, on `environment` (no door when `door` is undefined). */
function makeApp(
  door: Door | undefined,
  environment: Environment,
  identityDeps: IdentityDeps | null = identity,
) {
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new DeletableMemoryDocumentStore();
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo: new SqliteEntityRepository(db),
    docStore,
    worldId: world,
    identity: identityDeps ?? undefined,
    legalBodyOrders:
      door === "legalBodyOrders" ? legalBodyOrderDeps(s, { world, environment }) : undefined,
    customerCompanies:
      door === "customerCompanies"
        ? { ...customerCompanyDeps(s, Date.now, { world, environment }), documents, docStore }
        : undefined,
  };
  return buildApiApp(deps as ApiDeps);
}

/** The tenant's `GET /world-id/me` answer, and its raw text. */
async function me(
  app: ReturnType<typeof makeApp>,
  tenantId: Address,
): Promise<{ body: Json; text: string }> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  const res = await app.request("/world-id/me", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const text = await res.text();
  return { body: JSON.parse(text), text };
}

describe.each(["legalBodyOrders", "customerCompanies"] as const)(
  "GET /world-id/me with only %s mounted",
  (door) => {
    test("a verified record on production: state verified, the first and last names, required", async () => {
      verifiedGuardian(VERIFIED);
      const { body, text } = await me(makeApp(door, "production"), VERIFIED);
      expect(body.identity).toEqual({
        required: true,
        state: "verified",
        firstName: FIRST,
        lastName: LAST,
        verifiedAt: T0,
        expiresAt: EXPIRES,
      });
      expect(body.identity.firstName).toBe("Jean");
      // Never the full name, the country or the provider, anywhere in the answer.
      expect(JSON.stringify(body)).not.toContain(FULL);
      expect(JSON.stringify(body)).not.toContain(COUNTRY);
      expect(text).not.toContain(FULL);
      expect(text).not.toContain(COUNTRY);
      expect(text).not.toContain("stripe");
    });

    test("another tenant's token sees its own state, none, and no names", async () => {
      verifiedGuardian(VERIFIED);
      recordHuman(s.store, OTHER, "0xnullifier-other", T0);
      const { body, text } = await me(makeApp(door, "production"), OTHER);
      expect(body.identity).toEqual({ required: true, state: "none" });
      expect(body.identity).not.toHaveProperty("firstName");
      expect(body.identity).not.toHaveProperty("lastName");
      expect(text).not.toContain(FIRST);
      expect(text).not.toContain(LAST);
    });

    test("a second human who verified World ID on the account since: state none, and no names", async () => {
      verifiedGuardian(VERIFIED);
      // Another person's World ID verification on the same account, newer than the first.
      recordHuman(s.store, VERIFIED, "0xnullifier-second-human", T0 + DAY);
      const { body, text } = await me(makeApp(door, "production"), VERIFIED);
      expect(body.identity).toEqual({ required: true, state: "none" });
      expect(text).not.toContain(FIRST);
      expect(text).not.toContain(LAST);
    });

    test("the same human verifying World ID again: still verified", async () => {
      verifiedGuardian(VERIFIED);
      recordHuman(s.store, VERIFIED, `0xnullifier-${VERIFIED}`, T0 + DAY);
      const { body } = await me(makeApp(door, "production"), VERIFIED);
      expect(body.identity).toMatchObject({ required: true, state: "verified", firstName: FIRST });
    });

    test("a test record on production (written on a sandbox, or synthetic): state none", async () => {
      verifiedGuardian(VERIFIED, { environment: "sandbox", synthetic: true });
      verifiedGuardian(OTHER, { synthetic: true });
      const app = makeApp(door, "production");
      for (const tenantId of [VERIFIED, OTHER])
        expect((await me(app, tenantId)).body.identity, tenantId).toEqual({
          required: true,
          state: "none",
        });
    });

    test("on sandbox the check is not required", async () => {
      verifiedGuardian(VERIFIED);
      const app = makeApp(door, "sandbox");
      expect((await me(app, VERIFIED)).body.identity.required).toBe(false);
      expect((await me(app, OTHER)).body.identity).toEqual({ required: false, state: "none" });
    });

    test("a record sealed under a key no longer configured: 503 identity_unavailable, and a CRITICAL ops line with ids only", async () => {
      verifiedGuardian(VERIFIED);
      const printed: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
      // The key the record was sealed under is gone: another key is the only one configured.
      const rotatedAway: IdentityDeps = {
        ...identity,
        pii: { current: parsePiiKey(Buffer.alloc(32, 9).toString("base64"), "FORMATION_PII_KEY") },
      };
      const { token } = await signSession(
        VERIFIED,
        JWT_SECRET,
        3600,
        Math.floor(Date.now() / 1000),
      );

      const res = await makeApp(door, "production", rotatedAway).request("/world-id/me", {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text).error).toMatchObject({
        code: "identity_unavailable",
        message: "identity verification is not configured on this deployment",
      });
      const ops = printed
        .filter((line) => line.includes('"opslog"'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(ops.filter((o) => o.opslog === "identity_names_unreadable")).toEqual([
        {
          opslog: "identity_names_unreadable",
          at: expect.any(String),
          level: "error",
          severity: "CRITICAL",
          checkId: repo.latest(VERIFIED)?.checkId,
          keyId: RING.current.id,
          tenant: VERIFIED.slice(0, 10),
        },
      ]);
      for (const line of [...printed, text]) {
        expect(line).not.toContain(FIRST);
        expect(line).not.toContain(LAST);
      }
    });

    test("without the identity record wired (a box with no PII key): the record-less answer", async () => {
      verifiedGuardian(VERIFIED);
      for (const environment of ["sandbox", "production"] as const) {
        const { body } = await me(makeApp(door, environment, null), VERIFIED);
        expect(body.identity, environment).toEqual({
          required: environment === "production",
          state: "none",
        });
      }
    });
  },
);

describe("GET /world-id/me with neither legal-body door mounted", () => {
  test("the answer carries no identity block, as it carries no realHuman", async () => {
    verifiedGuardian(VERIFIED);
    const { body } = await me(makeApp(undefined, "production"), VERIFIED);
    expect(body).not.toHaveProperty("identity");
    expect(body).not.toHaveProperty("realHuman");
  });
});

describe("GET /config legalBodies.identityRequired", () => {
  test("true on production, false on sandbox", async () => {
    const identityRequired = async (environment: Environment) => {
      const res = await makeApp("legalBodyOrders", environment).request("/config", {});
      expect(res.status).toBe(200);
      return ((await res.json()) as Json).legalBodies.identityRequired;
    };
    expect(await identityRequired("production")).toBe(true);
    expect(await identityRequired("sandbox")).toBe(false);
  });
});
