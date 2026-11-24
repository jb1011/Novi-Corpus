/**
 * The done page of a legal body that already exists, as the server renders it, with every effect
 * run at once as the browser would run it.
 *
 * A body linked before the agent's wallet rule has an identity that still names the guardian's own
 * wallet, or none. Its done page shows a card, "Set your agent's wallet", with the sentence for
 * which of the two the public record names; a click on the card opens the agent's wallet step in
 * place, in its linked mode, which reads the registry itself. The card shows only for a linked, not
 * revoked order with no notice beside it, whose record was read, and only for those two cases; it
 * is measured against the order's own guardian. Rendering the page opens nothing: no chain read,
 * no wallet, no transaction.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import type {
  LegalBodyByAgent,
  LegalBodyConfig,
  LegalBodyOrderView,
  LegalBodyStatementJson,
} from "@/lib/api/types";

const calls = vi.hoisted(() => ({
  allowedWrites: 0,
  chainReads: 0,
  signatures: 0,
  /** Each `readContract` asked: its function and its arguments. */
  contractReads: [] as { functionName: unknown; args: unknown }[],
  byAgent: [] as { agentId: string | null | undefined; enabled: boolean }[],
  data: undefined as unknown,
  /** The card already clicked: the done page's one state (`walletOpen`) reads true. */
  walletOpen: false,
  /** The states asked for since the render began. */
  states: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // As the browser would: an effect runs, here at once, so whatever it does shows in the spies.
    useEffect: (effect: () => void) => {
      effect();
    },
    // The done page's one state is the render's first, and starts false: with `walletOpen` set it
    // reads as the card already clicked. Every other state is React's own.
    useState: ((initial: unknown) => {
      const state = actual.useState(initial);
      calls.states += 1;
      return calls.walletOpen && calls.states === 1 && initial === false ? [true, state[1]] : state;
    }) as typeof actual.useState,
  };
});

vi.mock("@/lib/api/legalBodyHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/legalBodyHooks")>()),
  useLegalBodyByAgentQuery: (agentId: string | null | undefined, enabled: boolean) => {
    calls.byAgent.push({ agentId, enabled });
    return { data: calls.data, isFetching: false, refetch: async () => ({}) };
  },
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
}));

vi.mock("wagmi", async (importOriginal) => {
  const read = () => {
    calls.chainReads += 1;
    throw new Error("not in this test");
  };
  const client = {
    getBlock: read,
    getCode: read,
    readContract: (p?: { functionName?: unknown; args?: unknown }) => {
      calls.contractReads.push({ functionName: p?.functionName, args: p?.args });
      return read();
    },
    simulateContract: read,
    waitForTransactionReceipt: read,
  };
  const signTypedDataAsync = async () => {
    calls.signatures += 1;
    throw new Error("not in this test");
  };
  return {
    ...(await importOriginal<typeof import("wagmi")>()),
    usePublicClient: () => client,
    useConnection: () => ({
      address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      addresses: ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"],
      chainId: 5042002,
    }),
    useSignTypedData: () => ({ signTypedDataAsync }),
  };
});

import { DoneStep } from "@/components/legalBody/DoneStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";

const AW = LEGAL_BODY_COPY.agentWallet;
const D = LEGAL_BODY_COPY.done;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
/** Anvil's first three published accounts: the guardian, the agent's own wallet, another wallet. */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const AGENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const AGENT_ID = "897126";
const NOW_S = Math.floor(Date.parse("2026-11-20T12:00:00Z") / 1000);

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

/** A body linked before the rule, on identity `AGENT_ID`, its identity owned by the guardian. */
const linkedOrder = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_linked",
  publicId: "pub_linked",
  companyId: "co_test",
  state: "linked",
  chainId: 5042002,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"11".repeat(32)}`, version: 1 },
  agentId: AGENT_ID,
  identityOwner: GUARDIAN,
  bodyAddress: "0x00000000000000000000000000000000000b0d1e",
  linkDeadline: null,
  createTxHash: `0x${"22".repeat(32)}`,
  deployedAt: NOW_S - 600,
  pointerSeenAt: NOW_S - 300,
  createdAt: "2026-11-20T11:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

function kit(order: LegalBodyOrderView, derivation: LegalBodyDerivation = { phase: "done" }): LegalBodyStepKit {
  return {
    config: config(),
    tenant: GUARDIAN,
    derivation,
    companyId: order.companyId,
    orderId: order.id,
    company: null,
    order,
    orders: [order],
    remember: vi.fn(),
    startAnother: vi.fn(),
    routeSignIn: vi.fn(() => false),
    door: "declare",
    // The shell reads no wallet for an order that is not a draft.
    agentWallet: null,
    refreshAgentWallet: vi.fn(async () => {}),
  };
}

/** The body's public record, all its fields, naming `agentWallet` as the agent's wallet. */
const record = (agentWallet: string): LegalBodyStatementJson => ({
  chainId: "5042002",
  identityRegistry: REGISTRY,
  factory: FACTORY,
  legalBody: "0x00000000000000000000000000000000000b0d1e",
  agentId: AGENT_ID,
  agentWallet: agentWallet as LegalBodyStatementJson["agentWallet"],
  identityOwnerAtCreation: GUARDIAN,
  bindingState: "linked",
  identityOwnerIsContract: false,
  agentWalletIsContract: false,
  standing: "active",
  attestationState: "active",
  jurisdiction: "WY",
  entityType: "LLC",
  legalName: "Example Test Holdings LLC",
  filingNumber: "TEST-0001",
  source: "customer",
  environment: "sandbox",
  controlVerified: true,
  existenceCheckedAt: String(NOW_S - 900),
  filedAt: "2026-03-10",
  einIssued: false,
  filingStatus: "not_yet_due",
  lastFiledPeriod: "0",
  lastFiledAt: "",
  lastFiledConfirmedBy: "",
  nextDue: "2027-03-01",
  oaManifestHash: `0x${"ab".repeat(32)}`,
  oaManifestVersion: "1",
  guardianHumanVerified: true,
  observedAtBlock: "31415926",
  issuedAt: String(NOW_S - 60),
  expiresAt: String(NOW_S + 240),
});

const LINKS = {
  transparency: "https://example.test/transparency",
  statement: `https://example.test/legal-bodies/by-agent/${AGENT_ID}`,
};

/** The by-agent answer with a signed statement whose record names `agentWallet`. */
const naming = (agentWallet: string): PublicRead<LegalBodyByAgent> => ({
  kind: "answer",
  body: {
    agentId: AGENT_ID,
    legalBody: true,
    standing: "active",
    publicId: "lb_test",
    network: "testnet",
    links: LINKS,
    checkedAt: "2026-11-20T12:00:00.000Z",
    statement: {
      domain: { name: "Novi Corpus Attestation", version: "2", chainId: 5042002 },
      primaryType: "LegalBodyStatement",
      message: record(agentWallet),
      attestor: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      signature: `0x${"cd".repeat(65)}`,
    },
  },
});

/** A body whose statement could not be made just now: no record. */
const UNSIGNED: PublicRead<LegalBodyByAgent> = {
  kind: "answer",
  body: {
    agentId: AGENT_ID,
    legalBody: true,
    standing: "unknown",
    publicId: null,
    network: "testnet",
    links: { transparency: LINKS.transparency },
    checkedAt: "2026-11-20T12:00:00.000Z",
    statement: null,
  },
};

const NO_BODY: PublicRead<LegalBodyByAgent> = {
  kind: "answer",
  body: { agentId: AGENT_ID, legalBody: false, standing: null, checkedAt: "2026-11-20T12:00:00.000Z" },
};

const markup = (k: LegalBodyStepKit) => renderToString(createElement(DoneStep, { kit: k }));

/** The done page as it is once the card was clicked. */
function openMarkup(k: LegalBodyStepKit): string {
  calls.walletOpen = true;
  calls.states = 0;
  try {
    return markup(k);
  } finally {
    calls.walletOpen = false;
  }
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

/** The card's words, inside one button: the card is what a person clicks. */
function cardButton(m: string): string | null {
  const button = [...m.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
    .map(([, inner]) => text(inner))
    .find((inner) => inner.includes(AW.doneTitle));
  return button ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  calls.allowedWrites = 0;
  calls.chainReads = 0;
  calls.signatures = 0;
  calls.contractReads = [];
  calls.byAgent = [];
  calls.data = undefined;
  calls.walletOpen = false;
  calls.states = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the card, for the two cases", () => {
  test("the record still names the guardian's own wallet: the title, then the sentence for it", () => {
    calls.data = naming(GUARDIAN);
    const m = markup(kit(linkedOrder()));
    const button = cardButton(m);
    expect(button).not.toBeNull();
    expect(button).toContain(AW.doneLine);
    expect(button!.indexOf(AW.doneTitle)).toBeLessThan(button!.indexOf(AW.doneLine));
    expect(text(m)).not.toContain(AW.doneLineNone);
    expect(calls.byAgent).toEqual([{ agentId: AGENT_ID, enabled: true }]);
  });

  test("in any letter case", () => {
    calls.data = naming(GUARDIAN.toLowerCase());
    expect(cardButton(markup(kit(linkedOrder())))).toContain(AW.doneLine);
  });

  test("the record names no wallet (the zero address): the title, then the sentence for none", () => {
    calls.data = naming(ZERO);
    const m = markup(kit(linkedOrder()));
    expect(cardButton(m)).toContain(AW.doneLineNone);
    expect(text(m)).not.toContain(AW.doneLine);
  });

  test("the card comes before the record", () => {
    calls.data = naming(GUARDIAN);
    const page = text(markup(kit(linkedOrder())));
    expect(page.indexOf(AW.doneTitle)).toBeGreaterThan(-1);
    expect(page.indexOf(AW.doneTitle)).toBeLessThan(page.indexOf(D.standingHeading));
  });
});

describe("no card otherwise", () => {
  test("the record names the agent's own wallet", () => {
    calls.data = naming(AGENT);
    const m = markup(kit(linkedOrder()));
    expect(text(m)).not.toContain(AW.doneTitle);
    // The rest of the done page is as before.
    expect(text(m)).toContain(D.standingHeading);
  });

  test.each<[string, PublicRead<LegalBodyByAgent> | undefined]>([
    ["not read yet", undefined],
    ["a read that could not be made", { kind: "could_not_check", reason: "rate_limited" }],
    ["a body whose statement could not be made just now", UNSIGNED],
    ["no legal body in the answer", NO_BODY],
  ])("the record not read: %s", (_name, data) => {
    calls.data = data;
    expect(text(markup(kit(linkedOrder())))).not.toContain(AW.doneTitle);
  });

  test("a revoked body, whatever its record names", () => {
    for (const wallet of [GUARDIAN, ZERO]) {
      calls.data = naming(wallet);
      const order = linkedOrder({ revoked: true });
      const m = markup(kit(order, { phase: "done", notice: { kind: "order_revoked" } }));
      expect(text(m)).not.toContain(AW.doneTitle);
    }
  });

  test.each([
    "company_revoked",
    "order_revoked",
    "winding_down",
    "dissolved",
    "broken_reason_unknown",
  ] as const)("a notice beside the body (%s), the order linked and not revoked: no card (ruling R18)", (kind) => {
    for (const wallet of [GUARDIAN, ZERO]) {
      calls.data = naming(wallet);
      const m = markup(kit(linkedOrder(), { phase: "done", notice: { kind } }));
      expect(text(m)).not.toContain(AW.doneTitle);
      // The notice is said, and the record is shown as before.
      expect(text(m)).toContain(D.standingHeading);
    }
  });

  test("a body that is not linked, whatever its record names", () => {
    calls.data = naming(GUARDIAN);
    for (const brokenReason of ["winding_down", "dissolved"] as const) {
      const order = linkedOrder({ state: "broken", brokenReason });
      const m = markup(kit(order, { phase: "done", notice: { kind: brokenReason } }));
      expect(text(m)).not.toContain(AW.doneTitle);
    }
  });

  test("measured against the order's own guardian", () => {
    // The order's guardian is another wallet than the one the record names.
    calls.data = naming(GUARDIAN);
    expect(text(markup(kit(linkedOrder({ guardian: OTHER }))))).not.toContain(AW.doneTitle);
    calls.data = naming(OTHER);
    expect(cardButton(markup(kit(linkedOrder({ guardian: OTHER }))))).toContain(AW.doneLine);
  });
});

describe("rendering the page opens nothing", () => {
  test("the card stays closed until a click: no step, no chain read, no wallet, nothing sent", () => {
    calls.data = naming(GUARDIAN);
    const k = kit(linkedOrder());
    const page = text(markup(k));
    vi.advanceTimersByTime(10 * 60_000);
    // The step's own words are not on the page before the card is clicked.
    expect(page).not.toContain(AW.why);
    expect(page).not.toContain(AW.hasKeyTitle);
    expect(page).not.toContain(AW.checking);
    expect(calls.chainReads).toBe(0);
    expect(calls.allowedWrites).toBe(0);
    expect(calls.signatures).toBe(0);
    expect(k.refreshAgentWallet).not.toHaveBeenCalled();
    expect(k.remember).not.toHaveBeenCalled();
  });
});

describe("the card clicked: the step opens in place, in its linked mode", () => {
  test("the step reads the registry itself, once, as it opens: getAgentWallet for this identity", () => {
    calls.data = naming(GUARDIAN);
    const k = kit(linkedOrder());
    const m = openMarkup(k);
    const page = text(m);
    // The step in the card's place, the record still below it.
    expect(cardButton(m)).toBeNull();
    expect(page).toContain(AW.title);
    expect(page).toContain(AW.checking);
    expect(page).toContain(D.standingHeading);
    // The linked mode's own read: a draft's step reads nothing as it opens (the shell reads for a
    // draft), and the shell reads no wallet for a linked order.
    expect(calls.contractReads).toEqual([{ functionName: "getAgentWallet", args: [BigInt(AGENT_ID)] }]);
    expect(calls.chainReads).toBe(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(calls.chainReads).toBe(1);
    expect(k.refreshAgentWallet).not.toHaveBeenCalled();
    // Opening it opens no wallet, sends nothing and remembers nothing.
    expect(calls.allowedWrites).toBe(0);
    expect(calls.signatures).toBe(0);
    expect(k.remember).not.toHaveBeenCalled();
  });

  test("the closed card reads nothing: the read above is the click's", () => {
    calls.data = naming(GUARDIAN);
    markup(kit(linkedOrder()));
    expect(calls.contractReads).toEqual([]);
    expect(calls.chainReads).toBe(0);
  });
});
