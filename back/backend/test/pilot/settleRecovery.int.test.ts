/**
 * The settle's recovery on anvil, through `pilot:settle`'s own wiring: MockUSDC and
 * MockERC8183Job, the buyer as the job's client, the seller as its provider, the referee as its
 * evaluator, and the real `buildPilotChain` over anvil's clients. Each case is seeded in its own
 * database on a real job, as the earlier commands would have left it; the box is in rehearsal
 * mode, the Kleros side is the scripted fake, and no Kleros read is taken.
 */
import { Command } from "commander";
import { http, type Hex, createPublicClient, encodeFunctionData } from "viem";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { iErc8183JobAbi } from "../../src/abis/generated";
import { anvilChain } from "../../src/chains";
import { registerPilotSettlementCommands } from "../../src/cli/pilotSettlement";
import type { Config } from "../../src/config/env";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import { type PilotChain, buildPilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { REFUND_CLOCK_MARGIN_SECONDS, reasonFor } from "../../src/pilot/settlement";
import type { PilotCaseRecord, PilotStatus } from "../../src/pilot/types";
import { type MockJobEnv, deployMockJob } from "../helpers/anvilJob";

const BUDGET = 500_000n;
const WEEK = 7 * 86_400;
const DELIVERABLE = `0x${"d1".repeat(32)}` as Hex;
const DISPUTE = "287";

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

/** Create, budget and fund, each by the account the contract requires. */
async function fundedJob(): Promise<{ jobId: bigint; expiredAt: number }> {
  const expiredAt = (await blockSeconds()) + WEEK;
  const { jobId } = await chain.job.createJob({
    provider: env.providerAddr,
    evaluator: env.evaluatorAddr,
    expiredAt: BigInt(expiredAt),
    description: "a test job",
  });
  await chain.job.setBudget(jobId, BUDGET, env.providerWallet);
  await chain.job.approveAndFund(jobId, env.usdcAddr, BUDGET);
  expect((await chain.job.escrowState(jobId)).status).toBe(1);
  return { jobId, expiredAt };
}

/** A funded job, then submitted by the provider. */
async function submittedJob(): Promise<{ jobId: bigint; expiredAt: number }> {
  const job = await fundedJob();
  await chain.job.submit(job.jobId, DELIVERABLE, env.providerWallet);
  expect((await chain.job.escrowState(job.jobId)).status).toBe(2);
  return job;
}

/** A rehearsal case on the job at `status`, in a database of its own, holding a first-round
 *  read and `patch`. */
function seedCase(
  job: { jobId: bigint; expiredAt: number },
  status: PilotStatus,
  patch: Partial<PilotCaseRecord> = {},
): { cases: SqlitePilotCaseRepository; caseId: string } {
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
    expiredAt: job.expiredAt,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  cases.advance(caseId, "created", status, {
    jobId: job.jobId.toString(),
    klerosChain: "fake",
    coreDisputeId: DISPUTE,
    rulingValue: "1",
    rulingTied: 0,
    rulingRoundCount: 1,
    ...patch,
  });
  return { cases, caseId };
}

/**
 * `pilot:settle` with `args`, as its own process would run it: the box in rehearsal mode, the
 * chain over anvil, the clock at `nowSec`. Returns the JSON objects it printed, the ops lines
 * aside; a refusal rejects.
 */
async function settleCommand(
  cases: SqlitePilotCaseRepository,
  args: string[],
  nowSec: number,
): Promise<Record<string, unknown>[]> {
  const ctx = {
    cfg: { pilot: { mode: "rehearsal" } } as unknown as Config,
    cases,
    close: () => undefined,
  } as unknown as PilotContext;
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerPilotSettlementCommands(program, {
    open: () => ctx,
    buildChain: () => chain,
    now: () => nowSec * 1000,
  });
  const logs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
  try {
    await program.parseAsync(["node", "cli", "pilot:settle", ...args]);
  } finally {
    log.mockRestore();
  }
  return logs
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((o) => o.opslog === undefined);
}

describe("the settle's recovery on anvil", () => {
  test("--tx adopts the referee's complete whose hash the row lost, sending nothing, and refuses a hash from another sender", async () => {
    const job = await submittedJob();
    const reason = reasonFor(DISPUTE);
    const { cases, caseId } = seedCase(job, "settling", {
      settleAction: "complete",
      settleReason: reason,
    });
    // The settle's own send, from the referee; the run stopped before it wrote the hash.
    const hash = await chain.job.complete(job.jobId, reason);
    expect(cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });
    expect((await chain.job.escrowState(job.jobId)).status).toBe(3);
    // The same call from a stranger: mined, reverted, and never the case's.
    const strangerHash = await env.strangerWallet.sendTransaction({
      account: env.strangerWallet.account!,
      chain: anvilChain,
      to: env.jobAddr,
      data: encodeFunctionData({
        abi: iErc8183JobAbi,
        functionName: "complete",
        args: [job.jobId, reason, "0x"],
      }),
      gas: 300_000n,
    });
    expect((await env.publicClient.waitForTransactionReceipt({ hash: strangerHash })).status).toBe(
      "reverted",
    );
    const now = await blockSeconds();
    const refereeNonce = () => env.publicClient.getTransactionCount({ address: env.evaluatorAddr });
    const nonceBefore = await refereeNonce();

    await expect(
      settleCommand(cases, ["--case", caseId, "--tx", strangerHash, "--yes"], now),
    ).rejects.toThrow(
      new RegExp(`has sender ${env.strangerAddr}, not the referee ${env.evaluatorAddr}`, "i"),
    );
    expect(cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });

    const [dryRun] = await settleCommand(cases, ["--case", caseId, "--tx", hash], now);
    expect(dryRun).toMatchObject({
      dryRun: true,
      status: "settling",
      proof: { hash, action: "complete", jobId: job.jobId.toString(), reason, receipt: "success" },
      write: { status: "settled", settleTxHash: hash, escrowOutcome: "released" },
    });
    expect(cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });

    // The box's clock an hour ahead: the row takes the block's time.
    const [out] = await settleCommand(cases, ["--case", caseId, "--tx", hash, "--yes"], now + 3600);
    expect(out).toMatchObject({ caseId, status: "settled", wrote: { settleTxHash: hash } });
    const receipt = await env.publicClient.getTransactionReceipt({ hash });
    const block = await env.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    expect(cases.find(caseId)).toMatchObject({
      status: "settled",
      settleAction: "complete",
      settleReason: reason,
      settleTxHash: hash,
      settledAt: Number(block.timestamp),
      escrowOutcome: "released",
    });
    expect(cases.events(caseId).at(-1)).toMatchObject({
      step: "settle",
      status: "adopted",
      ref: hash,
      detail: "complete",
    });
    expect(await refereeNonce()).toBe(nonceBefore);
  });

  // Last: the warp moves anvil's clock for every later job.
  test("--claim-refund on a case funded but never filed, past the expiry and the margin, refunds the buyer from the referee and the case ends failed", async () => {
    const job = await fundedJob();
    const { cases, caseId } = seedCase(job, "funded", {
      klerosChain: null,
      coreDisputeId: null,
      rulingValue: null,
      rulingTied: null,
      rulingRoundCount: null,
    });
    await warp(WEEK + 120);
    const now = await blockSeconds();
    expect(now).toBeGreaterThan(job.expiredAt + Number(REFUND_CLOCK_MARGIN_SECONDS));

    const [dryRun] = await settleCommand(cases, ["--case", caseId, "--claim-refund"], now);
    expect(dryRun).toMatchObject({
      dryRun: true,
      status: "funded",
      settlement: { action: "claimRefund" },
      escrow: { status: "Funded", budgetAtomic: BUDGET.toString(), expiredAt: job.expiredAt },
      send: { action: "claimRefund", jobId: job.jobId.toString(), from: env.evaluatorAddr },
    });
    expect(cases.find(caseId)).toMatchObject({ status: "funded", settleAction: null });

    const before = await env.usdcBalanceOf(env.clientAddr);
    const [out] = await settleCommand(cases, ["--case", caseId, "--claim-refund", "--yes"], now);
    const hash = out!.txHash as Hex;
    const tx = await env.publicClient.getTransaction({ hash });
    expect(tx.from.toLowerCase()).toBe(env.evaluatorAddr.toLowerCase());
    expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before + BUDGET);
    expect((await chain.job.escrowState(job.jobId)).status).toBe(5);
    expect(cases.find(caseId)).toMatchObject({
      status: "failed",
      settleAction: "claimRefund",
      settleTxHash: hash,
      settledAt: now,
      escrowOutcome: "refunded",
      error: "expired; escrow refunded by claimRefund",
      filingStartedAt: null,
    });
    expect(
      cases
        .events(caseId)
        .filter((e) => e.step === "settle")
        .map((e) => [e.status, e.ref]),
    ).toEqual([
      ["sending", null],
      ["sent", hash],
      ["ok", hash],
    ]);
    // A failed case whose filing never started is out of the cap's count.
    expect(cases.countFiled("rehearsal")).toBe(0);
  });
});
