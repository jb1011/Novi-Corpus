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
  ExecutionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  decodeFunctionData,
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
import {
  allowedCall,
  potExecCall,
  potSetupCall,
  potTransferCall,
  type CallContext,
} from "@/lib/legalBody/chain";
import type { AgentWalletRead } from "@/lib/legalBody/agentWallet";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";
import { formatDate } from "@/lib/format";
import {
  allowanceModuleAbi,
  erc20Abi,
  multicall3Abi,
  POT_EXEC_GAS_CAP,
  POT_FEE_LOW_WEI,
  POT_SETUP_GAS_CAP,
  POT_TAKE_GAS,
  POT_TRANSFER_GAS_CAP,
  potAddresses,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  safeAbi,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import { potReading, type PotRaw, type PotReading } from "@/lib/legalBody/safePotRules";
import {
  notedPotAddress,
  notedPotChecked,
  POT_SERVER_CODES,
  potAgentCommands,
  potCard,
  potCeilingHint,
  potCreatedView,
  potFeeLines,
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
  type PotProblem,
  type PotProblemSay,
} from "@/lib/legalBody/safePotStep";
import {
  potCreateFailureView,
  potFormBegin,
  potFormMoney,
  potFreshSalt,
  potNoteFailure,
  potPlanHolds,
  potReadsAllowed,
  potRecordWallet,
  potReviewNote,
  runPotCreate,
  runPotReview,
  type PotCreateDeps,
  type PotReviewDeps,
} from "@/lib/legalBody/safePotRun";
import {
  POT_ACTION_MOVED,
  potActionAfter,
  potActionContext,
  potActionDoneView,
  potActionFailureView,
  potCeilingCheck,
  potExecSimulationOk,
  isPotTransfer,
  potCardLockCore,
  potRecordFailureView,
  potTransferAmount,
  potTransferDoneView,
  potTransferFailureView,
  potTransferSendLabel,
  runPotAction,
  runPotTransfer,
  type PotActionDeps,
  type PotExecContext,
  type PotSafeAction,
  type PotTransfer,
  type PotTransferContext,
  type PotTransferDeps,
} from "@/lib/legalBody/safePotActions";
import { TIMEOUT_CODE } from "@/lib/api/timeout";
import { ApiError } from "@/lib/api/types";

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
    notedCode: undefined,
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
      fillCopy(P_.ceilingMax, { cap: "350" }),
    );
    expect(potCeilingHint({ kind: "capped", maxUsdc: 350, endsOn: null })).toBe(
      "At most 350 USDC, the grant's thirty-day total for buying, paying and engaging a contractor.",
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
      registryWallet: A,
      keyChanged: false,
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
    // The salt is the note's whenever there is a note.
    expect(potSaltNonce({ noted: NOTED, fresh: BigInt(999) })).toBe(BigInt(1));
    expect(potSaltNonce({ noted: null, fresh: BigInt(999) })).toBe(BigInt(999));
    expect(potSaltNonce({ noted: { ...NOTED, birth: { ...NOTED.birth, saltNonce: "x" } }, fresh: BigInt(999) })).toBe(
      BigInt(999),
    );
    const again = planOf(plan({ noted: NOTED, saltNonce: BigInt(1) }));
    expect(again.pot).toBe(V3_POT);
    expect(again.keyChanged).toBe(false);
    // Another ceiling would be another address, a second pot: refused, with the note's ceiling.
    const other = { ok: true as const, ceilingUnits: USDC(60), fundWei: ZERO, agentGasWei: ZERO };
    expect(plan({ noted: NOTED, saltNonce: BigInt(1), checked: other })).toEqual({ ok: false, problem: "noted_pot" });
    expect(potProblemSentence({ problem: "noted_pot", notedCeilingUnits: USDC(50) })).toBe(
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
    // A note whose first key is the guardian's is never set up.
    expect(plan({ noted: { ...NOTED, birth: { ...NOTED.birth, agentWallet: G } } })).toEqual({
      ok: false,
      problem: "refused",
    });
  });

  test("a noted address that holds code at click time is pot_exists, first, whatever the card was drawn with", () => {
    expect(plan({ noted: NOTED, notedCode: SOME_CODE })).toEqual({ ok: false, problem: "pot_exists" });
    // Before every other rule: a registry that cannot be read, a chain with no table.
    expect(plan({ noted: NOTED, notedCode: SOME_CODE, agentWallet: "unreadable" })).toEqual({
      ok: false,
      problem: "pot_exists",
    });
    expect(plan({ noted: NOTED, notedCode: SOME_CODE, chainId: 1 })).toEqual({ ok: false, problem: "pot_exists" });
    // No code there ("0x" or none): the plan goes on.
    expect(planOf(plan({ noted: NOTED, notedCode: "0x" })).pot).toBe(V3_POT);
  });

  test("a changed key with a code-less note plans the NOTED address for the note's first key, with value 0 and fee 0 (Ruling R19)", () => {
    // The registry names P now; the note was made for A. The form held money and fee money.
    const checked = { ok: true as const, ceilingUnits: USDC(50), fundWei: WEI(USDC(60)), agentGasWei: WEI(BigInt(100_000)) };
    const p = planOf(plan({ noted: NOTED, agentWallet: P, checked, guardianBalanceWei: ZERO }));
    expect(p).toEqual({
      guardian: G,
      agentWallet: A,
      registryWallet: P,
      keyChanged: true,
      agentWalletKind: null,
      ceilingUnits: USDC(50),
      fundWei: ZERO,
      agentGasWei: ZERO,
      saltNonce: BigInt(1),
      pot: V3_POT,
      value: ZERO,
    });
    // The review says nothing moves, names the note's key and the registry's new one, and what next.
    const lines = potReviewLines(p);
    expect(lines).toContain(P_.reviewNoMoney);
    expect(lines).toContain(fillCopy(P_.reviewAgentNoted, { address: A, registry: P }));
    expect(lines).toContain(P_.reviewKeyChanged);
    expect(lines).not.toContain(fillCopy(P_.reviewAgent, { address: A }));
    expect(lines.join(" ")).not.toContain("Multicall3");
    for (const line of lines) expect(line).not.toMatch(/\{[a-zA-Z]+\}/);
    // The one call creates the pot; the allowlist takes the context, which states no kind it did not read.
    const context = potSetupContext(p);
    expect("agentWalletKind" in context).toBe(false);
    const config = { chainId: CHAIN, identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address, factory: FACTORY };
    const req = potSetupCall(config, context, POT_SETUP_GAS_CAP);
    expect("ok" in req).toBe(false);
    if ("ok" in req) return;
    expect(req.value).toBe(ZERO);
    expect(allowedCall(req, { config, order: order(), pot: context }).ok).toBe(true);
    // With a new salt, never a second pot: refused.
    expect(plan({ noted: NOTED, agentWallet: P, saltNonce: BigInt(999) })).toEqual({ ok: false, problem: "refused" });
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
  test("every problem has its sentence, filled with the values its kind requires", () => {
    expect(potProblemSentence({ problem: "not_enough", balanceWei: WEI(USDC(3)), totalWei: BigInt("5100000000000000000") })).toBe(
      fillCopy(P_.problems.not_enough, { balance: "3", total: "5.1" }),
    );
    expect(potProblemSentence({ problem: "not_this_wallet", guardian: G })).toBe(
      fillCopy(P_.problems.not_this_wallet, { address: G }),
    );
    expect(potProblemSentence({ problem: "wrong_network", environment: "sandbox" })).toBe(
      fillCopy(P_.problems.wrong_network, { network: "Arc testnet" }),
    );
    expect(potProblemSentence({ problem: "wrong_network", environment: "production" })).toBe(
      fillCopy(P_.problems.wrong_network, { network: "Arc" }),
    );
  });

  test("no placeholder reaches the screen: every problem and every refusal, with realistic values, leaves no brace", () => {
    // One entry per problem: a problem added without its values fails to compile here.
    const every: Record<PotProblem, PotProblemSay> = {
      unsupported: { problem: "unsupported" },
      agent_wallet: { problem: "agent_wallet" },
      pot_exists: { problem: "pot_exists" },
      not_enough: { problem: "not_enough", balanceWei: WEI(USDC(3)), totalWei: WEI(USDC(5)) },
      not_this_wallet: { problem: "not_this_wallet", guardian: G },
      wrong_network: { problem: "wrong_network", environment: "production" },
      record_failed: { problem: "record_failed" },
      would_revert: { problem: "would_revert" },
      declined: { problem: "declined" },
      reverted: { problem: "reverted" },
      no_receipt: { problem: "no_receipt" },
      read_failed: { problem: "read_failed" },
      refused: { problem: "refused" },
      noted_pot: { problem: "noted_pot", notedCeilingUnits: USDC(50) },
      pot_unreadable: { problem: "pot_unreadable" },
      stale_plan: { problem: "stale_plan" },
      no_gas: { problem: "no_gas" },
    };
    expect(Object.keys(every).sort()).toEqual(Object.keys(P_.problems).sort());
    for (const say of Object.values(every)) {
      const sentence = potProblemSentence(say);
      expect(sentence.length, say.problem).toBeGreaterThan(0);
      expect(sentence, say.problem).not.toContain("{");
    }
    for (const environment of ["sandbox", "production"] as const)
      for (const code of [...Object.keys(P_.refusals), "something_new"])
        expect(potRefusalSentence(code, { environment, guardian: G }), code).not.toContain("{");
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
    expect(potRefusalSentence("fee_money_needs_plain_key", { environment: "sandbox", guardian: G })).toBe(
      potRefusalSentence("fee_money_contract_wallet", { environment: "sandbox", guardian: G }),
    );
    expect(potRefusalSentence("wallet_is_not_the_guardian", { environment: "sandbox", guardian: G })).toContain(G);
    expect(potRefusalSentence("wallet_on_another_chain", { environment: "production", guardian: G })).toContain("Arc");
    // A code this page does not know: the plain refusal, never the code.
    expect(potRefusalSentence("something_new", { environment: "sandbox", guardian: G })).toBe(P_.problems.refused);
    expect(potRefusalSentence("toString", { environment: "sandbox", guardian: G })).toBe(P_.problems.refused);
  });

  test("the server's pot codes choose the next step: a re-read of the pot after pot_exists and pot_not_on_record", () => {
    expect([...POT_SERVER_CODES].sort()).toEqual(
      [
        "pot_not_offered", "pot_exists", "pot_taken", "pot_pending", "pot_address_mismatch", "ceiling_above_grant",
        "grant_allows_no_spending", "pot_not_on_record", "agent_wallet_required", "rate_limited",
        "other_deployment", "legal_body_revoked", "order_closed", "pot_chain_unsupported", "not_found",
        "pot_declaration_required", "pot_invalid",
      ].sort(),
    );
    expect(potServerNext("pot_exists")).toBe("reread_pot");
    expect(potServerNext("pot_not_on_record")).toBe("reread_pot");
    // Ruling R22: a second address while the noted pot is being set up: read the note, plan THAT address.
    expect(potServerNext("pot_pending")).toBe("reread_pot");
    expect(potServerNext("pot_not_offered")).toBe("stop");
    expect(potServerNext("other_deployment")).toBe("stop");
    expect(potServerNext("pot_taken")).toBe("back_to_form");
    expect(potServerNext("pot_address_mismatch")).toBe("back_to_form");
    expect(potServerNext("ceiling_above_grant")).toBe("reread_grant");
    expect(potServerNext("grant_allows_no_spending")).toBe("reread_grant");
    expect(potServerNext("agent_wallet_required")).toBe("reread_record");
    expect(potServerNext("rate_limited")).toBe("try_again");
    // Where a retry can never work: stop.
    for (const code of [
      "legal_body_revoked", "order_closed", "pot_chain_unsupported", "not_found",
      "pot_declaration_required", "pot_invalid",
    ])
      expect(potServerNext(code), code).toBe("stop");
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
      cap: { kind: "none" },
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

  test("potCard: checking while the grant is read; a grant allowing none of the three kinds gets no pot offer, and an existing pot is still managed", () => {
    expect(card({ cap: null })).toBe("checking");
    expect(card({ cap: null, noted: NOTED, reading: read(HEALTHY) })).toBe("checking");
    const noSpending = { kind: "no_spending" } as const;
    expect(card({ cap: noSpending })).toBe("hidden");
    expect(card({ cap: noSpending, noted: NOTED, reading: { state: "absent" } })).toBe("hidden");
    expect(card({ cap: noSpending, noted: NOTED, reading: read(HEALTHY) })).toBe("manage");
    expect(card({ cap: noSpending, noted: NOTED, reading: read(STOPPED) })).toBe("manage");
    // A capped grant offers; a grant that could not be read offers the step, which says so.
    expect(card({ cap: { kind: "capped", maxUsdc: 350, endsOn: null } })).toBe("offer");
    expect(card({ cap: "unreadable" })).toBe("offer");
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
    // Add money only while the pot is on the record (Task 13): money put in a pot taken off the
    // record would not show beside the company.
    const off = view(HEALTHY, { onRecord: false });
    expect(off.actions).toEqual(["change", "stop", "fee_money", "put_back"]);
    expect(off.lines.at(-1)).toBe(P_.offRecord);
    expect(view(HEALTHY).lines).not.toContain(P_.offRecord);
    expect(view(HEALTHY, { onRecord: false, onThisDeployment: false }).actions).toEqual([
      "change", "stop", "fee_money",
    ]);
    // Ruling R26: never put back a pot that is not the guardian's alone; it can still be taken off.
    expect(view({ ...HEALTHY, owners: [P] }, { onRecord: false }).actions).toEqual([]);
    expect(view({ ...HEALTHY, owners: [P] }).actions).toEqual(["take_off_record"]);
    for (const raw of [STOPPED, { ...HEALTHY, guard: P }])
      expect(view(raw, { onRecord: false }).actions, "the guardian's alone").toContain("put_back");
  });

  test("add money only while the pot is on the record and reads ceiling_read or stopped: never off the record, never for other_delegate (a changed key is moved first), never for a pot this page does not read", () => {
    for (const raw of [HEALTHY, STOPPED, { ...HEALTHY, delegates: { list: [], next: 0 } }]) {
      expect(view(raw).actions, "on the record").toContain("add_money");
      expect(view(raw, { onRecord: false }).actions, "off the record").not.toContain("add_money");
    }
    // After a changed-key setup, the pot reads other_delegate until the new key is set: "My agent
    // has a new key" and "Stop" only, then the record action.
    expect(view(HEALTHY, {}, P).actions).toEqual(["new_key", "stop", "take_off_record"]);
    for (const raw of [{ ...HEALTHY, guard: P }, { ...HEALTHY, owners: [P] }, { ...HEALTHY, delegates: { list: [A, P], next: 0 } }])
      expect(view(raw).actions).not.toContain("add_money");
  });

  test("potFeeLines: the lines the reading view says of the agent key's fee money, for a plain key only", () => {
    expect(potFeeLines(HEALTHY)).toEqual([fillCopy(P_.shownFeeMoney, { amount: "0.1" })]);
    expect(potFeeLines({ ...HEALTHY, agentBalanceWei: BigInt("1000000000000000") })).toEqual([
      fillCopy(P_.shownFeeMoney, { amount: "0.001" }),
      P_.feeMoneyLow,
    ]);
    expect(potFeeLines({ ...HEALTHY, agentHasCode: true, agentBalanceWei: ZERO })).toEqual([]);
    // The reading view says exactly these.
    for (const raw of [HEALTHY, STOPPED, { ...HEALTHY, agentBalanceWei: ZERO }])
      for (const line of potFeeLines(raw)) expect(view(raw).lines).toContain(line);
  });

  test("potReadingView: the fee money line, and feeMoneyLow under 0.01 USDC for a plain key, not at 0.01", () => {
    const low = view({ ...HEALTHY, agentBalanceWei: POT_FEE_LOW_WEI - BigInt(1) }).lines;
    expect(low).toContain(fillCopy(P_.shownFeeMoney, { amount: "0.009999999999999999" }));
    expect(low).toContain(P_.feeMoneyLow);
    expect(view({ ...HEALTHY, agentBalanceWei: POT_FEE_LOW_WEI }).lines).not.toContain(P_.feeMoneyLow);
    expect(view({ ...HEALTHY, agentBalanceWei: ZERO, agentHasCode: true }).lines).not.toContain(P_.feeMoneyLow);
    expect(view({ ...STOPPED, agentBalanceWei: ZERO }).lines).toContain(P_.feeMoneyLow);
  });

  test("no fee money line at all for an agent wallet with code, on a running pot or a stopped one", () => {
    for (const raw of [HEALTHY, STOPPED]) {
      const lines = view({ ...raw, agentHasCode: true }).lines;
      expect(lines.some((l) => l.startsWith("Your agent's key holds"))).toBe(false);
      expect(lines).not.toContain(P_.feeMoneyLow);
      // A plain key's line is there for the same pot.
      expect(view(raw).lines).toContain(fillCopy(P_.shownFeeMoney, { amount: "0.1" }));
    }
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

// ---------------------------------------------------------------------------------------------
// The setup's two clicks: the review's fresh reads, and "Create the pot" (`safePotRun.ts`)
// ---------------------------------------------------------------------------------------------

const HASH: Hex = `0x${"7a".repeat(32)}`;
/** A revert, as viem names one through a contract call (`isRevert` reads it). */
const revertError = () =>
  Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" });
/** A revert of a plain call or estimate, as viem builds it: `CallExecutionError` (or
 *  `EstimateGasExecutionError`) around the node's `ExecutionRevertedError`, never named
 *  `ContractFunctionRevertedError`. */
const callRevertError = (wrapper = "CallExecutionError") =>
  Object.assign(new Error("Execution reverted for an unknown reason."), {
    name: wrapper,
    cause: new ExecutionRevertedError({ message: "execution reverted" }),
  });
/** The node could not be reached: not a revert. */
const offlineError = () =>
  Object.assign(new Error("HTTP request failed."), {
    name: "CallExecutionError",
    cause: new HttpRequestError({ url: "https://rpc.example.test", status: 502 }),
  });
/** The node says the sender's balance does not cover the value (and the fee): viem's
 *  `InsufficientFundsError`, inside the wrapper of a call, an estimate or a send. */
const moneyShortError = (wrapper = "CallExecutionError") =>
  Object.assign(new Error("The total cost exceeds the balance of the account."), {
    name: wrapper,
    cause: new InsufficientFundsError(),
  });
/** The wallet's no (EIP-1193 4001). */
const rejectedError = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

/** `aggregate3Value`'s answer for a plan: one result per call, the first naming `pot`. */
function simulated(p: PotPlan, over: { pot?: Address; failed?: boolean } = {}): Hex {
  const calls = 1 + (p.fundWei > ZERO ? 1 : 0) + (p.agentGasWei > ZERO ? 1 : 0);
  const first = { success: over.failed !== true, returnData: encodeAbiParameters([{ type: "address" }], [over.pot ?? p.pot]) };
  const rest = Array.from({ length: calls - 1 }, () => ({ success: true, returnData: "0x" as Hex }));
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3Value", result: [first, ...rest] });
}

describe("runPotCreate: what Create the pot does before and at the wallet", () => {
  /** Hand-made dependencies that say yes, each recording its call: the step on screen, the note
   *  and the registry as the review read them, the guardian connected; `impl` replaces any. */
  function harness(p: PotPlan, impl: Partial<PotCreateDeps> = {}) {
    const calls: string[] = [];
    const yes: PotCreateDeps = {
      alive: () => true,
      preflight: () => ({ ok: true }),
      simulate: async () => simulated(p),
      estimate: async () => BigInt(499_083),
      readBalance: async () => WEI(USDC(1000)),
      readNoted: async () => null,
      readRegistryWallet: async () => p.registryWallet,
      declare: async () => {},
      account: () => p.guardian,
      send: async () => ({ ok: true, hash: HASH }),
    };
    const use = { ...yes, ...impl };
    const d: PotCreateDeps = {
      alive: () => use.alive(),
      preflight: () => {
        calls.push("preflight");
        return use.preflight();
      },
      simulate: () => {
        calls.push("simulate");
        return use.simulate();
      },
      estimate: () => {
        calls.push("estimate");
        return use.estimate();
      },
      readBalance: () => {
        calls.push("balance");
        return use.readBalance();
      },
      readNoted: () => {
        calls.push("pot");
        return use.readNoted();
      },
      readRegistryWallet: () => {
        calls.push("registry");
        return use.readRegistryWallet();
      },
      declare: () => {
        calls.push("declare");
        return use.declare();
      },
      account: () => {
        calls.push("account");
        return use.account();
      },
      send: (gas) => {
        calls.push(`send ${gas}`);
        return use.send(gas);
      },
    };
    return { d, calls };
  }
  const funded = () =>
    planOf(plan({ checked: { ok: true, ceilingUnits: USDC(50), fundWei: WEI(USDC(60)), agentGasWei: WEI(BigInt(100_000)) } }));
  /** Everything up to the note, in order: the reads again, the account, then the note. */
  const UP_TO_NOTE = ["preflight", "simulate", "estimate", "pot", "registry", "account", "declare"];
  const ALL = [...UP_TO_NOTE, "account", "send 648808"];
  /** The step is gone after `n` asks of its lifetime. */
  const goneAfter = (n: number) => {
    let asked = 0;
    return () => {
      asked += 1;
      return asked <= n;
    };
  };

  test("all pass: preflight, simulate, estimate, the note and the registry read again, the account, declare, the account again, send, in that order, and send gets potGasLimit of the estimate", async () => {
    for (const p of [planOf(plan()), funded()]) {
      const { d, calls } = harness(p);
      expect(await runPotCreate(p, null, d)).toEqual({ ok: true, hash: HASH });
      // The server holds the declaration and the address before anything reaches the wallet.
      expect(calls).toEqual(ALL);
      expect(potGasLimit(BigInt(499_083), POT_SETUP_GAS_CAP)).toBe(BigInt(648_808));
    }
    // A plan made from a note: the note read again is that one.
    const again = planOf(plan({ noted: NOTED }));
    const { d } = harness(again, { readNoted: async () => NOTED });
    expect(await runPotCreate(again, NOTED, d)).toEqual({ ok: true, hash: HASH });
  });

  test("a preflight refusal: its problem, and nothing else is called", async () => {
    for (const problem of ["not_this_wallet", "wrong_network", "refused"] as const) {
      const { d, calls } = harness(planOf(plan()), { preflight: () => ({ ok: false, problem }) });
      expect(await runPotCreate(planOf(plan()), null, d)).toEqual({ ok: false, problem });
      expect(calls).toEqual(["preflight"]);
    }
  });

  test("a lifetime ended during the simulation calls neither declare nor send, and reads nothing after it", async () => {
    const p = planOf(plan());
    for (const impl of [
      { alive: goneAfter(0) },
      // A simulation that threw while the person left is not said either.
      { alive: goneAfter(0), simulate: async () => Promise.reject(callRevertError()) },
    ] as Partial<PotCreateDeps>[]) {
      const { d, calls } = harness(p, impl);
      expect(await runPotCreate(p, null, d)).toEqual({ ok: false, problem: "left" });
      expect(calls).toEqual(["preflight", "simulate"]);
    }
  });

  test("a lifetime ended at each later await: the estimate, the reads again, the note; nothing after it, and never the wallet", async () => {
    const p = planOf(plan());
    const cases: [number, string[]][] = [
      [1, ["preflight", "simulate", "estimate"]],
      [2, ["preflight", "simulate", "estimate", "pot", "registry"]],
      // One ended after declare calls no send.
      [3, UP_TO_NOTE],
    ];
    for (const [n, upTo] of cases) {
      const { d, calls } = harness(p, { alive: goneAfter(n) });
      expect(await runPotCreate(p, null, d), String(n)).toEqual({ ok: false, problem: "left" });
      expect(calls, String(n)).toEqual(upTo);
      expect(calls.some((c) => c.startsWith("send")), String(n)).toBe(false);
    }
    // A note refused while the person left is not said either, and nothing is sent.
    const refusedGone = harness(p, {
      alive: goneAfter(3),
      declare: async () => Promise.reject(new ApiError(409, { code: "pot_taken", message: "x" })),
    });
    expect(await runPotCreate(p, null, refusedGone.d)).toEqual({ ok: false, problem: "left" });
    expect(refusedGone.calls).toEqual(UP_TO_NOTE);
  });

  test("a simulation that throws, or that answers another address than the plan's pot: would_revert, and neither declare nor send is called", async () => {
    const p = funded();
    const cases: Partial<PotCreateDeps>[] = [
      // As viem throws it from `call`, and as a contract read would name it.
      { simulate: async () => Promise.reject(callRevertError()) },
      { simulate: async () => Promise.reject(revertError()) },
      { simulate: async () => simulated(p, { pot: SAFE_CREATED }) },
      { simulate: async () => simulated(p, { failed: true }) },
      { simulate: async () => simulated(planOf(plan())) },
      { simulate: async () => "0x" },
    ];
    for (const impl of cases) {
      const { d, calls } = harness(p, impl);
      expect(await runPotCreate(p, null, d)).toMatchObject({ ok: false, problem: "would_revert" });
      expect(calls).toEqual(["preflight", "simulate"]);
    }
  });

  test("a simulation or an estimate the node could not answer: read_failed, never said as a refusal of the chain, and neither declare nor send is called", async () => {
    const p = planOf(plan());
    const sim = harness(p, { simulate: async () => Promise.reject(offlineError()) });
    expect(await runPotCreate(p, null, sim.d)).toMatchObject({ ok: false, problem: "read_failed" });
    expect(sim.calls).toEqual(["preflight", "simulate"]);
    const est = harness(p, { estimate: async () => Promise.reject(offlineError()) });
    expect(await runPotCreate(p, null, est.d)).toMatchObject({ ok: false, problem: "read_failed" });
    expect(est.calls).toEqual(["preflight", "simulate", "estimate"]);
  });

  test("money that fell short since the review: the balance read again, not_enough with it and the plan's own value; nothing noted or sent", async () => {
    const p = funded();
    const short = WEI(USDC(10));
    for (const at of ["simulate", "estimate"] as const) {
      const fail = async () => Promise.reject(moneyShortError());
      const { d, calls } = harness(p, { [at]: fail, readBalance: async () => short });
      const result = await runPotCreate(p, null, d);
      expect(result, at).toEqual({ ok: false, problem: "not_enough", balanceWei: short, totalWei: p.value });
      expect(calls.at(-1), at).toBe("balance");
      expect(calls, at).not.toContain("declare");
      if (!result.ok)
        expect(potCreateFailureView(result, { environment: "sandbox", guardian: G })).toEqual({
          to: "form",
          lines: [fillCopy(P_.problems.not_enough, { balance: "10", total: "60.1" })],
        });
    }
    // The balance itself could not be read: read_failed.
    const unread = harness(p, {
      simulate: async () => Promise.reject(moneyShortError()),
      readBalance: async () => Promise.reject(offlineError()),
    });
    expect(await runPotCreate(p, null, unread.d)).toMatchObject({ ok: false, problem: "read_failed" });
  });

  test("an estimate above the cap: would_revert, and neither declare nor send is called", async () => {
    const p = planOf(plan());
    for (const impl of [
      { estimate: async () => POT_SETUP_GAS_CAP + BigInt(1) },
      { estimate: async () => ZERO },
      { estimate: async () => Promise.reject(callRevertError("EstimateGasExecutionError")) },
      { estimate: async () => Promise.reject(revertError()) },
    ] as Partial<PotCreateDeps>[]) {
      const { d, calls } = harness(p, impl);
      expect(await runPotCreate(p, null, d)).toMatchObject({ ok: false, problem: "would_revert" });
      expect(calls).toEqual(["preflight", "simulate", "estimate"]);
    }
    // At the cap itself, the limit is the cap.
    const atCap = harness(p, { estimate: async () => POT_SETUP_GAS_CAP });
    expect((await runPotCreate(p, null, atCap.d)).ok).toBe(true);
    expect(atCap.calls.at(-1)).toBe(`send ${POT_SETUP_GAS_CAP}`);
  });

  test("right before the note, the noted pot and the registry are read again: a note that is not the plan's, or a key that is not, is stale_plan, and nothing is noted or sent", async () => {
    const fresh = planOf(plan());
    const again = planOf(plan({ noted: NOTED }));
    const another: OrderPotView = { ...NOTED, address: SAFE_CREATED };
    const cases: [string, PotPlan, OrderPotView | null, Partial<PotCreateDeps>][] = [
      // The plan had no note, and one was noted since (another tab).
      ["a note appeared", fresh, null, { readNoted: async () => NOTED }],
      // The plan had a note, and the latest note is of another address.
      ["another address noted", again, NOTED, { readNoted: async () => another }],
      // The plan had a note, and none is there now.
      ["the note is gone", again, NOTED, { readNoted: async () => null }],
      // The registry names another key, or none.
      ["another key", fresh, null, { readRegistryWallet: async () => P }],
      ["no key", fresh, null, { readRegistryWallet: async () => "none" }],
    ];
    for (const [what, p, reviewed, impl] of cases) {
      const { d, calls } = harness(p, impl);
      expect(await runPotCreate(p, reviewed, d), what).toEqual({ ok: false, problem: "stale_plan" });
      expect(calls, what).toEqual(["preflight", "simulate", "estimate", "pot", "registry"]);
    }
    // In any letter case, the same note and the same key hold.
    const sameCase = harness(again, {
      readNoted: async () => ({ ...NOTED, address: V3_POT.toLowerCase() as Address }),
      readRegistryWallet: async () => A.toLowerCase() as Address,
    });
    expect((await runPotCreate(again, NOTED, sameCase.d)).ok).toBe(true);
    // The view: back to the form, review again, the noted pot read again.
    expect(potCreateFailureView({ ok: false, problem: "stale_plan" }, { environment: "sandbox", guardian: G })).toEqual({
      to: "form",
      lines: [P_.problems.stale_plan],
      reread: "pot",
    });
  });

  test("a read again that failed: GET /pot is pot_unreadable with the server's sentence for it, the registry read_failed; nothing noted or sent", async () => {
    const p = planOf(plan());
    const server = new ApiError(503, { code: "chain_unavailable", message: "x" });
    const pot = harness(p, { readNoted: async () => Promise.reject(server) });
    expect(await runPotCreate(p, null, pot.d)).toEqual({ ok: false, problem: "pot_unreadable", cause: server });
    expect(pot.calls).not.toContain("declare");
    expect(potCreateFailureView({ ok: false, problem: "pot_unreadable", cause: server }, { environment: "sandbox", guardian: G })).toEqual({
      to: "review",
      lines: [P_.recordUnavailable],
    });
    const registry = harness(p, { readRegistryWallet: async () => "unreadable" });
    expect(await runPotCreate(p, null, registry.d)).toMatchObject({ ok: false, problem: "read_failed" });
    expect(registry.calls).not.toContain("declare");
  });

  test("the account connected NOW is read right before the note and right before the send: a switch refuses with wallet_is_not_the_guardian, and nothing is sent", async () => {
    const p = planOf(plan());
    // Switched before the note: no note either.
    const before = harness(p, { account: () => P });
    expect(await runPotCreate(p, null, before.d)).toEqual({
      ok: false,
      problem: "refused",
      cause: "wallet_is_not_the_guardian",
    });
    expect(before.calls).not.toContain("declare");
    // Switched while the note was written: the note stands, the wallet is never asked.
    let switched = false;
    const after = harness(p, {
      declare: async () => {
        switched = true;
      },
      account: () => (switched ? P : G),
    });
    expect(await runPotCreate(p, null, after.d)).toEqual({
      ok: false,
      problem: "refused",
      cause: "wallet_is_not_the_guardian",
    });
    expect(after.calls).toEqual([...UP_TO_NOTE, "account"]);
    // Disconnected: the same.
    const none = harness(p, { account: () => null });
    expect((await runPotCreate(p, null, none.d)).ok).toBe(false);
    expect(none.calls.some((c) => c.startsWith("send"))).toBe(false);
    // Any letter case of the guardian is the guardian.
    const lower = harness(p, { account: () => G.toLowerCase() as Address });
    expect((await runPotCreate(p, null, lower.d)).ok).toBe(true);
    expect(potCreateFailureView({ ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" }, { environment: "sandbox", guardian: G })).toEqual({
      to: "review",
      lines: [potRefusalSentence("wallet_is_not_the_guardian", { environment: "sandbox", guardian: G })],
    });
  });

  test("a note the server refuses: record_failed with the error as cause, and send is not called", async () => {
    const p = planOf(plan());
    for (const error of [
      new ApiError(409, { code: "pot_taken", message: "This pot's address is noted for another legal body." }),
      offlineError(),
    ]) {
      const { d, calls } = harness(p, { declare: async () => Promise.reject(error) });
      expect(await runPotCreate(p, null, d)).toEqual({ ok: false, problem: "record_failed", cause: error });
      expect(calls).toEqual(UP_TO_NOTE);
    }
  });

  test("a refusal of the allowlist: refused; a rejection in the wallet: declined; a wallet that cannot pay the fee: no_gas, said as the fee", async () => {
    const p = planOf(plan());
    const refusal = harness(p, { send: async () => ({ ok: false, problem: "wallet_on_another_chain" }) });
    expect(await runPotCreate(p, null, refusal.d)).toEqual({ ok: false, problem: "refused", cause: "wallet_on_another_chain" });
    const no = harness(p, { send: async () => Promise.reject(rejectedError()) });
    expect(await runPotCreate(p, null, no.d)).toMatchObject({ ok: false, problem: "declined" });
    // Wrapped as viem wraps it, the wallet's no is still the wallet's no.
    const wrapped = harness(p, {
      send: async () => Promise.reject(Object.assign(new Error("request failed"), { cause: rejectedError() })),
    });
    expect(await runPotCreate(p, null, wrapped.d)).toMatchObject({ ok: false, problem: "declined" });
    const fee = harness(p, { send: async () => Promise.reject(moneyShortError("TransactionExecutionError")) });
    expect(await runPotCreate(p, null, fee.d)).toMatchObject({ ok: false, problem: "no_gas" });
    expect(potCreateFailureView({ ok: false, problem: "no_gas" }, { environment: "sandbox", guardian: G })).toEqual({
      to: "review",
      lines: [P_.problems.no_gas],
    });
    // Any other throw: would_revert only for a revert, else refused.
    const revert = harness(p, { send: async () => Promise.reject(revertError()) });
    expect(await runPotCreate(p, null, revert.d)).toMatchObject({ ok: false, problem: "would_revert" });
    const nodeRevert = harness(p, { send: async () => Promise.reject(callRevertError("TransactionExecutionError")) });
    expect(await runPotCreate(p, null, nodeRevert.d)).toMatchObject({ ok: false, problem: "would_revert" });
    const other = harness(p, { send: async () => Promise.reject(offlineError()) });
    expect(await runPotCreate(p, null, other.d)).toMatchObject({ ok: false, problem: "refused" });
    for (const h of [refusal, no, wrapped, fee, revert, nodeRevert, other]) expect(h.calls).toEqual(ALL);
  });

  test("potPlanHolds: the review's note (or none) and the plan's key, in any letter case", () => {
    const fresh = planOf(plan());
    const again = planOf(plan({ noted: NOTED }));
    expect(potPlanHolds({ plan: fresh, reviewed: null, latest: null, registry: A })).toBe(true);
    expect(potPlanHolds({ plan: fresh, reviewed: null, latest: NOTED, registry: A })).toBe(false);
    expect(potPlanHolds({ plan: again, reviewed: NOTED, latest: NOTED, registry: A })).toBe(true);
    expect(potPlanHolds({ plan: again, reviewed: NOTED, latest: null, registry: A })).toBe(false);
    expect(potPlanHolds({ plan: again, reviewed: NOTED, latest: { ...NOTED, address: SAFE_CREATED }, registry: A })).toBe(false);
    for (const registry of [P, "none", "unreadable"] as const)
      expect(potPlanHolds({ plan: fresh, reviewed: null, latest: null, registry }), registry).toBe(false);
    // A changed key's plan holds while the registry still names the key the review read.
    const changed = planOf(plan({ noted: NOTED, agentWallet: P }));
    expect(potPlanHolds({ plan: changed, reviewed: NOTED, latest: NOTED, registry: P })).toBe(true);
    expect(potPlanHolds({ plan: changed, reviewed: NOTED, latest: NOTED, registry: A })).toBe(false);
  });
});

describe("runPotReview: the review's reads, every one fresh in the click", () => {
  const CHECKED_50 = { ok: true as const, ceilingUnits: USDC(50), fundWei: ZERO, agentGasWei: ZERO };
  /** Hand-made reads that record what was asked: no note, the registry names A, no code anywhere
   *  but where `code` says, a guardian holding 1,000 USDC, and a fresh salt of 1. */
  function reads(impl: Partial<PotReviewDeps> = {}, code: Record<string, Hex> = {}) {
    const asked: string[] = [];
    const use: PotReviewDeps = {
      readNoted: async () => null,
      readRegistryWallet: async () => A,
      readCode: async (address) => code[address.toLowerCase()],
      readBalance: async () => WEI(USDC(1000)),
      freshSalt: () => BigInt(1),
      ...impl,
    };
    const d: PotReviewDeps = {
      readNoted: () => {
        asked.push("pot");
        return use.readNoted();
      },
      readRegistryWallet: () => {
        asked.push("registry");
        return use.readRegistryWallet();
      },
      readCode: (address) => {
        asked.push(`code ${address.toLowerCase()}`);
        return use.readCode(address);
      },
      readBalance: () => {
        asked.push("balance");
        return use.readBalance();
      },
      freshSalt: () => {
        asked.push("salt");
        return use.freshSalt();
      },
    };
    return { d, asked };
  }
  const review = (d: PotReviewDeps, checked: Extract<PotFormCheck, { ok: true }> = CHECKED_50) =>
    runPotReview({ chainId: CHAIN, guardian: G, checked }, d);
  const lower = (a: Address) => a.toLowerCase();

  test("with no note: GET /pot, the registry and the balance, then the agent wallet's code, then the predicted address's code; the plan is V3", async () => {
    const { d, asked } = reads();
    const result = await review(d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toEqual(planOf(plan()));
    expect(result.plan.pot).toBe(V3_POT);
    expect(result.noted).toBeNull();
    expect(result.kind).toBe("key");
    for (const read of ["pot", "registry", "balance", `code ${lower(A)}`, `code ${lower(V3_POT)}`])
      expect(asked.filter((x) => x === read), read).toHaveLength(1);
    expect(asked.indexOf(`code ${lower(A)}`)).toBeGreaterThan(asked.indexOf("registry"));
    expect(asked.indexOf(`code ${lower(V3_POT)}`)).toBeGreaterThan(asked.indexOf(`code ${lower(A)}`));
  });

  test("a note found in the click, where the card had none: the NOTED address with the note's own salt, never the fresh one", async () => {
    const { d, asked } = reads({ readNoted: async () => NOTED, freshSalt: () => BigInt(999) });
    const result = await review(d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.pot).toBe(V3_POT);
    expect(result.plan.saltNonce).toBe(BigInt(1));
    expect(result.noted).toEqual(NOTED);
    // The noted address's code first (one pot for life is decided before anything else), then the
    // agent wallet's; the noted address is the predicted one, so no other pot's code is read.
    expect(asked.filter((x) => x.startsWith("code "))).toEqual([`code ${lower(V3_POT)}`, `code ${lower(A)}`]);
  });

  test("the noted address holding code in the click: pot_exists, whatever the card was drawn with", async () => {
    const { d } = reads({ readNoted: async () => NOTED }, { [lower(V3_POT)]: SOME_CODE });
    expect(await review(d)).toMatchObject({ ok: false, say: { problem: "pot_exists" } });
    // And with no note, a predicted address that holds code is pot_exists too.
    const fresh = reads({}, { [lower(V3_POT)]: SOME_CODE });
    expect(await review(fresh.d)).toMatchObject({ ok: false, say: { problem: "pot_exists" } });
  });

  test("a failed GET /pot stops the click with pot_unreadable, said as the pot that could not be read, never as the chain", async () => {
    const server = new ApiError(503, { code: "chain_unavailable", message: "x" });
    const { d, asked } = reads({ readNoted: async () => Promise.reject(server) });
    const result = await review(d);
    expect(result).toEqual({ ok: false, say: { problem: "pot_unreadable" }, kind: null, cause: server });
    if (!result.ok) expect(potProblemSentence(result.say)).toBe(P_.recordUnavailable);
    expect(P_.problems.pot_unreadable).toBe(P_.recordUnavailable);
    expect(asked.some((x) => x.startsWith("code "))).toBe(false);
  });

  test("a failed read of the chain stops the click with read_failed, and nothing after it is read or planned", async () => {
    const failures: [Partial<PotReviewDeps>, string][] = [
      [{ readRegistryWallet: async () => Promise.reject(offlineError()) }, "registry"],
      [{ readBalance: async () => Promise.reject(offlineError()) }, "balance"],
      [{ readCode: async () => Promise.reject(offlineError()) }, "code"],
    ];
    for (const [impl, what] of failures) {
      const { d, asked } = reads(impl);
      const result = await review(d);
      expect(result, what).toMatchObject({ ok: false, say: { problem: "read_failed" } });
      if (!result.ok) expect(result.cause, what).toBeDefined();
      if (what !== "code") expect(asked.some((x) => x.startsWith("code ")), what).toBe(false);
    }
    // A registry that could not be read is read_failed too, never "no wallet".
    const registry = reads({ readRegistryWallet: async () => "unreadable" });
    expect(await review(registry.d)).toMatchObject({ ok: false, say: { problem: "read_failed" } });
  });

  test("the registry names none or the guardian's wallet: agent_wallet, and no code is read for it", async () => {
    for (const wallet of ["none", G] as const) {
      const { d, asked } = reads({ readRegistryWallet: async () => wallet });
      expect(await review(d)).toMatchObject({ ok: false, say: { problem: "agent_wallet" } });
      expect(asked).not.toContain(`code ${lower(G)}`);
    }
  });

  test("not_enough names the guardian's balance and the plan's own total", async () => {
    const checked = { ok: true as const, ceilingUnits: USDC(50), fundWei: WEI(USDC(60)), agentGasWei: WEI(BigInt(100_000)) };
    const value = BigInt("60100000000000000000");
    const { d } = reads({ readBalance: async () => value - BigInt(1) });
    const result = await review(d, checked);
    expect(result).toEqual({
      ok: false,
      say: { problem: "not_enough", balanceWei: value - BigInt(1), totalWei: value },
      kind: "key",
    });
    if (!result.ok)
      expect(potProblemSentence(result.say)).toBe(
        fillCopy(P_.problems.not_enough, { balance: "60.099999999999999999", total: "60.1" }),
      );
  });

  test("another ceiling than the noted pot's: noted_pot, naming the note's own ceiling", async () => {
    const { d } = reads({ readNoted: async () => NOTED });
    const result = await review(d, { ok: true, ceilingUnits: USDC(60), fundWei: ZERO, agentGasWei: ZERO });
    expect(result).toMatchObject({ ok: false, say: { problem: "noted_pot", notedCeilingUnits: USDC(50) } });
  });

  test("the agent wallet's kind is read in the click: a contract wallet gets no fee money, and the kind comes back for the form", async () => {
    const checked = { ok: true as const, ceilingUnits: USDC(50), fundWei: ZERO, agentGasWei: WEI(BigInt(100_000)) };
    for (const [code, kind] of [
      [SOME_CODE, "contract"],
      [DELEGATED_CODE, "delegated"],
    ] as const) {
      const { d } = reads({}, { [lower(A)]: code });
      const result = await review(d, checked);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe(kind);
      expect(result.plan.agentGasWei).toBe(ZERO);
      expect(result.plan.value).toBe(ZERO);
    }
  });

  test("potFreshSalt: the salt number of 16 random bytes", () => {
    expect(potFreshSalt(new Uint8Array(16).fill(0xff))).toBe(BigInt(`0x${"ff".repeat(16)}`));
    const one = new Uint8Array(16);
    one[15] = 1;
    expect(potFreshSalt(one)).toBe(BigInt(1));
    expect(() => potFreshSalt(new Uint8Array(15))).toThrow();
    expect(() => potFreshSalt(new Uint8Array(32))).toThrow();
  });
});

describe("after a refusal of Create the pot: where the screen goes, and what it says", () => {
  const ENV = { environment: "sandbox" as const, guardian: G };

  test("the server's refusal of the note: its own sentence as served, and its code chooses the next step", () => {
    const served = "This pot's address is noted for another legal body.";
    expect(potNoteFailure(new ApiError(409, { code: "pot_taken", message: served }))).toEqual({
      next: "back_to_form",
      line: served,
    });
    expect(potNoteFailure(new ApiError(409, { code: "pot_exists", message: served })).next).toBe("reread_pot");
    // No answer, or no answer the server wrote: this page's own sentence, and a try again.
    for (const e of [
      new ApiError(0, { code: "timeout", message: "The request timed out" }),
      new ApiError(502, { code: "http_error", message: "Bad Gateway" }),
      new ApiError(409, { code: "pot_taken", message: "  " }),
      offlineError(),
      "nothing",
    ])
      expect(potNoteFailure(e)).toEqual({ next: "try_again", line: P_.problems.record_failed });
  });

  test("the wallet's own problems go back to the review, with their sentence; nothing is lost but the click", () => {
    expect(potCreateFailureView({ ok: false, problem: "not_this_wallet" }, ENV)).toEqual({
      to: "review",
      lines: [fillCopy(P_.problems.not_this_wallet, { address: G })],
    });
    expect(potCreateFailureView({ ok: false, problem: "wrong_network" }, ENV)).toEqual({
      to: "review",
      lines: [fillCopy(P_.problems.wrong_network, { network: "Arc testnet" })],
    });
    expect(potCreateFailureView({ ok: false, problem: "declined", cause: rejectedError() }, ENV)).toEqual({
      to: "review",
      lines: [P_.problems.declined],
    });
    expect(potCreateFailureView({ ok: false, problem: "read_failed", cause: offlineError() }, ENV)).toEqual({
      to: "review",
      lines: [P_.problems.read_failed],
    });
    // The allowlist's refusal: its own sentence, never its code.
    expect(potCreateFailureView({ ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" }, ENV)).toEqual({
      to: "review",
      lines: [potRefusalSentence("wallet_is_not_the_guardian", ENV)],
    });
    expect(potCreateFailureView({ ok: false, problem: "refused", cause: offlineError() }, ENV)).toEqual({
      to: "review",
      lines: [P_.problems.refused],
    });
  });

  test("a refusal of the chain offers Change something; the page's own refusal before the wallet stops; the server's refusal follows its code", () => {
    expect(potCreateFailureView({ ok: false, problem: "would_revert" }, ENV)).toEqual({
      to: "problem",
      then: "form",
      lines: [P_.problems.would_revert],
    });
    expect(potCreateFailureView({ ok: false, problem: "refused" }, ENV)).toEqual({
      to: "problem",
      then: "none",
      lines: [P_.problems.refused],
    });
    const refusal = (code: string) =>
      potCreateFailureView(
        { ok: false, problem: "record_failed", cause: new ApiError(409, { code, message: `served ${code}` }) },
        ENV,
      );
    expect(refusal("rate_limited")).toEqual({ to: "review", lines: ["served rate_limited"] });
    expect(refusal("pot_taken")).toEqual({ to: "form", lines: ["served pot_taken"] });
    expect(refusal("pot_exists")).toEqual({ to: "problem", then: "form", lines: ["served pot_exists"], reread: "pot" });
    expect(refusal("ceiling_above_grant")).toEqual({ to: "form", lines: ["served ceiling_above_grant"], reread: "grant" });
    expect(refusal("agent_wallet_required")).toEqual({ to: "form", lines: ["served agent_wallet_required"], reread: "record" });
    expect(refusal("legal_body_revoked")).toEqual({ to: "problem", then: "none", lines: ["served legal_body_revoked"] });
    expect(
      potCreateFailureView({ ok: false, problem: "record_failed", cause: offlineError() }, ENV),
    ).toEqual({ to: "review", lines: [P_.problems.record_failed] });
  });
});

describe("the form's money fields", () => {
  test("a plain key, or a kind no click has read yet: the fee field with gasLine, and 0.1 proposed", () => {
    for (const kind of ["key", null] as const) {
      expect(potFormMoney({ kind, noted: null, registryWallet: A })).toEqual({ fields: "key", lines: [P_.gasLine] });
      expect(potFormBegin({ kind, noted: null, registryWallet: A })).toEqual({ ceiling: "", fund: "", agentGas: "0.1" });
    }
  });

  test("a delegated key or a contract wallet: gasContract in place of the fee field, and no fee money", () => {
    for (const kind of ["delegated", "contract"] as const) {
      expect(potFormMoney({ kind, noted: null, registryWallet: A })).toEqual({ fields: "no_fee", lines: [P_.gasContract] });
      expect(potFormBegin({ kind, noted: null, registryWallet: A })).toEqual({ ceiling: "", fund: "", agentGas: "" });
    }
  });

  test("the noted pot that never got code starts with its own ceiling; made for another key than the record's, it has no money fields and says why", () => {
    expect(potFormBegin({ kind: null, noted: NOTED, registryWallet: A })).toEqual({ ceiling: "50", fund: "", agentGas: "0.1" });
    expect(potFormMoney({ kind: null, noted: NOTED, registryWallet: A.toLowerCase() as Address }).fields).toBe("key");
    // The record names P now; the note was made for A.
    expect(potFormMoney({ kind: "key", noted: NOTED, registryWallet: P })).toEqual({
      fields: "none",
      lines: [fillCopy(P_.reviewAgentNoted, { address: A, registry: P }), P_.reviewKeyChanged],
    });
    expect(potFormBegin({ kind: "key", noted: NOTED, registryWallet: P })).toEqual({ ceiling: "50", fund: "", agentGas: "" });
  });
});

describe("the review's note, and the record's wallet", () => {
  test("potReviewNote: gasContract for a delegated key or a contract wallet, read in the click; nothing for a plain key or a kind not read", () => {
    expect(potReviewNote(planOf(plan()))).toBeNull();
    expect(potReviewNote(planOf(plan({ agentCode: SOME_CODE })))).toBe(P_.gasContract);
    expect(potReviewNote(planOf(plan({ agentCode: DELEGATED_CODE })))).toBe(P_.gasContract);
    // A changed key's plan read no kind: nothing said of it.
    expect(potReviewNote(planOf(plan({ noted: NOTED, agentWallet: P })))).toBeNull();
  });

  test("potRecordWallet: the record's agent wallet of its own; null for none, the guardian's, or no address", () => {
    expect(potRecordWallet(record(A), G)).toBe(A);
    expect(potRecordWallet(record(G), G)).toBeNull();
    expect(potRecordWallet(record(G.toLowerCase()), G)).toBeNull();
    expect(potRecordWallet(record(zeroAddress), G)).toBeNull();
    expect(potRecordWallet(record("0x1234"), G)).toBeNull();
    expect(potRecordWallet(null, G)).toBeNull();
  });
});

describe("what the done page reads of the pot", () => {
  const allowed = (over: Partial<Parameters<typeof potReadsAllowed>[0]> = {}) =>
    potReadsAllowed({ potOffered: true, chainId: CHAIN, order: order(), notice: undefined, ...over });

  test("nothing of the pot is read unless /config's pot is true, for a linked order of this chain with no notice", () => {
    expect(allowed()).toBe(true);
    expect(allowed({ potOffered: false })).toBe(false);
    expect(allowed({ potOffered: undefined as unknown as boolean })).toBe(false);
    expect(allowed({ chainId: 1, order: order({ chainId: 1 }) })).toBe(false);
    expect(allowed({ order: null })).toBe(false);
    expect(allowed({ order: order({ revoked: true }) })).toBe(false);
    expect(allowed({ order: order({ state: "deployed" }) })).toBe(false);
    expect(allowed({ order: order({ chainId: 5042 }) })).toBe(false);
    expect(allowed({ notice: { kind: "order_revoked" } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The guardian's Safe actions on the same pot: change, stop, take back, start again, a new key
// (`safePotActions.ts`). Every context is built from the click's own reads, never the card's.
// ---------------------------------------------------------------------------------------------

/** The deployment the allowlist reads: Arc testnet, the registry and the factory as served. */
const CFG: CallContext["config"] = {
  chainId: CHAIN,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: FACTORY,
};
/** A key the registry names in a click, where the card was drawn with another: an invention. */
const Q = "0x00000000000000000000000000000000000a9e17" as const;
/** An invention: some other Safe module. */
const OTHER_MODULE = "0x00000000000000000000000000000000000c0de2" as const;
/** The stopped Safe holding 3 USDC: V10's take back. */
const STOPPED_3: PotRaw = { ...STOPPED, balanceUnits: USDC(3), balanceWei: WEI(USDC(3)) };
const STOPPED_EMPTY: PotRaw = { ...STOPPED, balanceUnits: ZERO, balanceWei: ZERO };
/** The add-on on, no key: stopped, `no_delegate`. */
const NO_DELEGATE: PotRaw = { ...HEALTHY, delegates: { list: [], next: 0 } };
/** The running pot as read for P, a key it never listed: the module answers no token and a zero
 *  allowance for P (the reading is `other_delegate`, the pot's key being A). */
const FOR_P: PotRaw = { ...HEALTHY, tokens: [], allowance: [ZERO, ZERO, ZERO, ZERO, ZERO] };
/** A key removed elsewhere with `removeDelegate(key, false)`, the add-on still on: no key listed
 *  (stopped, `no_delegate`), and the removed key's allowance kept, with what was taken in its
 *  period (Ruling R35). */
const REMOVED_KEEPING: PotRaw = { ...NO_DELEGATE };
/** The 32-byte word 1: Safe's execTransaction answering true. */
const TRUE_WORD: Hex = `0x${"0".repeat(63)}1`;

/** `potActionContext` for the real Safe, from a raw read and the registry's key of the click. */
const ctxOf = (action: PotSafeAction, raw: PotRaw, agentWallet: Address = A, newCeilingUnits?: bigint) =>
  potActionContext(action, {
    pot: SAFE_CREATED,
    guardian: G,
    agentWallet,
    raw,
    reading: read(raw, agentWallet),
    newCeilingUnits,
  });
const acceptedCtx = (c: ReturnType<typeof potActionContext>): PotExecContext => {
  if ("problem" in c) throw new Error("the context was refused");
  return c;
};
/** The calldata the allowlist accepts for an action's context, through potExecCall. */
function acceptedData(ctx: PotExecContext): Hex {
  const req = potExecCall(CFG, ctx, BigInt(200_000));
  if ("ok" in req) throw new Error(`potExecCall refused: ${req.problem}`);
  const allowed = allowedCall(req, { config: CFG, order: order(), pot: ctx });
  if (!allowed.ok) throw new Error(`the allowlist refused: ${allowed.problem}`);
  return allowed.data;
}
const REFUSED = { problem: "refused" };

describe("potActionContext: each action's context from this click's own reads", () => {
  test("change: on ceiling_read only, with the new ceiling; refused on any other reading", () => {
    expect(ctxOf("change", HEALTHY, A, USDC(20))).toEqual({
      kind: "change",
      pot: SAFE_CREATED,
      guardian: G,
      agentWallet: A,
      ceilingUnits: USDC(20),
    });
    for (const [what, raw, wallet] of [
      ["stopped", STOPPED, A],
      ["stopped, the add-on still on", NO_DELEGATE, A],
      ["another key", HEALTHY, P],
      ["a guard", { ...HEALTHY, guard: P }, A],
      ["not the guardian's", { ...HEALTHY, owners: [P] }, A],
      ["absent", { ...HEALTHY, codeHash: null }, A],
    ] as [string, PotRaw, Address][])
      expect(ctxOf("change", raw, wallet, USDC(20)), what).toEqual(REFUSED);
  });

  test("change, start again and a new key take a ceiling under the form's rules only: a whole number of USDC from 1 to 3,000,000,000", () => {
    const bad = [undefined, ZERO, USDC(1) - BigInt(1), USDC(20) + BigInt(1), USDC(3_000_000_000) + USDC(1), -USDC(20)];
    for (const ceiling of bad) {
      expect(ctxOf("change", HEALTHY, A, ceiling), String(ceiling)).toEqual(REFUSED);
      expect(ctxOf("start_again", STOPPED, A, ceiling), String(ceiling)).toEqual(REFUSED);
      expect(ctxOf("new_key", HEALTHY, P, ceiling), String(ceiling)).toEqual(REFUSED);
    }
    expect(ctxOf("change", HEALTHY, A, USDC(3_000_000_000))).toMatchObject({ kind: "change" });
    expect(ctxOf("change", HEALTHY, A, USDC(1))).toMatchObject({ kind: "change" });
  });

  test("stop: every delegate and every module of the raw read, for a pot whose delegate is another key as well; no amount", () => {
    expect(ctxOf("stop", HEALTHY)).toEqual({
      kind: "stop",
      pot: SAFE_CREATED,
      guardian: G,
      delegates: [A],
      modules: [T.allowanceModule],
    });
    // The registry names P; the pot's key is still A: the stop removes A, the key the pot lists.
    expect(ctxOf("stop", HEALTHY, P)).toEqual(ctxOf("stop", HEALTHY, A));
    const two: PotRaw = { ...HEALTHY, delegates: { list: [A, P], next: 0 } };
    expect(ctxOf("stop", two)).toMatchObject({ delegates: [A, P], modules: [T.allowanceModule] });
    expect(ctxOf("stop", NO_DELEGATE)).toMatchObject({ delegates: [], modules: [T.allowanceModule] });
    expect(ctxOf("stop", { ...HEALTHY, guard: P })).toMatchObject({ kind: "stop", delegates: [A] });
    // The stop carries no amount at all: nothing the agent does while the guardian signs can make it fail.
    const stop = acceptedCtx(ctxOf("stop", HEALTHY));
    expect(Object.keys(stop).sort()).toEqual(["delegates", "guardian", "kind", "modules", "pot"]);
    // Copies of the read, never the read's own lists.
    if (stop.kind === "stop") expect(stop.delegates).not.toBe(HEALTHY.delegates.list);
    // Nothing to stop, or not a pot of the guardian's alone: refused.
    for (const raw of [STOPPED, { ...HEALTHY, owners: [P] }, { ...HEALTHY, codeHash: null }])
      expect(ctxOf("stop", raw)).toEqual(REFUSED);
  });

  test("take back: refused while a module is on and with a balance of 0; otherwise the pot's whole balance in wei, as read", () => {
    expect(ctxOf("withdraw", STOPPED_3)).toEqual({
      kind: "withdraw",
      pot: SAFE_CREATED,
      guardian: G,
      modules: [],
      balanceWei: WEI(USDC(3)),
    });
    expect(ctxOf("withdraw", STOPPED)).toMatchObject({ balanceWei: WEI(USDC(190)) });
    for (const [what, raw] of [
      ["the allowance on", HEALTHY],
      ["the add-on still on, no key", NO_DELEGATE],
      ["another add-on on", { ...STOPPED_3, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } }],
      ["a balance of 0", STOPPED_EMPTY],
      ["not the guardian's", { ...STOPPED_3, owners: [P] }],
      ["absent", { ...STOPPED_3, codeHash: null }],
    ] as [string, PotRaw][])
      expect(ctxOf("withdraw", raw), what).toEqual(REFUSED);
  });

  test("start again: only for a stopped pot, a restore for the registry's key of the click", () => {
    expect(ctxOf("start_again", STOPPED, A, USDC(50))).toEqual({
      kind: "restore",
      pot: SAFE_CREATED,
      guardian: G,
      agentWallet: A,
      ceilingUnits: USDC(50),
      delegates: [],
      modules: [],
      clearAllowance: false,
    });
    expect(ctxOf("start_again", STOPPED, P, USDC(50))).toMatchObject({ agentWallet: P, delegates: [], modules: [] });
    expect(ctxOf("start_again", NO_DELEGATE, A, USDC(50))).toMatchObject({ delegates: [], modules: [T.allowanceModule] });
    for (const [what, raw, wallet] of [
      ["running", HEALTHY, A],
      ["another key", HEALTHY, P],
      ["not the guardian's", { ...STOPPED, owners: [P] }, A],
      ["the guardian's own key", STOPPED, G],
    ] as [string, PotRaw, Address][])
      expect(ctxOf("start_again", raw, wallet, USDC(50)), what).toEqual(REFUSED);
  });

  test("a new key: only for other_delegate with the registry's key absent from a complete list, a restore for that key", () => {
    expect(ctxOf("new_key", FOR_P, P, USDC(50))).toEqual({
      kind: "restore",
      pot: SAFE_CREATED,
      guardian: G,
      agentWallet: P,
      ceilingUnits: USDC(50),
      delegates: [A],
      modules: [T.allowanceModule],
      clearAllowance: false,
    });
    for (const [what, raw, wallet] of [
      ["the registry's key is the pot's", HEALTHY, A],
      ["stopped", STOPPED, P],
      ["the registry's key among two", { ...HEALTHY, delegates: { list: [A, P], next: 0 } }, P],
      ["a list that is not complete", { ...HEALTHY, delegates: { list: [A], next: 5 } }, P],
      ["another limit first", { ...HEALTHY, guard: P }, Q],
      ["the guardian's own key", HEALTHY, G],
      ["not the guardian's", { ...HEALTHY, owners: [P] }, P],
    ] as [string, PotRaw, Address][])
      expect(ctxOf("new_key", raw, wallet, USDC(50)), what).toEqual(REFUSED);
  });

  test("Ruling R35: a restore clears the leftovers of an unlisted key whose raw allowance shows any, and only then", () => {
    // Removed elsewhere with its allowance kept: amount, spent, period and last reset are not 0.
    expect(ctxOf("start_again", REMOVED_KEEPING, A, USDC(50))).toMatchObject({
      kind: "restore",
      agentWallet: A,
      delegates: [],
      modules: [T.allowanceModule],
      clearAllowance: true,
    });
    // Any one of the four not 0 is a leftover; the nonce alone is not.
    const allowance = (a: number, s: number, r: number, l: number, n: number) =>
      [BigInt(a), BigInt(s), BigInt(r), BigInt(l), BigInt(n)] as PotRaw["allowance"];
    for (const [what, kept, clear] of [
      ["amount", allowance(1, 0, 0, 0, 2), true],
      ["spent", allowance(0, 1, 0, 0, 2), true],
      ["period", allowance(0, 0, 43200, 0, 2), true],
      ["last reset", allowance(0, 0, 0, 29919864, 2), true],
      ["the nonce alone", allowance(0, 0, 0, 0, 7), false],
      ["nothing", allowance(0, 0, 0, 0, 0), false],
    ] as [string, PotRaw["allowance"], boolean][]) {
      expect(ctxOf("start_again", { ...STOPPED, allowance: kept }, A, USDC(50)), what).toMatchObject({ clearAllowance: clear });
      expect(ctxOf("new_key", { ...FOR_P, allowance: kept }, P, USDC(50)), what).toMatchObject({ clearAllowance: clear });
    }
    // A read that is not five numbers is cleared: the part only removes rights.
    for (const odd of [undefined, [ZERO, ZERO], [0, 0, 0, 0, 0], "00000"])
      expect(ctxOf("start_again", { ...STOPPED, allowance: odd as unknown as PotRaw["allowance"] }, A, USDC(50))).toMatchObject({
        clearAllowance: true,
      });
    // A listed key is removed with its allowance: nothing to clear apart.
    expect(
      ctxOf("start_again", { ...STOPPED, delegates: { list: [A], next: 0 }, allowance: HEALTHY.allowance }, A, USDC(50)),
    ).toMatchObject({ delegates: [A], clearAllowance: false });
    // The stop, the change and the take back carry no such fact.
    for (const [action, raw] of [["stop", HEALTHY], ["change", HEALTHY], ["withdraw", STOPPED_3]] as [PotSafeAction, PotRaw][])
      expect(ctxOf(action, raw, A, USDC(20))).not.toHaveProperty("clearAllowance");
  });

  test("each accepted context passes the allowlist with its vector's bytes: V6, V9, V10, V11, V12, V13, V16 and V17", () => {
    const cases: [string, PotSafeAction, PotRaw, Address, bigint | undefined, number, Hex][] = [
      ["V6 change", "change", HEALTHY, A, USDC(20), 676, "0xc615b5f6bca36df97bbcb1f78c3a6a5f5a4cfb3c0f932d529192511423f01944"],
      ["V9 stop", "stop", HEALTHY, A, undefined, 900, "0xd709c6dfd342e50a6df9859f5063de95552f967b76c3281224a69a8c93507324"],
      ["V10 take back", "withdraw", STOPPED_3, A, undefined, 484, "0xce7031830a444423e2440b3aa34c5e9bfd41e6606641d3deb24abb35961dd164"],
      ["V11 start again", "start_again", STOPPED, A, USDC(50), 1092, "0x86747b4dd8d72f104246417a357650d86a7dd380fef6a438545ae98b453fdb76"],
      ["V12 a new key on a running pot", "new_key", FOR_P, P, USDC(50), 1124, "0xf8652af05b7d90febd332989e7aa09032325dac7467a629f72dc61fb28bed50c"],
      // A stopped pot reads `stopped` whatever key the registry names: its start again is for the
      // registry's key of the click, the new one, which is V13's shape.
      ["V13 the new key on a stopped pot", "start_again", STOPPED, P, USDC(50), 1092, "0x80154523980e27f1c18cdd015aedbfb47a427bc92292b88995879b2373401c12"],
      // Switched off elsewhere with disableModule alone: A still listed, removed first.
      ["V16 start again, the key still listed", "start_again", { ...STOPPED, delegates: { list: [A], next: 0 }, allowance: HEALTHY.allowance }, A, USDC(50), 1252, "0x5cc5e16da50f1eaa12fa7f4a415b509af88d67e05b494e1fb809035362871c1f"],
      // A removed elsewhere with its allowance kept, the add-on on: its leftovers deleted first.
      ["V17 a restore of an unlisted key with leftovers", "start_again", REMOVED_KEEPING, A, USDC(50), 1124, "0x5df83fef2cd3e804490975a21e4f0eef03d743e6c8c799fbff13906b8d90959a"],
    ];
    for (const [name, action, raw, wallet, ceiling, bytes, hash] of cases) {
      const data = acceptedData(acceptedCtx(ctxOf(action, raw, wallet, ceiling)));
      expect(size(data), name).toBe(bytes);
      expect(keccak256(data), name).toBe(hash);
    }
  });
});

describe("potExecSimulationOk: the simulated execTransaction answered true", () => {
  test("true for the 32-byte word 1; false for 0, an empty answer, 31 or 33 bytes, or another word", () => {
    expect(potExecSimulationOk(TRUE_WORD)).toBe(true);
    expect(potExecSimulationOk(encodeFunctionResult({ abi: safeAbi, functionName: "execTransaction", result: true }))).toBe(true);
    for (const answer of [
      `0x${"0".repeat(64)}`,
      encodeFunctionResult({ abi: safeAbi, functionName: "execTransaction", result: false }),
      "0x",
      `0x${"0".repeat(61)}1`,
      `0x${"0".repeat(65)}1`,
      `0x${"0".repeat(63)}2`,
      `0x${"1".repeat(64)}`,
      undefined,
    ] as Hex[])
      expect(potExecSimulationOk(answer), String(answer)).toBe(false);
  });
});

describe("Ruling R32: the browser recomputes the noted pot's address from its own birth details", () => {
  /** The real Safe of 24 Nov, as a note of it would read: born with a five-minute period. */
  const REAL_NOTE: OrderPotView = {
    address: SAFE_CREATED,
    onRecord: true,
    declaredAt: 1_764_000_000,
    birth: { saltNonce: "72231338869903870587851170785833461215", agentWallet: A, ceilingUnits: "2000000" },
  };

  test("notedPotAddress: V3's birth and the guardian give V3's pot; the address moves with every detail and with the guardian", () => {
    expect(notedPotAddress(T, G, NOTED.birth)).toBe(V3_POT);
    expect(notedPotAddress(T, G.toLowerCase() as Address, { ...NOTED.birth, agentWallet: A.toLowerCase() })).toBe(V3_POT);
    for (const [what, guardian, birth] of [
      ["another salt", G, { ...NOTED.birth, saltNonce: "2" }],
      ["another ceiling", G, { ...NOTED.birth, ceilingUnits: "60000000" }],
      ["another first key", G, { ...NOTED.birth, agentWallet: P }],
      ["another guardian", P, NOTED.birth],
    ] as [string, Address, unknown][]) {
      const other = notedPotAddress(T, guardian, birth);
      expect(other, what).not.toBeNull();
      expect(other, what).not.toBe(V3_POT);
    }
    // The real Safe was born with a five-minute period: no note of it recomputes to it.
    expect(notedPotAddress(T, G, REAL_NOTE.birth)).not.toBe(SAFE_CREATED);
  });

  test("notedPotAddress: birth details that do not read give null, never a throw", () => {
    for (const birth of [
      null,
      undefined,
      "1",
      {},
      { ...NOTED.birth, saltNonce: "01" },
      { ...NOTED.birth, saltNonce: 1 },
      { ...NOTED.birth, agentWallet: "0x1234" },
      { ...NOTED.birth, ceilingUnits: "0" },
      { ...NOTED.birth, ceilingUnits: "50000001" },
    ])
      expect(notedPotAddress(T, G, birth), JSON.stringify(birth)).toBeNull();
    // A table that is not the pinned one predicts nothing.
    expect(notedPotAddress({ ...T, proxyFactory: OTHER_MODULE }, G, NOTED.birth)).toBeNull();
  });

  test("notedPotChecked: the prediction when the note's address is it, in any letter case; null for no note, another address or a birth that does not read", () => {
    expect(notedPotChecked(T, G, NOTED)).toBe(V3_POT);
    expect(notedPotChecked(T, G, { ...NOTED, address: V3_POT.toLowerCase() as Address })).toBe(V3_POT);
    expect(notedPotChecked(T, G, { ...NOTED, address: `0x${V3_POT.slice(2).toUpperCase()}` as Address })).toBe(V3_POT);
    for (const [what, noted] of [
      ["no note", null],
      ["not read yet", undefined],
      ["another address", { ...NOTED, address: SAFE_CREATED }],
      ["the real Safe's own note", REAL_NOTE],
      ["a birth that does not read", { ...NOTED, birth: { ...NOTED.birth, saltNonce: "x" } }],
    ] as [string, OrderPotView | null | undefined][])
      expect(notedPotChecked(T, G, noted), what).toBeNull();
    // Another guardian's prediction is another address.
    expect(notedPotChecked(T, P, NOTED)).toBeNull();
  });

});

describe("runPotAction: one transaction on the same pot, from the click's own reads", () => {
  type Fresh = Awaited<ReturnType<PotActionDeps["read"]>>;
  /** The click's read: the registry names `agentWallet`, and the pot is read for it. */
  const fresh = (raw: PotRaw, agentWallet: Address = A): Fresh => ({ agentWallet, raw, reading: read(raw, agentWallet) });
  const none = (agentWallet: AgentWalletRead): Fresh => ({ agentWallet, raw: null, reading: null });
  /** What the card hands the runner: the pot, the guardian, the key its panel names (Ruling R23),
   *  and the ceiling typed. */
  const args = (newCeilingUnits?: bigint, shownAgentWallet: Address = A, noted: OrderPotView = NOTED) => ({
    pot: V3_POT,
    guardian: G,
    shownAgentWallet,
    newCeilingUnits,
    addresses: T,
    noted,
  });
  /** Hand-made dependencies that say yes, each recording its call; the allowlist is the real one,
   *  as the card's closure asks it. `impl` replaces any. */
  function harness(f: Fresh, impl: Partial<PotActionDeps> = {}) {
    const calls: string[] = [];
    const checked: PotExecContext[] = [];
    const sent: PotExecContext[] = [];
    const yes: PotActionDeps = {
      alive: () => true,
      read: async () => f,
      preflight: () => ({ ok: true }),
      check: (ctx) => {
        const req = potExecCall(CFG, ctx, POT_EXEC_GAS_CAP);
        if ("ok" in req) return req;
        const allowed = allowedCall(req, { config: CFG, order: order(), pot: ctx });
        return allowed.ok ? { ok: true, call: { to: req.address, data: allowed.data } } : allowed;
      },
      simulate: async () => TRUE_WORD,
      estimate: async () => BigInt(118_984),
      readBalance: async () => WEI(USDC(1000)),
      account: () => G,
      send: async () => ({ ok: true, hash: HASH }),
    };
    const use = { ...yes, ...impl };
    const d: PotActionDeps = {
      alive: () => use.alive(),
      read: () => {
        calls.push("read");
        return use.read();
      },
      preflight: () => {
        calls.push("preflight");
        return use.preflight();
      },
      check: (ctx) => {
        calls.push("check");
        checked.push(ctx);
        return use.check(ctx);
      },
      simulate: (call) => {
        calls.push("simulate");
        return use.simulate(call);
      },
      estimate: (call) => {
        calls.push("estimate");
        return use.estimate(call);
      },
      readBalance: () => {
        calls.push("balance");
        return use.readBalance();
      },
      account: () => {
        calls.push("account");
        return use.account();
      },
      send: (ctx, gas) => {
        calls.push(`send ${gas}`);
        sent.push(ctx);
        return use.send(ctx, gas);
      },
    };
    return { d, calls, checked, sent };
  }
  const ALL = ["read", "preflight", "check", "simulate", "estimate", "account", "send 154680"];
  /** The step is gone after `n` asks of its lifetime. */
  const goneAfter = (n: number) => {
    let asked = 0;
    return () => {
      asked += 1;
      return asked <= n;
    };
  };

  test("all pass: the click's read, the page's checks, the allowlist, the simulation, the estimate, the account, then the one send, in that order, with potGasLimit of the estimate", async () => {
    const cases: [PotSafeAction, Fresh, bigint | undefined][] = [
      ["change", fresh(HEALTHY), USDC(20)],
      ["stop", fresh(HEALTHY), undefined],
      ["withdraw", fresh(STOPPED_3), undefined],
      ["start_again", fresh(STOPPED), USDC(50)],
      ["new_key", fresh(FOR_P, P), USDC(50)],
    ];
    for (const [action, f, ceiling] of cases) {
      const h = harness(f);
      expect(await runPotAction(action, args(ceiling, f.agentWallet as Address), h.d), action).toEqual({
        ok: true,
        hash: HASH,
        agentWallet: f.agentWallet,
      });
      expect(h.calls, action).toEqual(ALL);
      // What is sent is the context of the click's read, the one the allowlist accepted.
      const want = potActionContext(action, {
        pot: V3_POT,
        guardian: G,
        newCeilingUnits: ceiling,
        agentWallet: f.agentWallet as Address,
        raw: f.raw as PotRaw,
        reading: f.reading as PotReading,
      });
      expect(h.sent, action).toEqual([want]);
      expect(h.checked, action).toEqual([want]);
    }
    expect(potGasLimit(BigInt(118_984), POT_EXEC_GAS_CAP)).toBe(BigInt(154_680));
  });

  /** For each action, a pot its fresh read lets it go on: the raw read, the key, the ceiling. */
  const GOES: [PotSafeAction, PotRaw, Address, bigint | undefined][] = [
    ["change", HEALTHY, A, USDC(20)],
    ["stop", HEALTHY, A, undefined],
    ["withdraw", STOPPED_3, A, undefined],
    ["start_again", STOPPED, A, USDC(50)],
    ["new_key", FOR_P, P, USDC(50)],
  ];

  test("Ruling R32: a noted pot whose address is not what its birth details predict, or whose birth does not read, is refused for each action before anything is read; the right address goes, in any letter case", async () => {
    const wrong: [string, OrderPotView, Address][] = [
      ["another address", { ...NOTED, address: SAFE_CREATED }, SAFE_CREATED],
      ["another salt", { ...NOTED, birth: { ...NOTED.birth, saltNonce: "2" } }, V3_POT],
      ["another ceiling", { ...NOTED, birth: { ...NOTED.birth, ceilingUnits: "60000000" } }, V3_POT],
      ["another first key", { ...NOTED, birth: { ...NOTED.birth, agentWallet: P } }, V3_POT],
      ["a birth that does not read", { ...NOTED, birth: { ...NOTED.birth, saltNonce: "01" } }, V3_POT],
      ["the card's pot not the noted one", NOTED, SAFE_CREATED],
    ];
    for (const [action, raw, wallet, ceiling] of GOES)
      for (const [what, noted, pot] of wrong) {
        const h = harness(fresh(raw, wallet));
        expect(await runPotAction(action, { ...args(ceiling, wallet, noted), pot }, h.d), `${action}, ${what}`).toEqual({
          ok: false,
          problem: "refused",
          cause: POT_ACTION_MOVED,
        });
        expect(h.calls, `${action}, ${what}`).toEqual([]);
      }
    for (const [action, raw, wallet, ceiling] of GOES) {
      const h = harness(fresh(raw, wallet));
      const lower = { ...NOTED, address: V3_POT.toLowerCase() as Address };
      expect(await runPotAction(action, { ...args(ceiling, wallet, lower), pot: V3_POT.toLowerCase() as Address }, h.d), action).toMatchObject({ ok: true });
      // What is sent names the recomputed address.
      expect(h.sent.map((c) => c.pot), action).toEqual([V3_POT]);
    }
  });

  test("a read that throws is read_failed and nothing else is called; a registry that cannot be read is read_failed too", async () => {
    const error = offlineError();
    const thrown = harness(fresh(HEALTHY), { read: async () => Promise.reject(error) });
    expect(await runPotAction("stop", args(), thrown.d)).toEqual({ ok: false, problem: "read_failed", cause: error });
    expect(thrown.calls).toEqual(["read"]);
    const unread = harness(none("unreadable"));
    expect(await runPotAction("stop", args(), unread.d)).toMatchObject({ ok: false, problem: "read_failed" });
    expect(unread.calls).toEqual(["read"]);
  });

  test("a registry that names the guardian's wallet, none, or the zero address: agent_wallet, and nothing else is called", async () => {
    for (const f of [fresh(HEALTHY, G), fresh(HEALTHY, G.toLowerCase() as Address), none("none"), fresh(HEALTHY, zeroAddress)]) {
      const h = harness(f);
      expect(await runPotAction("start_again", args(USDC(50)), h.d), String(f.agentWallet)).toEqual({
        ok: false,
        problem: "agent_wallet",
      });
      expect(h.calls).toEqual(["read"]);
    }
  });

  test("a take back asked while the fresh read shows a module on is refused before any simulation, whatever the card showed", async () => {
    // The card showed a stopped pot with money; the click reads the add-on on (started in another tab).
    for (const raw of [HEALTHY, NO_DELEGATE]) {
      const h = harness(fresh(raw));
      expect(await runPotAction("withdraw", args(), h.d)).toEqual({ ok: false, problem: "refused", cause: POT_ACTION_MOVED });
      expect(h.calls).toEqual(["read"]);
    }
    // Emptied since: nothing to take back, refused the same way.
    const emptied = harness(fresh(STOPPED_EMPTY));
    expect(await runPotAction("withdraw", args(), emptied.d)).toMatchObject({ ok: false, problem: "refused" });
    expect(emptied.calls).toEqual(["read"]);
    // A change asked of a pot stopped since, a start again of a pot running since: the same.
    for (const [action, raw, ceiling] of [
      ["change", STOPPED, USDC(20)],
      ["start_again", HEALTHY, USDC(50)],
      ["new_key", HEALTHY, USDC(50)],
    ] as [PotSafeAction, PotRaw, bigint][]) {
      const h = harness(fresh(raw));
      expect(await runPotAction(action, args(ceiling), h.d), action).toEqual({
        ok: false,
        problem: "refused",
        cause: POT_ACTION_MOVED,
      });
      expect(h.calls, action).toEqual(["read"]);
    }
  });

  test("Ruling R23: a new key or a start again pressed on a card that named key P, while the click's registry read names key Q, is refused before anything else, and the card reads again", async () => {
    for (const [action, raw] of [
      ["new_key", HEALTHY],
      ["start_again", STOPPED],
    ] as [PotSafeAction, PotRaw][]) {
      const h = harness(fresh(raw, Q));
      expect(await runPotAction(action, args(USDC(50), P), h.d), action).toEqual({
        ok: false,
        problem: "refused",
        cause: POT_ACTION_MOVED,
      });
      // Nothing preflighted, checked, simulated or sent.
      expect(h.calls, action).toEqual(["read"]);
      expect(h.sent, action).toEqual([]);
    }
    expect(potActionFailureView({ ok: false, problem: "refused", cause: POT_ACTION_MOVED }, { environment: "sandbox", guardian: G })).toEqual({
      lines: [P_.actionMoved],
      reread: true,
    });
  });

  test("Ruling R23: the key shown and the key read in the click are the same (any letter case): the restore is for that key, built from the click's read", async () => {
    const h = harness(fresh(FOR_P, P));
    expect(await runPotAction("new_key", args(USDC(50), P.toLowerCase() as Address), h.d)).toEqual({
      ok: true,
      hash: HASH,
      agentWallet: P,
    });
    expect(h.sent).toEqual([
      {
        kind: "restore",
        pot: V3_POT,
        guardian: G,
        agentWallet: P,
        ceilingUnits: USDC(50),
        delegates: [A],
        modules: [T.allowanceModule],
        clearAllowance: false,
      },
    ]);
    const again = harness(fresh(STOPPED, P));
    expect(await runPotAction("start_again", args(USDC(50), P), again.d)).toMatchObject({ ok: true, agentWallet: P });
    expect(again.sent).toEqual([
      { kind: "restore", pot: V3_POT, guardian: G, agentWallet: P, ceilingUnits: USDC(50), delegates: [], modules: [], clearAllowance: false },
    ]);
  });

  test("the stop, the change and the take back give no key: a key that moved in the registry never blocks the stop", async () => {
    // The card named A; the registry names Q now. The stop removes every key the pot lists.
    const stop = harness(fresh(HEALTHY, Q));
    expect(await runPotAction("stop", args(undefined, A), stop.d)).toMatchObject({ ok: true });
    expect(stop.sent).toEqual([
      { kind: "stop", pot: V3_POT, guardian: G, delegates: [A], modules: [T.allowanceModule] },
    ]);
    const back = harness(fresh(STOPPED_3, Q));
    expect(await runPotAction("withdraw", args(undefined, A), back.d)).toMatchObject({ ok: true });
  });

  test("a simulation that answers false, or nothing, is would_revert and nothing is sent; one the chain refuses too; one the node could not answer is read_failed", async () => {
    for (const impl of [
      { simulate: async () => `0x${"0".repeat(64)}` as Hex },
      { simulate: async () => "0x" as Hex },
      { simulate: async () => Promise.reject(callRevertError()) },
      { simulate: async () => Promise.reject(revertError()) },
    ] as Partial<PotActionDeps>[]) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotAction("stop", args(), h.d)).toMatchObject({ ok: false, problem: "would_revert" });
      expect(h.calls).toEqual(["read", "preflight", "check", "simulate"]);
    }
    const offline = harness(fresh(HEALTHY), { simulate: async () => Promise.reject(offlineError()) });
    expect(await runPotAction("stop", args(), offline.d)).toMatchObject({ ok: false, problem: "read_failed" });
    const est = harness(fresh(HEALTHY), { estimate: async () => Promise.reject(offlineError()) });
    expect(await runPotAction("stop", args(), est.d)).toMatchObject({ ok: false, problem: "read_failed" });
    expect(est.calls).toEqual(["read", "preflight", "check", "simulate", "estimate"]);
  });

  test("an estimate above the cap, or none, is would_revert; at the cap the limit is the cap", async () => {
    for (const impl of [
      { estimate: async () => POT_EXEC_GAS_CAP + BigInt(1) },
      { estimate: async () => ZERO },
      { estimate: async () => Promise.reject(callRevertError("EstimateGasExecutionError")) },
    ] as Partial<PotActionDeps>[]) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotAction("stop", args(), h.d)).toMatchObject({ ok: false, problem: "would_revert" });
      expect(h.calls).toEqual(["read", "preflight", "check", "simulate", "estimate"]);
    }
    const atCap = harness(fresh(HEALTHY), { estimate: async () => POT_EXEC_GAS_CAP });
    expect((await runPotAction("stop", args(), atCap.d)).ok).toBe(true);
    expect(atCap.calls.at(-1)).toBe(`send ${POT_EXEC_GAS_CAP}`);
  });

  test("money short at the simulation or the estimate: the guardian's balance read again and said; a balance that cannot be read is read_failed", async () => {
    const short = BigInt("100000000000000");
    for (const at of ["simulate", "estimate"] as const) {
      const h = harness(fresh(HEALTHY), { [at]: async () => Promise.reject(moneyShortError()), readBalance: async () => short });
      expect(await runPotAction("stop", args(), h.d), at).toEqual({ ok: false, problem: "no_gas", balanceWei: short });
      expect(h.calls.at(-1), at).toBe("balance");
      expect(h.calls.some((c) => c.startsWith("send")), at).toBe(false);
    }
    const unread = harness(fresh(HEALTHY), {
      simulate: async () => Promise.reject(moneyShortError()),
      readBalance: async () => Promise.reject(offlineError()),
    });
    expect(await runPotAction("stop", args(), unread.d)).toMatchObject({ ok: false, problem: "read_failed" });
  });

  test("the step's lifetime is asked after the read, the simulation and the estimate, and right before the send: a person who left gets no wallet prompt", async () => {
    const cases: [number, string[]][] = [
      [0, ["read"]],
      [1, ["read", "preflight", "check", "simulate"]],
      [2, ["read", "preflight", "check", "simulate", "estimate"]],
      [3, ["read", "preflight", "check", "simulate", "estimate", "account"]],
    ];
    for (const [n, upTo] of cases) {
      const h = harness(fresh(HEALTHY), { alive: goneAfter(n) });
      expect(await runPotAction("stop", args(), h.d), String(n)).toEqual({ ok: false, problem: "left" });
      expect(h.calls, String(n)).toEqual(upTo);
    }
    // A read or a simulation that threw while the person left is not said either.
    for (const impl of [
      { alive: goneAfter(0), read: async () => Promise.reject(offlineError()) },
      { alive: goneAfter(1), simulate: async () => Promise.reject(callRevertError()) },
      { alive: goneAfter(1), simulate: async () => Promise.reject(moneyShortError()) },
    ] as Partial<PotActionDeps>[]) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotAction("stop", args(), h.d)).toEqual({ ok: false, problem: "left" });
      expect(h.calls.some((c) => c.startsWith("send"))).toBe(false);
    }
  });

  test("the account connected NOW is read right before the send: a switch refuses with wallet_is_not_the_guardian, and nothing is sent", async () => {
    for (const account of [P, null]) {
      const h = harness(fresh(HEALTHY), { account: () => account });
      expect(await runPotAction("stop", args(), h.d), String(account)).toEqual({
        ok: false,
        problem: "refused",
        cause: "wallet_is_not_the_guardian",
      });
      expect(h.calls).toEqual(["read", "preflight", "check", "simulate", "estimate", "account"]);
    }
    const lower = harness(fresh(HEALTHY), { account: () => G.toLowerCase() as Address });
    expect((await runPotAction("stop", args(), lower.d)).ok).toBe(true);
  });

  test("the page's own checks and the allowlist come before the chain: a refusal is its problem, and nothing is simulated", async () => {
    for (const problem of ["not_this_wallet", "wrong_network", "refused"] as const) {
      const h = harness(fresh(HEALTHY), { preflight: () => ({ ok: false, problem }) });
      expect(await runPotAction("stop", args(), h.d)).toEqual({ ok: false, problem });
      expect(h.calls).toEqual(["read", "preflight"]);
    }
    // Another add-on alone and no key: the stop has nothing of the pot's to switch off.
    const other: PotRaw = { ...NO_DELEGATE, modules: { list: [OTHER_MODULE], next: SAFE_SENTINEL } };
    const h = harness(fresh(other));
    expect(await runPotAction("stop", args(), h.d)).toEqual({ ok: false, problem: "refused", cause: "nothing_to_stop" });
    expect(h.calls).toEqual(["read", "preflight", "check"]);
  });

  test("the send's outcomes, as Create the pot reads them: a refusal of the door, the wallet's no, a fee it cannot pay, a revert, any other throw", async () => {
    const outcomes: [Partial<PotActionDeps>, object][] = [
      [{ send: async () => ({ ok: false, problem: "wallet_on_another_chain" }) }, { problem: "refused", cause: "wallet_on_another_chain" }],
      [{ send: async () => Promise.reject(rejectedError()) }, { problem: "declined" }],
      [{ send: async () => Promise.reject(moneyShortError("TransactionExecutionError")) }, { problem: "no_gas" }],
      [{ send: async () => Promise.reject(revertError()) }, { problem: "would_revert" }],
      [{ send: async () => Promise.reject(callRevertError("TransactionExecutionError")) }, { problem: "would_revert" }],
      [{ send: async () => Promise.reject(offlineError()) }, { problem: "refused" }],
    ];
    for (const [impl, want] of outcomes) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotAction("stop", args(), h.d)).toMatchObject({ ok: false, ...want });
      expect(h.calls).toEqual(ALL);
    }
  });
});

describe("the actions' sentences, the ceiling field, and what the card shows after", () => {
  const ENV = { environment: "sandbox" as const, guardian: G };
  const CAP = { kind: "capped" as const, maxUsdc: 350, endsOn: null };

  test("potActionFailureView: a pot not as the card showed it is said so and read again; every other problem is Task 10's sentence", () => {
    expect(potActionFailureView({ ok: false, problem: "refused", cause: POT_ACTION_MOVED }, ENV)).toEqual({
      lines: [P_.actionMoved],
      reread: true,
    });
    expect(potActionFailureView({ ok: false, problem: "refused", cause: "nothing_to_stop" }, ENV)).toEqual({
      lines: [potRefusalSentence("nothing_to_stop", ENV)],
      reread: false,
    });
    expect(potActionFailureView({ ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" }, ENV).lines).toEqual([
      fillCopy(P_.problems.not_this_wallet, { address: G }),
    ]);
    for (const cause of [undefined, offlineError()])
      expect(potActionFailureView({ ok: false, problem: "refused", cause }, ENV).lines).toEqual([P_.problems.refused]);
    for (const problem of ["read_failed", "agent_wallet", "would_revert", "declined"] as const)
      expect(potActionFailureView({ ok: false, problem }, ENV), problem).toEqual({
        lines: [potProblemSentence({ problem })],
        reread: false,
      });
    expect(potActionFailureView({ ok: false, problem: "not_this_wallet" }, ENV).lines).toEqual([
      fillCopy(P_.problems.not_this_wallet, { address: G }),
    ]);
    expect(potActionFailureView({ ok: false, problem: "wrong_network" }, ENV).lines).toEqual([
      fillCopy(P_.problems.wrong_network, { network: "Arc testnet" }),
    ]);
    expect(potActionFailureView({ ok: false, problem: "no_gas", balanceWei: BigInt("100000000000000") }, ENV).lines).toEqual([
      fillCopy(P_.feeShort, { balance: "0.0001" }),
    ]);
    expect(potActionFailureView({ ok: false, problem: "no_gas" }, ENV).lines).toEqual([P_.problems.no_gas]);
    expect(potActionFailureView({ ok: false, problem: "left" }, ENV)).toEqual({ lines: [], reread: false });
    for (const s of [P_.actionMoved, P_.feeShort]) {
      expect(s).not.toMatch(/enforced|guarantee|free\b|—/i);
    }
  });

  test("potActionDoneView: a change or a restore is done only when the chain reads its ceiling; a stop or a take back once the allowance reads switched off", () => {
    expect(potActionDoneView("change", read(HEALTHY), USDC(50), A)).toEqual(potCreatedView(read(HEALTHY), USDC(50)));
    expect(potActionDoneView("change", read(HEALTHY), USDC(50), A).ok).toBe(true);
    expect(potActionDoneView("change", read(HEALTHY), USDC(20), A).ok).toBe(false);
    // A restore that left the allowance off: the warning's own lines, and no key named.
    expect(potActionDoneView("start_again", read(STOPPED), USDC(50), A)).toEqual({
      ok: false,
      lines: [P_.stoppedLine, fillCopy(P_.shownBalance, { balance: "190" })],
    });
    expect(potActionDoneView("new_key", read(HEALTHY, P), USDC(50), P).ok).toBe(false);
    // A restore that is done names the key that may take now: the click's.
    const moved = read({ ...HEALTHY, delegates: { list: [Q], next: 0 } }, Q);
    expect(potActionDoneView("new_key", moved, USDC(50), Q)).toEqual({
      ok: true,
      lines: [fillCopy(P_.shownAgent, { address: Q }), ...potCreatedView(moved, USDC(50)).lines],
    });
    expect(potActionDoneView("start_again", read(HEALTHY), USDC(50), A).lines[0]).toBe(fillCopy(P_.shownAgent, { address: A }));
    expect(potActionDoneView("stop", read(STOPPED), null, A)).toEqual({
      ok: true,
      lines: [P_.stoppedLine, fillCopy(P_.shownBalance, { balance: "190" })],
    });
    expect(potActionDoneView("stop", read(HEALTHY), null, A).ok).toBe(false);
    expect(potActionDoneView("withdraw", read(STOPPED_EMPTY), null, A)).toEqual({
      ok: true,
      lines: [P_.stoppedLine, fillCopy(P_.shownBalance, { balance: "0" })],
    });
    expect(potActionDoneView("withdraw", read({ ...HEALTHY, owners: [P] }), null, A)).toEqual({ ok: false, lines: [P_.notYours] });
  });

  test("potActionAfter: onePot under the stop's result, and nothing under the others'", () => {
    const done = { ok: true, lines: [], hash: HASH };
    expect(potActionAfter({ at: "done", action: "stop", ...done })).toEqual([P_.onePot]);
    expect(potActionAfter({ at: "done", action: "withdraw", ...done })).toEqual([]);
    expect(potActionAfter({ at: "problem", action: "stop", lines: [], hash: null, again: null })).toEqual([]);
    expect(potActionAfter({ at: "idle" })).toEqual([]);
  });

  test("potCeilingCheck: the form's ceiling rule, with the grant's cap", () => {
    expect(potCeilingCheck("20", CAP)).toEqual({ ok: true, ceilingUnits: USDC(20) });
    expect(potCeilingCheck("350", CAP)).toEqual({ ok: true, ceilingUnits: USDC(350) });
    expect(potCeilingCheck("", CAP)).toEqual({ ok: false, line: P_.ceilingProblems.empty });
    expect(potCeilingCheck("20.5", CAP)).toEqual({ ok: false, line: P_.ceilingProblems.not_whole });
    expect(potCeilingCheck("0", CAP)).toEqual({ ok: false, line: P_.ceilingProblems.zero });
    expect(potCeilingCheck("351", CAP)).toEqual({
      ok: false,
      line: fillCopy(P_.ceilingProblems.above_grant, { amount: "350" }),
    });
    expect(potCeilingCheck("20", { kind: "no_spending" })).toEqual({ ok: false, line: P_.grantNoSpending });
    expect(potCeilingCheck("4000", { kind: "none" })).toEqual({ ok: true, ceilingUnits: USDC(4000) });
  });
});

// ---------------------------------------------------------------------------------------------
// Add money and send fee money: one USDC transfer each (`safePotActions.ts`). Every context is
// built from the click's own reads; the money moves as USDC units, never as value.
// ---------------------------------------------------------------------------------------------

describe("potTransferAmount: the amount typed, in USDC units", () => {
  test("'' is empty, '5' is 5000000 units, '0.0000001' is too precise; fee money '1.5' is above its 1 USDC", () => {
    for (const kind of ["add_money", "fee_money"] as PotTransfer[])
      expect(potTransferAmount(kind, ""), kind).toEqual({ ok: false, sentence: P_.amountProblems.empty });
    expect(potTransferAmount("add_money", "5")).toEqual({ ok: true, amountUnits: BigInt(5_000_000) });
    expect(potTransferAmount("add_money", "0.0000001")).toEqual({ ok: false, sentence: P_.amountProblems.too_precise });
    expect(potTransferAmount("fee_money", "0.0000001")).toEqual({ ok: false, sentence: P_.amountProblems.too_precise });
    expect(potTransferAmount("fee_money", "1.5")).toEqual({ ok: false, sentence: P_.amountProblems.gas_too_large });
    // 1.5 USDC is fine for the pot.
    expect(potTransferAmount("add_money", "1.5")).toEqual({ ok: true, amountUnits: BigInt(1_500_000) });
  });

  test("the bounds: fee money at most 1 USDC, the pot's money at most 1,000,000,000 USDC; 0 is refused; anything else than an amount is not one", () => {
    expect(potTransferAmount("fee_money", "0.1")).toEqual({ ok: true, amountUnits: BigInt(100_000) });
    expect(potTransferAmount("fee_money", "1")).toEqual({ ok: true, amountUnits: USDC(1) });
    expect(potTransferAmount("fee_money", "1.000001")).toEqual({ ok: false, sentence: P_.amountProblems.gas_too_large });
    expect(potTransferAmount("fee_money", "0.000001")).toEqual({ ok: true, amountUnits: BigInt(1) });
    expect(potTransferAmount("add_money", "1000000000")).toEqual({ ok: true, amountUnits: USDC(1_000_000_000) });
    expect(potTransferAmount("add_money", "1000000000.000001")).toEqual({ ok: false, sentence: P_.amountProblems.too_large });
    for (const kind of ["add_money", "fee_money"] as PotTransfer[]) {
      for (const zero of ["0", "0.0", ".0", "0.000000", "00"])
        expect(potTransferAmount(kind, zero), `${kind} ${zero}`).toEqual({ ok: false, sentence: P_.amountProblems.zero });
      for (const bad of ["abc", "5 ", " 5", "-1", "1,5", ".", "1e3", "0x10"])
        expect(potTransferAmount(kind, bad), `${kind} ${bad}`).toEqual({ ok: false, sentence: P_.amountProblems.not_amount });
    }
    expect(P_.amountProblems.zero).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  test("potTransferSendLabel: the amount that will be sent once the field reads one, formatted from its units; the panel's title before", () => {
    expect(potTransferSendLabel("add_money", "")).toBe(P_.addMoneyTitle);
    expect(potTransferSendLabel("add_money", "5")).toBe(fillCopy(P_.addMoneySend, { amount: "5" }));
    expect(potTransferSendLabel("add_money", "5.50")).toBe(fillCopy(P_.addMoneySend, { amount: "5.5" }));
    expect(potTransferSendLabel("add_money", "abc")).toBe(P_.addMoneyTitle);
    expect(potTransferSendLabel("fee_money", "0.1")).toBe(fillCopy(P_.feeMoneySend, { amount: "0.1" }));
    expect(potTransferSendLabel("fee_money", "")).toBe(P_.feeMoneyTitle);
    expect(potTransferSendLabel("fee_money", "1.5")).toBe(P_.feeMoneyTitle);
    expect(isPotTransfer("add_money") && isPotTransfer("fee_money")).toBe(true);
    for (const other of ["change", "stop", "take_off_record", "put_back", "toString"]) expect(isPotTransfer(other), other).toBe(false);
  });
});

describe("runPotTransfer: one USDC transfer, from the click's own reads", () => {
  type Fresh = Awaited<ReturnType<PotTransferDeps["read"]>>;
  const BALANCE = WEI(USDC(1000));
  /** The click's read: the registry names `agentWallet`, the pot read for it, the guardian's
   *  balance in native wei. */
  const fresh = (raw: PotRaw, agentWallet: Address = A, guardianBalanceWei: bigint = BALANCE): Fresh => ({
    agentWallet,
    raw,
    reading: read(raw, agentWallet),
    guardianBalanceWei,
  });
  const none = (agentWallet: AgentWalletRead): Fresh => ({ agentWallet, raw: null, reading: null, guardianBalanceWei: BALANCE });
  /** V3's pot as GET /pot serves it, on the record: an address the browser recomputes from its
   *  birth details (Ruling R32). The real Safe of 24 Nov was born with a five-minute period, so no
   *  note of it is ever read as a pot; V14's bytes stay pinned at the allowlist. */
  const NOTED_SAFE: OrderPotView = NOTED;
  /** What the card hands the runner: the noted pot, the guardian, the key the fee money panel
   *  names, and the amount typed in units. */
  const args = (amountUnits: bigint, shownAgentWallet: Address = A, noted: OrderPotView = NOTED) => ({
    pot: V3_POT,
    guardian: G,
    shownAgentWallet,
    amountUnits,
    addresses: T,
    noted,
  });
  const ADD = BigInt(5_000_000);
  const FEE = BigInt(100_000);
  /** V14 and V15's estimate from G on the real node. */
  const ESTIMATE = BigInt(49_338);

  /** Hand-made dependencies that say yes, each recording its call; the allowlist is the real one,
   *  as the card's closure asks it, and `data` holds the calldata it accepted. */
  function harness(f: Fresh, impl: Partial<PotTransferDeps> = {}) {
    const calls: string[] = [];
    const checked: PotTransferContext[] = [];
    const sent: PotTransferContext[] = [];
    const data: Hex[] = [];
    const yes: PotTransferDeps = {
      alive: () => true,
      read: async () => f,
      readNoted: async () => NOTED_SAFE,
      preflight: () => ({ ok: true }),
      check: (ctx) => {
        const req = potTransferCall(CFG, ctx, POT_TRANSFER_GAS_CAP);
        if ("ok" in req) return req;
        const allowed = allowedCall(req, { config: CFG, order: order(), pot: ctx });
        return allowed.ok ? { ok: true, call: { to: req.address, data: allowed.data } } : allowed;
      },
      simulate: async () => TRUE_WORD,
      estimate: async () => ESTIMATE,
      readBalance: async () => BALANCE,
      account: () => G,
      send: async () => ({ ok: true, hash: HASH }),
    };
    const use = { ...yes, ...impl };
    const d: PotTransferDeps = {
      alive: () => use.alive(),
      read: () => {
        calls.push("read");
        return use.read();
      },
      readNoted: () => {
        calls.push("noted");
        return use.readNoted();
      },
      preflight: () => {
        calls.push("preflight");
        return use.preflight();
      },
      check: (ctx) => {
        calls.push("check");
        checked.push(ctx);
        const answer = use.check(ctx);
        if (answer.ok) data.push(answer.call.data);
        return answer;
      },
      simulate: (call) => {
        calls.push("simulate");
        return use.simulate(call);
      },
      estimate: (call) => {
        calls.push("estimate");
        return use.estimate(call);
      },
      readBalance: () => {
        calls.push("balance");
        return use.readBalance();
      },
      account: () => {
        calls.push("account");
        return use.account();
      },
      send: (ctx, gas) => {
        calls.push(`send ${gas}`);
        sent.push(ctx);
        return use.send(ctx, gas);
      },
    };
    return { d, calls, checked, sent, data };
  }
  // Ruling R32: add money reads GET /pot first, and checks its address, before any read of the pot.
  const ADD_ALL = ["noted", "read", "preflight", "check", "simulate", "estimate", "account", "send 64140"];
  const FEE_ALL = ["read", "preflight", "check", "simulate", "estimate", "account", "send 64140"];
  const ADD_CTX: PotTransferContext = { kind: "add_money", pot: V3_POT, guardian: G, amountUnits: ADD };
  const FEE_CTX: PotTransferContext = { kind: "fee_money", guardian: G, agentWallet: A, agentHasCode: false, amountUnits: FEE };
  const goneAfter = (n: number) => {
    let asked = 0;
    return () => {
      asked += 1;
      return asked <= n;
    };
  };

  test("all pass: the click's reads (and for Add money the noted pot, fresh), the page's checks, the allowlist, the simulation, the estimate, the account, then the one send; an estimate of 49338 sends gas 64140", async () => {
    for (const raw of [HEALTHY, STOPPED]) {
      const add = harness(fresh(raw));
      expect(await runPotTransfer("add_money", args(ADD), add.d)).toEqual({ ok: true, hash: HASH, agentWallet: A });
      expect(add.calls).toEqual(ADD_ALL);
      expect(add.sent).toEqual([ADD_CTX]);
      expect(add.checked).toEqual([ADD_CTX]);
      const fee = harness(fresh(raw));
      expect(await runPotTransfer("fee_money", args(FEE), fee.d)).toEqual({ ok: true, hash: HASH, agentWallet: A });
      expect(fee.calls).toEqual(FEE_ALL);
      expect(fee.sent).toEqual([FEE_CTX]);
    }
    expect(potGasLimit(ESTIMATE, POT_TRANSFER_GAS_CAP)).toBe(BigInt(64_140));
  });

  test("each accepted context passes Task 4's allowlist: add money is V14's transfer to V3's pot (V14 itself, to the real Safe, stays pinned at the allowlist), and V15 (fee money, 0.1 USDC to A) byte for byte", async () => {
    const add = harness(fresh(HEALTHY));
    await runPotTransfer("add_money", args(ADD), add.d);
    expect(add.data).toHaveLength(1);
    expect(size(add.data[0])).toBe(68);
    expect(decodeFunctionData({ abi: erc20Abi, data: add.data[0] })).toEqual({
      functionName: "transfer",
      args: [V3_POT, ADD],
    });
    const fee = harness(fresh(HEALTHY));
    await runPotTransfer("fee_money", args(FEE), fee.d);
    expect(size(fee.data[0])).toBe(68);
    expect(keccak256(fee.data[0])).toBe("0x81c73e55a126dfa49b01a558cb943527c09e803ac8ae17fa26f2b84a6532ab10");
  });

  test("Ruling R32: add money checks the fresh GET /pot answer, fee money the card's note, against the address its own birth details predict, before any chain read; the right address goes, in any letter case", async () => {
    const wrong: [string, OrderPotView][] = [
      ["another address", { ...NOTED, address: SAFE_CREATED }],
      ["another salt", { ...NOTED, birth: { ...NOTED.birth, saltNonce: "2" } }],
      ["another ceiling", { ...NOTED, birth: { ...NOTED.birth, ceilingUnits: "60000000" } }],
      ["another first key", { ...NOTED, birth: { ...NOTED.birth, agentWallet: P } }],
      ["a birth that does not read", { ...NOTED, birth: null as unknown as OrderPotView["birth"] }],
    ];
    for (const [what, noted] of wrong) {
      // Add money: the server's fresh answer is the one checked; the card's own note is right.
      const add = harness(fresh(HEALTHY), { readNoted: async () => noted });
      expect(await runPotTransfer("add_money", args(ADD), add.d), what).toEqual({ ok: false, problem: "refused", cause: POT_ACTION_MOVED });
      expect(add.calls, what).toEqual(["noted"]);
      expect(add.sent, what).toEqual([]);
      // Fee money: the card's note is checked, and nothing is read.
      const fee = harness(fresh(HEALTHY));
      expect(await runPotTransfer("fee_money", args(FEE, A, noted), fee.d), what).toEqual({ ok: false, problem: "refused", cause: POT_ACTION_MOVED });
      expect(fee.calls, what).toEqual([]);
    }
    // The card's pot not the noted one: both refuse.
    const elsewhere = { ...args(ADD), pot: SAFE_CREATED };
    expect(await runPotTransfer("add_money", elsewhere, harness(fresh(HEALTHY)).d)).toMatchObject({ cause: POT_ACTION_MOVED });
    expect(await runPotTransfer("fee_money", { ...elsewhere, amountUnits: FEE }, harness(fresh(HEALTHY)).d)).toMatchObject({ cause: POT_ACTION_MOVED });
    // Letter case is ignored; what is sent names the recomputed address.
    const lower = { ...NOTED, address: V3_POT.toLowerCase() as Address };
    const add = harness(fresh(HEALTHY), { readNoted: async () => lower });
    expect(await runPotTransfer("add_money", { ...args(ADD), pot: V3_POT.toLowerCase() as Address }, add.d)).toMatchObject({ ok: true });
    expect(add.sent).toEqual([ADD_CTX]);
    const fee = harness(fresh(HEALTHY));
    expect(await runPotTransfer("fee_money", args(FEE, A, lower), fee.d)).toMatchObject({ ok: true });
  });

  test("a read that throws is read_failed and nothing else is called; a registry that cannot be read too; a registry naming the guardian, none or zero is agent_wallet", async () => {
    const error = offlineError();
    for (const kind of ["add_money", "fee_money"] as PotTransfer[]) {
      // Add money has read GET /pot first (Ruling R32).
      const reads = kind === "add_money" ? ["noted", "read"] : ["read"];
      const thrown = harness(fresh(HEALTHY), { read: async () => Promise.reject(error) });
      expect(await runPotTransfer(kind, args(ADD), thrown.d)).toEqual({ ok: false, problem: "read_failed", cause: error });
      expect(thrown.calls).toEqual(reads);
      const unread = harness(none("unreadable"));
      expect(await runPotTransfer(kind, args(FEE), unread.d)).toMatchObject({ ok: false, problem: "read_failed" });
      expect(unread.calls).toEqual(reads);
      for (const f of [fresh(HEALTHY, G), fresh(HEALTHY, G.toLowerCase() as Address), none("none"), fresh(HEALTHY, zeroAddress)]) {
        const h = harness(f);
        expect(await runPotTransfer(kind, args(FEE), h.d), `${kind} ${String(f.agentWallet)}`).toEqual({ ok: false, problem: "agent_wallet" });
        expect(h.calls).toEqual(reads);
      }
    }
  });

  test("add money to a pot whose fresh read is not_the_guardians, limits_not_read or absent is refused before any simulation, and the card reads again", async () => {
    const cases: [string, Fresh][] = [
      ["not_the_guardians", fresh({ ...HEALTHY, owners: [P] })],
      ["limits_not_read, a guard", fresh({ ...HEALTHY, guard: P })],
      // A changed key on a running pot: other_delegate until the new key is set.
      ["limits_not_read, other_delegate", fresh(HEALTHY, P)],
      ["absent", fresh({ ...HEALTHY, codeHash: null })],
    ];
    for (const [what, f] of cases) {
      const h = harness(f);
      expect(await runPotTransfer("add_money", args(ADD), h.d), what).toEqual({ ok: false, problem: "refused", cause: POT_ACTION_MOVED });
      expect(h.calls, what).toEqual(["noted", "read"]);
      expect(h.sent, what).toEqual([]);
    }
    expect(potTransferFailureView({ ok: false, problem: "refused", cause: POT_ACTION_MOVED }, { environment: "sandbox", guardian: G })).toEqual({
      lines: [P_.actionMoved],
      reread: true,
    });
    // A stopped pot reads stopped whatever key the registry names: money may go in.
    expect((await runPotTransfer("add_money", args(ADD), harness(fresh(STOPPED, P)).d)).ok).toBe(true);
  });

  test("add money only to the noted pot, on the record, read fresh in the click: another address, off the record or no note is refused; a failed read is pot_unreadable", async () => {
    for (const [what, noted] of [
      ["another address noted", { ...NOTED_SAFE, address: SAFE_CREATED }],
      ["off the record", { ...NOTED_SAFE, onRecord: false }],
      ["no note", null],
    ] as [string, OrderPotView | null][]) {
      const h = harness(fresh(HEALTHY), { readNoted: async () => noted });
      expect(await runPotTransfer("add_money", args(ADD), h.d), what).toEqual({ ok: false, problem: "refused", cause: POT_ACTION_MOVED });
      // Refused on the server's answer alone: the pot is not read (Ruling R32).
      expect(h.calls, what).toEqual(["noted"]);
    }
    const server = new ApiError(503, { code: "chain_unavailable", message: "x" });
    const failed = harness(fresh(HEALTHY), { readNoted: async () => Promise.reject(server) });
    expect(await runPotTransfer("add_money", args(ADD), failed.d)).toEqual({ ok: false, problem: "pot_unreadable", cause: server });
    expect(failed.calls).toEqual(["noted"]);
    expect(potTransferFailureView({ ok: false, problem: "pot_unreadable", cause: server }, { environment: "sandbox", guardian: G }).lines).toEqual([
      P_.problems.pot_unreadable,
    ]);
    // The same address in another letter case is the noted pot.
    const lower = harness(fresh(HEALTHY), { readNoted: async () => ({ ...NOTED_SAFE, address: V3_POT.toLowerCase() as Address }) });
    expect((await runPotTransfer("add_money", args(ADD), lower.d)).ok).toBe(true);
    // Fee money does not ask the record.
    const fee = harness(fresh(HEALTHY), { readNoted: async () => null });
    expect((await runPotTransfer("fee_money", args(FEE), fee.d)).ok).toBe(true);
    expect(fee.calls).not.toContain("noted");
  });

  test("fee money when the click's registry read names a wallet with code is refused before any simulation, with the allowlist's code and the plain key's sentence (Ruling R10)", async () => {
    const h = harness(fresh({ ...HEALTHY, agentHasCode: true }));
    expect(await runPotTransfer("fee_money", args(FEE), h.d)).toEqual({ ok: false, problem: "refused", cause: "fee_money_contract_wallet" });
    expect(h.calls).toEqual(["read"]);
    const ENV = { environment: "sandbox" as const, guardian: G };
    expect(potTransferFailureView({ ok: false, problem: "refused", cause: "fee_money_contract_wallet" }, ENV)).toEqual({
      lines: [potRefusalSentence("fee_money_needs_plain_key", ENV)],
      reread: false,
    });
    // The allowlist says the same of such a context, whatever the runner did.
    const req = potTransferCall(CFG, { ...FEE_CTX, agentHasCode: true }, POT_TRANSFER_GAS_CAP);
    expect(req).toEqual({ ok: false, problem: "fee_money_contract_wallet" });
    // Money for the pot does not depend on the key's code.
    expect((await runPotTransfer("add_money", args(ADD), harness(fresh({ ...HEALTHY, agentHasCode: true })).d)).ok).toBe(true);
  });

  test("Ruling R23 applied to money: fee money pressed on a card that named key A, while the click's registry read names key Q, is refused and the card reads again; the same key in any letter case goes", async () => {
    const moved = harness(fresh(STOPPED, Q));
    expect(await runPotTransfer("fee_money", args(FEE, A), moved.d)).toEqual({ ok: false, problem: "refused", cause: POT_ACTION_MOVED });
    expect(moved.calls).toEqual(["read"]);
    expect(moved.sent).toEqual([]);
    const same = harness(fresh(HEALTHY, A));
    expect(await runPotTransfer("fee_money", args(FEE, A.toLowerCase() as Address), same.d)).toEqual({ ok: true, hash: HASH, agentWallet: A });
    // The transfer goes to the key read in the click, which is the one shown.
    expect(same.sent).toEqual([FEE_CTX]);
  });

  test("a guardian's balance one wei under the amount is not_enough, with the balance and the amount in wei, before the page's checks; at the amount it goes", async () => {
    const under = WEI(ADD) - BigInt(1);
    const add = harness(fresh(HEALTHY, A, under));
    expect(await runPotTransfer("add_money", args(ADD), add.d)).toEqual({ ok: false, problem: "not_enough", balanceWei: under, totalWei: WEI(ADD) });
    expect(add.calls).toEqual(["noted", "read"]);
    const feeUnder = WEI(FEE) - BigInt(1);
    const fee = harness(fresh(HEALTHY, A, feeUnder));
    expect(await runPotTransfer("fee_money", args(FEE), fee.d)).toMatchObject({ ok: false, problem: "not_enough", totalWei: WEI(FEE) });
    expect(fee.calls).toEqual(["read"]);
    expect((await runPotTransfer("add_money", args(ADD), harness(fresh(HEALTHY, A, WEI(ADD))).d)).ok).toBe(true);
    expect(
      potTransferFailureView({ ok: false, problem: "not_enough", balanceWei: under, totalWei: WEI(ADD) }, { environment: "sandbox", guardian: G }).lines,
    ).toEqual([fillCopy(P_.problems.not_enough, { balance: "4.999999999999999999", total: "5" })]);
  });

  test("an amount that is not a positive bigint reads nothing and sends nothing", async () => {
    for (const amount of [ZERO, BigInt(-1), 5 as unknown as bigint]) {
      const h = harness(fresh(HEALTHY));
      expect(await runPotTransfer("add_money", args(amount), h.d), String(amount)).toEqual({ ok: false, problem: "refused" });
      expect(h.calls).toEqual([]);
    }
  });

  test("the page's own checks and the allowlist come before the chain: a refusal is its problem, and nothing is simulated", async () => {
    for (const problem of ["not_this_wallet", "wrong_network", "refused"] as const) {
      const h = harness(fresh(HEALTHY), { preflight: () => ({ ok: false, problem }) });
      expect(await runPotTransfer("fee_money", args(FEE), h.d)).toEqual({ ok: false, problem });
      expect(h.calls).toEqual(["read", "preflight"]);
    }
    // Above the allowlist's bounds: its own code.
    const rich = WEI(USDC(2_000_000_000));
    const add = harness(fresh(HEALTHY, A, rich));
    expect(await runPotTransfer("add_money", args(USDC(1_000_000_000) + BigInt(1)), add.d)).toEqual({ ok: false, problem: "refused", cause: "fund_out_of_bounds" });
    expect(add.calls).toEqual(["noted", "read", "preflight", "check"]);
    const fee = harness(fresh(HEALTHY));
    expect(await runPotTransfer("fee_money", args(USDC(1) + BigInt(1)), fee.d)).toEqual({ ok: false, problem: "refused", cause: "agent_gas_out_of_bounds" });
    expect(fee.calls).toEqual(["read", "preflight", "check"]);
  });

  test("a simulation that does not answer true is would_revert and nothing is sent; one the chain refuses too; one the node could not answer is read_failed", async () => {
    for (const impl of [
      { simulate: async () => `0x${"0".repeat(64)}` as Hex },
      { simulate: async () => "0x" as Hex },
      { simulate: async () => Promise.reject(callRevertError()) },
      { simulate: async () => Promise.reject(revertError()) },
    ] as Partial<PotTransferDeps>[]) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotTransfer("fee_money", args(FEE), h.d)).toMatchObject({ ok: false, problem: "would_revert" });
      expect(h.calls).toEqual(["read", "preflight", "check", "simulate"]);
    }
    const offline = harness(fresh(HEALTHY), { simulate: async () => Promise.reject(offlineError()) });
    expect(await runPotTransfer("fee_money", args(FEE), offline.d)).toMatchObject({ ok: false, problem: "read_failed" });
  });

  test("an estimate above POT_TRANSFER_GAS_CAP, or none, is would_revert; at the cap the limit is the cap", async () => {
    for (const impl of [
      { estimate: async () => POT_TRANSFER_GAS_CAP + BigInt(1) },
      { estimate: async () => ZERO },
      { estimate: async () => Promise.reject(callRevertError("EstimateGasExecutionError")) },
    ] as Partial<PotTransferDeps>[]) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotTransfer("add_money", args(ADD), h.d)).toMatchObject({ ok: false, problem: "would_revert" });
      expect(h.calls).toEqual(["noted", "read", "preflight", "check", "simulate", "estimate"]);
    }
    const atCap = harness(fresh(HEALTHY), { estimate: async () => POT_TRANSFER_GAS_CAP });
    expect((await runPotTransfer("add_money", args(ADD), atCap.d)).ok).toBe(true);
    expect(atCap.calls.at(-1)).toBe(`send ${POT_TRANSFER_GAS_CAP}`);
  });

  test("money short at the simulation or the estimate: the guardian's balance read again, and how much is held and needed said; a balance that cannot be read is read_failed", async () => {
    const short = BigInt("100000000000000");
    for (const at of ["simulate", "estimate"] as const) {
      const h = harness(fresh(HEALTHY), { [at]: async () => Promise.reject(moneyShortError()), readBalance: async () => short });
      expect(await runPotTransfer("add_money", args(ADD), h.d), at).toEqual({ ok: false, problem: "not_enough", balanceWei: short, totalWei: WEI(ADD) });
      expect(h.calls.at(-1), at).toBe("balance");
      expect(h.calls.some((c) => c.startsWith("send")), at).toBe(false);
    }
    const unread = harness(fresh(HEALTHY), {
      simulate: async () => Promise.reject(moneyShortError()),
      readBalance: async () => Promise.reject(offlineError()),
    });
    expect(await runPotTransfer("fee_money", args(FEE), unread.d)).toMatchObject({ ok: false, problem: "read_failed" });
  });

  test("the step's lifetime is asked after every await and right before the send: a person who left gets no wallet prompt", async () => {
    // Add money reads GET /pot first (Ruling R32), then the chain.
    const addCases: [number, string[]][] = [
      [0, ["noted"]],
      [1, ["noted", "read"]],
      [2, ["noted", "read", "preflight", "check", "simulate"]],
      [3, ["noted", "read", "preflight", "check", "simulate", "estimate"]],
      [4, ["noted", "read", "preflight", "check", "simulate", "estimate", "account"]],
    ];
    for (const [n, upTo] of addCases) {
      const h = harness(fresh(HEALTHY), { alive: goneAfter(n) });
      expect(await runPotTransfer("add_money", args(ADD), h.d), String(n)).toEqual({ ok: false, problem: "left" });
      expect(h.calls, String(n)).toEqual(upTo);
    }
    const feeCases: [number, string[]][] = [
      [0, ["read"]],
      [1, ["read", "preflight", "check", "simulate"]],
      [2, ["read", "preflight", "check", "simulate", "estimate"]],
      [3, ["read", "preflight", "check", "simulate", "estimate", "account"]],
    ];
    for (const [n, upTo] of feeCases) {
      const h = harness(fresh(HEALTHY), { alive: goneAfter(n) });
      expect(await runPotTransfer("fee_money", args(FEE), h.d), String(n)).toEqual({ ok: false, problem: "left" });
      expect(h.calls, String(n)).toEqual(upTo);
    }
    // A read, a note or a simulation that threw while the person left is not said either.
    for (const impl of [
      { alive: goneAfter(0), readNoted: async () => Promise.reject(offlineError()) },
      { alive: goneAfter(1), read: async () => Promise.reject(offlineError()) },
      { alive: goneAfter(2), simulate: async () => Promise.reject(callRevertError()) },
      { alive: goneAfter(2), simulate: async () => Promise.reject(moneyShortError()) },
    ] as Partial<PotTransferDeps>[]) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotTransfer("add_money", args(ADD), h.d)).toEqual({ ok: false, problem: "left" });
      expect(h.calls.some((c) => c.startsWith("send"))).toBe(false);
    }
  });

  test("the account connected NOW is read right before the send: a switch refuses with wallet_is_not_the_guardian, and nothing is sent", async () => {
    for (const account of [P, null]) {
      const h = harness(fresh(HEALTHY), { account: () => account });
      expect(await runPotTransfer("fee_money", args(FEE), h.d), String(account)).toEqual({
        ok: false,
        problem: "refused",
        cause: "wallet_is_not_the_guardian",
      });
      expect(h.calls).toEqual(["read", "preflight", "check", "simulate", "estimate", "account"]);
    }
    expect((await runPotTransfer("fee_money", args(FEE), harness(fresh(HEALTHY), { account: () => G.toLowerCase() as Address }).d)).ok).toBe(true);
  });

  test("the send's outcomes, as Create the pot reads them: a refusal of the door, the wallet's no, a fee it cannot pay, a revert, any other throw", async () => {
    const outcomes: [Partial<PotTransferDeps>, object][] = [
      [{ send: async () => ({ ok: false, problem: "wallet_on_another_chain" }) }, { problem: "refused", cause: "wallet_on_another_chain" }],
      [{ send: async () => Promise.reject(rejectedError()) }, { problem: "declined" }],
      [{ send: async () => Promise.reject(moneyShortError("TransactionExecutionError")) }, { problem: "no_gas" }],
      [{ send: async () => Promise.reject(revertError()) }, { problem: "would_revert" }],
      [{ send: async () => Promise.reject(offlineError()) }, { problem: "refused" }],
    ];
    for (const [impl, want] of outcomes) {
      const h = harness(fresh(HEALTHY), impl);
      expect(await runPotTransfer("add_money", args(ADD), h.d)).toMatchObject({ ok: false, ...want });
      expect(h.calls).toEqual(ADD_ALL);
    }
  });
});

describe("after a transfer, and the public record's two actions", () => {
  const ENV = { environment: "sandbox" as const, guardian: G };

  test("potTransferFailureView: every other problem is the actions' own sentence", () => {
    for (const problem of ["read_failed", "agent_wallet", "would_revert", "declined", "no_gas"] as const)
      expect(potTransferFailureView({ ok: false, problem }, ENV), problem).toEqual(potActionFailureView({ ok: false, problem }, ENV));
    expect(potTransferFailureView({ ok: false, problem: "left" }, ENV)).toEqual({ lines: [], reread: false });
    expect(potTransferFailureView({ ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" }, ENV).lines).toEqual([
      fillCopy(P_.problems.not_this_wallet, { address: G }),
    ]);
  });

  test("potTransferDoneView: after Add money the pot's balance as read now; after Send fee money what the key holds, with the low mark's warning", () => {
    expect(potTransferDoneView("add_money", { ...HEALTHY, balanceUnits: USDC(195) })).toEqual({
      ok: true,
      lines: [fillCopy(P_.shownBalance, { balance: "195" })],
    });
    expect(potTransferDoneView("fee_money", { ...HEALTHY, agentBalanceWei: BigInt("200000000000000000") })).toEqual({
      ok: true,
      lines: [fillCopy(P_.shownFeeMoney, { amount: "0.2" })],
    });
    expect(potTransferDoneView("fee_money", { ...HEALTHY, agentBalanceWei: BigInt("1000000000000000") }).lines).toEqual([
      fillCopy(P_.shownFeeMoney, { amount: "0.001" }),
      P_.feeMoneyLow,
    ]);
  });

  test("potRecordFailureView: a retry after a lost answer (pot_not_on_record) reads GET /pot again and shows no failure; pot_exists, pot_pending and pot_taken read again and say the server's sentence", () => {
    const served = (code: string, message = `The server's sentence for ${code}.`) => new ApiError(409, { code, message });
    expect(potRecordFailureView(served("pot_not_on_record"))).toEqual({ lines: [], reread: true });
    for (const code of ["pot_exists", "pot_pending", "pot_taken"])
      expect(potRecordFailureView(served(code)), code).toEqual({ lines: [`The server's sentence for ${code}.`], reread: true });
    expect(potRecordFailureView(served("agent_wallet_required")).reread).toBe(true);
    // Another refusal: its sentence, as served, and nothing read again.
    for (const code of ["rate_limited", "other_deployment", "legal_body_revoked", "pot_not_offered"])
      expect(potRecordFailureView(served(code)), code).toEqual({ lines: [`The server's sentence for ${code}.`], reread: false });
    // A lost answer (no answer the server wrote): the request may have landed, so the sentence
    // claims nothing about the record, and the pot and the record are read again to show it.
    for (const e of [
      new ApiError(0, { code: TIMEOUT_CODE, message: "The request took too long." }),
      new ApiError(502, { code: "http_error", message: "Bad gateway" }),
      new ApiError(409, { code: "pot_exists", message: "  " }),
      new Error("Failed to fetch"),
      undefined,
    ])
      expect(potRecordFailureView(e)).toEqual({ lines: [P_.recordAnswerLost], reread: true });
    expect(P_.recordAnswerLost).not.toMatch(/\{[a-zA-Z]+\}|nothing|changed|sent|taken off|put back/i);
  });
});

describe("Ruling R25: one action at a time on the card", () => {
  test("potCardLockCore: a click takes the card, a second is refused until the first gives it back, and the card hears each change once", () => {
    const heard: boolean[] = [];
    const lock = potCardLockCore((busy) => heard.push(busy));
    expect(lock.held()).toBe(false);
    expect(lock.take()).toBe(true);
    expect(lock.held()).toBe(true);
    expect(lock.take()).toBe(false);
    expect(lock.take()).toBe(false);
    expect(heard).toEqual([true]);
    lock.release();
    expect(lock.held()).toBe(false);
    lock.release();
    expect(heard).toEqual([true, false]);
    expect(lock.take()).toBe(true);
    expect(heard).toEqual([true, false, true]);
  });
});
