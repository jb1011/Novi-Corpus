/**
 * The pot's card once the pot exists (`PotManage`): what the chain shows, the guardian's actions on
 * the SAME Safe (change, stop, take back, start again, a new key), each its own panel with one
 * transaction, and the agent's side, as the server renders them, with every effect run at once as
 * the browser would run it.
 *
 * Rendering reads nothing of the chain and sends nothing: every read an action decides on, and
 * its one transaction, are its click's. There is never a way to create a second pot. The card's
 * source holds one way to the wallet, the allowlist, called in one place.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { zeroAddress } from "viem";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import type {
  Address,
  Hex,
  LegalBodyByAgent,
  LegalBodyConfig,
  LegalBodyOrderView,
  LegalBodyStatementJson,
  OrderGrantView,
  OrderPotView,
} from "@/lib/api/types";

const calls = vi.hoisted(() => ({
  allowedWrites: 0,
  chainReads: 0,
  walletReads: 0,
  grantQueries: [] as boolean[],
  byAgent: undefined as unknown,
  pot: undefined as unknown,
  grant: undefined as unknown,
  raw: undefined as unknown,
  grantError: false,
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
  useOrderPotQuery: () => settled(calls.pot),
  useOrderGrantQuery: (_id: unknown, enabled: boolean) => {
    calls.grantQueries.push(enabled);
    return settled(calls.grant, calls.grantError ? { isError: true, isPending: false } : {});
  },
  usePotRawQuery: () => settled(calls.raw),
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
  useDeclarePotMutation: () => ({
    mutateAsync: async () => {
      throw new Error("not in this test");
    },
  }),
  useReadOrderPotNow: () => async () => {
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

import { DoneStep } from "@/components/legalBody/DoneStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import { PotManage } from "@/components/legalBody/PotManage";
import { PotActionResultPanel } from "@/components/legalBody/PotPanels";
import { arcTestnet } from "@/lib/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { formatDate } from "@/lib/format";
import { potAddresses, SAFE_PROXY_RUNTIME_CODE_HASH, SAFE_SENTINEL, type PotAddresses } from "@/lib/legalBody/safePot";
import { potReading, type PotRaw } from "@/lib/legalBody/safePotRules";
import { potAgentCommands, potCeilingHint } from "@/lib/legalBody/safePotStep";

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

const linkedOrder = (): LegalBodyOrderView => ({
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
});

function kit(): LegalBodyStepKit {
  const order = linkedOrder();
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
const HEALTHY_ENDS = (29_919_864 + 43200) * 60;
/** The real Safe after the run's stop: no module, no delegate, money still in it. */
const STOPPED: PotRaw = {
  ...HEALTHY,
  modules: { list: [], next: SAFE_SENTINEL },
  delegates: { list: [], next: 0 },
  allowance: [ZERO, ZERO, ZERO, ZERO, BigInt(3)],
};

/** The body's public record, naming `agentWallet` as the agent's wallet. */
const naming = (agentWallet: string): PublicRead<LegalBodyByAgent> => ({
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
      message: { agentWallet, legalBody: "0x00000000000000000000000000000000000b0d1e" } as unknown as LegalBodyStatementJson,
      attestor: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      signature: `0x${"cd".repeat(65)}`,
    },
  },
});

/** The card for a raw read, read for `agentWallet` (the record's key). */
function manage(raw: PotRaw, agentWallet: Address = A, noted: OrderPotView = NOTED): string {
  const k = kit();
  return renderToString(
    createElement(PotManage, {
      kit: k,
      order: k.order as LegalBodyOrderView,
      noted,
      agentWallet,
      raw,
      reading: potReading(raw, { addresses: T, guardian: G, agentWallet }),
      nowSeconds: NOW_S,
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

/** Every button: its opening tag and the words inside. */
function buttons(m: string): { tag: string; words: string }[] {
  return [...m.matchAll(/(<button[^>]*>)([\s\S]*?)<\/button>/g)].map(([, tag, inner]) => ({
    tag: tag ?? "",
    words: text(inner ?? "").trim(),
  }));
}
const button = (m: string, words: string) => buttons(m).find((b) => b.words === words) ?? null;
const isDisabled = (b: { tag: string } | null) => b !== null && /\sdisabled=""/.test(b.tag);
/** The Safe actions' buttons: every one sends one transaction. */
const SAFE_BUTTONS = [
  POT.changeSend,
  POT.stopSend,
  fillCopy(POT.withdrawSend, { balance: "190" }),
  POT.startAgainSend,
  POT.newKeySend,
];

beforeEach(() => {
  calls.allowedWrites = 0;
  calls.chainReads = 0;
  calls.walletReads = 0;
  calls.grantQueries = [];
  calls.byAgent = naming(A);
  calls.pot = { pot: NOTED };
  calls.grant = GRANT;
  calls.raw = HEALTHY;
  calls.grantError = false;
});

/** Rendering read nothing of the chain and reached no wallet. */
function nothingSent() {
  expect(calls.chainReads).toBe(0);
  expect(calls.allowedWrites).toBe(0);
  expect(calls.walletReads).toBe(0);
}

describe("the pot's card, as the chain shows the pot", () => {
  test("ceiling_read: the ceiling, what is left, Change the allowance and Stop the allowance; no take back, no start again; the agent's panel with both commands", () => {
    const m = manage(HEALTHY);
    const t = text(m);
    expect(t).toContain(fillCopy(POT.shownCeiling, { amount: "50" }));
    expect(t).toContain(fillCopy(POT.shownSpent, { spent: "10", left: "40", date: formatDate(HEALTHY_ENDS * 1000) }));
    for (const s of [POT.changeTitle, POT.changeLine, POT.stopTitle, POT.stopLine]) expect(t, s).toContain(s);
    expect(button(m, POT.changeSend)).not.toBeNull();
    expect(isDisabled(button(m, POT.changeSend))).toBe(false);
    expect(button(m, POT.stopSend)).not.toBeNull();
    for (const s of [POT.withdrawTitle, POT.startAgainTitle, POT.newKeyTitle, POT.onePot]) expect(t, s).not.toContain(s);
    // The change's ceiling field starts EMPTY, the grant's cap beside it.
    const field = /<input[^>]*id="legal-body-pot-ceiling-change"[^>]*>/.exec(m)?.[0] ?? "";
    expect(field).toContain('value=""');
    expect(t).toContain(potCeilingHint({ kind: "capped", maxUsdc: 350, endsOn: null }));
    // The agent's side: its title, line, the MCP tools, and the two commands with their intros.
    for (const s of [POT.agentTitle, POT.agentLine, POT.agentMcp, POT.agentCommandIntro, POT.agentReadIntro, POT.agentReadLine])
      expect(t, s).toContain(s);
    const commands = potAgentCommands({ addresses: T, pot: V3_POT, agentWallet: A, rpcUrl: arcTestnet.rpcUrls.default.http[0] });
    for (const command of [commands.take, commands.read]) {
      expect(t).toContain(command);
      expect(command).toContain(V3_POT);
      expect(command).toContain(A);
      expect(command).toContain(`--rpc-url ${arcTestnet.rpcUrls.default.http[0]}`);
    }
    nothingSent();
  });

  test("stopped with money: stoppedLine, Take the money back with the balance, Start again with onePot beside it; no agent's panel, no change", () => {
    const m = manage(STOPPED);
    const t = text(m);
    expect(t).toContain(POT.stoppedLine);
    expect(t).toContain(POT.withdrawTitle);
    expect(t).toContain(fillCopy(POT.withdrawLine, { balance: "190" }));
    expect(button(m, fillCopy(POT.withdrawSend, { balance: "190" }))).not.toBeNull();
    expect(t).toContain(POT.startAgainTitle);
    // Ruling R23: the panel names the key the allowance goes to.
    expect(t).toContain(fillCopy(POT.startAgainLine, { address: A }));
    expect(POT.startAgainLine).toContain("{address}");
    expect(button(m, POT.startAgainSend)).not.toBeNull();
    expect(t).toContain(POT.onePot);
    expect(t.indexOf(POT.onePot)).toBeGreaterThan(t.indexOf(POT.startAgainTitle));
    expect(/<input[^>]*id="legal-body-pot-ceiling-start_again"[^>]*>/.exec(m)?.[0]).toContain('value=""');
    for (const s of [POT.agentTitle, POT.changeTitle, POT.newKeyTitle]) expect(t, s).not.toContain(s);
    // Nothing left to stop: no stop.
    expect(button(m, POT.stopSend)).toBeNull();
    nothingSent();
  });

  test("stopped and empty: no take back, Start again only", () => {
    const m = manage({ ...STOPPED, balanceUnits: ZERO, balanceWei: ZERO });
    expect(text(m)).not.toContain(POT.withdrawTitle);
    expect(button(m, POT.startAgainSend)).not.toBeNull();
  });

  test("other_delegate with a new key in the registry: My agent has a new key, naming it, and the stop; no change, no add money", () => {
    const m = manage(HEALTHY, P);
    const t = text(m);
    expect(t).toContain(POT.newKeyTitle);
    expect(t).toContain(fillCopy(POT.newKeyLine, { address: P }));
    expect(button(m, POT.newKeySend)).not.toBeNull();
    expect(button(m, POT.stopSend)).not.toBeNull();
    expect(/<input[^>]*id="legal-body-pot-ceiling-new_key"[^>]*>/.exec(m)?.[0]).toContain('value=""');
    for (const s of [POT.changeTitle, POT.agentTitle, POT.addMoneyTitle, POT.startAgainTitle]) expect(t, s).not.toContain(s);
    nothingSent();
  });

  test("not_the_guardians: notYours, and no Safe button at all", () => {
    const m = manage({ ...HEALTHY, owners: [P] });
    expect(text(m)).toContain(POT.notYours);
    for (const words of SAFE_BUTTONS) expect(button(m, words), words).toBeNull();
    expect(buttons(m)).toHaveLength(0);
    for (const s of [POT.changeTitle, POT.stopTitle, POT.agentTitle]) expect(text(m), s).not.toContain(s);
  });

  test("no render ever offers a second pot", () => {
    const raws: [PotRaw, Address][] = [
      [HEALTHY, A],
      [STOPPED, A],
      [{ ...STOPPED, balanceUnits: ZERO, balanceWei: ZERO }, A],
      [HEALTHY, P],
      [{ ...HEALTHY, owners: [P] }, A],
      [{ ...HEALTHY, guard: P }, A],
    ];
    for (const [raw, wallet] of raws) {
      const t = text(manage(raw, wallet));
      expect(t.toLowerCase()).not.toContain("create a new pot");
      expect(t).not.toContain(POT.create);
      expect(t).not.toContain(POT.cardTitle);
    }
  });

  test("a grant that could not be read: the ceiling's panels say so with Try again and their button is disabled; the stop is still there", () => {
    calls.grant = undefined;
    calls.grantError = true;
    const m = manage(HEALTHY);
    expect(text(m)).toContain(POT.grantUnreadable);
    expect(button(m, POT.retry)).not.toBeNull();
    expect(isDisabled(button(m, POT.changeSend))).toBe(true);
    expect(isDisabled(button(m, POT.stopSend))).toBe(false);
    expect(m).not.toContain('id="legal-body-pot-ceiling-change"');
  });

  test("the card asks for the grant (the done page's cached answer) and nothing else on mount", () => {
    manage(HEALTHY);
    expect(calls.grantQueries).toContain(true);
    nothingSent();
  });
});

describe("the done page", () => {
  test("a noted pot with code: the manage card is the pot's card with its actions", () => {
    const m = renderToString(createElement(DoneStep, { kit: kit() }));
    const t = text(m);
    expect(t).toContain(POT.title);
    expect(t).toContain(POT.changeTitle);
    expect(button(m, POT.stopSend)).not.toBeNull();
    expect(button(m, POT.cardTitle)).toBeNull();
    nothingSent();
  });
});

describe("an action's result", () => {
  const HASH = `0x${"7a".repeat(32)}` as Hex;
  const result = (stage: Parameters<typeof PotActionResultPanel>[0]["stage"], after: string[] = []) =>
    renderToString(
      createElement(PotActionResultPanel, { title: POT.stopTitle, stage, after, busy: false, onCheckAgain: () => {} }),
    );

  test("checking, the wallet open, and the chain awaited, with the transaction's link", () => {
    expect(text(result({ at: "checking", action: "stop" }))).toContain(POT.checkingSend);
    expect(text(result({ at: "sending", action: "stop" }))).toContain(POT.sending);
    const waiting = result({ at: "waiting", action: "stop", hash: HASH });
    expect(text(waiting)).toContain(POT.waitingChange);
    expect(waiting).toContain(HASH);
    expect(buttons(waiting)).toHaveLength(0);
  });

  test("done: POT.done and what the chain shows, with onePot under the stop's result; a reading that is not what was asked is a warning", () => {
    const lines = [POT.stoppedLine, fillCopy(POT.shownBalance, { balance: "190" })];
    const done = result({ at: "done", action: "stop", ok: true, lines, hash: HASH }, [POT.onePot]);
    const t = text(done);
    expect(t).toContain(POT.stopTitle);
    expect(t).toContain(POT.done);
    for (const line of lines) expect(t).toContain(line);
    expect(t.indexOf(POT.onePot)).toBeGreaterThan(t.indexOf(lines[1]));
    expect(buttons(done)).toHaveLength(0);
    const warning = result({ at: "done", action: "change", ok: false, lines: [POT.stoppedLine], hash: HASH });
    expect(text(warning)).not.toContain(POT.done);
    expect(text(warning)).toContain(POT.stoppedLine);
    expect(warning).toContain("text-[#f3cd72]");
  });

  test("a problem: its sentence, the transaction's link when there is one, and Check again only when the chain may still show it", () => {
    const again = result({
      at: "problem",
      action: "stop",
      lines: [POT.problems.no_receipt],
      hash: HASH,
      again: { agentWallet: A, ceilingUnits: null, hash: HASH, confirmed: false },
    });
    expect(text(again)).toContain(POT.problems.no_receipt);
    expect(again).toContain(HASH);
    expect(button(again, POT.checkAgain)).not.toBeNull();
    const plain = result({ at: "problem", action: "stop", lines: [POT.problems.would_revert], hash: null, again: null });
    expect(text(plain)).toContain(POT.problems.would_revert);
    expect(buttons(plain)).toHaveLength(0);
  });
});

describe("the card's source", () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");
  const code = source("PotManage.tsx");
  const panels = source("PotPanels.tsx");

  test("no write of its own and no wallet client: the one way to the wallet is the allowlist", () => {
    for (const [name, file] of [
      ["PotManage.tsx", code],
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

  test("the function useAllowedWrite returns is called in exactly one place, inside the send closure handed to runPotAction", () => {
    expect(code.match(/useAllowedWrite\(/g)).toHaveLength(1);
    const named = /const (\w+) = useAllowedWrite\(\);/.exec(code);
    expect(named).not.toBeNull();
    const name = named?.[1] ?? "";
    expect([...code.matchAll(new RegExp(`\\b${name}\\b`, "g"))]).toHaveLength(2);
    const callsOf = [...code.matchAll(new RegExp(`\\b${name}\\(`, "g"))];
    expect(callsOf).toHaveLength(1);
    const at = callsOf[0]?.index ?? -1;
    const run = code.indexOf("await runPotAction(");
    expect(run).toBeGreaterThan(0);
    const sendKey = code.indexOf("send: ", run);
    expect(sendKey).toBeGreaterThan(run);
    expect(at).toBeGreaterThan(sendKey);
    expect(at).toBeLessThan(code.indexOf("if (!life.alive()) return;", sendKey));
    // "Waiting for your wallet." only once the wallet opens: set inside the send, right before it.
    const sending = code.indexOf('setStage({ at: "sending", action })', sendKey);
    expect(sending).toBeGreaterThan(sendKey);
    expect(sending).toBeLessThan(at);
    const checking = code.indexOf('setStage({ at: "checking", action })');
    expect(checking).toBeGreaterThan(0);
    expect(checking).toBeLessThan(run);
    expect(code.slice(0, run)).not.toContain('at: "sending"');
  });

  test("every read the click decides on is made in the click: the registry's key, then the pot read for it; the lifetime and the account asked at the moment", () => {
    const click = code.slice(code.indexOf("async function onAction"), code.indexOf("async function afterSend"));
    for (const read of [
      "readRegistry(client, agentId)",
      "readPotRaw(client, a, { pot: noted.address, agentWallet: wallet })",
      "potReading(fresh, { addresses: a, guardian, agentWallet: wallet })",
      "alive: () => life.alive()",
      "account: () => walletNow().address",
      "readBalance: () => client.getBalance({ address: guardian })",
    ])
      expect(click, read).toContain(read);
    const registry = code.slice(code.indexOf("function readRegistry"), code.indexOf("async function onAction"));
    expect(registry).toContain("readAgentWallet(");
    expect(registry).toContain('functionName: "getAgentWallet"');
    // The context comes from the click's read alone: the card's raw facts and reading (its props,
    // held as `shown...`) never reach the click, and its key only as the key the panel named, which
    // the click's own read must equal (Ruling R23).
    expect(click).toContain("await runPotAction(action, shown, {");
    const built = /const shown = \{([^}]*)\};/.exec(click);
    expect(built).not.toBeNull();
    const p = built?.[1] ?? "";
    expect(p).toContain("pot: noted.address");
    expect(p).toContain("shownAgentWallet: shownWallet");
    expect(p.replace("shownAgentWallet: shownWallet", "")).not.toMatch(/agentWallet|shownWallet/i);
    // That is the one place the card's key reaches the click.
    expect(click.match(/shownWallet/g)).toHaveLength(1);
    // Nor the receipt's continuation, the read back or Check again: every async function of the card.
    const clicks = code.slice(code.indexOf("async function onAction"), code.indexOf("const view = potReadingView("));
    expect(clicks).toContain("async function readBack");
    expect(clicks).toContain("async function onCheckAgain");
    for (const shown of ["shownWallet", "shownRaw", "shownReading"]) {
      expect(code, shown).toContain(shown);
      expect(clicks.replace("shownAgentWallet: shownWallet", ""), shown).not.toContain(shown);
    }
    // The click's own continuation asks the lifetime as soon as the runner answers.
    expect(click).toMatch(/\}\);\s*if \(!life\.alive\(\)\) return;\s*if \(!result\.ok\) \{/);
  });

  test("after the receipt the pot is read again against the click's own key", () => {
    const back = code.slice(code.indexOf("async function readBack"));
    expect(back).toContain("const wallet = again.agentWallet;");
    expect(back).toContain("readPotRaw(client, a, { pot: noted.address, agentWallet: wallet })");
    expect(back).toContain("potActionDoneView(");
    expect(code).toContain("result.agentWallet");
  });

  test("simulated and estimated from the guardian, with no fee field", () => {
    expect(code).toContain("client.call({");
    expect(code).toContain("client.estimateGas({");
    expect(code).toContain("account: guardian");
    for (const fee of ["maxFeePerGas", "maxPriorityFeePerGas", "gasPrice"]) expect(code, fee).not.toContain(fee);
  });

  test("a person who left is told nothing; nothing typed reaches a browser store; every timer is a lifetime's", () => {
    expect(code).toContain('if (result.problem === "left") return;');
    expect(code).toContain("stepLifetime()");
    for (const store of ["localStorage", "sessionStorage", "writeLegalBodyMemory", "remember(", "/storage"])
      expect(code, store).not.toContain(store);
    for (const file of [code, panels]) {
      expect(file).not.toContain("setTimeout");
      expect(file).not.toContain("setInterval");
    }
  });

  test("no way to a second pot: the card never names the setup", () => {
    expect(code.toLowerCase()).not.toContain("create a new pot");
    expect(code).not.toContain('from "./PotStep"');
    expect(code).not.toContain("<PotStep");
    expect(code).not.toContain("potSetupCall");
    expect(code).not.toContain("aggregate3Value");
  });
});
