/**
 * Ruling R37: the exit card reaches every legal body Ruling R33 names, through the flow itself.
 *
 * An order whose legal body fell (another deployment on this chain, a pointer cleared, replaced,
 * superseded) never reaches the done page: `deriveLegalBodyPhase` sends it to a closed notice or
 * back to the pointer step. Each case here goes through the real derivation and the flow's one
 * switch (`legalBodyPhaseScreen`), as the server renders it with every effect run at once: for a
 * noted pot the browser recomputes and reads as the guardian's alone, the exit card shows under
 * that screen, with "Stop the allowance" and the take off; with no note, nothing of the pot shows.
 *
 * Rendering reads nothing of the chain from the page and sends nothing: the hooks are fakes that
 * record what they were asked. G, A and V3 are the real run's public addresses and vector; every
 * other address is a placeholder.
 */
import { createElement, Fragment } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyConfig, LegalBodyOrderView, OrderPotView } from "@/lib/api/types";

const calls = vi.hoisted(() => ({
  allowedWrites: 0,
  declares: 0,
  potQueries: [] as boolean[],
  rawQueries: [] as { pot: string | null; agentWallet: string | null }[],
  pot: undefined as unknown,
  raw: undefined as unknown,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // As the browser would: an effect runs, here at once, so whatever it does shows in the spies.
    useEffect: (effect: () => void) => {
      effect();
    },
  };
});

/** A query's result as a component reads it. */
const settled = (data: unknown) => ({
  data,
  isError: false,
  isFetching: false,
  isPending: data === undefined,
  dataUpdatedAt: Date.parse("2026-11-20T12:00:00Z"),
  refetch: async () => ({}),
});
const refused = () => ({
  mutateAsync: async () => {
    calls.declares += 1;
    throw new Error("not in this test");
  },
});

vi.mock("@/lib/api/legalBodyHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/legalBodyHooks")>()),
  useOrderPotQuery: (_id: unknown, enabled: boolean) => {
    calls.potQueries.push(enabled);
    return settled(calls.pot);
  },
  useOrderGrantQuery: () => settled(undefined),
  usePotRawQuery: (_chainId: number, pot: string | null, agentWallet: string | null) => {
    calls.rawQueries.push({ pot, agentWallet });
    return settled(pot === null ? undefined : calls.raw);
  },
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
  useDeclarePotMutation: () => refused(),
  useTakePotOffRecordMutation: () => refused(),
  useReadOrderPotNow: () => async () => {
    throw new Error("not in this test");
  },
  useWalletNow: () => () => ({ address: "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A", chainId: 5042002 }),
  // The pointer step's own reads: nothing answered yet.
  useLegalBodyBindingQuery: () => ({ data: undefined, isError: false, refetch: async () => ({}) }),
  useLegalBodyOrderQuery: () => ({ data: undefined, refetch: async () => ({}) }),
  useRefreshBindingMutation: () => refused(),
  useGasSeedMutation: () => refused(),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useReadContract: () => ({ status: "pending", refetch: async () => ({}) }),
  useEstimateGas: () => ({ data: undefined, isLoading: false, refetch: async () => ({}) }),
  useEstimateFeesPerGas: () => ({ data: undefined, isLoading: false }),
  useBalance: () => ({ data: undefined, isFetching: false, refetch: async () => ({}) }),
  usePublicClient: () => ({}),
  useConnection: () => ({
    address: "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A",
    addresses: ["0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A"],
    chainId: 5042002,
  }),
  useWriteContract: () => ({ writeContractAsync: async () => "0x" }),
  useSendTransaction: () => ({ sendTransactionAsync: async () => "0x" }),
}));

import {
  legalBodyPhaseScreen,
  type LegalBodyPhaseScreenInput,
  type LegalBodyStepKit,
} from "@/components/legalBody/LegalBodyFlow";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { deriveLegalBodyPhase, type LegalBodyDerivation } from "@/lib/legalBody/flow";
import { potAddresses, SAFE_PROXY_RUNTIME_CODE_HASH, SAFE_SENTINEL, type PotAddresses } from "@/lib/legalBody/safePot";
import type { PotRaw } from "@/lib/legalBody/safePotRules";

const POT = LEGAL_BODY_COPY.pot;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
/** An invention: another factory on the same chain. */
const OTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
/** The real run of 24 Nov: the guardian and the agent's key. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
/** A placeholder: another wallet, the identity's owner on the paste branch. */
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** V3 with salt nonce 1: G, A, USDC, 50 USDC in each thirty-day period. */
const V3_POT = "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D" as const;
/** The Safe the real run created: an address V3's birth details do not predict. */
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
const CHAIN = 5042002;
const NOW_MS = Date.parse("2026-11-20T12:00:00Z");
const T = potAddresses(CHAIN) as PotAddresses;
const USDC = (n: number) => BigInt(n) * BigInt(1_000_000);

const config: Extract<LegalBodyConfig, { available: true }> = {
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: CHAIN,
  identityRegistry: REGISTRY,
  factory: FACTORY,
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
  pot: true,
} as Extract<LegalBodyConfig, { available: true }>;

/** An order of G on this deployment, as the server serves a linked one, with `over` on top. */
const orderOf = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_fallen",
  publicId: "pub_fallen",
  companyId: "co_test",
  state: "linked",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: G,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"11".repeat(32)}`, version: 1 },
  agentId: "897126",
  identityOwner: G,
  bodyAddress: "0x00000000000000000000000000000000000b0d1e",
  linkDeadline: null,
  createTxHash: `0x${"22".repeat(32)}`,
  deployedAt: 1_763_000_000,
  pointerSeenAt: 1_763_000_300,
  createdAt: "2026-11-20T11:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

const NOTED: OrderPotView = {
  address: V3_POT,
  onRecord: true,
  declaredAt: 1_763_100_000,
  birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" },
};

/** The proof's healthy pot right after its first take, the guardian's alone. */
const HEALTHY: PotRaw = {
  codeHash: SAFE_PROXY_RUNTIME_CODE_HASH,
  singleton: T.safeSingleton,
  owners: [G],
  threshold: BigInt(1),
  modules: { list: [T.allowanceModule], next: SAFE_SENTINEL },
  guard: "0x0000000000000000000000000000000000000000",
  fallbackHandler: T.fallbackHandler,
  delegates: { list: [A], next: 0 },
  tokens: [T.usdc],
  allowance: [USDC(50), USDC(10), BigInt(43200), BigInt(29_919_864), BigInt(2)],
  usdcAllowanceToAgent: BigInt(0),
  balanceUnits: USDC(190),
  balanceWei: USDC(190) * BigInt(1_000_000_000_000),
  agentBalanceWei: BigInt("100000000000000000"),
  agentHasCode: false,
};

/** The flow's own derivation for `order`, as the session asks it. */
const derive = (order: LegalBodyOrderView): LegalBodyDerivation =>
  deriveLegalBodyPhase({
    config,
    sessionAddress: G,
    nowMs: NOW_MS,
    company: null,
    documents: null,
    orders: [order],
    order,
    ownerChoice: null,
    agentId: null,
    agentWallet: null,
  });

/** The screen the flow's switch draws for `order`, through the derivation, as markup. */
function screen(order: LegalBodyOrderView): { derivation: LegalBodyDerivation; markup: string } {
  const derivation = derive(order);
  const kit = {
    config,
    tenant: G,
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
    agentWallet: null,
    refreshAgentWallet: vi.fn(async () => {}),
  } as LegalBodyStepKit;
  const input: LegalBodyPhaseScreenInput = {
    derivation,
    kit,
    publicConfig: undefined,
    memory: null,
    companies: [],
    orders: [order],
    company: null,
    door: kit.door,
    choices: { ownerChoice: null, agentId: null },
    router: { push: vi.fn() },
    companyQuery: { refetch: vi.fn() },
    companiesQuery: { refetch: vi.fn() },
    jump: vi.fn(),
    startAnother: vi.fn(),
    remember: vi.fn(),
    agreementRead: vi.fn(),
    backToCompany: vi.fn(),
    refusedDraftIds: [],
    identitySuggestion: null,
    noteIdentity: vi.fn(),
    sendBack: vi.fn(async () => {}),
  };
  return { derivation, markup: renderToString(createElement(Fragment, null, legalBodyPhaseScreen(input))) };
}

/** The visible text of markup, in one line. */
function text(m: string): string {
  return m
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
/** Every button: its opening tag and the words inside. */
function buttons(m: string): { tag: string; words: string }[] {
  return [...m.matchAll(/(<button[^>]*>)([\s\S]*?)<\/button>/g)].map(([, tag, inner]) => ({
    tag: tag ?? "",
    words: text(inner ?? "").trim(),
  }));
}
const button = (m: string, words: string) => buttons(m).find((b) => b.words.includes(words)) ?? null;
const isDisabled = (b: { tag: string } | null) => b !== null && /\sdisabled=""/.test(b.tag);

/** The words no exit card ever shows: the setup, the change, money, the restore, the put back. */
const NEVER = [POT.cardTitle, POT.changeTitle, POT.addMoneyTitle, POT.feeMoneyTitle, POT.backOnTitle, POT.startAgainTitle, POT.newKeyTitle];

/** The four legal bodies R33 names that never reach the done page, and the phase each lands on. */
const FALLEN: [string, LegalBodyOrderView, "closed" | "pointer"][] = [
  ["another deployment on this chain", orderOf({ factory: OTHER_FACTORY }), "closed"],
  ["broken, its pointer cleared, not revoked", orderOf({ state: "broken", brokenReason: "not_linked" }), "pointer"],
  [
    "broken, its pointer cleared, on the paste branch",
    orderOf({ state: "broken", brokenReason: "not_linked", identityOwner: OTHER }),
    "pointer",
  ],
  ["replaced", orderOf({ state: "broken", brokenReason: "replaced", replacedBy: "lbo_newer" }), "closed"],
  ["superseded", orderOf({ state: "superseded", supersededBy: "lbo_newer" }), "closed"],
];

beforeEach(() => {
  calls.allowedWrites = 0;
  calls.declares = 0;
  calls.potQueries = [];
  calls.rawQueries = [];
  calls.pot = { pot: null };
  calls.raw = undefined;
});

describe("Ruling R37: the exit card under the screens a fallen legal body lands on", () => {
  test.each(FALLEN)("%s: the flow's own screen, then the exit card for a noted pot the browser recomputes", (_what, order, phase) => {
    calls.pot = { pot: NOTED };
    calls.raw = HEALTHY;
    const { derivation, markup } = screen(order);
    expect(derivation.phase).toBe(phase);
    const t = text(markup);
    // The pot's card, read at the recomputed address against the birth's first key: no public
    // record is read on these screens.
    expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([{ pot: V3_POT, agentWallet: A }]);
    expect(t).toContain(POT.title);
    expect(t).toContain(fillCopy(POT.shownAddress, { address: V3_POT }));
    const stop = button(markup, POT.stopSend);
    expect(stop).not.toBeNull();
    expect(isDisabled(stop)).toBe(false);
    expect(button(markup, POT.offRecordSend)).not.toBeNull();
    for (const s of NEVER) expect(t, s).not.toContain(s);
    expect(calls.allowedWrites).toBe(0);
    expect(calls.declares).toBe(0);
  });

  test.each(FALLEN)("%s: with no note, nothing of the pot shows", (_what, order, phase) => {
    calls.pot = { pot: null };
    calls.raw = HEALTHY;
    const { derivation, markup } = screen(order);
    expect(derivation.phase).toBe(phase);
    const t = text(markup);
    expect(t).not.toContain(POT.title);
    expect(button(markup, POT.stopSend)).toBeNull();
    expect(button(markup, POT.offRecordSend)).toBeNull();
    expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([]);
  });

  test("a stopped pot holding money: Take the money back; a note its birth does not predict: the sentence and the take off alone, never read", () => {
    calls.pot = { pot: NOTED };
    calls.raw = { ...HEALTHY, modules: { list: [], next: SAFE_SENTINEL }, delegates: { list: [], next: 0 } };
    const replaced = orderOf({ state: "broken", brokenReason: "replaced", replacedBy: "lbo_newer" });
    const stopped = screen(replaced).markup;
    expect(text(stopped)).toContain(POT.withdrawTitle);
    expect(button(stopped, POT.stopSend)).toBeNull();
    calls.pot = { pot: { ...NOTED, address: SAFE_CREATED } };
    calls.rawQueries = [];
    const wrong = screen(replaced).markup;
    expect(text(wrong)).toContain(POT.notYours);
    expect(button(wrong, POT.offRecordSend)).not.toBeNull();
    expect(button(wrong, POT.stopSend)).toBeNull();
    expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([]);
  });

  test("an order of another chain than the configured one: its closed notice, and nothing of the pot is asked", () => {
    calls.pot = { pot: NOTED };
    calls.raw = HEALTHY;
    const { derivation, markup } = screen(orderOf({ chainId: 1 }));
    expect(derivation).toMatchObject({ phase: "closed", notice: { kind: "other_deployment" } });
    expect(text(markup)).not.toContain(POT.title);
    expect(calls.potQueries).toEqual([]);
    expect(calls.rawQueries).toEqual([]);
  });
});
