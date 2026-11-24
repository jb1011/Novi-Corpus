/**
 * The company's pot, the server's own copy: the addresses and the seven code hashes the start-up
 * check compares, the pinned ABI fragments, the setup's initializer and the pot's predicted
 * address, the agent's take, the reading rules (`potReading`) and the most a ceiling may be under
 * the agent's grant (`potCeilingCapFromGrant`).
 *
 * The pot is a Safe v1.4.1 whose only owner is the guardian, with Safe's AllowanceModule v0.1.1
 * letting the agent's own key take USDC up to a ceiling in each fixed thirty-day period. No contract
 * of ours. The guardian creates and runs it from the website; the server builds no guardian
 * transaction. It reads a pot, checks a noted address against the one its birth details predict,
 * and prepares the take the agent's key sends itself.
 *
 * The two packages share no code: the website holds the same constants, encodings and rules
 * (`interface/src/lib/legalBody/safePot.ts` and `safePotRules.ts`), and both suites pin them to the
 * same values and vectors. Every encoding is lifted from the script that ran on Arc testnet on
 * 24 Nov. Nothing here reads a chain, a clock or a key. Addresses are compared without regard to
 * letter case, hex in lower case; inside the bytes addresses are written in lower case, and an
 * address handed back is checksummed.
 */
import {
  type Address,
  type Hex,
  concat,
  encodeFunctionData,
  encodePacked,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
  size,
  zeroAddress,
} from "viem";
import { GRANT_AMOUNT_MAX } from "./grant";

// ---------------------------------------------------------------------------------------------
// Amounts, limits and pinned values
// ---------------------------------------------------------------------------------------------

/** The pot's period: thirty days in minutes, the module's `resetTimeMin`. The periods are fixed:
 *  each starts where the last one ended, counted from the minute the ceiling was first set. */
export const POT_PERIOD_MINUTES = 43200;
/** Units in 1 USDC: the ERC-20 face of Arc's native balance has 6 decimals. */
export const USDC_UNIT = 1_000_000n;
/** The largest ceiling a guardian may set, in whole USDC. */
export const POT_CEILING_MAX_USDC = 3_000_000_000;
/** The fixed gas limit of the agent's take (the real run's first take used 112,615). */
export const POT_TAKE_GAS = 200_000;
/** The agent key's low fee-money mark: one take's gas limit at 50 gwei, twice today's fee.
 *  0.01 USDC, in native wei. */
export const POT_FEE_LOW_WEI = 10_000_000_000_000_000n;

/** keccak256 of the factory's proxy creation code followed by the singleton as a 32-byte word:
 *  the init code hash every pot's address is derived from. */
export const SAFE_PROXY_INIT_CODE_HASH: Hex =
  "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee";
/** keccak256 of a created proxy's runtime code (171 bytes): what a pot's own code hashes to. */
export const SAFE_PROXY_RUNTIME_CODE_HASH: Hex =
  "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c";
/** The start and the end of a Safe's module list: the "previous module" of the first one. */
export const SAFE_SENTINEL: Address = "0x0000000000000000000000000000000000000001";
/** The storage slot of a Safe's guard: keccak256("guard_manager.guard.address"). */
export const SAFE_GUARD_SLOT: Hex =
  "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
/** The storage slot of a Safe's fallback handler: keccak256("fallback_manager.handler.address"). */
export const SAFE_FALLBACK_HANDLER_SLOT: Hex =
  "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5";

// ---------------------------------------------------------------------------------------------
// The addresses and their code
// ---------------------------------------------------------------------------------------------

/** The seven contracts the pot is built from. */
export type PotAddresses = {
  /** SafeL2 v1.4.1, the code every pot's proxy runs. */
  safeSingleton: Address;
  /** SafeProxyFactory v1.4.1, which creates the pot at an address known before it exists. */
  proxyFactory: Address;
  /** CompatibilityFallbackHandler v1.4.1. */
  fallbackHandler: Address;
  /** MultiSendCallOnly v1.5.0, NOT v1.4.1: only v1.5.0 sends a call to the zero address to the
   *  Safe itself. With v1.4.1 the `enableModule` of the setup goes nowhere and the allowance
   *  feature is silently left off. */
  multiSendCallOnly: Address;
  /** AllowanceModule v0.1.1. */
  allowanceModule: Address;
  /** Multicall3, which runs the setup's calls in one transaction and the reads in one call. */
  multicall3: Address;
  /** Arc's USDC: the ERC-20 face of the native balance. */
  usdc: Address;
};

/** Read from Arc testnet and Arc mainnet on 24 Nov 2026: the same seven on both chains, each with
 *  the same code. */
const ARC_POT_ADDRESSES: PotAddresses = {
  safeSingleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
  proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
  allowanceModule: "0xAA46724893dedD72658219405185Fb0Fc91e091C",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  usdc: "0x3600000000000000000000000000000000000000",
};

/** Arc mainnet and Arc testnet. */
const POT_CHAIN_IDS: readonly number[] = [5042, 5042002];

/** The table: 5042 and 5042002, the same seven addresses; any other chain is null. A new object
 *  each time, so a caller that changes its copy changes nothing else. */
export function potAddresses(chainId: number): PotAddresses | null {
  return POT_CHAIN_IDS.includes(chainId) ? { ...ARC_POT_ADDRESSES } : null;
}

/** The seven code hashes of the Global Constraints' table, by the table's names: keccak256 of
 *  `eth_getCode` at each address, equal on Arc testnet and mainnet on 24 Nov (Arc's nodes refuse
 *  `eth_getProof`, so a code hash is always read this way). USDC's is its proxy's: an upgrade of
 *  its implementation does not change it. The server compares them at start-up. */
export const POT_CODE_HASHES: Readonly<Record<keyof PotAddresses, Hex>> = Object.freeze({
  safeSingleton: "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
  proxyFactory: "0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317",
  fallbackHandler: "0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9",
  multiSendCallOnly: "0xcdbdcec38d2f1c7d961b0029ff8416b7e86e9974d6f0e9c9580c7d17fcfb6663",
  allowanceModule: "0x7aa63affdca06fe94576f00077ad61a02ccf203a5da31e1b4ed595df7b65cf3e",
  multicall3: "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891",
  usdc: "0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d",
});

/** Why a pot's address could not be predicted: another singleton (the factory would create the
 *  Safe at another address than the one predicted) or another proxy factory (the same). */
export type PotBuildProblem = "other_singleton" | "other_proxy_factory";

/** Thrown by `predictPotAddress` on a table that does not name the pinned singleton and factory:
 *  a bug to fix, never a sentence to show. */
export class PotBuildError extends Error {
  readonly problem: PotBuildProblem;
  constructor(problem: PotBuildProblem) {
    super(`The pot's address cannot be predicted: ${problem}.`);
    this.name = "PotBuildError";
    this.problem = problem;
  }
}

// ---------------------------------------------------------------------------------------------
// Pinned ABI fragments: the members the reads, the setup and the take use, with the signatures of
// the proven script
// ---------------------------------------------------------------------------------------------

/** Safe v1.4.1: the setup and the module it enables, and the reads of the pot's public record.
 *  `masterCopy()` is answered by the proxy itself: the singleton it runs. `getModulesPaginated`
 *  answers `next` the sentinel when the page holds the end of the list. `getStorageAt` reads
 *  `length` words from slot `offset`: the guard and the fallback handler slots. */
export const safeAbi = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function enableModule(address module)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
  "function getStorageAt(uint256 offset, uint256 length) view returns (bytes)",
  "function masterCopy() view returns (address)",
]);

/** MultiSendCallOnly v1.5.0: `multiSend`, reached by the setup. */
export const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);

/** AllowanceModule v0.1.1: the setup's two writes, the agent's take, and the three reads. The take
 *  is sent by the agent's key itself with an empty signature: the module takes `msg.sender` as the
 *  signer. `getDelegates` answers `next` 0 when there are no more. `getTokenAllowance` answers
 *  amount, spent, resetTimeMin, lastResetMin and nonce, the period already moved on in the view. */
export const allowanceModuleAbi = parseAbi([
  "function addDelegate(address delegate)",
  "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
  "function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
  "function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)",
  "function getTokens(address safe, address delegate) view returns (address[])",
  "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
]);

/** ERC-20, for Arc's USDC: the balance and the allowance. */
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address _owner, address _spender) view returns (uint256 remaining)",
]);

// ---------------------------------------------------------------------------------------------
// The encodings
// ---------------------------------------------------------------------------------------------

/** An address or bytes as written inside the encodings: lower case. viem takes an address in lower
 *  case without a checksum, so any letter case gives the same bytes. */
const low = <T extends Hex>(x: T): T => x.toLowerCase() as T;

/** Addresses compared without regard to letter case; anything that is not a string is never equal.
 *  Never throws, unlike `isAddressEqual`: a value of another kind is an answer, "not the same". */
const sameAddress = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** The pot's address is predicted from the pinned init code hash, which holds the pinned
 *  singleton, and from the pinned factory: with any other, the prediction would be wrong. */
function assertPinnedSafe(a: PotAddresses): void {
  if (!sameAddress(a.safeSingleton, ARC_POT_ADDRESSES.safeSingleton))
    throw new PotBuildError("other_singleton");
  if (!sameAddress(a.proxyFactory, ARC_POT_ADDRESSES.proxyFactory))
    throw new PotBuildError("other_proxy_factory");
}

/** What the pot is set to: the guardian (the Safe's only owner), the agent's own key (the
 *  module's delegate), the token, the ceiling in units, and the period in minutes. */
export type PotSetup = {
  guardian: Address;
  agentWallet: Address;
  token: Address;
  ceilingUnits: bigint;
  periodMinutes: number;
};

/** One call of a MultiSendCallOnly batch: operation 0 (a call), packed as uint8, address, uint256,
 *  uint256 length, bytes. */
const multiSendPart = (to: Address, data: Hex): Hex =>
  encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [0, low(to), 0n, BigInt(size(data)), low(data)],
  );

/**
 * Safe.setup([guardian], 1, multiSendCallOnly, multiSend(enableModule(module) sent to the zero
 * address, addDelegate(agent), setAllowance(agent, token, ceiling, period, 0)), fallbackHandler,
 * 0, 0, 0). The guardian is the only owner, one signature of the guardian's is enough, and no one
 * is paid for the creation. MultiSendCallOnly v1.5.0 sends the call to the zero address to the Safe
 * itself, whose own address the setup cannot know: it is derived from these very bytes.
 */
export function potInitializer(a: PotAddresses, p: PotSetup): Hex {
  const batch = encodeFunctionData({
    abi: multiSendAbi,
    functionName: "multiSend",
    args: [
      concat([
        multiSendPart(
          zeroAddress,
          encodeFunctionData({
            abi: safeAbi,
            functionName: "enableModule",
            args: [low(a.allowanceModule)],
          }),
        ),
        multiSendPart(
          a.allowanceModule,
          encodeFunctionData({
            abi: allowanceModuleAbi,
            functionName: "addDelegate",
            args: [low(p.agentWallet)],
          }),
        ),
        multiSendPart(
          a.allowanceModule,
          encodeFunctionData({
            abi: allowanceModuleAbi,
            functionName: "setAllowance",
            args: [low(p.agentWallet), low(p.token), p.ceilingUnits, p.periodMinutes, 0],
          }),
        ),
      ]),
    ],
  });
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [
      [low(p.guardian)],
      1n,
      low(a.multiSendCallOnly),
      batch,
      low(a.fallbackHandler),
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
}

/** CREATE2 of the factory: salt = keccak256(keccak256(initializer) ++ saltNonce as 32 bytes), with
 *  SAFE_PROXY_INIT_CODE_HASH. No chain read: the init code hash is pinned. Checksummed. Throws
 *  `PotBuildError` unless `a` names the pinned singleton and factory. */
export function predictPotAddress(a: PotAddresses, initializer: Hex, saltNonce: bigint): Address {
  assertPinnedSafe(a);
  const salt = keccak256(encodePacked(["bytes32", "uint256"], [keccak256(initializer), saltNonce]));
  return getContractAddress({
    opcode: "CREATE2",
    from: low(a.proxyFactory),
    salt,
    bytecodeHash: SAFE_PROXY_INIT_CODE_HASH,
  });
}

/** executeAllowanceTransfer(pot, token, to, amountUnits, zero, 0, agentWallet, 0x): an EMPTY
 *  signature, always. The agent's key sends it to the AllowanceModule itself, and the module takes
 *  the sender as the signer; no payment token and no payment. */
export function takeCalldata(p: {
  pot: Address;
  token: Address;
  to: Address;
  amountUnits: bigint;
  agentWallet: Address;
}): Hex {
  return encodeFunctionData({
    abi: allowanceModuleAbi,
    functionName: "executeAllowanceTransfer",
    args: [
      low(p.pot),
      low(p.token),
      low(p.to),
      p.amountUnits,
      zeroAddress,
      0n,
      low(p.agentWallet),
      "0x",
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// The reading rules
// ---------------------------------------------------------------------------------------------

const PERIOD = BigInt(POT_PERIOD_MINUTES);

/** What one block answered. `codeHash` is keccak256 of the code at the address, null for no code. */
export type PotRaw = {
  codeHash: Hex | null;
  singleton: Address;
  owners: readonly Address[];
  threshold: bigint;
  modules: { list: readonly Address[]; next: Address };
  guard: Address;
  fallbackHandler: Address;
  delegates: { list: readonly Address[]; next: number };
  tokens: readonly Address[];
  /** getTokenAllowance: amount, spent, resetTimeMin, lastResetMin, nonce. */
  allowance: readonly [bigint, bigint, bigint, bigint, bigint];
  /** The token's allowance(pot, agentWallet): an ERC-20 approval from the pot to the agent's key. */
  usdcAllowanceToAgent: bigint;
  /** The token's balanceOf(pot). */
  balanceUnits: bigint;
  /** The native balance of the pot. */
  balanceWei: bigint;
  /** The native balance of the agent's wallet: its fee money. */
  agentBalanceWei: bigint;
  /** The agent's wallet holds code (a contract or a delegated key). */
  agentHasCode: boolean;
};

/** Why a pot of the guardian's alone has limits that were not read. */
export type PotLimitsProblem =
  | "other_module"
  | "guard_set"
  | "other_handler"
  | "usdc_approved"
  | "other_delegate"
  | "other_token"
  | "other_period";

/**
 * absent: no code at the address. not_the_guardians: code that is not a pot of the guardian's
 * alone; nothing is said of it. stopped: "The agent's key cannot take from it: its allowance is
 * switched off." (never more than that: no read can prove that no key at all can move the pot's
 * money). limits_not_read: a pot of the guardian's alone with something the rules do not read
 * past. ceiling_read: the agent's key may take up to `ceilingUnits` in each thirty-day period;
 * `spentUnits` were taken in the current one, which ends at `periodEndsAt` (unix seconds).
 */
export type PotReading =
  | { state: "absent" }
  | { state: "not_the_guardians" }
  | { state: "stopped"; why: "module_off" | "no_delegate"; balanceUnits: bigint }
  | { state: "limits_not_read"; problem: PotLimitsProblem; balanceUnits: bigint }
  | {
      state: "ceiling_read";
      ceilingUnits: bigint;
      spentUnits: bigint;
      periodEndsAt: number;
      nonce: bigint;
      balanceUnits: bigint;
    };

/** A real list holding nothing: anything that is not an array is never empty. */
const isEmptyList = (list: unknown): boolean => Array.isArray(list) && list.length === 0;

/** A real list holding exactly `one`, in any letter case. */
const isExactly = (list: unknown, one: Address): boolean =>
  Array.isArray(list) && list.length === 1 && sameAddress(list[0], one);

/** Hex compared in lower case; anything that is not a string is never equal. */
const sameHex = (a: unknown, b: Hex): boolean =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * What a pot's raw facts let the record say. The rules, in this order, the first that applies
 * decides (the website's copy in `safePotRules.ts` is the same list, word for word):
 *
 *  1. `codeHash` null: `absent`.
 *  2. `codeHash` is not `SAFE_PROXY_RUNTIME_CODE_HASH`, or `singleton` is not
 *     `addresses.safeSingleton`, or `owners` is not exactly `[guardian]`, or `threshold` is not 1:
 *     `not_the_guardians`.
 *  3. `modules.list` is neither empty nor exactly `[addresses.allowanceModule]`, or `modules.next`
 *     is not the sentinel: `other_module` (another add-on alone counts here, never as "stopped":
 *     it could move the money).
 *  4. `guard` is not the zero address: `guard_set`.
 *  5. `fallbackHandler` is not `addresses.fallbackHandler`: `other_handler`.
 *  6. `usdcAllowanceToAgent` is not 0: `usdc_approved`.
 *  7. `modules.list` is empty: `stopped`, `why: "module_off"`.
 *  8. `delegates.list` is empty and `delegates.next` is 0: `stopped`, `why: "no_delegate"`.
 *  9. `delegates.list` is not exactly `[agentWallet]`, or `delegates.next` is not 0, or
 *     `agentWallet` is the guardian: `other_delegate` (the guardian's key, as the Safe's only
 *     owner, can take everything: no ceiling is read for it).
 * 10. `tokens` is not exactly `[addresses.usdc]`: `other_token` (this closes an allowance on the
 *     native coin, token zero).
 * 11. `allowance[2]` is not 43200: `other_period`.
 * 12. Any of the five fields of `allowance` (amount, spent, resetTimeMin, lastResetMin, nonce) is
 *     not a bigint: `other_period` (the allowance was not read as five numbers; a resetTimeMin of
 *     another kind has already broken rule 11). Otherwise `ceiling_read`:
 *     `ceilingUnits = allowance[0]`, `spentUnits = allowance[1]`,
 *     `periodEndsAt = Number((allowance[3] + 43200) * 60)` in unix seconds,
 *     `nonce = allowance[4]`.
 *
 * The module's own answers are never enough: after `disableModule` it still returns the delegate
 * and a live-looking allowance, and after `removeDelegate` it still lists the token (both seen in
 * the proof). Rules 3 and 7 come before the module's answers are read for that reason. "Stopped"
 * is reached only after rules 3 to 6, so "The agent's key cannot take from it: its allowance is
 * switched off." is said only when no other add-on, guard, handler or approval was found.
 *
 * Every rule asks for the expected fact and nothing else: a value of another kind (a number where
 * a bigint belongs, a string where a list belongs) breaks the rule it is read by, and only a pot
 * that passes rules 1 to 12 reads a ceiling. The rules are sound only for an address noted as the
 * one its birth details predict: its initializer fixes how the Safe was set up.
 */
export function potReading(
  raw: PotRaw,
  expect: { addresses: PotAddresses; guardian: Address; agentWallet: Address },
): PotReading {
  const a = expect.addresses;
  // 1.
  if (raw.codeHash === null) return { state: "absent" };
  // 2.
  if (
    !sameHex(raw.codeHash, SAFE_PROXY_RUNTIME_CODE_HASH) ||
    !sameAddress(raw.singleton, a.safeSingleton) ||
    !isExactly(raw.owners, expect.guardian) ||
    raw.threshold !== 1n
  )
    return { state: "not_the_guardians" };

  const balanceUnits = raw.balanceUnits;
  const notRead = (problem: PotLimitsProblem): PotReading => ({
    state: "limits_not_read",
    problem,
    balanceUnits,
  });
  // 3.
  const moduleOff = isEmptyList(raw.modules.list);
  if (
    !(moduleOff || isExactly(raw.modules.list, a.allowanceModule)) ||
    !sameAddress(raw.modules.next, SAFE_SENTINEL)
  )
    return notRead("other_module");
  // 4.
  if (!sameAddress(raw.guard, zeroAddress)) return notRead("guard_set");
  // 5.
  if (!sameAddress(raw.fallbackHandler, a.fallbackHandler)) return notRead("other_handler");
  // 6.
  if (raw.usdcAllowanceToAgent !== 0n) return notRead("usdc_approved");
  // 7.
  if (moduleOff) return { state: "stopped", why: "module_off", balanceUnits };
  // 8.
  if (isEmptyList(raw.delegates.list) && raw.delegates.next === 0)
    return { state: "stopped", why: "no_delegate", balanceUnits };
  // 9.
  if (
    !isExactly(raw.delegates.list, expect.agentWallet) ||
    raw.delegates.next !== 0 ||
    sameAddress(expect.agentWallet, expect.guardian)
  )
    return notRead("other_delegate");
  // 10.
  if (!isExactly(raw.tokens, a.usdc)) return notRead("other_token");
  // 11.
  const [amount, spent, resetTimeMin, lastResetMin, nonce] = raw.allowance;
  if (resetTimeMin !== PERIOD) return notRead("other_period");
  // 12.
  if (
    typeof amount !== "bigint" ||
    typeof spent !== "bigint" ||
    typeof resetTimeMin !== "bigint" ||
    typeof lastResetMin !== "bigint" ||
    typeof nonce !== "bigint"
  )
    return notRead("other_period");
  return {
    state: "ceiling_read",
    ceilingUnits: amount,
    spentUnits: spent,
    periodEndsAt: Number((lastResetMin + PERIOD) * 60n),
    nonce,
    balanceUnits,
  };
}

// ---------------------------------------------------------------------------------------------
// The ceiling's cap from a grant
// ---------------------------------------------------------------------------------------------

/** One of the grant's three spending kinds, as a grant holds it: an amount per act and one per
 *  thirty days, in whole US dollars (one USDC counts as one US dollar). */
export type GrantSpend =
  | { allowed: false }
  | { allowed: true; perAct: number; per30Days: number; above: string };

export type PotCeilingCap =
  /** No grant: the guardian sets the ceiling, up to POT_CEILING_MAX_USDC. */
  | { kind: "none" }
  /** A grant that allows none of the three kinds. */
  | { kind: "no_spending" }
  | { kind: "capped"; maxUsdc: number; endsOn: string | null };

/** A value that is an object and not null. */
const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

/** What one kind adds to the cap: its thirty-day amount when it is allowed, else nothing. A
 *  setting that is not exactly `allowed: true` with a whole `per30Days` from 1 to GRANT_AMOUNT_MAX
 *  (every grant is checked so when it is built; anything else could only be a broken value) adds
 *  nothing: a broken setting may lower the cap, never raise it. */
function per30DaysOf(setting: GrantSpend): number {
  if (!isObject(setting) || setting.allowed !== true) return 0;
  const amount: unknown = setting.per30Days;
  return typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount >= 1 &&
    amount <= GRANT_AMOUNT_MAX
    ? amount
    : 0;
}

/**
 * The sum of `per30Days` of buy, pay and engageContractor where allowed: the most the ceiling may
 * be. No grant is `none`, and so is a grant without its `choices` or its `acts` (a broken value):
 * never a throw. A grant whose three kinds add nothing is `no_spending`; otherwise `capped`, with
 * the grant's last day (`endsOn`, or null: until revoked). Three kinds at the grant's largest
 * amount add up to POT_CEILING_MAX_USDC, so a cap is never above the ceiling's own maximum.
 */
export function potCeilingCapFromGrant(
  grant: {
    choices: {
      acts: { buy: GrantSpend; pay: GrantSpend; engageContractor: GrantSpend };
      endsOn: string | null;
    };
  } | null,
): PotCeilingCap {
  if (!isObject(grant) || !isObject(grant.choices) || !isObject(grant.choices.acts))
    return { kind: "none" };
  const { acts, endsOn } = grant.choices;
  const maxUsdc =
    per30DaysOf(acts.buy) + per30DaysOf(acts.pay) + per30DaysOf(acts.engageContractor);
  if (maxUsdc === 0) return { kind: "no_spending" };
  return { kind: "capped", maxUsdc, endsOn };
}
