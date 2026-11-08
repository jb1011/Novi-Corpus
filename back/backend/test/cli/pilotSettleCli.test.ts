/**
 * `pilot:settle` and `pilot:case set-ids` over a fake PilotContext whose case table is a real
 * SQLite repository in memory, with a stub job adapter and the scripted fake Dispute Service:
 * no chain, no network.
 */
import Database from "better-sqlite3";
import { Command } from "commander";
import {
  type Hex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  encodeFunctionData,
} from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import { iErc8183JobAbi } from "../../src/abis/generated";
import { klerosCaseUrl } from "../../src/adapters/kleros/deployments";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import { registerPilotCommands } from "../../src/cli/pilot";
import { registerPilotSettlementCommands } from "../../src/cli/pilotSettlement";
import type { Config } from "../../src/config/env";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import type { KlerosStage, PilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { DROP_GRACE_SECONDS, reasonFor } from "../../src/pilot/settlement";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";

/** Spelled by code point: the repository keeps the character itself out of its sources. */
const EM_DASH = String.fromCodePoint(0x2014);
/** 2026-10-28T00:00:00Z, in seconds. */
const NOW = 1_793_145_600;
const EXPIRES = NOW + 7 * 86_400;
const TX = `0x${"ab".repeat(32)}` as Hex;

afterEach(() => vi.restoreAllMocks());

function makeFake(o: { chainStatus?: number; mode?: PilotMode; nowSec?: number } = {}) {
  /** The commands' clock, in seconds. */
  const clock = o.nowSec ?? NOW;
  const db = new Database(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const mode = o.mode ?? "rehearsal";
  const cfg = { pilot: { mode } } as unknown as Config;
  let opens = 0;
  let closes = 0;
  const ctx = { cfg, db, cases, close: () => closes++ } as unknown as PilotContext;
  const sent: { call: string; args: unknown[] }[] = [];
  const escrow = { status: o.chainStatus ?? 2 };
  const job = {
    escrowState: async () => ({
      status: escrow.status,
      budget: 500_000n,
      expiredAt: BigInt(EXPIRES),
      client: "0x0000000000000000000000000000000000000001",
      evaluator: "0x0000000000000000000000000000000000000003",
    }),
    complete: async (...args: unknown[]) => {
      sent.push({ call: "complete", args });
      escrow.status = 3;
      return TX;
    },
    reject: async (...args: unknown[]) => {
      sent.push({ call: "reject", args });
      escrow.status = 4;
      return TX;
    },
    claimRefund: async (...args: unknown[]) => {
      sent.push({ call: "claimRefund", args });
      escrow.status = 5;
      return TX;
    },
  };
  /** What the node holds under a hash: none by default, as a node that never saw it. */
  const node = {
    txs: new Map<string, { from: string; to: string; input: Hex; blockNumber: bigint | null }>(),
    receipts: new Map<string, { status: "success" | "reverted"; blockNumber: bigint }>(),
  };
  const chain = {
    job,
    publicClient: {
      getChainId: async () => 5042002,
      getBalance: async () => 10n ** 18n,
      getTransaction: async ({ hash }: { hash: Hex }) => {
        const tx = node.txs.get(hash);
        if (!tx) throw new TransactionNotFoundError({ hash });
        return tx;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const receipt = node.receipts.get(hash);
        if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
        return receipt;
      },
      getBlock: async () => ({ timestamp: BigInt(NOW - 60) }),
    },
    jobContract: "0x0000000000000000000000000000000000000b0b",
    chainId: 5042002,
    wallets: { referee: { name: "referee" } },
    addresses: { referee: "0x0000000000000000000000000000000000000003" },
  } as unknown as PilotChain;
  const fake = new FakeDisputeService({
    script: "pay",
    readsUntilAppeal: 1,
    answerUnknownDisputes: true,
    now: () => NOW * 1000,
  });
  const stage: KlerosStage = {
    mode: "rehearsal",
    service: fake,
    deployment: null,
    cap: null,
    flag: null,
  };
  const run = async (argv: string[]): Promise<Record<string, unknown>[]> => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const open = () => {
      opens++;
      return ctx;
    };
    // `pilot:case` lives with the other pilot commands; settle and poll take the fakes.
    if (argv[0] === "pilot:case") registerPilotCommands(program, open, { now: () => clock });
    else
      registerPilotSettlementCommands(program, {
        open,
        buildStage: () => stage,
        buildChain: () => chain,
        now: () => clock * 1000,
        sleep: async () => {},
      });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    try {
      await program.parseAsync(["node", "cli", ...argv]);
    } finally {
      vi.mocked(console.log).mockRestore();
    }
    for (const l of logs) expect(l).not.toContain(EM_DASH);
    return logs.map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return {
    db,
    cases,
    fake,
    sent,
    escrow,
    node,
    run,
    opened: () => opens,
    closed: () => closes,
  };
}

type Fake = ReturnType<typeof makeFake>;

function seed(
  f: Fake,
  o: { status?: PilotStatus; mode?: PilotMode; patch?: Partial<PilotCaseRecord> } = {},
): string {
  const caseId = newCaseId();
  f.cases.insert({
    caseId,
    label: "test case 1",
    mode: o.mode ?? "rehearsal",
    chainId: 5042002,
    jobContract: "0x0000000000000000000000000000000000000b0b",
    buyerAddress: "0x0000000000000000000000000000000000000001",
    buyerAgentId: "11",
    sellerAddress: "0x0000000000000000000000000000000000000002",
    sellerAgentId: "12",
    refereeAddress: "0x0000000000000000000000000000000000000003",
    budgetAtomic: "500000",
    description: "a test job",
    expiredAt: EXPIRES,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  f.cases.advance(caseId, "created", o.status ?? "filed", {
    jobId: "7",
    klerosChain: "fake",
    coreDisputeId: "287",
    ...o.patch,
  });
  return caseId;
}

describe("pilot:settle", () => {
  test("without --yes it prints the decision and sends nothing", async () => {
    const f = makeFake();
    const caseId = seed(f);
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--script", "pay"]);
    expect(out).toMatchObject({
      dryRun: true,
      caseId,
      settlement: { action: "complete", reason: reasonFor("287"), outcome: "released" },
      status: "ruled",
    });
    expect(String(out!.next)).toMatch(/--yes/);
    expect(f.sent).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("with --yes it sends the decision and prints the hash", async () => {
    const f = makeFake();
    const caseId = seed(f);
    const outs = await f.run(["pilot:settle", "--case", caseId, "--script", "pay", "--yes"]);
    const out = outs.find((o) => o.opslog === undefined);
    expect(out).toMatchObject({
      caseId,
      settlement: { action: "complete" },
      txHash: TX,
      status: "settled",
    });
    // The settle hands the adapter a hook that writes the hash the moment it exists.
    expect(f.sent).toEqual([
      {
        call: "complete",
        args: [7n, reasonFor("287"), { onBroadcast: expect.any(Function) }],
      },
    ]);
  });

  test("--claim-refund before the expiry is refused with the expiry time, and nothing is sent", async () => {
    const f = makeFake();
    const caseId = seed(f);
    await expect(
      f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]),
    ).rejects.toThrow(/expires at 2026-11-04T00:00:00.000Z/);
    expect(f.sent).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("--accept-round acts on the appealed round it names", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "filed" });
    // A read of a second round: the fake answers round one, so the stage is a stub here.
    const stub = {
      deployment: "testnet",
      getDispute: async () => ({
        status: "Appeal",
        ruling: "2",
        tied: false,
        ruled: false,
        roundCount: 2,
        rulingOptions: [
          { value: "1", title: "Pay the provider" },
          { value: "2", title: "Refund the client" },
        ],
        deadline: null,
        unresolvedFields: [],
        raw: null,
      }),
    };
    (f.fake as unknown as { getDispute: unknown }).getDispute = stub.getDispute;
    const [held] = await f.run(["pilot:settle", "--case", caseId, "--script", "pay"]);
    expect(held).toMatchObject({ settlement: { action: "none", why: "appealed" } });
    // The rehearsal row now holds the appealed read, so the second run decides from it.
    const [taken] = await f.run(["pilot:settle", "--case", caseId, "--accept-round", "2"]);
    expect(taken).toMatchObject({ settlement: { action: "reject" } });
  });

  test.each([
    [["pilot:settle"], /--case/],
    [["pilot:settle", "--case", "pc_nothex"], /pilot case id/],
    [["pilot:settle", "--case", "pc_000000000000", "--accept-round", "0"], /--accept-round/],
    [["pilot:settle", "--case", "pc_000000000000", "--accept-round", "two"], /--accept-round/],
    [
      ["pilot:settle", "--case", "pc_000000000000", "--accept-round", "2", "--claim-refund"],
      /cannot both be given/,
    ],
    [["pilot:settle", "--case", "pc_000000000000", "--script", "nope"], /--script/],
  ])("%j is refused before the context opens", async (argv, message) => {
    const f = makeFake();
    await expect(f.run(argv)).rejects.toThrow(message);
    expect(f.opened()).toBe(0);
    expect(f.sent).toEqual([]);
  });

  test("a rehearsal case with no ruling read yet needs --script, and nothing is read without it", async () => {
    const f = makeFake();
    const caseId = seed(f);
    await expect(f.run(["pilot:settle", "--case", caseId])).rejects.toThrow(
      /--script.*the case was filed with/,
    );
    expect(f.fake.calls).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("a rehearsal case holding a read settles from it without --script", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "ruled",
      patch: { rulingValue: "2", rulingTied: 0, rulingRoundCount: 1, rulingReadAt: NOW - 3600 },
    });
    const [out] = await f.run(["pilot:settle", "--case", caseId]);
    expect(out).toMatchObject({ settlement: { action: "reject" } });
    expect(f.fake.calls).toEqual([]);
  });

  test("a tie the court finalised waits for the expiry; a tie in the appeal period polls again", async () => {
    const f = makeFake();
    const tie = { rulingValue: "0", rulingTied: 1, rulingRoundCount: 1, rulingReadAt: NOW };
    const final = seed(f, { status: "ruled", patch: { ...tie, rulingStatus: "Executed" } });
    const [a] = await f.run(["pilot:settle", "--case", final]);
    expect(a).toMatchObject({ settlement: { why: "tied" } });
    expect(String(a!.next)).toMatch(/the court finalised a tie: the escrow waits for the expiry/);
    expect(String(a!.next)).toMatch(/--claim-refund/);
    const open = seed(f, {
      status: "filed",
      patch: { ...tie, rulingStatus: "Appeal", jobId: "8" },
    });
    const [b] = await f.run(["pilot:settle", "--case", open]);
    expect(String(b!.next)).toMatch(/poll again/);
  });

  test("a case of another mode is refused, and the context is closed", async () => {
    const f = makeFake();
    const caseId = seed(f, { mode: "testnet" });
    await expect(f.run(["pilot:settle", "--case", caseId, "--yes"])).rejects.toThrow(
      /testnet case and this stage is rehearsal/,
    );
    expect(f.sent).toEqual([]);
    expect(f.closed()).toBe(1);
  });
});

/** The first second past the expiry and the clock margin. */
const REFUND_TIME = EXPIRES + 61;

/** A case at `status` that was never filed: no Kleros chain, no dispute id, no filing time. */
const seedUnfiled = (f: Fake, status: PilotStatus, patch: Partial<PilotCaseRecord> = {}) =>
  seed(f, { status, patch: { klerosChain: null, coreDisputeId: null, ...patch } });

describe("pilot:settle --claim-refund on a case funded but never filed", () => {
  test("without --yes it prints the escrow it read and what it would send, and sends nothing", async () => {
    const f = makeFake({ chainStatus: 1, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "funded");
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund"]);
    expect(out).toEqual({
      dryRun: true,
      caseId,
      mode: "rehearsal",
      status: "funded",
      settlement: { action: "claimRefund", reason: null, outcome: "refunded" },
      escrow: {
        status: "Funded",
        budgetAtomic: "500000",
        expiredAt: EXPIRES,
        expiresAt: "2026-11-04T00:00:00.000Z",
        refundMarginSeconds: 60,
      },
      send: {
        action: "claimRefund",
        jobId: "7",
        from: "0x0000000000000000000000000000000000000003",
        to: "0x0000000000000000000000000000000000000b0b",
      },
      next: "nothing was sent: run the same command with --yes to send it",
    });
    expect(f.sent).toEqual([]);
    expect(f.cases.find(caseId)).toMatchObject({ status: "funded", settleAction: null });
    expect(f.cases.events(caseId)).toEqual([]);
  });

  test("with --yes it sends claimRefund from the referee and the case ends failed, refunded", async () => {
    const f = makeFake({ chainStatus: 2, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "contested");
    const [line, out] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]);
    expect(line).toMatchObject({ opslog: "pilot_case_settled", caseId, action: "claimRefund" });
    expect(out).toMatchObject({
      caseId,
      status: "failed",
      settlement: { action: "claimRefund" },
      escrow: { status: "Submitted" },
      txHash: TX,
    });
    expect(f.sent).toEqual([
      {
        call: "claimRefund",
        args: [7n, { name: "referee" }, { onBroadcast: expect.any(Function) }],
      },
    ]);
    expect(f.cases.find(caseId)).toMatchObject({
      status: "failed",
      settleAction: "claimRefund",
      settleTxHash: TX,
      settledAt: REFUND_TIME,
      escrowOutcome: "refunded",
      error: "expired; escrow refunded by claimRefund",
    });
  });

  test("an escrow the chain already refunded: the dry run says what --yes would record, and --yes records it", async () => {
    const f = makeFake({ chainStatus: 5, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "submitted");
    const write = {
      status: "failed",
      settleAction: "none",
      settleTxHash: null,
      settledAt: REFUND_TIME,
      escrowOutcome: "refunded",
      error: "expired; escrow refunded elsewhere",
      event: {
        step: "settle",
        status: "chain",
        ref: null,
        detail: "the chain shows the job Expired, moved by a transaction this case never sent",
      },
    };
    const [dry] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund"]);
    expect(dry).toEqual({
      dryRun: true,
      caseId,
      mode: "rehearsal",
      status: "submitted",
      settlement: { action: "none", why: "refunded_elsewhere", outcome: "refunded" },
      escrow: expect.objectContaining({ status: "Expired" }),
      write,
      next: "nothing to send: the escrow is already refunded to the client; nothing was written: run the same command with --yes to record the refund and fail the case",
    });
    expect(f.cases.find(caseId)).toMatchObject({ status: "submitted", escrowOutcome: null });
    expect(f.cases.events(caseId)).toEqual([]);
    const [line, out] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]);
    expect(line).toMatchObject({
      opslog: "pilot_case_settled",
      caseId,
      action: "none",
      endsAt: "failed",
    });
    expect(out).toMatchObject({
      caseId,
      status: "failed",
      settlement: { action: "none", why: "refunded_elsewhere" },
      escrow: { status: "Expired" },
      wrote: write,
      next: "nothing to send: the escrow is already refunded to the client",
    });
    expect(f.sent).toEqual([]);
    expect(f.cases.find(caseId)).toMatchObject({
      status: "failed",
      escrowOutcome: "refunded",
      error: "expired; escrow refunded elsewhere",
    });
    // Once recorded, a run says there is nothing left to send or to record.
    const [again] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]);
    expect(again).toMatchObject({
      status: "failed",
      next: "nothing to send or to record: the escrow is already refunded to the client, and the case records it",
    });
  });

  test("a failed case's dry run says --yes records the refund on it", async () => {
    const f = makeFake({ chainStatus: 4, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "failed", { error: "stuck" });
    const [dry] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund"]);
    expect(dry).toMatchObject({
      dryRun: true,
      status: "failed",
      write: { status: "failed", escrowOutcome: "refunded" },
      next: "nothing to send: the escrow is already refunded to the client; nothing was written: run the same command with --yes to record the refund on the case",
    });
    expect((dry!.write as Record<string, unknown>).error).toBeUndefined();
  });

  test("before the expiry and its margin it is refused with the expiry time, and nothing is sent", async () => {
    const f = makeFake({ chainStatus: 1, nowSec: EXPIRES + 60 });
    const caseId = seedUnfiled(f, "funded");
    await expect(
      f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]),
    ).rejects.toThrow(/expires at 2026-11-04T00:00:00.000Z; no claimRefund until 60 seconds after/);
    expect(f.sent).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("a contested case whose filing started and went back is refunded and ends failed", async () => {
    const f = makeFake({ chainStatus: 2, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "contested", { filingStartedAt: NOW - 100, klerosChain: "fake" });
    const [, out] = await f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]);
    expect(out).toMatchObject({ caseId, status: "failed", txHash: TX });
    expect(f.sent.map((s) => s.call)).toEqual(["claimRefund"]);
    expect(f.cases.find(caseId)).toMatchObject({ status: "failed", escrowOutcome: "refunded" });
  });

  test.each<[PilotStatus, RegExp]>([
    ["filing", /is filing: a filing of it may still be running.*pilot:case set-ids.*pilot:dispute/],
    [
      "filing_unknown",
      /is filing_unknown: its dispute may exist on Kleros; record its ids with pilot:case set-ids.*pilot:case fail/,
    ],
  ])(
    "a case at %s is refused, naming the command that resolves it, and nothing is sent",
    async (status, words) => {
      const f = makeFake({ chainStatus: 2, nowSec: REFUND_TIME });
      const caseId = seedUnfiled(f, status, { filingStartedAt: NOW - 100, klerosChain: "fake" });
      await expect(
        f.run(["pilot:settle", "--case", caseId, "--claim-refund", "--yes"]),
      ).rejects.toThrow(words);
      expect(f.sent).toEqual([]);
      expect(f.closed()).toBe(1);
    },
  );

  test("without --claim-refund a case never filed is refused, as before", async () => {
    const f = makeFake({ chainStatus: 1, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "funded");
    await expect(f.run(["pilot:settle", "--case", caseId, "--yes"])).rejects.toThrow(
      new RegExp(`case ${caseId} is funded; a settlement starts at filed`),
    );
    expect(f.sent).toEqual([]);
  });

  test("the option says it also takes back the escrow of a case no ruling settles", () => {
    const program = new Command();
    registerPilotSettlementCommands(program, {});
    const settle = program.commands.find((c) => c.name() === "pilot:settle")!;
    expect(settle.options.find((o) => o.long === "--claim-refund")?.description).toBe(
      "take the expiry path: claimRefund, refused before the expiry; on a funded, submitted, contested or failed case it takes the escrow back and the case ends failed",
    );
  });

  test("--dropped on a case's claimRefund hash clears it and says to claim the refund again", async () => {
    const f = makeFake({ chainStatus: 1, nowSec: REFUND_TIME });
    const caseId = seedUnfiled(f, "funded", { settleAction: "claimRefund", settleTxHash: TX });
    f.cases.recordEvent(caseId, "settle", "sending", null, "claimRefund");
    f.db
      .prepare(
        "UPDATE pilot_case_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM pilot_case_events WHERE case_id = ?)",
      )
      .run(sqliteUtcTimestamp((REFUND_TIME - DROP_GRACE_SECONDS) * 1000), caseId);
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--dropped", "--yes"]);
    expect(out).toMatchObject({
      caseId,
      status: "funded",
      wrote: { status: "funded", settleTxHash: null, settleAction: "claimRefund" },
      next: `run pilot:settle --case ${caseId} --claim-refund to refund it again from the chain`,
    });
    expect(f.sent).toEqual([]);
    expect(f.cases.find(caseId)).toMatchObject({ status: "funded", settleTxHash: null });
  });
});

/** The referee's complete of job 7 with the case's reason, as the node holds it once mined. */
function minedComplete(f: Fake, receipt: "success" | "reverted" = "success"): void {
  f.node.txs.set(TX, {
    from: "0x0000000000000000000000000000000000000003",
    to: "0x0000000000000000000000000000000000000b0b",
    input: encodeFunctionData({
      abi: iErc8183JobAbi,
      functionName: "complete",
      args: [7n, reasonFor("287"), "0x"],
    }),
    blockNumber: 1n,
  });
  f.node.receipts.set(TX, { status: receipt, blockNumber: 1n });
}

/** A settle/sending event on the case, stamped `secondsAgo` before the command's clock. */
function sendingEvent(f: Fake, caseId: string, secondsAgo: number): void {
  f.cases.recordEvent(caseId, "settle", "sending", null, `complete ${reasonFor("287")}`);
  f.db
    .prepare(
      "UPDATE pilot_case_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM pilot_case_events WHERE case_id = ?)",
    )
    .run(sqliteUtcTimestamp((NOW - secondsAgo) * 1000), caseId);
}

const SETTLING_COMPLETE: Partial<PilotCaseRecord> = {
  settleAction: "complete",
  settleReason: reasonFor("287"),
};

describe("pilot:settle --tx", () => {
  test("without --yes it prints the proof and what it would write, and writes nothing", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "settling", patch: SETTLING_COMPLETE });
    minedComplete(f);
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--tx", TX]);
    expect(out).toEqual({
      dryRun: true,
      caseId,
      mode: "rehearsal",
      status: "settling",
      proof: {
        hash: TX,
        sender: "0x0000000000000000000000000000000000000003",
        target: "0x0000000000000000000000000000000000000b0b",
        action: "complete",
        jobId: "7",
        reason: reasonFor("287"),
        receipt: "success",
        blockTime: new Date((NOW - 60) * 1000).toISOString(),
      },
      write: {
        status: "settled",
        settleTxHash: TX,
        settleAction: "complete",
        settledAt: NOW - 60,
        escrowOutcome: "released",
        event: { step: "settle", status: "adopted", ref: TX, detail: "complete" },
      },
      next: "nothing was written: run the same command with --yes to record it",
    });
    expect(f.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });
    expect(f.cases.events(caseId)).toEqual([]);
    expect(f.sent).toEqual([]);
    expect(f.closed()).toBe(1);
  });

  test("with --yes it adopts the hash and sends nothing", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "settling", patch: SETTLING_COMPLETE });
    minedComplete(f);
    const outs = await f.run([
      "pilot:settle",
      "--case",
      caseId,
      "--tx",
      TX.toUpperCase().replace("0X", "0x"),
      "--yes",
    ]);
    const out = outs.find((o) => o.opslog === undefined);
    expect(out).toMatchObject({
      caseId,
      status: "settled",
      proof: { hash: TX, receipt: "success" },
      wrote: { status: "settled", settleTxHash: TX },
    });
    expect(out!.dryRun).toBeUndefined();
    expect(f.cases.find(caseId)).toMatchObject({
      status: "settled",
      settleTxHash: TX,
      settledAt: NOW - 60,
      escrowOutcome: "released",
    });
    expect(f.sent).toEqual([]);
  });

  test("with --yes on a reverted hash it says the next run decides again", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "settling", patch: SETTLING_COMPLETE });
    minedComplete(f, "reverted");
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--tx", TX, "--yes"]);
    expect(out).toMatchObject({
      status: "settling",
      wrote: { status: "settling", settleTxHash: TX },
      next: `the transaction reverted: run pilot:settle --case ${caseId} to decide again from the chain`,
    });
    expect(f.sent).toEqual([]);
  });

  test("naming the hash the row holds says so and changes nothing", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "settled",
      patch: { ...SETTLING_COMPLETE, settleTxHash: TX },
    });
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--tx", TX, "--yes"]);
    expect(out).toEqual({
      caseId,
      mode: "rehearsal",
      status: "settled",
      txHash: TX,
      next: "nothing to change: the case already holds this hash",
    });
    expect(f.cases.events(caseId)).toEqual([]);
  });

  test("a hash the proof refuses is refused in its words, and nothing is written", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "settling", patch: SETTLING_COMPLETE });
    await expect(f.run(["pilot:settle", "--case", caseId, "--tx", TX, "--yes"])).rejects.toThrow(
      new RegExp(`case ${caseId}'s settle transaction ${TX} could not be read from the node yet`),
    );
    expect(f.cases.find(caseId)).toMatchObject({ status: "settling", settleTxHash: null });
    expect(f.closed()).toBe(1);
  });
});

describe("pilot:settle --dropped", () => {
  test("without --yes it prints what it read and what it would write, and writes nothing", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "settling",
      patch: { ...SETTLING_COMPLETE, settleTxHash: TX },
    });
    sendingEvent(f, caseId, DROP_GRACE_SECONDS + 5);
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--dropped"]);
    expect(out).toEqual({
      dryRun: true,
      caseId,
      mode: "rehearsal",
      status: "settling",
      read: {
        hash: TX,
        action: "complete",
        receipt: null,
        transaction: null,
        sendAgeSeconds: DROP_GRACE_SECONDS + 5,
        escrowStatus: "Submitted",
      },
      write: {
        status: "settling",
        settleTxHash: null,
        settleAction: "complete",
        settleReason: reasonFor("287"),
        event: {
          step: "settle",
          status: "dropped",
          ref: TX,
          detail: `complete not mined and not pending ${DROP_GRACE_SECONDS + 5} s after its send; the escrow is Submitted`,
        },
      },
      next: "nothing was written: run the same command with --yes to clear the hash",
    });
    expect(f.cases.find(caseId)!.settleTxHash).toBe(TX);
    expect(f.sent).toEqual([]);
  });

  test("with --yes it clears the hash, keeps the action, and sends nothing", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "settling",
      patch: { ...SETTLING_COMPLETE, settleTxHash: TX },
    });
    sendingEvent(f, caseId, DROP_GRACE_SECONDS);
    const [out] = await f.run(["pilot:settle", "--case", caseId, "--dropped", "--yes"]);
    expect(out).toMatchObject({
      caseId,
      status: "settling",
      wrote: { settleTxHash: null, settleAction: "complete" },
      next: `run pilot:settle --case ${caseId} to decide again from the chain`,
    });
    expect(out!.dryRun).toBeUndefined();
    expect(f.cases.find(caseId)).toMatchObject({
      status: "settling",
      settleTxHash: null,
      settleAction: "complete",
    });
    expect(f.cases.events(caseId).at(-1)).toMatchObject({
      step: "settle",
      status: "dropped",
      ref: TX,
    });
    expect(f.sent).toEqual([]);
  });

  test("a hash the node has a receipt for is refused, and the context is closed", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "settling",
      patch: { ...SETTLING_COMPLETE, settleTxHash: TX },
    });
    sendingEvent(f, caseId, 3600);
    minedComplete(f);
    await expect(f.run(["pilot:settle", "--case", caseId, "--dropped", "--yes"])).rejects.toThrow(
      /has a receipt \(success\): it was mined, not dropped/,
    );
    expect(f.cases.find(caseId)!.settleTxHash).toBe(TX);
    expect(f.closed()).toBe(1);
  });
});

describe("pilot:settle --tx and --dropped: the options", () => {
  test.each([
    [["--tx", TX, "--dropped"], /--tx and --dropped cannot both be given/],
    [["--tx", TX, "--claim-refund"], /--tx and --claim-refund cannot both be given/],
    [["--tx", TX, "--accept-round", "2"], /--tx and --accept-round cannot both be given/],
    [["--dropped", "--claim-refund"], /--dropped and --claim-refund cannot both be given/],
    [["--dropped", "--accept-round", "2"], /--dropped and --accept-round cannot both be given/],
    [["--tx", "0x1234"], /--tx must be a transaction hash \(0x and 64 hex digits\)/],
    [["--tx", `0x${"g".repeat(64)}`], /--tx must be a transaction hash/],
    [["--tx", `${"ab".repeat(32)}`], /--tx must be a transaction hash/],
    [["--tx", `0x${"ab".repeat(33)}`], /--tx must be a transaction hash/],
  ])("%j is refused before the context opens", async (flags, message) => {
    const f = makeFake();
    await expect(
      f.run(["pilot:settle", "--case", "pc_000000000000", ...flags, "--yes"]),
    ).rejects.toThrow(message);
    expect(f.opened()).toBe(0);
    expect(f.sent).toEqual([]);
  });

  test("each says what it does in one line of help", () => {
    const program = new Command();
    registerPilotSettlementCommands(program, {});
    const settle = program.commands.find((c) => c.name() === "pilot:settle")!;
    const help = (flag: string) => settle.options.find((o) => o.long === flag)?.description;
    expect(help("--tx")).toBe(
      "adopt a settle transaction the case lost, once it is proven to be the referee's settle of the case's job; sends nothing",
    );
    expect(help("--dropped")).toBe(
      "clear the transaction hash of a settling case, or the claimRefund hash of a funded, submitted, contested or failed case, once the network is proven to have dropped it, so the next run decides again; sends nothing",
    );
  });

  test.each([[["--tx", TX]], [["--dropped"]]])(
    "%j on a case of another mode is refused, and the context is closed",
    async (flags) => {
      const f = makeFake();
      const caseId = seed(f, {
        mode: "testnet",
        status: "settling",
        patch: { ...SETTLING_COMPLETE, settleTxHash: TX },
      });
      await expect(f.run(["pilot:settle", "--case", caseId, ...flags, "--yes"])).rejects.toThrow(
        /testnet case and this stage is rehearsal/,
      );
      expect(f.closed()).toBe(1);
    },
  );

  test.each([[["--tx", TX]], [["--dropped"]]])(
    "%j with --script outside the rehearsal is refused as the plain settle refuses it",
    async (flags) => {
      const f = makeFake({ mode: "testnet" });
      const caseId = seed(f, {
        mode: "testnet",
        status: "settling",
        patch: { ...SETTLING_COMPLETE, settleTxHash: TX },
      });
      await expect(
        f.run(["pilot:settle", "--case", caseId, ...flags, "--script", "pay", "--yes"]),
      ).rejects.toThrow(/--script is accepted in rehearsal mode only/);
    },
  );
});

describe("pilot:case show", () => {
  test("prints a settle/sent event with its hash, the trail that names a send's transaction", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "settling", patch: SETTLING_COMPLETE });
    f.cases.recordEvent(caseId, "settle", "sending", null, `complete ${reasonFor("287")}`);
    f.cases.recordEvent(caseId, "settle", "sent", TX, "complete");
    const [out] = await f.run(["pilot:case", "show", caseId]);
    expect(out!.events).toContainEqual(
      expect.objectContaining({ step: "settle", status: "sent", ref: TX, detail: "complete" }),
    );
  });
});

describe("pilot:poll prints the settlement it would take", () => {
  test("a pay ruling on a submitted job reads as complete", async () => {
    const f = makeFake();
    const caseId = seed(f);
    const [out] = await f.run(["pilot:poll", "--case", caseId, "--script", "pay"]);
    expect(out).toMatchObject({
      outcome: { kind: "pay" },
      status: "ruled",
      settlement: { action: "complete", reason: reasonFor("287"), outcome: "released" },
    });
    expect(f.sent).toEqual([]);
  });

  test("a case without a job says the settlement cannot be decided", async () => {
    const f = makeFake();
    const caseId = seed(f, { patch: { jobId: null } });
    const [out] = await f.run(["pilot:poll", "--case", caseId, "--script", "pay"]);
    expect(out).toMatchObject({ settlement: { unavailable: "the case has no job id" } });
  });
});

/** `--by` is required; a refusal test about another flag still passes one. */
const withBy = (flags: string[]) =>
  flags.includes("--by") ? flags : [...flags, "--by", "an operator"];

describe("pilot:case set-ids", () => {
  test("--by is required, since a person attests the ids, and its absence opens nothing", async () => {
    const f = makeFake();
    await expect(
      f.run(["pilot:case", "set-ids", "pc_000000000000", "--core", "312", "--yes"]),
    ).rejects.toThrow(/--by/);
    expect(f.opened()).toBe(0);
  });

  test("moves a filing_unknown case to filed with the ids, the evidence unknown and the operator named", async () => {
    const f = makeFake({ mode: "testnet" });
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, klerosChain: "arbitrum-sepolia-testnet" },
      mode: "testnet",
    });
    const [out] = await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "312",
      "--local",
      "44",
      "--by",
      "an operator",
      "--yes",
    ]);
    expect(out).toMatchObject({ case: { status: "filed" } });
    expect(f.cases.find(caseId)).toMatchObject({
      status: "filed",
      coreDisputeId: "312",
      localDisputeId: "44",
      evidenceStatus: "unknown",
      klerosChain: "arbitrum-sepolia-testnet",
      filedAt: NOW,
    });
    expect(f.cases.events(caseId)).toContainEqual(
      expect.objectContaining({
        step: "set_ids",
        status: "ok",
        ref: "312",
        detail: "by an operator",
      }),
    );
  });

  test("moves a filing case to filed, naming who read the ids", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "filing", patch: { coreDisputeId: null } });
    await f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "operator", "--yes"]);
    expect(f.cases.find(caseId)).toMatchObject({
      status: "filed",
      coreDisputeId: "312",
      localDisputeId: null,
      klerosChain: "fake",
    });
    expect(f.cases.events(caseId)).toContainEqual(
      expect.objectContaining({ step: "set_ids", detail: "by operator" }),
    );
  });

  test("without --yes it changes nothing", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "filing", patch: { coreDisputeId: null } });
    const [out] = await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "312",
      "--by",
      "an operator",
    ]);
    expect(out).toMatchObject({
      dryRun: true,
      from: "filing",
      to: "filed",
      filingStartedAt: null,
      next: "nothing was changed: open the Court URL and check that its two alias addresses are this case's buyer and seller, printed here; then run the same command with --yes",
    });
    expect(f.cases.find(caseId)).toMatchObject({ status: "filing", coreDisputeId: null });
    expect(f.cases.events(caseId)).toEqual([]);
  });

  test("the dry run shows when the filing started, as a date", async () => {
    const f = makeFake();
    const startedAt = NOW - 3600;
    const caseId = seed(f, {
      status: "filing",
      patch: { coreDisputeId: null, filingStartedAt: startedAt },
    });
    const [out] = await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "312",
      "--by",
      "an operator",
    ]);
    expect(out).toMatchObject({
      dryRun: true,
      filingStartedAt: new Date(startedAt * 1000).toISOString(),
    });
  });

  test("a case of another mode than the box's is refused, in the words the poll and the settle use", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing",
      mode: "testnet",
      patch: { coreDisputeId: null, klerosChain: "arbitrum-sepolia-testnet" },
    });
    await expect(
      f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]),
    ).rejects.toThrow(new RegExp(`case ${caseId} is a testnet case and this stage is rehearsal`));
    expect(f.cases.find(caseId)!.status).toBe("filing");
  });

  test("a filing keeps its local id and its filing time when only the core id is recorded", async () => {
    const f = makeFake();
    const filedAt = NOW - 3600;
    const caseId = seed(f, {
      status: "filing",
      patch: { coreDisputeId: null, localDisputeId: "44", filedAt },
    });
    await f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]);
    expect(f.cases.find(caseId)).toMatchObject({
      status: "filed",
      coreDisputeId: "312",
      localDisputeId: "44",
      filedAt,
    });
  });

  test("the dry run prints the local id the row holds when --local is omitted", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing",
      patch: { coreDisputeId: null, localDisputeId: "44", filedAt: NOW - 3600 },
    });
    const [out] = await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "312",
      "--by",
      "an operator",
    ]);
    expect(out).toMatchObject({ dryRun: true, coreDisputeId: "312", localDisputeId: "44" });
    expect(f.cases.find(caseId)).toMatchObject({
      status: "filing",
      coreDisputeId: null,
      localDisputeId: "44",
    });
  });

  test("a local id that differs from the one the row holds is refused", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing",
      patch: { coreDisputeId: null, localDisputeId: "44", filedAt: NOW - 3600 },
    });
    for (const yes of [[], ["--yes"]])
      await expect(
        f.run([
          "pilot:case",
          "set-ids",
          caseId,
          "--core",
          "312",
          "--local",
          "45",
          "--by",
          "an operator",
          ...yes,
        ]),
      ).rejects.toThrow(/already holds local dispute 44/);
    expect(f.cases.find(caseId)).toMatchObject({ status: "filing", localDisputeId: "44" });
  });

  test("refuses a row whose Kleros chain was never written", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, klerosChain: null },
    });
    await expect(
      f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]),
    ).rejects.toThrow(/never at filing/);
    expect(f.cases.find(caseId)!.status).toBe("filing_unknown");
  });

  test.each<[PilotStatus]>([["contested"], ["filed"], ["ruled"], ["settled"]])(
    "refuses a case at %s",
    async (status) => {
      const f = makeFake();
      const caseId = seed(f, { status });
      await expect(
        f.run(["pilot:case", "set-ids", caseId, "--core", "287", "--by", "an operator", "--yes"]),
      ).rejects.toThrow(/filing or filing_unknown/);
    },
  );

  test("refuses a different dispute id than the one the row already holds", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "filing_unknown" });
    await expect(
      f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]),
    ).rejects.toThrow(/already holds dispute 287/);
    expect(f.cases.find(caseId)!.status).toBe("filing_unknown");
  });

  test("refuses while the filing may still be landing, naming the minutes left", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, filingStartedAt: NOW - 10 * 60 },
    });
    for (const yes of [[], ["--yes"]])
      await expect(
        f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", ...yes]),
      ).rejects.toThrow(/filing started 10 minutes ago.*wait 20 more minutes/);
    expect(f.cases.find(caseId)!.status).toBe("filing_unknown");
  });

  test.each([
    [60, /filing started 1 minute ago.*wait 29 more minutes,/],
    [29 * 60, /filing started 29 minutes ago.*wait 1 more minute,/],
    [2 * 60, /filing started 2 minutes ago.*wait 28 more minutes,/],
  ])(
    "the window message counts the minutes in the singular and the plural (%i s)",
    async (age, message) => {
      const f = makeFake();
      const caseId = seed(f, {
        status: "filing_unknown",
        patch: { coreDisputeId: null, filingStartedAt: NOW - age },
      });
      await expect(
        f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]),
      ).rejects.toThrow(message);
    },
  );

  test("accepts a filing that started 30 minutes ago", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, filingStartedAt: NOW - 30 * 60 },
    });
    await f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]);
    expect(f.cases.find(caseId)!.status).toBe("filed");
  });

  test("refuses a dispute id another case holds on the same Kleros chain", async () => {
    const f = makeFake();
    seed(f, {
      status: "filed",
      patch: { jobId: "8", coreDisputeId: "312", klerosChain: "arbitrum-sepolia-testnet" },
    });
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, klerosChain: "arbitrum-sepolia-testnet" },
    });
    await expect(
      f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]),
    ).rejects.toThrow(/dispute 312 on arbitrum-sepolia-testnet.*pc_/);
    expect(f.cases.find(caseId)!.status).toBe("filing_unknown");
  });

  test("a holder that failed is named with its status, and the refusal says to correct it by hand", async () => {
    const f = makeFake();
    const holder = seed(f, {
      status: "failed",
      patch: { jobId: "8", coreDisputeId: "312", klerosChain: "arbitrum-sepolia-testnet" },
    });
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, klerosChain: "arbitrum-sepolia-testnet" },
    });
    await expect(
      f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]),
    ).rejects.toThrow(
      new RegExp(
        `held by case ${holder} \\(at failed\\); correct that case by hand before recording the id here`,
      ),
    );
  });

  test("two rehearsal cases may hold the same core id, since every rehearsal numbers its first dispute alike", async () => {
    const f = makeFake();
    const other = seed(f, { status: "filed", patch: { jobId: "8", coreDisputeId: "1000" } });
    const caseId = seed(f, { status: "filing_unknown", patch: { coreDisputeId: null } });
    await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "1000",
      "--by",
      "an operator",
      "--yes",
    ]);
    expect(f.cases.find(caseId)).toMatchObject({ status: "filed", coreDisputeId: "1000" });
    expect(f.cases.find(other)!.coreDisputeId).toBe("1000");
  });

  test("accepts the same dispute id when the other case is on another Kleros chain", async () => {
    const f = makeFake();
    seed(f, {
      status: "filed",
      patch: { jobId: "8", coreDisputeId: "312", klerosChain: "arbitrum-one" },
    });
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, klerosChain: "arbitrum-sepolia-testnet" },
    });
    await f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]);
    expect(f.cases.find(caseId)!.status).toBe("filed");
  });

  test("a case may hold its own dispute id", async () => {
    const f = makeFake();
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: "312", klerosChain: "arbitrum-sepolia-testnet" },
    });
    await f.run(["pilot:case", "set-ids", caseId, "--core", "312", "--by", "an operator", "--yes"]);
    expect(f.cases.find(caseId)!.status).toBe("filed");
  });

  test("the dry run shows the Court link and both parties", async () => {
    const f = makeFake({ mode: "testnet" });
    const caseId = seed(f, {
      status: "filing_unknown",
      patch: { coreDisputeId: null, klerosChain: "arbitrum-sepolia-testnet" },
      mode: "testnet",
    });
    const [out] = await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "312",
      "--by",
      "an operator",
    ]);
    expect(out).toMatchObject({
      dryRun: true,
      courtUrl: klerosCaseUrl("arbitrum-sepolia-testnet", "312"),
      buyerAddress: "0x0000000000000000000000000000000000000001",
      sellerAddress: "0x0000000000000000000000000000000000000002",
    });
  });

  test("the dry run of a fake-chain case has no Court link", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "filing", patch: { coreDisputeId: null } });
    const [out] = await f.run([
      "pilot:case",
      "set-ids",
      caseId,
      "--core",
      "312",
      "--by",
      "an operator",
    ]);
    expect(out).toMatchObject({ dryRun: true, courtUrl: null });
  });

  test.each([
    [["--core", "0"], /--core/],
    [["--core", (2n ** 256n).toString()], /--core/],
  ])("%j is refused before the context opens", async (flags, message) => {
    const f = makeFake();
    await expect(
      f.run(["pilot:case", "set-ids", "pc_000000000000", ...withBy(flags), "--yes"]),
    ).rejects.toThrow(message);
    expect(f.opened()).toBe(0);
  });

  test("accepts the largest 256-bit dispute id", async () => {
    const f = makeFake();
    const caseId = seed(f, { status: "filing", patch: { coreDisputeId: null } });
    const max = (2n ** 256n - 1n).toString();
    await f.run(["pilot:case", "set-ids", caseId, "--core", max, "--by", "an operator", "--yes"]);
    expect(f.cases.find(caseId)!.coreDisputeId).toBe(max);
  });

  test.each([
    [["--core", "01"], /--core/],
    [["--core", "-3"], /--core/],
    [["--core", "312", "--local", "x"], /--local/],
    [["--core", "312", "--by", "a\u0007b"], /--by/],
  ])("%j is refused before the context opens", async (flags, message) => {
    const f = makeFake();
    await expect(
      f.run(["pilot:case", "set-ids", "pc_000000000000", ...withBy(flags), "--yes"]),
    ).rejects.toThrow(message);
    expect(f.opened()).toBe(0);
  });
});
