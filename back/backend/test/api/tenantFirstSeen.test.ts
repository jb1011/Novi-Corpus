/**
 * `tenant_first_seen`: the funnel's "signed in" stage. `POST /auth/verify` records an account's
 * first sign-in once the SIWE address is known, and never moves it: a second sign-in writes
 * nothing. A sign-in that fails records nothing, and a record that cannot be written never fails
 * the sign-in.
 *
 * The key is one of anvil's published test accounts, never a real wallet.
 */
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteTenantFirstSeenRepository,
  type TenantFirstSeenRepository,
} from "../../src/persistence/tenantFirstSeenRepository";

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

test("migrate records when the sign-ins began to be recorded, once: when it creates the table", () => {
  const fresh = openDatabase(":memory:");
  try {
    const before = Date.now();
    migrate(fresh);
    const after = Date.now();
    const since = () =>
      fresh.prepare("SELECT value FROM meta WHERE key = 'funnel_first_seen_since'").get() as
        | { value: string }
        | undefined;
    const first = Number(since()?.value);
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(after);
    // A later migrate finds the table and leaves the date alone.
    migrate(fresh);
    expect(Number(since()?.value)).toBe(first);
  } finally {
    fresh.close();
  }
});
