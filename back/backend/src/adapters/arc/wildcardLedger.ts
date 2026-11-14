import type Database from "better-sqlite3";
import {
  type Address,
  type Hex,
  type PublicClient,
  getAbiItem,
  getContractAddress,
  isAddressEqual,
  toHex,
} from "viem";
import { noviControllerAbi } from "../../abis/generated";
import type { Config } from "../../config/env";
import { chunkRange, isRangeTooLargeError, shrinkRange } from "../../monitor/scan";
import { unreadable } from "./bootVerify";
import { managerAccount } from "./clients";

/**
 * Boot check: nobody holds the controller's WILDCARD_ROLE.
 *
 * The wildcard role lets its holder relay ANY selector to ANY target through the controller, so a
 * single stray holder undoes every selector grant and pin the controller was built with. The
 * controller does not enumerate role members, so the only complete answer comes from its history:
 * every RoleGranted and RoleRevoked for the wildcard role since the controller was created.
 *
 * Fail closed at every step:
 *  1. Two direct reads first: the executor and the default admin must not hold the role. They
 *     stand on their own, so a bug in the replay below can never hide the two addresses that
 *     matter most.
 *  2. The deploy transaction (CONTROLLER_DEPLOY_TX) must sit in CONTROLLER_DEPLOY_BLOCK, be a
 *     contract creation whose sender and nonce derive exactly the configured controller, and have
 *     a successful receipt in that block's receipts that names the controller. The check goes
 *     through the block, never through the transaction's hash: public Arc nodes return null from
 *     receipt-by-hash for old transactions while still serving the block and its receipts, and a
 *     null there would read as "this transaction does not exist". Once verified, the transaction
 *     and block are stored with the ledger; a later boot with the same pair skips this step, and a
 *     different pair refuses until an operator reconciles the stored row by hand.
 *  3. The replay reads the wildcard role's grants and revokes, filtered on the role topic by the
 *     node, from the deploy block (or the stored cursor) to the latest block, and keeps the holder
 *     set, the cursor and the verified deploy transaction in `controller_role_ledger` after every
 *     fully read window.
 *  4. A non-empty holder set refuses the boot, naming every holder and the transaction that
 *     granted it. Any read failure is "could not verify", never a pass.
 *
 * Cost: the first boot against an old testnet controller replays months of blocks at the public
 * RPC's window size (PUBLIC_RPC_LOG_RANGE, with sub-second blocks) and may take many minutes. A
 * rate-limited window is retried with backoff rather than failing the boot, and `npm run
 * ledger:prefill` runs this same check on its own so the ledger can be built while the previous
 * release is still serving. Every later boot resumes from the stored cursor and reads only the
 * blocks since the last boot. A fresh mainnet controller is one window.
 */

/**
 * The first window size, in blocks: the cap of Arc's public RPC on eth_getLogs. Starting wider
 * would spend the first queries of every window on range refusals. A node with a smaller cap is
 * still handled by the shrink-on-refusal loop.
 */
export const PUBLIC_RPC_LOG_RANGE = 10_000n;

/** Waits before each retry of a rate-limited window, in milliseconds; one retry per entry. */
export const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/**
 * Whether an RPC failure is the node rate limiting us: an HTTP 429 anywhere in the cause chain
 * (viem's HttpRequestError carries it as `status`), or a message naming a rate limit. A
 * rate-limited read says nothing about the chain, so it is retried rather than refused.
 */
export function isRateLimitError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 10; depth++) {
    if ((e as { status?: unknown }).status === 429) return true;
    const message = e instanceof Error ? e.message : String(e);
    if (/\b429\b|rate.?limit|too many requests/i.test(message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The boot log line for a passed check; the API and `ledger:prefill` print the same words. */
export function wildcardLedgerLogLine(ledger: WildcardLedgerResult): string {
  return `[boot] WILDCARD_ROLE verified on-chain: held by neither the executor nor the default admin, and no holder in the role history through block ${ledger.toBlock}${ledger.fromBlock !== undefined ? ` (read blocks ${ledger.fromBlock} to ${ledger.toBlock} in ${ledger.windows} window(s))` : ""}`;
}

/** One current holder of the wildcard role, with the grant that gave it the role. */
export interface WildcardHolder {
  /** Lowercase. */
  account: Address;
  grantedTx: Hex;
  grantedBlock: number;
}

export interface WildcardLedgerResult {
  /** The first block read this boot; undefined when the ledger was already at the latest block. */
  fromBlock?: bigint;
  toBlock: bigint;
  windows: number;
}

const roleGrantedEvent = getAbiItem({ abi: noviControllerAbi, name: "RoleGranted" });
const roleRevokedEvent = getAbiItem({ abi: noviControllerAbi, name: "RoleRevoked" });

interface LedgerRow {
  cursor_block: number;
  holders_json: string;
  deploy_tx: string | null;
  deploy_block: number | null;
}

interface StoredLedger {
  cursor: bigint;
  holders: Map<string, WildcardHolder>;
  /** Lowercase; null on a row written before the deploy transaction was stored. */
  deployTx: string | null;
  deployBlock: bigint | null;
}

function loadLedger(
  db: Database.Database,
  controller: string,
  chainId: number,
): StoredLedger | undefined {
  const row = db
    .prepare(
      "SELECT cursor_block, holders_json, deploy_tx, deploy_block FROM controller_role_ledger WHERE controller = ? AND chain_id = ?",
    )
    .get(controller, chainId) as LedgerRow | undefined;
  if (!row) return undefined;
  const holders = new Map<string, WildcardHolder>();
  for (const h of JSON.parse(row.holders_json) as WildcardHolder[])
    holders.set(h.account.toLowerCase(), { ...h, account: h.account.toLowerCase() as Address });
  return {
    cursor: BigInt(row.cursor_block),
    holders,
    deployTx: row.deploy_tx?.toLowerCase() ?? null,
    deployBlock: row.deploy_block === null ? null : BigInt(row.deploy_block),
  };
}

function saveLedger(
  db: Database.Database,
  controller: string,
  chainId: number,
  cursor: bigint,
  holders: Map<string, WildcardHolder>,
  deploy: { tx: Hex; block: bigint },
): void {
  db.prepare(
    `INSERT INTO controller_role_ledger
       (controller, chain_id, cursor_block, holders_json, deploy_tx, deploy_block)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (controller, chain_id)
     DO UPDATE SET cursor_block = excluded.cursor_block, holders_json = excluded.holders_json,
                   deploy_tx = excluded.deploy_tx, deploy_block = excluded.deploy_block`,
  ).run(
    controller,
    chainId,
    Number(cursor),
    JSON.stringify([...holders.values()]),
    deploy.tx.toLowerCase(),
    Number(deploy.block),
  );
}

/**
 * Refuse to boot if anyone holds the controller's WILDCARD_ROLE (see the module comment for the
 * order of checks). Returns what the replay read, for the boot log line.
 */
export async function assertNoWildcardHolder(
  publicClient: PublicClient,
  db: Database.Database,
  p: {
    controller: Address;
    chainId: number;
    /** CONTROLLER_DEPLOY_TX. Optional in the type because the config field is; absent refuses. */
    deployTx: Hex | undefined;
    /** CONTROLLER_DEPLOY_BLOCK, the block holding `deployTx`. Optional for the same reason. */
    deployBlock: bigint | number | undefined;
    executor: Address;
  },
  /** Injectable for tests, so a backoff costs no wall-clock time. */
  io: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<WildcardLedgerResult> {
  const sleep = io.sleep ?? realSleep;
  if (!p.deployTx)
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX is unset — the WILDCARD_ROLE check on CONTROLLER_ADDRESS ${p.controller} replays the controller's role history from the transaction that created it`,
    );
  if (p.deployBlock === undefined)
    throw new Error(
      `boot: CONTROLLER_DEPLOY_BLOCK is unset — the WILDCARD_ROLE check on CONTROLLER_ADDRESS ${p.controller} verifies the deploy transaction through the block that holds it`,
    );
  const deployTx = p.deployTx.toLowerCase() as Hex;
  const deployBlock = BigInt(p.deployBlock);

  // 1. The two direct reads.
  let wildcard: Hex;
  let admin: Address;
  let executorHolds: boolean;
  let adminHolds: boolean;
  try {
    [wildcard, admin] = await Promise.all([
      publicClient.readContract({
        address: p.controller,
        abi: noviControllerAbi,
        functionName: "WILDCARD_ROLE",
      }) as Promise<Hex>,
      publicClient.readContract({
        address: p.controller,
        abi: noviControllerAbi,
        functionName: "defaultAdmin",
      }) as Promise<Address>,
    ]);
    const holds = (account: Address) =>
      publicClient.readContract({
        address: p.controller,
        abi: noviControllerAbi,
        functionName: "hasRole",
        args: [wildcard, account],
      }) as Promise<boolean>;
    [executorHolds, adminHolds] = await Promise.all([holds(p.executor), holds(admin)]);
  } catch (err) {
    throw unreadable(`the WILDCARD_ROLE holders of CONTROLLER_ADDRESS ${p.controller}`, err);
  }
  if (executorHolds !== false)
    throw new Error(
      `boot: executor ${p.executor} (the address of PLATFORM_PRIVATE_KEY) holds WILDCARD_ROLE on CONTROLLER_ADDRESS ${p.controller} — it could relay any call to any contract; revoke the role from the controller admin before starting`,
    );
  if (adminHolds !== false)
    throw new Error(
      `boot: the default admin ${admin} holds WILDCARD_ROLE on CONTROLLER_ADDRESS ${p.controller} — it could relay any call to any contract; revoke the role before starting`,
    );

  // 2. The deploy transaction, verified through its block unless the ledger already holds it.
  const key = p.controller.toLowerCase();
  const stored = loadLedger(db, key, p.chainId);
  const alreadyVerified =
    stored !== undefined && stored.deployTx === deployTx && stored.deployBlock === deployBlock;
  if (stored && stored.deployTx !== null && !alreadyVerified)
    throw new Error(
      `boot: the stored deploy transaction for CONTROLLER_ADDRESS ${p.controller} on chain ${p.chainId} (${stored.deployTx} in block ${stored.deployBlock}) differs from CONTROLLER_DEPLOY_TX ${deployTx} in CONTROLLER_DEPLOY_BLOCK ${deployBlock} — the WILDCARD_ROLE ledger was built from the stored one; reconcile the configuration or the controller_role_ledger row by hand before starting`,
    );
  if (!alreadyVerified)
    await verifyDeployByBlock(publicClient, p.controller, deployTx, deployBlock);
  const deploy = { tx: deployTx, block: deployBlock };

  // 3. The replay, resumed from the stored cursor.
  const holders = stored?.holders ?? new Map<string, WildcardHolder>();
  let from = stored && stored.cursor + 1n > deployBlock ? stored.cursor + 1n : deployBlock;

  let latest: bigint;
  try {
    latest = await publicClient.getBlockNumber();
  } catch (err) {
    throw unreadable("the latest block number", err);
  }

  const firstBlock = from <= latest ? from : undefined;
  let range = PUBLIC_RPC_LOG_RANGE;
  let windows = 0;
  let rateLimitRetries = 0;
  while (from <= latest) {
    const window = chunkRange(from, latest, range)[0]!;
    let logs: Awaited<ReturnType<typeof readWindow>>;
    try {
      logs = await readWindow(publicClient, p.controller, wildcard, window.from, window.to);
      rateLimitRetries = 0;
    } catch (err) {
      if (isRangeTooLargeError(err)) {
        const smaller = shrinkRange(range);
        if (smaller !== undefined) {
          range = smaller;
          continue; // the same window again, narrower
        }
      }
      const backoff = RATE_LIMIT_BACKOFF_MS[rateLimitRetries];
      if (backoff !== undefined && isRateLimitError(err)) {
        rateLimitRetries++;
        await sleep(backoff);
        continue; // the same window again, after the node has had time to recover
      }
      throw unreadable(
        `the WILDCARD_ROLE history of CONTROLLER_ADDRESS ${p.controller} (blocks ${window.from} to ${window.to})`,
        err,
      );
    }
    for (const log of logs) {
      const account = log.args.account?.toLowerCase() as Address | undefined;
      if (!account || log.blockNumber === null || log.transactionHash === null)
        throw new Error(
          `boot: a WILDCARD_ROLE log of CONTROLLER_ADDRESS ${p.controller} in blocks ${window.from} to ${window.to} could not be decoded — refusing to boot on a role history it cannot read`,
        );
      if (log.eventName === "RoleGranted") {
        if (!holders.has(account))
          holders.set(account, {
            account,
            grantedTx: log.transactionHash,
            grantedBlock: Number(log.blockNumber),
          });
      } else {
        holders.delete(account);
      }
    }
    saveLedger(db, key, p.chainId, window.to, holders, deploy);
    windows++;
    from = window.to + 1n;
  }
  // Nothing to replay yet (a fresh controller whose ledger is already at the latest block, or a
  // row from before the deploy transaction was stored): keep the facts verified above anyway, so
  // the next boot skips the block reads and still catches a changed CONTROLLER_DEPLOY_TX.
  if (windows === 0 && !alreadyVerified) saveLedger(db, key, p.chainId, from - 1n, holders, deploy);

  // 4. Anyone left holds the role.
  if (holders.size > 0)
    throw new Error(
      `boot: ${holders.size} account(s) hold WILDCARD_ROLE on CONTROLLER_ADDRESS ${p.controller}, which lets a holder relay any call to any contract: ${[
        ...holders.values(),
      ]
        .map(
          (h) => `${h.account} (granted in transaction ${h.grantedTx} at block ${h.grantedBlock})`,
        )
        .join(", ")} — revoke the role from each before starting`,
    );

  return { fromBlock: firstBlock, toBlock: latest, windows };
}

/**
 * Prove CONTROLLER_DEPLOY_TX created CONTROLLER_ADDRESS, reading only the block and its receipts.
 * Any read that fails or comes back empty is "could not verify", never a pass; a transaction that
 * is readable and wrong refuses with what it actually is.
 */
async function verifyDeployByBlock(
  publicClient: PublicClient,
  controller: Address,
  deployTx: Hex,
  deployBlock: bigint,
): Promise<void> {
  let block: Awaited<ReturnType<typeof getFullBlock>>;
  try {
    block = await getFullBlock(publicClient, deployBlock);
  } catch (err) {
    throw unreadable(`CONTROLLER_DEPLOY_BLOCK ${deployBlock}`, err);
  }
  const tx = block.transactions.find((t) => t.hash.toLowerCase() === deployTx);
  if (!tx)
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} is not in block ${deployBlock} — set CONTROLLER_DEPLOY_TX and CONTROLLER_DEPLOY_BLOCK to the transaction that deployed CONTROLLER_ADDRESS ${controller} and the block that holds it`,
    );
  if (tx.to !== null)
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} is a call to ${tx.to}, not a contract creation — it did not deploy CONTROLLER_ADDRESS ${controller}`,
    );
  const derived = getContractAddress({ from: tx.from, nonce: BigInt(tx.nonce) });
  if (!isAddressEqual(derived, controller))
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} created ${derived} (sender ${tx.from}, nonce ${tx.nonce}), not CONTROLLER_ADDRESS ${controller} — set it to the transaction that deployed the controller`,
    );

  let receipts: Awaited<ReturnType<typeof getBlockReceipts>>;
  try {
    receipts = await getBlockReceipts(publicClient, deployBlock);
  } catch (err) {
    throw unreadable(`the receipts of CONTROLLER_DEPLOY_BLOCK ${deployBlock}`, err);
  }
  const receipt = receipts?.find((r) => r.transactionHash.toLowerCase() === deployTx);
  if (!receipt)
    throw unreadable(
      `the receipt of CONTROLLER_DEPLOY_TX ${deployTx} in block ${deployBlock}`,
      new Error(
        receipts ? "the block's receipts do not include it" : "eth_getBlockReceipts returned null",
      ),
    );
  if (receipt.status !== "0x1")
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} has status ${receipt.status} in block ${deployBlock} — a failed transaction created no controller`,
    );
  if (!receipt.contractAddress || !isAddressEqual(receipt.contractAddress, controller))
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} created ${receipt.contractAddress ?? "no contract"} according to its receipt, not CONTROLLER_ADDRESS ${controller} — set it to the transaction that deployed the controller`,
    );
}

function getFullBlock(publicClient: PublicClient, blockNumber: bigint) {
  return publicClient.getBlock({ blockNumber, includeTransactions: true });
}

/** Raw receipts (hex fields, as the node sends them); null when the node has none for the block. */
function getBlockReceipts(publicClient: PublicClient, blockNumber: bigint) {
  return publicClient.request({ method: "eth_getBlockReceipts", params: [toHex(blockNumber)] });
}

/**
 * The check as `ledger:prefill` runs it: from the configuration alone, with the executor address
 * derived from PLATFORM_PRIVATE_KEY exactly as the API derives it. Returns the API's log line.
 */
export async function prefillWildcardLedger(
  cfg: Config,
  publicClient: PublicClient,
  db: Database.Database,
  io: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  if (!cfg.controllerAddress)
    throw new Error(
      "ledger:prefill: CONTROLLER_ADDRESS is unset — the WILDCARD_ROLE ledger belongs to a controller, and this deployment has none",
    );
  const ledger = await assertNoWildcardHolder(
    publicClient,
    db,
    {
      controller: cfg.controllerAddress,
      chainId: cfg.chainId,
      deployTx: cfg.controllerDeployTx,
      deployBlock: cfg.controllerDeployBlock,
      executor: managerAccount(cfg).address,
    },
    io,
  );
  return wildcardLedgerLogLine(ledger);
}

/** Both role events for one window, in block and log-index order. */
async function readWindow(
  publicClient: PublicClient,
  controller: Address,
  wildcard: Hex,
  fromBlock: bigint,
  toBlock: bigint,
) {
  const [granted, revoked] = await Promise.all([
    publicClient.getLogs({
      address: controller,
      event: roleGrantedEvent,
      args: { role: wildcard },
      fromBlock,
      toBlock,
    }),
    publicClient.getLogs({
      address: controller,
      event: roleRevokedEvent,
      args: { role: wildcard },
      fromBlock,
      toBlock,
    }),
  ]);
  const logs = [...granted, ...revoked];
  logs.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? (a.logIndex ?? 0) - (b.logIndex ?? 0)
      : (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n)
        ? -1
        : 1,
  );
  return logs;
}
