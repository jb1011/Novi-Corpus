/**
 * The scheduler's operator commands, `scheduler:list` and `scheduler:run <name> --yes`, and the
 * job list they share with the API process (`buildScheduledJobs`).
 *
 * Each command opens the database through the configuration, so every test works in a temporary
 * data directory and writes its rows through its own connection over the same file. With
 * ARC_NETWORK unset the deployment is a sandbox. No fixture holds a readable name: the names are
 * ciphertext bytes, and the tenant is one of anvil's published test accounts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";
import { loadConfig } from "../../src/config/env";
import type { IdentityRowStatus } from "../../src/identity/types";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type EncryptedName,
  type NewGuardianIdentityCheck,
  type NewIdentityEvent,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import { SqliteScheduledJobRunRepository } from "../../src/persistence/scheduledJobRunRepository";
import { buildScheduledJobs } from "../../src/scheduler/jobs";
import { ANVIL_ACCOUNT_2 } from "../helpers/customerCompanyFixtures";

const DAY = 86_400_000;
const PII_KEY = Buffer.alloc(32, 7).toString("base64");
const guardian = ANVIL_ACCOUNT_2.address;

let dir: string;
let db: Database.Database;
let repo: SqliteIdentityRepository;
/** Every line written to standard output, the commands' and the ops lines alike. */
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scheduler-cli-"));
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  // The identity sweep is registered only where the names can be held: with the PII key. A box
  // whose doola block is in sandbox refuses the key, so this deployment has no doola block.
  process.env.FORMATION_PII_KEY = PII_KEY;
  // Required with the PII key: the identity record's duplicate check uses it.
  process.env.IDENTITY_NAME_HMAC_KEY = Buffer.alloc(32, 5).toString("hex");
  for (const name of [
    "ARC_NETWORK",
    "DOOLA_API_KEY",
    "DOOLA_WEBHOOK_SECRET",
    "DOOLA_ENVIRONMENT",
    "FORMATION_PII_KEY_PREVIOUS",
    "IDENTITY_UNUSED_RETENTION_DAYS",
    "IDENTITY_FAILED_RETENTION_DAYS",
  ])
    Reflect.deleteProperty(process.env, name);
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  repo = new SqliteIdentityRepository(db);
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/** Ciphertext and IV bytes only: no fixture here holds a readable name. */
const sealed = (byte: number): EncryptedName => ({
  ciphertext: Buffer.alloc(24, byte),
  iv: Buffer.alloc(12, byte),
});

function row(
  status: IdentityRowStatus,
  over: Partial<NewGuardianIdentityCheck> = {},
): NewGuardianIdentityCheck {
  const now = Date.now();
  return {
    nullifier: "0x5eed0001",
    tenantId: guardian,
    provider: "sandbox",
    providerRef: "ref_1",
    subject: null,
    status,
    supersedesCheckId: null,
    startedAt: now,
    completedAt: now,
    expiresAt: status === "failed" ? null : now + 3 * 365 * DAY,
    names:
      status === "failed" ? null : { first: sealed(1), last: sealed(2), full: null, keyId: "k1" },
    nameHmac: status === "failed" ? null : "a".repeat(64),
    documentCountry: "FRA",
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: status === "failed" ? null : "hit",
    reviewReasons: status === "needs_review" ? ["watchlist_hit"] : [],
    environment: "sandbox",
    synthetic: true,
    operator: "ops.example",
    operatorOsUser: "ops",
    ...over,
  };
}

const event = (kind: NewIdentityEvent["kind"], over: Partial<NewIdentityEvent> = {}) => ({
  kind,
  at: Date.now(),
  actor: "ops.example",
  actorOsUser: "ops",
  reasonCode: null,
  reason: null,
  ...over,
});

/** A review, then its refusal: the review row is superseded and still holds the names. */
function supersededReview(): number {
  const review = repo.append(row("needs_review"), event("recorded"));
  repo.append(
    row("failed", { supersedesCheckId: review.checkId, liveness: null }),
    event("refused", { reasonCode: "watchlist_confirmed", reason: "confirmed by hand" }),
  );
  return review.checkId;
}

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

const isOpsLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed;
  } catch {
    return false;
  }
};

async function run<T = Record<string, unknown>>(
  args: string[],
): Promise<{ output: T; ops: Record<string, unknown>[] }> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const lines = printed.slice(from);
  const outputs = lines.filter((line) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  return {
    output: JSON.parse(outputs[0] as string) as T,
    ops: lines.filter(isOpsLine).map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from).filter(isOpsLine)).toEqual([]);
  return message;
}

// ── buildScheduledJobs ────────────────────────────────────────────────────────────────────────

describe("buildScheduledJobs", () => {
  test("identity_sweep, every 24 hours, is registered only where the PII key is set", () => {
    expect(buildScheduledJobs(db, loadConfig()).map((j) => [j.name, j.everyMs])).toEqual([
      ["identity_sweep", DAY],
    ]);
    // Loud: its daily line, zero counts included, is the trace that the sweep ran.
    expect(buildScheduledJobs(db, loadConfig())[0]?.quiet).not.toBe(true);
    Reflect.deleteProperty(process.env, "FORMATION_PII_KEY");
    // The testnet box: no PII key, so no job, and the API starts no scheduler.
    expect(buildScheduledJobs(db, loadConfig())).toEqual([]);
  });

  test("the identity_sweep job erases what is due at the clock it is handed and returns its counts per rule", async () => {
    const reviewId = supersededReview();
    const [sweep] = buildScheduledJobs(db, loadConfig());
    await expect(sweep?.run(Date.now())).resolves.toEqual({
      count: 0,
      superseded: 0,
      abandoned: 0,
      unused: 0,
    });
    expect(repo.findById(reviewId)?.names).not.toBeNull();
    await expect(sweep?.run(Date.now() + 31 * DAY)).resolves.toEqual({
      count: 1,
      superseded: 1,
      abandoned: 0,
      unused: 0,
    });
    expect(repo.findById(reviewId)?.names).toBeNull();
  });
});

// ── scheduler:list ────────────────────────────────────────────────────────────────────────────

describe("scheduler:list", () => {
  test("prints the registered jobs, their interval and rule, and where the run history is; writes no ops line", async () => {
    const { output, ops } = await run(["scheduler:list"]);
    expect(output).toEqual({
      jobs: [
        {
          name: "identity_sweep",
          everyMs: DAY,
          schedule: "first run 30 s after boot, then every 24 h",
          // The job never ran on this deployment.
          lastRunAt: null,
          lastOk: null,
          consecutiveFailures: null,
        },
      ],
      history: "the run history is in the ops log: job_ran, job_failed, job_skipped",
    });
    expect(ops).toEqual([]);
  });

  test("prints each job's last run as the API's scheduler wrote it to scheduled_job_runs, and only for a registered job", async () => {
    const runs = new SqliteScheduledJobRunRepository(db);
    const at = Date.UTC(2026, 10, 10, 12);
    runs.record({
      name: "identity_sweep",
      lastRunAt: at,
      lastOk: false,
      consecutiveFailures: 3,
      updatedAt: at + 1_200,
    });
    // A job this deployment no longer registers.
    runs.record({
      name: "retired_job",
      lastRunAt: at,
      lastOk: true,
      consecutiveFailures: 0,
      updatedAt: at,
    });

    const { output, ops } = await run<{ jobs: Record<string, unknown>[] }>(["scheduler:list"]);

    expect(output.jobs).toEqual([
      {
        name: "identity_sweep",
        everyMs: DAY,
        schedule: "first run 30 s after boot, then every 24 h",
        lastRunAt: at,
        lastOk: false,
        consecutiveFailures: 3,
      },
    ]);
    expect(ops).toEqual([]);
  });

  test("without the PII key there is no job, and it says the API starts no scheduler", async () => {
    Reflect.deleteProperty(process.env, "FORMATION_PII_KEY");
    const { output } = await run(["scheduler:list"]);
    expect(output).toEqual({
      jobs: [],
      history: "the run history is in the ops log: job_ran, job_failed, job_skipped",
      next: "no job is registered on this deployment: the API starts no scheduler",
    });
  });
});

// ── scheduler:run ─────────────────────────────────────────────────────────────────────────────

describe("scheduler:run", () => {
  test("scheduler:run identity_sweep --yes on a database with a superseded 31-day-old row erases its names", async () => {
    const reviewId = supersededReview();
    // The database writes `created_at` on its own clock; the sweep reads the window from ours.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * DAY });

    const { output, ops } = await run(["scheduler:run", "identity_sweep", "--yes"]);

    expect(output).toEqual({
      name: "identity_sweep",
      ran: true,
      counts: { count: 1, superseded: 1, abandoned: 0, unused: 0 },
    });
    expect(ops).toEqual([
      expect.objectContaining({
        opslog: "identity_names_erased",
        count: 1,
        rules: { superseded: 1, abandoned: 0, unused: 0 },
      }),
      expect.objectContaining({
        opslog: "job_ran",
        name: "identity_sweep",
        ms: expect.any(Number),
        count: 1,
        superseded: 1,
        abandoned: 0,
        unused: 0,
      }),
    ]);
    expect(repo.findById(reviewId)).toMatchObject({ names: null });
    expect(repo.events(reviewId).at(-1)).toMatchObject({
      kind: "names_erased",
      actor: "system",
      reasonCode: "superseded",
    });
    // A manual run is in the ops log only: scheduled_job_runs is the API process's last run.
    expect(new SqliteScheduledJobRunRepository(db).list()).toEqual([]);
  });

  test("without --yes it prints what would run and runs nothing", async () => {
    const reviewId = supersededReview();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 31 * DAY });

    const { output, ops } = await run(["scheduler:run", "identity_sweep"]);

    expect(output).toEqual({
      name: "identity_sweep",
      everyMs: DAY,
      ran: false,
      next: "nothing was run: run scheduler:run identity_sweep --yes to run it now",
    });
    expect(ops).toEqual([]);
    expect(repo.findById(reviewId)?.names).not.toBeNull();
  });

  test("an unknown name is refused, with --yes and without", async () => {
    expect(await refusal(["scheduler:run", "waitlist_sweep", "--yes"])).toBe(
      "refusing: no scheduled job named waitlist_sweep",
    );
    expect(await refusal(["scheduler:run", "waitlist_sweep"])).toBe(
      "refusing: no scheduled job named waitlist_sweep",
    );
    // Where the PII key is not set, the identity sweep is not a scheduled job either.
    Reflect.deleteProperty(process.env, "FORMATION_PII_KEY");
    expect(await refusal(["scheduler:run", "identity_sweep", "--yes"])).toBe(
      "refusing: no scheduled job named identity_sweep",
    );
  });

  test("a failing run writes job_failed, with the message only, and the command fails", async () => {
    // The table the sweep reads is moved aside, so the run throws.
    db.exec("ALTER TABLE guardian_identity_checks RENAME TO moved_aside");
    const from = printed.length;
    let message: string | undefined;
    try {
      await buildCli(noChain).parseAsync([
        "node",
        "cli",
        "scheduler:run",
        "identity_sweep",
        "--yes",
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/no such table: guardian_identity_checks/);
    const ops = printed
      .slice(from)
      .filter(isOpsLine)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ops).toEqual([
      expect.objectContaining({
        opslog: "job_failed",
        level: "warn",
        name: "identity_sweep",
        consecutive: 1,
        error: message,
      }),
    ]);
    // No JSON object is printed for a run that failed.
    expect(printed.slice(from).filter((line) => !isOpsLine(line))).toEqual([]);
  });
});
