/**
 * The agent's wallet step's rules, each pure.
 *
 * Before a legal body is created, the agent's own wallet is written on its ERC-8004 identity:
 * `setAgentWallet(agentId, newWallet, deadline, signature)` on the identity registry, sent by the
 * identity's owner. The signature is the new wallet's, over `AgentWalletSet(uint256 agentId,address
 * newWallet,address owner,uint256 deadline)` in the registry's own EIP-712 domain, and the deadline
 * is at most 300 seconds ahead of the chain's clock. The registry takes a plain key's signature or
 * a contract wallet's own `isValidSignature`, never an ERC-6492 wrapped one.
 *
 * Here: what the registry names today (`readAgentWallet`, `agentWalletReadOf`) and whose wallet
 * that is (`agentWalletStanding`); the address a person types (`parseAgentWalletAddress`); the
 * deadline and the time left (`walletSetDeadline`, `walletSetSecondsLeft`, `walletSetSendable`);
 * the message in its two forms (`walletSetTypedData` for viem and wagmi, `walletSetText` for the
 * copy box) over the domain the registry answers (`registryDomainOf`); and what a pasted signature
 * is worth before anything is sent (`isErc6492Wrapped`, `walletSignatureVerdict`).
 *
 * Nothing here reads a chain, a clock or a wallet: the answers and the time come in as values.
 */
import { getAddress } from "viem";
import { EIP712_DOMAIN_FIELDS, type Address, type Hex } from "@/lib/api/types";
import type { WalletKind } from "./chain";
import { sameAddress } from "./flow";
import type { ChainRead } from "./paste";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

// ---------------------------------------------------------------------------------------------
// What the registry names today
// ---------------------------------------------------------------------------------------------

/** `getAgentWallet(agentId)`: the wallet; "none" when the registry names the zero address;
 *  "unreadable" when the chain could not be read or answered something that is not an address. */
export type AgentWalletRead = Address | "none" | "unreadable";

/** One answer of the registry, as the step reads it. */
function walletOf(answer: unknown): AgentWalletRead {
  if (typeof answer !== "string" || !ADDRESS.test(answer)) return "unreadable";
  return ZERO_ADDRESS.test(answer) ? "none" : (answer as Address);
}

/** A registry read: the zero address is "none"; a thrown read is "unreadable", whatever threw, a
 *  revert included: only the registry's answer says there is no wallet. */
export async function readAgentWallet(read: () => Promise<unknown>): Promise<AgentWalletRead> {
  let answer: unknown;
  try {
    answer = await read();
  } catch {
    return "unreadable";
  }
  return walletOf(answer);
}

/** The same decision over a query's state; null while pending. */
export function agentWalletReadOf(r: ChainRead): AgentWalletRead | null {
  if (r.status === "pending") return null;
  if (r.status === "error") return "unreadable";
  return walletOf(r.data);
}

/** Whose wallet the registry names: the agent's own (any wallet but the guardian's), the
 *  guardian's own wallet, or none. */
export type AgentWalletStanding = "own" | "guardians" | "none";

export function agentWalletStanding(
  read: Address | "none",
  guardian: Address,
): AgentWalletStanding {
  if (read === "none") return "none";
  return sameAddress(read, guardian) ? "guardians" : "own";
}

// ---------------------------------------------------------------------------------------------
// The address a person types
// ---------------------------------------------------------------------------------------------

export type WalletAddressProblem = "empty" | "not_address" | "zero" | "guardian";

/**
 * The agent's wallet as typed: the spaces and newlines at either end trimmed, then `0x` and 40 hex
 * digits in any letter case, never the zero address, never the guardian's own wallet. Returned
 * checksummed. A mixed-case address whose checksum is off is not refused: the wallet must sign the
 * message, and no signature recovers to a mistyped address.
 */
export function parseAgentWalletAddress(
  raw: string,
  guardian: Address,
): Address | { problem: WalletAddressProblem } {
  const value = raw.trim();
  if (value === "") return { problem: "empty" };
  if (!ADDRESS.test(value)) return { problem: "not_address" };
  if (ZERO_ADDRESS.test(value)) return { problem: "zero" };
  if (sameAddress(value, guardian)) return { problem: "guardian" };
  return getAddress(value.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// The deadline and the time left
// ---------------------------------------------------------------------------------------------

/** How long a message is valid: under the registry's 300 seconds, with room for a block. */
export const WALLET_SET_TTL_SECONDS = 270;
/** No transaction is offered with less left than this. */
export const WALLET_SET_SEND_MARGIN_SECONDS = 30;

/** The message's deadline, from the chain's clock: the head's timestamp plus 270 seconds. */
export function walletSetDeadline(headTimestamp: bigint): bigint {
  return headTimestamp + BigInt(WALLET_SET_TTL_SECONDS);
}

/**
 * The whole seconds left before the deadline, never below 0. `nowSeconds` is the caller's
 * reading of the chain's time, since the deadline is counted from the chain's clock. A time that
 * cannot be read (NaN) leaves 0.
 */
export function walletSetSecondsLeft(deadline: bigint, nowSeconds: number): number {
  const left = Math.floor(Number(deadline) - nowSeconds);
  // Written so that NaN reads as nothing left.
  return left > 0 ? left : 0;
}

/** Whether the transaction may still be offered: at least 30 whole seconds left. */
export function walletSetSendable(deadline: bigint, nowSeconds: number): boolean {
  return walletSetSecondsLeft(deadline, nowSeconds) >= WALLET_SET_SEND_MARGIN_SECONDS;
}

// ---------------------------------------------------------------------------------------------
// The message in its two forms
// ---------------------------------------------------------------------------------------------

/** What the agent's wallet signs. `agentId` is the id as the registry serves it, in decimal. */
export type WalletSetMessage = {
  agentId: string;
  newWallet: Address;
  owner: Address;
  deadline: bigint;
};

/** The registry's EIP-712 domain, as `registryDomainOf` read it. */
export type RegistryDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

/** The four fields of the registry's `AgentWalletSet` type string, in its order. */
const AGENT_WALLET_SET_FIELDS = [
  { name: "agentId", type: "uint256" },
  { name: "newWallet", type: "address" },
  { name: "owner", type: "address" },
  { name: "deadline", type: "uint256" },
] as const;

/** For wagmi and viem: types without EIP712Domain, bigints in the message. */
export type WagmiWalletSetTypedData = {
  domain: RegistryDomain;
  types: {
    AgentWalletSet: readonly [
      { name: "agentId"; type: "uint256" },
      { name: "newWallet"; type: "address" },
      { name: "owner"; type: "address" },
      { name: "deadline"; type: "uint256" },
    ];
  };
  primaryType: "AgentWalletSet";
  message: { agentId: bigint; newWallet: Address; owner: Address; deadline: bigint };
};

/** The domain's four fields, copied. */
const copyDomain = (d: RegistryDomain): RegistryDomain => ({
  name: d.name,
  version: d.version,
  chainId: d.chainId,
  verifyingContract: d.verifyingContract,
});

/**
 * The message in the form viem hashes and recovers over. `types` leaves `EIP712Domain` out, since
 * viem derives the same four fields from the domain; the two uint256 are bigints.
 */
export function walletSetTypedData(
  domain: RegistryDomain,
  m: WalletSetMessage,
): WagmiWalletSetTypedData {
  return {
    domain: copyDomain(domain),
    types: { AgentWalletSet: AGENT_WALLET_SET_FIELDS },
    primaryType: "AgentWalletSet",
    message: {
      agentId: BigInt(m.agentId),
      newWallet: m.newWallet,
      owner: m.owner,
      deadline: m.deadline,
    },
  };
}

/**
 * For the copy box: one JSON text, two-space indent, WITH the EIP712Domain type, every uint256 of
 * the message a decimal string, since JSON has no bigint. The domain's chain id stays a JSON
 * number, as in the link's copy box: a signer checks it against its chain. A signer that takes
 * whole typed data signs this as is, to the digest of `walletSetTypedData`.
 */
export function walletSetText(domain: RegistryDomain, m: WalletSetMessage): string {
  const typed = walletSetTypedData(domain, m);
  return JSON.stringify(
    {
      domain: typed.domain,
      types: { EIP712Domain: EIP712_DOMAIN_FIELDS, AgentWalletSet: AGENT_WALLET_SET_FIELDS },
      primaryType: typed.primaryType,
      message: {
        agentId: typed.message.agentId.toString(),
        newWallet: typed.message.newWallet,
        owner: typed.message.owner,
        deadline: typed.message.deadline.toString(),
      },
    },
    null,
    2,
  );
}

/** ERC-5267's `fields` for a domain of a name, a version, a chain id and a verifying contract,
 *  and no salt. */
const NAME_VERSION_CHAIN_CONTRACT = "0x0f";

/**
 * `eip712Domain()`'s answer, checked: chainId and verifyingContract must be the configured ones.
 * The answer is the seven values the pinned ABI reads, in order: `fields`, `name`, `version`,
 * `chainId` (a bigint), `verifyingContract`, `salt`, `extensions`. The name and the version are the
 * registry's own, read live. `fields` must say exactly the four fields the message's domain
 * carries, and no extension may be named: any other domain hashes to another digest. Anything else
 * is null, never a guess.
 */
export function registryDomainOf(
  answer: unknown,
  config: { chainId: number; identityRegistry: Address },
): RegistryDomain | null {
  if (!Array.isArray(answer) || answer.length !== 7) return null;
  const [fields, name, version, chainId, verifyingContract, , extensions] = answer as unknown[];
  if (typeof fields !== "string" || fields.toLowerCase() !== NAME_VERSION_CHAIN_CONTRACT)
    return null;
  if (typeof name !== "string" || typeof version !== "string") return null;
  if (
    typeof chainId !== "bigint" ||
    !Number.isSafeInteger(config.chainId) ||
    chainId !== BigInt(config.chainId)
  )
    return null;
  if (
    typeof verifyingContract !== "string" ||
    !ADDRESS.test(verifyingContract) ||
    !sameAddress(verifyingContract, config.identityRegistry)
  )
    return null;
  if (!Array.isArray(extensions) || extensions.length !== 0) return null;
  return {
    name,
    version,
    chainId: config.chainId,
    verifyingContract: verifyingContract as Address,
  };
}

// ---------------------------------------------------------------------------------------------
// What a pasted signature is worth
// ---------------------------------------------------------------------------------------------

/** ERC-6492's marker: `0x6492` repeated to 32 bytes, at the end of a wrapped signature. */
const ERC6492_MARKER = "6492".repeat(16);

/** Whether the signature ends with ERC-6492's marker (in any letter case): a signature made for a
 *  wallet not yet on the chain, which the registry refuses. */
export function isErc6492Wrapped(signature: Hex): boolean {
  return signature.toLowerCase().endsWith(ERC6492_MARKER);
}

export type WalletSignatureVerdict =
  | { ok: true }
  | {
      ok: false;
      problem: "wrong_key" | "compact" | "wrapped" | "not_on_chain" | "contract_refused";
    };

type VerdictProblem = Extract<WalletSignatureVerdict, { ok: false }>["problem"];

const refused = (problem: VerdictProblem): WalletSignatureVerdict => ({ ok: false, problem });

/** The 65 bytes of `r`, `s` and `v`: the only key signature the registry takes. */
const KEY_SIGNATURE_BYTES = 65;
/** The same signature in EIP-2098's compact form, `r` and `yParity` with `s`. */
const COMPACT_SIGNATURE_BYTES = 64;

/**
 * What a pasted signature is worth before the transaction is offered, in this order:
 *  1. a wrapped signature (`isErc6492Wrapped`) is `wrapped`, whatever else is true;
 *  2. a key (no code): 65 bytes that recover to `newWallet` are ok; exactly 64 bytes are
 *     `compact`; 65 bytes that do not recover are `wrong_key`; any other length is
 *     `not_on_chain`, since a wallet with no code cannot sign any other way;
 *  3. a delegated key (EIP-7702, the address has code): 65 bytes that recover to `newWallet` are
 *     ok; otherwise the wallet's own `isValidSignature` saying yes is ok; otherwise exactly 64
 *     bytes are `compact`, 65 bytes `wrong_key`, any other length `contract_refused`;
 *  4. a contract: its own `isValidSignature` saying yes is ok, anything else `contract_refused`.
 * 64 bytes are refused because the registry takes a key's signature in its 65-byte form only: the
 * compact form of the very same signature is refused on chain, so it is asked for again in 65.
 * `kind` is `walletKindOf(getCode(newWallet))`; `recovered` is the address the signature recovers
 * to over the typed data, or null when it does not recover; `contractAccepts` is the wallet's own
 * `isValidSignature` answer, or null when not asked.
 */
export function walletSignatureVerdict(p: {
  kind: WalletKind;
  newWallet: Address;
  signature: Hex;
  recovered: Address | null;
  contractAccepts: boolean | null;
}): WalletSignatureVerdict {
  if (isErc6492Wrapped(p.signature)) return refused("wrapped");
  const length = (p.signature.length - 2) / 2;
  const recovers = length === KEY_SIGNATURE_BYTES && sameAddress(p.recovered, p.newWallet);
  switch (p.kind) {
    case "key":
      if (recovers) return { ok: true };
      if (length === COMPACT_SIGNATURE_BYTES) return refused("compact");
      return refused(length === KEY_SIGNATURE_BYTES ? "wrong_key" : "not_on_chain");
    case "delegated":
      if (recovers || p.contractAccepts === true) return { ok: true };
      if (length === COMPACT_SIGNATURE_BYTES) return refused("compact");
      return refused(length === KEY_SIGNATURE_BYTES ? "wrong_key" : "contract_refused");
    case "contract":
      return p.contractAccepts === true ? { ok: true } : refused("contract_refused");
    default: {
      // A fourth kind fails the type check here; at run time, a kind this build does not know is
      // never ok.
      const unknownKind: never = p.kind;
      void unknownKind;
      return refused("contract_refused");
    }
  }
}
