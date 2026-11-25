/**
 * The company's pot, as bytes: the addresses, the pinned ABI fragments, the amount helpers, and
 * every transaction the website builds for it, each a pure function.
 *
 * The pot is a Safe v1.4.1 whose only owner is the guardian, with Safe's AllowanceModule v0.1.1
 * letting the agent's own key take USDC up to a ceiling in each fixed thirty-day period. No
 * contract of ours. The guardian creates it in one transaction to Multicall3 (create, then the
 * money for the pot and the fee money for the agent's key, each left out when 0), and later
 * changes the ceiling, stops it, takes the money back or starts it again, each by one
 * `execTransaction` the guardian sends itself.
 *
 * Every encoding here is lifted from the script that ran on Arc testnet on 24 Nov, and each is
 * pinned in the tests to the bytes it produced (V1 to V15 of the plan). Nothing here reads a chain
 * or a wallet and nothing here holds a key: what the chain says comes in as values. Addresses are
 * taken in any letter case; inside the bytes they are written in lower case, and an address handed
 * back is checksummed.
 */
import {
  concat,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  size,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "@/lib/api/types";
import { sameAddress } from "./flow";

// ---------------------------------------------------------------------------------------------
// Amounts, limits and pinned values
// ---------------------------------------------------------------------------------------------

/** The pot's period: thirty days in minutes, the module's `resetTimeMin`. The periods are fixed:
 *  each starts where the last one ended, counted from the minute the ceiling was first set. */
export const POT_PERIOD_MINUTES = 43200;
/** Units in 1 USDC: the ERC-20 face of Arc's native balance has 6 decimals. */
export const USDC_UNIT = BigInt(1_000_000);
/** Native wei in one unit: the native coin has 18 decimals, the ERC-20 face 6. */
export const WEI_PER_UNIT = BigInt(1_000_000_000_000);
/** The largest ceiling a guardian may type, in whole USDC. */
export const POT_CEILING_MAX_USDC = 3_000_000_000;
/** The most a guardian may put in the pot in one transaction: 1,000,000,000 USDC, in units. */
export const POT_FUND_MAX_UNITS = BigInt(1_000_000_000) * USDC_UNIT;
/** The most fee money the setup may send to the agent's key: 1 USDC, in units. */
export const POT_AGENT_GAS_MAX_UNITS = USDC_UNIT;
/** The fee money the setup offers to send to the agent's key, as a person reads it. */
export const POT_AGENT_GAS_DEFAULT = "0.1";
/** The gas limit no setup goes above (the real run used 493,959). */
export const POT_SETUP_GAS_CAP = BigInt(1_500_000);
/** The gas limit no `execTransaction` of the guardian goes above (the real stop used 118,984). */
export const POT_EXEC_GAS_CAP = BigInt(500_000);
/** The gas limit no USDC transfer goes above (estimated from the guardian at 49,338). */
export const POT_TRANSFER_GAS_CAP = BigInt(120_000);
/** The fixed gas limit of the agent's take (the real run's first take used 112,615). */
export const POT_TAKE_GAS = 200_000;
/** The agent key's low fee-money mark: one take's gas limit at 50 gwei, twice today's fee.
 *  0.01 USDC, in native wei. */
export const POT_FEE_LOW_WEI = BigInt("10000000000000000");

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
// The addresses
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
   *  feature is silently left off. It also refuses a delegatecall inside the batch. */
  multiSendCallOnly: Address;
  /** AllowanceModule v0.1.1. */
  allowanceModule: Address;
  /** Multicall3, which runs the setup's calls in one transaction of the guardian. */
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

/** Why the setup could not be built: another singleton (the factory would create the Safe at
 *  another address than the one predicted, and the money would go to the predicted one), another
 *  proxy factory (the same), or an amount below 0. */
export type PotBuildProblem = "other_singleton" | "other_proxy_factory" | "negative_amount";

/** Thrown by the setup's builders on what no screen should hand them: a bug to fix, never a
 *  sentence to show. The allowlist refuses each case before it calls them. */
export class PotBuildError extends Error {
  readonly problem: PotBuildProblem;
  constructor(problem: PotBuildProblem) {
    super(`The pot's setup cannot be built: ${problem}.`);
    this.name = "PotBuildError";
    this.problem = problem;
  }
}

/** The pot's address is predicted from the pinned init code hash, which holds the pinned
 *  singleton, and from the pinned factory: with any other, the prediction would be wrong. */
function assertPinnedSafe(a: PotAddresses): void {
  if (!sameAddress(a.safeSingleton, ARC_POT_ADDRESSES.safeSingleton))
    throw new PotBuildError("other_singleton");
  if (!sameAddress(a.proxyFactory, ARC_POT_ADDRESSES.proxyFactory))
    throw new PotBuildError("other_proxy_factory");
}

// ---------------------------------------------------------------------------------------------
// Pinned ABI fragments: only the members named, with the signatures of the proven script
// ---------------------------------------------------------------------------------------------

/** Multicall3: `aggregate3Value`, the setup's one transaction. */
export const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3Value",
    inputs: [
      {
        type: "tuple[]",
        name: "calls",
        components: [
          { type: "address", name: "target" },
          { type: "bool", name: "allowFailure" },
          { type: "uint256", name: "value" },
          { type: "bytes", name: "callData" },
        ],
      },
    ],
    outputs: [
      {
        type: "tuple[]",
        name: "returnData",
        components: [
          { type: "bool", name: "success" },
          { type: "bytes", name: "returnData" },
        ],
      },
    ],
    stateMutability: "payable",
  },
] as const;

/** SafeProxyFactory v1.4.1: `createProxyWithNonce`, which creates the pot. */
export const safeProxyFactoryAbi = [
  {
    type: "function",
    name: "createProxyWithNonce",
    inputs: [
      { type: "address", name: "_singleton" },
      { type: "bytes", name: "initializer" },
      { type: "uint256", name: "saltNonce" },
    ],
    outputs: [{ type: "address", name: "proxy" }],
    stateMutability: "nonpayable",
  },
] as const;

/** Safe v1.4.1: the setup, the guardian's one door (`execTransaction`), the module pair a batch
 *  calls on the Safe itself, and the reads of the pot's public record. */
export const safeAbi = [
  {
    type: "function",
    name: "setup",
    inputs: [
      { type: "address[]", name: "_owners" },
      { type: "uint256", name: "_threshold" },
      { type: "address", name: "to" },
      { type: "bytes", name: "data" },
      { type: "address", name: "fallbackHandler" },
      { type: "address", name: "paymentToken" },
      { type: "uint256", name: "payment" },
      { type: "address", name: "paymentReceiver" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execTransaction",
    inputs: [
      { type: "address", name: "to" },
      { type: "uint256", name: "value" },
      { type: "bytes", name: "data" },
      { type: "uint8", name: "operation" },
      { type: "uint256", name: "safeTxGas" },
      { type: "uint256", name: "baseGas" },
      { type: "uint256", name: "gasPrice" },
      { type: "address", name: "gasToken" },
      { type: "address", name: "refundReceiver" },
      { type: "bytes", name: "signatures" },
    ],
    outputs: [{ type: "bool" }],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "enableModule",
    inputs: [{ type: "address", name: "module" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "disableModule",
    inputs: [
      { type: "address", name: "prevModule" },
      { type: "address", name: "module" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getOwners",
    inputs: [],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getThreshold",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    // `next` is the sentinel when the page holds the end of the list.
    type: "function",
    name: "getModulesPaginated",
    inputs: [
      { type: "address", name: "start" },
      { type: "uint256", name: "pageSize" },
    ],
    outputs: [
      { type: "address[]", name: "array" },
      { type: "address", name: "next" },
    ],
    stateMutability: "view",
  },
  {
    // Reads `length` words from slot `offset`: the guard and the fallback handler slots.
    type: "function",
    name: "getStorageAt",
    inputs: [
      { type: "uint256", name: "offset" },
      { type: "uint256", name: "length" },
    ],
    outputs: [{ type: "bytes" }],
    stateMutability: "view",
  },
  {
    // Answered by the proxy itself: the singleton it runs.
    type: "function",
    name: "masterCopy",
    inputs: [],
    outputs: [{ type: "address" }],
    stateMutability: "view",
  },
] as const;

/** MultiSendCallOnly v1.5.0: `multiSend`, reached by the setup and by a delegatecall of the Safe. */
export const multiSendAbi = [
  {
    type: "function",
    name: "multiSend",
    inputs: [{ type: "bytes", name: "transactions" }],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

/** AllowanceModule v0.1.1: the guardian's three writes, the agent's take, and the three reads. */
export const allowanceModuleAbi = [
  {
    type: "function",
    name: "addDelegate",
    inputs: [{ type: "address", name: "delegate" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "removeDelegate",
    inputs: [
      { type: "address", name: "delegate" },
      { type: "bool", name: "removeAllowances" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setAllowance",
    inputs: [
      { type: "address", name: "delegate" },
      { type: "address", name: "token" },
      { type: "uint96", name: "allowanceAmount" },
      { type: "uint16", name: "resetTimeMin" },
      { type: "uint32", name: "resetBaseMin" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // Sent by the agent's key itself with an empty signature: the module takes `msg.sender` as
    // the signer.
    type: "function",
    name: "executeAllowanceTransfer",
    inputs: [
      { type: "address", name: "safe" },
      { type: "address", name: "token" },
      { type: "address", name: "to" },
      { type: "uint96", name: "amount" },
      { type: "address", name: "paymentToken" },
      { type: "uint96", name: "payment" },
      { type: "address", name: "delegate" },
      { type: "bytes", name: "signature" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // `next` is 0 when there are no more.
    type: "function",
    name: "getDelegates",
    inputs: [
      { type: "address", name: "safe" },
      { type: "uint48", name: "start" },
      { type: "uint8", name: "pageSize" },
    ],
    outputs: [
      { type: "address[]", name: "results" },
      { type: "uint48", name: "next" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getTokens",
    inputs: [
      { type: "address", name: "safe" },
      { type: "address", name: "delegate" },
    ],
    outputs: [{ type: "address[]" }],
    stateMutability: "view",
  },
  {
    // amount, spent, resetTimeMin, lastResetMin, nonce: the period already moved on in the view.
    type: "function",
    name: "getTokenAllowance",
    inputs: [
      { type: "address", name: "safe" },
      { type: "address", name: "delegate" },
      { type: "address", name: "token" },
    ],
    outputs: [{ type: "uint256[5]" }],
    stateMutability: "view",
  },
] as const;

/** ERC-20, for Arc's USDC: the balance, the allowance, and `transfer`. */
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { type: "address", name: "_owner" },
      { type: "address", name: "_spender" },
    ],
    outputs: [{ type: "uint256", name: "remaining" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      { type: "address", name: "_to" },
      { type: "uint256", name: "_value" },
    ],
    outputs: [{ type: "bool", name: "success" }],
    stateMutability: "nonpayable",
  },
] as const;

// ---------------------------------------------------------------------------------------------
// The amounts a person types
// ---------------------------------------------------------------------------------------------

const DIGITS = /^[0-9]+$/;
/** Digits, then at most one dot and digits after it; either side may be empty, not both. */
const AMOUNT = /^([0-9]*)(?:\.([0-9]*))?$/;
const USDC_DECIMALS = 6;

export type CeilingProblem = "empty" | "not_whole" | "zero" | "too_large";

/**
 * A whole number of USDC, digits only, 1 to POT_CEILING_MAX_USDC: returned in UNITS. Refuses and
 * never cleans: a space, a sign, a dot, a comma or an exponent is `not_whole`. The rules run in
 * this order: empty, not whole, zero, too large.
 */
export function parseCeilingUsdc(raw: string): bigint | { problem: CeilingProblem } {
  if (raw === "") return { problem: "empty" };
  if (!DIGITS.test(raw)) return { problem: "not_whole" };
  const whole = BigInt(raw);
  if (whole === BigInt(0)) return { problem: "zero" };
  if (whole > BigInt(POT_CEILING_MAX_USDC)) return { problem: "too_large" };
  return whole * USDC_UNIT;
}

export type AmountProblem = "not_amount" | "too_precise" | "too_large";

/**
 * "" is 0. Digits, at most one dot, at most 6 decimals, at most `maxUnits`: returned in UNITS.
 * ".5" and "5." are amounts; "." alone is not. Refuses and never cleans: a space, a sign, a comma
 * or an exponent is `not_amount`, and a seventh decimal is `too_precise` even when it is a zero.
 */
export function parseUsdcAmount(
  raw: string,
  maxUnits: bigint,
): bigint | { problem: AmountProblem } {
  if (raw === "") return BigInt(0);
  const m = AMOUNT.exec(raw);
  if (m === null) return { problem: "not_amount" };
  const whole = m[1];
  const fraction = m[2] ?? "";
  if (whole === "" && fraction === "") return { problem: "not_amount" };
  if (fraction.length > USDC_DECIMALS) return { problem: "too_precise" };
  const units =
    BigInt(whole === "" ? "0" : whole) * USDC_UNIT +
    BigInt(fraction.padEnd(USDC_DECIMALS, "0"));
  if (units > maxUnits) return { problem: "too_large" };
  return units;
}

/** Units of the ERC-20 face as native wei: the same money, 12 more decimals. */
export function unitsToWei(units: bigint): bigint {
  return units * WEI_PER_UNIT;
}

/** Units as an amount of USDC, with no trailing zeros: "5.1", "2", "0.000001". */
export function formatUsdcUnits(units: bigint): string {
  return formatUnits(units, USDC_DECIMALS);
}

// ---------------------------------------------------------------------------------------------
// The encodings
// ---------------------------------------------------------------------------------------------

/** An address or bytes as written inside the encodings: lower case. viem takes an address in lower
 *  case without a checksum, so any letter case gives the same bytes. */
const low = <T extends Hex>(x: T): T => x.toLowerCase() as T;
/** An address handed back: checksummed, whatever case it came in. */
const checksummed = (a: Address): Address => getAddress(low(a));

const ZERO = BigInt(0);
const CALL = 0;
const DELEGATECALL = 1;

/** What the pot is set to: the guardian (the Safe's only owner), the agent's own key (the
 *  module's delegate), the token, the ceiling in units, and the period in minutes. */
export type PotSetup = {
  guardian: Address;
  agentWallet: Address;
  token: Address;
  ceilingUnits: bigint;
  periodMinutes: number;
};

/** One call of a MultiSendCallOnly batch: operation 0, packed as uint8, address, uint256, uint256
 *  length, bytes. Always operation 0: MultiSendCallOnly refuses a delegatecall in the batch. */
export function multiSendPart(to: Address, value: bigint, data: Hex): Hex {
  return encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [CALL, low(to), value, BigInt(size(data)), low(data)],
  );
}

/** `multiSend(parts...)`, the parts packed one after the other. */
const multiSendData = (parts: readonly Hex[]): Hex =>
  encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [concat(parts)] });

/** `enableModule(module)` sent to the zero address: MultiSendCallOnly v1.5.0 sends it to the Safe
 *  itself. Never to the Safe's own address, which the setup cannot know: that address is derived
 *  from these very bytes. */
const enableModulePart = (a: PotAddresses): Hex =>
  multiSendPart(
    zeroAddress,
    ZERO,
    encodeFunctionData({
      abi: safeAbi,
      functionName: "enableModule",
      args: [low(a.allowanceModule)],
    }),
  );

const addDelegatePart = (a: PotAddresses, delegate: Address): Hex =>
  multiSendPart(
    a.allowanceModule,
    ZERO,
    encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "addDelegate",
      args: [low(delegate)],
    }),
  );

/** `removeDelegate(delegate, true)`: the delegate and its allowances go together. */
const removeDelegatePart = (a: PotAddresses, delegate: Address): Hex =>
  multiSendPart(
    a.allowanceModule,
    ZERO,
    encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "removeDelegate",
      args: [low(delegate), true],
    }),
  );

/** `setAllowance(agent, token, ceiling, period, 0)`. With a reset base of 0, the module's source
 *  starts the first period at the minute the call is mined when the delegate has no period yet (a
 *  new pot, or a key added again after `removeDelegate(d, true)`), and otherwise keeps the current
 *  period's start and what was spent in it. */
const setAllowanceData = (p: PotSetup): Hex =>
  encodeFunctionData({
    abi: allowanceModuleAbi,
    functionName: "setAllowance",
    args: [low(p.agentWallet), low(p.token), p.ceilingUnits, p.periodMinutes, 0],
  });

const setAllowancePart = (a: PotAddresses, p: PotSetup): Hex =>
  multiSendPart(a.allowanceModule, ZERO, setAllowanceData(p));

/** Safe's "approved by the sender" signature: 32 bytes of the owner, 32 zero bytes, 0x01. Valid
 *  only in a transaction the owner sends itself, so the guardian signs no separate message. */
export function ownerApprovalSignature(owner: Address): Hex {
  return concat([pad(low(owner), { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
}

/** The ten arguments of execTransaction, with safeTxGas, baseGas, gasPrice 0 and gasToken,
 *  refundReceiver zero: the guardian pays its own fee and the Safe pays no one. */
export type SafeExecArgs = readonly [
  Address,
  bigint,
  Hex,
  0 | 1,
  bigint,
  bigint,
  bigint,
  Address,
  Address,
  Hex,
];

/** The arguments the guardian sends for one call (or one delegatecall) from the pot. */
const execArgs = (
  guardian: Address,
  to: Address,
  value: bigint,
  data: Hex,
  operation: 0 | 1,
): SafeExecArgs => [
  checksummed(to),
  value,
  data,
  operation,
  ZERO,
  ZERO,
  ZERO,
  zeroAddress,
  zeroAddress,
  ownerApprovalSignature(guardian),
];

/**
 * Safe.setup([guardian], 1, multiSendCallOnly, multiSend(enableModule to the zero address,
 * addDelegate(agent), setAllowance(agent, token, ceiling, period, 0)), fallbackHandler, 0, 0, 0).
 * The guardian is the only owner, one signature of the guardian's is enough, and no one is paid
 * for the creation.
 */
export function potInitializer(a: PotAddresses, p: PotSetup): Hex {
  const batch = multiSendData([
    enableModulePart(a),
    addDelegatePart(a, p.agentWallet),
    setAllowancePart(a, p),
  ]);
  return encodeFunctionData({
    abi: safeAbi,
    functionName: "setup",
    args: [
      [low(p.guardian)],
      BigInt(1),
      low(a.multiSendCallOnly),
      batch,
      low(a.fallbackHandler),
      zeroAddress,
      ZERO,
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

/** One call of Multicall3's `aggregate3Value`; any call that fails makes the whole setup fail. */
export type Call3Value = { target: Address; allowFailure: false; value: bigint; callData: Hex };

/** Call 1 creates the Safe; call 2 sends `fundWei` to the predicted address, left out when 0;
 *  call 3 sends `agentGasWei` to the agent's wallet, left out when 0. `value` is their sum: the
 *  value the guardian's transaction to Multicall3 carries. Throws `PotBuildError` unless `a` names
 *  the pinned singleton and factory, and when an amount is below 0. */
export function potSetupCalls(
  a: PotAddresses,
  p: PotSetup & { saltNonce: bigint; fundWei: bigint; agentGasWei: bigint },
): { pot: Address; calls: Call3Value[]; value: bigint } {
  assertPinnedSafe(a);
  if (p.fundWei < ZERO || p.agentGasWei < ZERO) throw new PotBuildError("negative_amount");
  const initializer = potInitializer(a, p);
  const pot = predictPotAddress(a, initializer, p.saltNonce);
  const calls: Call3Value[] = [
    {
      target: checksummed(a.proxyFactory),
      allowFailure: false,
      value: ZERO,
      callData: encodeFunctionData({
        abi: safeProxyFactoryAbi,
        functionName: "createProxyWithNonce",
        args: [low(a.safeSingleton), initializer, p.saltNonce],
      }),
    },
  ];
  if (p.fundWei !== ZERO)
    calls.push({ target: pot, allowFailure: false, value: p.fundWei, callData: "0x" });
  if (p.agentGasWei !== ZERO)
    calls.push({
      target: checksummed(p.agentWallet),
      allowFailure: false,
      value: p.agentGasWei,
      callData: "0x",
    });
  return { pot, calls, value: p.fundWei + p.agentGasWei };
}

/** A plain call to the module: setAllowance(agent, token, ceiling, period, 0). The current period
 *  and what was spent in it are kept: only the ceiling (and the period's length) change. */
export function potChangeArgs(a: PotAddresses, p: PotSetup): SafeExecArgs {
  return execArgs(p.guardian, a.allowanceModule, ZERO, setAllowanceData(p), CALL);
}

/** removeDelegate(d, true) for every delegate, then disableModule(previous, module) sent to the
 *  zero address when the module is in `modules` (previous is the sentinel for the first, else the
 *  one before). No amount: the money stays in the pot until the guardian takes it back. */
export function potStopParts(
  a: PotAddresses,
  p: { delegates: readonly Address[]; modules: readonly Address[] },
): Hex[] {
  const parts = p.delegates.map((d) => removeDelegatePart(a, d));
  const i = p.modules.findIndex((m) => sameAddress(m, a.allowanceModule));
  if (i >= 0) {
    const previous = i === 0 ? SAFE_SENTINEL : p.modules[i - 1];
    parts.push(
      multiSendPart(
        zeroAddress,
        ZERO,
        encodeFunctionData({
          abi: safeAbi,
          functionName: "disableModule",
          args: [low(previous), low(a.allowanceModule)],
        }),
      ),
    );
  }
  return parts;
}

/** A delegatecall (operation 1) to multiSendCallOnly with those parts; null when there are none:
 *  nothing left to stop. */
export function potStopArgs(
  a: PotAddresses,
  p: { guardian: Address; delegates: readonly Address[]; modules: readonly Address[] },
): SafeExecArgs | null {
  const parts = potStopParts(a, p);
  if (parts.length === 0) return null;
  return execArgs(p.guardian, a.multiSendCallOnly, ZERO, multiSendData(parts), DELEGATECALL);
}

/** A plain call to the guardian with the value, no data: the pot's money back to the guardian. */
export function potWithdrawArgs(p: { guardian: Address; balanceWei: bigint }): SafeExecArgs {
  return execArgs(p.guardian, p.guardian, p.balanceWei, "0x", CALL);
}

/**
 * The restore (start again, or a new key, on the same Safe), in this order: removeDelegate(d,
 * true) for EVERY listed delegate, `agentWallet` included when it is listed; enableModule(module)
 * sent to the zero address when `modules` is empty; addDelegate(agentWallet);
 * setAllowance(agentWallet, token, ceiling, period, 0). No amount. Null when `modules` is neither
 * empty nor exactly [module]: a Safe with another module is not a pot this site restores.
 *
 * Why `agentWallet` is removed too when it is listed: a pot switched off elsewhere by
 * `disableModule` alone still lists its key, with that key's allowance as it was (its period's
 * start and what was taken in it). Without the removal, `addDelegate` does nothing for a key
 * already listed, and `setAllowance` with a reset base of 0 keeps the allowance's last reset, so
 * the old period and what was taken would carry on. `removeDelegate(key, true)` sets the key's
 * amount, spent, period and last reset to 0 (its nonce is kept); the module's `setAllowance` then
 * starts the period at the minute the restore is mined, because the allowance's last reset is 0.
 * So every restore starts a new thirty-day period, with nothing taken yet. The inputs of V11, V12
 * and V13 list no such key: their bytes are unchanged.
 */
export function potRestoreParts(
  a: PotAddresses,
  p: PotSetup & { delegates: readonly Address[]; modules: readonly Address[] },
): Hex[] | null {
  const off = p.modules.length === 0;
  const ours = p.modules.length === 1 && sameAddress(p.modules[0], a.allowanceModule);
  if (!off && !ours) return null;
  const parts = p.delegates.map((d) => removeDelegatePart(a, d));
  if (off) parts.push(enableModulePart(a));
  parts.push(addDelegatePart(a, p.agentWallet), setAllowancePart(a, p));
  return parts;
}

/** A delegatecall (operation 1) to multiSendCallOnly with those parts, signed by `p.guardian`;
 *  null when the parts are. */
export function potRestoreArgs(
  a: PotAddresses,
  p: PotSetup & { delegates: readonly Address[]; modules: readonly Address[] },
): SafeExecArgs | null {
  const parts = potRestoreParts(a, p);
  if (parts === null) return null;
  return execArgs(p.guardian, a.multiSendCallOnly, ZERO, multiSendData(parts), DELEGATECALL);
}
