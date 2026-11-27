/**
 * Whether this process offers the company's pot: one live flag, turned on only when the start-up
 * check of the seven contracts resolves (Rulings R1 and R11). Any error turns the pot off and only
 * the pot: the error's class and reason choose the log line and whether the check is tried again.
 * An unreadable node is tried again once a minute until the check resolves; a mismatch stays off
 * until a restart. The server itself boots in every case, so the check is never awaited by it.
 *
 * Fake timers and a check whose answers the test sets; no chain.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PotContractsNotVerifiedError } from "../../src/adapters/arc/safePotChain";
import { POT_CONTRACTS_RETRY_MS, startPotContractsGate } from "../../src/legalBody/potOffer";

const MINUTE = 60_000;

const unreadable = () =>
  new PotContractsNotVerifiedError({
    reason: "unreadable",
    contract: "allowanceModule",
    address: "0xAA46724893dedD72658219405185Fb0Fc91e091C",
    cause: new Error("the node did not answer"),
  });
const mismatch = () =>
  new PotContractsNotVerifiedError({
    reason: "mismatch",
    contract: "safeSingleton",
    address: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    expected: `0x${"b1".repeat(32)}`,
    actual: `0x${"00".repeat(32)}`,
  });

let lines: { level: "info" | "error"; line: string }[];
const log = (level: "info" | "error", line: string) => {
  lines.push({ level, line });
};

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the pot's flag", () => {
  test("the retry is once a minute", () => {
    expect(POT_CONTRACTS_RETRY_MS).toBe(MINUTE);
  });

  test("off until the check resolves, then on, with the verified line", async () => {
    let resolve: () => void = () => {};
    const check = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const gate = startPotContractsGate({ check, chainId: 5_042_002, log });
    // Off while the check is on its way: the flag is set only when it resolves.
    expect(gate.offered()).toBe(false);
    resolve();
    await gate.firstCheck;
    expect(gate.offered()).toBe(true);
    expect(lines).toEqual([
      {
        level: "info",
        line: "[boot] pot contracts verified on-chain: 7 code hashes on chain 5042002",
      },
    ]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("a mismatch: off, one loud line with the error's message, and no retry", async () => {
    const check = vi.fn(async () => {
      throw mismatch();
    });
    const gate = startPotContractsGate({ check, chainId: 5_042_002, log });
    await gate.firstCheck;
    expect(gate.offered()).toBe(false);
    expect(lines).toEqual([
      { level: "error", line: `[boot] pot contracts NOT verified: ${mismatch().message}` },
    ]);
    expect(lines[0]?.line).toMatch(/^\[boot\] pot contracts NOT verified: mismatch: /);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(check).toHaveBeenCalledTimes(1);
    expect(gate.offered()).toBe(false);
  });

  test("unreadable: off, then tried again once a minute, and on after a later resolve", async () => {
    let answers = 0;
    const check = vi.fn(async () => {
      answers += 1;
      if (answers <= 2) throw unreadable();
    });
    const gate = startPotContractsGate({ check, chainId: 5_042, log });
    await gate.firstCheck;
    expect(gate.offered()).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    // Not before the minute.
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(gate.offered()).toBe(false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(check).toHaveBeenCalledTimes(3);
    expect(gate.offered()).toBe(true);
    expect(lines.map((l) => l.level)).toEqual(["error", "error", "info"]);
    expect(lines[0]?.line).toMatch(/^\[boot\] pot contracts NOT verified: unreadable: /);
    expect(lines[2]?.line).toBe(
      "[boot] pot contracts verified on-chain: 7 code hashes on chain 5042",
    );
    // Once on, never tried again.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(check).toHaveBeenCalledTimes(3);
  });

  test("unreadable, then a mismatch on a retry: off for good", async () => {
    const check = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(unreadable())
      .mockRejectedValueOnce(mismatch())
      .mockResolvedValue(undefined);
    const gate = startPotContractsGate({ check, chainId: 5_042, log });
    await gate.firstCheck;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(check).toHaveBeenCalledTimes(2);
    expect(gate.offered()).toBe(false);
  });

  test("any other error turns the pot off too, with no retry: a check that throws at once, or a rejection that is not the named error", async () => {
    for (const check of [
      vi.fn((): Promise<void> => {
        throw new TypeError("a bug in the check");
      }),
      vi.fn(async (): Promise<void> => {
        throw new RangeError("another bug");
      }),
      vi.fn(async (): Promise<void> => {
        throw "not an error";
      }),
    ]) {
      lines = [];
      const gate = startPotContractsGate({ check, chainId: 5_042, log });
      await gate.firstCheck;
      expect(gate.offered()).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("error");
      expect(lines[0]?.line).toMatch(/^\[boot\] pot contracts NOT verified: /);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(check).toHaveBeenCalledTimes(1);
    }
  });

  test("stop ends the retry: no check after it, and the pot stays off", async () => {
    const check = vi.fn(async () => {
      throw unreadable();
    });
    const gate = startPotContractsGate({ check, chainId: 5_042, log });
    await gate.firstCheck;
    gate.stop();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(check).toHaveBeenCalledTimes(1);
    expect(gate.offered()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("firstCheck never rejects, whatever the check does", async () => {
    const gate = startPotContractsGate({
      check: async () => {
        throw mismatch();
      },
      chainId: 5_042,
      log,
    });
    await expect(gate.firstCheck).resolves.toBeUndefined();
  });

  test("the default log writes the verified line to the console and the NOT verified line as an error", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await startPotContractsGate({ check: async () => {}, chainId: 5_042 }).firstCheck;
    await startPotContractsGate({
      check: async () => {
        throw mismatch();
      },
      chainId: 5_042,
    }).firstCheck;
    expect(info.mock.calls).toEqual([
      ["[boot] pot contracts verified on-chain: 7 code hashes on chain 5042"],
    ]);
    expect(error.mock.calls).toEqual([
      [`[boot] pot contracts NOT verified: ${mismatch().message}`],
    ]);
    info.mockRestore();
    error.mockRestore();
  });
});
