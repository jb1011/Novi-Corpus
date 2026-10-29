/**
 * The settlement on anvil: MockUSDC and MockERC8183Job, the buyer as the job's client, the seller
 * as its provider, the referee as its evaluator. The contract enforces who may end the job and
 * where the money goes, so a USDC balance is the proof that each settlement did what it says.
 * The ruling is seeded on the row as a fresh read, so no Kleros read is taken.
 */
import { http, type Hex, createPublicClient } from "viem";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import { anvilChain } from "../../src/chains";
import type { Config } from "../../src/config/env";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import { type PilotChain, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { type SettleDeps, reasonFor, settleCase } from "../../src/pilot/settlement";
import { type MockJobEnv, deployMockJob } from "../helpers/anvilJob";

const BUDGET = 500_000n;
const WEEK = 7 * 86_400;
const DELIVERABLE = `0x${"d1".repeat(32)}` as Hex;
const EXPECTED = { "1": "Pay the provider", "2": "Refund the client" };

let env: MockJobEnv;
let chain: PilotChain;

beforeAll(async () => {
  env = await deployMockJob();
  await env.mintUsdc(env.clientAddr, 5_000_000n);
  const ctx = {
    cfg: {
      chainId: anvilChain.id,
      usdc: env.usdcAddr,
      jobContract: env.jobAddr,
      identityRegistry: "0x0000000000000000000000000000000000000005",
      arcExplorerUrl: "https://explorer.example.com",
    } as unknown as Config,
    publicClient: env.publicClient,
    sendClient: createPublicClient({ chain: anvilChain, transport: http(env.rpcUrl) }),
    wallets: { buyer: env.clientWallet, seller: env.providerWallet, referee: env.evaluatorWallet },
    addresses: { buyer: env.clientAddr, seller: env.providerAddr, referee: env.evaluatorAddr },
  } as unknown as PilotContext;
  chain = buildPilotChain(ctx);
});

afterAll(() => env?.stop());

const blockSeconds = async () => Number((await env.publicClient.getBlock()).timestamp);

/** Anvil's clock, moved past a deadline. `evm_increaseTime` alone does not mine a block. */
async function warp(seconds: number): Promise<void> {
  for (const [id, method, params] of [
    [1, "evm_increaseTime", [seconds]],
    [2, "evm_mine", []],
  ] as const) {
    await fetch(env.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  }
}

/** Create, budget, fund and submit, each by the account the contract requires. */
async function submittedJob(): Promise<{ jobId: bigint; expiredAt: number }> {
  const expiredAt = (await blockSeconds()) + WEEK;
  const { jobId } = await chain.job.createJob({
    provider: env.providerAddr,
    evaluator: env.evaluatorAddr,
    expiredAt: BigInt(expiredAt),
    description: "a test job",
  });
  await chain.job.setBudget(jobId, BUDGET, env.providerWallet);
  await chain.job.approveAndFund(jobId, env.usdcAddr, BUDGET);
  await chain.job.submit(jobId, DELIVERABLE, env.providerWallet);
  expect((await chain.job.escrowState(jobId)).status).toBe(2);
  return { jobId, expiredAt };
}

/** A rehearsal case on the job, ruled with `rulingValue` and read at `readAt`. */
async function settleDeps(
  jobId: bigint,
  expiredAt: number,
  rulingValue: string,
  now: number,
): Promise<{ deps: SettleDeps; caseId: string; cases: SqlitePilotCaseRepository }> {
  const db = openDatabase(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const caseId = newCaseId();
  cases.insert({
    caseId,
    label: "test case 1",
    mode: "rehearsal",
    chainId: anvilChain.id,
    jobContract: env.jobAddr,
    buyerAddress: env.clientAddr,
    buyerAgentId: "11",
    sellerAddress: env.providerAddr,
    sellerAgentId: "12",
    refereeAddress: env.evaluatorAddr,
    budgetAtomic: BUDGET.toString(),
    description: "a test job",
    expiredAt,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  cases.advance(caseId, "created", "ruled", {
    jobId: jobId.toString(),
    klerosChain: "fake",
    coreDisputeId: "287",
    rulingValue,
    rulingTied: 0,
    rulingRoundCount: 1,
    rulingReadAt: now,
  });
  const deps: SettleDeps = {
    chain,
    cases,
    stage: {
      mode: "rehearsal",
      service: new FakeDisputeService({ script: "pay" }),
      deployment: null,
      cap: null,
      flag: null,
    },
    expected: EXPECTED,
    now: () => now * 1000,
  };
  return { deps, caseId, cases };
}

describe("settlement on anvil", () => {
  test("a pay ruling completes with the case number as the reason and pays the provider", async () => {
    const { jobId, expiredAt } = await submittedJob();
    const now = await blockSeconds();
    const { deps, caseId, cases } = await settleDeps(jobId, expiredAt, "1", now);
    const before = await env.usdcBalanceOf(env.providerAddr);
    const r = await settleCase(deps, caseId, { send: true });
    expect(r.settlement).toEqual({
      action: "complete",
      reason: reasonFor("287"),
      outcome: "released",
    });
    expect(await env.usdcBalanceOf(env.providerAddr)).toBe(before + BUDGET);
    expect((await chain.job.escrowState(jobId)).status).toBe(3);
    const tx = await env.publicClient.getTransaction({ hash: r.txHash as Hex });
    expect(tx.from.toLowerCase()).toBe(env.evaluatorAddr.toLowerCase());
    expect(tx.input).toContain(reasonFor("287").slice(2));
    expect(cases.find(caseId)).toMatchObject({ status: "settled", escrowOutcome: "released" });
  });

  test("a refund ruling rejects from the evaluator and refunds the client", async () => {
    const { jobId, expiredAt } = await submittedJob();
    const now = await blockSeconds();
    const { deps, caseId, cases } = await settleDeps(jobId, expiredAt, "2", now);
    const before = await env.usdcBalanceOf(env.clientAddr);
    const r = await settleCase(deps, caseId, { send: true });
    expect(r.settlement.action).toBe("reject");
    expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before + BUDGET);
    expect((await chain.job.escrowState(jobId)).status).toBe(4);
    expect(cases.find(caseId)).toMatchObject({ status: "settled", escrowOutcome: "refunded" });
  });

  test("a reject from a stranger reverts and the escrow stays", async () => {
    const { jobId } = await submittedJob();
    await expect(chain.job.reject(jobId, reasonFor("287"), env.strangerWallet)).rejects.toThrow(
      /not client or evaluator|reverted/,
    );
    expect((await chain.job.escrowState(jobId)).status).toBe(2);
  });

  // Last: the warp moves anvil's clock for every later job.
  test("past the expiry claimRefund from the evaluator refunds the client", async () => {
    const { jobId, expiredAt } = await submittedJob();
    await warp(WEEK + 60);
    const now = await blockSeconds();
    expect(now).toBeGreaterThan(expiredAt);
    const { deps, caseId, cases } = await settleDeps(jobId, expiredAt, "1", now);
    const before = await env.usdcBalanceOf(env.clientAddr);
    const r = await settleCase(deps, caseId, { send: true });
    expect(r.settlement).toEqual({ action: "claimRefund", reason: null, outcome: "refunded" });
    const tx = await env.publicClient.getTransaction({ hash: r.txHash as Hex });
    expect(tx.from.toLowerCase()).toBe(env.evaluatorAddr.toLowerCase());
    expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before + BUDGET);
    expect((await chain.job.escrowState(jobId)).status).toBe(5);
    expect(cases.find(caseId)).toMatchObject({ status: "settled", settleAction: "claimRefund" });
  });
});
