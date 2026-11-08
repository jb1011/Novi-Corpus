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
import {
  type SettleDeps,
  type Settlement,
  UNFILED_REFUND_STATUSES,
  type UnfiledEscrowRead,
  adoptSettleTx,
  checkEscrowIsOwn,
  checkOwnConfig,
  clearDroppedSettleTx,
  decideSettlement,
  refundUnfiledCase,
  settleCase,
} from "../pilot/settlement";
import { publicErrorMessage } from "../workflow/publicError";
import { parseCaseId, parseTxHash, refuse } from "./pilotArgs";

/**
 * THE PILOT'S SETTLEMENT COMMANDS: reading a filed case's ruling from Kleros, and carrying it
 * out on Arc.
 *
 * Like the other pilot commands, each one parses its options before it opens its own narrow
 * context, prints JSON objects and throws on a refusal. `pilot:poll` only reads Kleros and the
 * escrow and writes the row: it sends no transaction. `pilot:settle` prints its decision and
 * sends it only with `--yes`; with `--claim-refund` on a case funded but never filed it takes the
 * escrow back after the expiry, and the case ends failed. Its two recovery options send nothing:
 * `--tx` adopts a settle hash the case lost once the chain proves it, and `--dropped` clears one
 * the network dropped; each prints what it read and writes only with `--yes`.
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
 * output; it sends nothing. It runs the checks `pilot:settle` runs that the job is the case's
 * own: the configured job contract and chain id, then the escrow's buyer, evaluator, expiry and
 * budget. A case with no job, a job that is not the case's, or an escrow that cannot be read,
 * says why.
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
    const chain = deps.buildChain(ctx);
    checkOwnConfig(chain, row);
    const jobId = BigInt(row.jobId);
    const escrow = await chain.job.escrowState(jobId);
    checkEscrowIsOwn(row, jobId, escrow);
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
  // The rehearsal's fake is built fresh for this process and walks the script it is given: a
  // default would read a verdict the case was never filed with.
  if (mode === "rehearsal" && script === undefined)
    refuse(
      `--script is required in rehearsal mode: the script the case was filed with, one of ${FAKE_SCRIPTS.join(", ")}`,
    );
  // A one-shot poll in the rehearsal is its own process with a fresh fake, which would answer
  // Evidence to its first read whatever the case has been through; the settle builds its stage
  // the same way, so the one read it takes already holds the script's verdict. A watch walks
  // the periods from Evidence on, and reads them as they come.
  const d: PollDeps = {
    stage: deps.buildStage(ctx.cfg, {
      script: script ?? DEFAULT_SCRIPT,
      readsUntilAppeal: watch === null ? 1 : undefined,
    }),
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

/** `--script` names the rehearsal fake's script, so it means nothing in another mode. */
function checkScriptMode(ctx: PilotContext, script: FakeScript | undefined): void {
  const mode = ctx.cfg.pilot?.mode;
  if (script !== undefined && mode !== "rehearsal")
    refuse(`--script is accepted in rehearsal mode only, and this box is in ${mode} mode`);
}

/** The settle's dependencies: the Kleros stage the box's mode selects, then the chain. */
function settleDepsOf(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  script: FakeScript | undefined,
): SettleDeps {
  const stage = deps.buildStage(ctx.cfg, { script: script ?? DEFAULT_SCRIPT, readsUntilAppeal: 1 });
  return {
    chain: deps.buildChain(ctx),
    cases: ctx.cases,
    stage,
    expected: expectedOf(ctx.cfg),
    now: deps.now,
  };
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

const FINAL_TIE = "the court finalised a tie: the escrow waits for the expiry, then --claim-refund";

/** The statuses at which a settlement reads the ruling when the row holds none. */
const UNREAD_STATUSES: ReadonlySet<string> = new Set(["filed", "evidence_unknown", "ruled"]);

async function settle(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  o: SettleOptions,
): Promise<void> {
  checkScriptMode(ctx, o.script);
  const row = ctx.cases.find(caseId);
  // A case never filed has no ruling: only the expiry gives its escrow back.
  if (o.claimRefundOnly && row !== undefined && UNFILED_REFUND_STATUSES.has(row.status))
    return refundUnfiled(ctx, deps, caseId, o);
  // A rehearsal case that holds a read is settled from it. One with none yet is read once, from
  // a fresh fake that answers its script's verdict at once, so the script must be the filing's.
  if (
    row !== undefined &&
    row.mode === "rehearsal" &&
    row.klerosChain === "fake" &&
    row.rulingReadAt === null &&
    UNREAD_STATUSES.has(row.status) &&
    !o.claimRefundOnly &&
    o.script === undefined
  )
    refuse(
      `case ${caseId} has no ruling read yet: pass --script with the script the case was filed with`,
    );
  const r = await settleCase(settleDepsOf(ctx, deps, o.script), caseId, {
    send: o.yes,
    acceptRound: o.acceptRound,
    claimRefundOnly: o.claimRefundOnly,
  });
  const after = ctx.cases.find(caseId);
  const base = { caseId, mode: after?.mode, settlement: r.settlement, status: after?.status };
  if (r.settlement.action === "none") {
    // A tie read at Executed is final: no appeal period is left for it to resolve in.
    const why =
      r.settlement.why === "tied" && after?.rulingStatus === "Executed"
        ? FINAL_TIE
        : NOTHING_TO_SEND[r.settlement.why];
    print({ ...base, next: `nothing to send: ${why}` });
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

const isoOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** The escrow a refund read, as it prints: the expiry also as a date. */
const escrowView = (e: UnfiledEscrowRead) => ({
  status: e.status,
  budgetAtomic: e.budgetAtomic,
  expiredAt: e.expiredAt,
  expiresAt: isoOf(e.expiredAt),
  refundMarginSeconds: e.refundMarginSeconds,
});

/** `pilot:settle --claim-refund` on a case funded but never filed: the escrow read and the
 *  claimRefund it leads to; sent with `--yes`. */
async function refundUnfiled(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  o: SettleOptions,
): Promise<void> {
  const r = await refundUnfiledCase(settleDepsOf(ctx, deps, o.script), caseId, { send: o.yes });
  const after = ctx.cases.find(caseId);
  const base = {
    caseId,
    mode: after?.mode,
    status: after?.status,
    settlement: r.settlement,
    escrow: escrowView(r.escrow),
  };
  if (r.settlement.action === "none") {
    print({ ...base, next: `nothing to send: ${NOTHING_TO_SEND[r.settlement.why]}` });
    return;
  }
  if (!o.yes) {
    print({
      dryRun: true,
      ...base,
      send: r.send,
      next: "nothing was sent: run the same command with --yes to send it",
    });
    return;
  }
  print({ ...base, send: r.send, txHash: r.txHash });
}

/** `pilot:settle --tx`: the proof of the hash and the write it leads to; written with `--yes`. */
async function adopt(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  hash: `0x${string}`,
  o: { script: FakeScript | undefined; yes: boolean },
): Promise<void> {
  checkScriptMode(ctx, o.script);
  const r = await adoptSettleTx(settleDepsOf(ctx, deps, o.script), caseId, hash, {
    write: o.yes,
  });
  const after = ctx.cases.find(caseId);
  const base = { caseId, mode: after?.mode, status: after?.status };
  if (r.unchanged) {
    print({ ...base, txHash: r.hash, next: "nothing to change: the case already holds this hash" });
    return;
  }
  const proof = { ...r.proof, blockTime: isoOf(r.proof.blockTime) };
  if (!o.yes) {
    print({
      dryRun: true,
      ...base,
      proof,
      write: r.write,
      next: "nothing was written: run the same command with --yes to record it",
    });
    return;
  }
  print({
    ...base,
    proof,
    wrote: r.write,
    ...(r.write.status === "settling"
      ? {
          next: `the transaction reverted: run pilot:settle --case ${caseId} to decide again from the chain`,
        }
      : {}),
  });
}

/** `pilot:settle --dropped`: what proved the drop and the write it leads to; written with
 *  `--yes`. */
async function dropped(
  ctx: PilotContext,
  deps: PilotSettlementDeps,
  caseId: string,
  o: { script: FakeScript | undefined; yes: boolean },
): Promise<void> {
  checkScriptMode(ctx, o.script);
  const r = await clearDroppedSettleTx(settleDepsOf(ctx, deps, o.script), caseId, {
    write: o.yes,
  });
  const after = ctx.cases.find(caseId);
  const base = { caseId, mode: after?.mode, status: after?.status };
  if (!o.yes) {
    print({
      dryRun: true,
      ...base,
      read: r.read,
      write: r.write,
      next: "nothing was written: run the same command with --yes to clear the hash",
    });
    return;
  }
  print({
    ...base,
    read: r.read,
    wrote: r.write,
    next: `run pilot:settle --case ${caseId} to decide again from the chain`,
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
    .option(
      "--script <name>",
      "rehearsal mode only, and required there: the fake's script, which must be the one the case was filed with",
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
    .option(
      "--claim-refund",
      "take the expiry path: claimRefund, refused before the expiry; on a case funded but never filed it takes the escrow back and the case ends failed",
    )
    .option("--accept-round <n>", "act on an appealed case's ruling when round <n> is the one read")
    .option(
      "--script <name>",
      "rehearsal mode only: the script the case was filed with, needed when the case holds no ruling read yet",
    )
    .option(
      "--tx <hash>",
      "adopt a settle transaction the case lost, once it is proven to be the referee's settle of the case's job; sends nothing",
    )
    .option(
      "--dropped",
      "clear a settling case's transaction hash once the network is proven to have dropped it, so the next run decides again; sends nothing",
    )
    .option("--yes", "confirm: send the transaction, or with --tx or --dropped write the row")
    .action(
      async (opts: {
        case: string;
        claimRefund?: boolean;
        acceptRound?: string;
        script?: string;
        tx?: string;
        dropped?: boolean;
        yes?: boolean;
      }) => {
        // Options are parsed before the context opens, so a bad one never opens the database.
        const caseId = parseCaseId("--case", opts.case);
        const acceptRound = parseAcceptRound(opts.acceptRound);
        if (acceptRound !== undefined && opts.claimRefund)
          refuse("--accept-round and --claim-refund cannot both be given");
        if (opts.tx !== undefined && opts.dropped)
          refuse("--tx and --dropped cannot both be given");
        // The two recovery options send nothing, so the options that shape a send mean nothing.
        const recovery = opts.tx !== undefined ? "--tx" : opts.dropped ? "--dropped" : undefined;
        if (recovery !== undefined && opts.claimRefund)
          refuse(`${recovery} and --claim-refund cannot both be given`);
        if (recovery !== undefined && acceptRound !== undefined)
          refuse(`${recovery} and --accept-round cannot both be given`);
        const tx = opts.tx === undefined ? undefined : parseTxHash("--tx", opts.tx);
        const script = parseScript(opts.script);
        const yes = !!opts.yes;
        const ctx = deps.open();
        try {
          if (tx !== undefined) await adopt(ctx, deps, caseId, tx, { script, yes });
          else if (opts.dropped) await dropped(ctx, deps, caseId, { script, yes });
          else
            await settle(ctx, deps, caseId, {
              acceptRound,
              claimRefundOnly: !!opts.claimRefund,
              script,
              yes,
            });
        } catch (e) {
          throw new Error(withoutEmDash(publicErrorMessage(e)));
        } finally {
          ctx.close();
        }
      },
    );
}
