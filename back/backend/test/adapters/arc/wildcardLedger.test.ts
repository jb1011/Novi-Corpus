/**
 * The boot check that nobody holds the controller's WILDCARD_ROLE.
 *
 * The controller cannot list a role's members, so the check rebuilds the holder set from the
 * role's RoleGranted and RoleRevoked logs, starting at the block that holds the transaction that
 * created the controller, and keeps the set and a cursor in SQLite so a later boot resumes. The
 * deploy transaction is proven through its block and that block's receipts, never by its hash,
 * because public nodes stop serving receipt-by-hash for old transactions. Every test here pins one
 * way that must refuse (or must not), and that a failure never moves the cursor past the last
 * window read in full.
 */
import type Database from "better-sqlite3";
import {
  type Address,
  BlockNotFoundError,
  type Hex,
  HttpRequestError,
  type PublicClient,
  getContractAddress,
} from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  assertNoWildcardHolder,
  isRateLimitError,
  prefillWildcardLedger,
} from "../../../src/adapters/arc/wildcardLedger";
import type { Config } from "../../../src/config/env";
import { ensureControllerRoleLedger, migrate, openDatabase } from "../../../src/persistence/db";

/** The account that broadcast the controller's deployment, and its nonce at the time. */
const DEPLOYER = "0x00000000000000000000000000000000000000d0" as Address;
const DEPLOY_NONCE = 7;
/** Derived the way the chain derives it, so the creation check has something true to match. */
const CONTROLLER = getContractAddress({ from: DEPLOYER, nonce: BigInt(DEPLOY_NONCE) });
const EXECUTOR = "0x000000000000000000000000000000000000000b" as Address;
const ADMIN = "0x000000000000000000000000000000000000000a" as Address;
const STRANGER = "0x00000000000000000000000000000000000000Ff" as Address;
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000c0" as Address;
/** The controller's wildcard role id: right-aligned, as the contract defines it. */
const WILDCARD = `0x${"0".repeat(63)}1` as Hex;
const DEPLOY_TX = `0x${"ab".repeat(32)}` as Hex;
const OTHER_TX = `0x${"12".repeat(32)}` as Hex;
const GRANT_TX = `0x${"cd".repeat(32)}` as Hex;
const REVOKE_TX = `0x${"ef".repeat(32)}` as Hex;
const CHAIN_ID = 5042002;
const DEPLOY_BLOCK = 10n;

interface RoleLog {
  eventName: "RoleGranted" | "RoleRevoked";
  role: Hex;
  account: Address;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

interface BlockTx {
  hash: Hex;
  to: Address | null;
  from: Address;
  nonce: number;
}

/** A receipt as eth_getBlockReceipts returns it: raw hex fields. */
interface RawReceipt {
  transactionHash: Hex;
  status: Hex;
  contractAddress: Address | null;
}

interface World {
  executorHolds?: boolean;
  adminHolds?: boolean;
  /** The transactions of the deploy block; defaults to the controller's creation alone. */
  blockTxs?: BlockTx[];
  /** The deploy block's receipts; null is a node that has none, undefined the default success. */
  receipts?: RawReceipt[] | null;
  /** The node does not implement eth_getBlockReceipts. */
  receiptsUnsupported?: boolean;
  latest: bigint;
  logs?: RoleLog[];
  /** Windows wider than this many blocks are refused with Arc's range error. */
  maxRange?: bigint;
  /** A getLogs whose fromBlock is this block fails with a transport error. */
  failAtFrom?: bigint;
  /** The window starting at `from` is answered with HTTP 429 for its first `times` attempts. */
  rateLimit?: { from: bigint; times: number };
}

const creation: BlockTx = { hash: DEPLOY_TX, to: null, from: DEPLOYER, nonce: DEPLOY_NONCE };

/** A PublicClient-shaped object answering from a scripted chain, recording every log query. */
function client(world: World) {
  const queries: { event: string; fromBlock: bigint; toBlock: bigint; role: Hex }[] = [];
  let rateLimitedAttempts = 0;
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
  const getBlock = vi.fn(
    async ({
      blockNumber,
      includeTransactions,
    }: { blockNumber: bigint; includeTransactions: boolean }) => {
      if (!includeTransactions) throw new Error("the check needs the block's transactions");
      if (blockNumber > world.latest) throw new BlockNotFoundError({ blockNumber });
      return { number: blockNumber, transactions: world.blockTxs ?? [creation] };
    },
  );
  const request = vi.fn(async ({ method, params }: { method: string; params: unknown[] }) => {
    if (method !== "eth_getBlockReceipts") throw new Error(`unexpected request ${method}`);
    if (world.receiptsUnsupported)
      throw new Error("the method eth_getBlockReceipts does not exist/is not available");
    if (params[0] !== `0x${DEPLOY_BLOCK.toString(16)}` && params[0] !== "0x0")
      throw new Error(`unexpected block ${String(params[0])}`);
    if (world.receipts !== undefined) return world.receipts;
    return [
      { transactionHash: DEPLOY_TX, status: "0x1", contractAddress: CONTROLLER.toLowerCase() },
    ];
  });
  // The lookups by transaction hash that public nodes stop answering for old transactions. The
  // check must never call them; each records the call and fails as such a node would.
  const getTransactionReceipt = vi.fn(async () => {
    throw new Error("receipt-by-hash must not be used");
  });
  const getTransaction = vi.fn(async () => {
    throw new Error("transaction-by-hash must not be used");
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
      if (world.rateLimit && q.fromBlock === world.rateLimit.from) {
        // One attempt is the pair of queries for one window; count it on the first of the two.
        if (q.event.name === "RoleGranted") rateLimitedAttempts++;
        if (rateLimitedAttempts <= world.rateLimit.times)
          throw new HttpRequestError({
            url: "https://rpc.example/arc",
            status: 429,
            details: "Too Many Requests",
          });
      }
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
    getBlock,
    request,
    getTransactionReceipt,
    getTransaction,
    getBlockNumber,
    getLogs,
  } as unknown as PublicClient;
  return {
    pc,
    queries,
    getLogs,
    getBlock,
    request,
    getTransactionReceipt,
    getTransaction,
    rateLimitedAttempts: () => rateLimitedAttempts,
  };
}

const params = {
  controller: CONTROLLER,
  chainId: CHAIN_ID,
  deployTx: DEPLOY_TX,
  deployBlock: DEPLOY_BLOCK,
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

function storedDeploy(): { deploy_tx: string | null; deploy_block: number | null } | undefined {
  return db
    .prepare(
      "SELECT deploy_tx, deploy_block FROM controller_role_ledger WHERE controller = ? AND chain_id = ?",
    )
    .get(CONTROLLER.toLowerCase(), CHAIN_ID) as
    | { deploy_tx: string | null; deploy_block: number | null }
    | undefined;
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
    latest: 100_000n,
    maxRange: 2_500n,
    logs: [grant(STRANGER, 70_000n), revoke(STRANGER, 80_000n)],
  });
  await assertNoWildcardHolder(pc, db, { ...params, deployBlock: 0n });
  const granted = queries.filter((q) => q.event === "RoleGranted");
  // The public RPC's 10,000-block cap first; 10,000 refused, 5,000 refused, then 2,500-block
  // windows from the same first block.
  expect(granted.slice(0, 3).map((q) => q.toBlock - q.fromBlock + 1n)).toEqual([
    10_000n,
    5_000n,
    2_500n,
  ]);
  expect(granted.slice(0, 3).map((q) => q.fromBlock)).toEqual([0n, 0n, 0n]);
  expect(granted.at(-1)?.toBlock).toBe(100_000n);
  expect(stored()).toEqual({ cursor_block: 100_000, holders: [] });
});

test("the deploy block proves the creation, and the boot passes without any lookup by hash", async () => {
  const { pc, getBlock, request, getTransactionReceipt, getTransaction } = client({ latest: 500n });
  await expect(assertNoWildcardHolder(pc, db, params)).resolves.toEqual({
    fromBlock: DEPLOY_BLOCK,
    toBlock: 500n,
    windows: 1,
  });
  expect(getBlock).toHaveBeenCalledWith({ blockNumber: DEPLOY_BLOCK, includeTransactions: true });
  expect(request).toHaveBeenCalledWith({ method: "eth_getBlockReceipts", params: ["0xa"] });
  expect(getTransactionReceipt).not.toHaveBeenCalled();
  expect(getTransaction).not.toHaveBeenCalled();
  // The verified pair is stored with the ledger, so the next boot can skip the block reads.
  expect(storedDeploy()).toEqual({ deploy_tx: DEPLOY_TX, deploy_block: 10 });
});

test("a deploy transaction that is not in CONTROLLER_DEPLOY_BLOCK refuses, naming the block", async () => {
  const { pc, getLogs } = client({
    latest: 500n,
    blockTxs: [{ ...creation, hash: OTHER_TX }],
  });
  await expect(assertNoWildcardHolder(pc, db, params)).rejects.toThrow(
    new RegExp(`CONTROLLER_DEPLOY_TX ${DEPLOY_TX} is not in block 10`),
  );
  expect(getLogs).not.toHaveBeenCalled();
  expect(storedDeploy()).toBeUndefined();
});

test("a deploy transaction that is a call, or that derives another address, refuses", async () => {
  const call = client({ latest: 500n, blockTxs: [{ ...creation, to: OTHER_CONTRACT }] });
  await expect(assertNoWildcardHolder(call.pc, db, params)).rejects.toThrow(
    new RegExp(
      `CONTROLLER_DEPLOY_TX ${DEPLOY_TX} is a call to ${OTHER_CONTRACT}, not a contract creation`,
    ),
  );
  const elsewhere = client({ latest: 500n, blockTxs: [{ ...creation, nonce: DEPLOY_NONCE + 1 }] });
  const derived = getContractAddress({ from: DEPLOYER, nonce: BigInt(DEPLOY_NONCE + 1) });
  await expect(assertNoWildcardHolder(elsewhere.pc, db, params)).rejects.toThrow(
    new RegExp(`CONTROLLER_DEPLOY_TX ${DEPLOY_TX} created ${derived} .*not CONTROLLER_ADDRESS`),
  );
  expect(call.request).not.toHaveBeenCalled();
  expect(elsewhere.getLogs).not.toHaveBeenCalled();
});

test("a deploy transaction whose receipt in the block failed, or names another contract, refuses", async () => {
  const reverted = client({
    latest: 500n,
    receipts: [{ transactionHash: DEPLOY_TX, status: "0x0", contractAddress: null }],
  });
  await expect(assertNoWildcardHolder(reverted.pc, db, params)).rejects.toThrow(
    /CONTROLLER_DEPLOY_TX .* has status 0x0 in block 10/,
  );
  const other = client({
    latest: 500n,
    receipts: [{ transactionHash: DEPLOY_TX, status: "0x1", contractAddress: OTHER_CONTRACT }],
  });
  await expect(assertNoWildcardHolder(other.pc, db, params)).rejects.toThrow(
    new RegExp(`created ${OTHER_CONTRACT} according to its receipt, not CONTROLLER_ADDRESS`),
  );
  expect(reverted.getLogs).not.toHaveBeenCalled();
  expect(storedDeploy()).toBeUndefined();
});

test("a node without eth_getBlockReceipts, or with no receipts, is 'could not verify' and stores nothing", async () => {
  for (const world of [
    { latest: 500n, receiptsUnsupported: true },
    { latest: 500n, receipts: null },
    { latest: 500n, receipts: [] },
  ]) {
    const { pc, getLogs } = client(world);
    const err = await assertNoWildcardHolder(pc, db, params).catch((e) => e);
    expect(err.message).toMatch(
      /could not verify .*(receipts of CONTROLLER_DEPLOY_BLOCK 10|receipt of CONTROLLER_DEPLOY_TX)/,
    );
    expect(getLogs).not.toHaveBeenCalled();
    expect(storedDeploy()).toBeUndefined();
  }
});

test("a deploy block the node cannot serve is 'could not verify'", async () => {
  const { pc } = client({ latest: 5n });
  await expect(assertNoWildcardHolder(pc, db, params)).rejects.toThrow(
    /could not verify CONTROLLER_DEPLOY_BLOCK 10/,
  );
});

test("a stored row with the same deploy transaction and block skips the block reads", async () => {
  await assertNoWildcardHolder(client({ latest: 100n }).pc, db, params);
  const second = client({ latest: 150n });
  const result = await assertNoWildcardHolder(second.pc, db, params);
  expect(result.fromBlock).toBe(101n);
  expect(second.getBlock).not.toHaveBeenCalled();
  expect(second.request).not.toHaveBeenCalled();
});

test("a stored row with a different deploy transaction or block refuses and is left as it was", async () => {
  await assertNoWildcardHolder(client({ latest: 100n }).pc, db, params);
  for (const changed of [
    { ...params, deployTx: OTHER_TX },
    { ...params, deployBlock: 11n },
  ]) {
    const { pc, getBlock, getLogs } = client({ latest: 150n });
    await expect(assertNoWildcardHolder(pc, db, changed)).rejects.toThrow(
      /stored deploy transaction for CONTROLLER_ADDRESS .* differs from CONTROLLER_DEPLOY_TX .*reconcile/,
    );
    expect(getBlock).not.toHaveBeenCalled();
    expect(getLogs).not.toHaveBeenCalled();
  }
  expect(storedDeploy()).toEqual({ deploy_tx: DEPLOY_TX, deploy_block: 10 });
  expect(stored().cursor_block).toBe(100);
});

test("a ledger row from before the deploy transaction was stored is verified once and filled in", async () => {
  db.prepare(
    "INSERT INTO controller_role_ledger (controller, chain_id, cursor_block, holders_json) VALUES (?, ?, ?, '[]')",
  ).run(CONTROLLER.toLowerCase(), CHAIN_ID, 500);
  const { pc, getBlock, getLogs } = client({ latest: 500n });
  await expect(assertNoWildcardHolder(pc, db, params)).resolves.toEqual({
    fromBlock: undefined,
    toBlock: 500n,
    windows: 0,
  });
  expect(getBlock).toHaveBeenCalledTimes(1);
  expect(getLogs).not.toHaveBeenCalled();
  expect(storedDeploy()).toEqual({ deploy_tx: DEPLOY_TX, deploy_block: 10 });
  expect(stored().cursor_block).toBe(500);
});

test("migrate adds the deploy columns to a ledger table created without them", () => {
  const old = openDatabase(":memory:");
  old.exec(`CREATE TABLE controller_role_ledger (
    controller TEXT NOT NULL, chain_id INTEGER NOT NULL, cursor_block INTEGER NOT NULL,
    holders_json TEXT NOT NULL, PRIMARY KEY (controller, chain_id))`);
  migrate(old);
  const cols = (
    old.prepare("PRAGMA table_info(controller_role_ledger)").all() as { name: string }[]
  ).map((c) => c.name);
  old.close();
  expect(cols).toEqual(expect.arrayContaining(["deploy_tx", "deploy_block"]));
});

test("the executor holding the wildcard role refuses before any block, receipt or log is read", async () => {
  const { pc, getLogs, getBlock, request } = client({ latest: 500n, executorHolds: true });
  const err = await assertNoWildcardHolder(pc, db, params).catch((e) => e);
  expect(err.message).toMatch(/executor .* holds WILDCARD_ROLE on CONTROLLER_ADDRESS/);
  expect(err.message).toContain(EXECUTOR);
  expect(getLogs).not.toHaveBeenCalled();
  expect(getBlock).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
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
    latest: 200_000n,
    failAtFrom: 10_000n, // the second 10,000-block window
  });
  const err = await assertNoWildcardHolder(pc, db, { ...params, deployBlock: 0n }).catch((e) => e);
  expect(err.message).toMatch(/could not verify .*WILDCARD_ROLE history.*blocks 10000 to 19999/s);
  expect(err.message).not.toMatch(/hold WILDCARD_ROLE/);
  expect(stored().cursor_block).toBe(9_999);
});

test("a missing CONTROLLER_DEPLOY_TX refuses by name", async () => {
  await expect(
    assertNoWildcardHolder(client({ latest: 1n }).pc, db, { ...params, deployTx: undefined }),
  ).rejects.toThrow(/CONTROLLER_DEPLOY_TX is unset/);
});

test("a missing CONTROLLER_DEPLOY_BLOCK refuses by name", async () => {
  await expect(
    assertNoWildcardHolder(client({ latest: 1n }).pc, db, { ...params, deployBlock: undefined }),
  ).rejects.toThrow(/CONTROLLER_DEPLOY_BLOCK is unset/);
});

test("a rate-limited window is retried after a backoff, and the cursor never moves past it early", async () => {
  const c = client({ latest: 25_000n, rateLimit: { from: 10_000n, times: 1 } });
  const cursorsAtSleep: number[] = [];
  const sleep = vi.fn(async (_ms: number) => {
    cursorsAtSleep.push(stored().cursor_block);
  });
  const result = await assertNoWildcardHolder(c.pc, db, { ...params, deployBlock: 0n }, { sleep });
  expect(result).toEqual({ fromBlock: 0n, toBlock: 25_000n, windows: 3 });
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000]);
  // While waiting, the ledger held only the window read in full before the rate limit.
  expect(cursorsAtSleep).toEqual([9_999]);
  expect(c.rateLimitedAttempts()).toBe(2);
  expect(stored().cursor_block).toBe(25_000);
});

test("a rate limit that does not clear refuses as 'could not verify' after five retries", async () => {
  const c = client({ latest: 25_000n, rateLimit: { from: 10_000n, times: 99 } });
  const sleep = vi.fn(async (_ms: number) => {});
  const err = await assertNoWildcardHolder(
    c.pc,
    db,
    { ...params, deployBlock: 0n },
    { sleep },
  ).catch((e) => e);
  expect(err.message).toMatch(/could not verify .*WILDCARD_ROLE history.*blocks 10000 to 19999/s);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  // The first attempt plus one per backoff.
  expect(c.rateLimitedAttempts()).toBe(6);
  expect(stored().cursor_block).toBe(9_999);
});

test("ledger:prefill runs the boot check from the configuration and returns the API's log line", async () => {
  const cfg = {
    controllerAddress: CONTROLLER,
    chainId: CHAIN_ID,
    controllerDeployTx: DEPLOY_TX,
    controllerDeployBlock: Number(DEPLOY_BLOCK),
    platformPrivateKey: `0x${"ab".repeat(32)}`,
  } as Config;
  const line = await prefillWildcardLedger(cfg, client({ latest: 500n }).pc, db);
  expect(line).toBe(
    "[boot] WILDCARD_ROLE verified on-chain: held by neither the executor nor the default admin, and no holder in the role history through block 500 (read blocks 10 to 500 in 1 window(s))",
  );
  expect(stored().cursor_block).toBe(500);
});

test("ledger:prefill refuses on a deployment with no controller", async () => {
  await expect(
    prefillWildcardLedger({ chainId: CHAIN_ID } as Config, client({ latest: 1n }).pc, db),
  ).rejects.toThrow(/CONTROLLER_ADDRESS is unset/);
});

test("rate limiting is recognised by HTTP status anywhere in the cause chain, or by its wording", () => {
  const http429 = new HttpRequestError({ url: "https://rpc.example/arc", status: 429 });
  expect(isRateLimitError(http429)).toBe(true);
  expect(isRateLimitError(new Error("request failed", { cause: http429 }))).toBe(true);
  expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
  expect(isRateLimitError(new Error("rate limit exceeded, retry later"))).toBe(true);
  expect(isRateLimitError(new Error("socket hang up"))).toBe(false);
  expect(isRateLimitError(new Error("requested range too large"))).toBe(false);
  expect(
    isRateLimitError(new HttpRequestError({ url: "https://rpc.example/arc", status: 503 })),
  ).toBe(false);
});

test("ledger:prefill works on a database that has never been migrated, creating only the ledger table", async () => {
  const fresh = openDatabase(":memory:");
  try {
    ensureControllerRoleLedger(fresh);
    const cfg = {
      controllerAddress: CONTROLLER,
      chainId: CHAIN_ID,
      controllerDeployTx: DEPLOY_TX,
      controllerDeployBlock: Number(DEPLOY_BLOCK),
      platformPrivateKey: `0x${"ab".repeat(32)}`,
    } as Config;
    await expect(prefillWildcardLedger(cfg, client({ latest: 500n }).pc, fresh)).resolves.toMatch(
      /no holder in the role history through block 500/,
    );
    const tables = (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(["controller_role_ledger"]);
    expect(
      fresh
        .prepare("SELECT cursor_block, deploy_tx, deploy_block FROM controller_role_ledger")
        .get(),
    ).toEqual({ cursor_block: 500, deploy_tx: DEPLOY_TX, deploy_block: 10 });
  } finally {
    fresh.close();
  }
});

test("ensureControllerRoleLedger adds the deploy columns to an old-shape table and keeps its rows", () => {
  const old = openDatabase(":memory:");
  try {
    old.exec(`CREATE TABLE controller_role_ledger (
      controller TEXT NOT NULL, chain_id INTEGER NOT NULL, cursor_block INTEGER NOT NULL,
      holders_json TEXT NOT NULL, PRIMARY KEY (controller, chain_id))`);
    old.prepare("INSERT INTO controller_role_ledger VALUES ('0xc0', 1, 42, '[]')").run();
    ensureControllerRoleLedger(old);
    ensureControllerRoleLedger(old); // idempotent
    const cols = (
      old.prepare("PRAGMA table_info(controller_role_ledger)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual([
      "controller",
      "chain_id",
      "cursor_block",
      "holders_json",
      "deploy_tx",
      "deploy_block",
    ]);
    expect(old.prepare("SELECT * FROM controller_role_ledger").get()).toEqual({
      controller: "0xc0",
      chain_id: 1,
      cursor_block: 42,
      holders_json: "[]",
      deploy_tx: null,
      deploy_block: null,
    });
  } finally {
    old.close();
  }
});
