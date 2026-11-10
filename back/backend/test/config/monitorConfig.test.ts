import { describe, expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";
import { watchedLegalBodyFactories } from "../../src/monitor/monitor";

const base = {
  ARC_TESTNET_RPC_URL: "https://rpc.testnet.arc.network",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  FACTORY_ADDRESS: "0x83D529E813Fe825b84250034A7A63f460A2ECA77",
  DATA_DIR: "/srv/novi/data",
};

test("monitor config defaults are present on every boot (no new required env)", () => {
  const cfg = loadConfig(base);
  expect(cfg.monitor).toEqual({
    pollSec: 30,
    grantTtlMin: 15,
    lookbackBlocks: 5000,
    dbPath: "/srv/novi/data/monitor.db",
    watchBeacons: [],
    watchFactories: [],
    watchLegalBodyFactories: [],
  });
  expect(cfg.alertWebhookUrl).toBeUndefined();
});

test("the monitor DB is separate from legalbody.db (it must never share the money-path schema)", () => {
  const cfg = loadConfig(base);
  expect(cfg.monitor?.dbPath).not.toBe(cfg.dbPath);
});

test("knobs are overridable", () => {
  const cfg = loadConfig({
    ...base,
    MONITOR_POLL_SEC: "10",
    MONITOR_GRANT_TTL_MIN: "5",
    MONITOR_LOOKBACK_BLOCKS: "250000",
  });
  expect(cfg.monitor?.pollSec).toBe(10);
  expect(cfg.monitor?.grantTtlMin).toBe(5);
  expect(cfg.monitor?.lookbackBlocks).toBe(250_000);
});

test("watch lists are parsed and checksum-normalized", () => {
  const cfg = loadConfig({
    ...base,
    MONITOR_WATCH_FACTORIES: "0x91997dfcde0046ea4abe67a5de9e1df54c9b6902",
    MONITOR_WATCH_BEACONS:
      " 0xCbE36eC37673805a185a6883f9597613ABB41c97 ,0x432ed0814FcDDd03330add098093482128Ad2CfD",
  });
  expect(cfg.monitor?.watchFactories).toEqual(["0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902"]);
  expect(cfg.monitor?.watchBeacons).toEqual([
    "0xCbE36eC37673805a185a6883f9597613ABB41c97",
    "0x432ed0814FcDDd03330add098093482128Ad2CfD",
  ]);
});

test("a malformed watch-list entry REFUSES the boot — a dropped beacon is a silent blind spot", () => {
  expect(() => loadConfig({ ...base, MONITOR_WATCH_BEACONS: "0xnope" })).toThrow(
    /MONITOR_WATCH_BEACONS contains "0xnope"/,
  );
  expect(() =>
    loadConfig({
      ...base,
      MONITOR_WATCH_FACTORIES: "0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902,,",
    }),
  ).toThrow(/MONITOR_WATCH_FACTORIES/);
});

test("ALERT_WEBHOOK_URL must be a URL and is REDACTED (the token is in the URL)", () => {
  expect(() => loadConfig({ ...base, ALERT_WEBHOOK_URL: "not-a-url" })).toThrow(
    /ALERT_WEBHOOK_URL/,
  );
  const cfg = loadConfig({
    ...base,
    ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/123/SUPER-SECRET-TOKEN",
  });
  expect(cfg.alertWebhookUrl).toContain("SUPER-SECRET-TOKEN");
  expect(JSON.stringify(redact(cfg))).not.toContain("SUPER-SECRET-TOKEN");
});

describe("MONITOR_WATCH_LEGAL_BODY_FACTORIES", () => {
  const LEGAL_BODY_FACTORY = "0xA1A1a1a1A1A1A1A1A1a1a1a1a1a1A1A1a1A1a1a1";
  const OLD_LEGAL_BODY_FACTORY = "0xa2A2a2A2A2A2A2a2a2a2a2A2A2A2A2a2A2A2a2a2";
  const withLegalBodyFactory = {
    ...base,
    CONTROLLER_ADDRESS: "0x9526E228E94A125843B2d010c1155780CBBAFb5c",
    LEGAL_BODY_FACTORY_ADDRESS: LEGAL_BODY_FACTORY,
  };

  test("parses and checksum-normalizes the list", () => {
    const cfg = loadConfig({
      ...base,
      MONITOR_WATCH_LEGAL_BODY_FACTORIES: ` ${OLD_LEGAL_BODY_FACTORY.toLowerCase()} `,
    });
    expect(cfg.monitor?.watchLegalBodyFactories).toEqual([OLD_LEGAL_BODY_FACTORY]);
  });

  test("the watched list is the configured factory plus the old one, deduplicated in any casing", () => {
    const cfg = loadConfig({
      ...withLegalBodyFactory,
      MONITOR_WATCH_LEGAL_BODY_FACTORIES: `${LEGAL_BODY_FACTORY.toLowerCase()},${OLD_LEGAL_BODY_FACTORY}`,
    });
    expect(
      watchedLegalBodyFactories(cfg.legalBodyFactory, cfg.monitor?.watchLegalBodyFactories ?? []),
    ).toEqual([LEGAL_BODY_FACTORY, OLD_LEGAL_BODY_FACTORY]);
  });

  test("with no legal-body factory configured, the watch list alone is watched", () => {
    const cfg = loadConfig({ ...base, MONITOR_WATCH_LEGAL_BODY_FACTORIES: OLD_LEGAL_BODY_FACTORY });
    expect(
      watchedLegalBodyFactories(cfg.legalBodyFactory, cfg.monitor?.watchLegalBodyFactories ?? []),
    ).toEqual([OLD_LEGAL_BODY_FACTORY]);
  });

  test("a malformed entry refuses the boot, naming the variable", () => {
    expect(() =>
      loadConfig({
        ...base,
        MONITOR_WATCH_LEGAL_BODY_FACTORIES: `${OLD_LEGAL_BODY_FACTORY},0xnope`,
      }),
    ).toThrow(/MONITOR_WATCH_LEGAL_BODY_FACTORIES contains "0xnope"/);
  });
});
