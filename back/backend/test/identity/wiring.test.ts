/**
 * The identity check's wiring (`identityWiringOf`): what the API process builds from its config
 * for the identity record, the automatic identity check and its webhook, and the boot line that
 * says so. `main.ts` hands the three objects to `buildApiApp` and the check to
 * `buildScheduledJobs`; this is the one place they are built, so the rules that bind them are
 * tested here: the record is one object, the check and the webhook name one environment, the
 * check is automatic only where the Stripe block is set, and the screener is there only with its
 * key.
 *
 * The database is real (in memory); nothing here calls Stripe or OpenSanctions. Every key is an
 * obvious placeholder (`rk_test_xxxx…`), never one a provider issued, and the private keys are
 * placeholders or anvil's published test account #0.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { StripeIdentityClient } from "../../src/adapters/stripe/identityClient";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { type Config, loadConfig } from "../../src/config/env";
import { identityCheckBootLine, identityWiringOf } from "../../src/identity/wiring";
import { migrate, openDatabase } from "../../src/persistence/db";
import { buildScheduledJobs } from "../../src/scheduler/jobs";
import { OpenSanctionsPersonScreener } from "../../src/screening/personScreener";
import { TaskTracker } from "../../src/util/taskTracker";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};
const PII = {
  FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
  IDENTITY_NAME_HMAC_KEY: Buffer.alloc(32, 5).toString("hex"),
};
const TEST_KEY = `rk_test_${"x".repeat(24)}`;
const LIVE_KEY = `rk_live_${"x".repeat(24)}`;
const FLOW_ID = `vf_${"q".repeat(24)}`;
const WEBHOOK_SECRET = `whsec_${"x".repeat(32)}`;
const SCREENING_KEY = `osk${"z".repeat(29)}`;
const STRIPE_TEST = {
  STRIPE_IDENTITY_KEY: TEST_KEY,
  STRIPE_IDENTITY_FLOW_ID: FLOW_ID,
  STRIPE_IDENTITY_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

/** A sandbox deployment (ARC_NETWORK unset) with the PII key and no Stripe block, that boots. */
const SANDBOX_RECORD = { ...BASE, ...PII };
/** The same sandbox deployment with the identity check configured, that boots. */
const SANDBOX_CHECK = {
  ...SANDBOX_RECORD,
  ...STRIPE_TEST,
  WEB_ORIGIN: "https://testnet.example.com",
};
/** The testnet box's shape once its environment gains the Stripe block: a sandbox doola block. */
const SANDBOX_DOOLA_CHECK = {
  ...SANDBOX_CHECK,
  DOOLA_API_KEY: "dk_test_key",
  DOOLA_WEBHOOK_SECRET: "whsec_doola_test",
};
/** A mainnet deployment with the legal-body feature and the identity check, that boots. */
const PRODUCTION_CHECK = {
  ...BASE,
  ...PII,
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  CONTROLLER_DEPLOY_TX: `0x${"ab".repeat(32)}`,
  CONTROLLER_DEPLOY_BLOCK: "10",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
  ARC_NETWORK: "mainnet",
  FUNNEL_SALT: "0f".repeat(32),
  ARC_CHAIN_ID: "8004",
  WORLD_APP_ID: "app_1",
  WORLD_RP_ID: "app.example",
  WORLD_RP_SIGNING_KEY: "0xsigning",
  WORLD_REQUIRE_GUARDIAN: "true",
  WORLD_MAX_COMPANIES_PER_HUMAN: "3",
  DOOLA_ENVIRONMENT: "production",
  DOOLA_API_KEY: "dk_live_key",
  DOOLA_WEBHOOK_SECRET: "whsec_live",
  LEGAL_BODY_FACTORY_ADDRESS: "0x3333333333333333333333333333333333333333",
  // anvil's published account #0.
  NOVI_ATTESTATION_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  STRIPE_IDENTITY_KEY: LIVE_KEY,
  STRIPE_IDENTITY_FLOW_ID: FLOW_ID,
  STRIPE_IDENTITY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  OPENSANCTIONS_API_KEY: SCREENING_KEY,
  WEB_ORIGIN: "https://app.example.com",
};

/** A stand-in for the World deps main.ts builds: the wiring hands it on and never reads it. */
const WORLD = { cfg: { action: "verify-guardian" } } as unknown as WorldIdDeps;

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => {
  db.close();
});

const wiringOf = (cfg: Config, tasks = new TaskTracker("identity_webhook_task")) =>
  identityWiringOf(cfg, db, WORLD, tasks);

describe("identityWiringOf", () => {
  test("without the PII key: no record, no check, no webhook", () => {
    const wired = wiringOf(loadConfig(BASE));
    expect(wired).toEqual({
      identity: undefined,
      identityCheck: undefined,
      stripeIdentity: undefined,
    });
  });

  test("with the PII key and no Stripe block: the record, not automatic, and no check", () => {
    const cfg = loadConfig(SANDBOX_RECORD);
    const wired = wiringOf(cfg);
    expect(wired.identity).toBeDefined();
    expect(wired.identity?.automatic).toBe(false);
    expect(wired.identity?.pii).toBe(cfg.pii);
    expect(wired.identity?.reverifyYears).toBe(cfg.identity.reverifyYears);
    expect(wired.identity?.blockedCountries).toBe(cfg.identity.blockedCountries);
    expect(wired.identityCheck).toBeUndefined();
    expect(wired.stripeIdentity).toBeUndefined();
  });

  test("with the Stripe block on a sandbox: automatic, the check's record IS the record, and the two blocks name the sandbox", () => {
    const cfg = loadConfig(SANDBOX_CHECK);
    const tasks = new TaskTracker("identity_webhook_task");
    const wired = wiringOf(cfg, tasks);
    const check = wired.identityCheck;
    expect(check).toBeDefined();
    // One object: a check it completes is the record `/world-id/me` and the gate read.
    expect(check?.identity).toBe(wired.identity);
    expect(wired.identity?.automatic).toBe(true);
    expect(check?.identity.nameHmacKey).toBe(cfg.identity.nameHmacKey);
    expect(check?.environment).toBe("sandbox");
    expect(wired.stripeIdentity?.environment).toBe("sandbox");
    expect(check?.provider).toBeInstanceOf(StripeIdentityClient);
    // A sandbox without the OpenSanctions key screens nothing.
    expect(check?.screener).toBeUndefined();
    expect(check?.world).toBe(WORLD);
    expect(check?.tasks).toBe(tasks);
    expect(check?.flowId).toBe(FLOW_ID);
    expect(check?.webOrigin).toBe("https://testnet.example.com");
    expect(check?.limits).toEqual({
      sessionDays: cfg.identity.sessionDays,
      maxPerDay: cfg.identity.sessionMaxPerDay,
      attemptsPerSession: cfg.identity.attemptsPerSession,
      redactAfterDays: cfg.identity.redactAfterDays,
    });
    // The webhook's secrets are the config's own wrappers, never revealed here.
    expect(wired.stripeIdentity?.webhookSecret).toBe(cfg.stripeIdentity?.webhookSecret);
    expect(wired.stripeIdentity?.webhookSecretPrevious).toBeUndefined();
  });

  test("the session limits are the config's, as set", () => {
    const cfg = loadConfig({
      ...SANDBOX_CHECK,
      IDENTITY_SESSION_DAYS: "9",
      IDENTITY_SESSION_MAX_PER_DAY: "2",
      IDENTITY_ATTEMPTS_PER_SESSION: "4",
      IDENTITY_REDACT_AFTER_DAYS: "11",
      STRIPE_IDENTITY_WEBHOOK_SECRET_PREVIOUS: `whsec_${"y".repeat(32)}`,
    });
    const wired = wiringOf(cfg);
    expect(wired.identityCheck?.limits).toEqual({
      sessionDays: 9,
      maxPerDay: 2,
      attemptsPerSession: 4,
      redactAfterDays: 11,
    });
    expect(wired.stripeIdentity?.webhookSecretPrevious).toBe(
      cfg.stripeIdentity?.webhookSecretPrevious,
    );
  });

  test("a sandbox with the OpenSanctions key screens", () => {
    const wired = wiringOf(loadConfig({ ...SANDBOX_CHECK, OPENSANCTIONS_API_KEY: SCREENING_KEY }));
    expect(wired.identityCheck?.screener).toBeInstanceOf(OpenSanctionsPersonScreener);
  });

  test("the testnet box with a sandbox doola block and the Stripe block: the check is wired, and its two jobs register", () => {
    const cfg = loadConfig(SANDBOX_DOOLA_CHECK);
    const wired = wiringOf(cfg);
    expect(wired.identityCheck?.environment).toBe("sandbox");
    expect(wired.identityCheck?.identity).toBe(wired.identity);
    // The scheduler starts where a job is registered: the name sweep (the PII key) and the
    // session sync (the check handed in).
    const jobs = buildScheduledJobs(db, cfg, { identitySessions: wired.identityCheck });
    expect(jobs.map((j) => j.name).sort()).toEqual(["identity_sessions_sync", "identity_sweep"]);
  });

  test("on production: automatic, the two blocks name production, and the screener is there", () => {
    const wired = wiringOf(loadConfig(PRODUCTION_CHECK));
    expect(wired.identityCheck?.identity).toBe(wired.identity);
    expect(wired.identity?.automatic).toBe(true);
    expect(wired.identityCheck?.environment).toBe("production");
    expect(wired.stripeIdentity?.environment).toBe("production");
    expect(wired.identityCheck?.screener).toBeInstanceOf(OpenSanctionsPersonScreener);
  });
});

describe("identityCheckBootLine", () => {
  test("offered on a sandbox, in test mode", () => {
    expect(identityCheckBootLine(loadConfig(SANDBOX_CHECK))).toBe(
      "⚠ identity check: automatic (stripe, test), offered",
    );
  });

  test("required on production, in live mode", () => {
    expect(identityCheckBootLine(loadConfig(PRODUCTION_CHECK))).toBe(
      "⚠ identity check: automatic (stripe, live), required",
    );
  });

  test("no line without the Stripe block", () => {
    expect(identityCheckBootLine(loadConfig(SANDBOX_RECORD))).toBeUndefined();
    expect(identityCheckBootLine(loadConfig(BASE))).toBeUndefined();
  });

  test("never the key, the flow id or the webhook secret", () => {
    for (const env of [SANDBOX_CHECK, PRODUCTION_CHECK]) {
      const line = identityCheckBootLine(loadConfig(env)) ?? "";
      for (const secret of [TEST_KEY, LIVE_KEY, FLOW_ID, WEBHOOK_SECRET, "vf_", "rk_", "whsec_"])
        expect(line).not.toContain(secret);
    }
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the other composition guards do: main.ts builds the wiring once, over its World deps and
 * its own tracker, prints the boot line, and hands the three objects on: the record and the
 * check to the doors, the check to the scheduler, and the tracker to the SIGTERM drain.
 */
test("the composition root builds the wiring once and hands it to the app, the scheduler and the drain", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const builtAt = main.indexOf(
    "const { identity, identityCheck, stripeIdentity } = identityWiringOf(",
  );
  expect(builtAt, "the wiring was not found").toBeGreaterThan(0);
  expect(main.split("identityWiringOf(")).toHaveLength(2);
  expect(main.slice(builtAt, main.indexOf(");", builtAt))).toMatch(
    /identityWiringOf\(\s*cfg,\s*db,\s*worldId,\s*identityTasks,\s*$/,
  );
  // After the World deps it hands on, before the first door that reads the record.
  expect(main.indexOf("const worldId = ")).toBeLessThan(builtAt);
  expect(builtAt).toBeLessThan(main.indexOf("const legalBodyOrders ="));
  expect(main).toMatch(/^ {2}const identityTasks = new TaskTracker\("identity_webhook_task"\);$/m);
  expect(main).toMatch(
    /^ {2}const identityLine = identityCheckBootLine\(cfg\);\n {2}if \(identityLine\) console\.warn\(identityLine\);$/m,
  );
  // The scheduler's list holds the session sync where the check was built.
  expect(builtAt).toBeLessThan(
    main.indexOf("buildScheduledJobs(db, cfg, { identitySessions: identityCheck })"),
  );
  // The app's deps: the record, the check and the webhook, each by its own name.
  const appAt = main.indexOf("const app = buildApiApp({");
  const app = main.slice(appAt, main.indexOf("\n  });", appAt));
  for (const key of ["identity", "identityCheck", "stripeIdentity"])
    expect(app, key).toMatch(new RegExp(`^ {4}${key},$`, "m"));
  // The drain on SIGTERM waits for the identity check's tracker beside doola's.
  const shutdownAt = main.indexOf("installShutdownHandlers({");
  expect(main.slice(shutdownAt, main.indexOf("});", shutdownAt))).toContain(
    "tasks: settledAll([doolaTasks, identityTasks]),",
  );
});
