import type { Command } from "commander";
import {
  FAKE_SCRIPTS,
  FakeDisputeService,
  type FakeScript,
} from "../adapters/kleros/fakeDisputeService";
import { type Config, DEFAULT_KLEROS_EXPECTED_OPTIONS, parseExpectedOptions } from "../config/env";
import {
  DEFAULT_SCRIPT,
  type KlerosStage,
  type PilotChain,
  buildKlerosService,
  buildPilotChain,
} from "../pilot/composition";
import { type PilotContext, openPilotContext } from "../pilot/context";
import { withoutEmDash } from "../pilot/job";
import {
  PERIOD_OVERDUE_GRACE_MS,
  type PollDeps,
  type PollResult,
  type RulingOutcome,
  pollOnce,
  pollUntilRuled,
} from "../pilot/ruling";
import { type Settlement, decideSettlement, settleCase } from "../pilot/settlement";
import { publicErrorMessage } from "../workflow/publicError";
import { parseCaseId, refuse } from "./pilotArgs";

/**
 * THE PILOT'S SETTLEMENT COMMANDS: reading a filed case's ruling from Kleros, and carrying it
 * out on Arc.
 *
 * Like the other pilot commands, each one parses its options before it opens its own narrow
 * context, prints JSON objects and throws on a refusal. `pilot:poll` only reads Kleros and the
 * escrow and writes the row: it sends no transaction. `pilot:settle` prints its decision and
 * sends it only with `--yes`.
 */
export interface PilotSettlementDeps {
  open: () => PilotContext;
  /** The Kleros stage the config's mode selects; `script` is the rehearsal fake's, and
   *  `readsUntilAppeal` how many of its reads come before the verdict. */
  buildStage: (cfg: Config, o: { script: FakeScript; readsUntilAppeal?: number }) => KlerosStage;
  /** The chain side: the job adapter whose evaluator is the referee, and the three wallets. */
  buildChain: (ctx: PilotContext) => PilotChain;
  /** Milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: PilotSettlementDeps = {
  open: openPilotContext,
  buildStage: (cfg, o) =>
    cfg.pilot?.mode === "rehearsal"
      ? rehearsalStage(o.script, o.readsUntilAppeal)
      : buildKlerosService(cfg, {}),
  buildChain: buildPilotChain,
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * The rehearsal's fake, built to answer a dispute it did not file: a command runs in its own
 * process, so the fake that filed the case is gone, and the read walks the named script from
 * Evidence instead.
 */
function rehearsalStage(script: FakeScript, readsUntilAppeal?: number): KlerosStage {
  return {
    mode: "rehearsal",
    service: new FakeDisputeService({ script, answerUnknownDisputes: true, readsUntilAppeal }),
    deployment: null,
    cap: null,
    flag: null,
  };
}

function parseScript(value: string | undefined): FakeScript | undefined {
  if (value === undefined) return undefined;
  if (!(FAKE_SCRIPTS as readonly string[]).includes(value))
    refuse(`--script must be one of ${FAKE_SCRIPTS.join(", ")}`);
  return value as FakeScript;
}

const DEFAULT_MAX_MINUTES = 180;
/** Up to four digits of minutes: a watch of at most 9999 minutes, about a week. */
const MAX_MINUTES = /^[1-9][0-9]{0,3}$/;
/** An appeal round number: at most three digits. */
const ROUND = /^[1-9][0-9]{0,2}$/;

function print(output: Record<string, unknown>): void {
  console.log(JSON.stringify(output, null, 2));
}

function parseMaxMinutes(value: string | undefined, watch: boolean): number {
  if (value === undefined) return DEFAULT_MAX_MINUTES;
  if (!watch) refuse("--max-minutes is accepted with --watch only");
  if (!MAX_MINUTES.test(value))
    refuse("--max-minutes must be a whole number of minutes above zero");
  return Number(value);
}

function parseAcceptRound(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!ROUND.test(value)) refuse("--accept-round must be a round number above zero");
  return Number(value);
}

/** The expected options as the config parsed them; the rehearsal may carry no Kleros section,
 *  so the default the config would have parsed stands in. */
function expectedOf(cfg: Config): Record<string, string> {
  return cfg.kleros?.expectedOptions ?? parseExpectedOptions(DEFAULT_KLEROS_EXPECTED_OPTIONS);
}

/**
 * What `pilot:settle` would decide from this outcome and the escrow read now, for the poll's
 * output; it sends nothing. A case with no job, or an escrow that cannot be read, says why.
 */
async function settlementPreview(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  outcome: RulingOutcome,
): Promise<Settlement | { unavailable: string }> {
  const row = ctx.cases.find(caseId);
  if (!row || row.jobId === null) return { unavailable: "the case has no job id" };
  try {
    const escrow = await deps.buildChain(ctx).job.escrowState(BigInt(row.jobId));
    return decideSettlement(outcome, escrow, Math.floor(deps.now() / 1000), {
      coreDisputeId: row.coreDisputeId ?? undefined,
    });
  } catch (e) {
    return { unavailable: withoutEmDash(publicErrorMessage(e)) };
  }
}

/** One read as it is printed: the period and its deadline, the ruling fields and the note. */
function readLine(r: PollResult): Record<string, unknown> {
  const note = r.deadlineUnreadable
    ? "deadline_unreadable"
    : r.overdueMs !== undefined && r.overdueMs > PERIOD_OVERDUE_GRACE_MS
      ? "period_overdue"
      : null;
  return {
    read: {
      status: r.read.status,
      ruling: r.read.ruling,
      tied: r.read.tied,
      roundCount: r.read.roundCount,
      deadline: r.read.deadline,
      note,
    },
    outcome: r.outcome,
  };
}

async function poll(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  watch: { maxMinutes: number } | null,
  script: FakeScript | undefined,
): Promise<void> {
  const mode = ctx.cfg.pilot?.mode;
  if (script !== undefined && mode !== "rehearsal")
    refuse(`--script is accepted in rehearsal mode only, and this box is in ${mode} mode`);
  const d: PollDeps = {
    stage: deps.buildStage(ctx.cfg, { script: script ?? DEFAULT_SCRIPT }),
    cases: ctx.cases,
    expected: expectedOf(ctx.cfg),
    now: deps.now,
    sleep: deps.sleep,
  };
  if (watch === null) {
    const r = await pollOnce(d, caseId);
    print({
      caseId,
      ...readLine(r),
      status: ctx.cases.find(caseId)?.status,
      settlement: await settlementPreview(ctx, deps, caseId, r.outcome),
    });
    return;
  }
  const r = await pollUntilRuled(d, caseId, {
    maxMinutes: watch.maxMinutes,
    onRead: (read) => print({ caseId, ...readLine(read) }),
  });
  print({
    caseId,
    reads: r.reads,
    capped: r.stop !== "outcome",
    stop: r.stop,
    outcome: r.outcome,
    status: ctx.cases.find(caseId)?.status,
    settlement: await settlementPreview(ctx, deps, caseId, r.outcome),
  });
}

interface SettleOptions {
  acceptRound: number | undefined;
  claimRefundOnly: boolean;
  script: FakeScript | undefined;
  yes: boolean;
}

/** Why nothing is sent, for each decision that sends nothing. */
const NOTHING_TO_SEND: Record<Extract<Settlement, { action: "none" }>["why"], string> = {
  released_elsewhere: "the escrow is already released to the provider",
  refunded_elsewhere: "the escrow is already refunded to the client",
  nothing_escrowed: "the job holds no escrow",
  ruling_pending: "the first round has no verdict yet: poll again",
  tied: "the round is tied: poll again, a tie may resolve inside the appeal period",
  refused: "the court refused to arbitrate: the escrow waits for the expiry, then --claim-refund",
  appealed: "the case was appealed: read the round, then act on it with --accept-round <n> --yes",
  too_close_to_expiry:
    "the job expires within ten minutes: run again after the expiry with --claim-refund",
  unknown_status: "the job is at a status the settlement does not act on: read the chain",
  options_mismatch: "the dispute's ruling options are not the expected ones: a person reads them",
  unexpected_ruling: "the ruling is not a value the settlement knows: a person reads it",
};

async function settle(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  o: SettleOptions,
): Promise<void> {
  const mode = ctx.cfg.pilot?.mode;
  if (o.script !== undefined && mode !== "rehearsal")
    refuse(`--script is accepted in rehearsal mode only, and this box is in ${mode} mode`);
  // In a rehearsal the re-read comes from a fresh fake, so it answers the verdict at once.
  const stage = deps.buildStage(ctx.cfg, {
    script: o.script ?? DEFAULT_SCRIPT,
    readsUntilAppeal: 1,
  });
  const r = await settleCase(
    {
      chain: deps.buildChain(ctx),
      cases: ctx.cases,
      stage,
      expected: expectedOf(ctx.cfg),
      now: deps.now,
    },
    caseId,
    { send: o.yes, acceptRound: o.acceptRound, claimRefundOnly: o.claimRefundOnly },
  );
  const row = ctx.cases.find(caseId);
  const base = { caseId, mode: row?.mode, settlement: r.settlement, status: row?.status };
  if (r.settlement.action === "none") {
    print({ ...base, next: `nothing to send: ${NOTHING_TO_SEND[r.settlement.why]}` });
    return;
  }
  if (!o.yes) {
    print({
      dryRun: true,
      ...base,
      next: "nothing was sent: run the same command with --yes to send it",
    });
    return;
  }
  print({ ...base, txHash: r.txHash });
}

export function registerPilotSettlementCommands(
  program: Command,
  overrides: Partial<PilotSettlementDeps> = {},
): void {
  const deps: PilotSettlementDeps = { ...defaultDeps, ...overrides };
  program
    .command("pilot:poll")
    .description(
      "read a filed pilot case's ruling from Kleros (test data) and record it on the case; with --watch, read until the first round has a verdict",
    )
    .requiredOption("--case <caseId>", "the pilot case")
    .option("--watch", "read every 30 seconds until the outcome is no longer pending")
    .option(
      "--max-minutes <n>",
      `with --watch, stop after this many minutes (default ${DEFAULT_MAX_MINUTES})`,
    )
    .option(
      "--script <name>",
      `rehearsal mode only: the fake's script, which must be the one the case was filed with (default ${DEFAULT_SCRIPT})`,
    )
    .action(
      async (opts: { case: string; watch?: boolean; maxMinutes?: string; script?: string }) => {
        // Options are parsed before the context opens, so a bad one never opens the database.
        const caseId = parseCaseId("--case", opts.case);
        const maxMinutes = parseMaxMinutes(opts.maxMinutes, !!opts.watch);
        const script = parseScript(opts.script);
        const ctx = deps.open();
        try {
          await poll(ctx, deps, caseId, opts.watch ? { maxMinutes } : null, script);
        } catch (e) {
          throw new Error(withoutEmDash(publicErrorMessage(e)));
        } finally {
          ctx.close();
        }
      },
    );

  program
    .command("pilot:settle")
    .description(
      "carry a pilot case's ruling out on Arc (test data): pay the provider, refund the client, or refund by expiry; prints the decision and sends it with --yes",
    )
    .requiredOption("--case <caseId>", "the pilot case")
    .option("--claim-refund", "take the expiry path: claimRefund, refused before the expiry")
    .option("--accept-round <n>", "act on an appealed case's ruling when round <n> is the one read")
    .option(
      "--script <name>",
      `rehearsal mode only: the fake's script for a ruling re-read, the one the case was filed with (default ${DEFAULT_SCRIPT})`,
    )
    .option("--yes", "confirm: send the transaction")
    .action(
      async (opts: {
        case: string;
        claimRefund?: boolean;
        acceptRound?: string;
        script?: string;
        yes?: boolean;
      }) => {
        // Options are parsed before the context opens, so a bad one never opens the database.
        const caseId = parseCaseId("--case", opts.case);
        const acceptRound = parseAcceptRound(opts.acceptRound);
        if (acceptRound !== undefined && opts.claimRefund)
          refuse("--accept-round and --claim-refund cannot both be given");
        const script = parseScript(opts.script);
        const ctx = deps.open();
        try {
          await settle(ctx, deps, caseId, {
            acceptRound,
            claimRefundOnly: !!opts.claimRefund,
            script,
            yes: !!opts.yes,
          });
        } catch (e) {
          throw new Error(withoutEmDash(publicErrorMessage(e)));
        } finally {
          ctx.close();
        }
      },
    );
}
