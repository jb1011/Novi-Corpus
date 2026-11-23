/**
 * The automatic identity check's settings: the Stripe Identity block (`cfg.stripeIdentity`), the
 * OpenSanctions block (`cfg.screening.openSanctions`), the identity session limits on
 * `cfg.identity`, and the six boot rules that tie them to the deployment.
 *
 * Every key here is an obvious placeholder (`rk_test_xxxx…`), never one Stripe or OpenSanctions
 * issued, and the private keys are placeholders or anvil's published test account #0.
 */
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};

const PII_KEY = Buffer.alloc(32, 7);
const NAME_HMAC_KEY = Buffer.alloc(32, 5);
/** The PII key and the fingerprint key that goes with it. */
const PII = {
  FORMATION_PII_KEY: PII_KEY.toString("base64"),
  IDENTITY_NAME_HMAC_KEY: NAME_HMAC_KEY.toString("hex"),
};

const TEST_KEY = `rk_test_${"x".repeat(24)}`;
const LIVE_KEY = `rk_live_${"x".repeat(24)}`;
const FLOW_ID = `vf_${"x".repeat(24)}`;
const WEBHOOK_SECRET = `whsec_${"x".repeat(32)}`;
const WEBHOOK_SECRET_PREVIOUS = `whsec_${"y".repeat(32)}`;
const SCREENING_KEY = `osk${"z".repeat(29)}`;

/** The three Stripe settings, in test mode. */
const STRIPE_TEST = {
  STRIPE_IDENTITY_KEY: TEST_KEY,
  STRIPE_IDENTITY_FLOW_ID: FLOW_ID,
  STRIPE_IDENTITY_WEBHOOK_SECRET: WEBHOOK_SECRET,
};
const STRIPE_LIVE = { ...STRIPE_TEST, STRIPE_IDENTITY_KEY: LIVE_KEY };

/** A sandbox deployment (ARC_NETWORK unset) with the identity check configured, that boots. */
const SANDBOX_CHECK = {
  ...BASE,
  ...PII,
  ...STRIPE_TEST,
  WEB_ORIGIN: "https://testnet.example.com",
};

/** A sandbox doola block: no SSN is ever collected on such a box. */
const DOOLA_SANDBOX = {
  DOOLA_API_KEY: "dk_test_key",
  DOOLA_WEBHOOK_SECRET: "whsec_doola_test",
};

/** A mainnet deployment with the legal-body feature on that boots (`identityEnv.test.ts`). */
const MAINNET_LEGAL_BODY = {
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
};

/** The same mainnet deployment with the identity check configured, that boots. */
const PRODUCTION_CHECK = {
  ...MAINNET_LEGAL_BODY,
  ...STRIPE_LIVE,
  OPENSANCTIONS_API_KEY: SCREENING_KEY,
  WEB_ORIGIN: "https://app.example.com",
};

const NEEDS_THE_PII_KEY =
  "Invalid config: the Stripe Identity block requires FORMATION_PII_KEY: the identity check seals the names of record under it";
const NEEDS_THE_SCREENING_KEY =
  "Invalid config: the Stripe Identity block on a production deployment (ARC_NETWORK=mainnet) requires OPENSANCTIONS_API_KEY: a production pass needs the sanctions search";
const NEEDS_AN_ORIGIN =
  "Invalid config: WEB_ORIGIN must be an explicit origin (scheme and host, not '*') when the Stripe Identity block is set: the identity check's return URL is built on it";

/** The message `fn` throws, or undefined when it returns. */
function thrownBy(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

/** `env` without the named settings. */
function without(env: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

test("the three Stripe settings are all or nothing", () => {
  const names = Object.keys(STRIPE_TEST);
  // Every one or two of the three: six half blocks, each refused with what is missing named.
  const halves = [
    [names[0]],
    [names[1]],
    [names[2]],
    [names[0], names[1]],
    [names[0], names[2]],
    [names[1], names[2]],
  ] as string[][];
  for (const kept of halves) {
    const missing = names.filter((name) => !kept.includes(name));
    const message = thrownBy(() => loadConfig(without(SANDBOX_CHECK, ...missing)));
    expect(message, kept.join("+")).toMatch(/^Invalid config: STRIPE_IDENTITY/);
    expect(message, kept.join("+")).toContain("(all-or-nothing)");
    for (const name of missing) expect(message, kept.join("+")).toContain(name);
  }
  // None of the three is the shape every deployment has today.
  expect(loadConfig(BASE).stripeIdentity).toBeUndefined();
  // All three boot, and the block holds them.
  const cfg = loadConfig(SANDBOX_CHECK);
  expect(cfg.stripeIdentity?.key.reveal()).toBe(TEST_KEY);
  expect(cfg.stripeIdentity?.flowId).toBe(FLOW_ID);
  expect(cfg.stripeIdentity?.webhookSecret.reveal()).toBe(WEBHOOK_SECRET);
  expect(cfg.stripeIdentity?.webhookSecretPrevious).toBeUndefined();
  const rotating = loadConfig({
    ...SANDBOX_CHECK,
    STRIPE_IDENTITY_WEBHOOK_SECRET_PREVIOUS: WEBHOOK_SECRET_PREVIOUS,
  });
  expect(rotating.stripeIdentity?.webhookSecretPrevious?.reveal()).toBe(WEBHOOK_SECRET_PREVIOUS);
});

test("a key, a flow id or a webhook secret of the wrong shape is refused", () => {
  for (const [name, bad] of [
    ["STRIPE_IDENTITY_KEY", `pk_test_${"x".repeat(24)}`],
    ["STRIPE_IDENTITY_KEY", `sk_${"x".repeat(24)}`],
    ["STRIPE_IDENTITY_KEY", `rk_prod_${"x".repeat(24)}`],
    ["STRIPE_IDENTITY_KEY", `${TEST_KEY} `],
    ["STRIPE_IDENTITY_KEY", "rk_test_"],
    ["STRIPE_IDENTITY_FLOW_ID", `vs_${"x".repeat(24)}`],
    ["STRIPE_IDENTITY_FLOW_ID", "vf_"],
    ["STRIPE_IDENTITY_FLOW_ID", `vf_${"x".repeat(8)}-${"x".repeat(8)}`],
    ["STRIPE_IDENTITY_WEBHOOK_SECRET", "x".repeat(32)],
    ["STRIPE_IDENTITY_WEBHOOK_SECRET", "whsec_"],
    ["STRIPE_IDENTITY_WEBHOOK_SECRET", `${WEBHOOK_SECRET} `],
    ["STRIPE_IDENTITY_WEBHOOK_SECRET_PREVIOUS", "y".repeat(32)],
  ] as const) {
    const message = thrownBy(() => loadConfig({ ...SANDBOX_CHECK, [name]: bad }));
    expect(message, `${name}=${bad}`).toMatch(new RegExp(`^Invalid config: ${name} `));
    // The refusal never echoes the value it refused: one of them is a key.
    expect(message, `${name}=${bad}`).not.toContain("x".repeat(24));
  }
  // A blank value is unset, so a blank key alone is no Stripe block at all.
  expect(loadConfig({ ...BASE, STRIPE_IDENTITY_KEY: "" }).stripeIdentity).toBeUndefined();
});

test("a live key on a sandbox deployment is refused, and a test key on production", () => {
  // The prefix decides the mode.
  for (const key of [`sk_test_${"x".repeat(24)}`, TEST_KEY])
    expect(loadConfig({ ...SANDBOX_CHECK, STRIPE_IDENTITY_KEY: key }).stripeIdentity?.mode).toBe(
      "test",
    );
  for (const key of [`sk_live_${"x".repeat(24)}`, LIVE_KEY])
    expect(loadConfig({ ...PRODUCTION_CHECK, STRIPE_IDENTITY_KEY: key }).stripeIdentity?.mode).toBe(
      "live",
    );

  for (const key of [`sk_live_${"x".repeat(24)}`, LIVE_KEY])
    expect(thrownBy(() => loadConfig({ ...SANDBOX_CHECK, STRIPE_IDENTITY_KEY: key }))).toBe(
      "Invalid config: STRIPE_IDENTITY_KEY is a live key on a sandbox deployment: a sandbox runs the identity check in Stripe's test mode only (use an sk_test_ or rk_test_ key)",
    );
  // Testnet named explicitly is a sandbox too.
  expect(
    thrownBy(() =>
      loadConfig({ ...SANDBOX_CHECK, ARC_NETWORK: "testnet", STRIPE_IDENTITY_KEY: LIVE_KEY }),
    ),
  ).toMatch(/is a live key on a sandbox deployment/);
  for (const key of [`sk_test_${"x".repeat(24)}`, TEST_KEY])
    expect(thrownBy(() => loadConfig({ ...PRODUCTION_CHECK, STRIPE_IDENTITY_KEY: key }))).toBe(
      "Invalid config: STRIPE_IDENTITY_KEY is a test key on a production deployment (ARC_NETWORK=mainnet): a test-mode check says nothing about a real person (use an sk_live_ or rk_live_ key)",
    );
});

test("the Stripe block needs the PII key", () => {
  // The fingerprint key alone is not enough: the names are sealed under the PII key.
  expect(thrownBy(() => loadConfig(without(SANDBOX_CHECK, "FORMATION_PII_KEY")))).toBe(
    NEEDS_THE_PII_KEY,
  );
  expect(
    thrownBy(() =>
      loadConfig(without(SANDBOX_CHECK, "FORMATION_PII_KEY", "IDENTITY_NAME_HMAC_KEY")),
    ),
  ).toBe(NEEDS_THE_PII_KEY);
  // With the PII key, the fingerprint key is required as it always is.
  expect(thrownBy(() => loadConfig(without(SANDBOX_CHECK, "IDENTITY_NAME_HMAC_KEY")))).toBe(
    "Invalid config: IDENTITY_NAME_HMAC_KEY is required with FORMATION_PII_KEY: the identity record's duplicate check uses it",
  );
});

test("the PII key is allowed on a sandbox doola box once the Stripe block is set", () => {
  const cfg = loadConfig({ ...SANDBOX_CHECK, ...DOOLA_SANDBOX });
  expect(cfg.doola?.environment).toBe("sandbox");
  expect(cfg.pii).toBeDefined();
  expect(cfg.pii?.current.key.equals(PII_KEY)).toBe(true);
  // The SSN's keyring is withheld from formation on that box: a sandbox never collects an SSN, so
  // every SSN path there stays exactly as it is with no key (it refuses, it never seals).
  expect(cfg.formation?.pii).toBeUndefined();

  // Without the Stripe block the same box is refused, and the refusal names the way out.
  const refused = thrownBy(() =>
    loadConfig({ ...BASE, ...PII, ...DOOLA_SANDBOX, WEB_ORIGIN: "https://testnet.example.com" }),
  );
  expect(refused).toMatch(
    /^Invalid config: FORMATION_PII_KEY is set with DOOLA_ENVIRONMENT=sandbox/,
  );
  expect(refused).toContain("(or configure the identity check, which seals names under it)");

  // A rotation is still checked on that box: the same key in both slots is refused.
  expect(
    thrownBy(() =>
      loadConfig({
        ...SANDBOX_CHECK,
        ...DOOLA_SANDBOX,
        FORMATION_PII_KEY_PREVIOUS: PII_KEY.toString("base64"),
      }),
    ),
  ).toMatch(/^Invalid config: FORMATION_PII_KEY and FORMATION_PII_KEY_PREVIOUS are the SAME key/);

  // On every other shape the two are still one object.
  const noDoola = loadConfig(SANDBOX_CHECK);
  expect(noDoola.pii).toBeDefined();
  expect(noDoola.formation?.pii).toBe(noDoola.pii);
  const production = loadConfig(PRODUCTION_CHECK);
  expect(production.formation?.pii).toBe(production.pii);
});

test("production with the Stripe block needs the OpenSanctions key", () => {
  expect(thrownBy(() => loadConfig(without(PRODUCTION_CHECK, "OPENSANCTIONS_API_KEY")))).toBe(
    NEEDS_THE_SCREENING_KEY,
  );
  const cfg = loadConfig(PRODUCTION_CHECK);
  expect(cfg.screening?.openSanctions?.apiKey.reveal()).toBe(SCREENING_KEY);
  // A sandbox needs none: its rows are held to nothing.
  expect(loadConfig(SANDBOX_CHECK).screening).toBeUndefined();
  // A production deployment without the Stripe block needs none either: the rule is the check's.
  expect(() => loadConfig(MAINNET_LEGAL_BODY)).not.toThrow();
});

test("the Stripe block needs an explicit WEB_ORIGIN", () => {
  for (const env of [SANDBOX_CHECK, PRODUCTION_CHECK]) {
    // Unset is the dev default, '*'.
    expect(thrownBy(() => loadConfig(without(env, "WEB_ORIGIN")))).toBe(NEEDS_AN_ORIGIN);
    for (const bad of [
      "*",
      "testnet.example.com",
      "https://testnet.example.com/",
      "https://testnet.example.com/legal-body",
      "https://testnet.example.com?x=1",
      "ftp://testnet.example.com",
      "not an origin",
    ])
      expect(
        thrownBy(() => loadConfig({ ...env, WEB_ORIGIN: bad })),
        bad,
      ).toBe(NEEDS_AN_ORIGIN);
  }
  // A scheme and a host, with a port when it has one, on any environment.
  for (const origin of ["http://localhost:3000", "https://testnet.example.com"])
    expect(loadConfig({ ...SANDBOX_CHECK, WEB_ORIGIN: origin }).webOrigin).toBe(origin);
  // Without the Stripe block a sandbox keeps the dev default.
  expect(loadConfig(BASE).webOrigin).toBe("*");
});

test("the defaults: dataset default, threshold 0.8, 14 days, 3 a day, 3 attempts, 7 days, 10 minutes", () => {
  const cfg = loadConfig({ ...SANDBOX_CHECK, OPENSANCTIONS_API_KEY: SCREENING_KEY });
  expect(cfg.screening?.openSanctions?.dataset).toBe("default");
  expect(cfg.screening?.openSanctions?.threshold).toBe(0.8);
  expect(cfg.identity.sessionDays).toBe(14);
  expect(cfg.identity.sessionMaxPerDay).toBe(3);
  expect(cfg.identity.attemptsPerSession).toBe(3);
  expect(cfg.identity.redactAfterDays).toBe(7);
  expect(cfg.identity.syncEveryMs).toBe(600_000);
  // The session limits are present on every deployment, the check configured or not.
  const bare = loadConfig(BASE);
  expect(bare.identity.sessionDays).toBe(14);
  expect(bare.identity.syncEveryMs).toBe(600_000);
});

test("the screening and session settings take their ranges, and refuse outside them", () => {
  const cfg = loadConfig({
    ...SANDBOX_CHECK,
    OPENSANCTIONS_API_KEY: SCREENING_KEY,
    OPENSANCTIONS_DATASET: "sanctions",
    OPENSANCTIONS_THRESHOLD: "0.5",
    IDENTITY_SESSION_DAYS: "60",
    IDENTITY_SESSION_MAX_PER_DAY: "10",
    IDENTITY_ATTEMPTS_PER_SESSION: "5",
    IDENTITY_REDACT_AFTER_DAYS: "30",
    IDENTITY_SYNC_EVERY_MS: "60000",
  });
  expect(cfg.screening?.openSanctions).toMatchObject({ dataset: "sanctions", threshold: 0.5 });
  expect(cfg.identity).toMatchObject({
    sessionDays: 60,
    sessionMaxPerDay: 10,
    attemptsPerSession: 5,
    redactAfterDays: 30,
    syncEveryMs: 60_000,
  });
  expect(
    loadConfig({ ...BASE, OPENSANCTIONS_API_KEY: SCREENING_KEY, OPENSANCTIONS_THRESHOLD: "1" })
      .screening?.openSanctions?.threshold,
  ).toBe(1);

  for (const [name, bad] of [
    ["OPENSANCTIONS_THRESHOLD", "0.49"],
    ["OPENSANCTIONS_THRESHOLD", "1.01"],
    ["OPENSANCTIONS_THRESHOLD", "high"],
    ["OPENSANCTIONS_DATASET", "default?x=1"],
    ["OPENSANCTIONS_DATASET", "../default"],
    ["IDENTITY_SESSION_DAYS", "0"],
    ["IDENTITY_SESSION_DAYS", "61"],
    ["IDENTITY_SESSION_DAYS", "1.5"],
    ["IDENTITY_SESSION_MAX_PER_DAY", "0"],
    ["IDENTITY_SESSION_MAX_PER_DAY", "11"],
    ["IDENTITY_ATTEMPTS_PER_SESSION", "0"],
    ["IDENTITY_ATTEMPTS_PER_SESSION", "6"],
    ["IDENTITY_REDACT_AFTER_DAYS", "0"],
    ["IDENTITY_REDACT_AFTER_DAYS", "31"],
    ["IDENTITY_SYNC_EVERY_MS", "59999"],
    // A timer cannot hold more: a longer delay would fire at once, in a loop.
    ["IDENTITY_SYNC_EVERY_MS", "2147483648"],
  ] as const)
    expect(
      thrownBy(() => loadConfig({ ...BASE, [name]: bad })),
      `${name}=${bad}`,
    ).toMatch(new RegExp(`^Invalid config: ${name} `));
});

test("redact hides the key, the webhook secrets and the screening key", () => {
  const stripeKey = `sk_test_${"x".repeat(24)}`;
  const cfg = loadConfig({
    ...SANDBOX_CHECK,
    STRIPE_IDENTITY_KEY: stripeKey,
    STRIPE_IDENTITY_WEBHOOK_SECRET_PREVIOUS: WEBHOOK_SECRET_PREVIOUS,
    OPENSANCTIONS_API_KEY: SCREENING_KEY,
  });
  const printed = JSON.stringify(redact(cfg));
  expect(printed).not.toContain("sk_test_");
  expect(printed).not.toContain(stripeKey);
  expect(printed).not.toContain("whsec_");
  expect(printed).not.toContain(SCREENING_KEY);
  const view = redact(cfg) as {
    stripeIdentity: Record<string, unknown>;
    screening: { openSanctions: Record<string, unknown> };
    identity: Record<string, unknown>;
  };
  // The mode and the flow id are what an operator checks in the boot line; they stay.
  expect(view.stripeIdentity).toEqual({
    key: "REDACTED",
    mode: "test",
    flowId: FLOW_ID,
    webhookSecret: "REDACTED",
    webhookSecretPrevious: "REDACTED",
  });
  expect(view.screening.openSanctions).toEqual({
    apiKey: "REDACTED",
    dataset: "default",
    threshold: 0.8,
  });
  expect(view.identity).toMatchObject({ sessionDays: 14, syncEveryMs: 600_000 });
  // Without the blocks, nothing is printed for them.
  const bare = redact(loadConfig(BASE));
  expect(bare.stripeIdentity).toBeUndefined();
  expect(bare.screening).toBeUndefined();
});
