/**
 * The ruling reader and the poll over a real SQLite case table in memory, with the scripted fake
 * Dispute Service (or a hand-made one) and an injected clock: no chain, no network, no wait.
 */
import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { deploymentFor } from "../../src/adapters/kleros/deployments";
import type { DisputeRead, KlerosDisputeService } from "../../src/adapters/kleros/disputeService";
import { FakeDisputeService, type FakeScript } from "../../src/adapters/kleros/fakeDisputeService";
import { migrate } from "../../src/persistence/db";
import { SqlitePilotCaseRepository, newCaseId } from "../../src/pilot/casesRepository";
import type { KlerosStage } from "../../src/pilot/composition";
import {
  PERIOD_OVERDUE_GRACE_MS,
  type PollDeps,
  pollOnce,
  pollUntilRuled,
  readRuling,
} from "../../src/pilot/ruling";
import type {
  KlerosChainOnRow,
  PilotCaseRecord,
  PilotMode,
  PilotStatus,
} from "../../src/pilot/types";

const EXPECTED = { "1": "Pay the provider", "2": "Refund the client" };
/** 2026-10-28T00:00:00Z, in milliseconds. */
const T0 = 1_793_145_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function read(o: Partial<DisputeRead> = {}): DisputeRead {
  return {
    status: "Appeal",
    ruling: "1",
    tied: false,
    ruled: false,
    roundCount: 1,
    rulingOptions: [
      { value: "1", title: "Pay the provider" },
      { value: "2", title: "Refund the client" },
    ],
    deadline: null,
    unresolvedFields: [],
    raw: {},
    ...o,
  };
}

describe("readRuling", () => {
  test.each<[string, Partial<DisputeRead>, ReturnType<typeof readRuling>]>([
    ["Evidence is pending", { status: "Evidence", ruling: "0", tied: true }, { kind: "pending" }],
    ["Commit is pending", { status: "Commit", ruling: "0", tied: true }, { kind: "pending" }],
    ["Vote is pending", { status: "Vote", ruling: "1" }, { kind: "pending" }],
    ["1 at Appeal pays", { ruling: "1" }, { kind: "pay" }],
    ["2 at Appeal refunds", { ruling: "2" }, { kind: "refund" }],
    ["0 at Appeal is a refusal", { ruling: "0" }, { kind: "refused" }],
    ["a tie at Appeal is tied", { ruling: "0", tied: true }, { kind: "tied" }],
    [
      "0 at Executed is a refusal",
      { status: "Executed", ruled: true, ruling: "0" },
      { kind: "refused" },
    ],
    ["1 at Executed pays", { status: "Executed", ruled: true, ruling: "1" }, { kind: "pay" }],
    [
      "a value outside the options is unexpected",
      { ruling: "3" },
      { kind: "unexpected", value: "3" },
    ],
    [
      "a ruling that does not parse is unexpected",
      { ruling: "abc" },
      { kind: "unexpected", value: "abc" },
    ],
    [
      "a second round is an appeal, whatever its ruling",
      { roundCount: 2, ruling: "2", tied: true },
      { kind: "appealed", roundCount: 2, value: "2", tied: true },
    ],
    ["a hex ruling is read by value", { ruling: "0x02" }, { kind: "refund" }],
  ])("%s", (_name, o, outcome) => {
    expect(readRuling(read(o), EXPECTED)).toEqual(outcome);
  });

  test("a period before Appeal that reports ruled is no longer pending", () => {
    expect(readRuling(read({ status: "Vote", ruled: true, ruling: "2" }), EXPECTED)).toEqual({
      kind: "refund",
    });
  });

  test("tied wins over any ruling value, so a vote not yet held never reads as a verdict", () => {
    expect(readRuling(read({ ruling: "1", tied: true }), EXPECTED)).toEqual({ kind: "tied" });
    expect(readRuling(read({ ruling: "2", tied: true }), EXPECTED)).toEqual({ kind: "tied" });
  });

  test("options written in hex match the decimal expected keys", () => {
    const options = [
      { value: "0x01", title: "Pay the provider" },
      { value: "0x02", title: "Refund the client" },
    ];
    expect(readRuling(read({ rulingOptions: options, ruling: "1" }), EXPECTED)).toEqual({
      kind: "pay",
    });
  });

  test("titles compare trimmed and without case", () => {
    const options = [
      { value: "1", title: "  pay the PROVIDER " },
      { value: "2", title: "Refund the client" },
    ];
    expect(readRuling(read({ rulingOptions: options }), EXPECTED)).toEqual({ kind: "pay" });
  });

  describe("an options mismatch wins over every other outcome", () => {
    test.each<[string, DisputeRead["rulingOptions"]]>([
      ["an expected value is missing", [{ value: "1", title: "Pay the provider" }]],
      [
        "a title differs",
        [
          { value: "1", title: "Refund the client" },
          { value: "2", title: "Pay the provider" },
        ],
      ],
      [
        "an option's value does not parse",
        [
          { value: "1", title: "Pay the provider" },
          { value: "2", title: "Refund the client" },
          { value: "three", title: "Split" },
        ],
      ],
      ["the options are empty", []],
    ])("%s", (_name, rulingOptions) => {
      for (const o of [
        { ruling: "1" },
        { ruling: "0", tied: true },
        { status: "Evidence" as const },
        { roundCount: 3 },
      ]) {
        const outcome = readRuling(read({ ...o, rulingOptions }), EXPECTED);
        expect(outcome.kind).toBe("options_mismatch");
        if (outcome.kind === "options_mismatch") expect(outcome.detail).not.toBe("");
      }
    });
  });

  test("an extra option beyond the expected ones is allowed", () => {
    const options = [
      { value: "1", title: "Pay the provider" },
      { value: "2", title: "Refund the client" },
      { value: "3", title: "Split" },
    ];
    expect(readRuling(read({ rulingOptions: options }), EXPECTED)).toEqual({ kind: "pay" });
  });
});

// --- the poll ---

interface Setup {
  deps: PollDeps;
  cases: SqlitePilotCaseRepository;
  clock: { now: number };
  sleeps: number[];
}

function setup(o: { stage: KlerosStage; clock?: { now: number } }): Setup {
  const db = new Database(":memory:");
  migrate(db);
  const cases = new SqlitePilotCaseRepository(db);
  const clock = o.clock ?? { now: T0 };
  const sleeps: number[] = [];
  return {
    cases,
    clock,
    sleeps,
    deps: {
      stage: o.stage,
      cases,
      expected: EXPECTED,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
      },
    },
  };
}

function rehearsalStage(fake: KlerosDisputeService): KlerosStage {
  return { mode: "rehearsal", service: fake, deployment: null, cap: null, flag: null };
}

function testnetStage(service: KlerosDisputeService): KlerosStage {
  return {
    mode: "testnet",
    service,
    deployment: deploymentFor("testnet"),
    cap: 10,
    flag: "--testnet",
  };
}

/** A filed row, seeded by hand: the filing is another step's. */
function seed(
  cases: SqlitePilotCaseRepository,
  o: {
    mode?: PilotMode;
    status?: PilotStatus;
    klerosChain?: KlerosChainOnRow | null;
    coreDisputeId?: string | null;
  } = {},
): PilotCaseRecord {
  const caseId = newCaseId();
  cases.insert({
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
    budgetAtomic: "2000000",
    description: "a test job",
    expiredAt: Math.floor(T0 / 1000) + 7 * 86_400,
    deliverablePath: null,
    deliverableHash: null,
    deliverableExtension: null,
  });
  const patch: Partial<PilotCaseRecord> = {};
  const chain = o.klerosChain === undefined ? "fake" : o.klerosChain;
  if (chain !== null) patch.klerosChain = chain;
  const id = o.coreDisputeId === undefined ? "1000" : o.coreDisputeId;
  if (id !== null) patch.coreDisputeId = id;
  return cases.advance(caseId, "created", o.status ?? "filed", patch) as PilotCaseRecord;
}

/** A fake on the shared clock with one mined dispute; returns the fake and the dispute's id. */
async function fakeWithDispute(
  script: FakeScript,
  clock: { now: number },
): Promise<{ fake: FakeDisputeService; coreDisputeId: string }> {
  const fake = new FakeDisputeService({ script, now: () => clock.now });
  const created = await fake.createDispute({ aliases: {} });
  if (created.status !== "mined") throw new Error("the fake did not mine the dispute");
  return { fake, coreDisputeId: created.coreDisputeId };
}

/** A rehearsal setup whose fake shares the setup's clock, with one filed row on its dispute. */
async function rehearsal(script: FakeScript, status: PilotStatus = "filed") {
  const clock = { now: T0 };
  const { fake, coreDisputeId } = await fakeWithDispute(script, clock);
  const s = setup({ stage: rehearsalStage(fake), clock });
  const row = seed(s.cases, { coreDisputeId, status });
  return { ...s, fake, row };
}

/** A service that answers every read with `next()` and counts what it was asked. */
function stubService(next: () => DisputeRead): KlerosDisputeService & {
  reads: { chain: string; coreDisputeId: string }[];
} {
  const reads: { chain: string; coreDisputeId: string }[] = [];
  const no = async (): Promise<never> => {
    throw new Error("not used in this test");
  };
  return {
    deployment: "testnet",
    reads,
    listTools: no,
    instructions: no,
    getCourt: no,
    pin: no,
    createDispute: no,
    submitEvidence: no,
    getDispute: async (p) => {
      reads.push(p);
      return next();
    },
  };
}

describe("pollOnce", () => {
  test("writes each read to the row's ruling columns and leaves a pending row filed", async () => {
    const s = await rehearsal("pay");
    const r = await pollOnce(s.deps, s.row.caseId);
    expect(r.outcome).toEqual({ kind: "pending" });
    const row = s.cases.find(s.row.caseId)!;
    expect(row.status).toBe("filed");
    expect(row.rulingStatus).toBe("Evidence");
    expect(row.rulingValue).toBe("0");
    expect(row.rulingTied).toBe(1);
    expect(row.rulingRoundCount).toBe(1);
    expect(row.rulingLabel).toBe("Invalid / Refuse to Arbitrate");
    expect(row.rulingReadAt).toBe(Math.floor(T0 / 1000));
    expect(row.rulingDeadline).toBe(r.read.deadline);
    expect(row.rulingDeadline).not.toBeNull();
  });

  test("sends the row's chain and dispute id, on the fake as on a real deployment", async () => {
    const s = await rehearsal("pay");
    await pollOnce(s.deps, s.row.caseId);
    const gets = s.fake.calls.filter((c) => c.tool === "dispute_get");
    expect(gets.map((c) => c.args)).toEqual([
      { chain: "fake", coreDisputeId: s.row.coreDisputeId },
    ]);

    const service = stubService(() => read({ status: "Evidence" }));
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "testnet",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    await pollOnce(t.deps, row.caseId);
    expect(service.reads).toEqual([{ chain: "arbitrum-sepolia-testnet", coreDisputeId: "186" }]);
  });

  test("a row whose chain differs from the stage's deployment is refused and nothing is read", async () => {
    const service = stubService(() => read());
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "testnet",
      klerosChain: "arbitrum-one",
      coreDisputeId: "287",
    });
    await expect(pollOnce(t.deps, row.caseId)).rejects.toThrow(/refusing.*arbitrum-one/);
    expect(service.reads).toEqual([]);
    expect(t.cases.find(row.caseId)!.rulingReadAt).toBeNull();
  });

  test("a rehearsal row that names a real chain is refused and nothing is read", async () => {
    const s = await rehearsal("pay");
    const other = seed(s.cases, { klerosChain: "arbitrum-sepolia-testnet" });
    await expect(pollOnce(s.deps, other.caseId)).rejects.toThrow(/refusing/);
    expect(s.fake.calls.filter((c) => c.tool === "dispute_get")).toEqual([]);
  });

  test("a row of another mode is refused and nothing is read", async () => {
    const service = stubService(() => read());
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "live",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    await expect(pollOnce(t.deps, row.caseId)).rejects.toThrow(/refusing.*live/);
    expect(service.reads).toEqual([]);
  });

  test.each<[string, Parameters<typeof seed>[1]]>([
    ["no Kleros chain", { klerosChain: null }],
    ["no dispute id", { coreDisputeId: null }],
    ["a status before filed", { status: "contested" }],
    ["a status after ruled", { status: "settled" }],
    ["a failed status", { status: "failed" }],
  ])("a row with %s is refused and nothing is read", async (_name, o) => {
    const s = await rehearsal("pay");
    const row = seed(s.cases, o);
    await expect(pollOnce(s.deps, row.caseId)).rejects.toThrow(/refusing/);
    expect(s.fake.calls.filter((c) => c.tool === "dispute_get")).toEqual([]);
  });

  test("an unknown case is refused", async () => {
    const s = await rehearsal("pay");
    await expect(pollOnce(s.deps, "pc_000000000000")).rejects.toThrow(/no pilot case/);
  });

  test("a final read advances evidence_unknown to ruled", async () => {
    const s = await rehearsal("refund", "evidence_unknown");
    const r = await pollUntilRuled(s.deps, s.row.caseId, {});
    expect(r.outcome).toEqual({ kind: "refund" });
    expect(s.cases.find(s.row.caseId)!.status).toBe("ruled");
  });

  test("a ruled row may be read again and stays ruled", async () => {
    const s = await rehearsal("pay");
    await pollUntilRuled(s.deps, s.row.caseId, {});
    expect(s.cases.find(s.row.caseId)!.status).toBe("ruled");
    s.clock.now += 60_000;
    const again = await pollOnce(s.deps, s.row.caseId);
    expect(again.outcome).toEqual({ kind: "pay" });
    const row = s.cases.find(s.row.caseId)!;
    expect(row.status).toBe("ruled");
    expect(row.rulingReadAt).toBe(Math.floor(s.clock.now / 1000));
  });

  test("a tie at Executed is final; a tie at Appeal is not", async () => {
    let next = read({ ruling: "0", tied: true });
    const service = stubService(() => next);
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "testnet",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    expect((await pollOnce(t.deps, row.caseId)).outcome).toEqual({ kind: "tied" });
    expect(t.cases.find(row.caseId)!.status).toBe("filed");
    next = read({ status: "Executed", ruled: true, ruling: "0", tied: true });
    expect((await pollOnce(t.deps, row.caseId)).outcome).toEqual({ kind: "tied" });
    expect(t.cases.find(row.caseId)!.status).toBe("ruled");
  });

  test.each<[string, Partial<DisputeRead>]>([
    ["an appeal", { roundCount: 2 }],
    ["an unexpected value", { ruling: "7" }],
    ["an options mismatch", { rulingOptions: [] }],
  ])("%s is written but does not advance the row", async (_name, o) => {
    const service = stubService(() => read(o));
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "testnet",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    await pollOnce(t.deps, row.caseId);
    const after = t.cases.find(row.caseId)!;
    expect(after.status).toBe("filed");
    expect(after.rulingReadAt).not.toBeNull();
  });

  test("a read past its deadline is written like any other and stays pending", async () => {
    for (const [pastMs, overdue] of [
      [5 * 60_000, false],
      [25 * 60_000, true],
    ] as const) {
      const service = stubService(() =>
        read({
          status: "Vote",
          ruling: "0",
          tied: true,
          deadline: new Date(T0 - pastMs).toISOString(),
        }),
      );
      const t = setup({ stage: testnetStage(service) });
      const row = seed(t.cases, {
        mode: "testnet",
        klerosChain: "arbitrum-sepolia-testnet",
        coreDisputeId: "186",
      });
      const r = await pollOnce(t.deps, row.caseId);
      expect(r.outcome).toEqual({ kind: "pending" });
      expect(r.overdueMs).toBe(pastMs);
      expect((r.overdueMs ?? 0) > PERIOD_OVERDUE_GRACE_MS).toBe(overdue);
      expect(t.cases.find(row.caseId)!.rulingDeadline).toBe(new Date(T0 - pastMs).toISOString());
    }
  });

  test("a deadline still ahead carries no overdue time", async () => {
    const service = stubService(() =>
      read({ status: "Vote", deadline: new Date(T0 + 60_000).toISOString() }),
    );
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "testnet",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    expect((await pollOnce(t.deps, row.caseId)).overdueMs).toBeUndefined();
  });

  test("a read that fails writes nothing and leaves the row as it was", async () => {
    const service = stubService(() => {
      throw new Error("the service did not answer");
    });
    const t = setup({ stage: testnetStage(service) });
    const row = seed(t.cases, {
      mode: "testnet",
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    await expect(pollOnce(t.deps, row.caseId)).rejects.toThrow(/did not answer/);
    const after = t.cases.find(row.caseId)!;
    expect(after.status).toBe("filed");
    expect(after.rulingReadAt).toBeNull();
  });
});

describe("pollUntilRuled through the fake's scripts", () => {
  test("pay: the fourth read is Appeal with 1, and the row is ruled", async () => {
    const s = await rehearsal("pay");
    const r = await pollUntilRuled(s.deps, s.row.caseId, {});
    expect(r).toEqual({ outcome: { kind: "pay" }, reads: 4 });
    expect(s.sleeps).toEqual([30_000, 30_000, 30_000]);
    const row = s.cases.find(s.row.caseId)!;
    expect(row.status).toBe("ruled");
    expect(row.rulingStatus).toBe("Appeal");
    expect(row.rulingValue).toBe("1");
    expect(row.rulingTied).toBe(0);
    expect(row.rulingLabel).toBe("Pay the provider");
    expect(row.rulingReadAt).toBe(Math.floor((T0 + 90_000) / 1000));
  });

  test("the row's columns follow each read", async () => {
    const s = await rehearsal("pay");
    const seen: (string | null)[] = [];
    const sleep = s.deps.sleep!;
    s.deps.sleep = async (ms) => {
      seen.push(s.cases.find(s.row.caseId)!.rulingStatus);
      await sleep(ms);
    };
    await pollUntilRuled(s.deps, s.row.caseId, {});
    seen.push(s.cases.find(s.row.caseId)!.rulingStatus);
    expect(seen).toEqual(["Evidence", "Commit", "Vote", "Appeal"]);
  });

  test("refuse: a 0 that is not tied is a refusal, and the row is ruled", async () => {
    const s = await rehearsal("refuse");
    expect(await pollUntilRuled(s.deps, s.row.caseId, {})).toEqual({
      outcome: { kind: "refused" },
      reads: 4,
    });
    expect(s.cases.find(s.row.caseId)!.status).toBe("ruled");
  });

  test("tie: the poll stops tied with the row filed, and a later read at Executed is a refusal", async () => {
    const s = await rehearsal("tie");
    expect(await pollUntilRuled(s.deps, s.row.caseId, {})).toEqual({
      outcome: { kind: "tied" },
      reads: 4,
    });
    expect(s.cases.find(s.row.caseId)!.status).toBe("filed");
    const outcomes: string[] = [];
    for (let i = 0; i < 3; i++) {
      s.clock.now += 3_600_000;
      outcomes.push((await pollOnce(s.deps, s.row.caseId)).outcome.kind);
    }
    expect(outcomes).toEqual(["tied", "tied", "refused"]);
    const row = s.cases.find(s.row.caseId)!;
    expect(row.status).toBe("ruled");
    expect(row.rulingStatus).toBe("Executed");
  });

  test("stalled: a Vote an hour past its deadline caps out as pending and logs the cap", async () => {
    const s = await rehearsal("stalled");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    const r = await pollUntilRuled(s.deps, s.row.caseId, {});
    expect(r.outcome).toEqual({ kind: "pending" });
    expect(r.reads).toBe(361);
    expect(s.clock.now - T0).toBe(180 * 60_000);
    const capped = logs.map((l) => JSON.parse(l)).filter((l) => l.opslog === "pilot_poll_capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]).toMatchObject({
      caseId: s.row.caseId,
      mode: "rehearsal",
      klerosChain: "fake",
      reads: 361,
    });
    const last = await pollOnce(s.deps, s.row.caseId);
    expect(last.outcome).toEqual({ kind: "pending" });
    expect(last.overdueMs).toBe(3_600_000);
    expect(last.overdueMs! > PERIOD_OVERDUE_GRACE_MS).toBe(true);
    expect(s.cases.find(s.row.caseId)!.status).toBe("filed");
  });

  test("the cap counts the injected clock with the given interval and minutes", async () => {
    const s = await rehearsal("stalled");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await pollUntilRuled(s.deps, s.row.caseId, { intervalMs: 60_000, maxMinutes: 3 });
    expect(r).toEqual({ outcome: { kind: "pending" }, reads: 4 });
    expect(s.sleeps).toEqual([60_000, 60_000, 60_000]);
  });

  test("a final outcome before the cap writes no cap line", async () => {
    const s = await rehearsal("pay");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    await pollUntilRuled(s.deps, s.row.caseId, {});
    expect(logs.filter((l) => l.includes("pilot_poll_capped"))).toEqual([]);
  });

  test("each read is handed to the caller as it happens", async () => {
    const s = await rehearsal("pay");
    const statuses: string[] = [];
    await pollUntilRuled(s.deps, s.row.caseId, {
      onRead: (r) => statuses.push(r.read.status),
    });
    expect(statuses).toEqual(["Evidence", "Commit", "Vote", "Appeal"]);
  });
});

describe("pollOnce when the row moves during the read", () => {
  test.each<[PilotStatus, PilotStatus, Partial<DisputeRead>]>([
    ["ruled", "settling", { ruling: "1" }],
    ["ruled", "settled", { ruling: "1" }],
    ["filed", "failed", { ruling: "1" }],
    ["filed", "failed", { status: "Vote", ruling: "0", tied: true }],
  ])("a %s row moved to %s is left as it is and the poll throws", async (from, to, o) => {
    // The service moves the row, so it needs the table and the id once they exist.
    const moving: { cases?: SqlitePilotCaseRepository; caseId: string } = { caseId: "" };
    const service = stubService(() => {
      moving.cases!.advance(moving.caseId, from, to);
      return read(o);
    });
    const t = setup({ stage: testnetStage(service) });
    moving.cases = t.cases;
    const row = seed(t.cases, {
      mode: "testnet",
      status: from,
      klerosChain: "arbitrum-sepolia-testnet",
      coreDisputeId: "186",
    });
    const caseId = row.caseId;
    moving.caseId = caseId;
    await expect(pollOnce(t.deps, caseId)).rejects.toThrow(new RegExp(`from ${from}.*${to}`));
    const after = t.cases.find(caseId)!;
    expect(after.status).toBe(to);
    expect(after.rulingReadAt).toBeNull();
    expect(after.rulingStatus).toBeNull();
    expect(t.cases.events(caseId).filter((e) => e.step === "ruling")).toEqual([]);
  });
});
