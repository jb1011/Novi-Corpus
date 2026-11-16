/**
 * The setting that names the pair of legal texts a deployment serves, LEGAL_BODY_AGREEMENT_VERSION.
 * The load only reads it: blank is unset, and any other value is trimmed and carried as given.
 * Which names are pairs is decided at start, where any other name refuses boot.
 */
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const BASE = {
  ARC_TESTNET_RPC_URL: "https://rpc.example",
  PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
};

/** The feature on: controller mode, the full-product factory, and the legal-body factory. */
const FEATURE_ON = {
  ...BASE,
  CONTROLLER_ADDRESS: "0x1111111111111111111111111111111111111111",
  CONTROLLER_DEPLOY_TX: `0x${"ab".repeat(32)}`,
  CONTROLLER_DEPLOY_BLOCK: "10",
  FACTORY_ADDRESS: "0x2222222222222222222222222222222222222222",
  LEGAL_BODY_FACTORY_ADDRESS: "0x3333333333333333333333333333333333333333",
};

const versionNamed = (env: Record<string, string>, value?: string) =>
  loadConfig(value === undefined ? env : { ...env, LEGAL_BODY_AGREEMENT_VERSION: value })
    .legalBodyAgreementVersion;

test("unset or blank, no version is named, the feature on or off", () => {
  for (const env of [BASE, FEATURE_ON]) {
    expect(versionNamed(env)).toBeUndefined();
    expect(versionNamed(env, "")).toBeUndefined();
    expect(versionNamed(env, "   ")).toBeUndefined();
  }
});

test("a version is trimmed", () => {
  expect(versionNamed(FEATURE_ON, " 2026-11-draft-5 ")).toBe("2026-11-draft-5");
  expect(versionNamed(FEATURE_ON, "2026-10-draft-1")).toBe("2026-10-draft-1");
});

test("any other text is carried as given: the refusal is made at start, not at load", () => {
  for (const given of ["2026-11-draft-4", "2026-11-DRAFT-5", "latest"])
    expect(versionNamed(FEATURE_ON, given), given).toBe(given);
});
