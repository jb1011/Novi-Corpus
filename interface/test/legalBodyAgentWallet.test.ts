/**
 * The agent's wallet step's pure rules (`agentWallet.ts`): what the registry names today and whose
 * wallet that is, whether a legal body's public record still owes the agent's wallet, the address
 * a person types, the deadline and the time left, the message in its
 * two forms over the registry's own domain, and what a pasted signature is worth before anything
 * is sent.
 *
 * The domain and the message are written out by hand for the live testnet registry (chain 5042002,
 * its public address, agent 897938), with invented wallets; the digest is the registry's for them.
 * Keys that sign are made at run time and thrown away. Anvil's first two published accounts stand
 * for the guardian and the agent's wallet.
 */
import { describe, expect, it } from "vitest";
import {
  hashTypedData,
  parseSignature,
  recoverTypedDataAddress,
  serializeCompactSignature,
  signatureToCompactSignature,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "@/lib/api/types";
import { walletKindOf, type WalletKind } from "@/lib/legalBody/chain";
import type { ChainRead } from "@/lib/legalBody/paste";
import {
  agentWalletOwed,
  agentWalletReadOf,
  agentWalletStanding,
  isErc6492Wrapped,
  parseAgentWalletAddress,
  readAgentWallet,
  registryDomainOf,
  WALLET_SET_SEND_MARGIN_SECONDS,
  WALLET_SET_TTL_SECONDS,
  walletSetDeadline,
  walletSetSecondsLeft,
  walletSetSendable,
  walletSetText,
  walletSetTypedData,
  walletSignatureVerdict,
  type AgentWalletRead,
  type WalletSetMessage,
} from "@/lib/legalBody/agentWallet";

const DOMAIN = { name: "ERC8004IdentityRegistry", version: "1", chainId: 5042002,
  verifyingContract: "0x8004A818BFB912233c491871b3d84c89A494BD9e" } as const;
const M = { agentId: "897938", newWallet: "0x00000000000000000000000000000000000000A1",
  owner: "0x00000000000000000000000000000000000000b2", deadline: BigInt(1795000000) } as const;
/** The registry's digest for `M` in `DOMAIN`. */
const DIGEST = "0x94db4481eb317eab24ca2a61050e643efa4cad640a20217fc780360dfa8f7d22";

/** The site's configuration of the same deployment. */
const CONFIG = { chainId: DOMAIN.chainId, identityRegistry: DOMAIN.verifyingContract };
/** `eip712Domain()` as the live registry answers it through the pinned ABI. */
const LIVE_ANSWER = [
  "0x0f",
  "ERC8004IdentityRegistry",
  "1",
  BigInt(5042002),
  "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  `0x${"00".repeat(32)}`,
  [],
] as const;

/** Anvil's first two published accounts, checksummed. */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
/** ERC-6492's marker: the 32 bytes a wrapped signature ends with. */
const MARKER = "6492".repeat(16);

const lower = (a: string) => a.toLowerCase() as Address;
const bytes = (n: number, byte = "ab"): Hex => `0x${byte.repeat(n)}`;

// ---------------------------------------------------------------------------------------------
// What the registry names today
// ---------------------------------------------------------------------------------------------

describe("readAgentWallet", () => {
  const answers = (value: unknown) => async () => value;
  const throws = (e: unknown) => async () => {
    throw e;
  };

  it.each<[string, () => Promise<unknown>, AgentWalletRead]>([
    ["a wallet", answers(AGENT), AGENT],
    ["a wallet in lower case, as answered", answers(lower(AGENT)), lower(AGENT)],
    ["the zero address: no wallet", answers(ZERO), "none"],
    ["a read that threw", throws(new Error("fetch failed")), "unreadable"],
    [
      "a revert is unreadable too, never no wallet",
      throws({ name: "ContractFunctionRevertedError" }),
      "unreadable",
    ],
    ["an answer too short to be an address", answers("0x12"), "unreadable"],
    ["an answer that is not text", answers(42), "unreadable"],
    ["no answer at all", answers(undefined), "unreadable"],
  ])("%s", async (_name, read, expected) => {
    expect(await readAgentWallet(read)).toBe(expected);
  });

  it("a read that throws before it returns a promise is unreadable", async () => {
    const read = () => {
      throw new Error("no client");
    };
    expect(await readAgentWallet(read)).toBe("unreadable");
  });
});

describe("agentWalletReadOf", () => {
  it.each<[string, ChainRead, AgentWalletRead | null]>([
    ["pending: not known yet", { status: "pending" }, null],
    ["an error", { status: "error", error: new Error("fetch failed") }, "unreadable"],
    ["a wallet", { status: "success", data: AGENT }, AGENT],
    ["the zero address", { status: "success", data: ZERO }, "none"],
    ["an answer of the wrong shape", { status: "success", data: BigInt(7) }, "unreadable"],
    ["a success with no data", { status: "success" }, "unreadable"],
  ])("%s", (_name, read, expected) => {
    expect(agentWalletReadOf(read)).toBe(expected);
  });
});

describe("agentWalletStanding", () => {
  it("another wallet than the guardian's is the agent's own", () => {
    expect(agentWalletStanding(AGENT, GUARDIAN)).toBe("own");
  });

  it("the guardian's wallet, in any letter case, is the guardian's", () => {
    expect(agentWalletStanding(GUARDIAN, GUARDIAN)).toBe("guardians");
    expect(agentWalletStanding(lower(GUARDIAN), GUARDIAN)).toBe("guardians");
    expect(agentWalletStanding(GUARDIAN, lower(GUARDIAN))).toBe("guardians");
  });

  it("no wallet is none", () => {
    expect(agentWalletStanding("none", GUARDIAN)).toBe("none");
  });
});

describe("agentWalletOwed: a record whose agent's wallet is still to be set", () => {
  it("the zero address is owed", () => {
    expect(agentWalletOwed(ZERO, GUARDIAN)).toBe(true);
  });

  it("the guardian's own wallet, in any letter case on either side, is owed", () => {
    expect(agentWalletOwed(GUARDIAN, GUARDIAN)).toBe(true);
    expect(agentWalletOwed(lower(GUARDIAN), GUARDIAN)).toBe(true);
    expect(agentWalletOwed(GUARDIAN, lower(GUARDIAN))).toBe(true);
    expect(agentWalletOwed(`0x${GUARDIAN.slice(2).toUpperCase()}` as Address, GUARDIAN)).toBe(true);
  });

  it("any other wallet is the agent's own: nothing is owed", () => {
    expect(agentWalletOwed(AGENT, GUARDIAN)).toBe(false);
    expect(agentWalletOwed(lower(AGENT), GUARDIAN)).toBe(false);
  });

  it("a value that is not an address is never said to be owed", () => {
    // The public record is checked only shallowly on arrival: a field of the wrong shape says
    // nothing rather than something false.
    for (const value of [undefined, null, 42, "", "0x00", "none"])
      expect(agentWalletOwed(value as unknown as Address, GUARDIAN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The address a person types
// ---------------------------------------------------------------------------------------------

describe("parseAgentWalletAddress", () => {
  it("an empty field, or spaces only, is empty", () => {
    expect(parseAgentWalletAddress("", GUARDIAN)).toEqual({ problem: "empty" });
    expect(parseAgentWalletAddress("  \n ", GUARDIAN)).toEqual({ problem: "empty" });
  });

  it.each([
    ["too short", "0x12"],
    ["no 0x", AGENT.slice(2)],
    ["one character too many", `${AGENT}0`],
    ["a letter that is not hex", `0x${"g".repeat(40)}`],
    ["a space inside", `${AGENT.slice(0, 20)} ${AGENT.slice(20)}`],
  ])("%s is not an address", (_name, raw) => {
    expect(parseAgentWalletAddress(raw, GUARDIAN)).toEqual({ problem: "not_address" });
  });

  it("the zero address is zero", () => {
    expect(parseAgentWalletAddress(ZERO, GUARDIAN)).toEqual({ problem: "zero" });
  });

  it("the guardian's own wallet, in another letter case, is the guardian", () => {
    expect(parseAgentWalletAddress(lower(GUARDIAN), GUARDIAN)).toEqual({ problem: "guardian" });
    expect(parseAgentWalletAddress(`0x${GUARDIAN.slice(2).toUpperCase()}`, GUARDIAN)).toEqual({
      problem: "guardian",
    });
  });

  it("a good address, trimmed and in any letter case, comes back checksummed", () => {
    expect(parseAgentWalletAddress(`  ${lower(AGENT)}\n`, GUARDIAN)).toBe(AGENT);
    expect(parseAgentWalletAddress(`0x${AGENT.slice(2).toUpperCase()}`, GUARDIAN)).toBe(AGENT);
  });
});

// ---------------------------------------------------------------------------------------------
// The deadline and the time left
// ---------------------------------------------------------------------------------------------

describe("walletSetDeadline", () => {
  it("is head + 270", () => expect(walletSetDeadline(BigInt(1000))).toBe(BigInt(1270)));

  it("leaves room under the registry's 300 seconds, and sends with 30 left at least", () => {
    expect(WALLET_SET_TTL_SECONDS).toBe(270);
    expect(WALLET_SET_SEND_MARGIN_SECONDS).toBe(30);
  });
});

describe("walletSetSecondsLeft", () => {
  it("counts down to the deadline", () => {
    expect(walletSetSecondsLeft(BigInt(1270), 1000)).toBe(270);
    expect(walletSetSecondsLeft(BigInt(1270), 1269)).toBe(1);
    expect(walletSetSecondsLeft(BigInt(1270), 1270)).toBe(0);
  });

  it("is never below 0", () => {
    expect(walletSetSecondsLeft(BigInt(1270), 1300)).toBe(0);
  });

  it("counts whole seconds, rounded down", () => {
    expect(walletSetSecondsLeft(BigInt(1270), 1000.4)).toBe(269);
  });

  it("a time that cannot be read (NaN) leaves nothing", () => {
    expect(walletSetSecondsLeft(BigInt(1270), Number.NaN)).toBe(0);
  });
});

describe("walletSetSendable", () => {
  it("sendable at 30 seconds left, not at 29", () => {
    expect(walletSetSendable(BigInt(1270), 1240)).toBe(true);
    expect(walletSetSendable(BigInt(1270), 1241)).toBe(false);
  });

  it("not with less than 30 whole seconds left, nor with a time that cannot be read", () => {
    expect(walletSetSendable(BigInt(1270), 1240.5)).toBe(false);
    expect(walletSetSendable(BigInt(1270), Number.NaN)).toBe(false);
  });

  it("sendable as soon as the message is made", () => {
    expect(walletSetSendable(walletSetDeadline(BigInt(1000)), 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The message in its two forms
// ---------------------------------------------------------------------------------------------

describe("walletSetTypedData", () => {
  it("hashes to the registry's digest", () => {
    expect(hashTypedData(walletSetTypedData(DOMAIN, M))).toBe(DIGEST);
  });

  it("leaves EIP712Domain out of the types and carries the uint256 as bigints", () => {
    const td = walletSetTypedData(DOMAIN, M);
    expect(Object.keys(td.types)).toEqual(["AgentWalletSet"]);
    expect(td.types.AgentWalletSet).toEqual([
      { name: "agentId", type: "uint256" },
      { name: "newWallet", type: "address" },
      { name: "owner", type: "address" },
      { name: "deadline", type: "uint256" },
    ]);
    expect(td.primaryType).toBe("AgentWalletSet");
    expect(td.domain).toEqual(DOMAIN);
    expect(td.message).toEqual({
      agentId: BigInt(897938),
      newWallet: M.newWallet,
      owner: M.owner,
      deadline: BigInt(1795000000),
    });
  });
});

describe("walletSetText", () => {
  it("the copy text parses back to the same digest, and carries EIP712Domain", () => {
    const parsed = JSON.parse(walletSetText(DOMAIN, M));
    expect(parsed.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    expect(hashTypedData(parsed)).toBe(DIGEST);
  });

  it("is one JSON text, two-space indent, every uint256 of the message a decimal string", () => {
    const text = walletSetText(DOMAIN, M);
    const parsed = JSON.parse(text);
    expect(text).toBe(JSON.stringify(parsed, null, 2));
    expect(Object.keys(parsed)).toEqual(["domain", "types", "primaryType", "message"]);
    expect(parsed.primaryType).toBe("AgentWalletSet");
    expect(parsed.domain).toEqual(DOMAIN);
    expect(parsed.message).toEqual({
      agentId: "897938",
      newWallet: M.newWallet,
      owner: M.owner,
      deadline: "1795000000",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The registry's domain
// ---------------------------------------------------------------------------------------------

describe("registryDomainOf", () => {
  const bend = (i: number, value: unknown) => LIVE_ANSWER.map((v, j) => (j === i ? value : v));

  it("the live answer is the domain the message is signed in", () => {
    const domain = registryDomainOf(LIVE_ANSWER, CONFIG);
    expect(domain).toEqual(DOMAIN);
    expect(hashTypedData(walletSetTypedData(domain!, M))).toBe(DIGEST);
  });

  it("the verifying contract matches in any letter case", () => {
    const config = { ...CONFIG, identityRegistry: lower(DOMAIN.verifyingContract) };
    expect(registryDomainOf(LIVE_ANSWER, config)).not.toBeNull();
  });

  it("refuses another chain id and another verifying contract", () => {
    expect(registryDomainOf(bend(3, BigInt(5042003)), CONFIG)).toBeNull();
    expect(registryDomainOf(LIVE_ANSWER, { ...CONFIG, chainId: 5042003 })).toBeNull();
    expect(registryDomainOf(bend(4, AGENT), CONFIG)).toBeNull();
    expect(registryDomainOf(LIVE_ANSWER, { ...CONFIG, identityRegistry: AGENT })).toBeNull();
  });

  it("takes the name and the version as the registry answers them", () => {
    expect(registryDomainOf(bend(1, "Another name"), CONFIG)?.name).toBe("Another name");
    expect(registryDomainOf(bend(2, "2"), CONFIG)?.version).toBe("2");
  });

  it.each<[string, unknown]>([
    ["a salt in the domain", bend(0, "0x1f")],
    ["no version in the domain", bend(0, "0x0d")],
    ["an extension", bend(6, [BigInt(1)])],
    ["a name that is not text", bend(1, 1)],
    ["a chain id that is not a uint256 as read", bend(3, "5042002")],
    ["a verifying contract that is not an address", bend(4, "0x8004")],
    ["a short answer", LIVE_ANSWER.slice(0, 5)],
    ["an object", { name: DOMAIN.name, version: "1", chainId: BigInt(5042002) }],
    ["nothing", undefined],
  ])("refuses %s", (_name, answer) => {
    expect(registryDomainOf(answer, CONFIG)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// What a pasted signature is worth
// ---------------------------------------------------------------------------------------------

describe("isErc6492Wrapped", () => {
  it.each<[string, Hex, boolean]>([
    ["ends with the marker", `0x${"ab".repeat(100)}${MARKER}`, true],
    ["the marker in upper case", `0x${"ab".repeat(100)}${MARKER.toUpperCase()}`, true],
    ["the marker alone", `0x${MARKER}`, true],
    ["a plain 65-byte signature", bytes(65), false],
    ["the marker, then more", `0x${MARKER}${"ab".repeat(65)}`, false],
    ["31 bytes of the marker", `0x${"ab".repeat(65)}${MARKER.slice(2)}`, false],
    ["nothing", "0x", false],
  ])("%s", (_name, signature, expected) => {
    expect(isErc6492Wrapped(signature)).toBe(expected);
  });
});

describe("walletSignatureVerdict", () => {
  const KEY = walletKindOf(undefined);
  const DELEGATED = walletKindOf(`0xef0100${"11".repeat(20)}`);
  const CONTRACT = walletKindOf("0x6080604052");

  type Input = Parameters<typeof walletSignatureVerdict>[0];
  /** The verdict for `AGENT` as the new wallet, with no contract asked, unless the case says. */
  const verdict = (p: Omit<Input, "newWallet" | "contractAccepts"> & Partial<Input>) =>
    walletSignatureVerdict({ newWallet: AGENT, contractAccepts: null, ...p });

  /** A fresh key as the agent's wallet, the message for it, and the message's typed form. */
  function agentKey() {
    const account = privateKeyToAccount(generatePrivateKey());
    const message: WalletSetMessage = { ...M, newWallet: account.address };
    return { account, message, typed: walletSetTypedData(DOMAIN, message) };
  }

  it("a key's own signature over the text is accepted", async () => {
    const { account, message, typed } = agentKey();
    // The agent signs the copy box's text as it stands; the page recovers over the typed form.
    const signature = await account.signTypedData(JSON.parse(walletSetText(DOMAIN, message)));
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(verdict({ kind: KEY, newWallet: message.newWallet, signature, recovered })).toEqual({
      ok: true,
    });
  });

  it("another key's signature is wrong_key", async () => {
    const { message, typed } = agentKey();
    const other = privateKeyToAccount(generatePrivateKey());
    const signature = await other.signTypedData(typed);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    expect(recovered).toBe(other.address);
    expect(verdict({ kind: KEY, newWallet: message.newWallet, signature, recovered })).toEqual({
      ok: false,
      problem: "wrong_key",
    });
  });

  it("65 bytes that do not recover are wrong_key", () => {
    expect(verdict({ kind: KEY, signature: bytes(65), recovered: null })).toEqual({
      ok: false,
      problem: "wrong_key",
    });
  });

  it("a key's 64-byte compact form of a valid signature is compact", async () => {
    const { account, message, typed } = agentKey();
    const full = await account.signTypedData(typed);
    const signature = serializeCompactSignature(signatureToCompactSignature(parseSignature(full)));
    expect(signature.length).toBe(2 + 2 * 64);
    // The same signature in 65 bytes is accepted; the compact form is refused, whether or not the
    // page could recover it.
    const recovered = await recoverTypedDataAddress({ ...typed, signature: full });
    expect(verdict({ kind: KEY, newWallet: message.newWallet, signature: full, recovered }))
      .toEqual({ ok: true });
    for (const r of [account.address, null])
      expect(verdict({ kind: KEY, newWallet: message.newWallet, signature, recovered: r }))
        .toEqual({ ok: false, problem: "compact" });
  });

  it("a 200-byte signature for an address with no code is not_on_chain", () => {
    expect(verdict({ kind: KEY, signature: bytes(200), recovered: null })).toEqual({
      ok: false,
      problem: "not_on_chain",
    });
  });

  it("any length but 64 or 65 bytes is not_on_chain for a key, even when told it recovers", () => {
    for (const n of [0, 63, 66, 130])
      expect(verdict({ kind: KEY, signature: bytes(n), recovered: AGENT })).toEqual({
        ok: false,
        problem: "not_on_chain",
      });
  });

  describe("a delegated wallet (EIP-7702)", () => {
    it("its key's own 65 bytes are ok, in any letter case", () => {
      expect(verdict({ kind: DELEGATED, signature: bytes(65), recovered: lower(AGENT) })).toEqual({
        ok: true,
      });
    });

    it("a signature that does not recover is ok when the wallet's own check says yes", () => {
      for (const n of [64, 65, 200])
        expect(
          verdict({
            kind: DELEGATED,
            signature: bytes(n),
            recovered: GUARDIAN,
            contractAccepts: true,
          }),
        ).toEqual({ ok: true });
    });

    it("65 bytes that do not recover, with no yes from the wallet, are wrong_key", () => {
      for (const contractAccepts of [false, null])
        for (const recovered of [GUARDIAN, null])
          expect(verdict({ kind: DELEGATED, signature: bytes(65), recovered, contractAccepts }))
            .toEqual({ ok: false, problem: "wrong_key" });
    });

    it("64 bytes with no yes from the wallet are compact, even when told they recover", () => {
      for (const contractAccepts of [false, null])
        expect(
          verdict({ kind: DELEGATED, signature: bytes(64), recovered: AGENT, contractAccepts }),
        ).toEqual({ ok: false, problem: "compact" });
    });

    it("any other length with no yes from the wallet is contract_refused", () => {
      for (const contractAccepts of [false, null])
        expect(
          verdict({ kind: DELEGATED, signature: bytes(200), recovered: null, contractAccepts }),
        ).toEqual({ ok: false, problem: "contract_refused" });
    });
  });

  it("a contract wallet is its own answer: accepted only when it said yes", () => {
    const contract = (contractAccepts: boolean | null, recovered: Address | null = null) =>
      verdict({ kind: CONTRACT, signature: bytes(200), recovered, contractAccepts });
    expect(contract(true)).toEqual({ ok: true });
    expect(contract(false)).toEqual({ ok: false, problem: "contract_refused" });
    expect(contract(null)).toEqual({ ok: false, problem: "contract_refused" });
    expect(contract(false, AGENT)).toEqual({ ok: false, problem: "contract_refused" });
    expect(verdict({ kind: CONTRACT, signature: bytes(65), recovered: AGENT })).toEqual({
      ok: false,
      problem: "contract_refused",
    });
  });

  it("a kind this build does not know is never ok", () => {
    const kind = "account" as WalletKind;
    expect(verdict({ kind, signature: bytes(65), recovered: AGENT, contractAccepts: true }))
      .toEqual({ ok: false, problem: "contract_refused" });
  });

  it("a signature ending in the 6492 marker is wrapped, whatever else is true", () => {
    const signature: Hex = `0x${"ab".repeat(100)}${MARKER}`;
    const kinds: WalletKind[] = [KEY, DELEGATED, CONTRACT];
    for (const kind of kinds)
      expect(verdict({ kind, signature, recovered: AGENT, contractAccepts: true })).toEqual({
        ok: false,
        problem: "wrapped",
      });
  });
});
