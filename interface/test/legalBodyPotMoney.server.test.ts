/**
 * The pot's card, Task 13: "Add money" and "Send fee money" (one USDC transfer each, `PotMoney`),
 * and the public record's two actions, "Take the pot off the public record" and "Put the pot back
 * on the public record" (`PotRecordAction`, in `PotManage.tsx`), as the server renders them, with
 * every effect run at once as the browser would run it.
 *
 * Rendering reads nothing of the chain or the server and sends nothing: each read a transfer
 * decides on, and its one transaction, are its click's. The record's two actions call the server
 * only, never a wallet. The money panel's source holds one way to the wallet, the allowlist,
 * called in one place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { zeroAddress } from "viem";
import type {
  Address,
  LegalBodyConfig,
  LegalBodyOrderView,
  OrderGrantView,
  OrderPotView,
} from "@/lib/api/types";

const calls = vi.hoisted(() => ({
  allowedWrites: 0,
  chainReads: 0,
  walletReads: 0,
  freshPotReads: 0,
  declares: 0,
  takenOff: 0,
  grant: undefined as unknown,
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

const settled = (data: unknown) => ({
  data,
  isError: false,
  isFetching: false,
  isPending: data === undefined,
  dataUpdatedAt: Date.parse("2026-11-20T12:00:00Z"),
  refetch: async () => ({}),
});

vi.mock("@/lib/api/legalBodyHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/legalBodyHooks")>()),
  useOrderGrantQuery: () => settled(calls.grant),
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
      calls.takenOff += 1;
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
    getTransactionReceipt: read,
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

import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import { PotManage, PotTakeOffCard } from "@/components/legalBody/PotManage";
import { PotActionResultPanel, type PotCardLock } from "@/components/legalBody/PotPanels";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  POT_AGENT_GAS_DEFAULT,
  potAddresses,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import { potReading, type PotRaw } from "@/lib/legalBody/safePotRules";

const POT = LEGAL_BODY_COPY.pot;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
/** The real run of 24 Nov: the guardian, the agent's key, the payee (the "new key" of V12). */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const P = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8" as const;
/** V3 with salt nonce 1: G, A, USDC, 50 USDC in each thirty-day period. */
const V3_POT = "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D" as const;
const CHAIN = 5042002;
const NOW_S = Math.floor(Date.parse("2026-11-20T12:00:00Z") / 1000);
const T = potAddresses(CHAIN) as PotAddresses;
const ZERO = BigInt(0);
const USDC = (n: number) => BigInt(n) * BigInt(1_000_000);
const WEI = (units: bigint) => units * BigInt(1_000_000_000_000);

const config = (): Extract<LegalBodyConfig, { available: true }> => ({
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
});

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
  agentId: "897126",
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

function kit(order: LegalBodyOrderView): LegalBodyStepKit {
  return {
    config: config(),
    tenant: G,
    derivation: { phase: "done" },
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

const NOTED: OrderPotView = {
  address: V3_POT,
  onRecord: true,
  declaredAt: NOW_S - 100,
  birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" },
};

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

/** The proof's healthy pot right after its first take; the agent's key holds 0.1 USDC. */
const HEALTHY: PotRaw = {
  codeHash: SAFE_PROXY_RUNTIME_CODE_HASH,
  singleton: T.safeSingleton,
  owners: [G],
  threshold: BigInt(1),
  modules: { list: [T.allowanceModule], next: SAFE_SENTINEL },
  guard: zeroAddress,
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
const STOPPED: PotRaw = {
  ...HEALTHY,
  modules: { list: [], next: SAFE_SENTINEL },
  delegates: { list: [], next: 0 },
  allowance: [ZERO, ZERO, ZERO, ZERO, BigInt(3)],
};

/** The card's lock (Ruling R25): open, or held by an action in flight. */
const OPEN: PotCardLock = { busy: false, held: () => false, take: () => true, release: () => {} };
const TAKEN: PotCardLock = { busy: true, held: () => true, take: () => false, release: () => {} };

/** The card for a raw read made for `agentWallet` (the record's key). */
function card(
  raw: PotRaw,
  over: { agentWallet?: Address; noted?: OrderPotView; order?: LegalBodyOrderView; lock?: PotCardLock } = {},
): string {
  const order = over.order ?? linkedOrder();
  const agentWallet = over.agentWallet ?? A;
  return renderToString(
    createElement(PotManage, {
      kit: kit(order),
      order,
      noted: over.noted ?? NOTED,
      agentWallet,
      raw,
      reading: potReading(raw, { addresses: T, guardian: G, agentWallet }),
      nowSeconds: NOW_S,
      lock: over.lock ?? OPEN,
      onChanged: () => {},
    }),
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
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function buttons(m: string): { tag: string; words: string }[] {
  return [...m.matchAll(/(<button[^>]*>)([\s\S]*?)<\/button>/g)].map(([, tag, inner]) => ({
    tag: tag ?? "",
    words: text(inner ?? "").trim(),
  }));
}
const button = (m: string, words: string) => buttons(m).find((b) => b.words === words) ?? null;
const isDisabled = (b: { tag: string } | null) => b !== null && /\sdisabled=""/.test(b.tag);
const input = (m: string, id: string) => new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(m)?.[0] ?? null;

const FEE_LINE = fillCopy(POT.feeMoneyLine, { address: A });
const HELD = (amount: string) => fillCopy(POT.shownFeeMoney, { amount });

beforeEach(() => {
  calls.allowedWrites = 0;
  calls.chainReads = 0;
  calls.walletReads = 0;
  calls.freshPotReads = 0;
  calls.declares = 0;
  calls.takenOff = 0;
  calls.grant = GRANT;
});

/** Rendering read nothing of the chain or the server and reached no wallet. */
function nothingSent() {
  expect(calls.chainReads).toBe(0);
  expect(calls.allowedWrites).toBe(0);
  expect(calls.walletReads).toBe(0);
  expect(calls.freshPotReads).toBe(0);
  expect(calls.declares).toBe(0);
  expect(calls.takenOff).toBe(0);
}

describe("Add money and Send fee money", () => {
  test("ceiling_read: Add money with its line, keep little and no recovery, an EMPTY field; Send fee money starting at 0.1 beside what the key holds; Take the pot off the public record", () => {
    const m = card(HEALTHY);
    const t = text(m);
    for (const s of [
      POT.addMoneyTitle,
      fillCopy(POT.addMoneyLine, { address: V3_POT }),
      POT.keepLittle,
      POT.noRecovery,
      POT.addMoneyLabel,
      POT.feeMoneyTitle,
      FEE_LINE,
      HELD("0.1"),
      POT.gasLabel,
      POT.offRecordTitle,
      POT.offRecordLine,
    ])
      expect(t, s).toContain(s);
    expect(input(m, "legal-body-pot-add-money")).toContain('value=""');
    expect(POT_AGENT_GAS_DEFAULT).toBe("0.1");
    expect(input(m, "legal-body-pot-fee-money")).toContain('value="0.1"');
    // The buttons: Add money names no amount until one is typed; fee money names the 0.1 proposed.
    expect(button(m, POT.addMoneyTitle)).not.toBeNull();
    expect(isDisabled(button(m, POT.addMoneyTitle))).toBe(false);
    expect(button(m, fillCopy(POT.feeMoneySend, { amount: "0.1" }))).not.toBeNull();
    expect(button(m, POT.offRecordSend)).not.toBeNull();
    // What the key holds is said once, in the fee money panel, never twice on the card.
    expect(count(t, HELD("0.1"))).toBe(1);
    expect(t.indexOf(HELD("0.1"))).toBeGreaterThan(t.indexOf(POT.feeMoneyTitle));
    expect(t).not.toContain(POT.feeMoneyLow);
    // Off the record only: no put back.
    expect(t).not.toContain(POT.backOnTitle);
    expect(t).not.toContain(POT.offRecord);
    nothingSent();
  });

  test("the agent's key at 0.001 USDC: the low mark's warning, once, in the fee money panel", () => {
    const m = card({ ...HEALTHY, agentBalanceWei: BigInt("1000000000000000") });
    const t = text(m);
    expect(t).toContain(HELD("0.001"));
    expect(count(t, POT.feeMoneyLow)).toBe(1);
    expect(t.indexOf(POT.feeMoneyLow)).toBeGreaterThan(t.indexOf(POT.feeMoneyTitle));
    expect(m).toContain("text-[#f3cd72]");
    nothingSent();
  });

  test("a contract wallet: no Send fee money, and nothing said of its balance; Add money still there", () => {
    const m = card({ ...HEALTHY, agentHasCode: true, agentBalanceWei: ZERO });
    const t = text(m);
    expect(t).not.toContain(POT.feeMoneyTitle);
    expect(t).not.toContain(FEE_LINE);
    expect(t).not.toContain(POT.feeMoneyLow);
    expect(t).not.toContain("Your agent's key holds");
    expect(m).not.toContain('id="legal-body-pot-fee-money"');
    expect(t).toContain(POT.addMoneyTitle);
  });

  test("a stopped pot: Add money and Send fee money beside Start again", () => {
    const t = text(card(STOPPED));
    for (const s of [POT.startAgainTitle, POT.addMoneyTitle, POT.feeMoneyTitle, FEE_LINE, HELD("0.1")]) expect(t, s).toContain(s);
  });

  test("after a changed-key setup (other_delegate): My agent has a new key and Stop only, no money panel until the new key is set", () => {
    const m = card(HEALTHY, { agentWallet: P });
    const t = text(m);
    expect(t).toContain(POT.newKeyTitle);
    for (const s of [POT.addMoneyTitle, POT.feeMoneyTitle]) expect(t, s).not.toContain(s);
    expect(m).not.toContain('id="legal-body-pot-add-money"');
    expect(m).not.toContain('id="legal-body-pot-fee-money"');
    expect(t).toContain(POT.offRecordTitle);
  });

  test("not the guardian's pot: no money panel, the record action only", () => {
    const m = card({ ...HEALTHY, owners: [P] });
    const t = text(m);
    for (const s of [POT.addMoneyTitle, POT.feeMoneyTitle]) expect(t, s).not.toContain(s);
    expect(buttons(m).map((b) => b.words)).toEqual([POT.offRecordSend]);
  });
});

describe("the public record", () => {
  test("off the record: offRecord, and Put the pot back on the public record with the declaration unticked and its button disabled; no Add money, no take off", () => {
    const m = card(HEALTHY, { noted: { ...NOTED, onRecord: false } });
    const t = text(m);
    expect(t).toContain(POT.offRecord);
    expect(t).toContain(POT.backOnTitle);
    expect(t).toContain(POT.declaration);
    expect(t).toContain(POT.declarationNeeded);
    const box = /<input[^>]*type="checkbox"[^>]*>/.exec(m)?.[0] ?? "";
    expect(box).not.toBe("");
    expect(box).not.toMatch(/\schecked(=""|\s|>)/);
    expect(button(m, POT.backOnSend)).not.toBeNull();
    expect(isDisabled(button(m, POT.backOnSend))).toBe(true);
    // Add money only while on the record; the fee money and the Safe's own actions stay.
    expect(t).not.toContain(POT.addMoneyTitle);
    expect(t).toContain(POT.feeMoneyTitle);
    expect(t).toContain(POT.changeTitle);
    expect(t).not.toContain(POT.offRecordTitle);
    expect(button(m, POT.offRecordSend)).toBeNull();
    nothingSent();
  });

  test("never put back for an order of another deployment: the server refuses it", () => {
    const order = linkedOrder({ factory: "0x00000000000000000000000000000000000fac70" });
    const t = text(card(HEALTHY, { noted: { ...NOTED, onRecord: false }, order }));
    expect(t).toContain(POT.offRecord);
    expect(t).not.toContain(POT.backOnTitle);
    expect(t).not.toContain(POT.declaration);
  });

  test("on the record: the take off is one button, enabled, with no wallet behind it", () => {
    const m = card(STOPPED);
    expect(isDisabled(button(m, POT.offRecordSend))).toBe(false);
    expect(text(m)).not.toContain(POT.declaration);
    nothingSent();
  });
});

describe("one action at a time on the card (Ruling R25)", () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");
  /** Every button that starts one of the card's actions (a wallet's or the record's). */
  const ACTIONS = [
    POT.changeSend,
    POT.stopSend,
    fillCopy(POT.withdrawSend, { balance: "190" }),
    POT.startAgainSend,
    POT.newKeySend,
    POT.addMoneyTitle,
    fillCopy(POT.feeMoneySend, { amount: "0.1" }),
    POT.offRecordSend,
    POT.backOnSend,
  ];
  const cases: [string, PotRaw, { agentWallet?: Address; noted?: OrderPotView }][] = [
    ["ceiling_read", HEALTHY, {}],
    ["stopped with money", STOPPED, {}],
    ["off the record", HEALTHY, { noted: { ...NOTED, onRecord: false } }],
    ["a new key in the registry", HEALTHY, { agentWallet: P }],
  ];

  test("while any action of the card is in flight, every action's button is disabled, and every field and the tick box with them; Copy stays", () => {
    for (const [what, raw, over] of cases) {
      const m = card(raw, { ...over, lock: TAKEN });
      const shown = buttons(m).filter((b) => ACTIONS.includes(b.words));
      expect(shown.length, what).toBeGreaterThan(1);
      for (const b of shown) expect(isDisabled(b), `${what}: ${b.words}`).toBe(true);
      for (const field of m.match(/<input[^>]*>/g) ?? []) expect(field, what).toMatch(/\sdisabled=""/);
      for (const b of buttons(m).filter((x) => x.words === POT.copy)) expect(isDisabled(b), what).toBe(false);
    }
    nothingSent();
  });

  test("with the card open, the same buttons are enabled, but for the put back until its box is ticked", () => {
    for (const [what, raw, over] of cases) {
      const m = card(raw, { ...over, lock: OPEN });
      for (const b of buttons(m).filter((x) => ACTIONS.includes(x.words)))
        expect(isDisabled(b), `${what}: ${b.words}`).toBe(b.words === POT.backOnSend);
    }
  });

  test("Check again, after a transaction not seen in time, follows the card's lock too", () => {
    const hash = `0x${"7a".repeat(32)}` as const;
    const panel = (disabled: boolean) =>
      renderToString(
        createElement(PotActionResultPanel, {
          title: POT.addMoneyTitle,
          stage: { at: "problem", action: "add_money", lines: [POT.problems.no_receipt], hash, again: { pot: V3_POT, agentWallet: A, ceilingUnits: null, hash, confirmed: false } },
          after: [],
          busy: false,
          disabled,
          onCheckAgain: () => {},
        }),
      );
    expect(isDisabled(button(panel(false), POT.checkAgain))).toBe(false);
    expect(isDisabled(button(panel(true), POT.checkAgain))).toBe(true);
    // Both result areas hand it the card's lock.
    for (const file of [source("PotManage.tsx"), source("PotMoney.tsx")])
      expect(file).toMatch(/<PotActionResultPanel[^>]*disabled=\{lock\.busy\}/);
  });

  test("the minimal take-off card follows the card's lock too", () => {
    const render = (lock: PotCardLock) =>
      renderToString(
        createElement(PotTakeOffCard, { kit: kit(linkedOrder()), order: linkedOrder(), noted: NOTED, lock, onChanged: () => {} }),
      );
    expect(isDisabled(button(render(OPEN), POT.offRecordSend))).toBe(false);
    expect(isDisabled(button(render(TAKEN), POT.offRecordSend))).toBe(true);
    const t = text(render(OPEN));
    expect(t).toContain(POT.title);
    expect(t).toContain(fillCopy(POT.shownAddress, { address: V3_POT }));
    expect(t).toContain(POT.offRecordLine);
    // Nothing else of the pot.
    expect(buttons(render(OPEN)).map((b) => b.words)).toEqual([POT.offRecordSend]);
    nothingSent();
  });
});

describe("the sources", () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");
  const code = source("PotMoney.tsx");
  const manage = source("PotManage.tsx");
  const panels = source("PotPanels.tsx");
  /** The record's two actions: the component and nothing else of PotManage.tsx. */
  const record = manage.slice(manage.indexOf("export function PotRecordAction"));

  test("no write of its own and no wallet client: the one way to the wallet is the allowlist", () => {
    for (const [name, file] of [
      ["PotMoney.tsx", code],
      ["PotManage.tsx", manage],
      ["PotPanels.tsx", panels],
    ] as const)
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

  test("the function useAllowedWrite returns is called in exactly one place, inside the send closure handed to runPotTransfer", () => {
    expect(code.match(/useAllowedWrite\(/g)).toHaveLength(1);
    const named = /const (\w+) = useAllowedWrite\(\);/.exec(code);
    expect(named).not.toBeNull();
    const name = named?.[1] ?? "";
    // Its declaration and its one call: nothing else holds it.
    expect([...code.matchAll(new RegExp(`\\b${name}\\b`, "g"))]).toHaveLength(2);
    const callsOf = [...code.matchAll(new RegExp(`\\b${name}\\(`, "g"))];
    expect(callsOf).toHaveLength(1);
    const at = callsOf[0]?.index ?? -1;
    const run = code.indexOf("await runPotTransfer(");
    expect(run).toBeGreaterThan(0);
    const sendKey = code.indexOf("send: ", run);
    expect(sendKey).toBeGreaterThan(run);
    expect(at).toBeGreaterThan(sendKey);
    expect(at).toBeLessThan(code.indexOf("if (!life.alive()) return;", sendKey));
    // "Waiting for your wallet." only once the wallet opens: set inside the send, right before it.
    const sending = code.indexOf('setStage({ at: "sending", action: kind })', sendKey);
    expect(sending).toBeGreaterThan(sendKey);
    expect(sending).toBeLessThan(at);
    const checking = code.indexOf('setStage({ at: "checking", action: kind })');
    expect(checking).toBeGreaterThan(0);
    expect(checking).toBeLessThan(run);
    expect(code.slice(0, run)).not.toContain('at: "sending"');
    // The request is the transfer's, at the gas decided by the runner.
    expect(code.slice(sendKey, at)).toContain("potTransferCall(config, ctx, gas)");
  });

  test("every read the click decides on is made in the click: the registry's key, the pot read for it, the guardian's balance, and GET /pot fresh; the lifetime and the account asked at the moment", () => {
    const click = code.slice(code.indexOf("async function onTransfer"), code.indexOf("async function afterSend"));
    for (const read of [
      "readRegistry(client, agentId)",
      // The pot read is the runner's checked address, handed to the closure (by construction).
      "read: async (pot) => {",
      "readPotRaw(client, a, { pot, agentWallet: wallet })",
      "potReading(fresh, { addresses: a, guardian, agentWallet: wallet })",
      "client.getBalance({ address: guardian })",
      "readNoted: () => readPotNow()",
      "alive: () => life.alive()",
      "account: () => walletNow().address",
      "readBalance: () => client.getBalance({ address: guardian })",
      "potTransferCall(config, ctx, POT_TRANSFER_GAS_CAP)",
      "allowedCall(req, { config, order, pot: ctx })",
    ])
      expect(click, read).toContain(read);
    const readClosure = click.slice(click.indexOf("read: async (pot) => {"), click.indexOf("readNoted: () =>"));
    expect(readClosure).not.toContain("noted.address");
    const registry = code.slice(code.indexOf("function readRegistry"), code.indexOf("async function onTransfer"));
    expect(registry).toContain("readAgentWallet(");
    expect(registry).toContain('functionName: "getAgentWallet"');
    // The card's key reaches the click only as the key the fee money panel named (Ruling R23),
    // which the click's own read must equal; its raw facts never.
    expect(click).toContain("await runPotTransfer(kind, shown, {");
    const built = /const shown = \{([^}]*)\};/.exec(click);
    expect(built).not.toBeNull();
    const p = built?.[1] ?? "";
    expect(p).toContain("pot: noted.address");
    expect(p).toContain("shownAgentWallet: shownWallet");
    expect(p.replace("shownAgentWallet: shownWallet", "")).not.toMatch(/agentWallet|shownWallet/i);
    expect(click.match(/shownWallet/g)).toHaveLength(1);
    const clicks = code.slice(code.indexOf("async function onTransfer"), code.indexOf("const feeLines = "));
    expect(clicks).toContain("async function readBack");
    expect(clicks).toContain("async function onCheckAgain");
    for (const shown of ["shownWallet", "shownRaw"]) {
      expect(code, shown).toContain(shown);
      expect(clicks.replace("shownAgentWallet: shownWallet", ""), shown).not.toContain(shown);
    }
    // The click's own continuation asks the lifetime as soon as the runner answers.
    expect(click).toMatch(/\}\);\s*if \(!life\.alive\(\)\) return;\s*if \(!result\.ok\) \{/);
    expect(code).toContain('if (result.problem === "left") return;');
  });

  test("after the receipt the pot and the key are read again against the click's own key, then the done page reads again", () => {
    const back = code.slice(code.indexOf("async function readBack"), code.indexOf("async function onCheckAgain"));
    expect(back).toContain("const wallet = again.agentWallet;");
    // Read back at the address the runner checked, never the component's noted one.
    expect(back).toContain("readPotRaw(client, a, { pot: again.pot, agentWallet: wallet })");
    expect(back).not.toContain("noted.address");
    expect(back).toContain("potTransferDoneView(");
    expect(code).toContain("pot: result.pot,");
    expect(back).toContain("latestOnChanged.current()");
    expect(code).toContain("result.agentWallet");
  });

  test("simulated and estimated from the guardian, with no fee field and no value: the money moves as USDC units", () => {
    expect(code).toContain("client.call({ account: guardian, to: call.to, data: call.data })");
    expect(code).toContain("client.estimateGas({ account: guardian, to: call.to, data: call.data })");
    for (const fee of ["maxFeePerGas", "maxPriorityFeePerGas", "gasPrice", "value:"]) expect(code, fee).not.toContain(fee);
  });

  test("the record's two actions call the server only: no wallet, no chain; the put back carries the noted address, its birth details and the declaration's version, and only once ticked", () => {
    expect(record.length).toBeGreaterThan(200);
    for (const reach of ["useAllowedWrite", "writeAllowed", "usePublicClient", "useWalletNow", "runPot", "readPotRaw"])
      expect(record, reach).not.toContain(reach);
    expect(record.match(/\.mutateAsync\(/g)).toHaveLength(2);
    const put = record.slice(record.indexOf("declarePot.mutateAsync("));
    for (const field of [
      "address: noted.address",
      "saltNonce: noted.birth.saltNonce",
      "ceilingUnits: noted.birth.ceilingUnits",
      "agentWallet: noted.birth.agentWallet",
      "declarationVersion: POT_DECLARATION_VERSION",
    ])
      expect(put.slice(0, put.indexOf("})")), field).toContain(field);
    expect(record).toContain('if (act === "put_back" && !declared) return;');
    expect(record).toContain("takeOff.mutateAsync()");
    // A refusal: sign in first; then the sentence, and the pot and the record read again when the
    // view says so (pot_not_on_record shows nothing and reads again).
    expect(record).toContain("kit.routeSignIn(e)");
    expect(record).toContain("potRecordFailureView(e)");
    expect(record).toContain("if (failed.reread) latestOnChanged.current();");
    expect(record).toContain("stepLifetime()");
  });

  test("a person who left is told nothing; nothing typed reaches a browser store; every timer is a lifetime's; no way to a second pot", () => {
    for (const [name, file] of [
      ["PotMoney.tsx", code],
      ["PotManage.tsx", manage],
    ] as const) {
      expect(file, name).toContain("stepLifetime()");
      for (const store of ["localStorage", "sessionStorage", "writeLegalBodyMemory", "remember(", "/storage"])
        expect(file, `${name}: ${store}`).not.toContain(store);
      expect(file, name).not.toContain("setTimeout");
      expect(file, name).not.toContain("setInterval");
      expect(file.toLowerCase(), name).not.toContain("create a new pot");
      expect(file, name).not.toContain("potSetupCall");
      expect(file, name).not.toContain("aggregate3Value");
    }
    expect(panels).not.toContain("setTimeout");
  });

  test("Ruling R25: every click of the card takes the card's one lock and gives it back, and every action's button and field reads it", () => {
    for (const [name, file] of [
      ["PotMoney.tsx", code],
      ["PotManage.tsx", manage],
    ] as const) {
      expect(file, name).not.toContain("inFlight");
      expect(file, name).not.toMatch(/disabled=\{busy/);
      expect(file, name).not.toMatch(/disabled: busy/);
    }
    // PotManage: the action and Check again; PotMoney: the transfer and Check again; the record.
    expect(manage.slice(0, manage.indexOf("export function PotRecordAction")).match(/if \(!lock\.take\(\)\) return;/g)).toHaveLength(2);
    expect(code.match(/if \(!lock\.take\(\)\) return;/g)).toHaveLength(2);
    expect(record.match(/if \(!lock\.take\(\)\) return;/g)).toHaveLength(1);
    // The put back waits for its tick AND for the card (a server render never shows it ticked).
    expect(record).toContain("disabled={lock.busy || !declared}");
    for (const file of [code, manage]) expect(file.match(/lock\.release\(\);/g)?.length).toBe(file.match(/lock\.take\(\)/g)?.length);
    // One lock per card, the done page's, handed down.
    expect(manage).toContain("lock={lock}");
    const done = source("DoneStep.tsx");
    expect(done).toContain("const lock = usePotCardLock();");
  });

  test("the record action starts again whenever the action changes: the declaration never shows ticked, no refusal is left over", () => {
    expect(manage).toMatch(/<PotRecordAction\s+key=\{recordAction \?\? "none"\}/);
    expect(record).toContain("const [declared, setDeclared] = useState(false);");
  });

  test("the panels draw only: no wallet, no chain, no server", () => {
    expect(panels).not.toContain('from "wagmi"');
    expect(panels).not.toContain("useAllowedWrite");
    expect(panels).not.toContain("usePublicClient");
    expect(panels).not.toContain("legalBodyHooks");
    expect(panels).not.toContain("legalBodyClient");
  });
});
