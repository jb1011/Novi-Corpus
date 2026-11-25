/**
 * "Give your agent an allowance": the done page's pot card, the setup's step and its panels, and
 * the public record's pot sentence, as the server renders them, with every effect run at once as
 * the browser would run it.
 *
 * The card shows only where `/config.legalBodies.pot` is true, and a click on it opens the step in
 * place. The step reads nothing on mount but the grant; every other read and the one transaction
 * are a click's. The form opens with an EMPTY ceiling and the grant's cap beside it; the review
 * ends with the declaration's tick box, unticked, and "Create the pot" stays disabled until it is
 * ticked. A pot read back as anything but its ceiling says so in a warning, and offers nothing.
 * The step's source holds one way to the wallet, the allowlist, called in one place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import type {
  Hex,
  LegalBodyByAgent,
  LegalBodyConfig,
  LegalBodyOrderView,
  LegalBodyStatementJson,
  OrderGrantView,
  OrderPotView,
  PotBlock,
} from "@/lib/api/types";

const calls = vi.hoisted(() => ({
  allowedWrites: 0,
  chainReads: 0,
  declares: 0,
  freshPotReads: 0,
  /** The wallet's account asked at a moment of the click. */
  walletReads: 0,
  /** Each pot hook asked, with whether it may read. */
  potQueries: [] as boolean[],
  grantQueries: [] as boolean[],
  rawQueries: [] as { pot: string | null; agentWallet: string | null }[],
  byAgent: undefined as unknown,
  pot: undefined as unknown,
  grant: undefined as unknown,
  raw: undefined as unknown,
  /** A read that failed: the query's result says so. */
  potError: false,
  grantError: false,
  rawError: false,
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
const settled = (data: unknown, over: Record<string, unknown> = {}) => ({
  data,
  isError: false,
  isFetching: false,
  isPending: data === undefined,
  dataUpdatedAt: Date.parse("2026-11-20T12:00:00Z"),
  refetch: async () => ({}),
  ...over,
});

vi.mock("@/lib/api/legalBodyHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/legalBodyHooks")>()),
  useLegalBodyByAgentQuery: () => settled(calls.byAgent),
  useOrderPotQuery: (_id: unknown, enabled: boolean) => {
    calls.potQueries.push(enabled);
    return settled(calls.pot, calls.potError ? { isError: true, isPending: false } : {});
  },
  useOrderGrantQuery: (_id: unknown, enabled: boolean) => {
    calls.grantQueries.push(enabled);
    return settled(calls.grant, calls.grantError ? { isError: true, isPending: false } : {});
  },
  usePotRawQuery: (_chainId: number, pot: string | null, agentWallet: string | null) => {
    calls.rawQueries.push({ pot, agentWallet });
    return settled(calls.raw, calls.rawError ? { isError: true, isPending: false } : {});
  },
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
  useDeclarePotMutation: () => ({
    mutateAsync: async () => {
      calls.declares += 1;
      throw new Error("not in this test");
    },
  }),
  useTakePotOffRecordMutation: () => ({
    mutateAsync: async () => {
      calls.declares += 1;
      throw new Error("not in this test");
    },
  }),
  useReadOrderPotNow: () => async () => {
    calls.freshPotReads += 1;
    throw new Error("not in this test");
  },
  useWalletNow: () => () => {
    calls.walletReads += 1;
    return { address: "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A", chainId: 5042002 };
  },
}));

vi.mock("wagmi", async (importOriginal) => {
  const read = () => {
    calls.chainReads += 1;
    throw new Error("not in this test");
  };
  const client = {
    call: read,
    estimateGas: read,
    getBalance: read,
    getBlock: read,
    getBlockNumber: read,
    getCode: read,
    multicall: read,
    readContract: read,
    simulateContract: read,
    waitForTransactionReceipt: read,
  };
  return {
    ...(await importOriginal<typeof import("wagmi")>()),
    usePublicClient: () => client,
    useConnection: () => ({
      address: "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A",
      addresses: ["0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A"],
      chainId: 5042002,
    }),
  };
});

import { DoneStep } from "@/components/legalBody/DoneStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import { LegalBodyRecord } from "@/components/legalBody/LegalBodyRecord";
import {
  PotCardView,
  PotCreatedPanel,
  PotFormPanel,
  PotProblemPanel,
  PotReviewPanel,
} from "@/components/legalBody/PotPanels";
import { PotStep } from "@/components/legalBody/PotStep";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";
import { potAddresses, SAFE_PROXY_RUNTIME_CODE_HASH, SAFE_SENTINEL, type PotAddresses } from "@/lib/legalBody/safePot";
import type { PotRaw } from "@/lib/legalBody/safePotRules";
import { potFormMoney } from "@/lib/legalBody/safePotRun";
import {
  potCeilingHint,
  potPlan,
  potReadingView,
  potRecordSentence,
  potReviewLines,
  type PotPlan,
} from "@/lib/legalBody/safePotStep";

const POT = LEGAL_BODY_COPY.pot;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
/** The real run of 24 Nov: the guardian, the agent's key, the payee. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const P = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8" as const;
/** V3 with salt nonce 1: G, A, USDC, 50 USDC in each thirty-day period. */
const V3_POT = "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D" as const;
/** The Safe the real run created: an address V3's birth details do not predict. */
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
const CHAIN = 5042002;
const AGENT_ID = "897126";
const NOW_S = Math.floor(Date.parse("2026-11-20T12:00:00Z") / 1000);
const T = potAddresses(CHAIN) as PotAddresses;
const ZERO = BigInt(0);
const USDC = (n: number) => BigInt(n) * BigInt(1_000_000);
const WEI = (units: bigint) => units * BigInt(1_000_000_000_000);

const config = (over: Partial<Extract<LegalBodyConfig, { available: true }>> = {}) =>
  ({
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
    ...over,
  }) as Extract<LegalBodyConfig, { available: true }>;

const linkedOrder = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_linked",
  publicId: "pub_linked",
  companyId: "co_test",
  state: "linked",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: G,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"11".repeat(32)}`, version: 1 },
  agentId: AGENT_ID,
  identityOwner: G,
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

function kit(
  over: Partial<Extract<LegalBodyConfig, { available: true }>> = {},
  orderOver: Partial<LegalBodyOrderView> = {},
  notice?: LegalBodyNotice,
): LegalBodyStepKit {
  const order = linkedOrder(orderOver);
  return {
    config: config(over),
    tenant: G,
    derivation: notice === undefined ? { phase: "done" } : { phase: "done", notice },
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
}

/** The body's public record, naming `agentWallet` as the agent's wallet. */
const record = (agentWallet: string): LegalBodyStatementJson => ({
  chainId: String(CHAIN),
  identityRegistry: REGISTRY,
  factory: FACTORY,
  legalBody: "0x00000000000000000000000000000000000b0d1e",
  agentId: AGENT_ID,
  agentWallet: agentWallet as LegalBodyStatementJson["agentWallet"],
  identityOwnerAtCreation: G,
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

/** The by-agent answer with a signed statement naming `agentWallet`, and the pot block given. */
const naming = (agentWallet: string, pot?: PotBlock | null): PublicRead<LegalBodyByAgent> => ({
  kind: "answer",
  body: {
    agentId: AGENT_ID,
    legalBody: true,
    standing: "active",
    publicId: "lb_test",
    network: "testnet",
    links: {
      transparency: "https://example.test/transparency",
      statement: `https://example.test/legal-bodies/by-agent/${AGENT_ID}`,
    },
    checkedAt: "2026-11-20T12:00:00.000Z",
    statement: {
      domain: { name: "Novi Corpus Attestation", version: "2", chainId: CHAIN },
      primaryType: "LegalBodyStatement",
      message: record(agentWallet),
      attestor: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      signature: `0x${"cd".repeat(65)}`,
    },
    ...(pot === undefined ? {} : { pot }),
  },
});

const NOTED: OrderPotView = {
  address: V3_POT,
  onRecord: true,
  declaredAt: NOW_S - 100,
  birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" },
};

/** A grant of 200 + 150 USDC per thirty days for buying and paying. */
const GRANT: OrderGrantView = {
  grant: {
    choices: {
      acts: {
        buy: { allowed: true, perAct: 50, per30Days: 200, above: "ask" },
        pay: { allowed: true, perAct: 50, per30Days: 150, above: "ask" },
        engageContractor: { allowed: false },
      },
      endsOn: null,
    },
  },
};

/** The proof's healthy pot right after its first take. */
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
  usdcAllowanceToAgent: ZERO,
  balanceUnits: USDC(190),
  balanceWei: WEI(USDC(190)),
  agentBalanceWei: BigInt("100000000000000000"),
  agentHasCode: false,
};
const ABSENT: PotRaw = { ...HEALTHY, codeHash: null };

/** V3's plan, as the review click makes it: the plan of `potPlan` from these reads. */
function v3Plan(over: Partial<Parameters<typeof potPlan>[0]> = {}): PotPlan {
  const r = potPlan({
    chainId: CHAIN,
    guardian: G,
    agentWallet: A,
    agentCode: undefined,
    checked: { ok: true, ceilingUnits: USDC(50), fundWei: WEI(USDC(60)), agentGasWei: WEI(BigInt(100_000)) },
    saltNonce: BigInt(1),
    potCode: undefined,
    guardianBalanceWei: WEI(USDC(1000)),
    noted: null,
    notedCode: undefined,
    ...over,
  });
  if (!r.ok) throw new Error(`the plan was refused: ${r.problem}`);
  return r.plan;
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

/** Every button: its opening tag and the words inside. */
function buttons(m: string): { tag: string; words: string }[] {
  return [...m.matchAll(/(<button[^>]*>)([\s\S]*?)<\/button>/g)].map(([, tag, inner]) => ({
    tag: tag ?? "",
    words: text(inner ?? "").trim(),
  }));
}
const button = (m: string, words: string) => buttons(m).find((b) => b.words.includes(words)) ?? null;
const isDisabled = (b: { tag: string } | null) => b !== null && /\sdisabled=""/.test(b.tag);

const done = (k: LegalBodyStepKit) => renderToString(createElement(DoneStep, { kit: k }));

beforeEach(() => {
  calls.allowedWrites = 0;
  calls.chainReads = 0;
  calls.declares = 0;
  calls.freshPotReads = 0;
  calls.walletReads = 0;
  calls.potQueries = [];
  calls.grantQueries = [];
  calls.rawQueries = [];
  calls.byAgent = naming(A);
  calls.pot = { pot: null };
  calls.grant = GRANT;
  calls.raw = undefined;
  calls.potError = false;
  calls.grantError = false;
  calls.rawError = false;
});

/** Nothing was read from the chain, nothing reached the wallet or the server's note. */
function nothingSent() {
  expect(calls.chainReads).toBe(0);
  expect(calls.allowedWrites).toBe(0);
  expect(calls.declares).toBe(0);
  expect(calls.freshPotReads).toBe(0);
  expect(calls.walletReads).toBe(0);
}

// ---------------------------------------------------------------------------------------------
// The done page's card
// ---------------------------------------------------------------------------------------------

describe("the done page's pot card", () => {
  test("offer: the card's title and line, in one button that opens the step; no wallet button", () => {
    const m = renderToString(
      createElement(PotCardView, { shown: { kind: "offer" }, onOpen: () => {}, onRetry: () => {}, retrying: false }),
    );
    const all = buttons(m);
    expect(all).toHaveLength(1);
    expect(all[0]?.words).toContain(POT.cardTitle);
    expect(all[0]?.words).toContain(POT.cardLine);
    expect(text(m)).not.toContain(POT.create);
    expect(text(m)).not.toContain(POT.review);
  });

  test("the done page with the pot offered and no note: the offer card, and rendering reads nothing and sends nothing", () => {
    const m = done(kit());
    const card = button(m, POT.cardTitle);
    expect(card).not.toBeNull();
    expect(card?.words).toContain(POT.cardLine);
    expect(text(m)).not.toContain(POT.create);
    // The noted pot and the grant may be read; the chain is read only for a noted pot.
    expect(calls.potQueries.every(Boolean)).toBe(true);
    expect(calls.grantQueries.every(Boolean)).toBe(true);
    expect(calls.rawQueries.every((q) => q.pot === null)).toBe(true);
    nothingSent();
  });

  test("unless /config.legalBodies.pot is true, the full card is never offered: no note, no card and no chain read; a note off the record is read on the chain for its exit card only (Ruling R33), never the grant", () => {
    for (const pot of [false, undefined])
      for (const noted of [null, { ...NOTED, onRecord: false }]) {
        calls.potQueries = [];
        calls.grantQueries = [];
        calls.rawQueries = [];
        calls.pot = { pot: noted };
        const m = done(kit({ pot }));
        expect(text(m)).not.toContain(POT.cardTitle);
        expect(text(m)).not.toContain(POT.title);
        expect(text(m)).not.toContain(POT.offRecordTitle);
        expect(calls.potQueries).toContain(true);
        expect(calls.grantQueries.some(Boolean)).toBe(false);
        // The exit card reads the recomputed pot against the record's own wallet, A.
        expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual(noted === null ? [] : [{ pot: V3_POT, agentWallet: A }]);
      }
    nothingSent();
  });

  describe("Rulings R24 and R33: a pot on the record can always be taken off it, and stopped and emptied wherever the full card is not", () => {
    /** The words no exit card ever shows: the setup, the change, money, the restore, the put back. */
    const NEVER = [POT.cardTitle, POT.changeTitle, POT.addMoneyTitle, POT.feeMoneyTitle, POT.backOnTitle, POT.startAgainTitle, POT.newKeyTitle, POT.checking];
    /** The pot's words, every one but the take off's (R24, before the pot is read). */
    const OTHERS = [...NEVER, POT.stopTitle, POT.withdrawTitle];
    /** The take off alone: the pot's address and Take the pot off the public record. */
    function minimal(m: string, what: string) {
      const t = text(m);
      expect(t, what).toContain(POT.title);
      expect(t, what).toContain(fillCopy(POT.shownAddress, { address: V3_POT }));
      expect(t, what).toContain(POT.offRecordTitle);
      const take = button(m, POT.offRecordSend);
      expect(take, what).not.toBeNull();
      expect(isDisabled(take), what).toBe(false);
      for (const s of OTHERS) expect(t, `${what}: ${s}`).not.toContain(s);
    }
    /** The exit card: the pot's address, Stop the allowance and the take off (with `withdraw`,
     *  Take the money back too), every button enabled, and nothing else of the pot. */
    function exitCard(m: string, what: string, o: { stop?: boolean; withdraw?: boolean; onRecord?: boolean } = {}) {
      const { stop = true, withdraw = false, onRecord = true } = o;
      const t = text(m);
      expect(t, what).toContain(POT.title);
      expect(t, what).toContain(fillCopy(POT.shownAddress, { address: V3_POT }));
      expect(t, what).toContain(fillCopy(POT.shownOwner, { address: G }));
      expect(button(m, POT.stopSend) !== null, `${what}: stop`).toBe(stop);
      expect(t.includes(POT.withdrawTitle), `${what}: take back`).toBe(withdraw);
      expect(button(m, POT.offRecordSend) !== null, `${what}: take off`).toBe(onRecord);
      expect(t.includes(POT.offRecord), `${what}: off the record`).toBe(!onRecord);
      for (const b of buttons(m).filter((b) => [POT.stopSend, POT.offRecordSend].some((w) => b.words.includes(w))))
        expect(isDisabled(b), `${what}: ${b.words}`).toBe(false);
      for (const s of NEVER) expect(t, `${what}: ${s}`).not.toContain(s);
    }

    test("the pot flag off: the exit card, its pot read on the chain at the recomputed address whatever the flag, and no grant read", () => {
      for (const pot of [false, undefined]) {
        calls.pot = { pot: NOTED };
        calls.raw = HEALTHY;
        calls.grantQueries = [];
        calls.rawQueries = [];
        exitCard(done(kit({ pot })), `pot ${String(pot)}`);
        expect(calls.grantQueries.some(Boolean)).toBe(false);
        expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([{ pot: V3_POT, agentWallet: A }]);
      }
      // A stopped pot holding money: Take the money back as well.
      calls.raw = { ...HEALTHY, modules: { list: [], next: SAFE_SENTINEL }, delegates: { list: [], next: 0 } };
      exitCard(done(kit({ pot: false })), "stopped with money", { stop: false, withdraw: true });
      // Taken off the record: the exits, no take off, and no put back.
      calls.pot = { pot: { ...NOTED, onRecord: false } };
      calls.raw = HEALTHY;
      exitCard(done(kit({ pot: false })), "off the record", { onRecord: false });
      // Before the pot is read: the take off alone, as before.
      calls.pot = { pot: NOTED };
      calls.raw = undefined;
      minimal(done(kit({ pot: false })), "not read yet");
      // Its read failed: the card says so with Try again, and the take off stays beside it.
      calls.rawError = true;
      const failed = done(kit({ pot: false }));
      expect(text(failed)).toContain(POT.recordUnavailable);
      expect(button(failed, POT.retry)).not.toBeNull();
      expect(button(failed, POT.offRecordSend)).not.toBeNull();
      expect(button(failed, POT.stopSend)).toBeNull();
      calls.rawError = false;
      nothingSent();
    });

    test("a revoked body, or one that is not linked: the same exit card", () => {
      calls.pot = { pot: NOTED };
      calls.raw = HEALTHY;
      exitCard(done(kit({}, { revoked: true })), "revoked");
      for (const state of ["deployed", "broken", "lapsed", "superseded"] as const) exitCard(done(kit({}, { state })), state);
      exitCard(done(kit({}, { state: "broken", brokenReason: "dissolved", revoked: true })), "broken and revoked");
      nothingSent();
    });

    test("another deployment on this chain: the exit card; another chain: the take off alone; never a put back", () => {
      calls.pot = { pot: NOTED };
      calls.raw = HEALTHY;
      // The flow marks an order of another deployment with its notice.
      const OTHER = { kind: "other_deployment" } as const;
      exitCard(done(kit({}, { factory: "0x00000000000000000000000000000000000fac70" }, OTHER)), "another factory");
      // An order of another chain than the configured one: nothing is read on the chain.
      calls.rawQueries = [];
      minimal(done(kit({}, { chainId: 1 }, OTHER)), "another chain, with its notice");
      minimal(done(kit({}, { chainId: 1 })), "another chain");
      expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([]);
      calls.pot = { pot: { ...NOTED, onRecord: false } };
      const off = text(done(kit({}, { chainId: 1 })));
      expect(off).not.toContain(POT.offRecordTitle);
      expect(off).not.toContain(POT.backOnTitle);
      nothingSent();
    });

    test("the pot offered, but its chain read failed: the take off beside the failure; the record naming no wallet of the agent's own: the exit card, read against the birth's first key", () => {
      calls.pot = { pot: NOTED };
      calls.rawError = true;
      const failed = done(kit());
      expect(text(failed)).toContain(POT.recordUnavailable);
      expect(button(failed, POT.retry)).not.toBeNull();
      expect(button(failed, POT.offRecordSend)).not.toBeNull();
      calls.rawError = false;
      calls.raw = HEALTHY;
      for (const named of [G, "0x0000000000000000000000000000000000000000"]) {
        calls.byAgent = naming(named);
        calls.rawQueries = [];
        exitCard(done(kit()), `the record names ${named}`);
        expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([{ pot: V3_POT, agentWallet: A }]);
      }
      // A pot that is not the guardian's alone: no exit card, the take off alone.
      calls.raw = { ...HEALTHY, owners: [G, P] };
      minimal(done(kit()), "not the guardian's alone");
      // Off the record and nothing to offer: nothing.
      calls.raw = { ...HEALTHY, owners: [G, P] };
      calls.pot = { pot: { ...NOTED, onRecord: false } };
      expect(text(done(kit()))).not.toContain(POT.offRecordTitle);
    });

    test("Ruling R32: a noted address its own birth details do not predict, or a birth that does not read: the pot is never read, the card says so, and offers only the take off", () => {
      calls.raw = HEALTHY;
      for (const [what, noted] of [
        ["another address", { ...NOTED, address: SAFE_CREATED }],
        ["another salt", { ...NOTED, birth: { ...NOTED.birth, saltNonce: "2" } }],
        ["a birth that does not read", { ...NOTED, birth: { ...NOTED.birth, ceilingUnits: "lots" } }],
      ] as [string, OrderPotView][])
        for (const k of [kit(), kit({ pot: false }), kit({}, { revoked: true })]) {
          calls.pot = { pot: noted };
          calls.rawQueries = [];
          const m = done(k);
          const t = text(m);
          expect(t, what).toContain(POT.notYours);
          expect(t, what).toContain(fillCopy(POT.shownAddress, { address: noted.address }));
          expect(button(m, POT.offRecordSend), what).not.toBeNull();
          for (const s of [...NEVER, POT.stopTitle, POT.withdrawTitle]) expect(t, `${what}: ${s}`).not.toContain(s);
          expect(calls.rawQueries.filter((q) => q.pot !== null), what).toEqual([]);
          // Off the record: the sentence, and nothing to press.
          calls.pot = { pot: { ...noted, onRecord: false } };
          const off = done(k);
          expect(text(off), what).toContain(POT.notYours);
          expect(buttons(off).filter((b) => b.words.includes(POT.offRecordSend))).toEqual([]);
        }
      // The noted address in another letter case is the pot: the full card, read at the checksummed address.
      calls.pot = { pot: { ...NOTED, address: V3_POT.toLowerCase() } };
      calls.rawQueries = [];
      const full = text(done(kit()));
      expect(full).toContain(POT.changeTitle);
      expect(full).not.toContain(POT.notYours);
      expect(calls.rawQueries.filter((q) => q.pot !== null)).toEqual([{ pot: V3_POT, agentWallet: A }]);
      nothingSent();
    });

    test("the full card keeps its own take off, once; a noted pot that never got code offers the setup, not a take off", () => {
      calls.pot = { pot: NOTED };
      calls.raw = HEALTHY;
      const full = text(done(kit()));
      expect(full).toContain(POT.changeTitle);
      expect(full.split(POT.offRecordTitle).length - 1).toBe(1);
      calls.raw = ABSENT;
      const offer = done(kit());
      expect(button(offer, POT.cardTitle)).not.toBeNull();
      expect(text(offer)).not.toContain(POT.offRecordTitle);
      // A grant that allows no spending hides the offer: a pot the chain shows was never created
      // still gets no take off (the record never shows it).
      calls.grant = {
        grant: {
          choices: {
            acts: { buy: { allowed: false }, pay: { allowed: false }, engageContractor: { allowed: false } },
            endsOn: null,
          },
        },
      } satisfies OrderGrantView;
      const hidden = text(done(kit()));
      expect(hidden).not.toContain(POT.cardTitle);
      expect(hidden).not.toContain(POT.offRecordTitle);
    });
  });

  test("checking: the card's title with pot.checking while the noted pot or the grant is read", () => {
    calls.pot = undefined;
    const m = done(kit());
    expect(text(m)).toContain(POT.cardTitle);
    expect(text(m)).toContain(POT.checking);
    expect(button(m, POT.cardTitle)).toBeNull();
  });

  test("a grant that allows no spending: no card at all", () => {
    calls.grant = {
      grant: {
        choices: {
          acts: { buy: { allowed: false }, pay: { allowed: false }, engageContractor: { allowed: false } },
          endsOn: null,
        },
      },
    } satisfies OrderGrantView;
    expect(text(done(kit()))).not.toContain(POT.cardTitle);
  });

  test("a noted pot with code: the pot's card with the reading's lines and the guardian's actions, read for the record's agent wallet", () => {
    calls.pot = { pot: NOTED };
    calls.raw = HEALTHY;
    const m = done(kit());
    expect(calls.rawQueries.some((q) => q.pot === V3_POT && q.agentWallet === A)).toBe(true);
    expect(text(m)).toContain(POT.title);
    const reading = potReadingView({ state: "ceiling_read", ceilingUnits: USDC(50), spentUnits: USDC(10), periodEndsAt: (29_919_864 + 43200) * 60, nonce: BigInt(2), balanceUnits: USDC(190) }, HEALTHY, {
      chainId: CHAIN,
      pot: V3_POT,
      guardian: G,
      agentWallet: A,
      onRecord: true,
      onThisDeployment: true,
      nowSeconds: NOW_S,
    });
    for (const line of reading.lines) expect(text(m)).toContain(line);
    // No offer: the card is the pot's, with its actions (Task 12), each a click's.
    expect(button(m, POT.cardTitle)).toBeNull();
    expect(text(m)).toContain(POT.changeTitle);
    nothingSent();
  });

  test("a noted pot that never got code: the offer again, for THAT address", () => {
    calls.pot = { pot: NOTED };
    calls.raw = ABSENT;
    expect(button(done(kit()), POT.cardTitle)).not.toBeNull();
  });

  test("a read of the noted pot or of the chain that failed: the card says the pot could not be read, with Try again, never a spinner for ever", () => {
    calls.pot = undefined;
    calls.potError = true;
    const noted = done(kit());
    expect(text(noted)).toContain(POT.recordUnavailable);
    expect(button(noted, POT.retry)).not.toBeNull();
    expect(text(noted)).not.toContain(POT.checking);
    expect(button(noted, POT.cardTitle)).toBeNull();

    calls.potError = false;
    calls.pot = { pot: NOTED };
    calls.rawError = true;
    const chain = done(kit());
    expect(text(chain)).toContain(POT.recordUnavailable);
    expect(button(chain, POT.retry)).not.toBeNull();
    nothingSent();
  });

  test("a grant that could not be read still offers the card: the step then says so", () => {
    calls.grant = undefined;
    calls.grantError = true;
    expect(button(done(kit()), POT.cardTitle)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The step and its panels
// ---------------------------------------------------------------------------------------------

describe("the step, opened", () => {
  const step = (over: Partial<Extract<LegalBodyConfig, { available: true }>> = {}) => {
    const k = kit(over);
    return renderToString(
      createElement(PotStep, { kit: k, order: k.order as LegalBodyOrderView, agentWallet: A, onCreated: () => {} }),
    );
  };

  test("nothing on mount but the grant's read: the form, and no chain read, no note, no fresh read of the pot, no wallet", () => {
    const m = step();
    expect(calls.grantQueries).toContain(true);
    // The noted pot is taken from the done page's answer, never asked of the server here.
    expect(calls.potQueries.length).toBeGreaterThan(0);
    expect(calls.potQueries.every((enabled) => enabled === false)).toBe(true);
    expect(text(m)).toContain(POT.title);
    expect(text(m)).toContain(POT.ceilingLabel);
    expect(button(m, POT.review)).not.toBeNull();
    expect(text(m)).not.toContain(POT.declaration);
    nothingSent();
  });

  test("a grant that could not be read: grantUnreadable with Try again, and no form", () => {
    calls.grant = undefined;
    calls.grantError = true;
    const m = step();
    expect(text(m)).toContain(POT.grantUnreadable);
    expect(button(m, POT.retry)).not.toBeNull();
    expect(text(m)).not.toContain(POT.ceilingLabel);
    expect(button(m, POT.review)).toBeNull();
    nothingSent();
  });

  test("while the grant is read: no form yet", () => {
    calls.grant = undefined;
    const m = step();
    expect(text(m)).not.toContain(POT.ceilingLabel);
    expect(button(m, POT.review)).toBeNull();
  });

  test("the form the step opens with: the ceiling EMPTY, the grant's cap beside it, 0.1 proposed for the fee money", () => {
    const m = step();
    const ceiling = /<input[^>]*id="legal-body-pot-ceiling"[^>]*>/.exec(m)?.[0] ?? "";
    expect(ceiling).toContain('value=""');
    expect(text(m)).toContain(fillCopy(POT.ceilingMax, { cap: "350" }));
    expect(/<input[^>]*id="legal-body-pot-gas"[^>]*>/.exec(m)?.[0]).toContain('value="0.1"');
  });

  test("a grant that allows no spending: grantNoSpending, and no form", () => {
    calls.grant = {
      grant: {
        choices: {
          acts: { buy: { allowed: false }, pay: { allowed: false }, engageContractor: { allowed: false } },
          endsOn: null,
        },
      },
    } satisfies OrderGrantView;
    const m = step();
    expect(text(m)).toContain(POT.grantNoSpending);
    expect(text(m)).not.toContain(POT.ceilingLabel);
    expect(button(m, POT.review)).toBeNull();
  });
});

describe("the form", () => {
  const CAP = { kind: "capped" as const, maxUsdc: 350, endsOn: null };
  const form = (over: Partial<Parameters<typeof PotFormPanel>[0]> = {}) =>
    renderToString(
      createElement(PotFormPanel, {
        network: "Arc testnet",
        form: { ceiling: "", fund: "", agentGas: "0.1" },
        problems: null,
        money: potFormMoney({ kind: null, noted: null, registryWallet: A }),
        ceilingHint: potCeilingHint(CAP),
        grantLines: [],
        lines: [],
        busy: false,
        onChange: () => {},
        onReview: () => {},
        ...over,
      }),
    );
  /** The `<input>` tags of the markup. */
  const inputs = (m: string) => [...m.matchAll(/<input[^>]*>/g)].map(([tag]) => tag);

  test("the three labels, what, periods, limits, keepLittle, noRecovery, an empty ceiling input and the grant's maximum", () => {
    const m = form();
    const t = text(m);
    for (const s of [
      POT.ceilingLabel,
      POT.fundLabel,
      POT.gasLabel,
      fillCopy(POT.what, { network: "Arc testnet" }),
      POT.periods,
      POT.limits,
      POT.keepLittle,
      POT.noRecovery,
      POT.fundLine,
      POT.gasLine,
      fillCopy(POT.ceilingMax, { cap: "350" }),
    ])
      expect(t, s).toContain(s);
    const fields = inputs(m);
    expect(fields).toHaveLength(3);
    // The ceiling is EMPTY: the cap is shown beside it, never put in it.
    const ceiling = fields.find((f) => f.includes('id="legal-body-pot-ceiling"'));
    expect(ceiling).toBeDefined();
    expect(ceiling).toContain('value=""');
    expect(ceiling).not.toContain('value="350"');
    expect(t).not.toContain("{");
    expect(button(m, POT.review)).not.toBeNull();
  });

  test("a contract wallet: gasContract in place of the fee field, and no fee field", () => {
    const m = form({
      form: { ceiling: "", fund: "", agentGas: "" },
      money: potFormMoney({ kind: "contract", noted: null, registryWallet: A }),
    });
    expect(text(m)).toContain(POT.gasContract);
    expect(text(m)).not.toContain(POT.gasLabel);
    expect(text(m)).not.toContain(POT.gasLine);
    expect(inputs(m)).toHaveLength(2);
    expect(m).not.toContain('id="legal-body-pot-gas"');
  });

  test("a noted pot made for another key than the record's: no money field, the noted key and why", () => {
    const m = form({
      form: { ceiling: "50", fund: "", agentGas: "" },
      money: potFormMoney({ kind: null, noted: NOTED, registryWallet: P }),
    });
    expect(text(m)).toContain(fillCopy(POT.reviewAgentNoted, { address: A, registry: P }));
    expect(text(m)).toContain(POT.reviewKeyChanged);
    expect(text(m)).not.toContain(POT.fundLabel);
    expect(text(m)).not.toContain(POT.gasLabel);
    expect(inputs(m)).toHaveLength(1);
  });

  test("a grant with a last day says so; each field's problem is said under it", () => {
    const m = form({
      grantLines: ["Your agent's grant ends on 1 March 2027. The pot does not stop by itself on that day: stop the allowance then."],
      problems: { ceiling: POT.ceilingProblems.empty, fund: POT.amountProblems.not_amount },
    });
    expect(text(m)).toContain("Your agent's grant ends on 1 March 2027.");
    expect(text(m)).toContain(POT.ceilingProblems.empty);
    expect(text(m)).toContain(POT.amountProblems.not_amount);
  });
});

describe("the review", () => {
  const review = (declared: boolean, plan: PotPlan = v3Plan()) =>
    renderToString(
      createElement(PotReviewPanel, {
        lines: potReviewLines(plan),
        note: null,
        declared,
        busy: false,
        problems: [],
        onDeclared: () => {},
        onCreate: () => {},
        onBack: () => {},
      }),
    );

  test("every line of potReviewLines, the unticked declaration with its exact sentence, and Create the pot disabled with declarationNeeded", () => {
    const m = review(false);
    for (const line of potReviewLines(v3Plan())) expect(text(m), line).toContain(line);
    expect(text(m)).toContain(POT.declaration);
    expect(POT.declaration).toBe(
      "I declare this pot for the company: it holds the company's money, and its address, its ceiling, what was taken from it and what it holds will show in the public record.",
    );
    const box = [...m.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map(([tag]) => tag);
    expect(box).toHaveLength(1);
    expect(box[0]).not.toMatch(/\schecked=""/);
    const create = button(m, POT.create);
    expect(create).not.toBeNull();
    expect(isDisabled(create)).toBe(true);
    expect(text(m)).toContain(POT.declarationNeeded);
    expect(button(m, POT.back)).not.toBeNull();
  });

  test("once declared is true, Create the pot is enabled and the box is ticked", () => {
    const m = review(true);
    const create = button(m, POT.create);
    expect(isDisabled(create)).toBe(false);
    expect(text(m)).not.toContain(POT.declarationNeeded);
    expect(m).toMatch(/<input[^>]*type="checkbox"[^>]*\schecked=""/);
  });

  test("the review of a plan with money names the sum the wallet will send, from the plan's own value", () => {
    expect(text(review(false))).toContain("send 60.1 USDC to a contract called Multicall3");
  });
});

describe("after the transaction", () => {
  test("the created panel with ok: false shows the reading's own sentence in a warning, and no Create the pot", () => {
    const m = renderToString(createElement(PotCreatedPanel, { ok: false, lines: [POT.stoppedLine] }));
    expect(text(m)).toContain(POT.stoppedLine);
    // The warning's tone: amber, never the calm one.
    expect(m).toContain("text-[#f3cd72]");
    expect(text(m)).not.toContain(POT.created);
    expect(button(m, POT.create)).toBeNull();
    expect(buttons(m)).toHaveLength(0);
  });

  test("the created panel with ok: true says the pot exists, then what the chain shows", () => {
    const lines = [fillCopy(POT.shownCeiling, { amount: "50" })];
    const m = renderToString(createElement(PotCreatedPanel, { ok: true, lines }));
    expect(text(m)).toContain(POT.created);
    expect(text(m)).toContain(lines[0]);
    expect(buttons(m)).toHaveLength(0);
  });

  test("no receipt: the sentence, the transaction's link and Check again", () => {
    const hash = `0x${"7a".repeat(32)}` as Hex;
    const m = renderToString(
      createElement(PotProblemPanel, {
        lines: [POT.problems.no_receipt],
        hash,
        then: "check_again",
        busy: false,
        onCheckAgain: () => {},
        onBack: () => {},
      }),
    );
    expect(text(m)).toContain(POT.problems.no_receipt);
    expect(m).toContain(hash);
    expect(button(m, POT.checkAgain)).not.toBeNull();
    expect(button(m, POT.back)).toBeNull();
  });

  test("a stop offers nothing", () => {
    const m = renderToString(
      createElement(PotProblemPanel, {
        lines: [POT.problems.refused],
        hash: null,
        then: "none",
        busy: false,
        onCheckAgain: () => {},
        onBack: () => {},
      }),
    );
    expect(text(m)).toContain(POT.problems.refused);
    expect(buttons(m)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The public record
// ---------------------------------------------------------------------------------------------

describe("the public record's pot sentence", () => {
  const BIRTH = {
    guardian: G,
    agentWallet: A,
    token: T.usdc,
    ceilingUnits: "50000000",
    periodMinutes: 43200 as const,
    saltNonce: "1",
    proxyFactory: T.proxyFactory,
    singleton: T.safeSingleton,
    fallbackHandler: T.fallbackHandler,
    multiSendCallOnly: T.multiSendCallOnly,
    allowanceModule: T.allowanceModule,
  };
  const BLOCK: PotBlock = {
    state: "ceiling_read",
    address: V3_POT,
    token: T.usdc,
    ceilingUnits: "50000000",
    periodMinutes: 43200,
    spentUnits: "10000000",
    periodEndsAt: NOW_S + 86_400,
    balanceUnits: "190000000",
    readAtBlock: "73886273",
    readAt: NOW_S,
    declaredBy: "guardian",
    declaredAt: NOW_S - 100,
    birth: BIRTH,
  };
  const recordOf = (read: PublicRead<LegalBodyByAgent>) =>
    renderToString(
      createElement(LegalBodyRecord, {
        read,
        orderState: "linked",
        environment: "sandbox",
        paymentRequired: false,
        onRetry: () => {},
        retrying: false,
      }),
    );

  test("under the statement's facts, the record says the pot as served", () => {
    const sentence = potRecordSentence(BLOCK);
    expect(sentence).not.toBeNull();
    const m = text(recordOf(naming(A, BLOCK)));
    expect(m).toContain(sentence as string);
    expect(m.indexOf(sentence as string)).toBeGreaterThan(m.indexOf(LEGAL_BODY_COPY.done.factsHeading));
  });

  test("no pot block, or one of no sentence: nothing of the pot", () => {
    for (const read of [naming(A), naming(A, null)]) {
      const m = text(recordOf(read));
      expect(m).not.toContain("The guardian declared this pot");
      expect(m).not.toContain(POT.recordUnavailable);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The step's source
// ---------------------------------------------------------------------------------------------

describe("the step's source", () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");
  const code = source("PotStep.tsx");
  const panels = source("PotPanels.tsx");
  const files = [
    ["PotStep.tsx", code],
    ["PotPanels.tsx", panels],
  ] as const;

  test("no write of its own and no wallet client: the one way to the wallet is the allowlist", () => {
    for (const [name, file] of files)
      for (const reach of [
        "writeContract",
        "useWriteContract",
        "sendTransaction",
        "useSendTransaction",
        "useWalletClient",
        "useConnectorClient",
        "getWalletClient",
        "sendAllowedCall",
        "eth_sendTransaction",
        "signMessage",
        "signTypedData",
      ])
        expect(file, `${name}: ${reach}`).not.toContain(reach);
  });

  test("the function useAllowedWrite returns is called in exactly one place, inside the send closure handed to runPotCreate", () => {
    expect(code.match(/useAllowedWrite\(/g)).toHaveLength(1);
    const named = /const (\w+) = useAllowedWrite\(\);/.exec(code);
    expect(named).not.toBeNull();
    const name = named?.[1] ?? "";
    const uses = [...code.matchAll(new RegExp(`\\b${name}\\b`, "g"))];
    // Its declaration and its one call: nothing else holds it.
    expect(uses).toHaveLength(2);
    const callsOf = [...code.matchAll(new RegExp(`\\b${name}\\(`, "g"))];
    expect(callsOf).toHaveLength(1);
    const at = callsOf[0]?.index ?? -1;
    const run = code.indexOf("await runPotCreate(");
    expect(run).toBeGreaterThan(0);
    const sendKey = code.indexOf("send: ", run);
    expect(sendKey).toBeGreaterThan(run);
    expect(at).toBeGreaterThan(sendKey);
    // The send closure is the last of the runner's closures: the call ends after it.
    expect(at).toBeLessThan(code.indexOf("if (!life.alive()) return;", sendKey));
  });

  test("the declaration is noted by runPotCreate's declare closure, before its send", () => {
    const run = code.indexOf("await runPotCreate(");
    const declareKey = code.indexOf("declare: ", run);
    const sendKey = code.indexOf("send: ", run);
    expect(declareKey).toBeGreaterThan(run);
    expect(sendKey).toBeGreaterThan(declareKey);
    expect(code.match(/\.mutateAsync\(/g)).toHaveLength(1);
    const note = code.indexOf(".mutateAsync(");
    expect(note).toBeGreaterThan(declareKey);
    expect(note).toBeLessThan(sendKey);
    expect(code.slice(note, sendKey)).toContain("declarationVersion: POT_DECLARATION_VERSION");
    // "Create the pot" does nothing until the box is ticked.
    expect(code).toMatch(/stage\.at !== "review" \|\| !stage\.declared/);
  });

  test("every read the click decides on is made in the click: the noted pot fresh, the registry, the codes, the balance", () => {
    const review = code.slice(code.indexOf("async function onReview"), code.indexOf("async function onCreate"));
    for (const read of ["readPotNow()", "readRegistry(client, agentId)", "getCode(", "getBalance(", "crypto.getRandomValues(new Uint8Array(16))", "runPotReview("])
      expect(review, read).toContain(read);
    // The registry's read is getAgentWallet, through readAgentWallet (unreadable, never "none").
    const registry = code.slice(code.indexOf("function readRegistry"), code.indexOf("async function onReview"));
    expect(registry).toContain("readAgentWallet(");
    expect(registry).toContain('functionName: "getAgentWallet"');
    // The click never plans from the card's cached note.
    expect(review).not.toContain("notedQuery.data");
  });

  test("Create the pot reads the noted pot and the registry again, asks the step's lifetime, and takes the account at the send", () => {
    const create = code.slice(code.indexOf("async function onCreate"), code.indexOf("function refusedBefore"));
    const run = create.indexOf("await runPotCreate(plan, reviewed, {");
    expect(run).toBeGreaterThan(0);
    for (const dep of [
      "alive: () => life.alive()",
      "readNoted: () => readPotNow()",
      "readRegistryWallet: () => readRegistry(client, agentId)",
      "readBalance: () => client.getBalance({ address: plan.guardian })",
      "account: () => walletNow().address",
    ])
      expect(create.slice(run), dep).toContain(dep);
    expect(create).not.toContain("notedQuery.data");
    // "Checking" until the wallet opens; "Waiting for your wallet" set inside the send, right before it.
    const checking = create.indexOf('setStage({ at: "checking", plan })');
    expect(checking).toBeGreaterThan(0);
    expect(checking).toBeLessThan(run);
    expect(create.slice(0, run)).not.toContain('at: "sending"');
    const sendKey = create.indexOf("send: ", run);
    const sending = create.indexOf('setStage({ at: "sending", plan })', sendKey);
    expect(sending).toBeGreaterThan(sendKey);
    expect(sending).toBeLessThan(create.indexOf("writeAllowed(", sendKey));
    // A person who left: nothing more is said.
    expect(create).toContain('if (result.problem === "left") return;');
  });

  test("the allowlist's door reads the account and the chain AT THE SEND, never from the render that made it", () => {
    const hooks = readFileSync(fileURLToPath(new URL("../src/lib/api/legalBodyHooks.ts", import.meta.url)), "utf8");
    const door = hooks.slice(hooks.indexOf("export function useAllowedWrite"), hooks.indexOf("export function useWalletNow"));
    expect(door).toMatch(/\(req: WriteRequest, ctx: CallContext\) => \{\s*const \{ address, chainId \} = getConnection\(config\);/);
    expect(door).toContain("walletAddress: address");
    expect(door).toContain("walletChainId: chainId");
    expect(hooks).not.toMatch(/useConnection\(/);
    const now = hooks.slice(hooks.indexOf("export function useWalletNow"));
    expect(now).toMatch(/\(\): \{ address: Address \| null; chainId: number \| undefined \} => \{\s*const \{ address, chainId \} = getConnection\(config\);/);
  });

  test("the setup is simulated and estimated from the guardian, with no fee field", () => {
    expect(code).toContain("client.call({");
    expect(code).toContain("client.estimateGas({");
    for (const fee of ["maxFeePerGas", "maxPriorityFeePerGas", "gasPrice"]) expect(code, fee).not.toContain(fee);
  });

  test("after a setup lands, the pot is read back against the key it was set up for", () => {
    expect(code).toMatch(/readPotRaw\(client, a, \{ pot: plan\.pot, agentWallet: plan\.agentWallet \}\)/);
    expect(code).toMatch(/potReading\(raw, \{ addresses: a, guardian: plan\.guardian, agentWallet: plan\.agentWallet \}\)/);
    expect(code).toContain("potCreatedView(reading, plan.ceilingUnits)");
  });

  test("nothing typed reaches a browser store", () => {
    for (const [name, file] of files)
      for (const store of ["localStorage", "sessionStorage", "writeLegalBodyMemory", "remember(", "/storage"])
        expect(file, `${name}: ${store}`).not.toContain(store);
  });

  test("the panels draw only: no wallet, no chain, no server", () => {
    expect(panels).not.toContain('from "wagmi"');
    expect(panels).not.toContain("useAllowedWrite");
    expect(panels).not.toContain("usePublicClient");
    expect(panels).not.toContain("legalBodyHooks");
    expect(panels).not.toContain("legalBodyClient");
  });

  test("every timer is a lifetime's", () => {
    expect(code).toContain("stepLifetime()");
    for (const [name, file] of files) {
      expect(file, name).not.toContain("setTimeout");
      expect(file, name).not.toContain("setInterval");
    }
  });
});
