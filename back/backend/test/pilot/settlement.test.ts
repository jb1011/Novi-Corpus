/**
 * The settlement over the fake node: the pure decision row by row, then `settleCase` with a real
 * JobAdapter, real local signers and a real SQLite case table. The node runs the job contract's
 * rules for `complete`, `reject` and `claimRefund`, so who signed and what the calldata carried
 * are read off what the node accepted.
 */
import Database from "better-sqlite3";
import { type Address, decodeFunctionData, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { iErc8183JobAbi } from "../../src/abis/generated";
import { JobAdapter } from "../../src/adapters/arc/jobAdapter";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import type { DisputeRead, KlerosDisputeService } from "../../src/adapters/kleros/disputeService";
import { FakeDisputeService, type FakeScript } from "../../src/adapters/kleros/fakeDisputeService";
import type { Config } from "../../src/config/env";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../../src/errors";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import { type KlerosStage, type PilotChain, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import type { RulingOutcome } from "../../src/pilot/ruling";
import {
  EXPIRY_MARGIN_SECONDS,
  type EscrowState,
  type SettleDeps,
  decideSettlement,
  reasonFor,
  settleCase,
} from "../../src/pilot/settlement";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";
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

  test("Submitted or Funded past the expiry, any ruling: claimRefund with no reason", () => {
    const after = EXPIRES + 1;
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
    expect(decideSettlement(PAY, escrow(2), EXPIRES + 1, { claimRefundOnly: true })).toEqual({
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
  return { node, cases, fake, stage, deps, clock, expiredAt };
}

type Setup = ReturnType<typeof setup>;

/** A case on job 7 at `status`, seeded by hand: the earlier steps are other modules'. */
function seed(
  s: Setup,
  o: { status?: PilotStatus; mode?: PilotMode; patch?: Partial<PilotCaseRecord> } = {},
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
  });
  s.cases.advance(caseId, "created", o.status ?? "filed", {
    jobId: "7",
    klerosChain: "fake",
    coreDisputeId: DISPUTE,
    ...o.patch,
  });
  return caseId;
}

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
    s.clock.sec = EXPIRES + 1;
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
