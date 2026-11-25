/**
 * The pot screens' view model (`safePotStep.ts`): which card the done page shows, the form and its
 * sentences, the plan of the setup and its review, the checks before the wallet, what a reading
 * says and offers, the record's sentence, and the agent's two commands.
 *
 * Every amount is an exact bigint: USDC units have 6 decimals and native wei 18, and the review's
 * total is formatted from the request's own value, never added up again in a sentence. The
 * fixtures are the real run of 24 Nov (guardian G, agent A, payee P, the Safe it created) and the
 * proof's healthy pot (RESULTS.md, S6).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  size,
  zeroAddress,
} from "viem";
import type {
  Address,
  Hex,
  LegalBodyOrderView,
  LegalBodyStatementJson,
  OrderPotView,
  PotBirth,
  PotBlock,
} from "@/lib/api/types";
import { allowedCall, potSetupCall } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";
import { formatDate } from "@/lib/format";
import {
  allowanceModuleAbi,
  multicall3Abi,
  POT_EXEC_GAS_CAP,
  POT_FEE_LOW_WEI,
  POT_SETUP_GAS_CAP,
  POT_TAKE_GAS,
  POT_TRANSFER_GAS_CAP,
  potAddresses,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import { potReading, type PotRaw, type PotReading } from "@/lib/legalBody/safePotRules";
import {
  POT_SERVER_CODES,
  potAgentCommands,
  potCard,
  potCeilingHint,
  potCreatedView,
  potFormCheck,
  potFormStart,
  potGasLimit,
  potGrantView,
  potPlan,
  potProblemSentence,
  potReadingView,
  potRecordSentence,
  potRefusalSentence,
  potReviewLines,
  potSaltNonce,
  potSendPreflight,
  potServerNext,
  potSetupContext,
  potSimulationOk,
  type PotFormCheck,
  type PotPlan,
} from "@/lib/legalBody/safePotStep";

const P_ = LEGAL_BODY_COPY.pot;

/** The real run of 24 Nov: the guardian, the agent's key, the payee, and the Safe it created. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const P = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8" as const;
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
/** V3 with salt nonce 1: G, A, USDC, 50 USDC in each thirty-day period. */
const V3_POT = "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D" as const;
/** Inventions: the testnet factory as served, another chain's id, a contract's code. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const CHAIN = 5042002;
const SOME_CODE: Hex = "0x6080604052";
const DELEGATED_CODE: Hex = `0xef0100${"ab".repeat(20)}`;

const T = potAddresses(CHAIN) as PotAddresses;
const ZERO = BigInt(0);
const USDC = (n: number) => BigInt(n) * BigInt(1_000_000);
const WEI = (units: bigint) => units * BigInt(1_000_000_000_000);

// The proof's healthy pot right after its first take (RESULTS.md, S6).
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
  allowance: [USDC(50), USDC(10), BigInt(43200), BigInt(29919864), BigInt(2)],
  usdcAllowanceToAgent: ZERO,
  balanceUnits: USDC(190),
  balanceWei: WEI(USDC(190)),
  agentBalanceWei: BigInt("100000000000000000"),
  agentHasCode: false,
};
/** The end of HEALTHY's period, in unix seconds. */
const HEALTHY_ENDS = (29919864 + 43200) * 60;
/** The real Safe after the run's stop: no module, no delegate. */
const STOPPED: PotRaw = {
  ...HEALTHY,
  modules: { list: [], next: SAFE_SENTINEL },
  delegates: { list: [], next: 0 },
  allowance: [ZERO, ZERO, ZERO, ZERO, BigInt(3)],
};
const read = (raw: PotRaw, agentWallet: Address = A): PotReading =>
  potReading(raw, { addresses: T, guardian: G, agentWallet });

const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_1",
  publicId: "lb_test",
  companyId: "co_1",
  state: "linked",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: G,
  amendmentDelay: 0,
  agreement: null,
  agentId: "897126",
  identityOwner: G,
  bodyAddress: "0x00000000000000000000000000000000000b0d1e",
  linkDeadline: null,
  createTxHash: null,
  deployedAt: 1,
  pointerSeenAt: 2,
  createdAt: "2026-11-20T11:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

/** The fields of the record `potCard` reads; the rest are the statement's usual ones. */
const record = (agentWallet: string): LegalBodyStatementJson =>
  ({ agentWallet, legalBody: "0x00000000000000000000000000000000000b0d1e" }) as unknown as LegalBodyStatementJson;

const NOTED: OrderPotView = {
  address: V3_POT,
  onRecord: true,
  declaredAt: 1_764_000_000,
  birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" },
};

// ---------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------

const checkedOf = (c: PotFormCheck): Extract<PotFormCheck, { ok: true }> => {
  if (!c.ok) throw new Error(`the form was refused: ${JSON.stringify(c)}`);
  return c;
};

const plan = (
  over: Partial<Parameters<typeof potPlan>[0]> = {},
): ReturnType<typeof potPlan> =>
  potPlan({
    chainId: CHAIN,
    guardian: G,
    agentWallet: A,
    agentCode: undefined,
    checked: { ok: true, ceilingUnits: USDC(50), fundWei: ZERO, agentGasWei: ZERO },
    saltNonce: BigInt(1),
    potCode: undefined,
    guardianBalanceWei: WEI(USDC(1000)),
    noted: null,
    ...over,
  });

const planOf = (r: ReturnType<typeof potPlan>): PotPlan => {
  if (!r.ok) throw new Error(`the plan was refused: ${r.problem}`);
  return r.plan;
};

describe("the review is the request's own value", () => {
  test("the review's total is the request's own value: '5' and '0.1' typed show 5.1, 5 and 0.1, and the plan's value is 5100000000000000000 wei", () => {
    const checked = checkedOf(
      potFormCheck({ ceiling: "2", fund: "5", agentGas: "0.1" }, { kind: "none" }, "key"),
    );
    expect(checked.ceilingUnits).toBe(BigInt(2_000_000));
    expect(checked.fundWei).toBe(BigInt("5000000000000000000"));
    expect(checked.agentGasWei).toBe(BigInt("100000000000000000"));
    const p = planOf(plan({ checked }));
    expect(p.value).toBe(BigInt("5100000000000000000"));
    const lines = potReviewLines(p);
    expect(lines.join(" ")).toContain("send 5.1 USDC to a contract called Multicall3");
    expect(lines.join(" ")).toContain("puts 5 USDC in it and sends 0.1 USDC to your agent's key");
    expect(lines).toContain(
      fillCopy(P_.reviewTotal, { total: "5.1", fund: "5", gas: "0.1" }),
    );
  });

  test("a value that no float could add (0.1 + 0.2): the total is 0.3 exactly, from the value", () => {
    const checked = checkedOf(
      potFormCheck({ ceiling: "2", fund: "0.1", agentGas: "0.2" }, { kind: "none" }, "key"),
    );
    const p = planOf(plan({ checked }));
    expect(p.value).toBe(BigInt("300000000000000000"));
    expect(potReviewLines(p).join(" ")).toContain("send 0.3 USDC to a contract");
  });

  test("no money typed: the review says the transaction sends no money; only a fund, or only fee money: the sentence for that case, with the one amount", () => {
    const none = planOf(plan());
    expect(potReviewLines(none)).toContain(P_.reviewNoMoney);
    expect(potReviewLines(none).join(" ")).not.toContain("Multicall3");

    const fundOnly = planOf(
      plan({ checked: checkedOf(potFormCheck({ ceiling: "2", fund: "60", agentGas: "" }, { kind: "none" }, "key")) }),
    );
    expect(potReviewLines(fundOnly)).toContain(fillCopy(P_.reviewFundOnly, { total: "60" }));

    const gasOnly = planOf(
      plan({ checked: checkedOf(potFormCheck({ ceiling: "2", fund: "", agentGas: "0.1" }, { kind: "none" }, "key")) }),
    );
    expect(potReviewLines(gasOnly)).toContain(fillCopy(P_.reviewGasOnly, { total: "0.1" }));
  });

  test("the review names the owner, the key, the ceiling and the pot's address, then ends with the fixed periods, keep little and no recovery", () => {
    const p = planOf(plan());
    const lines = potReviewLines(p);
    expect(lines.slice(0, 4)).toEqual([
      fillCopy(P_.reviewOwner, { address: G }),
      fillCopy(P_.reviewAgent, { address: A }),
      fillCopy(P_.reviewCeiling, { amount: "50" }),
      fillCopy(P_.reviewAddress, { address: V3_POT }),
    ]);
    expect(lines.slice(-3)).toEqual([P_.periods, P_.keepLittle, P_.noRecovery]);
    // The declaration is the tick box, not a line.
    expect(lines).not.toContain(P_.declaration);
    for (const line of lines) expect(line).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

describe("the form", () => {
  test("the form starts with an EMPTY ceiling whatever the cap, fee money 0.1 for a key and empty for a contract wallet, whose fee money is 0 whatever is typed", () => {
    expect(potFormStart("key")).toEqual({ ceiling: "", fund: "", agentGas: "0.1" });
    expect(potFormStart("contract")).toEqual({ ceiling: "", fund: "", agentGas: "" });
    expect(potFormStart("delegated")).toEqual({ ceiling: "", fund: "", agentGas: "" });
    for (const kind of ["contract", "delegated"] as const) {
      const c = checkedOf(potFormCheck({ ceiling: "5", fund: "1", agentGas: "0.5" }, { kind: "none" }, kind));
      expect(c.agentGasWei).toBe(ZERO);
      // Even fee money the form would refuse is not read for a wallet that takes none.
      expect(potFormCheck({ ceiling: "5", fund: "", agentGas: "abc" }, { kind: "none" }, kind).ok).toBe(true);
    }
  });

  test("the form for the noted pot that never got code starts with that pot's own ceiling", () => {
    expect(potFormStart("key", NOTED.birth)).toEqual({ ceiling: "50", fund: "", agentGas: "0.1" });
    expect(potFormStart("key", { ...NOTED.birth, ceilingUnits: "nope" })).toEqual(potFormStart("key"));
  });

  test("potCeilingHint names the grant's 350 USDC for a capped cap, and the no-grant sentence otherwise", () => {
    expect(potCeilingHint({ kind: "capped", maxUsdc: 350, endsOn: null })).toBe(
      fillCopy(P_.ceilingMax, { amount: "350" }),
    );
    expect(potCeilingHint({ kind: "capped", maxUsdc: 350, endsOn: null })).toContain("350 USDC");
    expect(potCeilingHint({ kind: "none" })).toBe(P_.ceilingNoGrant);
  });

  test("a ceiling above the grant's cap is refused with the grant's amount in the sentence; at it, accepted", () => {
    const cap = { kind: "capped", maxUsdc: 350, endsOn: null } as const;
    expect(potFormCheck({ ceiling: "351", fund: "", agentGas: "" }, cap, "key")).toEqual({
      ok: false,
      ceiling: fillCopy(P_.ceilingProblems.above_grant, { amount: "350" }),
    });
    expect(checkedOf(potFormCheck({ ceiling: "350", fund: "", agentGas: "" }, cap, "key")).ceilingUnits).toBe(
      USDC(350),
    );
  });

  test("each field's own problem, in its own sentence", () => {
    const none = { kind: "none" } as const;
    const ceiling = (raw: string) => potFormCheck({ ceiling: raw, fund: "", agentGas: "" }, none, "key");
    expect(ceiling("")).toEqual({ ok: false, ceiling: P_.ceilingProblems.empty });
    expect(ceiling("2.5")).toEqual({ ok: false, ceiling: P_.ceilingProblems.not_whole });
    expect(ceiling("0")).toEqual({ ok: false, ceiling: P_.ceilingProblems.zero });
    expect(ceiling("3000000001")).toEqual({ ok: false, ceiling: P_.ceilingProblems.too_large });
    const fund = (raw: string) => potFormCheck({ ceiling: "1", fund: raw, agentGas: "" }, none, "key");
    expect(fund("1,5")).toEqual({ ok: false, fund: P_.amountProblems.not_amount });
    expect(fund("0.0000001")).toEqual({ ok: false, fund: P_.amountProblems.too_precise });
    expect(fund("1000000001")).toEqual({ ok: false, fund: P_.amountProblems.too_large });
    // Every field is checked: three problems at once.
    expect(potFormCheck({ ceiling: "", fund: "x", agentGas: "2" }, none, "key")).toEqual({
      ok: false,
      ceiling: P_.ceilingProblems.empty,
      fund: P_.amountProblems.not_amount,
      agentGas: P_.amountProblems.gas_too_large,
    });
  });

  test("fee money of 1.5 USDC is refused with the gas_too_large sentence", () => {
    expect(potFormCheck({ ceiling: "1", fund: "", agentGas: "1.5" }, { kind: "none" }, "key")).toEqual({
      ok: false,
      agentGas: P_.amountProblems.gas_too_large,
    });
    expect(checkedOf(potFormCheck({ ceiling: "1", fund: "", agentGas: "1" }, { kind: "none" }, "key")).agentGasWei).toBe(
      WEI(USDC(1)),
    );
  });

  test("a grant that allows no spending offers no form", () => {
    expect(potGrantView({ kind: "no_spending" })).toEqual({ form: false, lines: [P_.grantNoSpending] });
    expect(potFormCheck({ ceiling: "1", fund: "", agentGas: "" }, { kind: "no_spending" }, "key")).toEqual({
      ok: false,
      ceiling: P_.grantNoSpending,
    });
    expect(potGrantView({ kind: "none" })).toEqual({ form: true, lines: [] });
    expect(potGrantView({ kind: "capped", maxUsdc: 5, endsOn: null })).toEqual({ form: true, lines: [] });
  });

  test("a grant with a last day says the pot does not stop by itself on it, the day as a UTC calendar day", () => {
    const view = potGrantView({ kind: "capped", maxUsdc: 5, endsOn: "2027-03-31" });
    expect(view.form).toBe(true);
    expect(view.lines).toEqual([
      fillCopy(P_.grantEnds, { date: formatDate(Date.parse("2027-03-31T12:00:00Z")) }),
    ]);
    // A last day that is not a calendar day says nothing it cannot read.
    expect(potGrantView({ kind: "capped", maxUsdc: 5, endsOn: "soon" }).lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

describe("potPlan, from this click's reads", () => {
  test("potPlan refuses agent_wallet when the registry names none or the guardian's wallet, and read_failed when it cannot be read", () => {
    expect(plan({ agentWallet: "none" })).toEqual({ ok: false, problem: "agent_wallet" });
    expect(plan({ agentWallet: G })).toEqual({ ok: false, problem: "agent_wallet" });
    expect(plan({ agentWallet: G.toLowerCase() as Address })).toEqual({ ok: false, problem: "agent_wallet" });
    expect(plan({ agentWallet: zeroAddress })).toEqual({ ok: false, problem: "agent_wallet" });
    // "unreadable" is a read that failed, or an answer that is not an address: not "unset".
    expect(plan({ agentWallet: "unreadable" })).toEqual({ ok: false, problem: "read_failed" });
  });

  test("potPlan refuses pot_exists when the predicted address holds code, and not_enough when the balance is under the value", () => {
    expect(plan({ potCode: SOME_CODE })).toEqual({ ok: false, problem: "pot_exists" });
    expect(planOf(plan({ potCode: "0x" })).pot).toBe(V3_POT);
    const checked = { ok: true as const, ceilingUnits: USDC(50), fundWei: WEI(USDC(60)), agentGasWei: WEI(BigInt(100_000)) };
    const value = WEI(USDC(60)) + WEI(BigInt(100_000));
    expect(plan({ checked, guardianBalanceWei: value - BigInt(1) })).toEqual({ ok: false, problem: "not_enough" });
    expect(planOf(plan({ checked, guardianBalanceWei: value })).value).toBe(value);
    // V5's value.
    expect(value).toBe(BigInt("60100000000000000000"));
  });

  test("potPlan's pot is the address Task 1 predicts for the same inputs (V3 with salt 1)", () => {
    const p = planOf(plan());
    expect(p).toEqual({
      guardian: G,
      agentWallet: A,
      agentWalletKind: "key",
      ceilingUnits: USDC(50),
      fundWei: ZERO,
      agentGasWei: ZERO,
      saltNonce: BigInt(1),
      pot: V3_POT,
      value: ZERO,
    });
  });

  test("the plan's setup context is one the allowlist rebuilds to the same pot and value", () => {
    const checked = checkedOf(potFormCheck({ ceiling: "50", fund: "60", agentGas: "0.1" }, { kind: "none" }, "key"));
    const p = planOf(plan({ checked }));
    const context = potSetupContext(p);
    expect(context).toEqual({
      kind: "setup",
      guardian: G,
      agentWallet: A,
      agentWalletKind: "key",
      ceilingUnits: USDC(50),
      saltNonce: BigInt(1),
      fundWei: WEI(USDC(60)),
      agentGasWei: WEI(BigInt(100_000)),
    });
    const config = { chainId: CHAIN, identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address, factory: FACTORY };
    const req = potSetupCall(config, context, POT_SETUP_GAS_CAP);
    expect("ok" in req).toBe(false);
    if ("ok" in req) return;
    expect(req.value).toBe(p.value);
    expect(allowedCall(req, { config, order: order(), pot: context }).ok).toBe(true);
  });

  test("a contract wallet and a delegated key: the plan sends no fee money, whatever the form held, and says its kind", () => {
    const checked = { ok: true as const, ceilingUnits: USDC(50), fundWei: ZERO, agentGasWei: WEI(BigInt(100_000)) };
    const contract = planOf(plan({ checked, agentCode: SOME_CODE }));
    expect(contract.agentWalletKind).toBe("contract");
    expect(contract.agentGasWei).toBe(ZERO);
    expect(contract.value).toBe(ZERO);
    expect(potReviewLines(contract)).toContain(P_.reviewNoMoney);
    const delegated = planOf(plan({ checked, agentCode: DELEGATED_CODE }));
    expect(delegated.agentWalletKind).toBe("delegated");
    expect(delegated.agentGasWei).toBe(ZERO);
  });

  test("a chain with no pot table is unsupported", () => {
    expect(plan({ chainId: 1 })).toEqual({ ok: false, problem: "unsupported" });
  });

  test("one pot for life: the noted address that never got code is set up again only at THAT address", () => {
    // The salt is the note's while the registry names the key the note was made for.
    expect(potSaltNonce({ noted: NOTED, agentWallet: A, fresh: BigInt(999) })).toBe(BigInt(1));
    expect(potSaltNonce({ noted: null, agentWallet: A, fresh: BigInt(999) })).toBe(BigInt(999));
    const again = planOf(plan({ noted: NOTED, saltNonce: BigInt(1) }));
    expect(again.pot).toBe(V3_POT);
    // Another ceiling would be another address, a second pot: refused, with the note's ceiling.
    const other = { ok: true as const, ceilingUnits: USDC(60), fundWei: ZERO, agentGasWei: ZERO };
    expect(plan({ noted: NOTED, saltNonce: BigInt(1), checked: other })).toEqual({ ok: false, problem: "noted_pot" });
    expect(potProblemSentence("noted_pot", { environment: "sandbox", notedCeilingUnits: USDC(50) })).toBe(
      fillCopy(P_.problems.noted_pot, { amount: "50" }),
    );
    // Another salt than the note's is never sent.
    expect(plan({ noted: NOTED, saltNonce: BigInt(2) })).toEqual({ ok: false, problem: "refused" });
    // A note whose birth does not give its address is never set up.
    expect(plan({ noted: { ...NOTED, address: SAFE_CREATED }, saltNonce: BigInt(1) })).toEqual({
      ok: false,
      problem: "refused",
    });
    expect(plan({ noted: { ...NOTED, birth: { ...NOTED.birth, saltNonce: "x" } } })).toEqual({
      ok: false,
      problem: "refused",
    });
  });

  test("a noted pot for a key the registry no longer names is never created: a new pot is planned for the registry's key", () => {
    expect(potSaltNonce({ noted: NOTED, agentWallet: P, fresh: BigInt(999) })).toBe(BigInt(999));
    const fresh = planOf(plan({ noted: NOTED, agentWallet: P, saltNonce: BigInt(999) }));
    expect(fresh.agentWallet).toBe(P);
    expect(fresh.pot).not.toBe(V3_POT);
  });
});

describe("before the wallet", () => {
  const pre = (over: Partial<Parameters<typeof potSendPreflight>[0]> = {}) =>
    potSendPreflight({
      order: order(),
      tenant: G,
      connected: G,
      walletChainId: CHAIN,
      chainId: CHAIN,
      guardian: G,
      ...over,
    });

  test("potSendPreflight: another connected account, no account: not_this_wallet; the wallet on another chain: wrong_network; a tenant that is not the order's guardian: refused", () => {
    expect(pre()).toEqual({ ok: true });
    expect(pre({ connected: G.toLowerCase() as Address, tenant: G.toLowerCase() as Address })).toEqual({ ok: true });
    expect(pre({ connected: A })).toEqual({ ok: false, problem: "not_this_wallet" });
    expect(pre({ connected: null })).toEqual({ ok: false, problem: "not_this_wallet" });
    expect(pre({ walletChainId: 1 })).toEqual({ ok: false, problem: "wrong_network" });
    expect(pre({ walletChainId: undefined })).toEqual({ ok: false, problem: "wrong_network" });
    expect(pre({ tenant: A })).toEqual({ ok: false, problem: "refused" });
    expect(pre({ guardian: A, connected: A, tenant: A })).toEqual({ ok: false, problem: "refused" });
    expect(pre({ order: null })).toEqual({ ok: false, problem: "refused" });
    expect(pre({ order: order({ revoked: true }) })).toEqual({ ok: false, problem: "refused" });
    expect(pre({ order: order({ state: "broken", brokenReason: "not_linked" }) })).toEqual({ ok: false, problem: "refused" });
    expect(pre({ order: order({ chainId: 1 }) })).toEqual({ ok: false, problem: "refused" });
  });

  const answer = (results: readonly { success: boolean; returnData: Hex }[]): Hex =>
    encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3Value", result: results });
  const potWord = (a: Address): Hex => encodeAbiParameters([{ type: "address" }], [a]);

  test("potSimulationOk: true for the plan's pot and every call a success; false for another address, a failed call, an answer that does not decode", () => {
    const checked = { ok: true as const, ceilingUnits: USDC(50), fundWei: WEI(USDC(5)), agentGasWei: WEI(BigInt(100_000)) };
    const p = planOf(plan({ checked }));
    const ok = { success: true, returnData: "0x" as Hex };
    expect(potSimulationOk(p, answer([{ success: true, returnData: potWord(V3_POT) }, ok, ok]))).toBe(true);
    // Any letter case of the same address.
    expect(potSimulationOk(p, answer([{ success: true, returnData: potWord(V3_POT.toLowerCase() as Address) }, ok, ok]))).toBe(true);
    expect(potSimulationOk(p, answer([{ success: true, returnData: potWord(SAFE_CREATED) }, ok, ok]))).toBe(false);
    expect(potSimulationOk(p, answer([{ success: true, returnData: potWord(V3_POT) }, { success: false, returnData: "0x" }, ok]))).toBe(false);
    expect(potSimulationOk(p, answer([{ success: false, returnData: potWord(V3_POT) }, ok, ok]))).toBe(false);
    // Another number of calls than the plan's.
    expect(potSimulationOk(p, answer([{ success: true, returnData: potWord(V3_POT) }]))).toBe(false);
    // An answer that is not 32 bytes of an address, or that does not decode at all.
    expect(potSimulationOk(p, answer([{ success: true, returnData: "0x1234" }, ok, ok]))).toBe(false);
    expect(potSimulationOk(p, answer([{ success: true, returnData: `0x${"ff".repeat(32)}` }, ok, ok]))).toBe(false);
    expect(potSimulationOk(p, "0x1234")).toBe(false);
    expect(potSimulationOk(p, "0x")).toBe(false);
    // A plan with no money has one call.
    const bare = planOf(plan());
    expect(potSimulationOk(bare, answer([{ success: true, returnData: potWord(V3_POT) }]))).toBe(true);
  });

  test("potGasLimit: 499083 gives 648808 under the cap of 1500000; 49338 gives 64140 under 120000; an estimate above the cap is null", () => {
    expect(potGasLimit(BigInt(499_083), POT_SETUP_GAS_CAP)).toBe(BigInt(648_808));
    expect(potGasLimit(BigInt(49_338), POT_TRANSFER_GAS_CAP)).toBe(BigInt(64_140));
    expect(potGasLimit(BigInt(163_756), POT_EXEC_GAS_CAP)).toBe(BigInt(212_883));
    // The headroom stops at the cap; an estimate above it is no limit at all.
    expect(potGasLimit(BigInt(1_400_000), POT_SETUP_GAS_CAP)).toBe(POT_SETUP_GAS_CAP);
    expect(potGasLimit(POT_SETUP_GAS_CAP, POT_SETUP_GAS_CAP)).toBe(POT_SETUP_GAS_CAP);
    expect(potGasLimit(POT_SETUP_GAS_CAP + BigInt(1), POT_SETUP_GAS_CAP)).toBeNull();
    expect(potGasLimit(ZERO, POT_SETUP_GAS_CAP)).toBeNull();
  });
});

describe("the sentences of a click's problems", () => {
  test("every problem has its sentence, filled", () => {
    const p = { environment: "sandbox" as const, guardian: G, balanceWei: WEI(USDC(3)), totalWei: BigInt("5100000000000000000"), notedCeilingUnits: USDC(50) };
    expect(potProblemSentence("not_enough", p)).toBe(fillCopy(P_.problems.not_enough, { balance: "3", total: "5.1" }));
    expect(potProblemSentence("not_this_wallet", p)).toBe(fillCopy(P_.problems.not_this_wallet, { address: G }));
    expect(potProblemSentence("wrong_network", p)).toBe(fillCopy(P_.problems.wrong_network, { network: "Arc testnet" }));
    expect(potProblemSentence("wrong_network", { ...p, environment: "production" })).toBe(
      fillCopy(P_.problems.wrong_network, { network: "Arc" }),
    );
    const all = [
      "unsupported", "agent_wallet", "pot_exists", "not_enough", "not_this_wallet", "wrong_network",
      "record_failed", "would_revert", "declined", "reverted", "no_receipt", "read_failed", "refused", "noted_pot",
    ] as const;
    for (const problem of all) {
      const s = potProblemSentence(problem, p);
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  test("every refusal the allowlist can give a pot click has a plain sentence of its own, never its code", () => {
    // Every code `chain.ts` refuses with, but the registry's own.
    const source = readSource("src/lib/legalBody/chain.ts");
    const codes = new Set([...source.matchAll(/refuse\("([a-z_0-9]+)"\)/g)].map((m) => m[1] ?? ""));
    const registryOnly = [
      "register_args", "set_metadata_args", "other_identity", "other_key", "other_body",
      "no_wallet_context", "set_agent_wallet_args", "deadline_out_of_window", "signature_shape",
      "not_the_registry", "order_not_pointable", "order_has_no_body", "not_allowed",
    ];
    for (const r of registryOnly) expect(codes.has(r), r).toBe(true);
    const potCodes = [...codes].filter((c) => !registryOnly.includes(c)).sort();
    expect(Object.keys(P_.refusals).sort()).toEqual(potCodes);
    for (const code of potCodes) {
      const s = potRefusalSentence(code, { environment: "sandbox", guardian: G });
      expect(s, code).not.toContain(code);
      expect(s, code).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(s, code).not.toBe(P_.problems.refused);
    }
    // The setup's and Send fee money's codes for one rule: one sentence (Ruling R10).
    expect(potRefusalSentence("fee_money_needs_plain_key", { environment: "sandbox" })).toBe(
      potRefusalSentence("fee_money_contract_wallet", { environment: "sandbox" }),
    );
    expect(potRefusalSentence("wallet_is_not_the_guardian", { environment: "sandbox", guardian: G })).toContain(G);
    expect(potRefusalSentence("wallet_on_another_chain", { environment: "production" })).toContain("Arc");
    // A code this page does not know: the plain refusal, never the code.
    expect(potRefusalSentence("something_new", { environment: "sandbox" })).toBe(P_.problems.refused);
    expect(potRefusalSentence("toString", { environment: "sandbox" })).toBe(P_.problems.refused);
  });

  test("the server's pot codes choose the next step: a re-read of the pot after pot_exists and pot_not_on_record", () => {
    expect([...POT_SERVER_CODES].sort()).toEqual(
      [
        "pot_not_offered", "pot_exists", "pot_taken", "pot_address_mismatch", "ceiling_above_grant",
        "grant_allows_no_spending", "pot_not_on_record", "agent_wallet_required", "rate_limited",
        "other_deployment",
      ].sort(),
    );
    expect(potServerNext("pot_exists")).toBe("reread_pot");
    expect(potServerNext("pot_not_on_record")).toBe("reread_pot");
    expect(potServerNext("pot_not_offered")).toBe("stop");
    expect(potServerNext("other_deployment")).toBe("stop");
    expect(potServerNext("pot_taken")).toBe("back_to_form");
    expect(potServerNext("pot_address_mismatch")).toBe("back_to_form");
    expect(potServerNext("ceiling_above_grant")).toBe("reread_grant");
    expect(potServerNext("grant_allows_no_spending")).toBe("reread_grant");
    expect(potServerNext("agent_wallet_required")).toBe("reread_record");
    expect(potServerNext("rate_limited")).toBe("try_again");
    expect(potServerNext("chain_unavailable")).toBe("try_again");
    expect(potServerNext(undefined)).toBe("try_again");
    expect(potServerNext("constructor")).toBe("try_again");
  });
});

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

describe("which card the done page shows", () => {
  const card = (over: Partial<Parameters<typeof potCard>[0]> = {}) =>
    potCard({
      potOffered: true,
      chainId: CHAIN,
      order: order(),
      notice: undefined,
      record: record(A),
      noted: null,
      reading: null,
      ...over,
    });

  test("potCard: hidden without /config's pot, on chain 1, for a deployed order, a revoked one, beside a notice, and when the record names the guardian's wallet or none", () => {
    expect(card()).toBe("offer");
    expect(card({ potOffered: false })).toBe("hidden");
    expect(card({ chainId: 1 })).toBe("hidden");
    expect(card({ order: null })).toBe("hidden");
    expect(card({ order: order({ state: "deployed" }) })).toBe("hidden");
    expect(card({ order: order({ revoked: true }) })).toBe("hidden");
    expect(card({ order: order({ chainId: 5042 }) })).toBe("hidden");
    const notices: LegalBodyNotice[] = [{ kind: "order_revoked" }, { kind: "winding_down" }, { kind: "other_deployment" }];
    for (const notice of notices) expect(card({ notice })).toBe("hidden");
    expect(card({ record: record(G) })).toBe("hidden");
    expect(card({ record: record(G.toLowerCase()) })).toBe("hidden");
    expect(card({ record: record(zeroAddress) })).toBe("hidden");
    expect(card({ record: record("not an address") })).toBe("hidden");
    // Hidden whatever the pot reads.
    expect(card({ potOffered: false, noted: NOTED, reading: read(HEALTHY) })).toBe("hidden");
  });

  test("potCard: offer with no note and with a note whose address has no code; manage for every other reading, off the record too; checking until the three answers are there", () => {
    expect(card({ noted: null })).toBe("offer");
    expect(card({ noted: NOTED, reading: { state: "absent" } })).toBe("offer");
    const readings: PotReading[] = [
      read(HEALTHY),
      read(STOPPED),
      read({ ...HEALTHY, guard: P }),
      read({ ...HEALTHY, owners: [P] }),
    ];
    for (const reading of readings) {
      expect(card({ noted: NOTED, reading })).toBe("manage");
      expect(card({ noted: { ...NOTED, onRecord: false }, reading })).toBe("manage");
    }
    expect(card({ record: null })).toBe("checking");
    expect(card({ record: null, noted: NOTED, reading: read(HEALTHY) })).toBe("checking");
    expect(card({ noted: undefined })).toBe("checking");
    expect(card({ noted: NOTED, reading: null })).toBe("checking");
  });
});

describe("what the card says of a reading, and what it offers", () => {
  const NOW = HEALTHY_ENDS - 86_400;
  const view = (
    raw: PotRaw,
    over: Partial<Parameters<typeof potReadingView>[2]> = {},
    agentWallet: Address = A,
  ) =>
    potReadingView(read(raw, agentWallet), raw, {
      chainId: CHAIN,
      pot: SAFE_CREATED,
      guardian: G,
      agentWallet,
      onRecord: true,
      onThisDeployment: true,
      nowSeconds: NOW,
      ...over,
    });

  test("potReadingView: ceiling_read offers change, stop, add_money, fee_money, take_off_record, and shows what is left until the period's end", () => {
    const v = view(HEALTHY);
    expect(v.actions).toEqual(["change", "stop", "add_money", "fee_money", "take_off_record"]);
    expect(v.lines).toEqual([
      fillCopy(P_.shownAddress, { address: SAFE_CREATED }),
      fillCopy(P_.shownOwner, { address: G }),
      fillCopy(P_.shownAgent, { address: A }),
      fillCopy(P_.shownCeiling, { amount: "50" }),
      fillCopy(P_.shownSpent, { spent: "10", left: "40", date: formatDate(HEALTHY_ENDS * 1000) }),
      fillCopy(P_.shownBalance, { balance: "190" }),
      fillCopy(P_.shownFeeMoney, { amount: "0.1" }),
    ]);
  });

  test("what is left floors at 0 after the guardian lowers the ceiling below what was taken", () => {
    const lowered: PotRaw = { ...HEALTHY, allowance: [USDC(5), USDC(10), BigInt(43200), BigInt(29919864), BigInt(3)] };
    expect(view(lowered).lines).toContain(
      fillCopy(P_.shownSpent, { spent: "10", left: "0", date: formatDate(HEALTHY_ENDS * 1000) }),
    );
  });

  test("a reading whose period has ended by now says no amount left: the next read shows the new period", () => {
    const lines = view(HEALTHY, { nowSeconds: HEALTHY_ENDS }).lines;
    expect(lines.some((l) => l.startsWith("Taken in this period"))).toBe(false);
    expect(lines).toContain(fillCopy(P_.shownCeiling, { amount: "50" }));
  });

  test("potReadingView: stopped offers start_again, withdraw only with money, add_money, fee_money; not fee_money for a wallet with code", () => {
    const withMoney = view(STOPPED);
    expect(withMoney.actions).toEqual(["start_again", "withdraw", "add_money", "fee_money", "take_off_record"]);
    expect(withMoney.lines).toContain(P_.stoppedLine);
    expect(withMoney.lines).toContain(fillCopy(P_.shownBalance, { balance: "190" }));
    const empty = view({ ...STOPPED, balanceUnits: ZERO, balanceWei: ZERO });
    expect(empty.actions).toEqual(["start_again", "add_money", "fee_money", "take_off_record"]);
    const contract = view({ ...STOPPED, agentHasCode: true });
    expect(contract.actions).toEqual(["start_again", "withdraw", "add_money", "take_off_record"]);
    expect(view({ ...HEALTHY, agentHasCode: true }).actions).toEqual(["change", "stop", "add_money", "take_off_record"]);
  });

  test("a pot stopped with its add-on still on (no key, module on) offers the stop first, and no take back until the add-on is off", () => {
    const noDelegate: PotRaw = { ...HEALTHY, delegates: { list: [], next: 0 } };
    expect(read(noDelegate)).toMatchObject({ state: "stopped", why: "no_delegate" });
    expect(view(noDelegate).actions).toEqual(["start_again", "stop", "add_money", "fee_money", "take_off_record"]);
  });

  test("potReadingView: other_delegate with the registry's key absent offers new_key and stop; with it present, stop only; not_the_guardians offers only the record action", () => {
    // The registry names P; the pot's key is still A.
    const moved = view(HEALTHY, {}, P);
    expect(read(HEALTHY, P)).toMatchObject({ state: "limits_not_read", problem: "other_delegate" });
    expect(moved.actions).toEqual(["new_key", "stop", "take_off_record"]);
    expect(moved.lines).toContain(
      fillCopy(P_.limitsNotRead, { reason: P_.limitReasons.other_delegate }),
    );
    // A second key beside the registry's.
    const two: PotRaw = { ...HEALTHY, delegates: { list: [A, P], next: 0 } };
    expect(view(two).actions).toEqual(["stop", "take_off_record"]);
    // Another limit the rules do not read past: the stop, when there is something to stop.
    expect(view({ ...HEALTHY, guard: P }).actions).toEqual(["stop", "take_off_record"]);
    expect(view({ ...HEALTHY, guard: P }).lines).toContain(
      fillCopy(P_.limitsNotRead, { reason: P_.limitReasons.guard_set }),
    );
    const theirs = view({ ...HEALTHY, owners: [P] });
    expect(theirs.actions).toEqual(["take_off_record"]);
    expect(theirs.lines).toContain(P_.notYours);
    for (const line of theirs.lines) expect(line).not.toMatch(/Ceiling|In the pot/);
  });

  test("potReadingView: off the record, put_back in place of take_off_record, and the offRecord line; never put_back for another deployment's order", () => {
    const off = view(HEALTHY, { onRecord: false });
    expect(off.actions).toEqual(["change", "stop", "add_money", "fee_money", "put_back"]);
    expect(off.lines.at(-1)).toBe(P_.offRecord);
    expect(view(HEALTHY).lines).not.toContain(P_.offRecord);
    expect(view(HEALTHY, { onRecord: false, onThisDeployment: false }).actions).toEqual([
      "change", "stop", "add_money", "fee_money",
    ]);
    expect(view({ ...HEALTHY, owners: [P] }, { onRecord: false }).actions).toEqual(["put_back"]);
  });

  test("potReadingView: the fee money line, and feeMoneyLow under 0.01 USDC for a plain key, not at 0.01", () => {
    const low = view({ ...HEALTHY, agentBalanceWei: POT_FEE_LOW_WEI - BigInt(1) }).lines;
    expect(low).toContain(fillCopy(P_.shownFeeMoney, { amount: "0.009999999999999999" }));
    expect(low).toContain(P_.feeMoneyLow);
    expect(view({ ...HEALTHY, agentBalanceWei: POT_FEE_LOW_WEI }).lines).not.toContain(P_.feeMoneyLow);
    expect(view({ ...HEALTHY, agentBalanceWei: ZERO, agentHasCode: true }).lines).not.toContain(P_.feeMoneyLow);
    expect(view({ ...STOPPED, agentBalanceWei: ZERO }).lines).toContain(P_.feeMoneyLow);
  });

  test("every line is filled", () => {
    const raws = [HEALTHY, STOPPED, { ...HEALTHY, guard: P }, { ...HEALTHY, owners: [P] }];
    for (const raw of raws)
      for (const line of view(raw, { onRecord: false }).lines) expect(line).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

describe("after a setup's or a restore's receipt", () => {
  test("potCreatedView is ok only for ceiling_read with the plan's ceiling", () => {
    expect(potCreatedView(read(HEALTHY), USDC(50))).toEqual({
      ok: true,
      lines: [
        fillCopy(P_.shownCeiling, { amount: "50" }),
        fillCopy(P_.shownSpent, { spent: "10", left: "40", date: formatDate(HEALTHY_ENDS * 1000) }),
        fillCopy(P_.shownBalance, { balance: "190" }),
      ],
    });
  });

  test("potCreatedView is not ok for stopped, and not ok for a ceiling that is not the plan's", () => {
    expect(potCreatedView(read(STOPPED), USDC(50))).toEqual({
      ok: false,
      lines: [P_.stoppedLine, fillCopy(P_.shownBalance, { balance: "190" })],
    });
    const other = potCreatedView(read(HEALTHY), USDC(60));
    expect(other.ok).toBe(false);
    expect(other.lines[0]).toBe(fillCopy(P_.shownCeiling, { amount: "50" }));
    expect(potCreatedView(read({ ...HEALTHY, guard: P }), USDC(50))).toEqual({
      ok: false,
      lines: [
        fillCopy(P_.limitsNotRead, { reason: P_.limitReasons.guard_set }),
        fillCopy(P_.shownBalance, { balance: "190" }),
      ],
    });
    expect(potCreatedView(read({ ...HEALTHY, owners: [P] }), USDC(50))).toEqual({ ok: false, lines: [P_.notYours] });
    expect(potCreatedView({ state: "absent" }, USDC(50))).toEqual({ ok: false, lines: [P_.waiting] });
  });
});

// ---------------------------------------------------------------------------------------------
// The public record and the agent's side
// ---------------------------------------------------------------------------------------------

describe("the public record's sentence", () => {
  const BIRTH: PotBirth = {
    guardian: G,
    agentWallet: A,
    token: T.usdc,
    ceilingUnits: "50000000",
    periodMinutes: 43200,
    saltNonce: "1",
    proxyFactory: T.proxyFactory,
    singleton: T.safeSingleton,
    fallbackHandler: T.fallbackHandler,
    multiSendCallOnly: T.multiSendCallOnly,
    allowanceModule: T.allowanceModule,
  };
  const READ = { readAtBlock: "73886273", readAt: 1_764_000_000, declaredBy: "guardian" as const, declaredAt: 1_763_990_000, birth: BIRTH };
  const CEILING: PotBlock = {
    state: "ceiling_read",
    address: V3_POT,
    token: T.usdc,
    ceilingUnits: "50000000",
    periodMinutes: 43200,
    spentUnits: "10000000",
    periodEndsAt: HEALTHY_ENDS,
    balanceUnits: "190000000",
    ...READ,
  };

  test("potRecordSentence: ceiling_read says 'in each thirty-day period; the current one ends on', stopped says 'The agent's key cannot take from it: its allowance is switched off.', limits_not_read, unavailable; null for none and for former", () => {
    const ceiling = potRecordSentence(CEILING);
    expect(ceiling).toBe(
      fillCopy(P_.recordCeiling, {
        address: V3_POT,
        amount: "50",
        ends: formatDate(HEALTHY_ENDS * 1000),
        balance: "190",
        date: formatDate(1_764_000_000 * 1000),
      }),
    );
    expect(ceiling).toContain("in each thirty-day period; the current one ends on");
    const stopped = potRecordSentence({ state: "stopped", address: V3_POT, balanceUnits: "3000000", ...READ });
    expect(stopped).toContain("The agent's key cannot take from it: its allowance is switched off.");
    expect(stopped).toContain("It holds 3 USDC.");
    expect(stopped).not.toMatch(/no key may take/i);
    expect(potRecordSentence({ state: "limits_not_read", address: V3_POT, ...READ })).toBe(
      fillCopy(P_.recordNotRead, { address: V3_POT }),
    );
    expect(potRecordSentence({ state: "unavailable" })).toBe(P_.recordUnavailable);
    expect(potRecordSentence(null)).toBeNull();
    expect(potRecordSentence(undefined)).toBeNull();
    expect(
      potRecordSentence({ state: "former", address: V3_POT, declaredBy: "guardian", declaredAt: 1, endedAt: 2, birth: BIRTH }),
    ).toBeNull();
  });

  test("a block it cannot read claims nothing, and never throws", () => {
    // Amounts that are not decimals: the pot named, its limits not read.
    expect(potRecordSentence({ ...CEILING, ceilingUnits: "lots" })).toBe(fillCopy(P_.recordNotRead, { address: V3_POT }));
    expect(potRecordSentence({ ...CEILING, periodEndsAt: Number.NaN })).toBe(fillCopy(P_.recordNotRead, { address: V3_POT }));
    // No address: nothing is named.
    expect(potRecordSentence({ ...CEILING, address: "0x12" as Address })).toBe(P_.recordUnavailable);
    expect(potRecordSentence({ state: "something" } as unknown as PotBlock)).toBeNull();
  });
});

describe("the agent's two commands", () => {
  const RPC = "https://rpc.testnet.arc.network";

  test("potAgentCommands: the take command encodes, for a payee and an amount, to the take the real run mined (V7)", () => {
    const { take } = potAgentCommands({ addresses: T, pot: SAFE_CREATED, agentWallet: A, rpcUrl: RPC });
    const words = take.split(" ").map((w) => w.replace(/^"|"$/g, ""));
    expect(words.slice(0, 2)).toEqual(["cast", "send"]);
    expect(words[2]).toBe(T.allowanceModule);
    expect(words[3]).toBe(
      "executeAllowanceTransfer(address,address,address,uint96,address,uint96,address,bytes)",
    );
    expect(words.slice(6, 8)).toEqual(["PAYEE", "UNITS"]);
    expect(words.slice(12)).toEqual(["--gas-limit", String(POT_TAKE_GAS), "--rpc-url", RPC, "--account", "agent-key"]);
    const args = [
      words[4] as Address,
      words[5] as Address,
      P,
      BigInt(1_000_000),
      words[8] as Address,
      BigInt(words[9] ?? ""),
      words[10] as Address,
      words[11] as Hex,
    ] as const;
    const data = encodeFunctionData({ abi: allowanceModuleAbi, functionName: "executeAllowanceTransfer", args });
    expect(size(data)).toBe(292);
    expect(keccak256(data)).toBe("0xdfe8f8bded62c4439e5dc86fdb9f39258afb89a2a0c10a65383c15ae626c24ec");
  });

  test("the read command asks the module for the pot's allowance to the agent's key in USDC", () => {
    const { read: readCommand } = potAgentCommands({ addresses: T, pot: SAFE_CREATED, agentWallet: A, rpcUrl: RPC });
    expect(readCommand).toBe(
      `cast call ${T.allowanceModule} "getTokenAllowance(address,address,address)(uint256[5])" ${SAFE_CREATED} ${A} ${T.usdc} --rpc-url ${RPC}`,
    );
    // Any letter case in, checksummed out.
    expect(
      potAgentCommands({ addresses: T, pot: SAFE_CREATED.toLowerCase() as Address, agentWallet: A.toLowerCase() as Address, rpcUrl: RPC }).read,
    ).toBe(readCommand);
  });
});

/** A file of this package, read as text. */
function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}
