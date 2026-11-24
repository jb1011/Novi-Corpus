import {
  type Address,
  type Hex,
  type PublicClient,
  getAddress,
  isAddress,
  keccak256,
  zeroAddress,
} from "viem";
import {
  POT_CODE_HASHES,
  type PotAddresses,
  type PotRaw,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  allowanceModuleAbi,
  erc20Abi,
  safeAbi,
} from "../../legalBody/safePot";

/**
 * The company's pot on chain, as the server reads it: a pot's raw facts at one block (`readPot`),
 * the code hash at an address (`codeHash`), and the start-up check of the seven contracts the pot
 * is built from (`assertPotContracts`). Reads only: nothing here signs or sends.
 *
 * The reads are the website's `readPotRaw` (`interface/src/lib/legalBody/safePotRules.ts`), read
 * for read: the two packages share no code, and both suites pin them to the real Safe's answers.
 * A code hash is keccak256 of `eth_getCode`: Arc's nodes refuse `eth_getProof`.
 */

/** The reads the pot's rules rest on. Any failed read throws: a failure is never an answer. */
export interface SafePotChainPort {
  /** Every read of the website's `readPotRaw` at `blockNumber` (the latest block, read first and
   *  fresh, when absent). Any failure throws. */
  readPot(p: { pot: Address; agentWallet: Address; blockNumber?: bigint }): Promise<PotRaw>;
  /** keccak256 of the code at an address at `blockNumber` (the latest block when absent), null for
   *  no code. Any failure throws. */
  codeHash(address: Address, blockNumber?: bigint): Promise<Hex | null>;
}

/** The first page of the Safe's module list, and of the module's delegates: ten, as the real run
 *  read them. A page that is not the end says so (`next`), and the rules refuse it. */
const PAGE = 10;
/** A storage word: 32 bytes, written out in full. */
const WORD = /^0x[0-9a-fA-F]{64}$/;
/** The 12 bytes above an address in a word: zeros. */
const ZERO_PREFIX = /^0{24}$/;
/** Code as a node answers it: whole bytes in hex. */
const CODE = /^0x(?:[0-9a-fA-F]{2})+$/;

/** The address in a Safe's storage word, its last 20 bytes, checksummed. A word that is not 32
 *  bytes, or that holds anything above its last 20 bytes, is not an address: the read fails,
 *  never answers. */
function addressInWord(word: Hex, slot: string): Address {
  if (typeof word !== "string" || !WORD.test(word))
    throw new Error(`The pot's ${slot} slot did not answer one 32-byte word.`);
  if (!ZERO_PREFIX.test(word.slice(2, 26)))
    throw new Error(`The pot's ${slot} slot does not hold an address.`);
  return getAddress(`0x${word.slice(26).toLowerCase()}`);
}

/** An address as the reads send it: checksummed from lower case, so any letter case is taken
 *  (viem refuses a mixed case that is not the checksum when it encodes a call). */
const checksummed = (x: Address): Address => getAddress(x.toLowerCase());

/** viem's getCode answers undefined for no code; a node may answer `0x`. */
const hasCode = (code: Hex | undefined): code is Hex => code !== undefined && code !== "0x";

/** Hex compared in lower case; anything that is not a string is never equal. */
const sameHex = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** The facts of an address with no pot's code: empty lists, the zero address, zeros and false. */
const nothingElse = (codeHash: Hex | null): PotRaw => ({
  codeHash,
  singleton: zeroAddress,
  owners: [],
  threshold: 0n,
  modules: { list: [], next: zeroAddress },
  guard: zeroAddress,
  fallbackHandler: zeroAddress,
  delegates: { list: [], next: 0 },
  tokens: [],
  allowance: [0n, 0n, 0n, 0n, 0n],
  usdcAllowanceToAgent: 0n,
  balanceUnits: 0n,
  balanceWei: 0n,
  agentBalanceWei: 0n,
  agentHasCode: false,
});

export class SafePotChain implements SafePotChainPort {
  constructor(private readonly d: { publicClient: PublicClient; addresses: PotAddresses }) {}

  /**
   * The reads, all at one block: `blockNumber` when given, else the latest, read first and fresh
   * (`getBlockNumber({ cacheTime: 0 })`). `getCode(pot)`; then, only when its hash is the
   * proxy's, one `multicall` with `multicallAddress` the table's Multicall3 and
   * `allowFailure: false`, plus `getBalance` of the pot and of the agent's wallet and `getCode` of
   * the agent's wallet. No code: `codeHash: null`; a code hash that is not the proxy's: that hash;
   * in both cases no other read, and the other fields hold empty lists, the zero address, zeros
   * and false.
   *
   * The multicall reads, as the real run read them: the Safe's `masterCopy()` (the proxy answers
   * it itself), `getOwners()`, `getThreshold()`, `getModulesPaginated(sentinel, 10)`, and its
   * guard and fallback handler slots by `getStorageAt(slot, 1)`; the module's
   * `getDelegates(pot, 0, 10)`, `getTokens(pot, agentWallet)` and
   * `getTokenAllowance(pot, agentWallet, usdc)`; the token's `balanceOf(pot)` and
   * `allowance(pot, agentWallet)`. Addresses are taken in any letter case and sent checksummed.
   */
  async readPot(p: { pot: Address; agentWallet: Address; blockNumber?: bigint }): Promise<PotRaw> {
    const client = this.d.publicClient;
    const a = this.d.addresses;
    const pot = checksummed(p.pot);
    const agentWallet = checksummed(p.agentWallet);
    const usdc = checksummed(a.usdc);
    // Read fresh: viem otherwise serves a cached head for its polling interval, and a read right
    // after the guardian's own transaction could see an older block.
    const blockNumber = p.blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
    const potCode = await client.getCode({ address: pot, blockNumber });
    if (!hasCode(potCode)) return nothingElse(null);
    const codeHash = keccak256(potCode);
    if (!sameHex(codeHash, SAFE_PROXY_RUNTIME_CODE_HASH)) return nothingElse(codeHash);

    const safe = { address: pot, abi: safeAbi } as const;
    const allowances = {
      address: checksummed(a.allowanceModule),
      abi: allowanceModuleAbi,
    } as const;
    const token = { address: usdc, abi: erc20Abi } as const;
    const [answers, balanceWei, agentBalanceWei, agentCode] = await Promise.all([
      client.multicall({
        contracts: [
          { ...safe, functionName: "masterCopy" },
          { ...safe, functionName: "getOwners" },
          { ...safe, functionName: "getThreshold" },
          { ...safe, functionName: "getModulesPaginated", args: [SAFE_SENTINEL, BigInt(PAGE)] },
          { ...safe, functionName: "getStorageAt", args: [BigInt(SAFE_GUARD_SLOT), 1n] },
          { ...safe, functionName: "getStorageAt", args: [BigInt(SAFE_FALLBACK_HANDLER_SLOT), 1n] },
          { ...allowances, functionName: "getDelegates", args: [pot, 0, PAGE] },
          { ...allowances, functionName: "getTokens", args: [pot, agentWallet] },
          { ...allowances, functionName: "getTokenAllowance", args: [pot, agentWallet, usdc] },
          { ...token, functionName: "balanceOf", args: [pot] },
          { ...token, functionName: "allowance", args: [pot, agentWallet] },
        ],
        multicallAddress: checksummed(a.multicall3),
        allowFailure: false,
        blockNumber,
      }),
      client.getBalance({ address: pot, blockNumber }),
      client.getBalance({ address: agentWallet, blockNumber }),
      client.getCode({ address: agentWallet, blockNumber }),
    ]);
    const [
      singleton,
      owners,
      threshold,
      [moduleList, moduleNext],
      guardWord,
      handlerWord,
      [delegateList, delegateNext],
      tokens,
      allowance,
      balanceUnits,
      usdcAllowanceToAgent,
    ] = answers;
    return {
      codeHash,
      singleton,
      owners,
      threshold,
      modules: { list: moduleList, next: moduleNext },
      guard: addressInWord(guardWord, "guard"),
      fallbackHandler: addressInWord(handlerWord, "fallback handler"),
      delegates: { list: delegateList, next: delegateNext },
      tokens,
      allowance,
      usdcAllowanceToAgent,
      balanceUnits,
      balanceWei,
      agentBalanceWei,
      agentHasCode: hasCode(agentCode),
    };
  }

  /** keccak256 of the code at `address`, at `blockNumber` when given (the public record reads a
   *  pot at its statement's block) and at the latest block otherwise; null for no code (`0x` or
   *  nothing). One read, no other. A failed read throws. */
  async codeHash(address: Address, blockNumber?: bigint): Promise<Hex | null> {
    const at = checksummed(address);
    const code = await this.d.publicClient.getCode(
      blockNumber === undefined ? { address: at } : { address: at, blockNumber },
    );
    return hasCode(code) ? keccak256(code) : null;
  }
}

// ---------------------------------------------------------------------------------------------
// The start-up check
// ---------------------------------------------------------------------------------------------

/** The seven contracts by the names a person checks them by. */
const POT_CONTRACT_NAMES: Readonly<Record<keyof PotAddresses, string>> = {
  safeSingleton: "SafeL2 v1.4.1",
  proxyFactory: "SafeProxyFactory v1.4.1",
  fallbackHandler: "CompatibilityFallbackHandler v1.4.1",
  multiSendCallOnly: "MultiSendCallOnly v1.5.0",
  allowanceModule: "AllowanceModule v0.1.1",
  multicall3: "Multicall3",
  usdc: "USDC (its proxy)",
};

/** The order the seven are read and reported in: the table's. */
const POT_CONTRACTS = Object.keys(POT_CONTRACT_NAMES) as (keyof PotAddresses)[];

/** mismatch: the chain answered, and a contract holds no code or other code; or the table or the
 *  hashes the check was handed cannot be used (a security stop for the pot; retrying will not
 *  change it). unreadable: a read of the code failed, or answered something that is not code (the
 *  deployment may be fine; it could not be confirmed). */
export type PotContractsProblem = "mismatch" | "unreadable";

/** What the check was handed and could not use, before any read: no table of addresses, no
 *  record of hashes, or a table entry that is not an address. Always a mismatch. */
export type PotContractsUnusable = "table" | "hashes" | "address";

/**
 * The one error `assertPotContracts` throws, whose `reason` says which: a caller catches exactly
 * this class and switches the pot off (on `unreadable`, it may try again later), and nothing else
 * of the server stops for it. `contract` is the table's name of the contract at fault, `address`
 * its address, `expected` its pinned hash, `actual` the hash read (null for no code); on
 * `unreadable`, `cause` is the read's own error.
 */
export class PotContractsNotVerifiedError extends Error {
  readonly reason: PotContractsProblem;
  readonly contract?: keyof PotAddresses;
  readonly address?: Address;
  readonly expected?: Hex;
  readonly actual?: Hex | null;
  /** Set when the check could not use what it was handed (always a mismatch): no read was made. */
  readonly unusable?: PotContractsUnusable;

  constructor(f: {
    reason: PotContractsProblem;
    contract?: keyof PotAddresses;
    address?: Address;
    expected?: Hex;
    actual?: Hex | null;
    unusable?: PotContractsUnusable;
    cause?: unknown;
  }) {
    super(PotContractsNotVerifiedError.describe(f), { cause: f.cause });
    this.name = "PotContractsNotVerifiedError";
    this.reason = f.reason;
    this.contract = f.contract;
    this.address = f.address;
    this.expected = f.expected;
    this.actual = f.actual;
    this.unusable = f.unusable;
  }

  /** One line for the boot log: the contract, its address and, on a mismatch, the two hashes. */
  private static describe(f: {
    reason: PotContractsProblem;
    contract?: keyof PotAddresses;
    address?: Address;
    expected?: Hex;
    actual?: Hex | null;
    unusable?: PotContractsUnusable;
    cause?: unknown;
  }): string {
    const name =
      f.contract === undefined ? undefined : (POT_CONTRACT_NAMES[f.contract] ?? f.contract);
    if (f.unusable === "table")
      return "mismatch: the table of the pot's seven contracts is not a table of addresses";
    if (f.unusable === "hashes")
      return "mismatch: the pinned code hashes are not a record of hashes";
    if (f.unusable === "address")
      return `mismatch: the pot's ${name ?? "contract"} (${f.contract}) has no address in the table`;
    const which =
      f.contract === undefined
        ? "one of the pot's seven contracts"
        : `the pot's ${name} (${f.contract}) at ${f.address}`;
    if (f.reason === "unreadable") {
      const why = f.cause instanceof Error ? `: ${f.cause.message.split("\n")[0]}` : "";
      return `unreadable: the code of ${which} could not be read${why}`;
    }
    const found =
      f.actual === null || f.actual === undefined ? "no code" : `code hashing to ${f.actual}`;
    return `mismatch: ${which} holds ${found}, not the pinned ${f.expected ?? "hash"}`;
  }
}

/**
 * Reads the code of the seven addresses at the latest block and compares keccak256 of each with
 * `hashes`, in lower case. Resolves when all seven match. Otherwise it throws ONE kind of error,
 * `PotContractsNotVerifiedError`, and nothing else:
 *
 * - `reason: "mismatch"`: an address holds no code, or code with another hash (a `hashes` record
 *   without that contract's hash never matches). A mismatch is reported before an unreadable
 *   contract: the chain's answer for one contract is a stop whatever the others answered.
 * - `reason: "unreadable"`: a read failed, or answered something that is not code.
 *
 * Before any read, what it was handed is checked: a table that is not an object, a hashes record
 * that is not one, or a table entry that is not an address (in any letter case) is a mismatch
 * too, with `unusable` saying which, and no read is made. Never a plain TypeError, and never
 * `unreadable`, which the caller would try again forever.
 *
 * The first contract at fault in the table's order is named. The check decides nothing about the
 * rest of the server: its caller catches this one class, boots anyway and only switches the pot
 * off (Ruling R1). A caller that forgot to catch it would still fail closed: the boot would stop,
 * loudly, rather than serve a pot whose contracts were not checked.
 */
export async function assertPotContracts(
  client: Pick<PublicClient, "getCode">,
  a: PotAddresses,
  hashes: Readonly<Record<keyof PotAddresses, Hex>> = POT_CODE_HASHES,
): Promise<void> {
  if (typeof a !== "object" || a === null)
    throw new PotContractsNotVerifiedError({ reason: "mismatch", unusable: "table" });
  if (typeof hashes !== "object" || hashes === null)
    throw new PotContractsNotVerifiedError({ reason: "mismatch", unusable: "hashes" });
  for (const contract of POT_CONTRACTS) {
    const address: unknown = a[contract];
    if (typeof address !== "string" || !isAddress(address, { strict: false }))
      throw new PotContractsNotVerifiedError({ reason: "mismatch", contract, unusable: "address" });
  }
  const reads = await Promise.allSettled(
    POT_CONTRACTS.map(async (contract) => {
      const code: unknown = await client.getCode({ address: checksummed(a[contract]) });
      if (code === undefined || code === "0x") return null;
      if (typeof code !== "string" || !CODE.test(code))
        throw new Error(
          `the node answered something that is not code: ${String(code).slice(0, 20)}`,
        );
      return keccak256(code as Hex);
    }),
  );
  let unreadable: PotContractsNotVerifiedError | undefined;
  for (const [i, read] of reads.entries()) {
    const contract = POT_CONTRACTS[i] as keyof PotAddresses;
    const address = a[contract];
    if (read.status === "rejected") {
      unreadable ??= new PotContractsNotVerifiedError({
        reason: "unreadable",
        contract,
        address,
        cause: read.reason,
      });
      continue;
    }
    const expected = hashes[contract];
    if (read.value === null || !sameHex(read.value, expected))
      throw new PotContractsNotVerifiedError({
        reason: "mismatch",
        contract,
        address,
        expected,
        actual: read.value,
      });
  }
  if (unreadable) throw unreadable;
}
