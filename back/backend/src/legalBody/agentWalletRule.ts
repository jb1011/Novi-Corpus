import { type Address, isAddressEqual, zeroAddress } from "viem";

/**
 * The agent's own wallet, as a link requires it: the wallet the identity names in the registry
 * (`getAgentWallet`) is set, and it is not the guardian's.
 *
 * A guardian who registers an identity from their own wallet leaves that wallet named as the
 * agent's: such an agent has no wallet of its own yet, and no legal body is created for it. The
 * identity owner's own address is accepted, as long as the owner is not the guardian.
 *
 * Addresses are compared whatever their letter case.
 */
export function ownAgentWallet(agentWallet: Address, guardian: Address): boolean {
  return !isAddressEqual(agentWallet, zeroAddress) && !isAddressEqual(agentWallet, guardian);
}
