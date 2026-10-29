import type { Command } from "commander";
import { type Config, DEFAULT_KLEROS_EXPECTED_OPTIONS, parseExpectedOptions } from "../config/env";
import { type KlerosStage, buildKlerosService } from "../pilot/composition";
import { type PilotContext, openPilotContext } from "../pilot/context";
import { withoutEmDash } from "../pilot/job";
import {
  PERIOD_OVERDUE_GRACE_MS,
  type PollDeps,
  type PollResult,
  pollOnce,
  pollUntilRuled,
} from "../pilot/ruling";
import { publicErrorMessage } from "../workflow/publicError";

/**
 * THE PILOT'S SETTLEMENT COMMANDS: reading a filed case's ruling from Kleros.
 *
 * Like the other pilot commands, each one parses its options before it opens its own narrow
 * context, prints JSON objects and throws on a refusal. `pilot:poll` only reads Kleros and writes
 * the row: it sends no transaction.
 */
export interface PilotSettlementDeps {
  open: () => PilotContext;
  /** The Kleros stage the config's mode selects. */
  buildStage: (cfg: Config) => KlerosStage;
  /** Milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: PilotSettlementDeps = {
  open: openPilotContext,
  buildStage: (cfg) => buildKlerosService(cfg, {}),
  now: Date.now,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

const CASE_ID = /^pc_[0-9a-f]{12}$/;
const DEFAULT_MAX_MINUTES = 180;
/** Three digits of minutes: a watch of at most about a week. */
const MAX_MINUTES = /^[1-9][0-9]{0,3}$/;
/** What the settlement step will decide from the outcome; this command decides nothing. */
const SETTLEMENT = "decided by pilot:settle";

function refuse(message: string): never {
  throw new Error(`refusing: ${message}`);
}

function print(output: Record<string, unknown>): void {
  console.log(JSON.stringify(output, null, 2));
}

function parseCaseId(value: string): string {
  if (!CASE_ID.test(value)) refuse("--case must be a pilot case id (pc_ and 12 hex digits)");
  return value;
}

function parseMaxMinutes(value: string | undefined, watch: boolean): number {
  if (value === undefined) return DEFAULT_MAX_MINUTES;
  if (!watch) refuse("--max-minutes is accepted with --watch only");
  if (!MAX_MINUTES.test(value))
    refuse("--max-minutes must be a whole number of minutes above zero");
  return Number(value);
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
): Promise<void> {
  const d: PollDeps = {
    stage: deps.buildStage(ctx.cfg),
    cases: ctx.cases,
    // The rehearsal needs no Kleros key, so the config may carry no Kleros section: the
    // expected options are then the default the config would have parsed.
    expected:
      ctx.cfg.kleros?.expectedOptions ?? parseExpectedOptions(DEFAULT_KLEROS_EXPECTED_OPTIONS),
    now: deps.now,
    sleep: deps.sleep,
  };
  if (watch === null) {
    const r = await pollOnce(d, caseId);
    print({
      caseId,
      ...readLine(r),
      status: ctx.cases.find(caseId)?.status,
      settlement: SETTLEMENT,
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
    settlement: SETTLEMENT,
  });
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
    .action(async (opts: { case: string; watch?: boolean; maxMinutes?: string }) => {
      // Options are parsed before the context opens, so a bad one never opens the database.
      const caseId = parseCaseId(opts.case);
      const maxMinutes = parseMaxMinutes(opts.maxMinutes, !!opts.watch);
      const ctx = deps.open();
      try {
        await poll(ctx, deps, caseId, opts.watch ? { maxMinutes } : null);
      } catch (e) {
        throw new Error(withoutEmDash(publicErrorMessage(e)));
      } finally {
        ctx.close();
      }
    });
}
