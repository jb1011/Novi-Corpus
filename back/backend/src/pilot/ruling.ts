import type { DisputeRead } from "../adapters/kleros/disputeService";
import { normaliseRulingValue } from "../adapters/kleros/httpDisputeService";
import { opsLog } from "../observability/opsLog";
import type { PilotCaseRepository } from "./casesRepository";
import type { KlerosStage } from "./composition";
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
  const mismatch = optionsMismatch(read.rulingOptions, expected);
  if (mismatch !== null) return { kind: "options_mismatch", detail: mismatch };
  if (PRE_RULING_PERIODS.has(read.status) && !read.ruled) return { kind: "pending" };
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
  const stageChain = d.stage.deployment === null ? "fake" : d.stage.deployment.chain;
  if (row.klerosChain !== stageChain)
    refuse(`case ${caseId}'s dispute is on ${row.klerosChain} and this stage reads ${stageChain}`);
  return row as ReturnType<typeof readableRow>;
}

/**
 * One read with the row's `kleros_chain`, never a config value, written to the row's ruling
 * columns with the time of the read. Advances `filed` or `evidence_unknown` to `ruled` when the
 * outcome is final (pay, refund, refused, or a tie at Executed). Refuses, before any request, a
 * row of another mode than the stage's, a row without a chain or a dispute id, a row at another
 * status, and a row whose chain is not the one the stage's service reads.
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
  d.cases.transaction(() => {
    const current = d.cases.find(caseId);
    if (current === undefined) throw new Error(`pilot case ${caseId} not found`);
    if (isFinal(outcome, read) && current.status !== "ruled") {
      const advanced = d.cases.advance(caseId, current.status, "ruled", patch);
      if (advanced === undefined)
        throw new Error(`pilot case ${caseId} moved from ${current.status} during the read`);
      d.cases.recordEvent(caseId, "ruling", outcome.kind, row.coreDisputeId, null);
    } else {
      d.cases.patch(caseId, patch);
    }
  });
  const deadlineMs = read.deadline === null ? Number.NaN : Date.parse(read.deadline);
  const behind = at - deadlineMs;
  return Number.isFinite(behind) && behind > 0
    ? { read, outcome, overdueMs: behind }
    : { read, outcome };
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_MINUTES = 180;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads until the outcome is anything but `pending`, or until `maxMinutes` have passed on the
 * injected clock, then stops with the last outcome; a stop at the cap writes the ops line
 * `pilot_poll_capped`. `onRead` sees every read as it is taken.
 */
export async function pollUntilRuled(
  d: PollDeps,
  caseId: string,
  opts: { intervalMs?: number; maxMinutes?: number; onRead?: (r: PollResult) => void },
): Promise<{ outcome: RulingOutcome; reads: number }> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? realSleep;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const capMs = (opts.maxMinutes ?? DEFAULT_MAX_MINUTES) * 60_000;
  const start = now();
  let reads = 0;
  for (;;) {
    const r = await pollOnce(d, caseId);
    reads++;
    opts.onRead?.(r);
    if (r.outcome.kind !== "pending") return { outcome: r.outcome, reads };
    if (now() - start >= capMs) {
      const row = d.cases.find(caseId);
      opsLog("pilot_poll_capped", {
        caseId,
        mode: row?.mode,
        klerosChain: row?.klerosChain,
        reads,
      });
      return { outcome: r.outcome, reads };
    }
    await sleep(intervalMs);
  }
}
