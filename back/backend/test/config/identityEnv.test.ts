/**
 * The guardian identity record's settings (`cfg.identity`), the PII keyring parsed once
 * (`cfg.pii`, the same object as `cfg.formation.pii`), the rule that a mainnet deployment with
 * the legal-body feature on holds that keyring (the record encrypts names under it), and the name
 * fingerprint's own secret (`IDENTITY_NAME_HMAC_KEY`, `cfg.identity.nameHmacKey`), required with
 * the PII key.
 *
 * Every key here is a placeholder or one of anvil's published test accounts, never a real wallet.
 */
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};

/** Controller mode with the full-product factory named: what the legal-body factory requires. */
const CONTROLLER_MODE = {
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  CONTROLLER_DEPLOY_TX: `0x${"ab".repeat(32)}`,
  CONTROLLER_DEPLOY_BLOCK: "10",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
};
const LB_FACTORY = "0x3333333333333333333333333333333333333333";
/** anvil's published account #0. */
const ATTESTATION_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PII_KEY = Buffer.alloc(32, 7);
/** The fingerprint secret: a constant test key, 64 hex characters. */
const NAME_HMAC_KEY = Buffer.alloc(32, 5);

/** A mainnet deployment with the legal-body feature on that boots: a production provider with the
 *  identity and SSN-key floors, controller mode, the factory and the attestation key. */
const MAINNET_LEGAL_BODY = {
  ...BASE,
  ...CONTROLLER_MODE,
  ARC_NETWORK: "mainnet",
  // The funnel's salt: a production deployment refuses to boot without one.
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
  FORMATION_PII_KEY: PII_KEY.toString("base64"),
  IDENTITY_NAME_HMAC_KEY: NAME_HMAC_KEY.toString("hex"),
  LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY,
  NOVI_ATTESTATION_KEY: ATTESTATION_KEY,
};

const NEEDS_THE_PII_KEY =
  "Invalid config: a mainnet deployment with LEGAL_BODY_FACTORY_ADDRESS requires FORMATION_PII_KEY: the guardian identity record encrypts names under it";

/** The message `fn` throws, or undefined when it returns. */
function thrownBy(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

test("the identity settings default: three years, 365 and 30 days, Cuba, Iran and North Korea blocked", () => {
  const cfg = loadConfig(BASE);
  expect(cfg.identity.reverifyYears).toBe(3);
  expect(cfg.identity.unusedRetentionDays).toBe(365);
  expect(cfg.identity.failedRetentionDays).toBe(30);
  expect(cfg.identity.blockedCountries).toEqual(new Set(["CUB", "IRN", "PRK"]));
});

test("the identity settings are overridable", () => {
  const cfg = loadConfig({
    ...BASE,
    IDENTITY_REVERIFY_YEARS: "5",
    IDENTITY_UNUSED_RETENTION_DAYS: "30",
    IDENTITY_FAILED_RETENTION_DAYS: "1",
    SCREENING_BLOCKED_COUNTRIES: "SYR, CUB",
  });
  expect(cfg.identity).toEqual({
    reverifyYears: 5,
    unusedRetentionDays: 30,
    failedRetentionDays: 1,
    blockedCountries: new Set(["SYR", "CUB"]),
  });
});

test("a blocked country that is not three upper-case letters refuses to boot", () => {
  for (const bad of ["cub", "CU", "CUBA", "CUB,,IRN", "", "CUB;IRN"])
    expect(
      thrownBy(() => loadConfig({ ...BASE, SCREENING_BLOCKED_COUNTRIES: bad })),
      bad,
    ).toMatch(/^Invalid config: SCREENING_BLOCKED_COUNTRIES /);
});

test("the reverify years and the retention days refuse out-of-range values", () => {
  for (const [name, bad] of [
    ["IDENTITY_REVERIFY_YEARS", "0"],
    ["IDENTITY_REVERIFY_YEARS", "11"],
    ["IDENTITY_REVERIFY_YEARS", "2.5"],
    ["IDENTITY_UNUSED_RETENTION_DAYS", "29"],
    ["IDENTITY_FAILED_RETENTION_DAYS", "0"],
  ] as const)
    expect(
      thrownBy(() => loadConfig({ ...BASE, [name]: bad })),
      `${name}=${bad}`,
    ).toMatch(new RegExp(`^Invalid config: ${name} `));
});

test("a mainnet deployment with the factory and no PII key refuses to boot", () => {
  const { FORMATION_PII_KEY: _key, ...noKey } = MAINNET_LEGAL_BODY;
  expect(thrownBy(() => loadConfig(noKey))).toBe(NEEDS_THE_PII_KEY);
});

test("the same deployment with the key boots, and the keyring is parsed once", () => {
  const cfg = loadConfig(MAINNET_LEGAL_BODY);
  expect(cfg.pii?.current.key.equals(PII_KEY)).toBe(true);
  expect(cfg.formation).toBeDefined();
  expect(cfg.pii).toBe(cfg.formation?.pii);
});

test("the PII key without the fingerprint key refuses to boot", () => {
  const { IDENTITY_NAME_HMAC_KEY: _fingerprint, ...noFingerprint } = MAINNET_LEGAL_BODY;
  expect(thrownBy(() => loadConfig(noFingerprint))).toBe(
    "Invalid config: IDENTITY_NAME_HMAC_KEY is required with FORMATION_PII_KEY: the identity record's duplicate check uses it",
  );
});

test("the fingerprint key is parsed once at boot: 32 bytes written as 64 hex characters", () => {
  expect(loadConfig(MAINNET_LEGAL_BODY).identity.nameHmacKey?.equals(NAME_HMAC_KEY)).toBe(true);
  for (const bad of [
    NAME_HMAC_KEY.toString("base64"),
    NAME_HMAC_KEY.toString("hex").slice(1),
    `${NAME_HMAC_KEY.toString("hex")}0`,
    `${NAME_HMAC_KEY.toString("hex").slice(2)}zz`,
    " ",
  ])
    expect(
      thrownBy(() => loadConfig({ ...MAINNET_LEGAL_BODY, IDENTITY_NAME_HMAC_KEY: bad })),
      bad,
    ).toBe(
      "Invalid config: IDENTITY_NAME_HMAC_KEY must be 32 bytes written as 64 hex characters (generate one with: openssl rand -hex 32)",
    );
});

test("a deployment with no PII key has no keyring", () => {
  expect(loadConfig(BASE).pii).toBeUndefined();
});

test("a testnet deployment with the factory and no PII key boots", () => {
  const cfg = loadConfig({ ...BASE, ...CONTROLLER_MODE, LEGAL_BODY_FACTORY_ADDRESS: LB_FACTORY });
  expect(cfg.legalBodyFactory).toBeDefined();
  expect(cfg.pii).toBeUndefined();
});

test("redact() hides the top-level keyring and the fingerprint key, keeps the key ids, and prints the blocked countries sorted", () => {
  const previous = Buffer.alloc(32, 9);
  const cfg = loadConfig({
    ...MAINNET_LEGAL_BODY,
    FORMATION_PII_KEY_PREVIOUS: previous.toString("base64"),
    SCREENING_BLOCKED_COUNTRIES: "PRK,CUB,IRN",
  });
  const printed = JSON.stringify(redact(cfg));
  for (const key of [PII_KEY, previous, NAME_HMAC_KEY]) {
    expect(printed).not.toContain(key.toString("base64"));
    expect(printed).not.toContain(key.toString("hex"));
    expect(printed).not.toContain(JSON.stringify([...key]).slice(1, -1));
  }
  expect(printed).not.toContain('"type":"Buffer"');
  expect(redact(cfg).pii).toEqual({
    current: { id: cfg.pii!.current.id, key: "REDACTED" },
    previous: { id: cfg.pii!.previous!.id, key: "REDACTED" },
  });
  expect(redact(cfg).identity).toEqual({
    reverifyYears: 3,
    unusedRetentionDays: 365,
    failedRetentionDays: 30,
    blockedCountries: ["CUB", "IRN", "PRK"],
    nameHmacKey: "REDACTED",
  });
});
