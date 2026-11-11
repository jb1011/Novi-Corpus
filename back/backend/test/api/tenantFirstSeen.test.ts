/**
 * `tenant_first_seen`: the funnel's "signed in" stage. `POST /auth/verify` records an account's
 * first sign-in once the SIWE address is known, and never moves it: a second sign-in writes
 * nothing. A sign-in that fails records nothing, and a record that cannot be written never fails
 * the sign-in. A database that already knew accounts when `migrate` created the table has each of
 * them filled in, once, at the earliest time any table holds for it.
 *
 * The key is one of anvil's published test accounts, never a real wallet; every other address is
 * a placeholder.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteTenantFirstSeenRepository,
  type TenantFirstSeenRepository,
} from "../../src/persistence/tenantFirstSeenRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";

/** anvil's published account 1. */
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
/** 2026-10-07T18:00:00Z. */
const T0 = Date.parse("2026-10-07T18:00:00.000Z");

let db: Database.Database;
let clock: number;
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  clock = T0;
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function app(tenantFirstSeen: TenantFirstSeenRepository | undefined) {
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    now: () => clock,
    tenantFirstSeen,
  } as never);
}
type App = ReturnType<typeof app>;

/** One SIWE sign-in: a nonce, the message, its signature (or a bad one), the verify. */
async function signIn(a: App, o: { badSignature?: boolean } = {}) {
  const nonce = (await (await a.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address,
    chainId: CHAIN,
    domain: DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
  });
  const signature = o.badSignature
    ? `0x${"1".repeat(130)}`
    : await account.signMessage({ message });
  return a.request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
}

const rows = () =>
  db.prepare("SELECT address, first_seen_at FROM tenant_first_seen").all() as {
    address: string;
    first_seen_at: number;
  }[];

test("two sign-ins of one account write one row, at the first sign-in's time", async () => {
  const a = app(new SqliteTenantFirstSeenRepository(db));
  expect((await signIn(a)).status).toBe(200);
  clock = T0 + 3 * 86_400_000;
  expect((await signIn(a)).status).toBe(200);

  expect(rows()).toEqual([{ address: account.address, first_seen_at: T0 }]);
});

test("the account is kept in one spelling, checksummed", async () => {
  const repo = new SqliteTenantFirstSeenRepository(db);
  expect(repo.recordFirstSeen(account.address.toLowerCase(), T0)).toBe(true);
  expect(repo.recordFirstSeen(account.address, T0 + 1)).toBe(false);
  expect(rows()).toEqual([{ address: account.address, first_seen_at: T0 }]);
  expect(repo.find(account.address.toLowerCase())).toEqual({
    address: account.address,
    firstSeenAt: T0,
  });
});

test("a sign-in that fails records nothing", async () => {
  const a = app(new SqliteTenantFirstSeenRepository(db));
  expect((await signIn(a, { badSignature: true })).status).toBe(401);
  expect(rows()).toEqual([]);
});

test("a record that cannot be written never fails the sign-in, and its ops line names no account", async () => {
  const broken: TenantFirstSeenRepository = {
    recordFirstSeen: () => {
      throw new Error(`SQLITE_BUSY while writing ${account.address}`);
    },
    find: () => undefined,
  };
  const res = await signIn(app(broken));
  expect(res.status).toBe(200);
  expect((await res.json()).address).toBe(account.address);

  const lines = printed.filter((line) => line.includes('"opslog"'));
  expect(lines.map((line) => JSON.parse(line).opslog)).toEqual(["tenant_first_seen_failed"]);
  expect(JSON.parse(lines[0] as string)).toMatchObject({ errorName: "Error" });
  for (const line of printed)
    expect(line.toLowerCase()).not.toContain(account.address.toLowerCase());
});

test("a deployment without the store signs in as before", async () => {
  expect((await signIn(app(undefined))).status).toBe(200);
  expect(rows()).toEqual([]);
});

test("a malformed account or time is refused before any write", () => {
  const repo = new SqliteTenantFirstSeenRepository(db);
  expect(() => repo.recordFirstSeen("0x1234", T0)).toThrow(/address/);
  expect(() => repo.recordFirstSeen(account.address, 0)).toThrow(/milliseconds/);
  expect(() => repo.recordFirstSeen(account.address, 1.5)).toThrow(/milliseconds/);
  expect(rows()).toEqual([]);
});

// ── A database that knew accounts before the table ───────────────────────────────────────────

/** A placeholder account, not a key anyone holds. */
const OTHER = getAddress("0x000000000000000000000000000000000000c0c0");
const FACTORY = getAddress("0x00000000000000000000000000000000000fac70");

/** The database as an earlier build left it: every table but the sign-ins, and no date for them. */
function asBeforeTheTable(): void {
  db.exec("DROP TABLE tenant_first_seen");
  db.prepare(
    "DELETE FROM meta WHERE key IN ('funnel_first_seen_since', 'funnel_first_seen_recorded_since')",
  ).run();
}

/** `ms` as SQLite's CURRENT_TIMESTAMP writes it (UTC, to the second). */
const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

let seeded = 0;
function entityOf(tenant: string | null, at: number): void {
  seeded += 1;
  db.prepare(
    `INSERT INTO entities (idempotency_key, name, status, manager, guardian, amendment_delay, ein,
                           formation_date, owner_tenant_id, created_at)
     VALUES (?, 'Example Agent', 'created', ?, ?, '172800', '00-0000000', 0, ?, ?)`,
  ).run(`entity-${seeded}`, FACTORY, FACTORY, tenant, sqlTime(at));
}

function companyOf(tenant: string, at: number): string {
  const companyId = new SqliteCompanyRepository(db).create({
    tenantId: tenant,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Example Works", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "an example purpose",
    industryLabel: "Software",
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
  db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(
    sqlTime(at),
    companyId,
  );
  return companyId;
}

/** A legal body row, its `created_at` written at the insert: the column is write-once after. */
function legalBodyOf(tenant: string, companyId: string, at: number): void {
  db.prepare(
    `INSERT INTO legal_bodies (legal_body_id, public_id, tenant_id, company_id, chain_id, factory,
                               guardian, amendment_delay, created_at)
     VALUES (?, ?, ?, ?, 5042002, ?, ?, 172800, ?)`,
  ).run(`lb_${randomUUID()}`, randomUUID(), tenant, companyId, FACTORY, tenant, sqlTime(at));
}

function verificationOf(tenant: string, at: number): void {
  seeded += 1;
  new SqliteWorldStore(db).recordVerification({
    nullifier: `nullifier-${seeded}`,
    action: "guardian-verification",
    tenantId: tenant,
    issuerSchemaId: 1,
    credential: "proof_of_human",
    environment: "production",
    verifiedAt: at,
    expiresAtMin: null,
  });
}

function apiKeyOf(tenant: string, at: number): void {
  seeded += 1;
  db.prepare("INSERT INTO api_keys (id, owner_tenant, hash, created_at) VALUES (?, ?, ?, ?)").run(
    `key-${seeded}`,
    tenant,
    "0".repeat(64),
    at,
  );
}

const sinceKept = () =>
  (
    db.prepare("SELECT value FROM meta WHERE key = 'funnel_first_seen_since'").get() as
      | { value: string }
      | undefined
  )?.value;

test("a database that already knows accounts: the table is filled with each one's earliest time in any table, checksummed, and the sign-ins are dated from the earliest", () => {
  const H = 3_600_000;
  // Anvil account 1: its World ID verification (milliseconds) comes first, in lower case
  // elsewhere; its agent and its company (CURRENT_TIMESTAMP text) after.
  verificationOf(account.address, T0 - 40 * H);
  entityOf(account.address.toLowerCase(), T0 - 20 * H);
  companyOf(account.address, T0 - 30 * H);
  // The placeholder: its legal body comes before the company it was written under, and an API
  // key (milliseconds) after both.
  const company = companyOf(OTHER, T0 - 5 * H);
  legalBodyOf(OTHER, company, T0 - 10 * H);
  apiKeyOf(OTHER.toLowerCase(), T0 - 2 * H);
  // An agent with no account, and one whose account is not an address: no row for either.
  entityOf(null, T0 - 50 * H);
  entityOf("not-an-address", T0 - 60 * H);
  asBeforeTheTable();

  migrate(db);

  expect(rows().sort((a, b) => a.first_seen_at - b.first_seen_at)).toEqual([
    { address: account.address, first_seen_at: T0 - 40 * H },
    { address: OTHER, first_seen_at: T0 - 10 * H },
  ]);
  expect(Number(sinceKept())).toBe(T0 - 40 * H);

  // Once, with the table: a later migrate finds it, and an account first seen since is left to
  // its own sign-in.
  verificationOf(getAddress("0x000000000000000000000000000000000000d0d0"), T0 - 90 * H);
  migrate(db);
  expect(rows()).toHaveLength(2);
  expect(Number(sinceKept())).toBe(T0 - 40 * H);
});

test("a database that knows no account yet: no row, and the sign-ins are dated from the migrate", () => {
  asBeforeTheTable();
  const before = Date.now();
  migrate(db);
  expect(rows()).toEqual([]);
  expect(Number(sinceKept())).toBeGreaterThanOrEqual(before);
});

test("a later sign-in of a backfilled account keeps the backfilled time", async () => {
  const earlier = T0 - 7 * 86_400_000;
  companyOf(account.address.toLowerCase(), earlier);
  asBeforeTheTable();
  migrate(db);
  expect(rows()).toEqual([{ address: account.address, first_seen_at: earlier }]);

  const a = app(new SqliteTenantFirstSeenRepository(db));
  expect((await signIn(a)).status).toBe(200);
  expect(rows()).toEqual([{ address: account.address, first_seen_at: earlier }]);
});

test("migrate records when the sign-ins began to be recorded, once: when it creates the table; on a database with no account the two dates are one", () => {
  const fresh = openDatabase(":memory:");
  try {
    const before = Date.now();
    migrate(fresh);
    const after = Date.now();
    const kept = (key: string) =>
      fresh.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
    const since = () => kept("funnel_first_seen_since");
    const recorded = () => kept("funnel_first_seen_recorded_since");
    const first = Number(since()?.value);
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(after);
    // Nothing filled in: the earliest date is the migrate's own, so no week counts stored rows.
    expect(recorded()).toEqual(since());
    // A later migrate finds the table and leaves both dates alone.
    migrate(fresh);
    expect(Number(since()?.value)).toBe(first);
    expect(Number(recorded()?.value)).toBe(first);
  } finally {
    fresh.close();
  }
});
