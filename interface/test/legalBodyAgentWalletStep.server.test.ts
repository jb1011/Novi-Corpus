/**
 * The agent's wallet step, rendered as the server renders it, with every effect run at once as the
 * browser would run it, and the clock a fake one.
 *
 * Before any click the step says why it is there and what the registry names today, and offers the
 * three choices: rendering reads nothing from the chain, opens no wallet and sends nothing. On the
 * paste branch the panel says what the owning key must do and offers "Check again" only; the
 * registry is read again every 30 seconds for two minutes, never at once. The source pins the rest:
 * the one way to the wallet is the allowlist, the five-minute window is checked before it, nothing
 * typed reaches a browser store, and the page never makes a key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ allowedWrites: 0, chainReads: 0, effects: 0, signatures: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // As the browser would: an effect runs, here at once, so whatever it does shows in the spies.
    useEffect: (effect: () => void) => {
      calls.effects += 1;
      effect();
    },
  };
});

vi.mock("@/lib/api/legalBodyHooks", () => ({
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
}));

vi.mock("wagmi", async (importOriginal) => {
  /** Every method a step could ask of the public client, each one counted. */
  const read = () => {
    calls.chainReads += 1;
    throw new Error("not in this test");
  };
  const client = {
    getBlock: read,
    getCode: read,
    readContract: read,
    simulateContract: read,
    waitForTransactionReceipt: read,
  };
  /** The browser wallet's signature, counted: rendering must never ask for one. */
  const signTypedDataAsync = async () => {
    calls.signatures += 1;
    throw new Error("not in this test");
  };
  return {
    ...(await importOriginal<typeof import("wagmi")>()),
    usePublicClient: () => client,
    // The guardian selected, and a second account of the same wallet connected to the site.
    useConnection: () => ({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      addresses: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
      chainId: 5042002,
    }),
    useSignTypedData: () => ({ signTypedDataAsync }),
  };
});

import { AgentWalletStep } from "@/components/legalBody/AgentWalletStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import type { LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import type { AgentWalletRead } from "@/lib/legalBody/agentWallet";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";
import { POINTER_WATCH_MS, POINTER_WATCH_WINDOW_MS } from "@/lib/legalBody/paste";

const AW = LEGAL_BODY_COPY.agentWallet;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const AGENT_ID = "897938";

const config = (): Extract<LegalBodyConfig, { available: true }> => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: REGISTRY,
  factory: FACTORY,
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
});

const order = (): LegalBodyOrderView => ({
  id: "lbo_draft",
  publicId: "pub_draft",
  companyId: "co_test",
  state: "draft",
  chainId: 5042002,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"11".repeat(32)}`, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
});

const NEEDED: LegalBodyDerivation = { phase: "wallet", walletStep: "needed", branch: "browser" };
const PASTE: LegalBodyDerivation = { phase: "wallet", walletStep: "needed", branch: "paste" };

function kit(derivation: LegalBodyDerivation, agentWallet: AgentWalletRead | null = GUARDIAN): LegalBodyStepKit {
  const o = order();
  return {
    config: config(),
    tenant: GUARDIAN,
    derivation,
    companyId: "co_test",
    orderId: o.id,
    company: null,
    order: o,
    orders: [o],
    remember: vi.fn(),
    startAnother: vi.fn(),
    routeSignIn: vi.fn(() => false),
    door: "declare",
    agentWallet,
    refreshAgentWallet: vi.fn(async () => {}),
  };
}

const markup = (k: LegalBodyStepKit) =>
  renderToString(createElement(AgentWalletStep, { kit: k, agentId: AGENT_ID }));

/** Whether the markup holds a button labelled exactly `label`. */
function hasButton(m: string, label: string): boolean {
  return [...m.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].some(
    ([, inner]) => inner.replace(/<[^>]*>/g, "").trim() === label,
  );
}

/** The text a person reads: the markup's tags dropped and its escapes undone. */
function text(m: string): string {
  return m
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.allowedWrites = 0;
  calls.chainReads = 0;
  calls.effects = 0;
  calls.signatures = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the browser branch, before any click", () => {
  test("why, what the registry names today, and the three choices", () => {
    const page = text(markup(kit(NEEDED)));
    expect(page).toContain(LEGAL_BODY_COPY.rail.labels.wallet);
    expect(page).toContain(AW.title);
    expect(page).toContain(AW.why);
    expect(page).toContain(AW.todayGuardian);
    for (const title of [AW.hasKeyTitle, AW.noKeyTitle, AW.providerTitle]) expect(page).toContain(title);
    expect(page).toContain(`${LEGAL_BODY_COPY.identity.yourIdentity} ${AGENT_ID}`);
  });

  test("a registry naming no wallet says so", () => {
    const page = text(markup(kit(NEEDED, "none")));
    expect(page).toContain(AW.todayNone);
    expect(page).not.toContain(AW.todayGuardian);
  });

  test("no wallet button, no field, no message before a choice", () => {
    const m = markup(kit(NEEDED));
    expect(hasButton(m, AW.send)).toBe(false);
    expect(hasButton(m, AW.prepare)).toBe(false);
    expect(m).not.toContain("<input");
    expect(m).not.toContain("<textarea");
    expect(text(m)).not.toContain(AW.messageIntro);
    expect(text(m)).not.toContain(AW.noKeyCommand);
  });

  test("no account button before a choice, though another account is connected", () => {
    const m = markup(kit(NEEDED));
    expect(text(m)).not.toContain(AW.otherAccountTitle);
    expect(text(m)).not.toContain("Sign with 0x");
  });

  test("rendering, effects included, reads no chain, opens no wallet and remembers nothing", () => {
    const k = kit(NEEDED);
    markup(k);
    vi.advanceTimersByTime(10 * 60_000);
    expect(calls.effects).toBeGreaterThan(0);
    expect(calls.allowedWrites).toBe(0);
    expect(calls.chainReads).toBe(0);
    expect(calls.signatures).toBe(0);
    expect(k.refreshAgentWallet).not.toHaveBeenCalled();
    expect(k.remember).not.toHaveBeenCalled();
    expect(k.startAnother).not.toHaveBeenCalled();
  });
});

describe("the paste branch", () => {
  test("the owning key must write it: the sentence, the registry, the function, and Check again", () => {
    const m = markup(kit(PASTE));
    const page = text(m);
    expect(page).toContain(AW.elsewhere);
    expect(page).toContain(REGISTRY);
    expect(page).toContain("setAgentWallet(uint256,address,uint256,bytes)");
    expect(page).toContain(AGENT_ID);
    expect(hasButton(m, AW.checkAgain)).toBe(true);
  });

  test("no field, no send button, no choices, no wallet", () => {
    const m = markup(kit(PASTE));
    expect(m).not.toContain("<input");
    expect(m).not.toContain("<textarea");
    expect(hasButton(m, AW.send)).toBe(false);
    expect(hasButton(m, AW.prepare)).toBe(false);
    expect(text(m)).not.toContain(AW.hasKeyTitle);
    expect(calls.allowedWrites).toBe(0);
    expect(calls.chainReads).toBe(0);
  });

  test("the registry is read again every 30 seconds for two minutes, never at once, then no more", () => {
    const k = kit(PASTE);
    markup(k);
    expect(k.refreshAgentWallet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(POINTER_WATCH_MS - 1);
    expect(k.refreshAgentWallet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(k.refreshAgentWallet).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(POINTER_WATCH_WINDOW_MS);
    const reads = POINTER_WATCH_WINDOW_MS / POINTER_WATCH_MS;
    expect(k.refreshAgentWallet).toHaveBeenCalledTimes(reads);
    vi.advanceTimersByTime(30 * 60_000);
    expect(k.refreshAgentWallet).toHaveBeenCalledTimes(reads);
    expect(calls.allowedWrites).toBe(0);
    expect(calls.chainReads).toBe(0);
  });
});

describe("while the registry is read, or could not be", () => {
  test("checking: one line, nothing to click", () => {
    const m = markup(kit({ phase: "wallet", walletStep: "checking", branch: "browser" }, null));
    expect(text(m)).toContain(AW.checking);
    expect(m).not.toContain("<button");
  });

  test("unreadable: the line and Try again", () => {
    const m = markup(kit({ phase: "wallet", walletStep: "unreadable", branch: "browser" }, "unreadable"));
    expect(text(m)).toContain(AW.unreadable);
    expect(hasButton(m, AW.retry)).toBe(true);
    expect(text(m)).not.toContain(AW.hasKeyTitle);
  });
});

describe("the step's source", () => {
  const code = readFileSync(
    fileURLToPath(new URL("../src/components/legalBody/AgentWalletStep.tsx", import.meta.url)),
    "utf8",
  );

  test("the one way to the wallet is the allowlist: no other write, no key", () => {
    expect(code).toContain("useAllowedWrite()");
    for (const reach of [
      "useWriteContract",
      "writeContract",
      "useSendTransaction",
      "sendTransaction",
      "sendAllowedCall",
      "signMessage",
      "apiKey",
      "x-api-key",
    ])
      expect(code).not.toContain(reach);
  });

  test("the one signature asked of the browser wallet: the step's own message, from the agent's account named", () => {
    expect(code).toContain("useSignTypedData()");
    // One call site, and it names the account: never the guardian's selected account by default.
    expect(code.match(/signTypedDataAsync\(/g)).toHaveLength(1);
    expect(code).toMatch(/signTypedDataAsync\(\{\s*\.\.\.walletSetTypedData\([^)]*\),\s*account\s*\}\)/);
    // The offered accounts never include the guardian or the identity's owner.
    expect(code).toContain("browserAgentAccounts(");
    // The browser's signature fills the field: the send parses and checks it as a pasted one.
    const signAt = code.indexOf("signTypedDataAsync({");
    const sendAt = code.indexOf("await send(");
    expect(signAt).toBeGreaterThan(0);
    expect(code.slice(signAt, signAt + 600)).toContain("setSignatureDraft(");
    expect(code.slice(code.lastIndexOf("async function onSend", sendAt), sendAt)).toContain(
      "parsePastedSignature(signatureDraft)",
    );
  });

  test("the page never makes a key", () => {
    for (const make of ["generatePrivateKey", "privateKeyToAccount", "mnemonic", "viem/accounts"])
      expect(code).not.toContain(make);
  });

  test("nothing typed reaches a browser store", () => {
    for (const store of ["writeLegalBodyMemory", "localStorage", "sessionStorage", "remember("])
      expect(code).not.toContain(store);
  });

  test("before the wallet: the time and the owner, then the simulation; every timer is a lifetime's", () => {
    const send = code.indexOf("await send(");
    expect(send).toBeGreaterThan(0);
    const preflight = code.lastIndexOf("agentWalletSendPreflight(", send);
    const simulate = code.lastIndexOf("simulateContract(", send);
    expect(preflight).toBeGreaterThan(0);
    expect(simulate).toBeGreaterThan(preflight);
    // The owner the message was prepared for is part of that check (ruling R13).
    expect(code.slice(preflight, simulate)).toContain("preparedFor: message.owner");
    expect(code.slice(simulate, send)).toContain("walletSetSendable(");
    expect(code).not.toContain("setTimeout");
    expect(code).not.toContain("setInterval");
  });

  test("the chain's time is the step's estimate, never the bare wall clock", () => {
    expect(code).toContain("chainNowSeconds(");
    expect(code).not.toMatch(/Date\.now\(\)\s*\/\s*1000/);
  });
});
