/**
 * `pilot:settle` and `pilot:case set-ids` over a fake PilotContext whose case table is a real
 * SQLite repository in memory, with a stub job adapter and the scripted fake Dispute Service:
 * no chain, no network.
 */
import Database from "better-sqlite3";
import { Command } from "commander";
import type { Hex } from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import { klerosCaseUrl } from "../../src/adapters/kleros/deployments";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import { registerPilotCommands } from "../../src/cli/pilot";
import { registerPilotSettlementCommands } from "../../src/cli/pilotSettlement";
import type { Config } from "../../src/config/env";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import type { KlerosStage, PilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { reasonFor } from "../../src/pilot/settlement";
import type { PilotCaseRecord, PilotMode, PilotStatus } from "../../src/pilot/types";

/** Spelled by code point: the repository keeps the character itself out of its sources. */
const EM_DASH = String.fromCodePoint(0x2014);
/** 2026-10-28T00:00:00Z, in seconds. */
const NOW = 1_793_145_600;
const EXPIRES = NOW + 7 * 86_400;
const TX = `0x${"ab".repeat(32)}` as Hex;

afterEach(() => vi.restoreAllMocks());

function makeFake(o: { chainStatus?: number; mode?: PilotMode } = {}) {
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
  const chain = {
    job,
    publicClient: { getChainId: async () => 5042002, getBalance: async () => 1n },
    jobContract: "0x0000000000000000000000000000000000000b0b",
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
    if (argv[0] === "pilot:case") registerPilotCommands(program, open, { now: () => NOW });
    else
      registerPilotSettlementCommands(program, {
        open,
        buildStage: () => stage,
        buildChain: () => chain,
        now: () => NOW * 1000,
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
  return { cases, fake, sent, escrow, run, opened: () => opens, closed: () => closes };
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
    expect(f.sent).toEqual([{ call: "complete", args: [7n, reasonFor("287")] }]);
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
    const f = makeFake();
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
    expect(out).toMatchObject({ dryRun: true, from: "filing", to: "filed" });
    expect(f.cases.find(caseId)).toMatchObject({ status: "filing", coreDisputeId: null });
    expect(f.cases.events(caseId)).toEqual([]);
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
    const f = makeFake();
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
