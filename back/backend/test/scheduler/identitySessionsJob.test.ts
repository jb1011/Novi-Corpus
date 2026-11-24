/**
 * The `identity_sessions_sync` job: the identity session service's sweep (`sweepSessions`) run by
 * the API's in-process scheduler, every `IDENTITY_SYNC_EVERY_MS`. It is on the list only where the
 * Stripe Identity block is configured AND the API process hands the list the session service
 * (`deps.identitySessions`); another process names it (`apiProcessOnlyJobs`) but cannot run it.
 *
 * The database is real (in memory); the provider is a fake held in memory, the screener absent (a
 * sandbox). Every key is an obvious placeholder, every tenant an invented address; no fixture
 * holds a readable name: the typed names are ciphertext bytes.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type IdentityProviderClient,
  StripeUnavailable,
} from "../../src/adapters/stripe/identityClient";
import type { ProviderSession } from "../../src/adapters/stripe/mapSession";
import { type Config, loadConfig } from "../../src/config/env";
import type { IdentitySessionDeps } from "../../src/identity/sessions";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { EncryptedName } from "../../src/persistence/identityRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqliteIdentitySessionRepository } from "../../src/persistence/identitySessionRepository";
import { apiProcessOnlyJobs, buildScheduledJobs } from "../../src/scheduler/jobs";
import { Scheduler } from "../../src/scheduler/scheduler";
import { TaskTracker } from "../../src/util/taskTracker";
import { TEST_PII_RING } from "../helpers/customerCompanyFixtures";

const DAY = 86_400_000;
const MINUTE = 60_000;
/** 20 November 2026, 12:00 UTC: when the sessions were created. */
const T0 = Date.UTC(2026, 10, 20, 12);

/** A sandbox deployment (ARC_NETWORK unset) with the identity check configured, that boots. */
const SANDBOX_CHECK = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
  FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
  IDENTITY_NAME_HMAC_KEY: Buffer.alloc(32, 5).toString("hex"),
  STRIPE_IDENTITY_KEY: `rk_test_${"x".repeat(24)}`,
  STRIPE_IDENTITY_FLOW_ID: `vf_${"x".repeat(24)}`,
  STRIPE_IDENTITY_WEBHOOK_SECRET: `whsec_${"x".repeat(32)}`,
  WEB_ORIGIN: "https://testnet.example.com",
};

/** The same deployment without the Stripe Identity block. */
function withoutStripe(): Config {
  const {
    STRIPE_IDENTITY_KEY: _key,
    STRIPE_IDENTITY_FLOW_ID: _flow,
    STRIPE_IDENTITY_WEBHOOK_SECRET: _secret,
    ...rest
  } = SANDBOX_CHECK;
  return loadConfig(rest);
}

/** A tenant id as the session spells it: EIP-55 checksummed. */
const tenant = (n: number) => getAddress(`0x${"ab".repeat(18)}${n.toString(16).padStart(4, "0")}`);
/** Our opaque session id: 32 lower-case hex digits. */
const sid = (n: number) => n.toString(16).padStart(32, "0");
/** Ciphertext and IV bytes only. */
const sealed = (byte: number): EncryptedName => ({
  ciphertext: Buffer.alloc(24, byte),
  iv: Buffer.alloc(12, byte),
});

/** The provider, in memory: a read of `vs_test_down` fails as Stripe being down; any other ref is
 *  a session still processing, under our reference. */
class FakeProvider implements IdentityProviderClient {
  readonly reads: string[] = [];
  constructor(private readonly references: Map<string, string>) {}
  async createSession(): Promise<never> {
    throw new Error("the sweep creates no session");
  }
  async retrieveSession(ref: string): Promise<ProviderSession> {
    this.reads.push(ref);
    if (ref === "vs_test_down") throw new StripeUnavailable(503, "Stripe Identity retrieve: 503");
    return {
      id: ref,
      livemode: false,
      status: "processing",
      clientReferenceId: this.references.get(ref) ?? null,
      url: null,
      lastErrorCode: null,
      redaction: null,
      outputs: null,
      report: null,
    };
  }
  async cancelSession(): Promise<never> {
    throw new Error("no session here is past its days");
  }
  async redactSession(): Promise<never> {
    throw new Error("no session here is due for redaction");
  }
}

let db: Database.Database;
let sessions: SqliteIdentitySessionRepository;
let provider: FakeProvider;
/** Every ops line written to standard output, parsed. */
let ops: Record<string, unknown>[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  sessions = new SqliteIdentitySessionRepository(db);
  provider = new FakeProvider(
    new Map([
      ["vs_test_read", sid(1)],
      ["vs_test_down", sid(2)],
    ]),
  );
  ops = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null && "opslog" in parsed) ops.push(parsed);
    } catch {
      // Not an ops line.
    }
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The session service as the API process builds it, over this test's database and fakes. */
function sessionDeps(): IdentitySessionDeps {
  return {
    identity: {
      repo: new SqliteIdentityRepository(db),
      pii: TEST_PII_RING,
      reverifyYears: 3,
      blockedCountries: new Set(["PRK"]),
      nameHmacKey: Buffer.alloc(32, 5),
    },
    world: undefined,
    sessions,
    provider,
    screener: undefined,
    environment: "sandbox",
    flowId: SANDBOX_CHECK.STRIPE_IDENTITY_FLOW_ID,
    webOrigin: SANDBOX_CHECK.WEB_ORIGIN,
    limits: { sessionDays: 14, maxPerDay: 3, attemptsPerSession: 3, redactAfterDays: 7 },
    tasks: new TaskTracker("identity_session"),
  };
}

/** An open session nobody has read yet. */
function openSession(n: number, providerRef: string): void {
  sessions.insert({
    sessionId: sid(n),
    tenantId: tenant(n),
    nullifier: null,
    provider: "stripe",
    providerRef,
    environment: "sandbox",
    livemode: false,
    returnPath: "/legal-body",
    createdAt: T0,
    startedCheckId: n,
    typedNames: { first: sealed(1), last: sealed(2), keyId: "k1" },
  });
}

describe("buildScheduledJobs and identity_sessions_sync", () => {
  test("registered every IDENTITY_SYNC_EVERY_MS only with both the Stripe block and the session service", () => {
    const cfg = loadConfig(SANDBOX_CHECK);
    const deps = { identitySessions: sessionDeps() };
    expect(buildScheduledJobs(db, cfg, deps).map((j) => [j.name, j.everyMs])).toEqual([
      ["identity_sweep", DAY],
      ["identity_sessions_sync", 10 * MINUTE],
    ]);
    expect(
      buildScheduledJobs(
        db,
        loadConfig({ ...SANDBOX_CHECK, IDENTITY_SYNC_EVERY_MS: "120000" }),
        deps,
      ).find((j) => j.name === "identity_sessions_sync")?.everyMs,
    ).toBe(2 * MINUTE);

    // No session service handed in (another process, or an API not wired): not on the list.
    expect(buildScheduledJobs(db, cfg).map((j) => j.name)).toEqual(["identity_sweep"]);
    expect(buildScheduledJobs(db, cfg, {}).map((j) => j.name)).toEqual(["identity_sweep"]);
    // No Stripe block: not on the list, whatever is handed in.
    expect(buildScheduledJobs(db, withoutStripe(), deps).map((j) => j.name)).toEqual([
      "identity_sweep",
    ]);
  });

  test("apiProcessOnlyJobs names the job wherever the Stripe block is set, as the API registers it", () => {
    const cfg = loadConfig(SANDBOX_CHECK);
    expect(apiProcessOnlyJobs(cfg)).toEqual([
      {
        name: "identity_sessions_sync",
        everyMs: 10 * MINUTE,
        note: expect.stringContaining("runs in the API process only"),
      },
    ]);
    expect(apiProcessOnlyJobs(withoutStripe())).toEqual([]);
    // The list another process reads, plus the jobs it names, is the API process's list.
    const inApi = buildScheduledJobs(db, cfg, { identitySessions: sessionDeps() });
    expect([
      ...buildScheduledJobs(db, cfg).map((j) => [j.name, j.everyMs]),
      ...apiProcessOnlyJobs(cfg).map((j) => [j.name, j.everyMs]),
    ]).toEqual(inApi.map((j) => [j.name, j.everyMs]));
  });

  test("its run is one sweep at the clock it is handed, returning the sweep's five counts", async () => {
    openSession(1, "vs_test_read");
    openSession(2, "vs_test_down");
    const job = buildScheduledJobs(db, loadConfig(SANDBOX_CHECK), {
      identitySessions: sessionDeps(),
    }).find((j) => j.name === "identity_sessions_sync");

    await expect(job?.run(T0 + 10 * MINUTE)).resolves.toEqual({
      synced: 1,
      abandoned: 0,
      redactRequested: 0,
      redacted: 0,
      errors: 1,
    });
    expect(provider.reads).toEqual(expect.arrayContaining(["vs_test_read", "vs_test_down"]));
    // The read is recorded at the scheduler's clock, not the wall clock.
    expect(sessions.byId(sid(1))).toMatchObject({
      lastStatus: "processing",
      lastReadAt: T0 + 10 * MINUTE,
    });
  });

  test("through the scheduler, job_ran carries the five counts beside the job's name and duration", async () => {
    openSession(1, "vs_test_read");
    const scheduler = new Scheduler({ now: () => T0 + 10 * MINUTE });
    for (const job of buildScheduledJobs(db, loadConfig(SANDBOX_CHECK), {
      identitySessions: sessionDeps(),
    }))
      scheduler.register(job);

    await scheduler.runNow("identity_sessions_sync");

    expect(ops.filter((l) => l.opslog === "job_ran")).toEqual([
      expect.objectContaining({
        name: "identity_sessions_sync",
        ms: expect.any(Number),
        synced: 1,
        abandoned: 0,
        redactRequested: 0,
        redacted: 0,
        errors: 0,
      }),
    ]);
  });
});
