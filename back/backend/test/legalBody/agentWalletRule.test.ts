/**
 * The agent's own wallet, as the link requires it: the wallet the identity names is set, and it is
 * not the guardian's. Every address here is a placeholder.
 */
import type { Address } from "viem";
import { expect, test } from "vitest";
import { ownAgentWallet } from "../../src/legalBody/agentWalletRule";

const G = "0x172B7952b0F711b8B372410E81d51Dcba7D4BB02" as Address;

test("accepts a wallet that is set and is not the guardian's", () => {
  expect(ownAgentWallet("0x00000000000000000000000000000000000000A1", G)).toBe(true);
});

test("refuses the zero address", () => {
  expect(ownAgentWallet("0x0000000000000000000000000000000000000000", G)).toBe(false);
});

test("refuses the guardian's wallet, whatever the letter case", () => {
  expect(ownAgentWallet(G, G)).toBe(false);
  expect(ownAgentWallet(G.toLowerCase() as Address, G)).toBe(false);
});
