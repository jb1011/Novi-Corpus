/**
 * The legal-body flow's chain layer: the pinned ABI fragments, the pointer encoder, the one
 * allowlist every wallet write request passes, the door that sends it, and the mint parse.
 *
 * Pin and assert, then send: nothing reaches a wallet unless it is one of the seven calls below.
 * Four are on the identity registry, built for the selected order or, for the agent's wallet, the
 * selected identity, on the chain and registry that `/config` names: never an approval, a transfer
 * or a value. Three are the company's pot, sent from the order's guardian's own account, each with
 * what it may move and to whom:
 * - its setup, one transaction to Multicall3 that creates the pot and may carry money to two
 *   places only, the pot it creates (at most 1,000,000,000 USDC) and the agent's own key (at most
 *   1 USDC, and only to a plain key);
 * - the guardian's `execTransaction` on the noted pot, which carries no value and changes the
 *   ceiling, stops the allowance, takes the pot's money back to the guardian, or starts it again;
 * - a USDC `transfer` with no value: "Add money" to the noted pot (at most 1,000,000,000 USDC), or
 *   "Send fee money" to the agent's own key, a plain key (at most 1 USDC).
 * Money goes to the guardian's own pot, to the agent's own key, or back to the guardian: nothing
 * goes to Novi Corpus, which holds no key and no money. A pot call is rebuilt from the
 * allowlist's own context and sent only when the request equals the rebuild. Each request is read
 * once, and what cannot be read is refused, never thrown. The registry's addresses come from the
 * API (`/config.legalBodies`, the order), never from this bundle; the pot's contracts are pinned
 * per chain in `safePot.ts`, and the pot's own address is the one the server noted for the order.
 */
import { encodeAbiParameters, encodeFunctionData, formatUnits, getAddress } from "viem";
import type { Address, Hex, LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import { sameAddress } from "./flow";
import {
  erc20Abi,
  multicall3Abi,
  POT_AGENT_GAS_MAX_UNITS,
  POT_CEILING_MAX_USDC,
  POT_EXEC_GAS_CAP,
  POT_FUND_MAX_UNITS,
  POT_PERIOD_MINUTES,
  POT_SETUP_GAS_CAP,
  POT_TRANSFER_GAS_CAP,
  potAddresses,
  potChangeArgs,
  potRestoreArgs,
  potSetupCalls,
  potStopArgs,
  potWithdrawArgs,
  safeAbi,
  USDC_UNIT,
  WEI_PER_UNIT,
  type Call3Value,
  type PotAddresses,
  type PotSetup,
  type SafeExecArgs,
} from "./safePot";

// ---------------------------------------------------------------------------------------------
// Pinned ABI fragments
// ---------------------------------------------------------------------------------------------

/** The ERC-8004 identity registry: the two `register` overloads, the metadata pair,
 *  `setAgentWallet` and the EIP-712 domain its message is signed in, the reads, and the ERC-721
 *  `Transfer` a mint emits. The only writes are the four the allowlist names. */
export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    inputs: [],
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "register",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setMetadata",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
      { name: "value", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // Sent by the identity's owner, with the new wallet's signature over `AgentWalletSet`.
    type: "function",
    name: "setAgentWallet",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    // ERC-5267: the domain `AgentWalletSet` is signed in, read live.
    type: "function",
    name: "eip712Domain",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getMetadata",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "key", type: "string" },
    ],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
  {
    // Reverts for an id that was never minted: read the revert as "no identity with this id".
    type: "function",
    name: "ownerOf",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAgentWallet",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
    anonymous: false,
  },
] as const;

/** The legal-body factory: the three reads the pointer step needs. */
export const legalBodyFactoryAbi = [
  {
    type: "function",
    name: "encodePointer",
    inputs: [{ name: "legalBody", type: "address" }],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "linkedLegalBody",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "identityOwnerAtCreation",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

/** keccak256("Transfer(address,address,uint256)"). */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;
/** The metadata key the factory reads the pointer under. */
export const POINTER_KEY = "legalBody";
/** The pointer format the factory writes and reads. */
export const POINTER_VERSION = 1;
/** Arc's native unit (USDC as gas) has 18 decimals on chain. */
export const NATIVE_DECIMALS = 18;

// ---------------------------------------------------------------------------------------------
// The pointer
// ---------------------------------------------------------------------------------------------

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ZERO_WORD = /^0x0{64}$/;
/** An address in a 32-byte topic: twelve zero bytes, then the twenty of the address. */
const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;
/** A uint256 as the API serves it: decimal, no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const ZERO_ADDRESS = /^0x0{40}$/;
/** Bytes as hex: `0x` and whole bytes, at least one. */
const WHOLE_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;
/** The registry's limit: the deadline at most 300 seconds after the chain's time. */
const MAX_WALLET_SET_DELAY_SECONDS = 300;
/** The longest signature the allowlist forwards, far above a key's 65 bytes or a contract
 *  wallet's usual few hundred. */
const MAX_SIGNATURE_BYTES = 2048;
/** The largest uint256, 2^256 - 1: 78 decimal digits can write more, and the encoder throws on it. */
const MAX_UINT256 = BigInt(`0x${"f".repeat(64)}`);

/** `abi.encode(uint8 1, uint256 chainId, address body)`: exactly 96 bytes. The body's casing
 *  does not matter: addresses are compared in lower case everywhere in this flow. */
export function encodePointer(chainId: number, body: Address): Hex {
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "uint256" }, { type: "address" }],
    [POINTER_VERSION, BigInt(chainId), body.toLowerCase() as Address],
  );
}

/** The local encoding must equal what the factory's `encodePointer(body)` returned: a mismatch
 *  is a stop, not a send. */
export function pointerMatchesFactory(local: Hex, fromFactory: Hex): boolean {
  return local.toLowerCase() === fromFactory.toLowerCase();
}

/** A native amount in wei, as an amount of USDC, with Arc's 18 decimals. */
export function formatNative(wei: bigint): string {
  return formatUnits(wei, NATIVE_DECIMALS);
}

/** What signs for an address: a plain key (no code), a key delegated under EIP-7702 (23 bytes,
 *  `0xef0100` and the delegate's address), or a contract. */
export type WalletKind = "key" | "delegated" | "contract";

const DELEGATION = /^0xef0100[0-9a-f]{40}$/;

/** `code` as `getCode` answers it: undefined or `0x` for an address with no code. */
export function walletKindOf(code: Hex | undefined): WalletKind {
  if (code === undefined || code === "0x") return "key";
  return DELEGATION.test(code.toLowerCase()) ? "delegated" : "contract";
}

// ---------------------------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------------------------

/**
 * The only shape a wallet write request takes in this flow: the registry's three functions over
 * `identityRegistryAbi`, `aggregate3Value` over `multicall3Abi`, `execTransaction` over `safeAbi`,
 * or USDC's `transfer` over `erc20Abi`. One object type rather than one per pair: which ABI goes
 * with which name, like every other field, is the allowlist's to check at run time, since the type
 * was never proof.
 */
export type WriteRequest = {
  chainId: number;
  address: Address;
  abi: typeof identityRegistryAbi | typeof multicall3Abi | typeof safeAbi | typeof erc20Abi;
  functionName:
    | "register"
    | "setMetadata"
    | "setAgentWallet"
    | "aggregate3Value"
    | "execTransaction"
    | "transfer";
  args: readonly unknown[];
  value?: bigint;
  gas?: bigint;
};

/**
 * What the allowlist rebuilds a pot call from. It is pure and reads nothing: a screen reads these
 * in the same click. `guardian` is the order's `guardian` as the API served it; `agentWallet` is
 * the registry's `getAgentWallet` for the order's identity; `pot` is the address the server noted
 * for the order; `delegates`, `modules` and `balanceWei` are a `readPotRaw` of that pot, and
 * `agentHasCode` is its field for the agent's wallet. The setup's `agentWalletKind` is
 * `walletKindOf` of the agent wallet's `getCode` in the same click: fee money goes to a plain key
 * only, and a context that leaves the kind out (a screen that did not read that wallet's code, Ruling
 * R21) is read only when it sends no fee money. Money sent
 * as value is in native wei (18 decimals); the ceiling, and the amount of a USDC transfer, are in
 * USDC units (6): a transfer never carries wei.
 */
export type PotCallContext =
  | {
      kind: "setup";
      guardian: Address;
      agentWallet: Address;
      agentWalletKind?: WalletKind;
      ceilingUnits: bigint;
      saltNonce: bigint;
      fundWei: bigint;
      agentGasWei: bigint;
    }
  | { kind: "change"; pot: Address; guardian: Address; agentWallet: Address; ceilingUnits: bigint }
  | {
      kind: "stop";
      pot: Address;
      guardian: Address;
      delegates: readonly Address[];
      modules: readonly Address[];
    }
  | {
      kind: "withdraw";
      pot: Address;
      guardian: Address;
      modules: readonly Address[];
      balanceWei: bigint;
    }
  | {
      kind: "restore";
      pot: Address;
      guardian: Address;
      agentWallet: Address;
      ceilingUnits: bigint;
      delegates: readonly Address[];
      modules: readonly Address[];
    }
  | { kind: "add_money"; pot: Address; guardian: Address; amountUnits: bigint }
  | {
      kind: "fee_money";
      guardian: Address;
      agentWallet: Address;
      agentHasCode: boolean;
      amountUnits: bigint;
    };

export type CallContext = {
  config: Pick<
    Extract<LegalBodyConfig, { available: true }>,
    "chainId" | "identityRegistry" | "factory"
  >;
  /** The selected order; required for the pointer and for every pot call. */
  order: LegalBodyOrderView | null;
  /** The selected identity (its id in decimal), the guardian, and the caller's reading of the
   *  chain's time in seconds (finite, 0 or more); required for the agent's wallet, which needs no
   *  order. */
  wallet?: { agentId: string; guardian: Address; nowSeconds: number };
  /** The pot's facts of the click; required for a pot call. */
  pot?: PotCallContext;
};

export type Refusal = { ok: false; problem: string };

const refuse = (problem: string): Refusal => ({ ok: false, problem });

/** The order's identity and body, when both are there and well formed. */
function bodyOf(order: LegalBodyOrderView): { agentId: bigint; body: Address } | null {
  const { agentId, bodyAddress } = order;
  if (agentId === null || bodyAddress === null) return null;
  if (!CANONICAL_DECIMAL.test(agentId) || !ADDRESS.test(bodyAddress)) return null;
  return { agentId: BigInt(agentId), body: bodyAddress };
}

/** `register()` with no URI, `register(string)` otherwise. */
export function registerCall(config: CallContext["config"], uri: string | null): WriteRequest {
  return {
    chainId: config.chainId,
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "register",
    args: uri === null ? [] : [uri],
  };
}

/** `setMetadata(agentId, "legalBody", pointer)` for the selected order's own body, on the
 *  configured registry. Whether it may be sent is `allowedCall`'s to say. */
export function pointerCall(
  config: CallContext["config"],
  order: LegalBodyOrderView,
): WriteRequest | Refusal {
  const own = bodyOf(order);
  if (own === null) return refuse("order_has_no_body");
  return {
    chainId: config.chainId,
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "setMetadata",
    args: [own.agentId, POINTER_KEY, encodePointer(order.chainId, own.body)],
  };
}

/** `setAgentWallet(agentId, newWallet, deadline, signature)` on the configured registry, for the
 *  identity `agentId` names in decimal. Whether it may be sent is `allowedCall`'s to say. */
export function agentWalletCall(
  config: CallContext["config"],
  p: { agentId: string; newWallet: Address; deadline: bigint; signature: Hex },
): WriteRequest {
  return {
    chainId: config.chainId,
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: "setAgentWallet",
    args: [BigInt(p.agentId), p.newWallet, p.deadline, p.signature],
  };
}

// ---------------------------------------------------------------------------------------------
// The pot's calls: the context as read, and the rebuild
// ---------------------------------------------------------------------------------------------

const ZERO = BigInt(0);
/** The largest ceiling, in units: POT_CEILING_MAX_USDC whole USDC. */
const MAX_CEILING_UNITS = BigInt(POT_CEILING_MAX_USDC) * USDC_UNIT;
/** The most delegates, or modules, a context may list: the first page `readPotRaw` reads. */
const MAX_POT_LIST = 10;

/** The setup's context as read: its wallet kind left out only when it sends no fee money. */
type SetupContext = Omit<Extract<PotCallContext, { kind: "setup" }>, "agentWalletKind"> & {
  agentWalletKind: WalletKind | undefined;
};
/** A list as the context held it: copied, its entries not read yet. */
type UnreadList = readonly unknown[];
/** An action's context as read: every field of its kind, the lists copied but their entries
 *  read only by the rule of the kind that encodes them. */
type ExecRead =
  | Extract<PotCallContext, { kind: "change" }>
  | { kind: "stop"; pot: Address; guardian: Address; delegates: UnreadList; modules: UnreadList }
  | { kind: "withdraw"; pot: Address; guardian: Address; modules: UnreadList; balanceWei: bigint }
  | {
      kind: "restore";
      pot: Address;
      guardian: Address;
      agentWallet: Address;
      ceilingUnits: bigint;
      delegates: UnreadList;
      modules: UnreadList;
    };

const isAddress = (x: unknown): x is Address => typeof x === "string" && ADDRESS.test(x);
const WALLET_KINDS: readonly unknown[] = ["key", "delegated", "contract"];
const isWalletKind = (x: unknown): x is WalletKind => WALLET_KINDS.includes(x);
/** A bigint of 0 or more. */
const isAmount = (x: unknown): x is bigint => typeof x === "bigint" && x >= ZERO;
/** Addresses compared without regard to letter case; what is not a string is never equal. */
const sameAddr = (a: unknown, b: Address): boolean => typeof a === "string" && sameAddress(a, b);
/** Hex compared in lower case; anything that is not a string is never equal. */
const sameHex = (a: unknown, b: Hex): boolean =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** An address handed to the wallet: checksummed from lower case (viem refuses a mixed case that is
 *  not the checksum). Only ever called on an address the rules read. */
const checksummed = (a: Address): Address => getAddress(a.toLowerCase());

/** The setup's context, read once into a copy of its own, or null when it is no setup's context:
 *  not an object, another kind, an address that is not `0x` and 40 hex digits, a number that is
 *  not a bigint of 0 or more, a wallet kind that is none of the three, or no wallet kind while fee
 *  money is sent. The rules read the copy only. */
function readSetupContext(raw: unknown): SetupContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const {
    kind,
    guardian,
    agentWallet,
    agentWalletKind,
    ceilingUnits,
    saltNonce,
    fundWei,
    agentGasWei,
  } = raw as Record<string, unknown>;
  if (
    kind !== "setup" ||
    !isAddress(guardian) ||
    !isAddress(agentWallet) ||
    !isAmount(ceilingUnits) ||
    !isAmount(saltNonce) ||
    !isAmount(fundWei) ||
    !isAmount(agentGasWei)
  )
    return null;
  // One of the three kinds; or none at all, read only when no fee money is sent.
  const walletKind = isWalletKind(agentWalletKind) ? agentWalletKind : undefined;
  if (agentWalletKind !== undefined && walletKind === undefined) return null;
  if (walletKind === undefined && agentGasWei !== ZERO) return null;
  return {
    kind: "setup",
    guardian,
    agentWallet,
    agentWalletKind: walletKind,
    ceilingUnits,
    saltNonce,
    fundWei,
    agentGasWei,
  };
}

/** An action's context, read once into a copy of its own, or null when it is no action's context:
 *  not an object, a kind other than change, stop, withdraw and restore, an address that is not `0x`
 *  and 40 hex digits, a number that is not a bigint of 0 or more (a balance also no more than a
 *  uint256: no chain holds more), or a list that is not a list. */
function readExecContext(raw: unknown): ExecRead | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, pot, guardian, agentWallet, ceilingUnits, delegates, modules, balanceWei } =
    raw as Record<string, unknown>;
  if (!isAddress(pot) || !isAddress(guardian)) return null;
  const listed = Array.isArray(delegates) ? [...(delegates as unknown[])] : null;
  const on = Array.isArray(modules) ? [...(modules as unknown[])] : null;
  if (kind === "change") {
    if (!isAddress(agentWallet) || !isAmount(ceilingUnits)) return null;
    return { kind: "change", pot, guardian, agentWallet, ceilingUnits };
  }
  if (kind === "stop") {
    if (listed === null || on === null) return null;
    return { kind: "stop", pot, guardian, delegates: listed, modules: on };
  }
  if (kind === "withdraw") {
    if (on === null || !isAmount(balanceWei) || balanceWei > MAX_UINT256) return null;
    return { kind: "withdraw", pot, guardian, modules: on, balanceWei };
  }
  if (kind === "restore") {
    if (!isAddress(agentWallet) || !isAmount(ceilingUnits) || listed === null || on === null)
      return null;
    return {
      kind: "restore",
      pot,
      guardian,
      agentWallet,
      ceilingUnits,
      delegates: listed,
      modules: on,
    };
  }
  return null;
}

type TransferContext = Extract<PotCallContext, { kind: "add_money" | "fee_money" }>;

/** A transfer's context, read once into a copy of its own, or null when it is no transfer's
 *  context: not an object, a kind other than add_money and fee_money, an address that is not `0x`
 *  and 40 hex digits, an amount that is not a bigint of 0 or more, or a code fact that is not a
 *  boolean. */
function readTransferContext(raw: unknown): TransferContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { kind, pot, guardian, agentWallet, agentHasCode, amountUnits } = raw as Record<
    string,
    unknown
  >;
  if (!isAddress(guardian) || !isAmount(amountUnits)) return null;
  if (kind === "add_money") {
    if (!isAddress(pot)) return null;
    return { kind: "add_money", pot, guardian, amountUnits };
  }
  if (kind === "fee_money") {
    if (!isAddress(agentWallet) || typeof agentHasCode !== "boolean") return null;
    return { kind: "fee_money", guardian, agentWallet, agentHasCode, amountUnits };
  }
  return null;
}

/** A list the rules may encode: at most ten entries, each an address; otherwise null. */
const addressList = (list: UnreadList): readonly Address[] | null =>
  list.length <= MAX_POT_LIST && list.every(isAddress) ? (list as readonly Address[]) : null;

/** The agent's wallet and the ceiling, for the setup, the change and the restore, in this order:
 *  never the zero address; never the guardian's own wallet; a whole number of USDC from 1 to
 *  POT_CEILING_MAX_USDC. */
function walletAndCeilingProblem(p: {
  guardian: Address;
  agentWallet: Address;
  ceilingUnits: bigint;
}): Refusal | null {
  if (ZERO_ADDRESS.test(p.agentWallet)) return refuse("wallet_is_zero");
  if (sameAddress(p.agentWallet, p.guardian)) return refuse("wallet_is_guardian");
  if (
    p.ceilingUnits % USDC_UNIT !== ZERO ||
    p.ceilingUnits < USDC_UNIT ||
    p.ceilingUnits > MAX_CEILING_UNITS
  )
    return refuse("ceiling_out_of_bounds");
  return null;
}

/** Wei that is a whole number of USDC units, and at most `maxUnits` of them. */
const wholeUnits = (wei: bigint, maxUnits: bigint): boolean =>
  wei % WEI_PER_UNIT === ZERO && wei / WEI_PER_UNIT <= maxUnits;

/** What the pot is set to: the table's USDC, and always the thirty-day period. */
const potSetupOf = (
  a: PotAddresses,
  p: { guardian: Address; agentWallet: Address; ceilingUnits: bigint },
): PotSetup => ({
  guardian: p.guardian,
  agentWallet: p.agentWallet,
  token: a.usdc,
  ceilingUnits: p.ceilingUnits,
  periodMinutes: POT_PERIOD_MINUTES,
});

/** The setup's own rules, in order, then its rebuild: the wallet and the ceiling; the pot's money
 *  in whole units, at most POT_FUND_MAX_UNITS; the fee money the same, at most
 *  POT_AGENT_GAS_MAX_UNITS, and only for a plain key (a delegated key or a contract wallet takes
 *  none); a salt nonce no larger than a uint256. Nothing reaches the encoder before every rule has
 *  passed. */
function rebuildSetup(
  a: PotAddresses,
  p: SetupContext,
): { ok: true; calls: Call3Value[]; value: bigint } | Refusal {
  const problem = walletAndCeilingProblem(p);
  if (problem !== null) return problem;
  if (!wholeUnits(p.fundWei, POT_FUND_MAX_UNITS)) return refuse("fund_out_of_bounds");
  if (!wholeUnits(p.agentGasWei, POT_AGENT_GAS_MAX_UNITS)) return refuse("agent_gas_out_of_bounds");
  if (p.agentGasWei !== ZERO && p.agentWalletKind !== "key")
    return refuse("fee_money_needs_plain_key");
  if (p.saltNonce > MAX_UINT256) return refuse("salt_out_of_bounds");
  const { calls, value } = potSetupCalls(a, {
    ...potSetupOf(a, p),
    saltNonce: p.saltNonce,
    fundWei: p.fundWei,
    agentGasWei: p.agentGasWei,
  });
  return { ok: true, calls, value };
}

/** An action's own rules, by kind, then its rebuild. change: the wallet and the ceiling. stop: at
 *  most ten delegates and modules, each an address; something to stop. withdraw: no module on;
 *  something in the pot. restore: the wallet and the ceiling; the lists as for the stop; no module
 *  but the pot's own. */
function rebuildExec(a: PotAddresses, p: ExecRead): { ok: true; args: SafeExecArgs } | Refusal {
  if (p.kind === "change") {
    const problem = walletAndCeilingProblem(p);
    if (problem !== null) return problem;
    return { ok: true, args: potChangeArgs(a, potSetupOf(a, p)) };
  }
  if (p.kind === "stop") {
    const delegates = addressList(p.delegates);
    const modules = addressList(p.modules);
    if (delegates === null || modules === null) return refuse("no_pot_context");
    const args = potStopArgs(a, { guardian: p.guardian, delegates, modules });
    return args === null ? refuse("nothing_to_stop") : { ok: true, args };
  }
  if (p.kind === "withdraw") {
    if (p.modules.length !== 0) return refuse("allowance_still_on");
    if (p.balanceWei === ZERO) return refuse("nothing_to_withdraw");
    return { ok: true, args: potWithdrawArgs({ guardian: p.guardian, balanceWei: p.balanceWei }) };
  }
  const problem = walletAndCeilingProblem(p);
  if (problem !== null) return problem;
  const delegates = addressList(p.delegates);
  const modules = addressList(p.modules);
  if (delegates === null || modules === null) return refuse("no_pot_context");
  const args = potRestoreArgs(a, { ...potSetupOf(a, p), delegates, modules });
  return args === null ? refuse("restore_other_module") : { ok: true, args };
}

/** A USDC transfer's two arguments: the payee, checksummed, and the amount in units. */
type TransferArgs = readonly [Address, bigint];

/** A transfer's own rules, by kind, then its rebuild. Add money, in this order: never to the zero
 *  address, the guardian's own wallet or any address of the pot's table (Ruling R32: the
 *  allowlist does not rely on the caller having recomputed the noted pot); 1 unit to
 *  POT_FUND_MAX_UNITS, to the noted pot. Fee money, in this order: never the zero address; never
 *  the guardian's own wallet; never a wallet with code, so only a plain key; 1 unit to
 *  POT_AGENT_GAS_MAX_UNITS; to the agent's wallet. */
function rebuildTransfer(
  a: PotAddresses,
  p: TransferContext,
): { ok: true; args: TransferArgs } | Refusal {
  if (p.kind === "add_money") {
    if (
      ZERO_ADDRESS.test(p.pot) ||
      sameAddress(p.pot, p.guardian) ||
      Object.values(a).some((known) => sameAddr(known, p.pot))
    )
      return refuse("not_the_pot");
    if (p.amountUnits === ZERO || p.amountUnits > POT_FUND_MAX_UNITS)
      return refuse("fund_out_of_bounds");
    return { ok: true, args: [checksummed(p.pot), p.amountUnits] };
  }
  if (ZERO_ADDRESS.test(p.agentWallet)) return refuse("wallet_is_zero");
  if (sameAddress(p.agentWallet, p.guardian)) return refuse("wallet_is_guardian");
  if (p.agentHasCode) return refuse("fee_money_contract_wallet");
  if (p.amountUnits === ZERO || p.amountUnits > POT_AGENT_GAS_MAX_UNITS)
    return refuse("agent_gas_out_of_bounds");
  return { ok: true, args: [checksummed(p.agentWallet), p.amountUnits] };
}

/** The setup, as the screen asks for it: `aggregate3Value` on the table's Multicall3, its value
 *  the sum of the inner amounts, and the gas given. Refused, never thrown, when the chain has no
 *  pot or the context breaks the setup's own rules; whether it may be sent is `allowedCall`'s to
 *  say. */
export function potSetupCall(
  config: CallContext["config"],
  p: Extract<PotCallContext, { kind: "setup" }>,
  gas: bigint,
): WriteRequest | Refusal {
  const a = potAddresses(config.chainId);
  if (a === null) return refuse("pot_chain_unsupported");
  const read = readSetupContext(p);
  if (read === null) return refuse("no_pot_context");
  const rebuilt = rebuildSetup(a, read);
  if (!rebuilt.ok) return rebuilt;
  return {
    chainId: config.chainId,
    address: checksummed(a.multicall3),
    abi: multicall3Abi,
    functionName: "aggregate3Value",
    args: [rebuilt.calls],
    value: rebuilt.value,
    gas,
  };
}

/** A guardian's action on the noted pot: `execTransaction` with no value, and the gas given.
 *  Refused, never thrown, when the chain has no pot or the context breaks its kind's rules; whether
 *  it may be sent is `allowedCall`'s to say. */
export function potExecCall(
  config: CallContext["config"],
  p: Extract<PotCallContext, { kind: "change" | "stop" | "withdraw" | "restore" }>,
  gas: bigint,
): WriteRequest | Refusal {
  const a = potAddresses(config.chainId);
  if (a === null) return refuse("pot_chain_unsupported");
  const read = readExecContext(p);
  if (read === null) return refuse("no_pot_context");
  const rebuilt = rebuildExec(a, read);
  if (!rebuilt.ok) return rebuilt;
  return {
    chainId: config.chainId,
    address: checksummed(read.pot),
    abi: safeAbi,
    functionName: "execTransaction",
    args: rebuilt.args,
    gas,
  };
}

/** "Add money" or "Send fee money": `transfer` on the table's USDC, with no value, and the gas
 *  given. Refused, never thrown, when the chain has no pot or the context breaks its kind's rules;
 *  whether it may be sent is `allowedCall`'s to say. */
export function potTransferCall(
  config: CallContext["config"],
  p: Extract<PotCallContext, { kind: "add_money" | "fee_money" }>,
  gas: bigint,
): WriteRequest | Refusal {
  const a = potAddresses(config.chainId);
  if (a === null) return refuse("pot_chain_unsupported");
  const read = readTransferContext(p);
  if (read === null) return refuse("no_pot_context");
  const rebuilt = rebuildTransfer(a, read);
  if (!rebuilt.ok) return rebuilt;
  return {
    chainId: config.chainId,
    address: checksummed(a.usdc),
    abi: erc20Abi,
    functionName: "transfer",
    args: rebuilt.args,
    gas,
  };
}

/** The states whose body the owner may point at: `deployed`, and `broken` because the pointer was
 *  cleared. Never a replaced or superseded body: pointing back at it breaks its replacement. And
 *  never a revoked one, which the flow does not offer either. */
function pointable(order: LegalBodyOrderView): boolean {
  if (order.revoked) return false;
  return (
    order.state === "deployed" || (order.state === "broken" && order.brokenReason === "not_linked")
  );
}

/** What the allowlist accepted: the calldata, and the arguments it was encoded from. A pot call
 *  also carries the whole request the wallet gets, rebuilt by the rules with nothing of the
 *  caller's object in it, and the account that must send it: the order's guardian. */
type Checked = {
  ok: true;
  data: Hex;
  args: readonly unknown[];
  pot?: { guardian: Address; request: WriteRequest };
};

/** The setup's calls equal to the rebuild's, field by field: the target and the call data without
 *  regard to case, `allowFailure` false, the value exactly. One list of calls, and nothing else. */
function sameCalls(args: unknown, want: readonly Call3Value[]): boolean {
  if (!Array.isArray(args) || args.length !== 1) return false;
  const calls: unknown = args[0];
  if (!Array.isArray(calls) || calls.length !== want.length) return false;
  return want.every((w, i) => {
    const call: unknown = calls[i];
    if (typeof call !== "object" || call === null) return false;
    const { target, allowFailure, value, callData } = call as Record<string, unknown>;
    return (
      sameAddr(target, w.target) &&
      allowFailure === false &&
      value === w.value &&
      sameHex(callData, w.callData)
    );
  });
}

/** Ten values equal to the rebuild's: addresses without regard to case, bytes in lower case,
 *  numbers exactly and of the same kind. */
function sameExecArgs(args: unknown, want: SafeExecArgs): boolean {
  if (!Array.isArray(args) || args.length !== want.length) return false;
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, sig] =
    args as unknown[];
  return (
    sameAddr(to, want[0]) &&
    value === want[1] &&
    sameHex(data, want[2]) &&
    operation === want[3] &&
    safeTxGas === want[4] &&
    baseGas === want[5] &&
    gasPrice === want[6] &&
    sameAddr(gasToken, want[7]) &&
    sameAddr(refundReceiver, want[8]) &&
    sameHex(sig, want[9])
  );
}

/** Two values equal to the rebuild's: the payee without regard to case, the amount exactly and a
 *  bigint. */
function sameTransferArgs(args: unknown, want: TransferArgs): boolean {
  if (!Array.isArray(args) || args.length !== 2) return false;
  const [to, amount] = args as unknown[];
  return sameAddr(to, want[0]) && amount === want[1];
}

/** The pot's three functions. */
type PotFunction = "aggregate3Value" | "execTransaction" | "transfer";

/** The context of the function's kinds, read once, or null: each reader reads only its own. */
function readPotContext(
  fn: PotFunction,
  raw: unknown,
): SetupContext | ExecRead | TransferContext | null {
  if (fn === "aggregate3Value") return readSetupContext(raw);
  if (fn === "execTransaction") return readExecContext(raw);
  return readTransferContext(raw);
}

/**
 * The pot's three functions. First, for all: the request's chain is the configured one; the chain
 * has the pot's contracts; a complete context of the function's kinds; an order on this
 * deployment, linked and not revoked, whose guardian is the context's; a gas from 1 to the
 * function's cap. Then the function's own rules (`checkSetup`, `checkExec`, `checkTransfer`).
 *
 * THE EXITS (Ruling R33). Stop the allowance and Take the money back only remove rights or pay the
 * guardian's own wallet, so the guardian keeps them whatever happened to the legal body: for those
 * two kinds the order need not be linked, may be revoked, and may be of another factory on this
 * chain. Every other rule holds for them as for the rest: the configured chain in the pot's table,
 * an order of this chain whose guardian is the context's, the gas, and the rebuild compared.
 */
function checkPotCall(req: WriteRequest, ctx: CallContext, fn: PotFunction): Checked | Refusal {
  const { config } = ctx;
  if (req.chainId !== config.chainId) return refuse("wrong_chain");
  const table = potAddresses(config.chainId);
  if (table === null) return refuse("pot_chain_unsupported");
  const p = readPotContext(fn, ctx.pot);
  if (p === null) return refuse("no_pot_context");
  const order: unknown = ctx.order;
  if (typeof order !== "object" || order === null) return refuse("no_order");
  const o = order as LegalBodyOrderView;
  const exit = p.kind === "stop" || p.kind === "withdraw";
  if (o.chainId !== config.chainId || (!exit && !sameAddress(o.factory, config.factory)))
    return refuse("order_on_another_deployment");
  if (!exit && (o.state !== "linked" || o.revoked !== false)) return refuse("order_not_linked");
  if (!sameAddr(o.guardian, p.guardian)) return refuse("guardian_is_not_the_orders");
  const gas: unknown = req.gas;
  const cap =
    fn === "aggregate3Value"
      ? POT_SETUP_GAS_CAP
      : fn === "execTransaction"
        ? POT_EXEC_GAS_CAP
        : POT_TRANSFER_GAS_CAP;
  if (typeof gas !== "bigint" || gas <= ZERO || gas > cap) return refuse("gas_out_of_bounds");
  // Each reader reads only its function's kinds: the kind is the function's.
  if (p.kind === "setup") return checkSetup(req, config.chainId, table, p, gas);
  if (p.kind === "add_money" || p.kind === "fee_money")
    return checkTransfer(req, config.chainId, table, p, gas);
  return checkExec(req, config.chainId, table, p, gas);
}

/** The setup: to the table's Multicall3, over the pinned ABI; its own rules and the rebuild; the
 *  value (absent reads as 0) the rebuild's; the calls the rebuild's. */
function checkSetup(
  req: WriteRequest,
  chainId: number,
  a: PotAddresses,
  p: SetupContext,
  gas: bigint,
): Checked | Refusal {
  if (!sameAddr(req.address, a.multicall3)) return refuse("not_multicall3");
  if (req.abi !== multicall3Abi) return refuse("not_the_pinned_abi");
  const rebuilt = rebuildSetup(a, p);
  if (!rebuilt.ok) return rebuilt;
  const given: unknown = req.value;
  if ((given === undefined ? ZERO : given) !== rebuilt.value) return refuse("value_mismatch");
  if (!sameCalls(req.args, rebuilt.calls)) return refuse("setup_args");
  const args = [rebuilt.calls];
  return {
    ok: true,
    data: encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3Value",
      args: [rebuilt.calls],
    }),
    args,
    pot: {
      guardian: p.guardian,
      request: {
        chainId,
        address: checksummed(a.multicall3),
        abi: multicall3Abi,
        functionName: "aggregate3Value",
        args,
        value: rebuilt.value,
        gas,
      },
    },
  };
}

/** An action: no value; over the pinned ABI; on the noted pot; its kind's rules and the rebuild;
 *  the ten arguments the rebuild's. */
function checkExec(
  req: WriteRequest,
  chainId: number,
  a: PotAddresses,
  p: ExecRead,
  gas: bigint,
): Checked | Refusal {
  const value: unknown = req.value;
  if (value !== undefined && value !== ZERO) return refuse("sends_value");
  if (req.abi !== safeAbi) return refuse("not_the_pinned_abi");
  if (!sameAddr(req.address, p.pot)) return refuse("not_the_pot");
  const rebuilt = rebuildExec(a, p);
  if (!rebuilt.ok) return rebuilt;
  if (!sameExecArgs(req.args, rebuilt.args)) return refuse("exec_args");
  const request: WriteRequest = {
    chainId,
    address: checksummed(p.pot),
    abi: safeAbi,
    functionName: "execTransaction",
    args: rebuilt.args,
    gas,
  };
  if (value === ZERO) request.value = ZERO;
  return {
    ok: true,
    data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: rebuilt.args }),
    args: rebuilt.args,
    pot: { guardian: p.guardian, request },
  };
}

/** A transfer: on the table's USDC; over the pinned ABI; no value (absent or 0); its kind's rules
 *  and the rebuild; the two arguments the rebuild's. The wallet gets the rebuild with no value:
 *  the money moves as USDC units, never as wei. */
function checkTransfer(
  req: WriteRequest,
  chainId: number,
  a: PotAddresses,
  p: TransferContext,
  gas: bigint,
): Checked | Refusal {
  if (!sameAddr(req.address, a.usdc)) return refuse("not_usdc");
  if (req.abi !== erc20Abi) return refuse("not_the_pinned_abi");
  const value: unknown = req.value;
  if (value !== undefined && value !== ZERO) return refuse("sends_value");
  const rebuilt = rebuildTransfer(a, p);
  if (!rebuilt.ok) return rebuilt;
  if (!sameTransferArgs(req.args, rebuilt.args)) return refuse("transfer_args");
  return {
    ok: true,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: rebuilt.args }),
    args: rebuilt.args,
    pot: {
      guardian: p.guardian,
      request: {
        chainId,
        address: checksummed(a.usdc),
        abi: erc20Abi,
        functionName: "transfer",
        args: rebuilt.args,
        gas,
      },
    },
  };
}

/** The allowlist itself; `allowedCall` shows its answer, `sendAllowedCall` sends it. The pot's
 *  three functions take their own rules; any other name takes the registry's, which refuse any
 *  value. It reads what `gate` read once, never the caller's objects. */
function checkCall(req: WriteRequest, ctx: CallContext): Checked | Refusal {
  const fn = req.functionName;
  if (fn === "aggregate3Value" || fn === "execTransaction" || fn === "transfer")
    return checkPotCall(req, ctx, fn);
  const { config } = ctx;
  if (req.value !== undefined && req.value !== BigInt(0)) return refuse("sends_value");
  if (req.chainId !== config.chainId) return refuse("wrong_chain");
  if (!sameAddress(req.address, config.identityRegistry)) return refuse("not_the_registry");
  if (req.abi !== identityRegistryAbi) return refuse("not_the_pinned_abi");
  // The type says an array; a request assembled elsewhere might not hold one.
  const args: readonly unknown[] | null = Array.isArray(req.args) ? req.args : null;

  if (req.functionName === "register") {
    if (args === null) return refuse("register_args");
    if (args.length === 0) {
      return {
        ok: true,
        data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [] }),
        args: [],
      };
    }
    const [uri] = args;
    if (args.length === 1 && typeof uri === "string") {
      return {
        ok: true,
        data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [uri] }),
        args: [uri],
      };
    }
    return refuse("register_args");
  }

  if (req.functionName === "setMetadata") {
    const order = ctx.order;
    if (order === null) return refuse("no_order");
    // The order's chain is read once: the one compared is the one the pointer encodes.
    const orderChainId = order.chainId;
    if (orderChainId !== config.chainId || !sameAddress(order.factory, config.factory))
      return refuse("order_on_another_deployment");
    if (!pointable(order)) return refuse("order_not_pointable");
    const own = bodyOf(order);
    if (own === null) return refuse("order_has_no_body");
    if (args === null || args.length !== 3) return refuse("set_metadata_args");
    const [agentId, key, value] = args;
    if (typeof agentId !== "bigint" || agentId !== own.agentId) return refuse("other_identity");
    if (key !== POINTER_KEY) return refuse("other_key");
    const expected = encodePointer(orderChainId, own.body);
    if (typeof value !== "string" || value.toLowerCase() !== expected) return refuse("other_body");
    return {
      ok: true,
      data: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "setMetadata",
        args: [own.agentId, POINTER_KEY, expected],
      }),
      args: [own.agentId, POINTER_KEY, expected],
    };
  }

  if (req.functionName === "setAgentWallet") {
    const wallet = ctx.wallet;
    if (!wallet) return refuse("no_wallet_context");
    // Each field read once: the rules below compare what was checked here.
    const { agentId: contextId, guardian, nowSeconds: now } = wallet;
    // The type is not proof, and an incomplete context is no context: a guardian that is not an
    // address would let its rule pass unread, and an id that is not a string or a time that is not
    // a finite number at or above 0 cannot be compared with anything.
    if (
      typeof guardian !== "string" ||
      !ADDRESS.test(guardian) ||
      typeof contextId !== "string" ||
      !Number.isFinite(now) ||
      now < 0
    )
      return refuse("no_wallet_context");
    if (args === null || args.length !== 4) return refuse("set_agent_wallet_args");
    const [agentId, newWallet, deadline, signature] = args;
    if (
      typeof agentId !== "bigint" ||
      typeof newWallet !== "string" ||
      !ADDRESS.test(newWallet) ||
      typeof deadline !== "bigint" ||
      typeof signature !== "string"
    )
      return refuse("set_agent_wallet_args");
    // An id in the context that is not a canonical decimal matches no identity: never read by
    // `BigInt`, which takes hex and throws on the rest. Nor does one past any uint256.
    if (
      !CANONICAL_DECIMAL.test(contextId) ||
      agentId !== BigInt(contextId) ||
      agentId > MAX_UINT256
    )
      return refuse("other_identity");
    if (ZERO_ADDRESS.test(newWallet)) return refuse("wallet_is_zero");
    if (sameAddress(newWallet, guardian)) return refuse("wallet_is_guardian");
    // A bigint compares with a number exactly, a fraction of a second included. A huge but finite
    // time puts its whole window past any uint256: refused too, never handed to the encoder.
    const inWindow =
      deadline >= now && deadline <= now + MAX_WALLET_SET_DELAY_SECONDS && deadline <= MAX_UINT256;
    if (!inWindow) return refuse("deadline_out_of_window");
    if (signature.length > 2 + 2 * MAX_SIGNATURE_BYTES || !WHOLE_BYTES.test(signature))
      return refuse("signature_shape");
    // viem refuses an address whose letter case is not its checksum: the wallet is forwarded
    // checksummed and the signature in lower case, so the calldata is the same in any case.
    const to = getAddress(newWallet.toLowerCase());
    const sig = signature.toLowerCase() as Hex;
    return {
      ok: true,
      data: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "setAgentWallet",
        args: [agentId, to, deadline, sig],
      }),
      args: [agentId, to, deadline, sig],
    };
  }

  return refuse("not_allowed");
}

/** The request as the allowlist reads it: each of its seven fields read once, the arguments copied
 *  into a list of its own when they are a list. The rules read this copy only, and the wallet gets
 *  only what was built from it: a request whose fields answer otherwise on a later read changes
 *  nothing. */
function snapshotOf(req: WriteRequest): WriteRequest {
  const { chainId, address, abi, functionName, args, value, gas } = req;
  const copy: WriteRequest = {
    chainId,
    address,
    abi,
    functionName,
    args: Array.isArray(args) ? Array.prototype.slice.call(args) : args,
  };
  if (value !== undefined) copy.value = value;
  if (gas !== undefined) copy.gas = gas;
  return copy;
}

/** The context as the allowlist reads it: each of its four fields read once, and the three values
 *  of `/config`. The order, the identity's facts and the pot's are each read once by the rule that
 *  takes them. */
function contextOf(ctx: CallContext): CallContext {
  const { config, order, wallet, pot } = ctx;
  const { chainId, identityRegistry, factory } = config;
  return { config: { chainId, identityRegistry, factory }, order, wallet, pot };
}

/** Both doors' one entry: the request and its context read once, then the rules. A request or a
 *  context that throws while it is read (a getter, a revoked Proxy) is refused `bad_request`:
 *  nothing it holds reaches the wallet, and the screen gets a problem, never a throw. */
function gate(
  req: WriteRequest,
  ctx: CallContext,
): { ok: true; request: WriteRequest; checked: Checked } | Refusal {
  try {
    const request = snapshotOf(req);
    const checked = checkCall(request, contextOf(ctx));
    return checked.ok ? { ok: true, request, checked } : checked;
  } catch {
    return refuse("bad_request");
  }
}

/**
 * The allowlist's answer, for a screen to show. Both doors, this one and `sendAllowedCall`, pass
 * `checkCall`, which holds the rules, so there is one allowlist: exactly seven calls.
 *
 * Four on the registry of `/config`'s chain, never with a value. `register()` and
 * `register(string)`; `setMetadata(agentId, "legalBody", pointer)` for the selected order's own
 * identity and body; and `setAgentWallet(agentId, newWallet, deadline, signature)` for the
 * selected identity, with no order needed. Its rules, in order: a complete context (an id that is
 * a string, the guardian's address, a finite chain time of 0 or more); four arguments of the right
 * types; the context's identity, no larger than a uint256; never the zero address; never the
 * guardian's own wallet; a deadline from the chain's time to 300 seconds after it, no larger than a
 * uint256; a signature of 1 to 2,048 whole bytes.
 *
 * Three for the company's pot, for an order that is linked and not revoked, from a context whose
 * guardian is the order's, on a chain the pot's table holds, with a gas from 1 to the call's cap.
 * The setup, `aggregate3Value` on the table's Multicall3: it creates the Safe the context
 * describes (the guardian its only owner, the agent's wallet its only delegate, the ceiling in
 * each thirty-day period) and may carry money to two places only, the pot it creates (at most
 * 1,000,000,000 USDC) and the agent's own wallet (at most 1 USDC, and only to a plain key), each in
 * whole units; its value is the sum of the two. The guardian's `execTransaction` on the noted pot,
 * with no value: change the ceiling, stop the allowance, take the pot's money back to the guardian
 * (only once no module is on), or start again with the registry's key. And USDC's `transfer` on
 * the table's USDC, with no value: "Add money", 1 unit to 1,000,000,000 USDC to the noted pot; or
 * "Send fee money", 1 unit to 1 USDC to the agent's own wallet, a plain key with no code, never
 * the guardian's. Each is rebuilt from the context alone, with the table's USDC and the thirty-day
 * period, and accepted only when the request equals the rebuild. `sendAllowedCall` then asks that
 * the connected account be the guardian's. Money moves to the guardian's own pot, to the agent's
 * own key, or back to the guardian, and to nobody else: nothing goes to Novi Corpus.
 *
 * Reads the request and its context once, and refuses with the first rule broken, in the order
 * they are written. Never throws on what it is handed: what cannot be read is `bad_request`.
 * Returns the calldata it checked, encoded over the pinned ABI.
 */
export function allowedCall(
  req: WriteRequest,
  ctx: CallContext,
): { ok: true; data: Hex } | Refusal {
  const gated = gate(req, ctx);
  return gated.ok ? { ok: true, data: gated.checked.data } : gated;
}

/** The request the wallet gets: the fields the allowlist read in its one reading, with the
 *  arguments it checked (a new array, never the caller's, which could still change), and nothing
 *  else: a key it did not read (a calldata suffix, a nonce, an account) never reaches the wallet.
 *  The ABI is the pinned one of the branch that accepted, never the request's. For the registry's
 *  calls `value` and `gas` pass through as read; a pot call's request is the one its branch
 *  rebuilt, with the value and the gas it checked. */
function forwarded(read: WriteRequest, checked: Checked): WriteRequest {
  if (checked.pot !== undefined) return checked.pot.request;
  const out: WriteRequest = {
    chainId: read.chainId,
    address: read.address,
    abi: identityRegistryAbi,
    functionName: read.functionName,
    args: checked.args,
  };
  if (read.value !== undefined) out.value = read.value;
  if (read.gas !== undefined) out.gas = read.gas;
  return out;
}

/**
 * The one door to the wallet: the allowlist, then the chain. Refuses, with a problem the screen
 * turns into a sentence, when this site is not configured for the request's chain or the wallet
 * is on another one, instead of switching the wallet silently; and, for a pot call, when the
 * connected account (`walletAddress`) is not the order's guardian or none is named: the money
 * would come from another account, and an action's approval holds only from the guardian's own.
 * The chain compared is the one the allowlist read. Otherwise one `writeContract`, of what the
 * allowlist built from its one reading.
 */
export async function sendAllowedCall(
  req: WriteRequest,
  ctx: CallContext,
  deps: {
    walletChainId: number | undefined;
    /** The connected account; a pot call is sent only from the guardian's. */
    walletAddress?: Address;
    configuredChainIds: readonly number[];
    writeContract: (req: WriteRequest) => Promise<Hex>;
  },
): Promise<{ ok: true; hash: Hex; data: Hex } | Refusal> {
  const gated = gate(req, ctx);
  if (!gated.ok) return gated;
  const { request, checked } = gated;
  if (!deps.configuredChainIds.includes(request.chainId)) return refuse("chain_not_configured");
  if (deps.walletChainId !== request.chainId) return refuse("wallet_on_another_chain");
  if (checked.pot !== undefined && !sameAddr(deps.walletAddress, checked.pot.guardian))
    return refuse("wallet_is_not_the_guardian");
  const hash = await deps.writeContract(forwarded(request, checked));
  return { ok: true, hash, data: checked.data };
}

// ---------------------------------------------------------------------------------------------
// The mint
// ---------------------------------------------------------------------------------------------

/**
 * The agentId a `register` minted, from its receipt: the one `Transfer` from the zero address,
 * emitted by the registry, to the registering wallet. Anything else is null: never guess an id.
 * A receipt that says it did not succeed is null; one that names no status is read by its logs,
 * which a reverted transaction never carries.
 */
export function agentIdFromMint(
  receipt: { status?: string; logs: readonly { address: string; topics: readonly string[] }[] },
  ctx: { registry: Address; owner: Address },
): string | null {
  if (receipt.status !== undefined && receipt.status !== "success") return null;
  const mints = receipt.logs.filter(
    (l) =>
      sameAddress(l.address, ctx.registry) &&
      l.topics.length === 4 &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      ZERO_WORD.test(l.topics[1] ?? ""),
  );
  if (mints.length !== 1) return null;
  const [, , to, id] = mints[0].topics;
  const recipient = ADDRESS_WORD.exec(to ?? "");
  if (recipient === null || !sameAddress(`0x${recipient[1]}`, ctx.owner)) return null;
  if (!WORD.test(id ?? "")) return null;
  return BigInt(id).toString();
}
