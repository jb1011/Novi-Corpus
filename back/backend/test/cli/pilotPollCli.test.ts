/**
 * `pilot:poll` over a fake PilotContext whose case table is a real SQLite repository in memory,
 * with the scripted fake Dispute Service and an injected clock and sleep: no chain, no network,
 * no wait.
 */
import Database from "better-sqlite3";
import { Command } from "commander";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import type { DisputeRead, KlerosDisputeService } from "../../src/adapters/kleros/disputeService";
import {
  KlerosHttpError,
  KlerosRefusal,
  KlerosTransportError,
  KlerosWrongDeploymentError,
} from "../../src/adapters/kleros/errors";
import { FakeDisputeService, type FakeScript } from "../../src/adapters/kleros/fakeDisputeService";
import { registerPilotSettlementCommands } from "../../src/cli/pilotSettlement";
import type { Config } from "../../src/config/env";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import type { KlerosStage, PilotChain } from "../../src/pilot/composition";
import type { PilotContext } from "../../src/pilot/context";
import { type EscrowState, reasonFor } from "../../src/pilot/settlement";
import type { KlerosChainOnRow, PilotCaseRecord, PilotMode } from "../../src/pilot/types";
import { PLATFORM_FUNDS_MESSAGE } from "../../src/workflow/publicError";

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
  o: {
    script?: FakeScript;
    mode?: PilotMode;
    stage?: KlerosStage;
    realStage?: boolean;
    /** The job contract the configuration names; default the one the seeded rows were made on. */
    jobContract?: string;
    /** The chain id the configuration names; default the seeded rows'. */
    chainId?: number;
    /** Fields of the escrow the chain answers that differ from the seeded rows' job. */
    escrow?: Partial<EscrowState>;
    /** A failure the escrow read throws instead of answering. */
    escrowError?: Error;
  } = {},
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
        ...(o.realStage
          ? {}
          : {
              buildStage: () => {
                out.stages++;
                return stage;
              },
            }),
        // The escrow the settlement line is decided on: a submitted job a week from expiry, made
        // for the seeded rows' buyer, referee, expiry and budget, on their chain and contract.
        buildChain: () =>
          ({
            jobContract: o.jobContract ?? JOB_CONTRACT,
            chainId: o.chainId ?? 5042002,
            job: {
              escrowState: async () => {
                if (o.escrowError) throw o.escrowError;
                return {
                  status: 2,
                  budget: 2_000_000n,
                  expiredAt: BigInt(Math.floor(T0 / 1000) + 7 * 86_400),
                  client: "0x0000000000000000000000000000000000000001",
                  evaluator: "0x0000000000000000000000000000000000000003",
                  ...o.escrow,
                };
              },
            },
          }) as unknown as PilotChain,
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

const JOB_CONTRACT = "0x0000000000000000000000000000000000000b0b";

let jobIds = 0;

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
    jobContract: JOB_CONTRACT,
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
    // The job id is unique per row; the stub escrow answers the same job for every id.
    jobId: String(++jobIds),
    klerosChain: o.klerosChain ?? "fake",
    coreDisputeId: o.coreDisputeId,
  };
  cases.advance(caseId, "created", "filed", patch);
  return caseId;
}

const disputeGets = (f: Fake) => f.fake.calls.filter((c) => c.tool === "dispute_get");

describe("pilot:poll: one read", () => {
  test("prints the read, the outcome, the row's status and the settlement it would take", async () => {
    const f = await makeFake();
    const [out] = await f.run(["pilot:poll", "--case", f.caseId, "--script", "pay"]);
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
      settlement: { action: "none", why: "ruling_pending" },
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
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--script", "stalled"]);
    expect(outs).toHaveLength(1);
    expect(disputeGets(f)).toHaveLength(1);
  });
});

describe("pilot:poll: the settlement line checks the job is the case's own", () => {
  test("a job contract that is not the configured one prints unavailable, naming it, and sends nothing", async () => {
    const other = "0x00000000000000000000000000000000000000f1";
    const f = await makeFake({ jobContract: other });
    const [out] = await f.run(["pilot:poll", "--case", f.caseId, "--script", "pay"]);
    const settlement = (out as { settlement: { unavailable?: string } }).settlement;
    expect(Object.keys(settlement)).toEqual(["unavailable"]);
    expect(settlement.unavailable).toContain(JOB_CONTRACT);
    expect(settlement.unavailable).toContain(other);
    expect(settlement.unavailable).toMatch(/job contract/);
    expect(f.cases.find(f.caseId)!.settleTxHash).toBeNull();
  });

  test("an escrow read that fails prints unavailable in public words, with no file path", async () => {
    const f = await makeFake({
      escrowError: new Error(
        "ENOENT: no such file or directory, open /var/lib/arc/node/state.json",
      ),
    });
    const [out] = await f.run(["pilot:poll", "--case", f.caseId, "--script", "pay"]);
    expect(out).toMatchObject({
      outcome: { kind: "pending" },
      settlement: { unavailable: "ENOENT: no such file or directory, open state.json" },
    });
    expect(JSON.stringify(out)).not.toContain("/var/lib");
    expect(f.closed()).toBe(1);
  });

  const OTHER = "0x00000000000000000000000000000000000000f1";
  const EXPIRY = Math.floor(T0 / 1000) + 7 * 86_400;
  test.each<[string, Parameters<typeof makeFake>[0], string]>([
    [
      "configured chain id",
      { chainId: 1 },
      "is on chain id 5042002 and the configured chain id is 1",
    ],
    [
      "client",
      { escrow: { client: OTHER } },
      `client is ${OTHER} and the case's buyer is 0x0000000000000000000000000000000000000001`,
    ],
    [
      "evaluator",
      { escrow: { evaluator: OTHER } },
      `evaluator is ${OTHER} and the case's referee is 0x0000000000000000000000000000000000000003`,
    ],
    [
      "expiry",
      { escrow: { expiredAt: BigInt(EXPIRY + 1) } },
      `expiredAt is ${EXPIRY + 1} and the case's expiredAt is ${EXPIRY}`,
    ],
    [
      "budget",
      { escrow: { budget: 2_000_001n } },
      "budget is 2000001 and the case's budget is 2000000",
    ],
  ])(
    "a job whose %s is not the case's prints unavailable, naming both values",
    async (_name, o, words) => {
      const f = await makeFake(o);
      const [out] = await f.run(["pilot:poll", "--case", f.caseId, "--script", "pay"]);
      const settlement = (out as { settlement: { unavailable?: string } }).settlement;
      expect(Object.keys(settlement)).toEqual(["unavailable"]);
      expect(settlement.unavailable).toContain(words);
    },
  );
});

describe("pilot:poll --watch", () => {
  test("prints each read, then the outcome with the row ruled", async () => {
    const f = await makeFake();
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--watch", "--script", "pay"]);
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
      settlement: {
        action: "complete",
        reason: reasonFor(f.cases.find(f.caseId)!.coreDisputeId!),
        outcome: "released",
      },
    });
    expect(f.closed()).toBe(1);
  });

  test("a stalled case caps out at --max-minutes as pending with period_overdue", async () => {
    const f = await makeFake({ script: "stalled" });
    const outs = await f.run([
      "pilot:poll",
      "--case",
      f.caseId,
      "--watch",
      "--max-minutes",
      "2",
      "--script",
      "stalled",
    ]);
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
    const final = outs.find((o) => (o as { settlement?: unknown }).settlement !== undefined);
    expect(final).toMatchObject({
      reads: 5,
      capped: true,
      outcome: { kind: "pending" },
      status: "filed",
    });
    expect(outs.some((o) => (o as { opslog?: string }).opslog === "pilot_poll_capped")).toBe(true);
  });

  test("a second poll on a ruled rehearsal case is refused and the ruling stays as it was", async () => {
    const f = await makeFake({ script: "refund" });
    await f.run(["pilot:poll", "--case", f.caseId, "--watch", "--script", "refund"]);
    const ruled = f.cases.find(f.caseId)!;
    expect(ruled).toMatchObject({ status: "ruled", rulingValue: "2" });
    const reads = disputeGets(f).length;
    await expect(
      f.run(["pilot:poll", "--case", f.caseId, "--watch", "--script", "refund"]),
    ).rejects.toThrow(/ruled \(refund\)/);
    await expect(f.run(["pilot:poll", "--case", f.caseId, "--script", "refund"])).rejects.toThrow(
      /ruled \(refund\)/,
    );
    expect(disputeGets(f)).toHaveLength(reads);
    expect(f.cases.find(f.caseId)).toEqual(ruled);
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
    await expect(
      f.run(["pilot:poll", "--case", "pc_000000000000", "--script", "pay"]),
    ).rejects.toThrow(/no pilot case/);
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

/** A testnet fake whose service answers every read with `answer()`, with one filed row on it. */
async function testnetWith(answer: () => DisputeRead) {
  const service = {
    deployment: "testnet",
    getDispute: async () => answer(),
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
  const caseId = seed(f.cases, {
    mode: "testnet",
    coreDisputeId: "186",
    klerosChain: "arbitrum-sepolia-testnet",
  });
  return { ...f, caseId };
}

function voteRead(deadline: string | null): DisputeRead {
  return {
    status: "Vote",
    ruling: "0",
    tied: true,
    ruled: false,
    roundCount: 1,
    rulingOptions: [
      { value: "0x01", title: "Pay the provider" },
      { value: "0x02", title: "Refund the client" },
    ],
    deadline,
    unresolvedFields: [],
    raw: {},
  };
}

describe("pilot:poll on a real deployment", () => {
  test("the watch is re-runnable on a testnet case it already ruled", async () => {
    const f = await testnetWith(() => ({
      ...voteRead(null),
      status: "Appeal",
      ruling: "1",
      tied: false,
    }));
    const first = await f.run(["pilot:poll", "--case", f.caseId, "--watch"]);
    expect(first.at(-1)).toMatchObject({ outcome: { kind: "pay" }, status: "ruled" });
    const again = await f.run(["pilot:poll", "--case", f.caseId, "--watch"]);
    expect(again.at(-1)).toMatchObject({ reads: 1, outcome: { kind: "pay" }, status: "ruled" });
  });
});

describe("pilot:poll: the read's note", () => {
  test.each([
    [19, null],
    [20, null],
    [21, "period_overdue"],
  ])("a deadline %i minutes behind the clock prints the note %s", async (minutes, note) => {
    const f = await testnetWith(() => voteRead(new Date(T0 - minutes * 60_000).toISOString()));
    const [out] = await f.run(["pilot:poll", "--case", f.caseId]);
    expect(out).toMatchObject({ read: { note }, outcome: { kind: "pending" } });
  });

  test("a deadline that is not a date prints deadline_unreadable", async () => {
    const f = await testnetWith(() => voteRead("soon"));
    const [out] = await f.run(["pilot:poll", "--case", f.caseId]);
    expect(out).toMatchObject({ read: { deadline: "soon", note: "deadline_unreadable" } });
  });

  test("no deadline prints no note", async () => {
    const f = await testnetWith(() => voteRead(null));
    const [out] = await f.run(["pilot:poll", "--case", f.caseId]);
    expect(out).toMatchObject({ read: { deadline: null, note: null } });
  });
});

describe("pilot:poll: one read that fails at Kleros", () => {
  test("is reported in the service's redacted words, never the platform's sentence or a file path, and leaves one read_failed event", async () => {
    const f = await testnetWith(() => {
      throw new KlerosTransportError(
        "Kleros dispute_get: insufficient funds for gas at /var/lib/kleros/transport/client.js",
      );
    });
    const err = await f.run(["pilot:poll", "--case", f.caseId]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Kleros dispute_get: insufficient funds for gas at client.js",
    );
    expect((err as Error).message).not.toContain("/var/lib");
    expect((err as Error).message).not.toContain(PLATFORM_FUNDS_MESSAGE);
    expect(f.cases.events(f.caseId)).toEqual([
      expect.objectContaining({
        step: "ruling",
        status: "read_failed",
        ref: "186",
        detail: "Kleros dispute_get: insufficient funds for gas at client.js",
      }),
    ]);
    expect(f.cases.find(f.caseId)).toMatchObject({ status: "filed", rulingReadAt: null });
    expect(f.closed()).toBe(1);
  });

  test.each<[string, () => Error, string]>([
    [
      "a refusal of the service",
      () =>
        new KlerosRefusal(
          "dispute_get",
          "INSUFFICIENT_FUNDS: insufficient funds in the fee wallet at /var/lib/kleros/fees.json",
        ),
      "INSUFFICIENT_FUNDS: insufficient funds in the fee wallet at fees.json",
    ],
    [
      "a read of another deployment",
      () => new KlerosWrongDeploymentError("arbitrum-sepolia-testnet", "arbitrum-one"),
      'Kleros read names chain "arbitrum-one", but this service is bound to arbitrum-sepolia-testnet',
    ],
  ])(
    "%s is reported in the service's words, never the platform's sentence, and leaves one read_failed event",
    async (_name, failure, text) => {
      const f = await testnetWith(() => {
        throw failure();
      });
      const err = await f.run(["pilot:poll", "--case", f.caseId]).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(text);
      expect((err as Error).message).not.toContain(PLATFORM_FUNDS_MESSAGE);
      expect(f.cases.events(f.caseId)).toEqual([
        expect.objectContaining({
          step: "ruling",
          status: "read_failed",
          ref: "186",
          detail: text,
        }),
      ]);
      expect(f.closed()).toBe(1);
    },
  );

  test("an HTTP status leaves one read_failed event, in the service's words", async () => {
    const f = await testnetWith(() => {
      throw new KlerosHttpError(503, "upstream unavailable");
    });
    await expect(f.run(["pilot:poll", "--case", f.caseId])).rejects.toThrow(
      /^Kleros Dispute Service answered HTTP 503$/,
    );
    expect(f.cases.events(f.caseId)).toEqual([
      expect.objectContaining({
        step: "ruling",
        status: "read_failed",
        detail: "Kleros Dispute Service answered HTTP 503",
      }),
    ]);
  });
});

describe("pilot:poll --watch when reads keep failing", () => {
  test("stops after the sixth failure in a row and says why", async () => {
    const f = await testnetWith(() => {
      throw new KlerosTransportError("Kleros dispute_get: no answer in time");
    });
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--watch"]);
    const opslines = outs.filter((o) => (o as { opslog?: string }).opslog !== undefined);
    expect(
      opslines.filter((o) => (o as { opslog: string }).opslog === "pilot_poll_read_failed"),
    ).toHaveLength(6);
    expect(outs.at(-1)).toMatchObject({
      caseId: f.caseId,
      reads: 6,
      capped: true,
      stop: "reads_failing",
      outcome: { kind: "pending" },
      status: "filed",
    });
    expect(f.closed()).toBe(1);
  });
});

describe("pilot:poll --script: a rehearsal poll from a fresh process", () => {
  test("a one-shot poll reads past Evidence at once, and rules the case on the script's verdict", async () => {
    const f = await makeFake({ realStage: true });
    const [out] = await f.run(["pilot:poll", "--case", f.caseId, "--script", "refund"]);
    expect(out).toMatchObject({
      read: { status: "Appeal", ruling: "2" },
      outcome: { kind: "refund" },
      status: "ruled",
      settlement: { action: "reject" },
    });
  });

  test("the command's own fake finds a case it did not file and walks the named script", async () => {
    const f = await makeFake({ realStage: true });
    const outs = await f.run(["pilot:poll", "--case", f.caseId, "--watch", "--script", "refund"]);
    expect(outs.at(-1)).toMatchObject({
      reads: 4,
      stop: "outcome",
      outcome: { kind: "refund" },
      status: "ruled",
    });
  });

  test.each([[[]], [["--watch"]]])(
    "a rehearsal poll without --script is refused, naming the flag and the scripts, and reads nothing",
    async (extra) => {
      const f = await makeFake({ realStage: true });
      await expect(f.run(["pilot:poll", "--case", f.caseId, ...extra])).rejects.toThrow(
        /--script.*one of pay, refund/,
      );
      expect(disputeGets(f)).toEqual([]);
      expect(f.cases.find(f.caseId)!.status).toBe("filed");
      expect(f.closed()).toBe(1);
    },
  );

  test("an unknown script is refused before the context opens", async () => {
    const f = await makeFake({ realStage: true });
    await expect(f.run(["pilot:poll", "--case", f.caseId, "--script", "refnud"])).rejects.toThrow(
      /--script/,
    );
    expect(f.opened()).toBe(0);
  });

  test("--script outside rehearsal is refused and nothing is read", async () => {
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
    const row = seed(f.cases, {
      mode: "testnet",
      coreDisputeId: "186",
      klerosChain: "arbitrum-sepolia-testnet",
    });
    await expect(f.run(["pilot:poll", "--case", row, "--script", "pay"])).rejects.toThrow(
      /--script.*rehearsal/,
    );
    expect(reads).toEqual([]);
    expect(f.stages).toBe(0);
    expect(f.closed()).toBe(1);
  });
});
