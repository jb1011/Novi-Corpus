/**
 * The settlement over the fake node: the pure decision row by row, then `settleCase` with a real
 * JobAdapter, real local signers and a real SQLite case table. The node runs the job contract's
 * rules for `complete`, `reject` and `claimRefund`, so who signed and what the calldata carried
 * are read off what the node accepted.
 */
import Database from "better-sqlite3";
import { type Address, type Hex, decodeFunctionData, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { iErc8183JobAbi } from "../../src/abis/generated";
import { JobAdapter } from "../../src/adapters/arc/jobAdapter";
import { RECEIPT_TIMEOUT_MS } from "../../src/adapters/arc/receipts";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import type { DisputeRead, KlerosDisputeService } from "../../src/adapters/kleros/disputeService";
import { KlerosTransportError } from "../../src/adapters/kleros/errors";
import { FakeDisputeService, type FakeScript } from "../../src/adapters/kleros/fakeDisputeService";
import type { Config } from "../../src/config/env";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../../src/errors";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import { type KlerosStage, type PilotChain, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { type RulingOutcome, pollOnce } from "../../src/pilot/ruling";
import {
  EXPIRY_MARGIN_SECONDS,
  type EscrowState,
  MIN_GAS_WEI,
  REFUND_CLOCK_MARGIN_SECONDS,
  SEND_IN_FLIGHT_SECONDS,
  type SettleDeps,
  decideSettlement,
  decisionTurnsOnRuling,
  reasonFor,
  settleCase,
} from "../../src/pilot/settlement";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import {
  JOB_CONTRACT,
  USDC,
  evaluatorAccount,
  jobClientAccount,
  usdcJobNode,
} from "../helpers/jobFundHarness";

/** anvil's account #3: the seller. The buyer and the referee are the harness's #1 and #2. */
const sellerAccount = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const BUYER = jobClientAccount.address as Address;
const SELLER = sellerAccount.address as Address;
const REFEREE = evaluatorAccount.address as Address;
const BUDGET = 500_000n;
/** The clock in seconds; the job expires a week later. */
const NOW = 1_800_000_000;
const EXPIRES = NOW + 7 * 86_400;
const EXPECTED = { "1": "Pay the provider", "2": "Refund the client" };
const DISPUTE = "287";

beforeEach(() => resetSenderNonces());
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// The decision, row by row
// ---------------------------------------------------------------------------

const escrow = (status: number, expiredAt = EXPIRES): EscrowState => ({
  status,
  budget: BUDGET,
  expiredAt: BigInt(expiredAt),
  client: BUYER,
  evaluator: REFEREE,
});
const PAY: RulingOutcome = { kind: "pay" };
const REFUND: RulingOutcome = { kind: "refund" };
const withId = { coreDisputeId: DISPUTE };

describe("decideSettlement: one test per row of the table", () => {
  test("Completed with any ruling: none, released elsewhere", () => {
    for (const r of [PAY, REFUND, { kind: "pending" } as const])
      expect(decideSettlement(r, escrow(3), NOW, withId)).toEqual({
        action: "none",
        why: "released_elsewhere",
        outcome: "released",
      });
  });

  test("Rejected or Expired with any ruling: none, refunded elsewhere", () => {
    for (const status of [4, 5])
      for (const r of [PAY, REFUND])
        expect(decideSettlement(r, escrow(status), NOW, withId)).toEqual({
          action: "none",
          why: "refunded_elsewhere",
          outcome: "refunded",
        });
  });

  test("Submitted, outside the margin, pay: complete with the case number as the reason", () => {
    expect(decideSettlement(PAY, escrow(2), NOW, withId)).toEqual({
      action: "complete",
      reason: reasonFor(DISPUTE),
      outcome: "released",
    });
  });

  test("Submitted, outside the margin, refund: reject with the case number as the reason", () => {
    expect(decideSettlement(REFUND, escrow(2), NOW, withId)).toEqual({
      action: "reject",
      reason: reasonFor(DISPUTE),
      outcome: "refunded",
    });
  });

  test("Submitted, outside the margin, tied, refused or pending: none, keep polling", () => {
    expect(decideSettlement({ kind: "tied" }, escrow(2), NOW, withId)).toEqual({
      action: "none",
      why: "tied",
    });
    expect(decideSettlement({ kind: "refused" }, escrow(2), NOW, withId)).toEqual({
      action: "none",
      why: "refused",
    });
    expect(decideSettlement({ kind: "pending" }, escrow(2), NOW, withId)).toEqual({
      action: "none",
      why: "ruling_pending",
    });
  });

  test("Submitted or Funded past the expiry and the clock margin, any ruling: claimRefund with no reason", () => {
    const after = EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1;
    for (const status of [1, 2])
      for (const r of [PAY, REFUND, { kind: "pending" } as const, { kind: "tied" } as const])
        expect(decideSettlement(r, escrow(status), after, withId)).toEqual({
          action: "claimRefund",
          reason: null,
          outcome: "refunded",
        });
    // At the expiry second itself the contract still refuses claimRefund.
    expect(decideSettlement(PAY, escrow(2), EXPIRES, withId)).toEqual({
      action: "none",
      why: "too_close_to_expiry",
    });
  });

  test("Submitted 30 seconds past the expiry: no refund yet, the clock margin has not passed", () => {
    expect(REFUND_CLOCK_MARGIN_SECONDS).toBe(60n);
    for (const status of [1, 2])
      expect(decideSettlement(PAY, escrow(status), EXPIRES + 30, withId).action).not.toBe(
        "claimRefund",
      );
    // The margin's last second still waits; the next one refunds.
    expect(decideSettlement(PAY, escrow(2), EXPIRES + 60, withId).action).toBe("none");
    expect(decideSettlement(PAY, escrow(2), EXPIRES + 61, withId).action).toBe("claimRefund");
    expect(() => decideSettlement(PAY, escrow(2), EXPIRES + 30, { claimRefundOnly: true })).toThrow(
      /expires at .*no claimRefund until 60 seconds after that/,
    );
  });

  test("Submitted inside the last ten minutes, pay or refund: none, too close to the expiry", () => {
    const inside = EXPIRES - EXPIRY_MARGIN_SECONDS + 1;
    expect(EXPIRY_MARGIN_SECONDS).toBe(600);
    for (const r of [PAY, REFUND])
      expect(decideSettlement(r, escrow(2), inside, withId)).toEqual({
        action: "none",
        why: "too_close_to_expiry",
      });
    // The margin's edge still sends.
    expect(decideSettlement(PAY, escrow(2), EXPIRES - EXPIRY_MARGIN_SECONDS, withId).action).toBe(
      "complete",
    );
  });

  test("Open with any ruling: none, nothing escrowed", () => {
    expect(decideSettlement(PAY, escrow(0), NOW, withId)).toEqual({
      action: "none",
      why: "nothing_escrowed",
      outcome: "none",
    });
  });

  test("any other status: none, unknown status", () => {
    for (const status of [6, 9])
      expect(decideSettlement(PAY, escrow(status), NOW, withId)).toEqual({
        action: "none",
        why: "unknown_status",
      });
    // Funded before the expiry is not a status the table settles from.
    expect(decideSettlement(PAY, escrow(1), NOW, withId)).toEqual({
      action: "none",
      why: "unknown_status",
    });
  });
});

describe("decideSettlement: the rulings the table does not act on, and the operator's options", () => {
  test("Submitted with an options mismatch, an appeal or an unexpected value: none, each named", () => {
    expect(
      decideSettlement({ kind: "options_mismatch", detail: "x" }, escrow(2), NOW, withId),
    ).toEqual({ action: "none", why: "options_mismatch" });
    expect(
      decideSettlement(
        { kind: "appealed", roundCount: 2, value: "1", tied: false },
        escrow(2),
        NOW,
        withId,
      ),
    ).toEqual({ action: "none", why: "appealed" });
    expect(decideSettlement({ kind: "unexpected", value: "3" }, escrow(2), NOW, withId)).toEqual({
      action: "none",
      why: "unexpected_ruling",
    });
  });

  test("acceptRound acts on an appealed round's value only when it names the round read", () => {
    const appealed = (value: string, tied = false): RulingOutcome => ({
      kind: "appealed",
      roundCount: 2,
      value,
      tied,
    });
    expect(decideSettlement(appealed("1"), escrow(2), NOW, { ...withId, acceptRound: 2 })).toEqual({
      action: "complete",
      reason: reasonFor(DISPUTE),
      outcome: "released",
    });
    expect(
      decideSettlement(appealed("0x02"), escrow(2), NOW, { ...withId, acceptRound: 2 }).action,
    ).toBe("reject");
    expect(decideSettlement(appealed("1"), escrow(2), NOW, { ...withId, acceptRound: 3 })).toEqual({
      action: "none",
      why: "appealed",
    });
    expect(
      decideSettlement(appealed("0", true), escrow(2), NOW, { ...withId, acceptRound: 2 }),
    ).toEqual({ action: "none", why: "tied" });
    expect(decideSettlement(appealed("0"), escrow(2), NOW, { ...withId, acceptRound: 2 })).toEqual({
      action: "none",
      why: "refused",
    });
    expect(decideSettlement(appealed("7"), escrow(2), NOW, { ...withId, acceptRound: 2 })).toEqual({
      action: "none",
      why: "unexpected_ruling",
    });
  });

  test("claimRefundOnly takes the expiry path after the expiry and refuses before it", () => {
    expect(decideSettlement(PAY, escrow(2), EXPIRES + 61, { claimRefundOnly: true })).toEqual({
      action: "claimRefund",
      reason: null,
      outcome: "refunded",
    });
    expect(() => decideSettlement(PAY, escrow(2), NOW, { claimRefundOnly: true })).toThrow(
      /expires at 2027-.*no claimRefund/,
    );
    // A job the chain already settled is reported, not refused.
    expect(decideSettlement(PAY, escrow(3), NOW, { claimRefundOnly: true })).toMatchObject({
      why: "released_elsewhere",
    });
  });
});

test("decisionTurnsOnRuling holds exactly where a pay and a pending ruling decide differently", () => {
  const times = [
    NOW,
    EXPIRES - EXPIRY_MARGIN_SECONDS,
    EXPIRES - EXPIRY_MARGIN_SECONDS + 1,
    EXPIRES,
    EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1,
  ];
  for (const status of [0, 1, 2, 3, 4, 5, 6])
    for (const at of times) {
      const e = escrow(status);
      const differ =
        decideSettlement(PAY, e, at, withId).action !==
        decideSettlement({ kind: "pending" }, e, at, withId).action;
      expect(decisionTurnsOnRuling(e, at)).toBe(differ);
    }
  expect(decisionTurnsOnRuling(escrow(2), NOW)).toBe(true);
});

test("reasonFor writes the dispute id as a 32-byte number", () => {
  expect(reasonFor("287")).toBe(`0x${"00".repeat(30)}011f`);
  expect(reasonFor("287")).toBe(toHex(287n, { size: 32 }));
});

// ---------------------------------------------------------------------------
// settleCase over the fake node
// ---------------------------------------------------------------------------

function setup(
  o: {
    chainStatus?: number;
    expiredAt?: number;
    script?: FakeScript;
    mode?: PilotMode;
    stageMode?: PilotMode;
    revertReject?: boolean;
    revertComplete?: boolean;
    withholdReceipt?: "complete" | "reject" | "claimRefund";
    evaluator?: Address;
    /** The referee's native balance; "unreadable" makes the balance read fail. Default funded. */
    refereeGas?: bigint | "unreadable";
    service?: KlerosDisputeService;
    deployment?: KlerosStage["deployment"];
  } = {},
) {
  const clock = { sec: NOW };
  const node = usdcJobNode({
    usdc: USDC,
    jobContract: JOB_CONTRACT,
    budget: BUDGET,
    now: () => clock.sec,
    answerTransactions: true,
    revertReject: o.revertReject,
    revertComplete: o.revertComplete,
    withholdReceipt: o.withholdReceipt,
    nativeBalanceOf: () => {
      if (o.refereeGas === "unreadable") throw new Error("the node could not read the balance");
      return o.refereeGas ?? 1_000_000_000_000_000_000n;
    },
  });
  node.mint(BUYER, 10_000_000n);
  const expiredAt = o.expiredAt ?? EXPIRES;
  node.seedChainJob({
    id: 7n,
    client: BUYER,
    provider: SELLER,
    evaluator: o.evaluator ?? REFEREE,
    description: "a test job",
    budget: BUDGET,
    expiredAt: BigInt(expiredAt),
    status: o.chainStatus ?? 2,
    hook: "0x0000000000000000000000000000000000000000",
  });
  const db = new Database(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const ctx = {
    cfg: {
      chainId: 31_337,
      usdc: USDC,
      jobContract: JOB_CONTRACT,
      identityRegistry: "0x0000000000000000000000000000000000000005",
      arcExplorerUrl: "https://explorer.example.com",
    } as unknown as Config,
    publicClient: node.publicClient,
    sendClient: node.sendClient,
    wallets: {
      buyer: node.walletFor(jobClientAccount),
      seller: node.walletFor(sellerAccount),
      referee: node.walletFor(evaluatorAccount),
    },
    addresses: { buyer: BUYER, seller: SELLER, referee: REFEREE },
  } as unknown as PilotContext;
  const chain: PilotChain = buildPilotChain(ctx);
  // A short receipt bound, so a withheld receipt is reported in milliseconds.
  chain.job = new JobAdapter({
    publicClient: node.publicClient,
    clientWallet: ctx.wallets.buyer,
    evaluatorWallet: ctx.wallets.referee,
    sendClient: node.sendClient,
    jobContract: JOB_CONTRACT,
    receiptTimeoutMs: 300,
  });
  const fake = new FakeDisputeService({
    script: o.script ?? "pay",
    readsUntilAppeal: 1,
    answerUnknownDisputes: true,
    now: () => clock.sec * 1000,
  });
  const stage: KlerosStage = {
    mode: o.stageMode ?? "rehearsal",
    service: o.service ?? fake,
    deployment: o.deployment ?? null,
    cap: null,
    flag: null,
  };
  const deps: SettleDeps = {
    chain,
    cases,
    stage,
    expected: EXPECTED,
    now: () => clock.sec * 1000,
  };
  return { node, db, cases, fake, stage, deps, clock, expiredAt };
}

type Setup = ReturnType<typeof setup>;

/** A case on job 7 at `status`, seeded by hand: the earlier steps are other modules'. */
function seed(
  s: Setup,
  o: {
    status?: PilotStatus;
    mode?: PilotMode;
    patch?: Partial<PilotCaseRecord>;
    /** Columns the row is inserted with instead of the ones that match the chain's job. */
    insert?: Partial<Parameters<Setup["cases"]["insert"]>[0]>;
  } = {},
): string {
  const caseId = newCaseId();
  s.cases.insert({
    caseId,
    label: "test case 1",
    mode: o.mode ?? "rehearsal",
    chainId: 31_337,
    jobContract: JOB_CONTRACT,
    buyerAddress: BUYER,
    buyerAgentId: "11",
    sellerAddress: SELLER,
    sellerAgentId: "12",
    refereeAddress: REFEREE,
    budgetAtomic: BUDGET.toString(),
    description: "a test job",
    expiredAt: s.expiredAt,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
    ...o.insert,
  });
  s.cases.advance(caseId, "created", o.status ?? "filed", {
    jobId: "7",
    klerosChain: "fake",
    coreDisputeId: DISPUTE,
    ...o.patch,
  });
  return caseId;
}

/** The columns of a stored first-round pay read, taken at the test clock. */
const STORED_PAY: Partial<PilotCaseRecord> = {
  rulingStatus: "Appeal",
  rulingValue: "1",
  rulingTied: 0,
  rulingRoundCount: 1,
  rulingReadAt: NOW,
};

/** A first-round read at Appeal with the expected options and `ruling`. */
function appealRead(ruling: string): DisputeRead {
  return {
    status: "Appeal",
    ruling,
    tied: false,
    ruled: false,
    roundCount: 1,
    rulingOptions: [
      { value: "0x01", title: "Pay the provider" },
      { value: "0x02", title: "Refund the client" },
    ],
    deadline: null,
    unresolvedFields: [],
    raw: null,
  };
}

/** The calls the node accepted, decoded from the transactions it answers, with their signer. */
async function decodedSends(s: Setup) {
  return Promise.all(
    s.node.sends.map(async (send) => {
      const tx = await s.node.publicClient.getTransaction({ hash: send.hash });
      return {
        from: tx.from.toLowerCase(),
        ...decodeFunctionData({ abi: iErc8183JobAbi, data: tx.input }),
      };
    }),
  );
}

describe("settleCase: the three sends", () => {
  test("a pay ruling completes from the referee with the case number in the calldata", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toEqual({
      action: "complete",
      reason: reasonFor(DISPUTE),
      outcome: "released",
    });
    const sends = await decodedSends(s);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      from: REFEREE.toLowerCase(),
      functionName: "complete",
      args: [7n, reasonFor(DISPUTE), "0x"],
    });
    expect(r.txHash).toBe(s.node.sends[0]!.hash);
    expect(s.node.balanceOf(SELLER)).toBe(BUDGET);
    const row = s.cases.find(caseId)!;
    expect(row).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleReason: reasonFor(DISPUTE),
      settleTxHash: r.txHash,
      settledAt: NOW,
      escrowOutcome: "released",
    });
  });

  test("a refund ruling rejects from the referee and the client gets the budget back", async () => {
    const s = setup({ script: "refund" });
    const caseId = seed(s);
    const before = s.node.balanceOf(BUYER);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement.action).toBe("reject");
    expect(await decodedSends(s)).toEqual([
      expect.objectContaining({
        from: REFEREE.toLowerCase(),
        functionName: "reject",
        args: [7n, reasonFor(DISPUTE), "0x"],
      }),
    ]);
    expect(s.node.balanceOf(BUYER)).toBe(before + BUDGET);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settled", escrowOutcome: "refunded" });
  });

  test("after the expiry claimRefund goes out from the referee, whatever the ruling", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    s.clock.sec = EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1;
    const before = s.node.balanceOf(BUYER);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toEqual({ action: "claimRefund", reason: null, outcome: "refunded" });
    expect(await decodedSends(s)).toEqual([
      expect.objectContaining({
        from: REFEREE.toLowerCase(),
        functionName: "claimRefund",
        args: [7n],
      }),
    ]);
    expect(s.node.balanceOf(BUYER)).toBe(before + BUDGET);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "claimRefund",
      settleReason: null,
      escrowOutcome: "refunded",
    });
  });

  test("--claim-refund refuses before the expiry, naming it, and sends nothing", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    await expect(settleCase(s.deps, caseId, { send: true, claimRefundOnly: true })).rejects.toThrow(
      /expires at .*no claimRefund/,
    );
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)!.status).toBe("filed");
  });

  test("the settled line names the case, the mode, the chain, the action, the hash and the dispute", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
    const r = await settleCase(s.deps, caseId, { send: true });
    const settled = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.opslog === "pilot_case_settled");
    expect(settled).toMatchObject({
      caseId,
      mode: "rehearsal",
      klerosChain: "fake",
      action: "complete",
      txHash: r.txHash,
      coreDisputeId: DISPUTE,
    });
  });
});

describe("settleCase: once only", () => {
  test("a second run after the chain settled sends nothing", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: true });
    const again = await settleCase(s.deps, caseId, { send: true });
    expect(again.settlement).toEqual({
      action: "none",
      why: "released_elsewhere",
      outcome: "released",
    });
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)!.status).toBe("settled");
  });

  test("two settles after one success send exactly one transaction across all three calls", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    const first = await settleCase(s.deps, caseId, { send: true });
    expect(first.txHash).toBe(s.node.sends[0]!.hash);
    for (let again = 0; again < 2; again++) {
      const r = await settleCase(s.deps, caseId, { send: true });
      expect(r.settlement.action).toBe("none");
      expect(r.txHash).toBeUndefined();
    }
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settled", settleTxHash: first.txHash });
  });

  test("two settles started together cannot both send: the second finds the row moved and refuses", async () => {
    const s = setup({ script: "pay" });
    // A ruled row with a fresh stored read, so neither run polls and the settle's own move from
    // ruled to settling is the only thing that can stop the second.
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const results = await Promise.allSettled([
      settleCase(s.deps, caseId, { send: true }),
      settleCase(s.deps, caseId, { send: true }),
    ]);
    expect(s.node.sends).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/moved from ruled while this command ran/);
    expect(s.cases.find(caseId)!.status).toBe("settled");
  });

  test("two settles at once on a ruled row: one sends, the other refuses at the settling move", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const results = await Promise.allSettled([
      settleCase(s.deps, caseId, { send: true }),
      settleCase(s.deps, caseId, { send: true }),
    ]);
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(String(refused[0]!.reason)).toMatch(/moved from ruled while this command ran/);
    expect(s.node.sends).toHaveLength(1);
  });

  test("a row another command moves off settling during the send is left where it was put", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const job = s.deps.chain.job;
    const real = job.complete.bind(job);
    job.complete = async (...a: Parameters<typeof job.complete>) => {
      const hash = await real(...a);
      s.cases.advance(caseId, "settling", "failed", { error: "marked failed by another command" });
      return hash;
    };
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(/left settling/);
    expect(s.cases.find(caseId)!.status).toBe("failed");
    expect(s.cases.events(caseId)).toContainEqual(
      expect.objectContaining({ step: "settle", status: "sent", ref: s.node.sends[0]!.hash }),
    );
  });

  test("a second settle while the first transaction has no receipt sees settling with its hash and sends nothing", async () => {
    const s = setup({ script: "pay", withholdReceipt: "complete" });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: true }).catch(() => undefined);
    const hash = s.node.sends[0]!.hash;
    expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: hash });
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(`${hash}.*has no receipt yet`),
    );
    expect(s.node.sends).toHaveLength(1);
  });

  describe("the fake node's complete follows the contract", () => {
    test("a complete from an address that is not the job's evaluator reverts and moves nothing", async () => {
      const s = setup({ script: "pay", evaluator: SELLER });
      const err = await s.deps.chain.job.complete(7n, reasonFor(DISPUTE)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChainTxRevertedError);
      expect(s.node.chainJob(7n)!.status).toBe(2);
      expect(s.node.balanceOf(SELLER)).toBe(0n);
    });

    test.each([[0], [1], [3], [4], [5]])(
      "a complete on a job at status %i reverts and moves nothing",
      async (status) => {
        const s = setup({ script: "pay", chainStatus: status });
        const err = await s.deps.chain.job
          .complete(7n, reasonFor(DISPUTE))
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ChainTxRevertedError);
        expect(s.node.chainJob(7n)!.status).toBe(status);
        expect(s.node.balanceOf(SELLER)).toBe(0n);
      },
    );
  });

  test("a dry run decides and sends nothing, and the row keeps its status", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    const r = await settleCase(s.deps, caseId, { send: false });
    expect(r.settlement.action).toBe("complete");
    expect(r.txHash).toBeUndefined();
    expect(s.node.sends).toEqual([]);
    // Only the ruling read wrote to the row.
    const row = s.cases.find(caseId)!;
    expect(row.status).toBe("ruled");
    expect(row.settleAction).toBeNull();
  });

  test("a reverted reject leaves the row at settling with the hash on the trail, then is re-decided from the chain", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const caseId = seed(s);
    const err = await settleCase(s.deps, caseId, { send: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainTxRevertedError);
    const reverted = (err as ChainTxRevertedError).txHash;
    const row = s.cases.find(caseId)!;
    expect(row).toMatchObject({
      status: "settling",
      settleAction: "reject",
      settleReason: reasonFor(DISPUTE),
      settleTxHash: reverted,
    });
    expect(s.cases.events(caseId)).toContainEqual(
      expect.objectContaining({ step: "settle", status: "reverted", ref: reverted }),
    );
    // The escrow is still Submitted, so the next run decides again and sends again.
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement.action).toBe("reject");
    expect(s.node.hashesOf("reject")).toHaveLength(2);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleTxHash: r.txHash,
      escrowOutcome: "refunded",
    });
  });

  test("a row at settling whose transaction landed is recorded settled with its hash, sending nothing", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: true });
    const hash = s.node.sends[0]!.hash;
    // A crash after the send, before the row's settled write.
    s.cases.advance(caseId, "settled", "settling", { settledAt: null, escrowOutcome: null });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleTxHash: hash,
      escrowOutcome: "released",
    });
  });

  test("a row at settling whose escrow another transaction moved is settled with no hash of ours", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: true }).catch(() => undefined);
    // Somebody else's claimRefund after the expiry.
    s.clock.sec = EXPIRES + 1;
    s.node.chainJob(7n)!.status = 5;
    await settleCase(s.deps, caseId, { send: true });
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleTxHash: null,
      escrowOutcome: "refunded",
    });
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.events(caseId).at(-1)).toMatchObject({
      step: "settle",
      status: "chain",
      ref: null,
    });
    expect(s.cases.events(caseId).at(-1)!.detail).toMatch(/hash of our own send may be unknown/);
  });

  test("a row at settling whose transaction has no receipt yet is refused, and nothing is sent", async () => {
    const s = setup({ script: "pay", withholdReceipt: "complete" });
    const caseId = seed(s);
    const err = await settleCase(s.deps, caseId, { send: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainTxUnconfirmedError);
    const pending = (err as ChainTxUnconfirmedError).txHash;
    expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: pending });
    for (const send of [true, false])
      await expect(settleCase(s.deps, caseId, { send })).rejects.toThrow(
        new RegExp(`${pending}.*wait until it is mined or dropped, then run again`),
      );
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)!.status).toBe("settling");
  });

  test("a row at settling whose transaction then succeeds is recorded settled with that hash, sending nothing", async () => {
    const s = setup({ script: "pay", withholdReceipt: "complete" });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: true }).catch(() => undefined);
    const pending = s.node.sends[0]!.hash;
    s.node.releaseWithheld();
    s.clock.sec = NOW + 60;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleTxHash: pending,
      settledAt: NOW + 60,
      escrowOutcome: "released",
    });
  });

  test("a row at settling with send false reports the chain and writes nothing", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: true }).catch(() => undefined);
    const r = await settleCase(s.deps, caseId, { send: false });
    expect(r.settlement.action).toBe("reject");
    expect(s.cases.find(caseId)!.status).toBe("settling");
    expect(s.node.sends).toHaveLength(1);
  });
});

/** The case's settle events as [status, ref, detail], in the order they were written. */
const settleTrail = (s: Setup, caseId: string) =>
  s.cases
    .events(caseId)
    .filter((e) => e.step === "settle")
    .map((e) => [e.status, e.ref, e.detail]);

describe("settleCase: the hash is written the moment it exists", () => {
  // The settled line goes to stdout; these tests read the row and the trail instead.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("the row holds the hash, with a sent event, before the receipt is waited for", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const atWait: (PilotCaseRecord | undefined)[] = [];
    const wait = s.node.publicClient.waitForTransactionReceipt;
    vi.spyOn(s.node.publicClient, "waitForTransactionReceipt").mockImplementation(async (args) => {
      atWait.push(s.cases.find(caseId));
      return wait(args);
    });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(atWait).toEqual([
      expect.objectContaining({ status: "settling", settleTxHash: r.txHash }),
    ]);
    expect(settleTrail(s, caseId)).toEqual([
      ["sending", null, `complete ${reasonFor(DISPUTE)}`],
      ["sent", r.txHash, "complete"],
      ["ok", r.txHash, "complete"],
    ]);
  });

  test("a transport error during the receipt wait leaves the hash on the row, and the next run reads its receipt first", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    vi.spyOn(s.node.publicClient, "waitForTransactionReceipt").mockRejectedValueOnce(
      new Error("socket hang up"),
    );
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow("socket hang up");
    const hash = s.node.sends[0]!.hash;
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settling",
      settleAction: "complete",
      settleTxHash: hash,
    });
    expect(settleTrail(s, caseId)).toEqual([
      ["sending", null, `complete ${reasonFor(DISPUTE)}`],
      ["sent", hash, "complete"],
      ["failed", hash, "socket hang up"],
    ]);
    // The transaction was mined: the next run finds its receipt and records it, sending nothing.
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleTxHash: hash,
      escrowOutcome: "released",
    });
  });

  test("a row another command moved off settling before the broadcast keeps the hash on its trail, and the hook does not throw", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const job = s.deps.chain.job;
    const real = job.complete.bind(job);
    job.complete = async (...a: Parameters<typeof job.complete>) => {
      s.cases.advance(caseId, "settling", "failed", { error: "marked failed by another command" });
      return real(...a);
    };
    // The send succeeds, so what stops the run is the settled write, not the hook.
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(/left settling/);
    const hash = s.node.sends[0]!.hash;
    expect(s.cases.find(caseId)).toMatchObject({ status: "failed", settleTxHash: null });
    expect(settleTrail(s, caseId)).toEqual([
      ["sending", null, `complete ${reasonFor(DISPUTE)}`],
      ["sent", hash, "complete"],
      ["sent", hash, "complete succeeded after the row left settling"],
    ]);
  });

  test("a hook whose write fails is reported, and the hash is written with the failure", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const record = s.cases.recordEvent.bind(s.cases);
    let refused = false;
    vi.spyOn(s.cases, "recordEvent").mockImplementation((id, step, status, ref, detail) => {
      if (step === "settle" && status === "sent" && !refused) {
        refused = true;
        throw new Error("database is locked");
      }
      record(id, step, status, ref, detail);
    });
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow("database is locked");
    const hash = s.node.sends[0]!.hash;
    // The hook's transaction rolled back as a whole; the failure's own record wrote the hash.
    expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: hash });
    expect(settleTrail(s, caseId)).toEqual([
      ["sending", null, `complete ${reasonFor(DISPUTE)}`],
      ["failed", hash, "database is locked"],
    ]);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settled", settleTxHash: hash });
  });

  test.each<["reject" | "claimRefund"]>([["reject"], ["claimRefund"]])(
    "a %s writes its hash before the receipt wait too",
    async (action) => {
      const s = setup({ script: action === "reject" ? "refund" : "pay" });
      const caseId = seed(s, {
        status: "ruled",
        patch: { ...STORED_PAY, rulingValue: action === "reject" ? "2" : "1" },
      });
      if (action === "claimRefund") s.clock.sec = EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1;
      vi.spyOn(s.node.publicClient, "waitForTransactionReceipt").mockRejectedValueOnce(
        new Error("socket hang up"),
      );
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow("socket hang up");
      const hash = s.node.sends[0]!.hash;
      expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: hash });
      expect(settleTrail(s, caseId)).toContainEqual(["sent", hash, action]);
    },
  );
});

/** A settling row on job 7 that chose `complete` and holds no hash: a send that stopped before
 *  its hash was written, or one that may still be running. */
function seedSettlingNoHash(s: Setup, o: Parameters<typeof seed>[1] = {}): string {
  return seed(s, {
    ...o,
    status: "settling",
    patch: {
      ...STORED_PAY,
      settleAction: "complete",
      settleReason: reasonFor(DISPUTE),
      ...o.patch,
    },
  });
}

/** A settle/sending event on the case, stamped `secondsAgo` before the settle's clock in the
 *  database's own format, or with `stamp` as given. */
function sendingEvent(s: Setup, caseId: string, secondsAgo: number, stamp?: string): void {
  s.cases.recordEvent(caseId, "settle", "sending", null, `complete ${reasonFor(DISPUTE)}`);
  s.db
    .prepare(
      "UPDATE pilot_case_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM pilot_case_events WHERE case_id = ?)",
    )
    .run(stamp ?? sqliteUtcTimestamp((s.clock.sec - secondsAgo) * 1000), caseId);
}

describe("settleCase: a send that may still be running is never sent again", () => {
  // The settled line goes to stdout; these tests read the row and the trail instead.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("the window is the receipt wait and two minutes more", () => {
    expect(SEND_IN_FLIGHT_SECONDS).toBe(RECEIPT_TIMEOUT_MS / 1000 + 120);
    expect(SEND_IN_FLIGHT_SECONDS).toBe(180);
  });

  test("a settling row with no hash whose send started inside the window is refused with zero reads and zero sends", async () => {
    const reads: unknown[] = [];
    const service = {
      deployment: "testnet",
      getDispute: async (p: unknown): Promise<DisputeRead> => {
        reads.push(p);
        return appealRead("1");
      },
    } as unknown as KlerosDisputeService;
    const s = setup({ service, stageMode: "testnet", deployment: deploymentFor("testnet") });
    // A stale stored read on a real deployment: a run that went on would read Kleros.
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { klerosChain: "arbitrum-sepolia-testnet", rulingReadAt: NOW - 3600 },
    });
    sendingEvent(s, caseId, 30);
    const chainReads = [
      vi.spyOn(s.deps.chain.publicClient, "getChainId"),
      vi.spyOn(s.deps.chain.publicClient, "getTransactionReceipt"),
      vi.spyOn(s.deps.chain.publicClient, "getBalance"),
      vi.spyOn(s.deps.chain.job, "escrowState"),
    ];
    for (const send of [true, false])
      await expect(settleCase(s.deps, caseId, { send })).rejects.toThrow(
        new RegExp(
          `^refusing: a settle may still be running on case ${caseId}: its send started 30 s ago, and a send is treated as running for 180 s; wait, then run again; nothing was sent$`,
        ),
      );
    expect(reads).toEqual([]);
    for (const spy of chainReads) expect(spy).not.toHaveBeenCalled();
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });
  });

  test("the window's last second still refuses, and the next one decides again from the chain", async () => {
    const s = setup({ script: "pay" });
    const caseId = seedSettlingNoHash(s);
    sendingEvent(s, caseId, SEND_IN_FLIGHT_SECONDS - 1);
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      /a settle may still be running on case .*: its send started 179 s ago/,
    );
    expect(s.node.sends).toEqual([]);
    s.clock.sec += 1;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement.action).toBe("complete");
    expect(s.node.sends).toHaveLength(1);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settled", settleTxHash: r.txHash });
  });

  test("the latest send is the one measured: an old attempt then a recent one is refused", async () => {
    const s = setup({ script: "pay" });
    const caseId = seedSettlingNoHash(s);
    sendingEvent(s, caseId, 3600);
    sendingEvent(s, caseId, 60);
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      /a settle may still be running on case .*: its send started 60 s ago/,
    );
    expect(s.node.sends).toEqual([]);
  });

  test("a send whose start time cannot be read is refused, since an unknown age never lets a second send through", async () => {
    const s = setup({ script: "pay" });
    const caseId = seedSettlingNoHash(s);
    sendingEvent(s, caseId, 0, "not a time");
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(
        `a settle may still be running on case ${caseId}: the time its send started cannot be read; .*nothing was sent`,
      ),
    );
    expect(s.node.sends).toEqual([]);
  });

  test("a settling row with no hash and no send on its trail is decided again from the chain", async () => {
    const s = setup({ script: "pay" });
    const caseId = seedSettlingNoHash(s);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement.action).toBe("complete");
    expect(s.node.sends).toHaveLength(1);
  });

  test("two settles at once on a settling row with no hash and an old send: exactly one sends", async () => {
    const s = setup({ script: "pay" });
    // The settle's clock follows the database's here: each run's sending event is stamped by the
    // database, and the run that moves second measures the first one's against this clock.
    s.clock.sec = Math.floor(Date.now() / 1000);
    const caseId = seedSettlingNoHash(s);
    sendingEvent(s, caseId, 3600);
    const results = await Promise.allSettled([
      settleCase(s.deps, caseId, { send: true }),
      settleCase(s.deps, caseId, { send: true }),
    ]);
    expect(s.node.sends).toHaveLength(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(
      new RegExp(`a settle may still be running on case ${caseId}: its send started -?\\d+ s ago`),
    );
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleTxHash: s.node.sends[0]!.hash,
    });
  });

  test("a re-send after a reverted receipt is not held by the window: the revert ended that send", async () => {
    const s = setup({ script: "refund", revertReject: true });
    // On the database's clock, so the reverted run's own sending event is seconds old.
    s.clock.sec = Math.floor(Date.now() / 1000);
    const caseId = seed(s);
    const err = await settleCase(s.deps, caseId, { send: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainTxRevertedError);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement.action).toBe("reject");
    expect(s.node.hashesOf("reject")).toHaveLength(2);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settled", settleTxHash: r.txHash });
  });
});

/** A refund case whose first reject reverted: at settling, holding the reverted hash. */
async function revertedRow(s: Setup): Promise<{ caseId: string; reverted: Hex }> {
  const caseId = seed(s);
  const err = await settleCase(s.deps, caseId, { send: true }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChainTxRevertedError);
  const reverted = (err as ChainTxRevertedError).txHash as Hex;
  expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: reverted });
  return { caseId, reverted };
}

/** A hash another run's broadcast wrote on the row. */
const OTHER_RUNS_HASH = `0x${"cd".repeat(32)}` as Hex;

describe("settleCase: a settling row whose hash reverted is sent on once", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("two settles at once on it send one new transaction, and the row holds the sending run's hash", async () => {
    const s = setup({ script: "refund", revertReject: true });
    // On the database's clock, as for the race on a row with no hash: the run that moves second
    // measures the first one's sending event against this clock.
    s.clock.sec = Math.floor(Date.now() / 1000);
    const { caseId } = await revertedRow(s);
    const results = await Promise.allSettled([
      settleCase(s.deps, caseId, { send: true }),
      settleCase(s.deps, caseId, { send: true }),
    ]);
    expect(s.node.hashesOf("reject")).toHaveLength(2);
    const sent = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof settleCase>>
    >[];
    expect(sent).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(
      new RegExp(
        `(a settle may still be running on case ${caseId}|pilot case ${caseId} moved while this command ran).*; nothing was sent$`,
      ),
    );
    expect(s.node.hashesOf("reject")[1]).toBe(sent[0]!.value.txHash);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleTxHash: sent[0]!.value.txHash,
    });
  });

  test("a hash written on the row between this run's read and its move refuses: the row moved", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const { caseId, reverted } = await revertedRow(s);
    const job = s.deps.chain.job;
    const real = job.escrowState.bind(job);
    job.escrowState = async (...a: Parameters<typeof job.escrowState>) => {
      const state = await real(...a);
      s.cases.patch(caseId, { settleTxHash: OTHER_RUNS_HASH });
      return state;
    };
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(
        `^refusing: pilot case ${caseId} moved while this command ran: its transaction hash is not the one this run read; nothing was sent$`,
      ),
    );
    expect(s.node.hashesOf("reject")).toEqual([reverted]);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settling",
      settleTxHash: OTHER_RUNS_HASH,
    });
  });

  test("another run's send with no outcome yet holds a re-send before any read, until the window passes", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const { caseId } = await revertedRow(s);
    sendingEvent(s, caseId, 30);
    const reads = [
      vi.spyOn(s.deps.chain.publicClient, "getTransactionReceipt"),
      vi.spyOn(s.deps.chain.job, "escrowState"),
    ];
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(
        `^refusing: a settle may still be running on case ${caseId}: its send started 30 s ago, .*; nothing was sent$`,
      ),
    );
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    expect(s.node.hashesOf("reject")).toHaveLength(1);
    s.clock.sec += SEND_IN_FLIGHT_SECONDS;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement.action).toBe("reject");
    expect(s.node.hashesOf("reject")).toHaveLength(2);
  });

  test("another run's send recorded while this one read is caught inside the move", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const { caseId, reverted } = await revertedRow(s);
    const job = s.deps.chain.job;
    const real = job.escrowState.bind(job);
    job.escrowState = async (...a: Parameters<typeof job.escrowState>) => {
      const state = await real(...a);
      sendingEvent(s, caseId, 0);
      return state;
    };
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(
        `^refusing: a settle may still be running on case ${caseId}: its send started 0 s ago`,
      ),
    );
    expect(s.node.hashesOf("reject")).toEqual([reverted]);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: reverted });
  });

  test("the hook does not write over a hash another run wrote, and keeps its own on the trail", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const { caseId } = await revertedRow(s);
    const job = s.deps.chain.job;
    const real = job.reject.bind(job);
    job.reject = async (...a: Parameters<typeof job.reject>) => {
      s.cases.patch(caseId, { settleTxHash: OTHER_RUNS_HASH });
      return real(...a);
    };
    const atWait: (string | null | undefined)[] = [];
    const wait = s.node.publicClient.waitForTransactionReceipt;
    vi.spyOn(s.node.publicClient, "waitForTransactionReceipt").mockImplementation(async (args) => {
      atWait.push(s.cases.find(caseId)?.settleTxHash);
      return wait(args);
    });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(atWait).toEqual([OTHER_RUNS_HASH]);
    expect(settleTrail(s, caseId)).toContainEqual(["sent", r.txHash, "reject"]);
  });

  test("the failure's own record does not write over a hash another run wrote", async () => {
    const s = setup({ script: "refund", revertReject: true });
    const { caseId } = await revertedRow(s);
    const job = s.deps.chain.job;
    const real = job.reject.bind(job);
    job.reject = async (...a: Parameters<typeof job.reject>) => {
      s.cases.patch(caseId, { settleTxHash: OTHER_RUNS_HASH });
      return real(...a);
    };
    vi.spyOn(s.node.publicClient, "waitForTransactionReceipt").mockRejectedValueOnce(
      new Error("socket hang up"),
    );
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow("socket hang up");
    const mine = s.node.hashesOf("reject")[1]!;
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settling",
      settleTxHash: OTHER_RUNS_HASH,
    });
    expect(settleTrail(s, caseId)).toContainEqual(["sent", mine, "reject"]);
    expect(settleTrail(s, caseId)).toContainEqual(["failed", mine, "socket hang up"]);
  });
});

/** A testnet stage whose Dispute Service answers every read with `answer`, and the reads. */
function testnetStage(
  answer: () => DisputeRead,
  o: Parameters<typeof setup>[0] = {},
): { s: Setup; reads: { chain: string; coreDisputeId: string }[] } {
  const reads: { chain: string; coreDisputeId: string }[] = [];
  const service = {
    deployment: "testnet",
    getDispute: async (p: { chain: string; coreDisputeId: string }): Promise<DisputeRead> => {
      reads.push(p);
      return answer();
    },
  } as unknown as KlerosDisputeService;
  const s = setup({ ...o, service, stageMode: "testnet", deployment: deploymentFor("testnet") });
  return { s, reads };
}

/** A testnet case's dispute, its stored read an hour old. */
const TESTNET_STALE: Partial<PilotCaseRecord> = {
  klerosChain: "arbitrum-sepolia-testnet",
  rulingReadAt: NOW - 3600,
};

/** The ruling columns, which a read taken before a re-send never writes. */
const rulingColumns = (row: PilotCaseRecord) => ({
  rulingStatus: row.rulingStatus,
  rulingValue: row.rulingValue,
  rulingTied: row.rulingTied,
  rulingRoundCount: row.rulingRoundCount,
  rulingLabel: row.rulingLabel,
  rulingReadAt: row.rulingReadAt,
  rulingDeadline: row.rulingDeadline,
});

describe("settleCase: a re-send on a real deployment reads Kleros again", () => {
  // The settled line goes to stdout; these tests read the row and the trail instead.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  test("a settling row with no hash and a stale read is read on its own chain, and a refund read sends reject in place of the stored complete", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"));
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    const before = s.cases.find(caseId)!;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([{ chain: "arbitrum-sepolia-testnet", coreDisputeId: DISPUTE }]);
    expect(r.settlement).toEqual({
      action: "reject",
      reason: reasonFor(DISPUTE),
      outcome: "refunded",
    });
    expect(await decodedSends(s)).toEqual([
      expect.objectContaining({ from: REFEREE.toLowerCase(), functionName: "reject" }),
    ]);
    const row = s.cases.find(caseId)!;
    expect(row).toMatchObject({
      status: "settled",
      settleAction: "reject",
      settleReason: reasonFor(DISPUTE),
      escrowOutcome: "refunded",
    });
    expect(rulingColumns(row)).toEqual(rulingColumns(before));
    expect(settleTrail(s, caseId)).toEqual([
      ["reread", DISPUTE, "refund"],
      ["sending", null, `reject ${reasonFor(DISPUTE)}`],
      ["sent", r.txHash, "reject"],
      ["ok", r.txHash, "reject"],
    ]);
  });

  test("a settling row whose hash reverted is read again before the re-send", async () => {
    const { s, reads } = testnetStage(() => appealRead("1"), { revertReject: true });
    const reverted = (await s.deps.chain.job
      .reject(7n, reasonFor(DISPUTE), s.deps.chain.wallets.referee)
      .catch((e: unknown) => e)) as ChainTxRevertedError;
    expect(reverted).toBeInstanceOf(ChainTxRevertedError);
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, settleAction: "reject", settleTxHash: reverted.txHash },
    });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toHaveLength(1);
    expect(r.settlement.action).toBe("complete");
    expect(s.node.hashesOf("complete")).toEqual([r.txHash]);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleTxHash: r.txHash,
    });
  });

  test.each<[string, number | null]>([
    ["never taken", null],
    ["taken ten minutes ago", NOW - 600],
  ])("a settling row whose stored read was %s is read again", async (_name, readAt) => {
    const { s, reads } = testnetStage(() => appealRead("1"));
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, rulingReadAt: readAt },
    });
    await settleCase(s.deps, caseId, { send: true });
    expect(reads).toHaveLength(1);
  });

  test("a settling row read under ten minutes ago is decided from its action, with no read", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"));
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, rulingReadAt: NOW - 599 },
    });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement.action).toBe("complete");
  });

  const swapped = [
    { value: "0x01", title: "Refund the client" },
    { value: "0x02", title: "Pay the provider" },
  ];
  test.each<[string, DisputeRead, string]>([
    ["pending", { ...appealRead("0"), status: "Vote", tied: true }, "pending"],
    ["tied", { ...appealRead("0"), tied: true }, "tied"],
    ["refused", appealRead("0"), "refused"],
    ["appealed", { ...appealRead("2"), roundCount: 2 }, "appealed \\(round 2\\)"],
    ["options_mismatch", { ...appealRead("1"), rulingOptions: swapped }, "options_mismatch"],
    ["unexpected", appealRead("7"), "unexpected"],
  ])("a read that is %s refuses, naming it, and nothing is sent", async (kind, read, named) => {
    const { s, reads } = testnetStage(() => read);
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    for (const send of [true, false])
      await expect(settleCase(s.deps, caseId, { send })).rejects.toThrow(
        new RegExp(
          `^refusing: case ${caseId}'s ruling, read again before a new send, is ${named}, not a pay or a refund to act on; nothing was sent$`,
        ),
      );
    expect(reads).toHaveLength(2);
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settling",
      settleAction: "complete",
      settleTxHash: null,
    });
    expect(settleTrail(s, caseId)).toEqual([
      ["reread", DISPUTE, kind],
      ["reread", DISPUTE, kind],
    ]);
  });

  test("an appealed round read again is acted on when the run accepts that round", async () => {
    const { s } = testnetStage(() => ({ ...appealRead("2"), roundCount: 2 }));
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    const r = await settleCase(s.deps, caseId, { send: true, acceptRound: 2 });
    expect(r.settlement.action).toBe("reject");
    expect(s.node.hashesOf("reject")).toEqual([r.txHash]);
  });

  test("a failed read refuses in the service's redacted words, and nothing is sent", async () => {
    const { s } = testnetStage(() => {
      throw new KlerosTransportError(
        "dispute_get failed at https://kleros.example.com/v1/mcp?apiKey=SENTINELKEY after 3 tries",
      );
    });
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    const err = await settleCase(s.deps, caseId, { send: true }).catch((e: unknown) => e);
    expect(String(err)).toBe(
      `Error: refusing: case ${caseId}'s ruling could not be read again before a new send: dispute_get failed at https://kleros.example.com after 3 tries; nothing was sent`,
    );
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });
    expect(settleTrail(s, caseId)).toEqual([]);
  });

  test("a stored claimRefund needs no read: the expiry path does not depend on the ruling", async () => {
    const { s, reads } = testnetStage(() => appealRead("1"));
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, settleAction: "claimRefund", settleReason: null },
    });
    s.clock.sec = EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement.action).toBe("claimRefund");
    expect(s.node.hashesOf("claimRefund")).toEqual([r.txHash]);
  });

  test("--claim-refund on a settling row reads nothing either", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"));
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    s.clock.sec = EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1;
    const r = await settleCase(s.deps, caseId, { send: true, claimRefundOnly: true });
    expect(reads).toEqual([]);
    expect(r.settlement.action).toBe("claimRefund");
  });

  test("a rehearsal settling row keeps the action it chose, however old its read", async () => {
    const s = setup({ script: "refund" });
    const caseId = seedSettlingNoHash(s, { patch: { rulingReadAt: NOW - 3600 } });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(s.fake.calls).toEqual([]);
    expect(r.settlement.action).toBe("complete");
  });

  test("a settling row whose hash landed reads nothing and is recorded settled", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"));
    const landed = await s.deps.chain.job.complete(7n, reasonFor(DISPUTE));
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, settleTxHash: landed },
    });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleTxHash: landed,
    });
  });

  test("a settled row reads nothing", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"), { chainStatus: 3 });
    const caseId = seed(s, {
      mode: "testnet",
      status: "settled",
      patch: {
        ...STORED_PAY,
        ...TESTNET_STALE,
        settleAction: "complete",
        settleReason: reasonFor(DISPUTE),
      },
    });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
  });

  test("a Kleros outage on a settling row whose escrow the chain settled still records the chain's outcome", async () => {
    const { s, reads } = testnetStage(
      () => {
        throw new KlerosTransportError("dispute_get failed after 3 tries");
      },
      { chainStatus: 3 },
    );
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleTxHash: null,
    });
  });

  test("past the expiry a stale settling row takes the expiry path with no Kleros read", async () => {
    const { s, reads } = testnetStage(() => {
      throw new KlerosTransportError("dispute_get failed after 3 tries");
    });
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    s.clock.sec = EXPIRES + Number(REFUND_CLOCK_MARGIN_SECONDS) + 1;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement.action).toBe("claimRefund");
    expect(s.node.hashesOf("claimRefund")).toEqual([r.txHash]);
  });

  test("inside the expiry's last ten minutes nothing is read and nothing is sent", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"));
    const caseId = seedSettlingNoHash(s, { mode: "testnet", patch: TESTNET_STALE });
    s.clock.sec = EXPIRES - EXPIRY_MARGIN_SECONDS + 1;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(reads).toEqual([]);
    expect(r.settlement).toEqual({ action: "none", why: "too_close_to_expiry" });
    expect(s.node.sends).toEqual([]);
  });

  test("a row whose dispute is on another Kleros chain than the stage reads is refused before the read, though the service would answer", async () => {
    const { s, reads } = testnetStage(() => appealRead("2"));
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, klerosChain: "arbitrum-one" },
    });
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(
        `^refusing: case ${caseId}'s dispute is on arbitrum-one and this stage reads arbitrum-sepolia-testnet; nothing was sent$`,
      ),
    );
    expect(reads).toEqual([]);
    expect(s.node.sends).toEqual([]);
  });

  test.each<[string, Partial<PilotCaseRecord>]>([
    ["Kleros chain", { klerosChain: null }],
    ["dispute id", { coreDisputeId: null }],
  ])("a settling row with no %s is refused before a re-send", async (_name, missing) => {
    const { s, reads } = testnetStage(() => appealRead("1"));
    const caseId = seedSettlingNoHash(s, {
      mode: "testnet",
      patch: { ...TESTNET_STALE, ...missing },
    });
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(
        `^refusing: case ${caseId} has no Kleros chain or dispute id to read its ruling again before a new send; nothing was sent$`,
      ),
    );
    expect(reads).toEqual([]);
    expect(s.node.sends).toEqual([]);
  });
});

describe("settleCase: an escrow the chain settled keeps the action the chain agrees with", () => {
  // The settled line goes to stdout; these tests read the row and the trail instead.
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  const ELSEWHERE_NOTE = (name: string) =>
    `the chain shows the job ${name}, moved by a transaction whose hash this row does not hold; the hash of our own send may be unknown`;

  test.each<["complete" | "reject" | "claimRefund", number, string]>([
    ["complete", 3, "Completed"],
    ["reject", 4, "Rejected"],
    ["claimRefund", 5, "Expired"],
  ])(
    "a settling row that chose %s, holding no hash, on a job at status %i keeps its action",
    async (action, status, name) => {
      const s = setup({ script: "pay", chainStatus: status });
      const caseId = seedSettlingNoHash(s, {
        patch: {
          settleAction: action,
          settleReason: action === "claimRefund" ? null : reasonFor(DISPUTE),
        },
      });
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
      const r = await settleCase(s.deps, caseId, { send: true });
      expect(r.settlement.action).toBe("none");
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)).toMatchObject({
        status: "settled",
        settleAction: action,
        settleTxHash: null,
      });
      expect(s.cases.events(caseId).at(-1)).toMatchObject({
        step: "settle",
        status: "chain",
        ref: null,
        detail: ELSEWHERE_NOTE(name),
      });
      const settled = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((l) => l.opslog === "pilot_case_settled");
      expect(settled).toMatchObject({ caseId, action, txHash: null });
    },
  );

  test.each<["complete" | "reject" | "claimRefund", number]>([
    ["complete", 4],
    ["complete", 5],
    ["reject", 3],
    ["reject", 5],
    ["claimRefund", 3],
    ["claimRefund", 4],
  ])(
    "a settling row that chose %s, on a job at status %i, is recorded with no action of ours",
    async (action, status) => {
      const s = setup({ script: "pay", chainStatus: status });
      const caseId = seedSettlingNoHash(s, {
        patch: {
          settleAction: action,
          settleReason: action === "claimRefund" ? null : reasonFor(DISPUTE),
        },
      });
      await settleCase(s.deps, caseId, { send: true });
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)).toMatchObject({
        status: "settled",
        settleAction: "none",
        settleTxHash: null,
      });
      expect(s.cases.events(caseId).at(-1)!.detail).toMatch(/hash of our own send may be unknown/);
    },
  );

  test("a row that chose no action is recorded with none, as before", async () => {
    const s = setup({ script: "pay", chainStatus: 3 });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    await settleCase(s.deps, caseId, { send: true });
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "none",
      settleTxHash: null,
      escrowOutcome: "released",
    });
  });
});

describe("settleCase: refusals and the ruling read", () => {
  test("a row of another mode is refused with zero reads and zero sends", async () => {
    const s = setup({ stageMode: "testnet" });
    const caseId = seed(s, { mode: "rehearsal" });
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      /rehearsal case and this stage is testnet/,
    );
    expect(s.node.sends).toEqual([]);
    expect(s.fake.calls).toEqual([]);
    // A row at settling skips the ruling read, so only the mode check stands before the send.
    const t = setup({ stageMode: "testnet" });
    const settling = seed(t, {
      mode: "rehearsal",
      status: "settling",
      patch: { settleAction: "reject", settleReason: reasonFor(DISPUTE) },
    });
    await expect(settleCase(t.deps, settling, { send: true })).rejects.toThrow(
      /rehearsal case and this stage is testnet/,
    );
    expect(t.node.sends).toEqual([]);
  });

  test("the ruling re-read names the row's chain and dispute id", async () => {
    const reads: { chain: string; coreDisputeId: string }[] = [];
    const service = {
      deployment: "testnet",
      getDispute: async (p: { chain: string; coreDisputeId: string }): Promise<DisputeRead> => {
        reads.push(p);
        return {
          status: "Appeal",
          ruling: "1",
          tied: false,
          ruled: false,
          roundCount: 1,
          rulingOptions: [
            { value: "0x01", title: "Pay the provider" },
            { value: "0x02", title: "Refund the client" },
          ],
          deadline: null,
          unresolvedFields: [],
          raw: null,
        };
      },
    } as unknown as KlerosDisputeService;
    const s = setup({ service, stageMode: "rehearsal" });
    const caseId = seed(s);
    await settleCase(s.deps, caseId, { send: false });
    expect(reads).toEqual([{ chain: "fake", coreDisputeId: DISPUTE }]);
  });

  test("a ruled row read less than ten minutes ago is decided from the row, with no read", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, {
      status: "ruled",
      patch: { rulingValue: "2", rulingTied: 0, rulingRoundCount: 1, rulingReadAt: NOW - 599 },
    });
    const r = await settleCase(s.deps, caseId, { send: false });
    expect(r.settlement.action).toBe("reject");
    expect(s.fake.calls).toEqual([]);
  });

  test("a rehearsal row is decided from its stored read however old, since the fake cannot read it again", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, {
      status: "ruled",
      patch: { rulingValue: "2", rulingTied: 0, rulingRoundCount: 1, rulingReadAt: NOW - 3600 },
    });
    const r = await settleCase(s.deps, caseId, { send: false });
    expect(r.settlement.action).toBe("reject");
    expect(s.fake.calls).toEqual([]);
  });

  test("a rehearsal row whose stored read is pending is not read again, and waits", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, {
      patch: {
        rulingStatus: "Vote",
        rulingValue: "0",
        rulingTied: 1,
        rulingRoundCount: 1,
        rulingReadAt: NOW - 3600,
      },
    });
    const r = await settleCase(s.deps, caseId, { send: false });
    expect(r.settlement).toEqual({ action: "none", why: "ruling_pending" });
    expect(s.fake.calls).toEqual([]);
  });

  test.each<[PilotStatus]>([["filed"], ["evidence_unknown"]])(
    "a rehearsal row at %s holding a verdict that did not rule the case sends nothing",
    async (status) => {
      // What an options mismatch leaves: an Appeal read with a value, and the row not ruled.
      const s = setup({ script: "pay" });
      const caseId = seed(s, {
        status,
        patch: {
          rulingStatus: "Appeal",
          rulingValue: "1",
          rulingTied: 0,
          rulingRoundCount: 1,
          rulingReadAt: NOW - 60,
        },
      });
      for (let run = 0; run < 2; run++) {
        const r = await settleCase(s.deps, caseId, { send: true });
        expect(r.settlement).toEqual({ action: "none", why: "options_mismatch" });
      }
      expect(s.node.sends).toEqual([]);
      expect(s.fake.calls).toEqual([]);
      expect(s.cases.find(caseId)!.status).toBe(status);
    },
  );

  test("a testnet ruled pay row whose re-read showed an appeal settles nothing within ten minutes", async () => {
    let next = appealRead("1");
    const service = {
      deployment: "testnet",
      getDispute: async (): Promise<DisputeRead> => next,
    } as unknown as KlerosDisputeService;
    const s = setup({ service, stageMode: "testnet", deployment: deploymentFor("testnet") });
    const caseId = seed(s, {
      mode: "testnet",
      patch: { klerosChain: "arbitrum-sepolia-testnet" },
    });
    const poll = {
      stage: s.stage,
      cases: s.cases,
      expected: EXPECTED,
      now: () => s.clock.sec * 1000,
    };
    await pollOnce(poll, caseId);
    expect(s.cases.find(caseId)!.status).toBe("ruled");
    next = { ...appealRead("2"), roundCount: 2 };
    s.clock.sec += 60;
    await pollOnce(poll, caseId);
    s.clock.sec += 60;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toEqual({ action: "none", why: "appealed" });
    expect(s.node.sends).toEqual([]);
  });

  test("a testnet ruled pay row whose re-read showed an appeal with unresolved options settles nothing within ten minutes", async () => {
    let next = appealRead("1");
    const service = {
      deployment: "testnet",
      getDispute: async (): Promise<DisputeRead> => next,
    } as unknown as KlerosDisputeService;
    const s = setup({ service, stageMode: "testnet", deployment: deploymentFor("testnet") });
    const caseId = seed(s, {
      mode: "testnet",
      patch: { klerosChain: "arbitrum-sepolia-testnet" },
    });
    const poll = {
      stage: s.stage,
      cases: s.cases,
      expected: EXPECTED,
      now: () => s.clock.sec * 1000,
    };
    await pollOnce(poll, caseId);
    expect(s.cases.find(caseId)!.rulingValue).toBe("1");
    next = {
      ...appealRead("2"),
      roundCount: 2,
      rulingOptions: [],
      unresolvedFields: ["rulingOptions"],
    };
    s.clock.sec += 60;
    await pollOnce(poll, caseId);
    expect(s.cases.find(caseId)!.rulingRoundCount).toBe(2);
    s.clock.sec += 60;
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toEqual({ action: "none", why: "appealed" });
    expect(s.node.sends).toEqual([]);
  });

  /** Round 1 read at Appeal, with the ruling options a read can come back with when they fail
   *  the check: not resolved by the service, or resolved with the two titles swapped. */
  const FAILING_OPTIONS: [string, Partial<DisputeRead>][] = [
    ["unresolved", { rulingOptions: [], unresolvedFields: ["rulingOptions"] }],
    [
      "swapped titles",
      {
        rulingOptions: [
          { value: "0x01", title: "Refund the client" },
          { value: "0x02", title: "Pay the provider" },
        ],
      },
    ],
  ];

  test.each(FAILING_OPTIONS)(
    "an accepted round whose options were %s when read is not acted on from the stored read",
    async (_name, failing) => {
      let next = appealRead("1");
      const service = {
        deployment: "testnet",
        getDispute: async (): Promise<DisputeRead> => next,
      } as unknown as KlerosDisputeService;
      const s = setup({ service, stageMode: "testnet", deployment: deploymentFor("testnet") });
      const caseId = seed(s, {
        mode: "testnet",
        status: "ruled",
        patch: {
          klerosChain: "arbitrum-sepolia-testnet",
          rulingStatus: "Appeal",
          rulingValue: "1",
          rulingTied: 0,
          rulingRoundCount: 1,
          rulingReadAt: NOW,
        },
      });
      next = { ...appealRead("1"), roundCount: 2, ...failing };
      s.clock.sec += 60;
      await pollOnce(
        { stage: s.stage, cases: s.cases, expected: EXPECTED, now: () => s.clock.sec * 1000 },
        caseId,
      );
      expect(s.cases.find(caseId)!.rulingRoundCount).toBe(2);
      s.clock.sec += 60;
      const r = await settleCase(s.deps, caseId, { send: true, acceptRound: 2 });
      expect(r.settlement).toEqual({ action: "none", why: "options_mismatch" });
      expect(s.node.sends).toEqual([]);
    },
  );

  test.each(FAILING_OPTIONS)(
    "a ruled row whose later read had options %s is read again by every settle, and never sent on",
    async (_name, failing) => {
      let next: DisputeRead = { ...appealRead("1"), ...failing };
      const service = {
        deployment: "testnet",
        getDispute: async (): Promise<DisputeRead> => next,
      } as unknown as KlerosDisputeService;
      const s = setup({ service, stageMode: "testnet", deployment: deploymentFor("testnet") });
      const readAt = NOW - 3600;
      const caseId = seed(s, {
        mode: "testnet",
        status: "ruled",
        patch: {
          klerosChain: "arbitrum-sepolia-testnet",
          rulingStatus: "Appeal",
          rulingValue: "1",
          rulingTied: 0,
          rulingRoundCount: 1,
          rulingReadAt: readAt,
        },
      });
      const first = await settleCase(s.deps, caseId, { send: true });
      expect(first.settlement).toEqual({ action: "none", why: "options_mismatch" });
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)).toMatchObject({ status: "ruled", rulingReadAt: readAt });
      s.clock.sec += 60;
      const second = await settleCase(s.deps, caseId, { send: true });
      expect(second.settlement).toEqual({ action: "none", why: "options_mismatch" });
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)).toMatchObject({ status: "ruled", rulingReadAt: readAt });
      // Once the options read right again, the next settle acts on the verdict it reads.
      next = appealRead("1");
      const third = await settleCase(s.deps, caseId, { send: true });
      expect(third.settlement.action).toBe("complete");
      expect(s.node.sends).toHaveLength(1);
    },
  );

  test("a testnet ruled row read ten minutes ago or more is read again on its own chain", async () => {
    const reads: { chain: string; coreDisputeId: string }[] = [];
    const service = {
      deployment: "testnet",
      getDispute: async (p: { chain: string; coreDisputeId: string }): Promise<DisputeRead> => {
        reads.push(p);
        return appealRead("1");
      },
    } as unknown as KlerosDisputeService;
    const s = setup({ service, stageMode: "testnet", deployment: deploymentFor("testnet") });
    const stale = { rulingValue: "2", rulingTied: 0, rulingRoundCount: 1 };
    const caseId = seed(s, {
      mode: "testnet",
      status: "ruled",
      patch: { klerosChain: "arbitrum-sepolia-testnet", ...stale, rulingReadAt: NOW - 600 },
    });
    const r = await settleCase(s.deps, caseId, { send: false });
    expect(r.settlement.action).toBe("complete");
    expect(reads).toEqual([{ chain: "arbitrum-sepolia-testnet", coreDisputeId: DISPUTE }]);
  });

  test.each<[PilotStatus]>([["contested"], ["filing"], ["failed"], ["filing_unknown"]])(
    "a row at %s is refused before any read or send",
    async (status) => {
      const s = setup();
      const caseId = seed(s, { status });
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(/refusing/);
      expect(s.fake.calls).toEqual([]);
      expect(s.node.sends).toEqual([]);
    },
  );

  test("a pending ruling inside the job's life sends nothing and keeps the row filed", async () => {
    const s = setup({ script: "stalled" });
    const caseId = seed(s);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toEqual({ action: "none", why: "ruling_pending" });
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)!.status).toBe("filed");
  });

  test("a job whose evaluator is not the referee is refused before the row moves, naming both", async () => {
    const s = setup({ script: "pay", evaluator: SELLER });
    const caseId = seed(s);
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(`evaluator is ${SELLER}.*referee is ${REFEREE}`, "i"),
    );
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)!.status).toBe("ruled");
  });

  describe("a job that is not the case's own is refused before anything is sent", () => {
    const OTHER = "0x00000000000000000000000000000000000000f1" as Address;
    test.each<[string, Parameters<typeof seed>[1] & object, RegExp]>([
      [
        "chain id",
        { insert: { chainId: 5_042_002 } },
        /is on chain id 5042002 and the configured chain id is 31337/,
      ],
      [
        "job contract",
        { insert: { jobContract: OTHER } },
        /job contract is 0x0{38}f1 and the configured job contract is 0x/i,
      ],
      [
        "client",
        { insert: { buyerAddress: OTHER } },
        /client is 0x.* and the case's buyer is 0x0{38}f1/i,
      ],
      [
        "evaluator",
        { insert: { refereeAddress: OTHER } },
        /evaluator is 0x.* and the case's referee is 0x0{38}f1/i,
      ],
      [
        "expiry",
        { insert: { expiredAt: EXPIRES + 1 } },
        new RegExp(`expiredAt is ${EXPIRES} and the case's expiredAt is ${EXPIRES + 1}`),
      ],
      [
        "budget",
        { insert: { budgetAtomic: "999" } },
        /budget is 500000 and the case's budget is 999/,
      ],
    ])("a different %s sends nothing and leaves the row", async (_field, o, message) => {
      const s = setup({ script: "pay" });
      const caseId = seed(s, o);
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(message);
      expect(s.node.sends).toEqual([]);
      expect(["filed", "ruled"]).toContain(s.cases.find(caseId)!.status);
    });

    test("a job contract that is not the configured one is refused before any read", async () => {
      const s = setup({ script: "pay" });
      const caseId = seed(s, { insert: { jobContract: OTHER } });
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
        /job contract is 0x0{38}f1 and the configured job contract is 0x/i,
      );
      expect(s.fake.calls).toEqual([]);
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)!.status).toBe("filed");
    });

    test("a settling row holding a hash on another chain id is refused for the chain, not for its receipt", async () => {
      const s = setup({ script: "pay" });
      const caseId = seed(s, {
        status: "settling",
        insert: { chainId: 5_042_002 },
        patch: {
          settleAction: "complete",
          settleReason: reasonFor(DISPUTE),
          settleTxHash: `0x${"ab".repeat(32)}`,
        },
      });
      const err = await settleCase(s.deps, caseId, { send: true }).catch((e: unknown) => e);
      expect(String(err)).toMatch(/is on chain id 5042002 and the configured chain id is 31337/);
      expect(String(err)).not.toMatch(/no receipt yet/);
      expect(s.node.sends).toEqual([]);
    });

    test("a node on another chain than the configured one is refused after the configuration matched", async () => {
      const s = setup({ script: "pay" });
      s.deps.chain.chainId = 5_042_002;
      const caseId = seed(s, { insert: { chainId: 5_042_002 } });
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
        /is on chain id 5042002 and the connected chain is 31337/,
      );
      expect(s.node.sends).toEqual([]);
    });

    test("a job that has already settled is not refused for the budget it reads as", async () => {
      const s = setup({ script: "pay", chainStatus: 3 });
      const caseId = seed(s, { insert: { budgetAtomic: "999" } });
      const r = await settleCase(s.deps, caseId, { send: true });
      expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
      expect(s.node.sends).toEqual([]);
    });

    test("a job whose evaluator is the case's referee but not the referee wallet is still refused", async () => {
      const s = setup({ script: "pay", evaluator: SELLER });
      const caseId = seed(s, { insert: { refereeAddress: SELLER } });
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
        new RegExp(`evaluator is ${SELLER}.*referee is ${REFEREE}`, "i"),
      );
      expect(s.node.sends).toEqual([]);
    });

    test("a dry run refuses a different job too", async () => {
      const s = setup({ script: "pay" });
      const caseId = seed(s, { insert: { buyerAddress: OTHER } });
      await expect(settleCase(s.deps, caseId, { send: false })).rejects.toThrow(/refusing/);
      expect(s.node.sends).toEqual([]);
    });

    test("when every field matches the send goes through", async () => {
      const s = setup({ script: "pay" });
      const caseId = seed(s);
      await settleCase(s.deps, caseId, { send: true });
      expect(s.node.sends).toHaveLength(1);
    });
  });

  describe("the referee's gas is checked before the transaction", () => {
    test("a referee with no gas sends nothing, names its address and leaves the row", async () => {
      const s = setup({ script: "pay", refereeGas: 0n });
      const caseId = seed(s);
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
        new RegExp(`referee's address ${REFEREE} holds 0 of the native token.*is 0\\.1;`),
      );
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)!.status).toBe("ruled");
    });

    test("a referee holding 1 wei is under the floor, sends nothing and names the floor", async () => {
      expect(MIN_GAS_WEI).toBe(10n ** 17n);
      const s = setup({ script: "pay", refereeGas: 1n });
      const caseId = seed(s);
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
        new RegExp(
          `referee's address ${REFEREE} holds 0\\.000000000000000001 of the native token and the floor to send its transaction is 0\\.1;`,
        ),
      );
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)!.status).toBe("ruled");
    });

    test("a balance that cannot be read sends nothing and gives the public error message", async () => {
      const s = setup({ script: "pay", refereeGas: "unreadable" });
      const caseId = seed(s);
      await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
        /referee's gas balance could not be read/,
      );
      expect(s.node.sends).toEqual([]);
      expect(s.cases.find(caseId)!.status).toBe("ruled");
    });

    test("a referee holding exactly the floor sends", async () => {
      const s = setup({ script: "pay", refereeGas: MIN_GAS_WEI });
      const caseId = seed(s);
      await settleCase(s.deps, caseId, { send: true });
      expect(s.node.sends).toHaveLength(1);
    });

    test("a dry run does not read the balance", async () => {
      const s = setup({ script: "pay", refereeGas: "unreadable" });
      const caseId = seed(s);
      const r = await settleCase(s.deps, caseId, { send: false });
      expect(r.settlement.action).toBe("complete");
    });
  });

  test("a ruling read again while the settle ran is not acted on, and the row is left ruled", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s, { status: "ruled", patch: STORED_PAY });
    const job = s.deps.chain.job;
    const real = job.escrowState.bind(job);
    job.escrowState = async (...a: Parameters<typeof job.escrowState>) => {
      const state = await real(...a);
      // Another command reads the next round while this one is between its read and its send.
      s.cases.advance(caseId, "ruled", "ruled", { rulingRoundCount: 2, rulingReadAt: NOW + 30 });
      return state;
    };
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(
      new RegExp(`case ${caseId}'s ruling was read again while this command ran; run it again`),
    );
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)).toMatchObject({ status: "ruled", rulingRoundCount: 2 });
  });

  test("a settled write that misses after the send keeps the hash on the trail", async () => {
    const s = setup({ script: "pay" });
    const caseId = seed(s);
    const advance = s.cases.advance.bind(s.cases);
    vi.spyOn(s.cases, "advance").mockImplementation((id, from, to, patch) =>
      to === "settled" ? undefined : advance(id, from, to, patch),
    );
    await expect(settleCase(s.deps, caseId, { send: true })).rejects.toThrow(/left settling/);
    const hash = s.node.sends[0]!.hash;
    expect(s.cases.events(caseId)).toContainEqual(
      expect.objectContaining({ step: "settle", status: "sent", ref: hash }),
    );
  });

  test("an escrow released elsewhere is recorded settled with no hash when sending", async () => {
    const s = setup({ script: "refund", chainStatus: 3 });
    const caseId = seed(s);
    const r = await settleCase(s.deps, caseId, { send: true });
    expect(r.settlement).toMatchObject({ why: "released_elsewhere" });
    expect(s.node.sends).toEqual([]);
    expect(s.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "none",
      settleTxHash: null,
      escrowOutcome: "released",
    });
  });
});
