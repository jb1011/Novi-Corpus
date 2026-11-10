/**
 * The boot check that nobody holds the controller's WILDCARD_ROLE.
 *
 * The controller cannot list a role's members, so the check rebuilds the holder set from the
 * role's RoleGranted and RoleRevoked logs, starting at the block of the transaction that created
 * the controller, and keeps the set and a cursor in SQLite so a later boot resumes. Every test here
 * pins one way that must refuse (or must not), and that a failure never moves the cursor past the
 * last window read in full.
 */
import type Database from "better-sqlite3";
import { type Address, type Hex, type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assertNoWildcardHolder } from "../../../src/adapters/arc/wildcardLedger";
import { migrate, openDatabase } from "../../../src/persistence/db";

const CONTROLLER = "0x4819bd1e7f5F1e2b0e07A2E4f3d0B3E1C2A4f6e0" as Address;
const EXECUTOR = "0x000000000000000000000000000000000000000b" as Address;
const ADMIN = "0x000000000000000000000000000000000000000a" as Address;
const STRANGER = "0x00000000000000000000000000000000000000Ff" as Address;
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000c0" as Address;
/** The controller's wildcard role id: right-aligned, as the contract defines it. */
const WILDCARD = `0x${"0".repeat(63)}1` as Hex;
const DEPLOY_TX = `0x${"ab".repeat(32)}` as Hex;
const GRANT_TX = `0x${"cd".repeat(32)}` as Hex;
const REVOKE_TX = `0x${"ef".repeat(32)}` as Hex;
const CHAIN_ID = 5042002;

interface RoleLog {
  eventName: "RoleGranted" | "RoleRevoked";
  role: Hex;
  account: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface World {
  executorHolds?: boolean;
  adminHolds?: boolean;
  receipt?: {
    status: "success" | "reverted";
    contractAddress: Address | null;
    blockNumber: bigint;
  };
  receiptMissing?: boolean;
  latest: bigint;
  logs?: RoleLog[];
  /** Windows wider than this many blocks are refused with Arc's range error. */
  maxRange?: bigint;
  /** A getLogs whose fromBlock is this block fails with a transport error. */
  failAtFrom?: bigint;
}

/** A PublicClient-shaped object answering from a scripted chain, recording every log query. */
function client(world: World) {
  const queries: { event: string; fromBlock: bigint; toBlock: bigint; role: Hex }[] = [];
  const readContract = vi.fn(
    async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === "WILDCARD_ROLE") return WILDCARD;
      if (functionName === "defaultAdmin") return ADMIN;
      if (functionName === "hasRole") {
        const [role, account] = args as [Hex, Address];
        if (role !== WILDCARD) throw new Error(`unexpected role ${role}`);
        if (account === EXECUTOR) return world.executorHolds ?? false;
        if (account === ADMIN) return world.adminHolds ?? false;
        return false;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  );
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (world.receiptMissing) throw new TransactionReceiptNotFoundError({ hash });
    return world.receipt ?? { status: "success", contractAddress: CONTROLLER, blockNumber: 10n };
  });
  const getBlockNumber = vi.fn(async () => world.latest);
  const getLogs = vi.fn(
    async (q: {
      address: Address;
      event: { name: string };
      args: { role: Hex };
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      queries.push({
        event: q.event.name,
        fromBlock: q.fromBlock,
        toBlock: q.toBlock,
        role: q.args.role,
      });
      if (q.address !== CONTROLLER) throw new Error(`unexpected address ${q.address}`);
      if (world.failAtFrom !== undefined && q.fromBlock === world.failAtFrom)
        throw new Error("socket hang up");
      if (world.maxRange !== undefined && q.toBlock - q.fromBlock + 1n > world.maxRange)
        throw new Error("requested range too large");
      return (world.logs ?? [])
        .filter(
          (l) =>
            l.eventName === q.event.name &&
            l.role === q.args.role &&
            l.blockNumber >= q.fromBlock &&
            l.blockNumber <= q.toBlock,
        )
        .map((l) => ({
          eventName: l.eventName,
          args: { role: l.role, account: l.account, sender: ADMIN },
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
          transactionHash: l.transactionHash,
        }));
    },
  );
  const pc = {
    readContract,
    getTransactionReceipt,
    getBlockNumber,
    getLogs,
  } as unknown as PublicClient;
  return { pc, queries, getLogs, getTransactionReceipt };
}

const params = {
  controller: CONTROLLER,
  chainId: CHAIN_ID,
  deployTx: DEPLOY_TX,
  executor: EXECUTOR,
};

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

function stored(): { cursor_block: number; holders: { account: string; grantedTx: string }[] } {
  const row = db
    .prepare(
      "SELECT cursor_block, holders_json FROM controller_role_ledger WHERE controller = ? AND chain_id = ?",
    )
    .get(CONTROLLER.toLowerCase(), CHAIN_ID) as { cursor_block: number; holders_json: string };
  return { cursor_block: row.cursor_block, holders: JSON.parse(row.holders_json) };
}

const grant = (account: Address, blockNumber: bigint, logIndex = 0): RoleLog => ({
  eventName: "RoleGranted",
  role: WILDCARD,
  account,
  blockNumber,
  logIndex,
  transactionHash: GRANT_TX,
});
const revoke = (account: Address, blockNumber: bigint, logIndex = 0): RoleLog => ({
  eventName: "RoleRevoked",
  role: WILDCARD,
  account,
  blockNumber,
  logIndex,
  transactionHash: REVOKE_TX,
});

test("a grant then a revoke passes and leaves an empty holder set", async () => {
  const { pc, queries } = client({
    latest: 500n,
    logs: [grant(STRANGER, 50n), revoke(STRANGER, 60n)],
  });
  const result = await assertNoWildcardHolder(pc, db, params);
  expect(result).toEqual({ fromBlock: 10n, toBlock: 500n, windows: 1 });
  expect(stored()).toEqual({ cursor_block: 500, holders: [] });
  // The node filters on the role topic: every query carried the wildcard role id.
  expect(queries.every((q) => q.role === WILDCARD)).toBe(true);
  expect(queries.map((q) => q.event).sort()).toEqual(["RoleGranted", "RoleRevoked"]);
});

test("a grant and its revoke in the same block apply in log-index order", async () => {
  const { pc } = client({
    latest: 500n,
    logs: [revoke(STRANGER, 50n, 3), grant(STRANGER, 50n, 1)],
  });
  await expect(assertNoWildcardHolder(pc, db, params)).resolves.toBeDefined();
  expect(stored().holders).toEqual([]);
});

test("a grant with no revoke refuses the boot, naming the holder and the granting transaction", async () => {
  const { pc } = client({ latest: 500n, logs: [grant(STRANGER, 50n)] });
  const err = await assertNoWildcardHolder(pc, db, params).catch((e) => e);
  expect(err.message).toMatch(/1 account\(s\) hold WILDCARD_ROLE on CONTROLLER_ADDRESS/);
  expect(err.message).toContain(STRANGER.toLowerCase());
  expect(err.message).toContain(`granted in transaction ${GRANT_TX} at block 50`);
  // The holder is stored, so the next boot still refuses without re-reading the grant.
  expect(stored()).toEqual({
    cursor_block: 500,
    holders: [{ account: STRANGER.toLowerCase(), grantedTx: GRANT_TX, grantedBlock: 50 }],
  });
});

test("the cursor advances, and the next boot reads from the block after it", async () => {
  await assertNoWildcardHolder(client({ latest: 100n }).pc, db, params);
  expect(stored().cursor_block).toBe(100);

  const second = client({ latest: 150n });
  const result = await assertNoWildcardHolder(second.pc, db, params);
  expect(result.fromBlock).toBe(101n);
  expect(second.queries.map((q) => q.fromBlock)).toEqual([101n, 101n]);
  expect(stored().cursor_block).toBe(150);
});

test("a holder found on one boot is still refused on the next, from the stored set alone", async () => {
  await assertNoWildcardHolder(
    client({ latest: 100n, logs: [grant(STRANGER, 50n)] }).pc,
    db,
    params,
  ).catch(() => undefined);
  const err = await assertNoWildcardHolder(client({ latest: 150n }).pc, db, params).catch((e) => e);
  expect(err.message).toContain(STRANGER.toLowerCase());
});

test("a range-too-large refusal halves the window and retries it; the final cursor is the latest block", async () => {
  const { pc, queries } = client({
    receipt: { status: "success", contractAddress: CONTROLLER, blockNumber: 0n },
    latest: 100_000n,
    maxRange: 22_500n,
    logs: [grant(STRANGER, 70_000n), revoke(STRANGER, 80_000n)],
  });
  await assertNoWildcardHolder(pc, db, params);
  const granted = queries.filter((q) => q.event === "RoleGranted");
  // 90,000 refused, 45,000 refused, then 22,500-block windows from the same first block.
  expect(granted.slice(0, 3).map((q) => q.toBlock - q.fromBlock + 1n)).toEqual([
    90_000n,
    45_000n,
    22_500n,
  ]);
  expect(granted.slice(0, 3).map((q) => q.fromBlock)).toEqual([0n, 0n, 0n]);
  expect(granted.at(-1)?.toBlock).toBe(100_000n);
  expect(stored()).toEqual({ cursor_block: 100_000, holders: [] });
});

test("a receipt that created another contract refuses, naming CONTROLLER_DEPLOY_TX", async () => {
  const { pc, getLogs } = client({
    latest: 500n,
    receipt: { status: "success", contractAddress: OTHER_CONTRACT, blockNumber: 10n },
  });
  const err = await assertNoWildcardHolder(pc, db, params).catch((e) => e);
  expect(err.message).toMatch(
    new RegExp(
      `CONTROLLER_DEPLOY_TX ${DEPLOY_TX} created ${OTHER_CONTRACT}, not CONTROLLER_ADDRESS`,
    ),
  );
  expect(getLogs).not.toHaveBeenCalled();
});

test("a failed or missing deploy transaction refuses, naming CONTROLLER_DEPLOY_TX", async () => {
  const reverted = client({
    latest: 500n,
    receipt: { status: "reverted", contractAddress: null, blockNumber: 10n },
  });
  await expect(assertNoWildcardHolder(reverted.pc, db, params)).rejects.toThrow(
    /CONTROLLER_DEPLOY_TX .* has status reverted/,
  );
  const missing = client({ latest: 500n, receiptMissing: true });
  await expect(assertNoWildcardHolder(missing.pc, db, params)).rejects.toThrow(
    /CONTROLLER_DEPLOY_TX .* has no receipt on this chain/,
  );
});

test("the executor holding the wildcard role refuses before any receipt or log is read", async () => {
  const { pc, getLogs, getTransactionReceipt } = client({ latest: 500n, executorHolds: true });
  const err = await assertNoWildcardHolder(pc, db, params).catch((e) => e);
  expect(err.message).toMatch(/executor .* holds WILDCARD_ROLE on CONTROLLER_ADDRESS/);
  expect(err.message).toContain(EXECUTOR);
  expect(getLogs).not.toHaveBeenCalled();
  expect(getTransactionReceipt).not.toHaveBeenCalled();
});

test("the default admin holding the wildcard role refuses too", async () => {
  const { pc, getLogs } = client({ latest: 500n, adminHolds: true });
  await expect(assertNoWildcardHolder(pc, db, params)).rejects.toThrow(
    new RegExp(`default admin ${ADMIN} holds WILDCARD_ROLE`),
  );
  expect(getLogs).not.toHaveBeenCalled();
});

test("an RPC failure is 'could not verify', and the cursor stays at the last complete window", async () => {
  const { pc } = client({
    receipt: { status: "success", contractAddress: CONTROLLER, blockNumber: 0n },
    latest: 200_000n,
    failAtFrom: 90_000n, // the second 90,000-block window
  });
  const err = await assertNoWildcardHolder(pc, db, params).catch((e) => e);
  expect(err.message).toMatch(/could not verify .*WILDCARD_ROLE history.*blocks 90000 to 179999/s);
  expect(err.message).not.toMatch(/hold WILDCARD_ROLE/);
  expect(stored().cursor_block).toBe(89_999);
});

test("a missing CONTROLLER_DEPLOY_TX refuses by name", async () => {
  await expect(
    assertNoWildcardHolder(client({ latest: 1n }).pc, db, { ...params, deployTx: undefined }),
  ).rejects.toThrow(/CONTROLLER_DEPLOY_TX is unset/);
});
