/**
 * `pilot:poll` over a fake PilotContext whose case table is a real SQLite repository in memory,
 * with the scripted fake Dispute Service and an injected clock and sleep: no chain, no network,
 * no wait.
 */
import Database from "better-sqlite3";
import { Command } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import type { KlerosDisputeService } from "../../src/adapters/kleros/disputeService";
import { FakeDisputeService, type FakeScript } from "../../src/adapters/kleros/fakeDisputeService";
import { registerPilotSettlementCommands } from "../../src/cli/pilotSettlement";
import type { Config } from "../../src/config/env";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import type { KlerosStage } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import type { KlerosChainOnRow, PilotCaseRecord, PilotMode } from "../../src/pilot/types";

/** Spelled by code point: the repository keeps the character itself out of its sources. */
const EM_DASH = String.fromCodePoint(0x2014);
/** 2026-10-28T00:00:00Z, in milliseconds. */
const T0 = 1_793_145_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

interface Fake {
  cases: SqlitePilotCaseRepository;
  fake: FakeDisputeService;
  clock: { now: number };
  stages: number;
  opened: () => number;
  closed: () => number;
  run: (argv: string[]) => Promise<unknown[]>;
}

async function makeFake(
  o: { script?: FakeScript; mode?: PilotMode; stage?: KlerosStage } = {},
): Promise<Fake & { caseId: string }> {
  const clock = { now: T0 };
  const fake = new FakeDisputeService({ script: o.script ?? "pay", now: () => clock.now });
  const created = await fake.createDispute({ aliases: {} });
  if (created.status !== "mined") throw new Error("the fake did not mine the dispute");
  const db = new Database(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const mode = o.mode ?? "rehearsal";
  const cfg = { pilot: { mode } } as unknown as Config;
  let opens = 0;
  let closes = 0;
  const ctx = { cfg, db, cases, close: () => closes++ } as unknown as PilotContext;
  const stage: KlerosStage = o.stage ?? {
    mode: "rehearsal",
    service: fake,
    deployment: null,
    cap: null,
    flag: null,
  };
  const out: Fake = {
    cases,
    fake,
    clock,
    stages: 0,
    opened: () => opens,
    closed: () => closes,
    run: async (argv) => {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      registerPilotSettlementCommands(program, {
        open: () => {
          opens++;
          return ctx;
        },
        buildStage: () => {
          out.stages++;
          return stage;
        },
        now: () => clock.now,
        sleep: async (ms) => {
          clock.now += ms;
        },
      });
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
      try {
        await program.parseAsync(["node", "cli", ...argv]);
      } finally {
        vi.mocked(console.log).mockRestore();
      }
      for (const l of logs) expect(l).not.toContain(EM_DASH);
      return logs.map((l) => JSON.parse(l) as unknown);
    },
  };
  const caseId = seed(cases, { mode, coreDisputeId: created.coreDisputeId });
  return { ...out, caseId };
}

function seed(
  cases: SqlitePilotCaseRepository,
  o: { mode: PilotMode; coreDisputeId: string; klerosChain?: KlerosChainOnRow },
): string {
  const caseId = newCaseId();
  cases.insert({
    caseId,
    label: "test case 1",
    mode: o.mode,
    chainId: 5042002,
    jobContract: "0x0000000000000000000000000000000000000b0b",
    buyerAddress: "0x0000000000000000000000000000000000000001",
    buyerAgentId: "11",
    sellerAddress: "0x0000000000000000000000000000000000000002",
    sellerAgentId: "12",
    refereeAddress: "0x0000000000000000000000000000000000000003",
    budgetAtomic: "2000000",
    description: "a test job",
    expiredAt: Math.floor(T0 / 1000) + 7 * 86_400,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  const patch: Partial<PilotCaseRecord> = {
    klerosChain: o.klerosChain ?? "fake",
    coreDisputeId: o.coreDisputeId,
  };
  cases.advance(caseId, "created", "filed", patch);
  return caseId;
}

const disputeGets = (f: Fake) => f.fake.calls.filter((c) => c.tool === "dispute_get");

describe("pilot:poll: one read", () => {
  test("prints the read, the outcome, the row's status and the settlement seam", async () => {
    const f = await makeFake();
    const [out] = await f.run(["pilot:poll", "--case", f.caseId]);
    expect(out).toMatchObject({
      caseId: f.caseId,
      read: {
        status: "Evidence",
        ruling: "0",
        tied: true,
        roundCount: 1,
        note: null,
      },
      outcome: { kind: "pending" },
      status: "filed",
      settlement: "decided by pilot:settle",
    });
    expect((out as { read: { deadline: string } }).read.deadline).toBe(
      new Date(T0 + 10 * 60_000).toISOString(),
    );
    expect(disputeGets(f)).toHaveLength(1);
    expect(f.opened()).toBe(1);
    expect(f.closed()).toBe(1);
  });

  test("without --watch it reads once even when the outcome is pending", async () => {
    const f = await makeFake({ script: "stalled" });
    const outs = await f.run(["pilot:poll", "--case", f.caseId]);
    expect(outs).toHaveLength(1);
    expect(disputeGets(f)).toHaveLength(1);
  });
});

describe("pilot:poll --watch", () => {
  test("prints each read, then the outcome with the row ruled", async () => {
    const f = await makeFake();
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--watch"]);
    expect(outs).toHaveLength(5);
    expect(outs.slice(0, 4).map((o) => (o as { read: { status: string } }).read.status)).toEqual([
      "Evidence",
      "Commit",
      "Vote",
      "Appeal",
    ]);
    expect(outs[4]).toMatchObject({
      caseId: f.caseId,
      reads: 4,
      capped: false,
      outcome: { kind: "pay" },
      status: "ruled",
      settlement: "decided by pilot:settle",
    });
    expect(f.closed()).toBe(1);
  });

  test("a stalled case caps out at --max-minutes as pending with period_overdue", async () => {
    const f = await makeFake({ script: "stalled" });
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--watch", "--max-minutes", "2"]);
    const reads = outs.filter((o) => (o as { read?: unknown }).read !== undefined) as {
      read: { status: string; note: string | null };
    }[];
    // Reads at 0, 0.5, 1, 1.5 and 2 minutes; the Vote reads carry a deadline an hour past.
    expect(reads.map((r) => [r.read.status, r.read.note])).toEqual([
      ["Evidence", null],
      ["Commit", null],
      ["Vote", "period_overdue"],
      ["Vote", "period_overdue"],
      ["Vote", "period_overdue"],
    ]);
    const final = outs.find((o) => (o as { settlement?: string }).settlement !== undefined);
    expect(final).toMatchObject({
      reads: 5,
      capped: true,
      outcome: { kind: "pending" },
      status: "filed",
    });
    expect(outs.some((o) => (o as { opslog?: string }).opslog === "pilot_poll_capped")).toBe(true);
  });

  test("the watch is re-runnable on a row it already ruled", async () => {
    const f = await makeFake();
    await f.run(["pilot:poll", "--case", f.caseId, "--watch"]);
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--watch"]);
    expect(outs.at(-1)).toMatchObject({ reads: 1, outcome: { kind: "pay" }, status: "ruled" });
  });
});

describe("pilot:poll: the flags and refusals", () => {
  test.each([
    [["pilot:poll"], /--case/],
    [["pilot:poll", "--case", "pc_nothex"], /pilot case id/],
    [["pilot:poll", "--case", "pc_000000000000", "--watch", "--max-minutes", "0"], /--max-minutes/],
    [
      ["pilot:poll", "--case", "pc_000000000000", "--watch", "--max-minutes", "1.5"],
      /--max-minutes/,
    ],
    [["pilot:poll", "--case", "pc_000000000000", "--max-minutes", "5"], /--max-minutes.*--watch/],
  ])("%j is refused before the context opens", async (argv, message) => {
    const f = await makeFake();
    await expect(f.run(argv)).rejects.toThrow(message);
    expect(f.opened()).toBe(0);
    expect(disputeGets(f)).toEqual([]);
  });

  test("an unknown case is refused and the context is closed", async () => {
    const f = await makeFake();
    await expect(f.run(["pilot:poll", "--case", "pc_000000000000"])).rejects.toThrow(
      /no pilot case/,
    );
    expect(f.closed()).toBe(1);
    expect(disputeGets(f)).toEqual([]);
  });

  test("a row whose chain is not the stage's is refused with zero requests", async () => {
    const reads: unknown[] = [];
    const service = {
      deployment: "testnet",
      getDispute: async (p: unknown) => {
        reads.push(p);
        throw new Error("must not be read");
      },
    } as unknown as KlerosDisputeService;
    const f = await makeFake({
      mode: "testnet",
      stage: {
        mode: "testnet",
        service,
        deployment: deploymentFor("testnet"),
        cap: 10,
        flag: "--testnet",
      },
    });
    const other = seed(f.cases, {
      mode: "testnet",
      coreDisputeId: "287",
      klerosChain: "arbitrum-one",
    });
    await expect(f.run(["pilot:poll", "--case", other])).rejects.toThrow(/refusing.*arbitrum-one/);
    expect(reads).toEqual([]);
  });

  test("a read that fails is reported in one line without an em dash", async () => {
    const service = {
      deployment: "testnet",
      getDispute: async () => {
        throw new Error(`Kleros dispute_get ${EM_DASH} the service did not answer`);
      },
    } as unknown as KlerosDisputeService;
    const f = await makeFake({
      mode: "testnet",
      stage: {
        mode: "testnet",
        service,
        deployment: deploymentFor("testnet"),
        cap: 10,
        flag: "--testnet",
      },
    });
    const row = seed(f.cases, {
      mode: "testnet",
      coreDisputeId: "186",
      klerosChain: "arbitrum-sepolia-testnet",
    });
    const err = await f.run(["pilot:poll", "--case", row]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/did not answer/);
    expect((err as Error).message).not.toContain(EM_DASH);
    expect(f.closed()).toBe(1);
  });
});
