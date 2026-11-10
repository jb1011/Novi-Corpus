import type Database from "better-sqlite3";
import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  getAbiItem,
  isAddressEqual,
} from "viem";
import { noviControllerAbi } from "../../abis/generated";
import { MAX_LOG_RANGE, chunkRange, isRangeTooLargeError, shrinkRange } from "../../monitor/scan";
import { unreadable } from "./bootVerify";

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
 *  2. The deploy receipt (CONTROLLER_DEPLOY_TX) must exist, have succeeded, and have created
 *     exactly the configured controller. Its block is where the role history starts.
 *  3. The replay reads the wildcard role's grants and revokes, filtered on the role topic by the
 *     node, from the deploy block (or the stored cursor) to the latest block, and keeps the holder
 *     set and the cursor in `controller_role_ledger` after every fully read window.
 *  4. A non-empty holder set refuses the boot, naming every holder and the transaction that
 *     granted it. Any read failure is "could not verify", never a pass.
 *
 * Cost: the first boot against an old testnet controller replays months of blocks at the public
 * RPC's window size (a few thousand blocks per query on Arc's public endpoint, with sub-second
 * blocks) and may take many minutes. Every later boot resumes from the stored cursor and reads only
 * the blocks since the last boot. A fresh mainnet controller is one window.
 */

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
}

function loadLedger(
  db: Database.Database,
  controller: string,
  chainId: number,
): { cursor: bigint; holders: Map<string, WildcardHolder> } | undefined {
  const row = db
    .prepare(
      "SELECT cursor_block, holders_json FROM controller_role_ledger WHERE controller = ? AND chain_id = ?",
    )
    .get(controller, chainId) as LedgerRow | undefined;
  if (!row) return undefined;
  const holders = new Map<string, WildcardHolder>();
  for (const h of JSON.parse(row.holders_json) as WildcardHolder[])
    holders.set(h.account.toLowerCase(), { ...h, account: h.account.toLowerCase() as Address });
  return { cursor: BigInt(row.cursor_block), holders };
}

function saveLedger(
  db: Database.Database,
  controller: string,
  chainId: number,
  cursor: bigint,
  holders: Map<string, WildcardHolder>,
): void {
  db.prepare(
    `INSERT INTO controller_role_ledger (controller, chain_id, cursor_block, holders_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (controller, chain_id)
     DO UPDATE SET cursor_block = excluded.cursor_block, holders_json = excluded.holders_json`,
  ).run(controller, chainId, Number(cursor), JSON.stringify([...holders.values()]));
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
    executor: Address;
  },
): Promise<WildcardLedgerResult> {
  if (!p.deployTx)
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX is unset — the WILDCARD_ROLE check on CONTROLLER_ADDRESS ${p.controller} replays the controller's role history from the transaction that created it`,
    );
  const deployTx = p.deployTx;

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

  // 2. The deploy receipt names the contract and the first block of its history.
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: deployTx });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError)
      throw new Error(
        `boot: CONTROLLER_DEPLOY_TX ${deployTx} has no receipt on this chain — it is not the transaction that created CONTROLLER_ADDRESS ${p.controller}`,
        { cause: err },
      );
    throw unreadable(`the deploy receipt (CONTROLLER_DEPLOY_TX ${deployTx})`, err);
  }
  if (!receipt)
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} has no receipt on this chain — it is not the transaction that created CONTROLLER_ADDRESS ${p.controller}`,
    );
  if (receipt.status !== "success")
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} has status ${receipt.status} — a failed transaction created no controller`,
    );
  if (!receipt.contractAddress || !isAddressEqual(receipt.contractAddress, p.controller))
    throw new Error(
      `boot: CONTROLLER_DEPLOY_TX ${deployTx} created ${receipt.contractAddress ?? "no contract"}, not CONTROLLER_ADDRESS ${p.controller} — set it to the transaction that deployed the controller`,
    );

  // 3. The replay, resumed from the stored cursor.
  const key = p.controller.toLowerCase();
  const stored = loadLedger(db, key, p.chainId);
  const holders = stored?.holders ?? new Map<string, WildcardHolder>();
  let from =
    stored && stored.cursor + 1n > receipt.blockNumber ? stored.cursor + 1n : receipt.blockNumber;

  let latest: bigint;
  try {
    latest = await publicClient.getBlockNumber();
  } catch (err) {
    throw unreadable("the latest block number", err);
  }

  const firstBlock = from <= latest ? from : undefined;
  let range = MAX_LOG_RANGE;
  let windows = 0;
  while (from <= latest) {
    const window = chunkRange(from, latest, range)[0]!;
    let logs: Awaited<ReturnType<typeof readWindow>>;
    try {
      logs = await readWindow(publicClient, p.controller, wildcard, window.from, window.to);
    } catch (err) {
      if (isRangeTooLargeError(err)) {
        const smaller = shrinkRange(range);
        if (smaller !== undefined) {
          range = smaller;
          continue; // the same window again, narrower
        }
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
    saveLedger(db, key, p.chainId, window.to, holders);
    windows++;
    from = window.to + 1n;
  }

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
