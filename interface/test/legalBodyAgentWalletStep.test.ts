/**
 * The agent's wallet step's view model (`agentWalletStep.ts`), each piece pure: the chain's time as
 * the step estimates it, the preparation of the message, what a pasted signature is worth once the
 * chain is asked, the check before any wallet prompt, what the screen shows for a derivation and a
 * stage, and the sentences of every refusal.
 *
 * The domain is the live testnet registry's (chain 5042002, its public address); agent ids and
 * wallets are invented. Keys that sign are made at run time and thrown away. Anvil's first two
 * published accounts stand for the guardian and the agent's wallet.
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
import {
  WALLET_SET_SEND_MARGIN_SECONDS,
  walletSetDeadline,
  walletSetTypedData,
  type RegistryDomain,
  type WalletSetMessage,
} from "@/lib/legalBody/agentWallet";
import {
  agentWalletCall,
  allowedCall,
  identityRegistryAbi,
} from "@/lib/legalBody/chain";
import {
  ERC1271_MAGIC,
  SET_AGENT_WALLET_FUNCTION,
  agentWalletLineText,
  agentWalletPrepare,
  agentWalletSendPreflight,
  agentWalletSignatureCheck,
  agentWalletStepView,
  chainClockAt,
  chainNowSeconds,
  erc1271Accepts,
  walletAddressSentence,
  walletCallRefusalSentence,
  walletPreflightSentence,
  walletSendFailureLines,
  walletSignatureSentence,
  type AgentWalletStage,
} from "@/lib/legalBody/agentWalletStep";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";

const AW = LEGAL_BODY_COPY.agentWallet;

const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const DOMAIN: RegistryDomain = {
  name: "ERC8004IdentityRegistry",
  version: "1",
  chainId: 5042002,
  verifyingContract: REGISTRY,
};
const CONFIG = {
  chainId: 5042002,
  identityRegistry: REGISTRY,
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as Address,
};
/** Anvil's first two published accounts, checksummed, and a third for "another wallet". */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const AGENT_ID = "897938";
const HEAD = BigInt(1_795_000_000);
/** An EIP-7702 delegation's code: `0xef0100` and the delegate's address. */
const DELEGATED_CODE = `0xef0100${"12".repeat(20)}` as Hex;
const CONTRACT_CODE = "0x6080604052" as Hex;
const MARKER = "6492".repeat(16);

const lower = (a: string) => a.toLowerCase() as Address;

const message = (over: Partial<WalletSetMessage> = {}): WalletSetMessage => ({
  agentId: AGENT_ID,
  newWallet: AGENT,
  owner: GUARDIAN,
  deadline: walletSetDeadline(HEAD),
  ...over,
});

/** Every string a view shows, for the template check. */
function viewStrings(v: ReturnType<typeof agentWalletStepView>): string[] {
  const out: string[] = [v.title, ...v.lines];
  for (const c of v.choices) out.push(c.title, c.line);
  if (v.noKey) out.push(v.noKey.ask, v.noKey.commandIntro, v.noKey.command);
  if (v.sign) out.push(v.sign.intro, v.sign.heading, v.sign.ask, v.sign.commandIntro, v.sign.command);
  if (v.countdown) out.push(v.countdown);
  if (v.status) out.push(v.status.text);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The chain's time (ruling R1)
// ---------------------------------------------------------------------------------------------

describe("chainNowSeconds: the chain's time, from the head and the local time since", () => {
  const clock = chainClockAt(HEAD, 10_000);

  it("is the head's timestamp at the moment it was read", () => {
    expect(clock).toEqual({ headSeconds: Number(HEAD), readAtMs: 10_000 });
    expect(chainNowSeconds(clock, 10_000)).toBe(Number(HEAD));
  });

  it("moves with the local seconds elapsed since the read, fractions included", () => {
    expect(chainNowSeconds(clock, 25_500)).toBe(Number(HEAD) + 15.5);
    expect(chainNowSeconds(clock, 10_000 + 270_000)).toBe(Number(HEAD) + 270);
  });

  it("never goes back before the head when the local clock is set back", () => {
    expect(chainNowSeconds(clock, 4_000)).toBe(Number(HEAD));
  });

  it("a local time that cannot be read leaves no time to send", () => {
    expect(Number.isNaN(chainNowSeconds(clock, Number.NaN))).toBe(true);
    expect(
      agentWalletSendPreflight({
        ownerOf: GUARDIAN,
        connected: GUARDIAN,
        deadline: walletSetDeadline(HEAD),
        nowSeconds: chainNowSeconds(clock, Number.NaN),
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  describe("a computer clock that is off does not matter: the estimate depends on the elapsed time only", () => {
    const deadline = walletSetDeadline(HEAD);
    const req = agentWalletCall(CONFIG, {
      agentId: AGENT_ID,
      newWallet: AGENT,
      deadline,
      signature: `0x${"ab".repeat(65)}`,
    });
    const ctx = (nowSeconds: number) => ({
      config: CONFIG,
      order: null,
      wallet: { agentId: AGENT_ID, guardian: GUARDIAN, nowSeconds },
    });
    const preflight = (nowSeconds: number) =>
      agentWalletSendPreflight({ ownerOf: GUARDIAN, connected: GUARDIAN, deadline, nowSeconds });

    it("31 seconds slow, at once: the bare wall clock puts the deadline past the registry's 300", () => {
      expect(allowedCall(req, ctx(Number(HEAD) - 31))).toEqual({
        ok: false,
        problem: "deadline_out_of_window",
      });
      const estimate = chainNowSeconds(chainClockAt(HEAD, 1_000_000), 1_000_000);
      expect(allowedCall(req, ctx(estimate)).ok).toBe(true);
    });

    it("four minutes fast, ten seconds on: the bare wall clock leaves under 30 seconds", () => {
      expect(preflight(Number(HEAD) + 240 + 10)).toEqual({ ok: false, reason: "expired" });
      const estimate = chainNowSeconds(chainClockAt(HEAD, 1_000_000), 1_010_000);
      expect(preflight(estimate)).toEqual({ ok: true });
      expect(allowedCall(req, ctx(estimate)).ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Before any wallet prompt
// ---------------------------------------------------------------------------------------------

describe("agentWalletSendPreflight", () => {
  const deadline = walletSetDeadline(HEAD);
  const at = (left: number) => Number(deadline) - left;
  const base = { ownerOf: GUARDIAN as Address | "none", connected: GUARDIAN as Address | null, deadline };

  it("passes for the owner connected, with time left", () => {
    expect(agentWalletSendPreflight({ ...base, nowSeconds: at(200) })).toEqual({ ok: true });
  });

  it("the owner in another letter case is the same wallet", () => {
    expect(
      agentWalletSendPreflight({ ...base, connected: lower(GUARDIAN), nowSeconds: at(200) }),
    ).toEqual({ ok: true });
  });

  it("no identity with this id now: no_identity", () => {
    expect(agentWalletSendPreflight({ ...base, ownerOf: "none", nowSeconds: at(200) })).toEqual({
      ok: false,
      reason: "no_identity",
    });
  });

  it.each([
    ["no wallet connected", null],
    ["another wallet connected", OTHER],
  ])("%s: not_this_wallet", (_name, connected) => {
    expect(agentWalletSendPreflight({ ...base, connected, nowSeconds: at(200) })).toEqual({
      ok: false,
      reason: "not_this_wallet",
    });
  });

  it("the identity moved to another key since the message: not_this_wallet", () => {
    expect(agentWalletSendPreflight({ ...base, ownerOf: OTHER, nowSeconds: at(200) })).toEqual({
      ok: false,
      reason: "not_this_wallet",
    });
  });

  it("29 seconds left: expired; 30 seconds left: still sendable", () => {
    expect(WALLET_SET_SEND_MARGIN_SECONDS).toBe(30);
    expect(agentWalletSendPreflight({ ...base, nowSeconds: at(29) })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(agentWalletSendPreflight({ ...base, nowSeconds: at(29.5) })).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(agentWalletSendPreflight({ ...base, nowSeconds: at(30) })).toEqual({ ok: true });
  });

  it("past the deadline: expired", () => {
    expect(agentWalletSendPreflight({ ...base, nowSeconds: at(-5) })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("says the first reason in order: the identity, the wallet, then the time", () => {
    expect(
      agentWalletSendPreflight({ ownerOf: "none", connected: null, deadline, nowSeconds: at(0) }),
    ).toEqual({ ok: false, reason: "no_identity" });
    expect(
      agentWalletSendPreflight({ ownerOf: GUARDIAN, connected: null, deadline, nowSeconds: at(0) }),
    ).toEqual({ ok: false, reason: "not_this_wallet" });
  });
});

// ---------------------------------------------------------------------------------------------
// "Prepare the message"
// ---------------------------------------------------------------------------------------------

describe("agentWalletPrepare", () => {
  const base = {
    choice: "has_key" as const,
    agentId: AGENT_ID,
    newWallet: AGENT as Address,
    ownerOf: GUARDIAN as Address | "none" | "unreadable",
    connected: GUARDIAN as Address | null,
    domain: DOMAIN as RegistryDomain | null,
    code: undefined as Hex | undefined,
    headTimestamp: HEAD,
    environment: "sandbox" as const,
  };

  it("builds the message for the identity's owner, valid 270 seconds from the head", () => {
    expect(agentWalletPrepare(base)).toEqual({
      ok: true,
      domain: DOMAIN,
      message: { agentId: AGENT_ID, newWallet: AGENT, owner: GUARDIAN, deadline: HEAD + BigInt(270) },
    });
  });

  it("the provider choice is refused for an address with no code, and no message is prepared", () => {
    for (const code of [undefined, "0x" as Hex]) {
      const prepared = agentWalletPrepare({ ...base, choice: "provider", code });
      expect(prepared).toEqual({
        ok: false,
        line: fillCopy(AW.signatureProblems.not_on_chain, { network: "Arc testnet" }),
      });
      expect("message" in prepared).toBe(false);
    }
    expect(agentWalletPrepare({ ...base, choice: "provider", environment: "production" })).toEqual({
      ok: false,
      line: fillCopy(AW.signatureProblems.not_on_chain, { network: "Arc" }),
    });
  });

  it.each([
    ["a contract wallet", CONTRACT_CODE],
    ["a delegated key", DELEGATED_CODE],
  ])("the provider choice takes %s, which exists on the chain", (_name, code) => {
    expect(agentWalletPrepare({ ...base, choice: "provider", code }).ok).toBe(true);
  });

  it.each(["has_key", "no_key"] as const)("%s takes a key with no code, and a wallet with code", (choice) => {
    expect(agentWalletPrepare({ ...base, choice }).ok).toBe(true);
    expect(agentWalletPrepare({ ...base, choice, code: CONTRACT_CODE }).ok).toBe(true);
  });

  it("an owner that could not be read: the registry could not be read", () => {
    expect(agentWalletPrepare({ ...base, ownerOf: "unreadable" })).toEqual({
      ok: false,
      line: AW.unreadable,
    });
  });

  it("a domain that is not the deployment's: no message", () => {
    expect(agentWalletPrepare({ ...base, domain: null })).toEqual({
      ok: false,
      line: AW.domainMismatch,
    });
  });

  it("no identity, or an identity this wallet does not own: refused before any message", () => {
    expect(agentWalletPrepare({ ...base, ownerOf: "none" })).toEqual({
      ok: false,
      line: fillCopy(AW.noIdentity, { agentId: AGENT_ID, network: "Arc testnet" }),
    });
    expect(agentWalletPrepare({ ...base, ownerOf: OTHER })).toEqual({
      ok: false,
      line: AW.notThisWallet,
    });
    expect(agentWalletPrepare({ ...base, connected: null })).toEqual({
      ok: false,
      line: AW.notThisWallet,
    });
  });

  it("the owner in the message is the registry's answer, in its own letter case", () => {
    const prepared = agentWalletPrepare({ ...base, connected: lower(GUARDIAN) });
    expect(prepared.ok && prepared.message.owner).toBe(GUARDIAN);
  });
});

// ---------------------------------------------------------------------------------------------
// What a pasted signature is worth, once the chain is asked
// ---------------------------------------------------------------------------------------------

describe("agentWalletSignatureCheck", () => {
  type Deps = Parameters<typeof agentWalletSignatureCheck>[0];
  const asked = { recover: 0, isValidSignature: 0 };
  const reset = () => {
    asked.recover = 0;
    asked.isValidSignature = 0;
  };

  async function signed(m: WalletSetMessage, key = generatePrivateKey()) {
    const account = privateKeyToAccount(key);
    const typed = walletSetTypedData(DOMAIN, { ...m, newWallet: account.address });
    return { account, typed, signature: await account.signTypedData(typed) };
  }

  /** The step's deps for one signature: real recovery, the code and the wallet's answer given. */
  function deps(p: {
    newWallet: Address;
    signature: Hex;
    typed: ReturnType<typeof walletSetTypedData>;
    code?: () => Promise<Hex | undefined>;
    isValidSignature?: () => Promise<unknown>;
  }): Deps {
    return {
      newWallet: p.newWallet,
      signature: p.signature,
      readCode: p.code ?? (async () => undefined),
      recover: () => {
        asked.recover += 1;
        return recoverTypedDataAddress({ ...p.typed, signature: p.signature });
      },
      isValidSignature: () => {
        asked.isValidSignature += 1;
        return (p.isValidSignature ?? (async () => "0xffffffff"))();
      },
    };
  }

  const revert = Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError" });

  it("a key's 65-byte signature over the message is accepted, and no wallet is asked", async () => {
    reset();
    const s = await signed(message());
    const check = await agentWalletSignatureCheck(deps({ ...s, newWallet: s.account.address }));
    expect(check).toEqual({ ok: true });
    expect(asked.isValidSignature).toBe(0);
  });

  it("another key's signature is wrong_key", async () => {
    const s = await signed(message());
    const other = privateKeyToAccount(generatePrivateKey());
    const check = await agentWalletSignatureCheck(deps({ ...s, newWallet: other.address }));
    expect(check).toEqual({ ok: false, problem: "wrong_key" });
  });

  it("the 64-byte compact form is compact: viem's recovery throws on it and is caught", async () => {
    const s = await signed(message());
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(s.signature)));
    expect((compact.length - 2) / 2).toBe(64);
    await expect(recoverTypedDataAddress({ ...s.typed, signature: compact })).rejects.toThrow();
    const check = await agentWalletSignatureCheck(
      deps({ ...s, signature: compact, newWallet: s.account.address }),
    );
    expect(check).toEqual({ ok: false, problem: "compact" });
  });

  it("a wrapped signature is wrapped, whatever the wallet says", async () => {
    const s = await signed(message());
    const wrapped = `${s.signature}${"00".repeat(32)}${MARKER}` as Hex;
    const check = await agentWalletSignatureCheck(
      deps({ ...s, signature: wrapped, newWallet: s.account.address, isValidSignature: async () => ERC1271_MAGIC }),
    );
    expect(check).toEqual({ ok: false, problem: "wrapped" });
  });

  it("a contract wallet is asked: its yes is accepted, no recovery made", async () => {
    reset();
    const s = await signed(message());
    const check = await agentWalletSignatureCheck(
      deps({
        ...s,
        newWallet: OTHER,
        code: async () => CONTRACT_CODE,
        isValidSignature: async () => ERC1271_MAGIC,
      }),
    );
    expect(check).toEqual({ ok: true });
    expect(asked).toEqual({ recover: 0, isValidSignature: 1 });
  });

  it.each([
    ["answers other bytes", async () => "0xffffffff"],
    ["reverts", async () => Promise.reject(revert)],
  ])("a contract wallet that %s: contract_refused", async (_name, isValidSignature) => {
    const s = await signed(message());
    const check = await agentWalletSignatureCheck(
      deps({ ...s, newWallet: OTHER, code: async () => CONTRACT_CODE, isValidSignature }),
    );
    expect(check).toEqual({ ok: false, problem: "contract_refused" });
  });

  it("a contract wallet whose answer could not be read: unreadable, never a refusal", async () => {
    const s = await signed(message());
    const check = await agentWalletSignatureCheck(
      deps({
        ...s,
        newWallet: OTHER,
        code: async () => CONTRACT_CODE,
        isValidSignature: async () => Promise.reject(new Error("offline")),
      }),
    );
    expect(check).toEqual({ ok: false, problem: "unreadable" });
  });

  it("a delegated key whose own key signed: accepted, the wallet not asked", async () => {
    reset();
    const s = await signed(message());
    const check = await agentWalletSignatureCheck(
      deps({ ...s, newWallet: s.account.address, code: async () => DELEGATED_CODE }),
    );
    expect(check).toEqual({ ok: true });
    expect(asked).toEqual({ recover: 1, isValidSignature: 0 });
  });

  it("a delegated key whose recovery does not match is asked, as a contract wallet is", async () => {
    reset();
    const s = await signed(message());
    const yes = await agentWalletSignatureCheck(
      deps({ ...s, newWallet: OTHER, code: async () => DELEGATED_CODE, isValidSignature: async () => ERC1271_MAGIC }),
    );
    expect(yes).toEqual({ ok: true });
    expect(asked.isValidSignature).toBe(1);
    const no = await agentWalletSignatureCheck(
      deps({ ...s, newWallet: OTHER, code: async () => DELEGATED_CODE }),
    );
    expect(no).toEqual({ ok: false, problem: "wrong_key" });
  });

  it("a code that could not be read: unreadable", async () => {
    const s = await signed(message());
    const check = await agentWalletSignatureCheck(
      deps({ ...s, newWallet: s.account.address, code: async () => Promise.reject(new Error("offline")) }),
    );
    expect(check).toEqual({ ok: false, problem: "unreadable" });
  });

  it("the digest the wallet is asked over is the registry's for the message", () => {
    const typed = walletSetTypedData(DOMAIN, message());
    expect(hashTypedData(typed)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("erc1271Accepts", () => {
  it("only the magic value, in any letter case", () => {
    expect(ERC1271_MAGIC).toBe("0x1626ba7e");
    expect(erc1271Accepts("0x1626ba7e")).toBe(true);
    expect(erc1271Accepts("0x1626BA7E")).toBe(true);
    for (const other of ["0xffffffff", "0x", "0x1626ba7e00", 1, null, undefined, true])
      expect(erc1271Accepts(other)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// What the screen shows
// ---------------------------------------------------------------------------------------------

describe("agentWalletStepView", () => {
  const base = {
    walletStep: "needed" as const,
    branch: "browser" as const,
    read: GUARDIAN as Address | "none" | "unreadable" | null,
    guardian: GUARDIAN as Address,
    stage: { at: "choose" } as AgentWalletStage,
    secondsLeft: null as number | null,
    environment: "sandbox" as const,
  };
  const prepared: AgentWalletStage = { at: "message", message: message(), domain: DOMAIN };

  it("checking: one line, nothing to click", () => {
    const v = agentWalletStepView({ ...base, walletStep: "checking", read: null });
    expect(v.title).toBe(AW.title);
    expect(v.lines).toEqual([AW.checking]);
    expect(v.panel).toBe("checking");
    expect(v.choices).toEqual([]);
    expect(v.addressField).toBe(false);
    expect(v.signatureField).toBe(false);
    expect(v.button).toBeNull();
  });

  it("unreadable: the line and Try again", () => {
    const v = agentWalletStepView({ ...base, walletStep: "unreadable", read: "unreadable" });
    expect(v.lines).toEqual([AW.unreadable]);
    expect(v.panel).toBe("unreadable");
    expect(v.button).toBe("retry");
    expect(v.choices).toEqual([]);
  });

  it("needed, the registry naming the guardian's own wallet: why, today, and the three choices", () => {
    const v = agentWalletStepView(base);
    expect(v.lines).toEqual([AW.why, AW.todayGuardian]);
    expect(v.panel).toBe("browser");
    expect(v.choices.map((c) => c.choice)).toEqual(["has_key", "no_key", "provider"]);
    expect(v.choices.map((c) => c.title)).toEqual([AW.hasKeyTitle, AW.noKeyTitle, AW.providerTitle]);
    expect(v.choices.every((c) => !c.chosen)).toBe(true);
    expect(v.addressField).toBe(false);
    expect(v.signatureField).toBe(false);
    expect(v.button).toBeNull();
  });

  it("needed, the guardian's wallet in another letter case: still the guardian's", () => {
    expect(agentWalletStepView({ ...base, read: lower(GUARDIAN) }).lines).toEqual([AW.why, AW.todayGuardian]);
  });

  it("needed, the registry naming no wallet", () => {
    expect(agentWalletStepView({ ...base, read: "none" }).lines).toEqual([AW.why, AW.todayNone]);
  });

  it("the paste branch: the owning key must write it; no field and no send button", () => {
    const v = agentWalletStepView({ ...base, branch: "paste" });
    expect(v.panel).toBe("elsewhere");
    expect(v.lines).toEqual([AW.why, AW.todayGuardian]);
    expect(v.status?.text).toBe(AW.elsewhere);
    expect(v.choices).toEqual([]);
    expect(v.addressField).toBe(false);
    expect(v.signatureField).toBe(false);
    expect(v.sign).toBeNull();
    expect(v.button).toBe("check_again");
    // Whatever stage the step holds, the paste branch never offers a field or a send.
    const later = agentWalletStepView({ ...base, branch: "paste", stage: prepared, secondsLeft: 200 });
    expect(later.addressField || later.signatureField).toBe(false);
    expect(later.button).toBe("check_again");
  });

  it("a choice opens the address field and Prepare the message", () => {
    const v = agentWalletStepView({ ...base, stage: { at: "address", choice: "has_key" } });
    expect(v.choices.find((c) => c.chosen)?.choice).toBe("has_key");
    expect(v.addressField).toBe(true);
    expect(v.button).toBe("prepare");
    expect(v.noKey).toBeNull();
    expect(v.choices.find((c) => c.choice === "has_key")?.line).toBe(AW.hasKeyLine);
  });

  it("the provider choice says the wallet must already exist on the network", () => {
    const v = agentWalletStepView({ ...base, stage: { at: "address", choice: "provider" } });
    expect(v.choices.find((c) => c.choice === "provider")?.line).toBe(
      fillCopy(AW.providerLine, { network: "Arc testnet" }),
    );
    expect(v.addressField).toBe(true);
    expect(v.button).toBe("prepare");
  });

  it("the provider choice refused at preparation stays on its address, with Prepare the message", () => {
    // `agentWalletPrepare` refused the address (no code), so the stage did not move.
    const refused = agentWalletPrepare({
      choice: "provider",
      agentId: AGENT_ID,
      newWallet: AGENT,
      ownerOf: GUARDIAN,
      connected: GUARDIAN,
      domain: DOMAIN,
      code: undefined,
      headTimestamp: HEAD,
      environment: "sandbox",
    });
    expect(refused.ok).toBe(false);
    const v = agentWalletStepView({ ...base, stage: { at: "address", choice: "provider" } });
    expect(v.sign).toBeNull();
    expect(v.signatureField).toBe(false);
    expect(v.button).toBe("prepare");
  });

  it("no key yet: how to make one where the agent runs, then the same field; the page makes none", () => {
    const v = agentWalletStepView({ ...base, stage: { at: "address", choice: "no_key" } });
    expect(v.noKey).toEqual({
      ask: AW.noKeyAsk,
      commandIntro: AW.noKeyCommandIntro,
      command: AW.noKeyCommand,
    });
    expect(v.addressField).toBe(true);
    expect(v.button).toBe("prepare");
  });

  it("the prepared message: the ways to sign, the countdown with its seconds, the field and the send", () => {
    const v = agentWalletStepView({ ...base, stage: prepared, choice: "has_key", secondsLeft: 200 });
    expect(v.sign).toEqual({
      intro: AW.messageIntro,
      heading: AW.messageHeading,
      ask: AW.signAsk,
      commandIntro: AW.signCommandIntro,
      command: AW.signCommand,
    });
    expect(v.countdown).toBe("Valid for 200 more seconds.");
    expect(v.countdown).toBe(fillCopy(AW.countdown, { seconds: "200" }));
    expect(v.signatureField).toBe(true);
    expect(v.button).toBe("send");
    expect(v.status).toBeNull();
    expect(v.choices.find((c) => c.chosen)?.choice).toBe("has_key");
  });

  it("at 30 seconds left the send is still offered", () => {
    const v = agentWalletStepView({ ...base, stage: prepared, choice: "has_key", secondsLeft: 30 });
    expect(v.button).toBe("send");
    expect(v.countdown).toBe(fillCopy(AW.countdown, { seconds: "30" }));
  });

  it.each([29, 1, 0])(
    "expired at %i seconds left: no send, no field, the message gone, Prepare the message offered",
    (secondsLeft) => {
      const v = agentWalletStepView({ ...base, stage: prepared, choice: "has_key", secondsLeft });
      expect(v.button).toBe("prepare");
      expect(v.status).toEqual({ text: AW.expired, tone: "warn", busy: false });
      expect(v.signatureField).toBe(false);
      expect(v.sign).toBeNull();
      expect(v.countdown).toBeNull();
      expect(v.addressField).toBe(true);
    },
  );

  it("a message with no time known reads as expired", () => {
    expect(agentWalletStepView({ ...base, stage: prepared, choice: "has_key" }).button).toBe("prepare");
  });

  it("while the wallet is open: its line and nothing to click", () => {
    const v = agentWalletStepView({ ...base, stage: { at: "sending" }, choice: "has_key" });
    expect(v.status).toEqual({ text: AW.sending, tone: "info", busy: true });
    expect(v.button).toBeNull();
    expect(v.choices).toEqual([]);
    expect(v.addressField || v.signatureField).toBe(false);
  });

  it("once sent: waiting for the registry, with Check again", () => {
    const hash = `0x${"cd".repeat(32)}` as Hex;
    const v = agentWalletStepView({ ...base, stage: { at: "waiting", hash }, choice: "has_key" });
    expect(v.status).toEqual({ text: AW.waiting, tone: "info", busy: true });
    expect(v.button).toBe("check_again");
    expect(v.choices).toEqual([]);
    expect(v.addressField || v.signatureField).toBe(false);
  });

  it.each([
    ["reverted", AW.reverted],
    ["would_revert", AW.wouldRevert],
  ] as const)("%s: said plainly, and a new message offered", (at, text) => {
    const v = agentWalletStepView({ ...base, stage: { at }, choice: "provider" });
    expect(v.status).toEqual({ text, tone: "warn", busy: false });
    expect(v.button).toBe("prepare");
    expect(v.addressField).toBe(true);
    expect(v.signatureField).toBe(false);
    expect(v.choices.find((c) => c.chosen)?.choice).toBe("provider");
  });

  it("no template is left half-filled in any view", () => {
    const stages: AgentWalletStage[] = [
      { at: "choose" },
      { at: "address", choice: "has_key" },
      { at: "address", choice: "no_key" },
      { at: "address", choice: "provider" },
      prepared,
      { at: "sending" },
      { at: "waiting", hash: `0x${"cd".repeat(32)}` },
      { at: "reverted" },
      { at: "would_revert" },
    ];
    for (const environment of ["sandbox", "production"] as const)
      for (const branch of ["browser", "paste"] as const)
        for (const walletStep of ["checking", "unreadable", "needed"] as const)
          for (const stage of stages)
            for (const secondsLeft of [null, 0, 200]) {
              const v = agentWalletStepView({
                ...base,
                walletStep,
                branch,
                stage,
                secondsLeft,
                environment,
                choice: "provider",
              });
              for (const s of viewStrings(v)) expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
            }
  });
});

describe("agentWalletLineText: the line on the link screens", () => {
  it("names the wallet when the registry names one", () => {
    expect(agentWalletLineText(AGENT)).toBe(`This agent's wallet: ${AGENT}`);
    expect(agentWalletLineText(AGENT)).toBe(fillCopy(AW.line, { address: AGENT }));
  });

  it.each([null, "none", "unreadable"] as const)("says nothing for %s", (read) => {
    expect(agentWalletLineText(read)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------------

describe("the sentences of the step", () => {
  it("an address that is not one, the zero address, the guardian's own", () => {
    expect(walletAddressSentence("not_address")).toBe(AW.addressProblems.not_address);
    // An empty field is not an address either.
    expect(walletAddressSentence("empty")).toBe(AW.addressProblems.not_address);
    expect(walletAddressSentence("zero")).toBe(AW.addressProblems.zero);
    expect(walletAddressSentence("guardian")).toBe(AW.addressProblems.guardian);
  });

  it.each(["wrong_key", "compact", "wrapped", "not_on_chain", "contract_refused"] as const)(
    "the signature refused as %s has its sentence, the network named",
    (problem) => {
      const s = walletSignatureSentence(problem, "sandbox");
      expect(s).toBe(fillCopy(AW.signatureProblems[problem], { network: "Arc testnet" }));
      expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
    },
  );

  it("the compact signature's sentence asks for the 65-byte form", () => {
    expect(AW.signatureProblems.compact).toBe(
      "This is a compact signature of 64 bytes. The registry takes the usual 65-byte form: sign again without the compact option.",
    );
  });

  it("a signature check the chain could not answer: the registry could not be read", () => {
    expect(walletSignatureSentence("unreadable", "sandbox")).toBe(AW.unreadable);
  });

  it("each preflight reason", () => {
    const p = { agentId: AGENT_ID, environment: "production" as const };
    expect(walletPreflightSentence("no_identity", p)).toBe(
      fillCopy(AW.noIdentity, { agentId: AGENT_ID, network: "Arc" }),
    );
    expect(walletPreflightSentence("not_this_wallet", p)).toBe(AW.notThisWallet);
    expect(walletPreflightSentence("expired", p)).toBe(AW.expired);
  });

  const ALLOWLIST = [
    "no_wallet_context",
    "set_agent_wallet_args",
    "other_identity",
    "wallet_is_zero",
    "wallet_is_guardian",
    "deadline_out_of_window",
    "signature_shape",
    "sends_value",
    "wrong_chain",
    "not_the_registry",
    "not_the_pinned_abi",
  ] as const;

  it.each(ALLOWLIST)("the allowlist's %s: its own sentence, which says nothing was sent", (problem) => {
    const s = walletCallRefusalSentence(problem, "sandbox");
    expect(s).toBe(AW.callProblems[problem]);
    expect(s).toContain("Nothing was sent.");
    expect(s).not.toContain(problem);
  });

  it("the two chain checks name the network", () => {
    expect(walletCallRefusalSentence("wallet_on_another_chain", "sandbox")).toBe(
      fillCopy(AW.callProblems.wallet_on_another_chain, { network: "Arc testnet" }),
    );
    expect(walletCallRefusalSentence("chain_not_configured", "production")).toBe(
      fillCopy(AW.callProblems.chain_not_configured, { network: "Arc" }),
    );
  });

  it("a problem this page does not know is named, never hidden", () => {
    expect(walletCallRefusalSentence("not_allowed", "sandbox")).toBe(
      fillCopy(AW.callRefused, { problem: "not_allowed" }),
    );
  });

  it("every allowlist problem of setAgentWallet has its sentence", () => {
    expect(Object.keys(AW.callProblems).sort()).toEqual(
      [...ALLOWLIST, "wallet_on_another_chain", "chain_not_configured"].sort(),
    );
  });

  it("the wallet's no, or a wallet that failed: declined, said plainly", () => {
    const no = Object.assign(new Error("User rejected the request."), { code: 4001 });
    expect(walletSendFailureLines(no, "sandbox")).toEqual([AW.declined]);
    expect(walletSendFailureLines(new Error("something broke"), "sandbox")).toEqual([AW.declined]);
    expect(walletSendFailureLines("not an error", "sandbox")).toEqual([AW.declined]);
  });

  it("a wallet that cannot pay the gas: where the native USDC comes from", () => {
    const poor = Object.assign(new Error("insufficient funds"), { name: "InsufficientFundsError" });
    expect(walletSendFailureLines(poor, "sandbox")).toEqual([LEGAL_BODY_COPY.pointer.gas]);
    expect(walletSendFailureLines(poor, "production")).toEqual([LEGAL_BODY_COPY.pointer.gasProduction]);
  });
});

describe("the function the owning key calls", () => {
  it("is the registry's setAgentWallet, as the pinned ABI names it", () => {
    const fragment = identityRegistryAbi.find((f) => f.type === "function" && f.name === "setAgentWallet");
    expect(fragment).toBeDefined();
    const types = fragment && "inputs" in fragment ? fragment.inputs.map((i) => i.type).join(",") : "";
    expect(SET_AGENT_WALLET_FUNCTION).toBe(`setAgentWallet(${types})`);
  });
});
