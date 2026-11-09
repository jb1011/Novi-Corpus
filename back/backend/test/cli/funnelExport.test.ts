/**
 * `funnel:export`: the formed door's funnel, per ISO week, each stage labelled by its source. A
 * read-only operator command: no --yes, no --operator, no ops line, and it prints counts only,
 * never an address. Excluded: the accounts of FUNNEL_EXCLUDE_TENANTS and --exclude-tenants, and
 * every synthetic or sandbox row unless --include-sandbox. A stage whose source this build does
 * not have prints null with the source `not_available`, never 0 (the invite stage, the split of a
 * payment by settlement kind, and the statement reads on a database that never recorded one,
 * whatever the command's own FUNNEL_SALT). Two stages were not recorded before their table, or
 * their first row, existed: a week wholly before that date prints null too, and the stage's label
 * says "recorded since" the date; the accounts a database knew before the sign-ins were recorded
 * count in the week they first appear. The command opens the database read-only, and refuses a
 * database that is not there, or that this build has not migrated, rather than make one.
 *
 * The command opens the database through the configuration, so every test works in a temporary
 * data directory and seeds its rows through its own connection over the same file. With
 * ARC_NETWORK unset the deployment is a sandbox; the production rule of the sign-ins is exercised
 * through the exported function, handed a configuration whose network is mainnet.
 *
 * Every key is one of anvil's published test accounts, every other address a placeholder, and no
 * fixture holds a readable name.
 */
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FUNNEL_COLUMNS, funnelExport } from "../../src/cli/funnel";
import { buildCli } from "../../src/cli/index";
import { type Config, loadConfig, redact } from "../../src/config/env";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type NewGuardianIdentityCheck,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import {
  SqliteStatementReadRepository,
  callerDayHash,
} from "../../src/persistence/statementReadRepository";
import { SqliteTenantFirstSeenRepository } from "../../src/persistence/tenantFirstSeenRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ACTION,
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
} from "../helpers/customerCompanyFixtures";

const SALT = "5a".repeat(32);
const DAY = 86_400_000;

/** External accounts. */
const A: Address = ANVIL_ACCOUNT_2.address;
const B: Address = ANVIL_ACCOUNT_3.address;
const C: Address = getAddress("0x000000000000000000000000000000000000c0c0");
const D: Address = getAddress("0x000000000000000000000000000000000000d0d0");
const E: Address = getAddress("0x000000000000000000000000000000000000e0e0");
/** A founder: FUNNEL_EXCLUDE_TENANTS. */
const F: Address = ANVIL_ACCOUNT_4.address;
/** Excluded by --exclude-tenants. */
const X: Address = getAddress("0x000000000000000000000000000000000000a0a0");
const ALL = [A, B, C, D, E, F, X];

let dir: string;
let db: Database.Database;
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "funnel-export-"));
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  process.env.FUNNEL_SALT = SALT;
  // The founder, checksummed: the list takes no other spelling.
  process.env.FUNNEL_EXCLUDE_TENANTS = F;
  Reflect.deleteProperty(process.env, "ARC_NETWORK");
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── The seed ──────────────────────────────────────────────────────────────────────────────────
//
// The window is 2026-10-05 (a Monday) to 2026-10-25 (a Sunday): ISO weeks 41, 42 and 43.

/** Noon UTC of `day`, in milliseconds. */
const at = (day: string): number => Date.parse(`${day}T12:00:00.000Z`);
/** `day` as SQLite's CURRENT_TIMESTAMP writes it. */
const sqlTime = (day: string): string => `${day} 12:00:00`;

let nullifiers = 0;
function verified(
  tenant: Address,
  day: string,
  o: { credential?: string | null; environment?: string } = {},
): void {
  nullifiers += 1;
  const recorded = new SqliteWorldStore(db).recordVerification({
    nullifier: `nullifier-${nullifiers}`,
    action: ACTION,
    tenantId: tenant,
    issuerSchemaId: 1,
    credential: o.credential === undefined ? "proof_of_human" : o.credential,
    environment: o.environment ?? "production",
    verifiedAt: at(day),
    expiresAtMin: null,
  });
  if (!recorded) throw new Error("the verification row was not recorded");
}

/** Ciphertext bytes only: no fixture holds a readable name. */
const sealed = (byte: number) => ({
  ciphertext: Buffer.alloc(24, byte),
  iv: Buffer.alloc(12, byte),
});

function identityCheck(
  tenant: Address,
  status: "passed" | "failed",
  day: string,
  o: { environment?: "sandbox" | "production"; synthetic?: boolean } = {},
): void {
  const completedAt = at(day);
  const row: NewGuardianIdentityCheck = {
    nullifier: null,
    tenantId: tenant,
    provider: "stripe",
    providerRef: `ref_${status}_${day}`,
    subject: null,
    status,
    supersedesCheckId: null,
    startedAt: completedAt - 60_000,
    completedAt,
    expiresAt: status === "passed" ? completedAt + 365 * DAY : null,
    names:
      status === "passed" ? { first: sealed(1), last: sealed(2), full: null, keyId: "k1" } : null,
    nameHmac: status === "passed" ? "a".repeat(64) : null,
    documentCountry: "FRA",
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: status === "passed" ? "clear" : null,
    reviewReasons: [],
    environment: o.environment ?? "production",
    synthetic: o.synthetic ?? false,
    operator: "ops.example",
    operatorOsUser: "ops",
  };
  new SqliteIdentityRepository(db).append(row, {
    kind: "recorded",
    at: completedAt,
    actor: "ops.example",
    actorOsUser: "ops",
    reasonCode: null,
    reason: null,
  });
}

function company(
  tenant: Address,
  day: string,
  o: {
    provider?: string;
    purposeKind?: "agent" | "legal_body";
    environment?: "sandbox" | "production";
    synthetic?: boolean;
    status?: "draft" | "ready" | "abandoned";
    filedOn?: string;
  } = {},
): string {
  const companyId = new SqliteCompanyRepository(db).create({
    tenantId: tenant,
    status: o.status === "abandoned" ? "ready" : (o.status ?? "ready"),
    provider: o.provider ?? "doola",
    environment: o.environment ?? "production",
    synthetic: o.synthetic ?? false,
    nameOptions: [{ name: "Example Works", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "an example purpose",
    industryLabel: "Software",
    intakeSynthesized: false,
    purposeKind: o.purposeKind ?? "legal_body",
  });
  db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(
    sqlTime(day),
    companyId,
  );
  if (o.status === "abandoned")
    db.prepare("UPDATE companies SET status = 'abandoned' WHERE company_id = ?").run(companyId);
  if (o.filedOn)
    db.prepare("UPDATE companies SET filed_at = ? WHERE company_id = ?").run(
      Date.parse(`${o.filedOn}T00:00:00.000Z`) / 1000,
      companyId,
    );
  return companyId;
}

let payments = 0;
function payment(
  companyId: string,
  status: "quoted" | "settled" | "refunded" | "expired",
  day: string,
  product: "formation" | "maintenance_year" = "formation",
): void {
  payments += 1;
  db.prepare(
    `INSERT INTO formation_payments
       (payment_id, company_id, product, status, amount_usdc, nonce, valid_before, created_at)
     VALUES (?, ?, ?, ?, '500000000', ?, ?, ?)`,
  ).run(
    `payment-${payments}`,
    companyId,
    product,
    status,
    `0x${payments.toString(16).padStart(64, "0")}`,
    Math.floor(at(day) / 1000) + 900,
    sqlTime(day),
  );
}

function body(tenant: Address, companyId: string, linkedOn: string[] = []): string {
  const { legalBodyId } = new SqliteLegalBodyRepository(db).create({
    tenantId: tenant,
    companyId,
    chainId: CHAIN_ID,
    factory: FACTORY,
    amendmentDelay: 172_800,
  });
  for (const day of linkedOn)
    db.prepare(
      "INSERT INTO legal_body_events (legal_body_id, kind, actor, created_at) VALUES (?, 'linked', 'system', ?)",
    ).run(legalBodyId, sqlTime(day));
  return legalBodyId;
}

function reads(
  legalBodyId: string,
  day: string,
  callers: string[],
  kind: "anonymous" | "owner" = "anonymous",
): void {
  const repo = new SqliteStatementReadRepository(db);
  for (const caller of callers)
    repo.record({
      legalBodyId,
      day,
      callerKind: kind,
      callerDayHash: callerDayHash(caller, day, SALT),
      firstReadAt: at(day),
    });
}

/** The seed every export test reads; the expected counts are in the tests. */
/** The day a stage has been recorded since, as `migrate` and the first read row write it. */
function recordedSince(
  key: "funnel_first_seen_since" | "funnel_statement_reads_since",
  day: string,
) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(at(day)));
}

function seed(): void {
  const firstSeen = new SqliteTenantFirstSeenRepository(db);
  firstSeen.recordFirstSeen(A, at("2026-10-06"));
  firstSeen.recordFirstSeen(B, at("2026-10-13"));
  firstSeen.recordFirstSeen(C, at("2026-10-14"));
  firstSeen.recordFirstSeen(F, at("2026-10-06"));
  firstSeen.recordFirstSeen(X, at("2026-10-20"));
  // Outside the window, on either side.
  firstSeen.recordFirstSeen(D, at("2026-10-04"));
  firstSeen.recordFirstSeen(E, at("2026-10-26"));

  // World ID: the first accepted verification of each account, production only.
  verified(A, "2026-10-07");
  verified(A, "2026-10-15", { credential: "orb" });
  verified(B, "2026-10-13", { credential: "orb", environment: "staging" });
  verified(C, "2026-10-14", { credential: "device" });
  verified(D, "2026-10-14", { credential: null });
  verified(F, "2026-10-07");

  // Identity: the latest check of each account, passed.
  identityCheck(A, "passed", "2026-10-14");
  identityCheck(B, "passed", "2026-10-15", { environment: "sandbox", synthetic: true });
  identityCheck(C, "passed", "2026-10-16");
  identityCheck(C, "failed", "2026-10-17");
  identityCheck(D, "failed", "2026-10-16");
  identityCheck(F, "passed", "2026-10-14");

  // Companies for a legal body, by provider; and their payments and filings.
  const formedA = company(A, "2026-10-15", { filedOn: "2026-10-20" });
  const declaredA = company(A, "2026-10-16", { provider: "customer" });
  const sandboxB = company(B, "2026-10-16", {
    environment: "sandbox",
    synthetic: true,
    filedOn: "2026-10-21",
  });
  const agentC = company(C, "2026-10-15", { purposeKind: "agent", filedOn: "2026-10-20" });
  const founderF = company(F, "2026-10-15", { filedOn: "2026-10-20" });
  const excludedX = company(X, "2026-10-20");
  const abandonedA = company(A, "2026-10-21", { status: "abandoned" });

  payment(formedA, "expired", "2026-10-15");
  payment(formedA, "settled", "2026-10-15");
  payment(formedA, "settled", "2026-10-16", "maintenance_year");
  payment(declaredA, "refunded", "2026-10-22");
  payment(sandboxB, "settled", "2026-10-16");
  payment(agentC, "settled", "2026-10-15");
  payment(founderF, "settled", "2026-10-15");
  payment(excludedX, "settled", "2026-10-20");
  payment(abandonedA, "quoted", "2026-10-21");

  // Legal bodies and their links: each body counted once, at its first link.
  const bodyA = body(A, declaredA, ["2026-10-23", "2026-10-24"]);
  body(A, formedA);
  const bodyB = body(B, sandboxB, ["2026-10-23"]);
  const bodyF = body(F, founderF, ["2026-10-23"]);

  // Statement reads: distinct anonymous callers per body per day.
  reads(bodyA, "2026-10-12", ["192.0.2.1"]);
  reads(bodyA, "2026-10-23", ["192.0.2.1", "192.0.2.2"]);
  reads(bodyA, "2026-10-23", ["192.0.2.3"], "owner");
  reads(bodyA, "2026-10-24", ["192.0.2.1"]);
  reads(bodyA, "2026-10-26", ["192.0.2.1"]);
  reads(bodyB, "2026-10-23", ["192.0.2.4"]);
  reads(bodyF, "2026-10-23", ["192.0.2.5"]);

  // Both stages recorded since before the window (`migrate` and the first read wrote today's and
  // the first seeded read's dates): every week of it counts.
  recordedSince("funnel_first_seen_since", "2026-09-01");
  recordedSince("funnel_statement_reads_since", "2026-09-01");
}

// ── Running the command ───────────────────────────────────────────────────────────────────────

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

/** Everything the command wrote to standard output. */
async function run(args: string[]): Promise<string[]> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", "funnel:export", ...args]);
  return printed.slice(from);
}

type Week = Record<string, unknown>;
interface Export {
  since: string;
  until: string;
  includeSandbox: boolean;
  excludedTenants: number;
  stages: string[];
  sources: Record<string, string>;
  weeks: Week[];
}

async function exported(args: string[]): Promise<Export> {
  const lines = await run(args);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Export;
}

async function refusal(args: string[]): Promise<string> {
  try {
    await run(args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("the command did not refuse");
}

const WINDOW = ["--since", "2026-10-05", "--until", "2026-10-25", "--exclude-tenants", X];

/** The counts of a week, the week's own fields left out. */
const counts = ({ week: _w, from: _f, to: _t, ...rest }: Week) => rest;

const NINE = [
  "signed_in",
  "world_verified",
  "identity_verified",
  "invite_redeemed",
  "company_requested",
  "paid",
  "filed",
  "body_linked",
  "statement_reads",
];

describe("the counts", () => {
  test("per ISO week, external production accounts only: the founders, the excluded and the synthetic rows left out", async () => {
    seed();
    const out = await exported(WINDOW);

    expect(out).toMatchObject({
      since: "2026-10-05",
      until: "2026-10-25",
      includeSandbox: false,
      excludedTenants: 2,
      stages: NINE,
    });
    expect(out.weeks.map(({ week, from, to }) => [week, from, to])).toEqual([
      ["2026-W41", "2026-10-05", "2026-10-11"],
      ["2026-W42", "2026-10-12", "2026-10-18"],
      ["2026-W43", "2026-10-19", "2026-10-25"],
    ]);
    // A sandbox deployment: its sign-ins are sandbox rows, counted only with --include-sandbox.
    expect(out.weeks.map(counts)).toEqual([
      {
        signed_in: 0,
        world_verified: 1,
        identity_verified: 0,
        invite_redeemed: null,
        company_requested: 0,
        company_requested_doola: 0,
        company_requested_customer: 0,
        paid: 0,
        paid_transfer: null,
        paid_complimentary: null,
        filed: 0,
        body_linked: 0,
        statement_reads: 0,
      },
      {
        signed_in: 0,
        world_verified: 0,
        identity_verified: 1,
        invite_redeemed: null,
        company_requested: 2,
        company_requested_doola: 1,
        company_requested_customer: 1,
        paid: 1,
        paid_transfer: null,
        paid_complimentary: null,
        filed: 0,
        body_linked: 0,
        statement_reads: 1,
      },
      {
        signed_in: 0,
        world_verified: 0,
        identity_verified: 0,
        invite_redeemed: null,
        company_requested: 1,
        company_requested_doola: 1,
        company_requested_customer: 0,
        paid: 1,
        paid_transfer: null,
        paid_complimentary: null,
        filed: 1,
        body_linked: 1,
        statement_reads: 3,
      },
    ]);
  });

  test("with --include-sandbox the sandbox and synthetic rows count; the founders are still left out", async () => {
    seed();
    const out = await exported([...WINDOW, "--include-sandbox"]);
    expect(out.includeSandbox).toBe(true);
    expect(out.weeks.map(counts)).toEqual([
      expect.objectContaining({ signed_in: 1, world_verified: 1, identity_verified: 0 }),
      expect.objectContaining({
        signed_in: 2,
        world_verified: 1,
        identity_verified: 2,
        company_requested: 3,
        company_requested_doola: 2,
        company_requested_customer: 1,
        paid: 2,
        statement_reads: 1,
      }),
      expect.objectContaining({
        signed_in: 0,
        company_requested: 1,
        paid: 1,
        filed: 2,
        body_linked: 2,
        statement_reads: 4,
      }),
    ]);
  });

  test("on a production deployment the sign-ins count without the flag", () => {
    seed();
    const sandbox = loadConfig();
    const production: Config = { ...sandbox, arcNetwork: "mainnet" };
    const out = funnelExport(db, production, {
      since: "2026-10-05",
      until: "2026-10-25",
      excludeTenants: X,
    });
    expect(out.weeks.map((w) => w.signed_in)).toEqual([1, 2, 0]);
    // The excluded account signed in in week 43: still not counted.
    expect(out.excludedTenants).toBe(2);
  });

  test("without --exclude-tenants the account is counted; FUNNEL_EXCLUDE_TENANTS still leaves the founder out", async () => {
    seed();
    const out = await exported([
      "--since",
      "2026-10-05",
      "--until",
      "2026-10-25",
      "--include-sandbox",
    ]);
    expect(out.excludedTenants).toBe(1);
    // X signed in and requested a company in week 43; X's payment there counts too.
    expect(out.weeks[2]).toMatchObject({ signed_in: 1, company_requested: 2, paid: 2 });
  });

  test("a stage this build has no source for prints null with the source not_available, never 0", async () => {
    seed();
    const out = await exported(WINDOW);
    for (const column of ["invite_redeemed", "paid_transfer", "paid_complimentary"]) {
      expect(out.sources[column], column).toBe("not_available");
      for (const week of out.weeks) expect(week[column], column).toBeNull();
    }
    expect(out.sources.statement_reads).not.toBe("not_available");
  });

  /** The export with FUNNEL_SALT set in the command's environment, then without it. */
  async function withAndWithoutSalt(args: string[]): Promise<[Export, Export]> {
    process.env.FUNNEL_SALT = SALT;
    const salted = await exported(args);
    Reflect.deleteProperty(process.env, "FUNNEL_SALT");
    const unsalted = await exported(args);
    return [salted, unsalted];
  }

  test("a database on which no statement read was ever recorded: the reads are null, not_available, whether or not the command has FUNNEL_SALT", async () => {
    seed();
    db.prepare("DELETE FROM statement_reads").run();
    db.prepare("DELETE FROM meta WHERE key = 'funnel_statement_reads_since'").run();
    const [salted, unsalted] = await withAndWithoutSalt(WINDOW);
    expect(unsalted).toEqual(salted);
    expect(salted.sources.statement_reads).toBe(
      "not_available; no statement read has been recorded on this database",
    );
    for (const week of salted.weeks) expect(week.statement_reads).toBeNull();
    // The other stages are unchanged.
    expect(salted.weeks[2]).toMatchObject({ body_linked: 1, filed: 1 });
  });

  test("a database that records reads since a day: null before it, counted from it, whether or not the command has FUNNEL_SALT", async () => {
    seed();
    recordedSince("funnel_statement_reads_since", "2026-10-20");
    const [salted, unsalted] = await withAndWithoutSalt(WINDOW);
    expect(unsalted).toEqual(salted);
    expect(salted.weeks.map((w) => w.statement_reads)).toEqual([null, null, 3]);
    expect(salted.sources.statement_reads).toBe(
      "statement_reads.day; distinct anonymous callers per legal body per day summed; production rows only; not synthetic; recorded since 2026-10-20",
    );
  });

  test("accounts the database knew before the sign-ins were recorded: each counted in the week it first appears, and not again at a later sign-in", async () => {
    db.exec("DROP TABLE tenant_first_seen");
    db.prepare("DELETE FROM meta WHERE key = 'funnel_first_seen_since'").run();
    // A's first trace is its company, in week 41; B's its World ID verification, in week 42.
    company(A, "2026-10-06");
    verified(B, "2026-10-13");
    company(B, "2026-10-21");
    migrate(db);
    // A signs in in week 43: its first sign-in stays the one the backfill found.
    expect(new SqliteTenantFirstSeenRepository(db).recordFirstSeen(A, at("2026-10-22"))).toBe(
      false,
    );

    const out = await exported([...WINDOW, "--include-sandbox"]);
    expect(out.weeks.map((w) => w.signed_in)).toEqual([1, 1, 0]);
    expect(out.sources.signed_in).toBe(
      "tenant_first_seen.first_seen_at; first sign-in per account; any deployment; recorded since 2026-10-06",
    );
  });

  test("a stage recorded since mid-window: null for the weeks wholly before, counted from the week it began; the label says since when", async () => {
    seed();
    recordedSince("funnel_first_seen_since", "2026-10-14");
    recordedSince("funnel_statement_reads_since", "2026-10-20");
    const out = await exported([...WINDOW, "--include-sandbox"]);

    expect(out.weeks.map((w) => w.signed_in)).toEqual([null, 2, 0]);
    expect(out.weeks.map((w) => w.statement_reads)).toEqual([null, null, 4]);
    expect(out.sources.signed_in).toBe(
      "tenant_first_seen.first_seen_at; first sign-in per account; any deployment; recorded since 2026-10-14",
    );
    expect(out.sources.statement_reads).toMatch(/; recorded since 2026-10-20$/);
    // The other stages had their tables all along.
    expect(out.weeks.map((w) => w.world_verified)).toEqual([1, 1, 0]);
    for (const column of ["world_verified", "company_requested", "paid", "filed", "body_linked"])
      expect(out.sources[column], column).not.toContain("recorded since");

    const header = (await run([...WINDOW, "--include-sandbox", "--format", "csv"]))
      .join("\n")
      .split("\n")[0] as string;
    expect(header).toContain(`signed_in [${out.sources.signed_in}]`);
    expect(header).toContain(`statement_reads [${out.sources.statement_reads}]`);
  });

  test("with no date recorded the sign-ins are counted in every week, their label unchanged; the reads are null, none recorded", async () => {
    seed();
    db.prepare("DELETE FROM meta WHERE key LIKE 'funnel_%'").run();
    const out = await exported([...WINDOW, "--include-sandbox"]);
    expect(out.weeks.map((w) => w.signed_in)).toEqual([1, 2, 0]);
    expect(out.weeks.map((w) => w.statement_reads)).toEqual([null, null, null]);
    expect(out.sources.statement_reads).toBe(
      "not_available; no statement read has been recorded on this database",
    );
    expect(JSON.stringify(out.sources)).not.toContain("recorded since");
  });

  test("--until defaults to today, and a window inside one week prints that week, cut to the window", async () => {
    seed();
    const out = await exported(["--since", "2026-10-21", "--until", "2026-10-23"]);
    expect(out.weeks.map(({ week, from, to }) => [week, from, to])).toEqual([
      ["2026-W43", "2026-10-21", "2026-10-23"],
    ]);
    // The read on 2026-10-24 is outside it.
    expect(out.weeks[0]).toMatchObject({ statement_reads: 2, filed: 0, body_linked: 1 });

    const today = new Date().toISOString().slice(0, 10);
    const open = await exported(["--since", today]);
    expect(open.until).toBe(today);
    expect(open.weeks).toHaveLength(1);
  });
});

describe("the output", () => {
  test("the CSV header names every stage with its source label, and a missing source prints null", async () => {
    seed();
    const json = await exported(WINDOW);
    const lines = (await run([...WINDOW, "--format", "csv"])).join("\n").split("\n");
    expect(lines).toHaveLength(4);
    const header = (lines[0] as string).split(",");
    expect(header.slice(0, 3)).toEqual(["week", "from", "to"]);
    expect(header.slice(3)).toEqual(
      FUNNEL_COLUMNS.map((column) => `${column} [${json.sources[column]}]`),
    );
    for (const stage of NINE)
      expect(
        header.some((cell) => cell.startsWith(`${stage} [`)),
        stage,
      ).toBe(true);
    expect(header).toContain("invite_redeemed [not_available]");
    // The World ID stage says what its source keeps: each World ID's latest verification.
    const worldVerified =
      "guardian_verifications.verified_at; latest accepted verification per account (per World ID; of several the earliest); production rows only";
    expect(json.sources.world_verified).toBe(worldVerified);
    expect(header).toContain(`world_verified [${worldVerified}]`);
    expect(lines[3]).toBe("2026-W43,2026-10-19,2026-10-25,0,0,0,null,1,1,0,1,null,null,1,1,3");
  });

  test("counts only: no address, no salt and no caller in the output; no ops line; nothing written", async () => {
    seed();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    const dump = () =>
      JSON.stringify(
        tables.map((t) => db.prepare(`SELECT * FROM "${t}"`).all()),
        (_k, v) => (Buffer.isBuffer(v) ? v.toString("hex") : v),
      );
    const before = dump();

    const all = [
      ...(await run([...WINDOW, "--include-sandbox"])),
      ...(await run([...WINDOW, "--format", "csv"])),
    ].join("\n");
    for (const address of ALL) expect(all.toLowerCase()).not.toContain(address.toLowerCase());
    expect(all).not.toContain(SALT);
    expect(all).not.toContain("192.0.2.");
    expect(all).not.toContain('"opslog"');
    expect(dump()).toBe(before);
  });
});

describe("refusals", () => {
  test("a date that is not YYYY-MM-DD or not a day, an end before the start, a bad format", async () => {
    for (const since of ["2026-10-5", "05/10/2026", "2026-02-30", "2026-13-01", ""])
      expect(await refusal(["--since", since])).toBe(
        "refusing: --since must be a date, YYYY-MM-DD",
      );
    expect(await refusal(["--since", "2026-10-05", "--until", "2026-10-32"])).toBe(
      "refusing: --until must be a date, YYYY-MM-DD",
    );
    expect(await refusal(["--since", "2026-10-25", "--until", "2026-10-05"])).toBe(
      "refusing: --until must not be before --since",
    );
    expect(await refusal(["--since", "2026-10-05", "--format", "xml"])).toBe(
      "refusing: --format must be json or csv",
    );
  });

  test("--exclude-tenants must be checksummed addresses, and the refusal repeats none of them", async () => {
    const typo = `${A.slice(0, 40)}`;
    const message = await refusal(["--since", "2026-10-05", "--exclude-tenants", `${B},${typo}`]);
    expect(message).toBe(
      "refusing: --exclude-tenants must be EIP-55 checksummed wallet addresses, comma-separated (entry 2 is not one)",
    );
    expect(message.toLowerCase()).not.toContain(typo.toLowerCase());
    // A mixed-case address whose checksum is wrong is a typo too: one letter's case flipped.
    const badChecksum = A.replace(/[A-F]/, (ch) => ch.toLowerCase());
    expect(badChecksum).not.toBe(A);
    expect(await refusal(["--since", "2026-10-05", "--exclude-tenants", badChecksum])).toMatch(
      /entry 1 is not one/,
    );
    // An address in lower case is a valid address, but not the checksummed spelling.
    const lower = await refusal([
      "--since",
      "2026-10-05",
      "--exclude-tenants",
      `${B},${A.toLowerCase()}`,
    ]);
    expect(lower).toBe(
      "refusing: --exclude-tenants must be EIP-55 checksummed wallet addresses, comma-separated (entry 2 is not one)",
    );
    expect(lower.toLowerCase()).not.toContain(A.toLowerCase());
  });

  test("a database that is not there is refused, and no file or directory is made", async () => {
    const missing = join(dir, "not-the-data-dir");
    process.env.DATA_DIR = missing;
    const message = await refusal(["--since", "2026-10-05"]);
    expect(message).toBe(
      `refusing: there is no database at ${missing}/legalbody.db: check DATA_DIR`,
    );
    expect(existsSync(missing)).toBe(false);
  });

  test("a database this build has not migrated is refused in plain words, not with a database error, and nothing is written to it", async () => {
    // An earlier build's database, which has tables but not the funnel's; and an empty file.
    const earlier = mkdtempSync(join(tmpdir(), "funnel-earlier-"));
    const empty = mkdtempSync(join(tmpdir(), "funnel-empty-"));
    try {
      const old = openDatabase(join(earlier, "legalbody.db"));
      old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      old.close();
      writeFileSync(join(empty, "legalbody.db"), "");
      for (const dataDir of [earlier, empty]) {
        process.env.DATA_DIR = dataDir;
        expect(await refusal(["--since", "2026-10-05"]), dataDir).toBe(
          "refusing: the database has not been migrated by this build: start the API once first",
        );
      }
      const reopened = openDatabase(join(earlier, "legalbody.db"));
      expect(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
        [{ name: "meta" }],
      );
      reopened.close();
      expect(statSync(join(empty, "legalbody.db")).size).toBe(0);
    } finally {
      rmSync(earlier, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the read-only open reads a database no other connection holds open", async () => {
    seed();
    // The test's own connection closed (its WAL files go with it), so the command alone opens the
    // file, read-only: it is read all the same.
    db.close();
    const out = await exported(WINDOW);
    expect(out.weeks).toHaveLength(3);
    db = openDatabase(join(dir, "legalbody.db"));
  });
});

describe("the settings", () => {
  const BASE = {
    ARC_TESTNET_RPC_URL: "https://rpc.example",
    PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  };

  test("FUNNEL_EXCLUDE_TENANTS: EIP-55 checksummed addresses, comma-separated; any other entry refuses boot without repeating it", () => {
    expect(loadConfig(BASE).funnel).toEqual({ excludeTenants: [], salt: undefined });
    expect(loadConfig({ ...BASE, FUNNEL_EXCLUDE_TENANTS: "" }).funnel?.excludeTenants).toEqual([]);
    expect(
      loadConfig({ ...BASE, FUNNEL_EXCLUDE_TENANTS: ` ${A} , ${B} ` }).funnel?.excludeTenants,
    ).toEqual([A, B]);
    const MESSAGE = (entry: number) =>
      `Invalid config: FUNNEL_EXCLUDE_TENANTS must be EIP-55 checksummed wallet addresses, comma-separated (entry ${entry} is not one)`;
    const messageOf = (value: string) => {
      try {
        loadConfig({ ...BASE, FUNNEL_EXCLUDE_TENANTS: value });
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    expect(messageOf(`${A},0x1234`)).toBe(MESSAGE(2));
    expect(messageOf(`${A},`)).toBe(MESSAGE(2));
    // A valid address in lower case, or with one letter's case flipped, is not checksummed.
    expect(messageOf(`${A},${B.toLowerCase()}`)).toBe(MESSAGE(2));
    expect(messageOf(A.replace(/[A-F]/, (ch) => ch.toLowerCase()))).toBe(MESSAGE(1));
    expect(messageOf(`${A},${B.toLowerCase()}`).toLowerCase()).not.toContain(B.toLowerCase());
  });

  test("FUNNEL_SALT: 32 bytes of hex, kept in lower case; anything else refuses boot without repeating it", () => {
    expect(loadConfig({ ...BASE, FUNNEL_SALT: "5A".repeat(32) }).funnel?.salt).toBe(SALT);
    expect(loadConfig({ ...BASE, FUNNEL_SALT: "" }).funnel?.salt).toBeUndefined();
    for (const bad of ["5a".repeat(31), "5a".repeat(33), `0x${"5a".repeat(32)}`, "zz".repeat(32)]) {
      let message = "";
      try {
        loadConfig({ ...BASE, FUNNEL_SALT: bad });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe(
        "Invalid config: FUNNEL_SALT must be 32 bytes written as 64 hex characters (generate one with: openssl rand -hex 32)",
      );
    }
  });

  test("FUNNEL_SALT is required on a production deployment", async () => {
    const { assertFunnelConfig } = await import("../../src/config/env");
    expect(() =>
      assertFunnelConfig({
        arcNetwork: "mainnet",
        funnel: { excludeTenants: [], salt: undefined },
      }),
    ).toThrow(
      "Invalid config: FUNNEL_SALT is required on a production deployment (ARC_NETWORK=mainnet): without it no statement read is recorded",
    );
    expect(() =>
      assertFunnelConfig({ arcNetwork: "mainnet", funnel: { excludeTenants: [], salt: SALT } }),
    ).not.toThrow();
    expect(() =>
      assertFunnelConfig({
        arcNetwork: "testnet",
        funnel: { excludeTenants: [], salt: undefined },
      }),
    ).not.toThrow();
  });

  test("redact() hides the salt and the excluded accounts, and keeps how many there are", () => {
    const cfg = loadConfig({ ...BASE, FUNNEL_SALT: SALT, FUNNEL_EXCLUDE_TENANTS: `${A},${B}` });
    const printedCfg = JSON.stringify(redact(cfg));
    expect(printedCfg).not.toContain(SALT);
    expect(printedCfg.toLowerCase()).not.toContain(A.toLowerCase());
    expect(redact(cfg).funnel).toEqual({ excludeTenants: 2, salt: "REDACTED" });
  });
});
