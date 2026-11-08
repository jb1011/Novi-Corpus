import type { DisputeRead } from "../adapters/kleros/disputeService";
import { KlerosHttpError, KlerosTransportError } from "../adapters/kleros/errors";
import { normaliseRulingValue } from "../adapters/kleros/httpDisputeService";
import { opsLog } from "../observability/opsLog";
import type { PilotCaseRepository } from "./casesRepository";
import type { KlerosStage } from "./composition";
import { klerosTextOf } from "./klerosCheck";
import type { PilotCaseRecord, PilotStatus } from "./types";

/**
 * THE RULING READER: what one `dispute_get` answer means for the pilot case, and the poll that
 * reads it until the first round has a verdict.
 *
 * A ruling is read by its VALUE, never by its position in the options list: the options are
 * checked against the values and titles the settlement expects before anything else, so a
 * template whose options moved can never be settled as the wrong party. The read always names
 * the chain stored on the row, the one that created the dispute: the same dispute id on another
 * deployment is somebody else's case.
 */
export type RulingOutcome =
  | { kind: "pending" }
  | { kind: "tied" }
  | { kind: "refused" }
  | { kind: "pay" }
  | { kind: "refund" }
  | { kind: "appealed"; roundCount: number; value: string; tied: boolean }
  | { kind: "unexpected"; value: string }
  | { kind: "options_mismatch"; detail: string };

/**
 * Two keeper intervals. Kleros's keeper passes the periods about every 10 minutes, so a
 * `deadline` is normally in the past for up to about one interval before the period advances.
 * Past this grace it points at a keeper outage or at jurors not all drawn.
 */
export const PERIOD_OVERDUE_GRACE_MS = 20 * 60_000;

const PRE_RULING_PERIODS: ReadonlySet<DisputeRead["status"]> = new Set([
  "Evidence",
  "Commit",
  "Vote",
]);

/** The pilot preset's ruling values: 0 is the court's refusal to arbitrate. */
const REFUSED = 0n;
const PAY = 1n;
const REFUND = 2n;

const titleKey = (t: string) => t.trim().toLowerCase();

export function readRuling(read: DisputeRead, expected: Record<string, string>): RulingOutcome {
  const pending = PRE_RULING_PERIODS.has(read.status) && !read.ruled;
  // The service leaves the options out while it cannot resolve them, commonest on the testnet.
  // Before a verdict that is a state to wait out; a verdict is never read without its options.
  const unresolved =
    read.rulingOptions.length === 0 && read.unresolvedFields.includes("rulingOptions");
  if (pending && unresolved) return { kind: "pending" };
  const mismatch = optionsMismatch(read.rulingOptions, expected);
  if (mismatch !== null) return { kind: "options_mismatch", detail: mismatch };
  if (pending) return { kind: "pending" };
  if (read.roundCount > 1)
    return { kind: "appealed", roundCount: read.roundCount, value: read.ruling, tied: read.tied };
  // Before any vote no option leads and the service answers 0 with `tied`: a reader that ignored
  // `tied` would report a vote that has not happened as a refusal. So `tied` wins over the value.
  if (read.tied) return { kind: "tied" };
  const value = normaliseRulingValue(read.ruling);
  if (value === REFUSED) return { kind: "refused" };
  if (value === PAY) return { kind: "pay" };
  if (value === REFUND) return { kind: "refund" };
  return { kind: "unexpected", value: read.ruling };
}

/** Why the options differ from the expected ones, or null when every expected value is there
 *  with its title. An option the settlement does not expect is allowed when its value parses. */
function optionsMismatch(
  options: DisputeRead["rulingOptions"],
  expected: Record<string, string>,
): string | null {
  const titlesByValue = new Map<string, string[]>();
  for (const o of options) {
    const v = normaliseRulingValue(o.value);
    if (v === null) return `the ruling option value ${JSON.stringify(o.value)} is not a number`;
    const key = v.toString();
    titlesByValue.set(key, [...(titlesByValue.get(key) ?? []), o.title]);
  }
  for (const [value, title] of Object.entries(expected)) {
    const titles = titlesByValue.get(value);
    if (titles === undefined)
      return `the expected ruling option ${value} (${JSON.stringify(title)}) is missing`;
    for (const t of titles)
      if (titleKey(t) !== titleKey(title))
        return `the ruling option ${value} is titled ${JSON.stringify(t)}, expected ${JSON.stringify(title)}`;
  }
  return null;
}

/**
 * The ruling the row's stored read gives, rebuilt from its columns. Only a row at `ruled` yields
 * a verdict to act on: a final read always advances the row to `ruled`, so a row still at filed
 * or evidence_unknown that holds a pay, refund or refusal value was stopped by the options check,
 * and that check is what it reports. A stored Evidence, Commit or Vote read is pending.
 */
export function rulingOfStoredRead(row: PilotCaseRecord): RulingOutcome {
  if (
    row.rulingStatus !== null &&
    PRE_RULING_PERIODS.has(row.rulingStatus as DisputeRead["status"])
  )
    return { kind: "pending" };
  if (row.rulingRoundCount !== null && row.rulingRoundCount > 1)
    return {
      kind: "appealed",
      roundCount: row.rulingRoundCount,
      value: row.rulingValue ?? "",
      tied: row.rulingTied === 1,
    };
  if (row.rulingTied === 1) return { kind: "tied" };
  const value = normaliseRulingValue(row.rulingValue);
  const verdict = value === REFUSED || value === PAY || value === REFUND;
  if (verdict && row.status !== "ruled")
    return { kind: "options_mismatch", detail: "the stored read did not rule the case" };
  if (value === REFUSED) return { kind: "refused" };
  if (value === PAY) return { kind: "pay" };
  if (value === REFUND) return { kind: "refund" };
  return { kind: "unexpected", value: row.rulingValue ?? "" };
}

export interface PollDeps {
  stage: KlerosStage;
  cases: PilotCaseRepository;
  expected: Record<string, string>;
  /** Milliseconds; default `Date.now`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollResult {
  read: DisputeRead;
  outcome: RulingOutcome;
  /** How far the read's `deadline` is behind the clock, when it is behind; absent otherwise. */
  overdueMs?: number;
  /** Set when the read has a `deadline` that is not a date, so its lateness cannot be told. */
  deadlineUnreadable?: true;
}

/** The statuses a read is taken on. `ruled` may be read again; it stays `ruled`. */
const READABLE: ReadonlySet<PilotStatus> = new Set(["filed", "evidence_unknown", "ruled"]);

/** A ruling the case is settled on: the first round's verdict, or a tie the court finalised. */
function isFinal(outcome: RulingOutcome, read: DisputeRead): boolean {
  if (outcome.kind === "pay" || outcome.kind === "refund" || outcome.kind === "refused")
    return true;
  return outcome.kind === "tied" && read.status === "Executed";
}

function refuse(message: string): never {
  throw new Error(`refusing: ${message}; nothing was sent to Kleros`);
}

/** The row, checked against the stage before any request: its mode, its status, its ids, and a
 *  chain that the stage's service is the deployment of. */
function readableRow(
  d: PollDeps,
  caseId: string,
): PilotCaseRecord & {
  klerosChain: NonNullable<PilotCaseRecord["klerosChain"]>;
  coreDisputeId: string;
} {
  const row = d.cases.find(caseId);
  if (!row) refuse(`no pilot case ${caseId}`);
  if (row.mode !== d.stage.mode)
    refuse(`case ${caseId} is a ${row.mode} case and this stage is ${d.stage.mode}`);
  if (!READABLE.has(row.status))
    refuse(`case ${caseId} is ${row.status}; a ruling is read at filed, evidence_unknown or ruled`);
  if (row.klerosChain === null) refuse(`case ${caseId} has no Kleros chain`);
  if (row.coreDisputeId === null) refuse(`case ${caseId} has no dispute id`);
  // A fresh fake knows nothing of the case and would replay its script over the verdict.
  if (d.stage.deployment === null && row.status === "ruled")
    refuse(
      `case ${caseId} is ruled (${rulingOfStoredRead(row).kind}); a rehearsal ruling is final once read, and a fresh fake can only replay its script: settle it with pilot:settle`,
    );
  const problem = stageChainProblem(d.stage, row);
  if (problem !== null) refuse(problem);
  return row as ReturnType<typeof readableRow>;
}

/**
 * Why the stage cannot read the row's dispute, or null when it can: the stage's service reads one
 * Kleros chain, its deployment's or the fake's for a rehearsal, and the same dispute id on another
 * chain is somebody else's case. Checked before any request; the poll and the settle's re-read
 * both run it, each refusing in its own words.
 */
export function stageChainProblem(stage: KlerosStage, row: PilotCaseRecord): string | null {
  const stageChain = stage.deployment === null ? "fake" : stage.deployment.chain;
  return row.klerosChain === stageChain
    ? null
    : `case ${row.caseId}'s dispute is on ${row.klerosChain} and this stage reads ${stageChain}`;
}

/**
 * One read with the row's `kleros_chain`, never a config value, written to the row's ruling
 * columns with the time of the read. Advances `filed` or `evidence_unknown` to `ruled` when the
 * outcome is final (pay, refund, refused, or a tie at Executed). On a row already ruled, a read
 * that is neither final nor an appeal keeps the stored ruling: only the period and the deadline
 * are written, with an event naming the outcome. A settle trusts a stored ruling for ten minutes
 * after the time of its read, so such a read never renews that time: a pending, tied or
 * unexpected read leaves it as it is, and a read that failed the options check clears it, so the
 * next settle reads Kleros live. An appeal is written in full. A rehearsal row at ruled is
 * refused. Refuses, before any request, a row of another mode than the stage's, a row without a
 * chain or a dispute id, a row at another status, and a row whose chain is not the one the
 * stage's service reads.
 */
export async function pollOnce(d: PollDeps, caseId: string): Promise<PollResult> {
  const now = d.now ?? Date.now;
  const row = readableRow(d, caseId);
  const read = await d.stage.service.getDispute({
    chain: row.klerosChain,
    coreDisputeId: row.coreDisputeId,
  });
  const at = now();
  const outcome = readRuling(read, d.expected);
  const patch: Partial<PilotCaseRecord> = {
    rulingStatus: read.status,
    rulingValue: read.ruling,
    rulingTied: read.tied ? 1 : 0,
    rulingRoundCount: read.roundCount,
    rulingLabel: read.rulingLabel ?? null,
    rulingReadAt: Math.floor(at / 1000),
    rulingDeadline: read.deadline,
  };
  // The compare-and-set is against the status seen before the request went out: a row another
  // command moved while the read was in flight (to settling, settled or failed) is left as it is.
  const from = row.status;
  const final = isFinal(outcome, read);
  const to: PilotStatus = final ? "ruled" : from;
  // A ruled case keeps its verdict against a later read that is not one: options the service
  // could not resolve, an unexpected value, or a tie in the appeal period. A read of a later
  // round is never kept, whatever the options check made of it: it is written in full, so a
  // settle sees the new round instead of acting on the first one.
  const appeal = read.roundCount > 1;
  const keepRuling = from === "ruled" && !final && !appeal;
  // A read that failed the options check revokes the trust in the stored verdict: with no time
  // of read, the next settle reads Kleros live instead of acting on it from the row.
  const mismatch = outcome.kind === "options_mismatch";
  const written: Partial<PilotCaseRecord> = keepRuling
    ? {
        rulingStatus: patch.rulingStatus,
        rulingDeadline: patch.rulingDeadline,
        ...(mismatch ? { rulingReadAt: null } : {}),
      }
    : patch;
  d.cases.transaction(() => {
    if (d.cases.advance(caseId, from, to, written) === undefined) {
      const found = d.cases.find(caseId)?.status ?? "missing";
      throw new Error(
        `pilot case ${caseId} moved from ${from} to ${found} during the read; the read was not written`,
      );
    }
    if (to !== from) d.cases.recordEvent(caseId, "ruling", outcome.kind, row.coreDisputeId, null);
    if (appeal && from === "ruled" && !final)
      d.cases.recordEvent(
        caseId,
        "ruling",
        "appealed",
        row.coreDisputeId,
        `a read of the ruled case shows round ${read.roundCount}; the read is written in full (${outcome.kind})`,
      );
    if (keepRuling)
      d.cases.recordEvent(
        caseId,
        "ruling",
        outcome.kind,
        row.coreDisputeId,
        mismatch
          ? "a read of the ruled case failed the options check; the stored ruling is kept, and the next settle reads Kleros again before acting on it"
          : "a read of the ruled case was not final; the stored ruling is kept",
      );
  });
  if (read.deadline === null) return { read, outcome };
  const behind = at - Date.parse(read.deadline);
  if (Number.isNaN(behind)) return { read, outcome, deadlineUnreadable: true };
  return behind > 0 ? { read, outcome, overdueMs: behind } : { read, outcome };
}

/** Whether `e` is a Kleros read that failed: no usable answer (a transport error) or an HTTP
 *  status. Any other error is a refusal or a bug, never a failed read. */
export function isKlerosReadFailure(e: unknown): e is KlerosTransportError | KlerosHttpError {
  return e instanceof KlerosTransportError || e instanceof KlerosHttpError;
}

/**
 * A failed Kleros read as the case's trail keeps it: one `ruling/read_failed` event, in the
 * service's own words, redacted (`klerosTextOf`), which it returns. A failed read is Kleros's
 * answer, not the platform's, so never `publicErrorMessage`'s fixed sentences.
 */
export function recordReadFailed(
  cases: PilotCaseRepository,
  caseId: string,
  e: KlerosTransportError | KlerosHttpError,
): string {
  const text = klerosTextOf(e);
  cases.recordEvent(
    caseId,
    "ruling",
    "read_failed",
    cases.find(caseId)?.coreDisputeId ?? null,
    text,
  );
  return text;
}

/**
 * A refusal because the ruling could not be read. Its words hold the service's, already
 * redacted by `klerosTextOf`, so a command prints them as they are: through
 * `publicErrorMessage`, a fee wallet's "insufficient funds" in Kleros's answer would read as the
 * platform's own wallet. The name stays `Error`, as every other refusal's.
 */
export class RulingReadRefusal extends Error {}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MINUTES = 180;
/** A watch rides out this many failed reads in a row (an outage of the service or the network,
 *  answered as a transport or HTTP error) and stops at the next one. */
export const MAX_FAILED_READS_IN_A_ROW = 5;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why a watch stopped: a final or non-pending outcome, the time cap, reads that kept failing,
 *  or the service refusing the key. */
export type PollStop = "outcome" | "max_minutes" | "reads_failing" | "auth_refused";

/** The HTTP statuses of a missing, unknown or refused key: waiting does not change the answer. */
const AUTH_REFUSED: ReadonlySet<number> = new Set([401, 403]);

/**
 * Reads until the outcome is anything but `pending`, or until `maxMinutes` have passed on the
 * injected clock, then stops with the last outcome. A transport or HTTP error is written as the
 * ops line `pilot_poll_read_failed` and a `read_failed` event on the case's trail, and the watch
 * goes on, up to `MAX_FAILED_READS_IN_A_ROW` in a row; any other error, a refusal included,
 * escapes. An HTTP 401 or 403 stops the watch at once with the reason `auth_refused`. A stop at
 * the cap, on failing reads or on a refused key writes the ops line `pilot_poll_capped` with its
 * reason. `reads` counts every request, failed ones included. `onRead` sees every read that
 * answered, as it is taken.
 */
export async function pollUntilRuled(
  d: PollDeps,
  caseId: string,
  opts: { intervalMs?: number; maxMinutes?: number; onRead?: (r: PollResult) => void },
): Promise<{ outcome: RulingOutcome; reads: number; stop: PollStop }> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? realSleep;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const capMs = (opts.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
  const start = now();
  let reads = 0;
  let failedInARow = 0;
  let outcome: RulingOutcome = { kind: "pending" };
  const capped = (reason: Exclude<PollStop, "outcome">, error?: string) => {
    const row = d.cases.find(caseId);
    opsLog("pilot_poll_capped", {
      caseId,
      mode: row?.mode,
      klerosChain: row?.klerosChain,
      reads,
      reason,
      ...(error === undefined ? {} : { error }),
    });
    return { outcome, reads, stop: reason };
  };
  for (;;) {
    reads++;
    let r: PollResult;
    try {
      r = await pollOnce(d, caseId);
    } catch (e) {
      if (!isKlerosReadFailure(e)) throw e;
      const text = recordReadFailed(d.cases, caseId, e);
      if (e instanceof KlerosHttpError && AUTH_REFUSED.has(e.status))
        return capped("auth_refused", text);
      failedInARow++;
      opsLog("pilot_poll_read_failed", {
        caseId,
        reads,
        failedInARow,
        error: text,
      });
      if (failedInARow > MAX_FAILED_READS_IN_A_ROW) return capped("reads_failing");
      if (now() - start >= capMs) return capped("max_minutes");
      await sleep(intervalMs);
      continue;
    }
    failedInARow = 0;
    outcome = r.outcome;
    opts.onRead?.(r);
    if (outcome.kind !== "pending") return { outcome, reads, stop: "outcome" };
    if (now() - start >= capMs) return capped("max_minutes");
    await sleep(intervalMs);
  }
}
