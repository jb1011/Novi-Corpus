import {
  type Hex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  formatUnits,
  toHex,
} from "viem";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import { RECEIPT_TIMEOUT_MS } from "../adapters/arc/receipts";
import type { DisputeRead } from "../adapters/kleros/disputeService";
import { normaliseRulingValue } from "../adapters/kleros/httpDisputeService";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../errors";
import { JobStatusOnChain } from "../jobs/refund";
import { opsLog } from "../observability/opsLog";
import { parseSqliteUtc } from "../util/sqliteTime";
import { publicErrorMessage } from "../workflow/publicError";
import type { PilotCaseRepository } from "./casesRepository";
import type { KlerosStage, PilotChain } from "./composition";
import { FILING_IN_PROGRESS_SECONDS } from "./dispute";
import { jobCallOf, withoutEmDash } from "./job";
import { klerosTextOf } from "./klerosCheck";
import {
  type RulingOutcome,
  RulingReadRefusal,
  isKlerosReadFailure,
  pollOnce,
  readRuling,
  recordReadFailed,
  rulingOfStoredRead,
  stageChainProblem,
} from "./ruling";
import type { PilotCaseRecord, PilotStatus } from "./types";

/**
 * THE SETTLEMENT ON ARC: what the referee does with the job's escrow once the ruling is in.
 *
 * `decideSettlement` is pure: the ruling, the escrow as the chain reports it and the clock give
 * one action. `settleCase` reads, decides and, when asked to send, moves the row to `settling`
 * before the transaction and to `settled` after it. Acting once is a property of the chain:
 * `complete` and `reject` revert on a job that is no longer Submitted, and the decision never
 * sends on a job the chain says is settled, so a repeated run reads the chain and stops.
 * `refundUnfiledCase` takes back, once its job's expiry and the clock margin have passed, the
 * escrow of a case no ruling's settle reaches: one funded, submitted or contested, or failed.
 */
export type EscrowState = Awaited<ReturnType<JobAdapter["escrowState"]>>;

export type Settlement =
  | {
      action: "complete" | "reject" | "claimRefund";
      reason: Hex | null;
      outcome: "released" | "refunded";
    }
  | {
      action: "none";
      why:
        | "released_elsewhere"
        | "refunded_elsewhere"
        | "nothing_escrowed"
        | "ruling_pending"
        | "tied"
        | "refused"
        | "appealed"
        | "too_close_to_expiry"
        | "unknown_status"
        | "options_mismatch"
        | "unexpected_ruling";
      outcome?: "released" | "refunded" | "none";
    };

type NoAction = Extract<Settlement, { action: "none" }>;

/**
 * The last ten minutes before the expiry: a pay or refund sent then may land after the expiry,
 * when the job can only be refunded, so the referee waits and takes the expiry path instead.
 */
export const EXPIRY_MARGIN_SECONDS = 600;

/** A stored ruling read older than this is read again before the referee acts on it. */
const RULING_FRESH_SECONDS = 600;

/**
 * How long a settle's send may still be running after its `settle/sending` event, in seconds:
 * the adapter's receipt wait, and two minutes more for the broadcast before it and the writes
 * after it. A settling row with no hash is never sent on again while its latest send is younger
 * than this; past it, the next run decides again from the chain.
 */
export const SEND_IN_FLIGHT_SECONDS = RECEIPT_TIMEOUT_MS / 1000 + 120;

/**
 * The least native token the referee must hold to send its transaction: 0.1. The native token on
 * Arc is USDC with 18 decimals, so this is a tenth of a dollar, enough for many transactions at
 * the fee the network charges and far above a dust balance that could not pay for one.
 */
export const MIN_GAS_WEI = 10n ** 17n;

/**
 * How far past the escrow's `expiredAt` the box's clock must be before a `claimRefund` is
 * decided. The box's clock is compared with chain time, and the two can differ by a little: a
 * box clock that runs ahead would otherwise send a refund the contract still refuses.
 */
export const REFUND_CLOCK_MARGIN_SECONDS = 60n;

/** The Kleros dispute id as a 32-byte number: the `reason` of `complete` and `reject`, readable
 *  on the explorer. */
export function reasonFor(coreDisputeId: string): Hex {
  return toHex(BigInt(coreDisputeId), { size: 32 });
}

const isoOf = (unixSeconds: bigint | number) => new Date(Number(unixSeconds) * 1000).toISOString();

/** Whether the box's clock is past the escrow's expiry and the clock margin: the time a
 *  claimRefund is decided. The contract needs the clock strictly past `expiredAt`. */
function refundTimeReached(expiredAt: bigint, nowSeconds: number): boolean {
  return BigInt(nowSeconds) > expiredAt + REFUND_CLOCK_MARGIN_SECONDS;
}

function notYetExpired(expiredAt: bigint): Error {
  return new Error(
    `refusing: the job expires at ${isoOf(expiredAt)}; no claimRefund until ${REFUND_CLOCK_MARGIN_SECONDS} seconds after that, a margin for the difference between this box's clock and chain time, and nothing was sent`,
  );
}

/** An appealed round read as its own value, when the operator named that very round. */
function accepted(ruling: RulingOutcome, acceptRound: number | undefined): RulingOutcome {
  if (ruling.kind !== "appealed" || acceptRound !== ruling.roundCount) return ruling;
  if (ruling.tied) return { kind: "tied" };
  const value = normaliseRulingValue(ruling.value);
  if (value === 0n) return { kind: "refused" };
  if (value === 1n) return { kind: "pay" };
  if (value === 2n) return { kind: "refund" };
  return { kind: "unexpected", value: ruling.value };
}

const WAIT_FOR: Record<Exclude<RulingOutcome["kind"], "pay" | "refund">, NoAction["why"]> = {
  pending: "ruling_pending",
  tied: "tied",
  refused: "refused",
  appealed: "appealed",
  unexpected: "unexpected_ruling",
  options_mismatch: "options_mismatch",
};

/**
 * The decision, by the chain's status first: a settled escrow is reported and never sent on;
 * past the expiry and its clock margin the job can only be refunded, whatever the ruling; before
 * that, only a Submitted job with a pay or refund ruling is acted on, and not in the last ten
 * minutes before the expiry.
 *
 * `nowSeconds` and the escrow's `expiredAt` are unix seconds; the contract's `claimRefund` needs
 * the clock strictly past `expiredAt`, and the decision waits a further
 * `REFUND_CLOCK_MARGIN_SECONDS`. `coreDisputeId` gives the reason of a `complete` or a
 * `reject`. `claimRefundOnly` takes the expiry path and throws before the expiry and its margin.
 */
export function decideSettlement(
  ruling: RulingOutcome,
  escrow: EscrowState,
  nowSeconds: number,
  opts: { acceptRound?: number; claimRefundOnly?: boolean; coreDisputeId?: string } = {},
): Settlement {
  const { status } = escrow;
  if (status === JobStatusOnChain.completed)
    return { action: "none", why: "released_elsewhere", outcome: "released" };
  if (status === JobStatusOnChain.rejected || status === JobStatusOnChain.expired)
    return { action: "none", why: "refunded_elsewhere", outcome: "refunded" };
  if (status === JobStatusOnChain.open)
    return { action: "none", why: "nothing_escrowed", outcome: "none" };
  if (status !== JobStatusOnChain.funded && status !== JobStatusOnChain.submitted)
    return { action: "none", why: "unknown_status" };
  const now = BigInt(nowSeconds);
  if (refundTimeReached(escrow.expiredAt, nowSeconds))
    return { action: "claimRefund", reason: null, outcome: "refunded" };
  if (opts.claimRefundOnly) throw notYetExpired(escrow.expiredAt);
  if (status !== JobStatusOnChain.submitted) return { action: "none", why: "unknown_status" };
  const r = accepted(ruling, opts.acceptRound);
  if (r.kind !== "pay" && r.kind !== "refund") return { action: "none", why: WAIT_FOR[r.kind] };
  if (now > escrow.expiredAt - BigInt(EXPIRY_MARGIN_SECONDS))
    return { action: "none", why: "too_close_to_expiry" };
  if (opts.coreDisputeId === undefined)
    throw new Error("a pay or refund settlement needs the case's dispute id for its reason");
  const reason = reasonFor(opts.coreDisputeId);
  return r.kind === "pay"
    ? { action: "complete", reason, outcome: "released" }
    : { action: "reject", reason, outcome: "refunded" };
}

/**
 * Whether `decideSettlement` acts on the ruling for this escrow at this time: only for a Submitted
 * job outside the expiry's last ten minutes, which is also before the expiry path opens. Anywhere
 * else the chain and the clock decide alone, so a ruling read there would change nothing.
 */
export function decisionTurnsOnRuling(escrow: EscrowState, nowSeconds: number): boolean {
  return (
    escrow.status === JobStatusOnChain.submitted &&
    BigInt(nowSeconds) <= escrow.expiredAt - BigInt(EXPIRY_MARGIN_SECONDS)
  );
}

export interface SettleDeps {
  chain: PilotChain;
  cases: PilotCaseRepository;
  stage: KlerosStage;
  expected: Record<string, string>;
  /** Milliseconds, as the poll's clock; default `Date.now`. */
  now?: () => number;
}

/** The statuses a settlement starts from. `filed` and `evidence_unknown` reach the expiry path,
 *  or an appealed round the operator accepts; `settling` resumes; `settled` re-reads only. */
const SETTLEABLE: ReadonlySet<PilotStatus> = new Set([
  "filed",
  "evidence_unknown",
  "ruled",
  "settling",
  "settled",
]);

/**
 * The statuses whose escrow no ruling's settle takes back, refunded by claimRefund once the job
 * expired (`refundUnfiledCase`): a case funded but never filed, one whose filing went back to
 * contested with nothing filed, and a failed one. After the expiry and its margin the contract
 * allows no move but the refund to the client, whatever a dispute says, so a filing that started
 * changes nothing there.
 */
export const UNFILED_REFUND_STATUSES: ReadonlySet<PilotStatus> = new Set([
  "funded",
  "submitted",
  "contested",
  "failed",
]);

/** The statuses `pilot:settle --claim-refund` hands to `refundUnfiledCase`: the four it refunds,
 *  and the two filings in doubt it refuses, each naming the command that resolves it first. */
export const CLAIM_REFUND_UNFILED_ROUTE: ReadonlySet<PilotStatus> = new Set([
  ...UNFILED_REFUND_STATUSES,
  "filing",
  "filing_unknown",
]);

function refuse(message: string): never {
  throw new Error(`refusing: ${message}; nothing was sent`);
}

/** A refusal because the ruling could not be read, its words already in the service's redacted
 *  ones: the command prints it as it is. */
function refuseUnread(message: string): never {
  throw new RulingReadRefusal(`refusing: ${message}; nothing was sent`);
}

/** The settle events that are a send or the outcome of one, as opposed to a read or the chain's.
 *  A hash adopted through its proof, or cleared as dropped, is a send's outcome too. */
const SEND_TRAIL: ReadonlySet<string> = new Set([
  "sending",
  "sent",
  "reverted",
  "unconfirmed",
  "failed",
  "ok",
  "adopted",
  "dropped",
]);

/**
 * Refuses while the case's latest `settle/sending` event is younger than
 * {SEND_IN_FLIGHT_SECONDS} on the settle's clock, whatever the row's status. With
 * `outcomeEndsSend`, a sending event that its outcome (sent, reverted, unconfirmed, failed, ok,
 * adopted or dropped) already follows holds nothing: for a row whose hash reverted, where this
 * run's own revert ended its send but another run's newer one has not ended yet. The database
 * stamps the event; a stamp that cannot be read refuses too, since an unknown age never lets a
 * second send through. Run it before any read and again inside the transaction that records the
 * next `settle/sending` event, so two runs cannot both pass it.
 */
export function refuseWhileSendMayRun(
  cases: PilotCaseRepository,
  caseId: string,
  nowSec: number,
  o: { outcomeEndsSend?: boolean } = {},
): void {
  const trail = cases.events(caseId).filter((e) => e.step === "settle" && SEND_TRAIL.has(e.status));
  const last = o.outcomeEndsSend
    ? trail.at(-1)
    : trail.filter((e) => e.status === "sending").at(-1);
  if (last === undefined || last.status !== "sending") return;
  const age = ageOf(last, nowSec);
  if (age === null)
    refuse(
      `a settle may still be running on case ${caseId}: the time its send started cannot be read; read the chain and the case's trail before it is sent on again`,
    );
  if (age < SEND_IN_FLIGHT_SECONDS)
    refuse(
      `a settle may still be running on case ${caseId}: its send started ${age} s ago, and a send is treated as running for ${SEND_IN_FLIGHT_SECONDS} s; wait, then run again`,
    );
}

/** Seconds since the database stamped the event, on the settle's clock; null when the stamp cannot
 *  be read (the parser reads such a stamp as 0). */
function ageOf(e: { createdAt: string }, nowSec: number): number | null {
  const ms = parseSqliteUtc(e.createdAt);
  return ms === 0 ? null : nowSec - Math.floor(ms / 1000);
}

/** The ruling a row at `settling` was acting on, from the action it chose: the decision is taken
 *  again against the chain and the clock. A re-send on a real deployment from a stale read reads
 *  the ruling again instead (`readsBeforeResend`). */
function rulingOfAction(action: PilotCaseRecord["settleAction"]): RulingOutcome {
  if (action === "complete") return { kind: "pay" };
  if (action === "reject") return { kind: "refund" };
  return { kind: "pending" };
}

/**
 * Whether a settling row about to be sent on again (no hash, or one whose receipt reverted) may
 * read Kleros again: on a real deployment, when its stored read is missing or older than
 * RULING_FRESH_SECONDS, since the ruling may have moved on appeal after the action was chosen.
 * It reads only after the escrow, and only when the decision turns on the ruling
 * (`decisionTurnsOnRuling`). A claimRefund, stored or asked for, reads nothing: the expiry path
 * does not depend on the ruling. A rehearsal's fake cannot read the case again.
 */
function readsBeforeResend(
  row: PilotCaseRecord,
  opts: { claimRefundOnly?: boolean },
  nowSec: number,
): boolean {
  if (row.klerosChain === "fake") return false;
  if (row.settleAction === "claimRefund" || opts.claimRefundOnly) return false;
  return row.rulingReadAt === null || nowSec - row.rulingReadAt >= RULING_FRESH_SECONDS;
}

/**
 * The ruling read live before a re-send: one read of the row's dispute on the row's Kleros chain,
 * from the stage's Dispute Service once the stage is shown to read that chain, decided by
 * `readRuling` with the stage's expected options. Nothing is written to the row's status or
 * ruling columns; a `settle/reread` event names the outcome. A read that fails refuses, in the
 * service's redacted words, and a transport or HTTP failure leaves a `ruling/read_failed` event.
 */
async function rereadRuling(d: SettleDeps, row: PilotCaseRecord): Promise<RulingOutcome> {
  const { caseId, klerosChain, coreDisputeId } = row;
  if (klerosChain === null || coreDisputeId === null)
    refuse(
      `case ${caseId} has no Kleros chain or dispute id to read its ruling again before a new send`,
    );
  const problem = stageChainProblem(d.stage, row);
  if (problem !== null) refuse(problem);
  let read: DisputeRead;
  try {
    read = await d.stage.service.getDispute({ chain: klerosChain, coreDisputeId });
  } catch (e) {
    const text = isKlerosReadFailure(e) ? recordReadFailed(d.cases, caseId, e) : klerosTextOf(e);
    refuseUnread(`case ${caseId}'s ruling could not be read again before a new send: ${text}`);
  }
  const outcome = readRuling(read, d.expected);
  d.cases.recordEvent(caseId, "settle", "reread", coreDisputeId, outcome.kind);
  return outcome;
}

/** The decisions that wait on the ruling, as opposed to the chain or the clock. */
const WAITS_ON_RULING: ReadonlySet<NoAction["why"]> = new Set(Object.values(WAIT_FOR));

/** An outcome as a refusal names it: its kind, and the round of an appeal. */
const outcomeName = (r: RulingOutcome) =>
  r.kind === "appealed" ? `appealed (round ${r.roundCount})` : r.kind;

type Receipt = Awaited<ReturnType<PilotChain["publicClient"]["getTransactionReceipt"]>>;

/** The receipt, or null while the node has none: the transaction is pending, or was dropped.
 *  Any other failure of the read escapes. */
async function receiptOf(d: SettleDeps, hash: Hex): Promise<Receipt | null> {
  try {
    return await d.chain.publicClient.getTransactionReceipt({ hash });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return null;
    throw e;
  }
}

/** The receipt's status, or null while the node has none, as {receiptOf} reads it. */
async function receiptStatus(d: SettleDeps, hash: Hex): Promise<"success" | "reverted" | null> {
  return (await receiptOf(d, hash))?.status ?? null;
}

const STATUS_NAME: Record<number, string> = {
  [JobStatusOnChain.open]: "Open",
  [JobStatusOnChain.funded]: "Funded",
  [JobStatusOnChain.submitted]: "Submitted",
  [JobStatusOnChain.completed]: "Completed",
  [JobStatusOnChain.rejected]: "Rejected",
  [JobStatusOnChain.expired]: "Expired",
};

/** The chain's status as a refusal names it: its name, or its number when it has none. */
const statusName = (status: number) => STATUS_NAME[status] ?? String(status);

/** The ops line of an escrow settled on chain. A case whose escrow the expiry refund took back
 *  ends `failed`, not `settled`, and its line says so with `endsAt`; a settle's line is as it
 *  always was. */
function settledLine(
  row: PilotCaseRecord,
  action: PilotCaseRecord["settleAction"],
  txHash: Hex | null,
  endsAt?: "failed",
): void {
  opsLog("pilot_case_settled", {
    caseId: row.caseId,
    mode: row.mode,
    klerosChain: row.klerosChain,
    action,
    txHash,
    coreDisputeId: row.coreDisputeId,
    ...(endsAt === undefined ? {} : { endsAt }),
  });
}

/**
 * Reads the ruling and the escrow, decides, and with `send` advances to settling (action, reason)
 * before the transaction, then to settled with the hash.
 *
 * Before any read: the mode, the status (one no settlement starts from is refused), the job id,
 * and the configured job contract and chain id (`checkOwnConfig`). A row at `settling` is then
 * held while its latest send may still be running ({SEND_IN_FLIGHT_SECONDS}), and one with a
 * stored hash reads that transaction's receipt first: none yet is refused, a success is recorded
 * settled with that hash, and a revert lets the row be decided again against the chain.
 *
 * The ruling: a settling or settled row acts on the action it chose, and `claimRefundOnly` reads
 * none. A rehearsal row that holds a read is decided from it, whatever its age. A ruled row whose
 * stored read is younger than ten minutes is decided from it, unless an appealed round is
 * accepted, which is always read live. Any other row reads Kleros live, with the ROW's
 * kleros_chain, in the row's mode only; a read that fails refuses and leaves a
 * `ruling/read_failed` event. Then the connected chain, and the escrow read as the case's own job
 * (`checkEscrowIsOwn`). A settling row about to be sent on again, on a real deployment whose
 * stored read is stale, reads the ruling again after the escrow, when the decision turns on it
 * (`readsBeforeResend`). Then the decision.
 *
 * An escrow settled elsewhere is recorded settled with no action of ours, or with the row's when
 * the chain agrees with it. Before a send: the referee as the job's evaluator, and its gas floor
 * ({MIN_GAS_WEI}); the move to settling refuses while a send may still be running, and when the
 * row's hash, its ruling's time of read or its round count is no longer the one this run read.
 * With `send` false only the ruling reads write, with their events.
 */
export async function settleCase(
  d: SettleDeps,
  caseId: string,
  opts: { send: boolean; acceptRound?: number; claimRefundOnly?: boolean },
): Promise<{ settlement: Settlement; txHash?: Hex }> {
  const nowMs = d.now ?? Date.now;
  const nowSec = () => Math.floor(nowMs() / 1000);
  let row = d.cases.find(caseId);
  if (!row) refuse(`no pilot case ${caseId}`);
  if (row.mode !== d.stage.mode)
    refuse(`case ${caseId} is a ${row.mode} case and this stage is ${d.stage.mode}`);
  if (!SETTLEABLE.has(row.status))
    refuse(
      `case ${caseId} is ${row.status}; a settlement starts at filed, evidence_unknown, ruled, settling or settled`,
    );
  if (row.jobId === null) refuse(`case ${caseId} has no job id`);
  const jobId = BigInt(row.jobId);
  // What needs no network is checked before any read, so a row made for another deployment is
  // refused before Kleros is asked about it or a receipt is waited for.
  checkOwnConfig(d.chain, row);

  // Our earlier send is resolved before anything else: a second transaction while the first may
  // still land is the one thing the adapter says not to do. A row with no hash may be another
  // run's send, still before its broadcast or its hash's write; a row whose hash reverted may
  // have another run's newer send under way, its hash not yet written. Either waits out the
  // window, checked here before any read and again inside the move to settling, so two runs
  // cannot both pass.
  if (row.status === "settling")
    refuseWhileSendMayRun(d.cases, caseId, nowSec(), {
      outcomeEndsSend: row.settleTxHash !== null,
    });
  let landed: Hex | null = null;
  if (row.status === "settling" && row.settleTxHash !== null) {
    const hash = row.settleTxHash as Hex;
    const receipt = await receiptStatus(d, hash);
    if (receipt === null)
      refuse(
        `case ${caseId}'s ${row.settleAction} ${hash} has no receipt yet; wait until it is mined or dropped, then run again`,
      );
    if (receipt === "success") landed = hash;
  }

  let ruling: RulingOutcome;
  // A re-send that may read the ruling again does so after the escrow read, and only when the
  // decision turns on the ruling: a settled escrow or the expiry path never waits on Kleros.
  const mayReread =
    row.status === "settling" && landed === null && readsBeforeResend(row, opts, nowSec());
  if (row.status === "settling" || row.status === "settled")
    ruling = rulingOfAction(row.settleAction);
  // The expiry path does not depend on the ruling, so a Kleros outage does not hold it up.
  else if (opts.claimRefundOnly) ruling = { kind: "pending" };
  // Never widen this branch beyond the fake: on a real deployment the ruling can still change on
  // appeal, so its stored read is trusted only while fresh, and read again after that.
  else if (row.klerosChain === "fake" && row.rulingReadAt !== null)
    ruling = rulingOfStoredRead(row);
  // An accepted round is always read live, so the round acted on is one whose options passed.
  else if (
    row.status === "ruled" &&
    row.rulingReadAt !== null &&
    opts.acceptRound === undefined &&
    nowSec() - row.rulingReadAt < RULING_FRESH_SECONDS
  )
    ruling = rulingOfStoredRead(row);
  else {
    try {
      ruling = (
        await pollOnce({ stage: d.stage, cases: d.cases, expected: d.expected, now: nowMs }, caseId)
      ).outcome;
    } catch (e) {
      if (!isKlerosReadFailure(e)) throw e;
      // As the poll's watch does: the failed read leaves its line on the case's trail.
      refuseUnread(
        `case ${caseId}'s ruling could not be read: ${recordReadFailed(d.cases, caseId, e)}`,
      );
    }
    row = d.cases.find(caseId) as PilotCaseRecord;
  }

  await checkConnectedChain(d, row);
  const escrow = await d.chain.job.escrowState(jobId);
  checkEscrowIsOwn(row, jobId, escrow);
  // Set when the ruling of a settling row was read live before a re-send.
  let reread: RulingOutcome | null = null;
  if (mayReread && decisionTurnsOnRuling(escrow, nowSec())) {
    reread = await rereadRuling(d, row);
    ruling = reread;
  }
  const settlement = decideSettlement(ruling, escrow, nowSec(), {
    acceptRound: opts.acceptRound,
    claimRefundOnly: opts.claimRefundOnly,
    coreDisputeId: row.coreDisputeId ?? undefined,
  });

  if (landed !== null && settlement.action !== "none")
    refuse(
      `case ${caseId}'s ${row.settleAction} ${landed} succeeded but the chain shows job ${jobId} at status ${escrow.status}; read the chain before acting`,
    );
  if (row.status === "settled") {
    if (settlement.action !== "none")
      refuse(
        `case ${caseId} is settled but the chain shows job ${jobId} at status ${escrow.status}; read the chain before acting`,
      );
    return { settlement };
  }
  // A re-send acts on a final pay or refund read now, which may differ from the stored action:
  // the move to settling then writes the new one. Any other ruling is named, and nothing is sent.
  if (reread !== null && settlement.action === "none" && WAITS_ON_RULING.has(settlement.why))
    refuse(
      `case ${caseId}'s ruling, read again before a new send, is ${outcomeName(reread)}, not a pay or a refund to act on`,
    );
  if (!opts.send) return { settlement };

  if (settlement.action === "none") {
    if (settlement.why !== "released_elsewhere" && settlement.why !== "refunded_elsewhere")
      return { settlement };
    return recordElsewhere(d, row, escrow, settlement, nowSec(), landed);
  }
  await checkRefereeCanSend(d, jobId, escrow);
  return send(d, row, jobId, settlement, nowSec);
}

/**
 * The referee is the job's evaluator, and holds the gas to send: the last checks before a
 * settle's transaction. A balance that cannot be read refuses, in its public words.
 */
async function checkRefereeCanSend(
  d: SettleDeps,
  jobId: bigint,
  escrow: EscrowState,
): Promise<void> {
  const referee = d.chain.addresses.referee;
  if (escrow.evaluator.toLowerCase() !== referee.toLowerCase())
    refuse(`job ${jobId}'s evaluator is ${escrow.evaluator} and the referee is ${referee}`);
  // The referee signs the transaction and pays its gas: found out here, nothing has moved yet.
  let gas: bigint;
  try {
    gas = await d.chain.publicClient.getBalance({ address: referee });
  } catch (e) {
    refuse(`the referee's gas balance could not be read: ${publicErrorMessage(e)}`);
  }
  if (gas < MIN_GAS_WEI)
    refuse(
      `the referee's address ${referee} holds ${formatUnits(gas, 18)} of the native token and the floor to send its transaction is ${formatUnits(MIN_GAS_WEI, 18)}`,
    );
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The job contract and the chain id this process is configured with are the row's own: a row
 * never settles a job read from another deployment. It reads nothing from the network, so it
 * runs before any read; the poll's preview runs it too. Refuses with the values compared.
 */
export function checkOwnConfig(chain: PilotChain, row: PilotCaseRecord): void {
  if (!sameAddress(chain.jobContract, row.jobContract))
    refuse(
      `case ${row.caseId}'s job contract is ${row.jobContract} and the configured job contract is ${chain.jobContract}`,
    );
  if (chain.chainId !== row.chainId)
    refuse(
      `case ${row.caseId} is on chain id ${row.chainId} and the configured chain id is ${chain.chainId}`,
    );
}

/** The node this process is connected to is on the row's chain, whatever the configuration says. */
async function checkConnectedChain(d: SettleDeps, row: PilotCaseRecord): Promise<void> {
  const connected = await d.chain.publicClient.getChainId();
  if (connected !== row.chainId)
    refuse(
      `case ${row.caseId} is on chain id ${row.chainId} and the connected chain is ${connected}`,
    );
}

/**
 * The job read from the chain is the one the case was made for: its buyer, its evaluator, its
 * expiry and, while it holds funds, its budget are the row's. Exported for the poll's preview.
 */
export function checkEscrowIsOwn(row: PilotCaseRecord, jobId: bigint, escrow: EscrowState): void {
  if (!sameAddress(escrow.client, row.buyerAddress))
    refuse(`job ${jobId}'s client is ${escrow.client} and the case's buyer is ${row.buyerAddress}`);
  if (!sameAddress(escrow.evaluator, row.refereeAddress))
    refuse(
      `job ${jobId}'s evaluator is ${escrow.evaluator} and the case's referee is ${row.refereeAddress}`,
    );
  if (escrow.expiredAt !== BigInt(row.expiredAt))
    refuse(
      `job ${jobId}'s expiredAt is ${escrow.expiredAt} and the case's expiredAt is ${row.expiredAt}`,
    );
  // A budget only means something while the escrow holds it: a settled job reads as it ends.
  const holdsFunds =
    escrow.status === JobStatusOnChain.funded || escrow.status === JobStatusOnChain.submitted;
  if (holdsFunds && escrow.budget !== BigInt(row.budgetAtomic))
    refuse(
      `job ${jobId}'s budget is ${escrow.budget} and the case's budget is ${row.budgetAtomic}`,
    );
}

/** The status each of the three transactions leaves the job at. */
const STATUS_AFTER: Record<SendAction, number> = {
  complete: JobStatusOnChain.completed,
  reject: JobStatusOnChain.rejected,
  claimRefund: JobStatusOnChain.expired,
};

/**
 * The escrow is settled on chain: the row follows it, with our hash only when its receipt says
 * our transaction succeeded. Without that hash, the action the row chose is kept when the chain
 * shows the status that action leaves, since our own send may be the one that landed with its
 * hash unknown; `none` is written when they differ or the row chose no action.
 */
function recordElsewhere(
  d: SettleDeps,
  row: PilotCaseRecord,
  escrow: EscrowState,
  settlement: NoAction,
  at: number,
  hash: Hex | null,
): { settlement: Settlement } {
  const action = actionOnRecord(row, escrow.status, hash);
  d.cases.transaction(() => {
    const moved = d.cases.advance(row.caseId, row.status, "settled", {
      settleAction: action,
      settleTxHash: hash,
      settledAt: at,
      escrowOutcome: settlement.outcome ?? null,
    });
    if (!moved) refuse(`pilot case ${row.caseId} moved from ${row.status} while this command ran`);
    d.cases.recordEvent(row.caseId, "settle", "chain", hash, chainShows(escrow.status, hash));
  });
  settledLine(row, action, hash);
  return { settlement };
}

/**
 * The action a row the chain settled is recorded with: the one it chose when it holds our landed
 * hash, or when the chain shows the status that action leaves, since our own send may be the one
 * that landed with its hash unknown; `none` when they differ or the row chose no action.
 */
function actionOnRecord(
  row: PilotCaseRecord,
  chainStatus: number,
  hash: Hex | null,
): PilotCaseRecord["settleAction"] {
  const chose = row.settleAction;
  const agrees = chose !== null && chose !== "none" && STATUS_AFTER[chose] === chainStatus;
  return hash !== null || agrees ? chose : "none";
}

/** The detail of the `settle/chain` event: the status the chain shows, and whether this row holds
 *  the hash that moved it. A row that never recorded a send of its own (`sent` false) says so,
 *  as no hash of ours can be the unknown one. */
const chainShows = (chainStatus: number, hash: Hex | null, sent = true) => {
  const shows = `the chain shows the job ${statusName(chainStatus)}`;
  if (hash !== null) return shows;
  return sent
    ? `${shows}, moved by a transaction whose hash this row does not hold; the hash of our own send may be unknown`
    : `${shows}, moved by a transaction this case never sent`;
};

/** The three transactions a settlement sends. */
type SendAction = Extract<Settlement, { action: "complete" | "reject" | "claimRefund" }>["action"];

/**
 * The row as the run that sends left it: the status its send was recorded at (`settling` for a
 * settle) and the hash it held then (none, or a reverted one).
 */
export interface SendStart {
  status: PilotStatus;
  settleTxHash: string | null;
}

/** Writes `hash` on the row while it is still as `start` says, inside the caller's transaction.
 *  A row another command moved, or whose hash another run wrote, is left as it is. */
function writeHashIfUnmoved(
  cases: PilotCaseRepository,
  caseId: string,
  start: SendStart,
  hash: Hex,
): void {
  const current = cases.find(caseId);
  if (current?.status !== start.status || current.settleTxHash !== start.settleTxHash) return;
  cases.advance(caseId, start.status, start.status, { settleTxHash: hash });
}

/**
 * The hash of a settle's transaction, written the moment the node accepted it and before its
 * receipt is waited for: on the row while it is still as `start` says, and as a `settle/sent`
 * event with the action, whatever became of the row, so a row another command moved, or whose
 * hash another run wrote, keeps this hash on its trail and the other one on the row. One
 * transaction; it throws only when the database write fails.
 */
export function recordBroadcast(
  cases: PilotCaseRepository,
  caseId: string,
  start: SendStart,
  action: SendAction,
  hash: Hex,
): void {
  cases.transaction(() => {
    writeHashIfUnmoved(cases, caseId, start, hash);
    cases.recordEvent(caseId, "settle", "sent", hash, action);
  });
}

async function send(
  d: SettleDeps,
  row: PilotCaseRecord,
  jobId: bigint,
  settlement: Extract<Settlement, { action: SendAction }>,
  nowSec: () => number,
): Promise<{ settlement: Settlement; txHash: Hex }> {
  const { caseId } = row;
  const { action, reason } = settlement;
  // The row says what is about to be sent before it is sent: a crash after the broadcast leaves
  // it at settling, and the next run reads the chain before anything else.
  d.cases.transaction(() => {
    // Measured on the row as this run read it: another run's send that started since leaves its
    // sending event, and its hash may already be on the row.
    if (row.status === "settling")
      refuseWhileSendMayRun(d.cases, caseId, nowSec(), {
        outcomeEndsSend: row.settleTxHash !== null,
      });
    const current = d.cases.find(caseId);
    // A hash written since this run read the row is another run's broadcast.
    if (current !== undefined && current.settleTxHash !== row.settleTxHash)
      refuse(
        `pilot case ${caseId} moved while this command ran: its transaction hash is not the one this run read`,
      );
    // The decision was made from the ruling this row held. A read that came in since (an appeal,
    // or a verdict read again) may have changed it, and the status alone would not show that.
    if (
      current !== undefined &&
      (current.rulingReadAt !== row.rulingReadAt ||
        current.rulingRoundCount !== row.rulingRoundCount)
    )
      refuse(`case ${caseId}'s ruling was read again while this command ran; run it again`);
    const moved = d.cases.advance(caseId, row.status, "settling", {
      settleAction: action,
      settleReason: reason,
    });
    if (!moved) refuse(`pilot case ${caseId} moved from ${row.status} while this command ran`);
    d.cases.recordEvent(
      caseId,
      "settle",
      "sending",
      null,
      reason === null ? action : `${action} ${reason}`,
    );
  });
  const txHash = await sendFromReferee(
    d,
    caseId,
    jobId,
    { status: "settling", settleTxHash: row.settleTxHash },
    action,
    reason,
  );
  const settled = recordLanded(d, caseId, "settling", "settled", action, txHash, {
    settleTxHash: txHash,
    settledAt: nowSec(),
    escrowOutcome: settlement.outcome,
  });
  settledLine(settled, action, txHash);
  return { settlement, txHash };
}

/**
 * The settle's transaction, sent from the referee, its hash returned once its receipt is in. The
 * hash is written as soon as it exists (`recordBroadcast`): a transport error or a stop during the
 * receipt wait then leaves it on the row, and the next run reads its receipt before anything
 * else. A failure is recorded with the hash it names or the one the broadcast gave, and rethrown.
 */
async function sendFromReferee(
  d: SettleDeps,
  caseId: string,
  jobId: bigint,
  start: SendStart,
  action: SendAction,
  reason: Hex | null,
): Promise<Hex> {
  let broadcast: Hex | null = null;
  const hook = {
    onBroadcast: (hash: Hex) => {
      broadcast = hash;
      recordBroadcast(d.cases, caseId, start, action, hash);
    },
  };
  try {
    if (action === "complete") return await d.chain.job.complete(jobId, reason as Hex, hook);
    if (action === "reject")
      return await d.chain.job.reject(jobId, reason as Hex, d.chain.wallets.referee, hook);
    return await d.chain.job.claimRefund(jobId, d.chain.wallets.referee, hook);
  } catch (e) {
    // The hash the error names, or the one the broadcast gave: written again here, so a hook
    // whose own write failed does not lose it.
    const sent =
      e instanceof ChainTxRevertedError || e instanceof ChainTxUnconfirmedError
        ? e.txHash
        : broadcast;
    d.cases.transaction(() => {
      // Only while the row is still ours to write: a concurrent run may have settled it, or
      // written its own hash. A hash our hook already wrote is left as it is.
      if (sent !== null) writeHashIfUnmoved(d.cases, caseId, start, sent);
      d.cases.recordEvent(
        caseId,
        "settle",
        e instanceof ChainTxRevertedError
          ? "reverted"
          : e instanceof ChainTxUnconfirmedError
            ? "unconfirmed"
            : "failed",
        sent,
        withoutEmDash(publicErrorMessage(e)),
      );
    });
    throw e;
  }
}

/**
 * A send that landed, written on the row in one transaction with `settle/ok`, while the row is
 * still at `from`. A row another command moved meanwhile keeps the hash on its trail, and the run
 * says so.
 */
function recordLanded(
  d: SettleDeps,
  caseId: string,
  from: PilotStatus,
  to: PilotStatus,
  action: SendAction,
  txHash: Hex,
  patch: Partial<PilotCaseRecord>,
): PilotCaseRecord {
  const moved = d.cases.transaction(() => {
    const moved = d.cases.advance(caseId, from, to, patch);
    if (moved) d.cases.recordEvent(caseId, "settle", "ok", txHash, action);
    return moved;
  });
  if (!moved) {
    // The transaction succeeded: its hash stays on the trail even though the row moved away.
    d.cases.recordEvent(
      caseId,
      "settle",
      "sent",
      txHash,
      `${action} succeeded after the row left ${from}`,
    );
    throw new Error(
      `pilot case ${caseId} left ${from} while ${action} ${txHash} was sent; read the chain before acting`,
    );
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Recovery: a settle hash the row lost, and one the network dropped. Neither sends anything.
// ---------------------------------------------------------------------------

/** The three settle calls, in the order a refusal names them. */
const SEND_ACTIONS: readonly SendAction[] = ["complete", "reject", "claimRefund"];

/** What `pilot:settle --tx` proved about the transaction it was given, as it prints it. */
export interface SettleTxProof {
  hash: Hex;
  /** The transaction's sender and target, as the node returns them. */
  sender: string;
  target: string;
  action: SendAction;
  jobId: string;
  /** The reason of a complete or a reject; null for a claimRefund, which carries none. */
  reason: Hex | null;
  receipt: "success" | "reverted";
  /** The unix seconds of the block that holds it. */
  blockTime: number;
}

/** What an adoption writes on the row, or would write in a dry run, and the event it records. */
export interface AdoptWrite {
  status: "settling" | "settled";
  settleTxHash: Hex;
  settleAction: SendAction;
  settledAt?: number;
  escrowOutcome?: "released" | "refunded";
  event: { step: "settle"; status: "adopted"; ref: Hex; detail: string };
}

export type AdoptResult =
  | { unchanged: true; hash: Hex; status: PilotStatus }
  | { unchanged: false; proof: SettleTxProof; write: AdoptWrite; written: boolean };

const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A network read that refuses when it fails, in the redacted words of the failure. */
async function readOrRefuse<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    refuse(`${what} could not be read: ${withoutEmDash(publicErrorMessage(e))}`);
  }
}

/**
 * The call `hash` makes, proven to be one of this case's settles: sent by the case's referee to
 * the job contract, a complete, reject or claimRefund of the case's job, and for a complete or a
 * reject the case's reason (the row's, else the one its dispute id gives). A transaction the node
 * does not know, calldata that does not decode, or any field that differs refuses, naming the
 * field and both values.
 */
async function provenSettleCall(
  d: SettleDeps,
  row: PilotCaseRecord,
  jobId: bigint,
  hash: Hex,
): Promise<Pick<SettleTxProof, "sender" | "target" | "action" | "reason">> {
  const what = `case ${row.caseId}'s settle transaction ${hash}`;
  const call = await jobCallOf(d.chain, hash, {
    fn: SEND_ACTIONS,
    verb: "settles",
    jobId,
    sender: row.refereeAddress,
    role: "referee",
    retry: "check the hash, or run again once the node has it",
  });
  if (typeof call === "string") refuse(`${what} ${call}`);
  const action = call.functionName as SendAction;
  let reason: Hex | null = null;
  if (action !== "claimRefund") {
    const expected =
      row.settleReason ?? (row.coreDisputeId === null ? null : reasonFor(row.coreDisputeId));
    if (expected === null)
      refuse(
        `${what} is a ${action}, and the case holds no reason or dispute id to compare its reason with`,
      );
    reason = call.args[1] as Hex;
    if (!sameHash(reason, expected))
      refuse(`${what} has reason ${reason}, not the case's ${expected}`);
  }
  return { sender: call.tx.from, target: call.tx.to as string, action, reason };
}

/** The action a proven settle must be on this row: the one a settling row chose, and for a
 *  settled row the one it chose or none. */
function checkActionFits(row: PilotCaseRecord, action: SendAction, hash: Hex): void {
  if (row.status === "settling" && action !== row.settleAction)
    refuse(
      `case ${row.caseId} chose ${row.settleAction ?? "no action"} and ${hash} is a ${action}`,
    );
  if (row.status === "settled" && row.settleAction !== "none" && action !== row.settleAction)
    refuse(
      `case ${row.caseId} is settled with the action ${row.settleAction ?? "none recorded"} and ${hash} is a ${action}`,
    );
}

/** The receipt's status and its block's time; no receipt yet refuses, as still pending. */
async function minedOf(
  d: SettleDeps,
  row: PilotCaseRecord,
  action: SendAction,
  hash: Hex,
): Promise<Pick<SettleTxProof, "receipt" | "blockTime">> {
  const receipt = await readOrRefuse(`the receipt of ${hash}`, () => receiptOf(d, hash));
  if (receipt === null)
    refuse(
      `case ${row.caseId}'s ${action} ${hash} has no receipt yet: it is still pending: wait, then run again`,
    );
  // The block's time, never this box's: the row records when the chain settled the job.
  const block = await readOrRefuse(`the block of ${hash}`, () =>
    d.chain.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  );
  return { receipt: receipt.status, blockTime: Number(block.timestamp) };
}

const adoptedEvent = (hash: Hex, detail: string): AdoptWrite["event"] => ({
  step: "settle",
  status: "adopted",
  ref: hash,
  detail,
});

/** A settling row's adoption: settled with the hash on a success, the hash alone on a revert. */
function settlingWrite(proof: SettleTxProof): AdoptWrite {
  const { hash, action } = proof;
  if (proof.receipt === "reverted")
    return {
      status: "settling",
      settleTxHash: hash,
      settleAction: action,
      event: adoptedEvent(hash, `${action} reverted`),
    };
  return {
    status: "settled",
    settleTxHash: hash,
    settleAction: action,
    settledAt: proof.blockTime,
    escrowOutcome: action === "complete" ? "released" : "refunded",
    event: adoptedEvent(hash, action),
  };
}

/** A settled row's adoption: the hash and the action, once the receipt succeeded and the chain,
 *  read as the case's own job, shows the status the action leaves. */
async function settledWrite(
  d: SettleDeps,
  row: PilotCaseRecord,
  jobId: bigint,
  proof: SettleTxProof,
): Promise<AdoptWrite> {
  const { hash, action } = proof;
  if (proof.receipt !== "success")
    refuse(
      `case ${row.caseId}'s ${action} ${hash} reverted on chain, and a reverted transaction is never attached to a settled row`,
    );
  const escrow = await readOrRefuse(`job ${jobId}'s escrow`, () => d.chain.job.escrowState(jobId));
  checkEscrowIsOwn(row, jobId, escrow);
  if (escrow.status !== STATUS_AFTER[action])
    refuse(
      `the chain shows job ${jobId} ${statusName(escrow.status)} and ${hash} is a ${action}, which leaves it ${statusName(STATUS_AFTER[action])}`,
    );
  return {
    status: "settled",
    settleTxHash: hash,
    settleAction: action,
    event: adoptedEvent(hash, `${action}, attached to the settled row`),
  };
}

/**
 * `pilot:settle --tx`: a settle transaction the row lost, adopted only through its proof. It
 * sends nothing. By the row's status:
 * - settling with no hash: the proven action must be the one the row chose. A success moves the
 *   row to settled with the hash, its block's time and the outcome the action gives; a revert
 *   writes the hash and leaves the row at settling, for the next run to read. Held, like a send,
 *   while the row's last send may still be running, before any read and again at the write.
 * - settled with no hash, and the action none or the proven one: the hash and the action are
 *   attached once the receipt succeeded and the chain shows the status that action leaves; the
 *   outcome and the time stay as they are.
 * - holding a hash: refused unless it is the same one, which changes nothing.
 * - any other status: refused.
 * A transaction with no receipt yet is refused as still pending. The configured deployment is
 * checked before any read, the connected chain before the transaction is read, and the write
 * compares the row with the one this run read, in one transaction. With `write` false nothing is
 * written: the result is what was read and what would be written.
 */
export async function adoptSettleTx(
  d: SettleDeps,
  caseId: string,
  hash: Hex,
  opts: { write: boolean },
): Promise<AdoptResult> {
  const nowSec = () => Math.floor((d.now ?? Date.now)() / 1000);
  const row = d.cases.find(caseId);
  if (!row) refuse(`no pilot case ${caseId}`);
  if (row.mode !== d.stage.mode)
    refuse(`case ${caseId} is a ${row.mode} case and this stage is ${d.stage.mode}`);
  if (row.jobId === null) refuse(`case ${caseId} has no job id`);
  const jobId = BigInt(row.jobId);
  checkOwnConfig(d.chain, row);
  const { status } = row;
  if (status !== "settling" && status !== "settled")
    refuse(
      `case ${caseId} is ${status}; a settle transaction is adopted on a settling or settled case only`,
    );
  if (row.settleTxHash !== null) {
    if (!sameHash(row.settleTxHash, hash))
      refuse(
        `case ${caseId} is ${status} with settle transaction ${row.settleTxHash}, not ${hash}; a hash the row holds is never replaced`,
      );
    return { unchanged: true, hash: row.settleTxHash as Hex, status };
  }
  // A settling row with no hash may be another run's send, its hash not yet written: an adoption
  // then could leave the row free for a new send while that one still lands.
  if (status === "settling") refuseWhileSendMayRun(d.cases, caseId, nowSec());
  await checkConnectedChain(d, row);
  const call = await provenSettleCall(d, row, jobId, hash);
  checkActionFits(row, call.action, hash);
  const proof: SettleTxProof = {
    hash,
    ...call,
    jobId: jobId.toString(),
    ...(await minedOf(d, row, call.action, hash)),
  };
  const write =
    status === "settling" ? settlingWrite(proof) : await settledWrite(d, row, jobId, proof);
  if (!opts.write) return { unchanged: false, proof, write, written: false };
  d.cases.transaction(() => {
    if (status === "settling") refuseWhileSendMayRun(d.cases, caseId, nowSec());
    const current = d.cases.find(caseId);
    if (
      current?.status !== status ||
      current.settleTxHash !== null ||
      current.settleAction !== row.settleAction
    )
      refuse(`pilot case ${caseId} moved while this command ran`);
    const { event, status: to, ...patch } = write;
    if (!d.cases.advance(caseId, status, to, patch))
      refuse(`pilot case ${caseId} moved while this command ran`);
    d.cases.recordEvent(caseId, event.step, event.status, event.ref, event.detail);
  });
  if (status === "settling" && write.status === "settled")
    settledLine(row, write.settleAction, hash);
  return { unchanged: false, proof, write, written: true };
}

/**
 * How long after a settle's send its hash may be cleared as dropped, in seconds: well past the
 * time a send is treated as running ({SEND_IN_FLIGHT_SECONDS}), so a hash still on its way to the
 * node, or still in another node's pool, is not cleared on the first silence.
 */
export const DROP_GRACE_SECONDS = 600;

/** What `pilot:settle --dropped` read to prove the drop, as it prints it. */
export interface DropRead {
  hash: Hex;
  action: PilotCaseRecord["settleAction"];
  /** What the node answered for the hash: no receipt, and no transaction mined or pending. */
  receipt: null;
  transaction: null;
  /** Seconds since the case's latest settle/sending event, on the settle's clock. */
  sendAgeSeconds: number;
  escrowStatus: "Funded" | "Submitted";
}

/** The row as a cleared drop leaves it, at its own status with the action and the reason kept,
 *  and the event recorded. */
export interface DropWrite {
  status: PilotStatus;
  settleTxHash: null;
  settleAction: PilotCaseRecord["settleAction"];
  settleReason: string | null;
  event: { step: "settle"; status: "dropped"; ref: Hex; detail: string };
}

export interface DropResult {
  read: DropRead;
  write: DropWrite;
  written: boolean;
}

/** Whether the node knows the transaction, mined or pending; a failure other than "not found"
 *  escapes. */
async function transactionKnown(d: SettleDeps, hash: Hex): Promise<boolean> {
  try {
    await d.chain.publicClient.getTransaction({ hash });
    return true;
  } catch (e) {
    if (e instanceof TransactionNotFoundError) return false;
    throw e;
  }
}

/**
 * `pilot:settle --dropped`: the hash of a send, cleared once the network is proven to have
 * dropped it, so the next run decides again. It sends nothing. A settling row that holds a hash,
 * or a row of the expiry refund (funded, submitted, contested or failed) that holds the hash of
 * its claimRefund; the proof, in order: at least {DROP_GRACE_SECONDS} since the case's latest
 * settle/sending event (before any read), the connected chain is the row's, the node has no
 * receipt for the hash and no transaction under it, mined or pending, and the escrow, read as
 * the case's own job, is still Funded or Submitted. Any of them failing refuses, naming it. The
 * write, in one transaction, compares the row's status and hash with the ones this run read,
 * clears the hash, keeps the action and the reason, and records settle/dropped with the old hash;
 * the row stays at its status. With `write` false nothing is written.
 */
export async function clearDroppedSettleTx(
  d: SettleDeps,
  caseId: string,
  opts: { write: boolean },
): Promise<DropResult> {
  const nowSec = () => Math.floor((d.now ?? Date.now)() / 1000);
  const row = d.cases.find(caseId);
  if (!row) refuse(`no pilot case ${caseId}`);
  if (row.mode !== d.stage.mode)
    refuse(`case ${caseId} is a ${row.mode} case and this stage is ${d.stage.mode}`);
  if (row.jobId === null) refuse(`case ${caseId} has no job id`);
  const jobId = BigInt(row.jobId);
  checkOwnConfig(d.chain, row);
  // The expiry refund records its claimRefund at the row's own status, not at settling.
  const refundsByExpiry =
    UNFILED_REFUND_STATUSES.has(row.status) && row.settleAction === "claimRefund";
  if (row.status !== "settling" && !refundsByExpiry) {
    const action = UNFILED_REFUND_STATUSES.has(row.status)
      ? ` and its action is ${row.settleAction ?? "not recorded"}, not claimRefund`
      : "";
    refuse(
      `case ${caseId} is ${row.status}${action}; a hash is cleared as dropped on a settling case, or on a funded, submitted, contested or failed case whose claimRefund it is`,
    );
  }
  if (row.settleTxHash === null) refuse(`case ${caseId} holds no settle transaction hash to clear`);
  const hash = row.settleTxHash as Hex;
  // The send as the refusals and the event name it: its action, or words for a row with none.
  const sent = row.settleAction ?? "settle (no action recorded)";
  const what = `case ${caseId}'s ${sent} ${hash}`;
  const sending = d.cases
    .events(caseId)
    .filter((e) => e.step === "settle" && e.status === "sending")
    .at(-1);
  if (sending === undefined)
    refuse(`case ${caseId} has no settle/sending event, so the drop of ${hash} cannot be timed`);
  const age = ageOf(sending, nowSec());
  if (age === null)
    refuse(
      `the time case ${caseId}'s last send started cannot be read, so the drop of ${hash} cannot be timed`,
    );
  if (age < DROP_GRACE_SECONDS)
    refuse(
      `case ${caseId}'s last send started ${age} s ago, and a hash is cleared as dropped only ${DROP_GRACE_SECONDS} s after its send; wait, then run again`,
    );
  // A node on another chain knows nothing of the hash: it would read as dropped.
  await checkConnectedChain(d, row);
  // The receipt first: a transaction mined between the two reads is then found by the second.
  const receipt = await readOrRefuse(`the receipt of ${hash}`, () => receiptOf(d, hash));
  if (receipt !== null)
    refuse(
      `${what} has a receipt (${receipt.status}): it was mined, not dropped; run pilot:settle to read it`,
    );
  if (await readOrRefuse(`the transaction ${hash}`, () => transactionKnown(d, hash)))
    refuse(
      `${what} has no receipt but the node still knows it: it is pending, not dropped; wait, then run again`,
    );
  const escrow = await readOrRefuse(`job ${jobId}'s escrow`, () => d.chain.job.escrowState(jobId));
  checkEscrowIsOwn(row, jobId, escrow);
  if (escrow.status !== JobStatusOnChain.funded && escrow.status !== JobStatusOnChain.submitted)
    refuse(
      `job ${jobId} is ${statusName(escrow.status)}, not Funded or Submitted, so ${hash} is not cleared; run pilot:settle to read the chain`,
    );
  const escrowStatus = statusName(escrow.status) as DropRead["escrowStatus"];
  const read: DropRead = {
    hash,
    action: row.settleAction,
    receipt: null,
    transaction: null,
    sendAgeSeconds: age,
    escrowStatus,
  };
  const write: DropWrite = {
    status: row.status,
    settleTxHash: null,
    settleAction: row.settleAction,
    settleReason: row.settleReason,
    event: {
      step: "settle",
      status: "dropped",
      ref: hash,
      detail: `${sent} not mined and not pending ${age} s after its send; the escrow is ${escrowStatus}`,
    },
  };
  if (!opts.write) return { read, write, written: false };
  d.cases.transaction(() => {
    const current = d.cases.find(caseId);
    if (current?.status !== row.status || current.settleTxHash !== row.settleTxHash)
      refuse(`pilot case ${caseId} moved while this command ran`);
    if (!d.cases.advance(caseId, row.status, row.status, { settleTxHash: null }))
      refuse(`pilot case ${caseId} moved while this command ran`);
    const { event } = write;
    d.cases.recordEvent(caseId, event.step, event.status, event.ref, event.detail);
  });
  return { read, write, written: true };
}

// ---------------------------------------------------------------------------
// A case no ruling settles: its escrow, refunded by claimRefund after the expiry.
// ---------------------------------------------------------------------------

/** The failure reason of a case whose escrow our claimRefund took back. */
const REFUNDED_BY_CLAIM = "expired; escrow refunded by claimRefund";
/** The failure reason of a case whose escrow the chain shows refunded by a transaction this row
 *  does not hold. */
const REFUNDED_ELSEWHERE = "expired; escrow refunded elsewhere";

/** The escrow the refund read, as its dry run prints it. */
export interface UnfiledEscrowRead {
  /** The chain's status, by name. */
  status: string;
  budgetAtomic: string;
  /** Unix seconds. */
  expiredAt: number;
  /** How far past `expiredAt` the box's clock must be before claimRefund is sent. */
  refundMarginSeconds: number;
}

/** What the refund writes for an escrow the chain already refunded, or would write in a dry run,
 *  and the event it records. */
export interface UnfiledRecord {
  status: "failed";
  settleAction: PilotCaseRecord["settleAction"];
  settleTxHash: Hex | null;
  settledAt: number;
  escrowOutcome: "refunded";
  /** The failure reason; absent on a row already failed, which keeps the one it has. */
  error?: string;
  event: { step: "settle"; status: "chain"; ref: Hex | null; detail: string };
}

export interface UnfiledRefund {
  settlement: Settlement;
  escrow: UnfiledEscrowRead;
  /** The transaction sent, or the one a dry run would send; absent when nothing is to be sent. */
  send?: { action: "claimRefund"; jobId: string; from: string; to: string };
  txHash?: Hex;
  /** For an escrow the chain already refunded: what is written, or would be with `send`; null
   *  when the row already records the refund. */
  record?: UnfiledRecord | null;
  /** Whether `record` was written. */
  written?: boolean;
}

/** Why a filing in doubt is not refunded yet, naming the command that resolves it first. */
function filingInDoubt(row: PilotCaseRecord): string {
  const { caseId } = row;
  if (row.status === "filing")
    return `case ${caseId} is filing: a filing of it may still be running, and its dispute may exist; wait until ${FILING_IN_PROGRESS_SECONDS / 60} minutes after its filing started, then record its dispute ids with pilot:case set-ids and settle it, or run pilot:dispute on it with --yes, which freezes a filing that stopped at filing_unknown`;
  return `case ${caseId} is filing_unknown: its dispute may exist on Kleros; record its ids with pilot:case set-ids, then pilot:settle --case ${caseId} --claim-refund takes its expiry path, or mark it failed with pilot:case fail once Kleros confirms none exists, then run this command again`;
}

/**
 * `pilot:settle --claim-refund` on a case no ruling settles (funded, submitted, contested or
 * failed): its job's escrow back to the buyer by the referee's claimRefund, once the expiry and
 * its clock margin passed, and the row to `failed` with the escrow refunded. After the expiry the
 * contract allows no move but this refund, whatever a dispute says, so a case whose filing
 * started is refunded the same way. The cap's rule is unchanged: a failed row counts while its
 * filing started, so a case whose filing never started takes no slot, and one whose filing
 * started and went back to contested takes the slot a plain fail of it would. A case at filing or
 * filing_unknown is refused, naming the command that resolves it first.
 *
 * Before any read: the mode, the status, the job id, the configured deployment, and the in-flight
 * hold while an earlier send may still be running. A row that holds a hash reads that
 * transaction's receipt first: none yet refuses, a success is the transaction that landed, and a
 * revert lets the row be decided again. Then the connected chain, the escrow read as the case's
 * own job, and the expiry plus {REFUND_CLOCK_MARGIN_SECONDS}, before which nothing is decided. An
 * escrow the chain shows Expired or Rejected is recorded and nothing is sent; a Completed one, or
 * one that holds no escrow, refuses. A Funded or Submitted one is sent claimRefund, once the
 * referee is shown to be the job's evaluator with gas enough to send.
 *
 * The row says what is about to be sent before it is sent: in one transaction, held again by
 * the in-flight check and comparing the row with the one this run read, the action and a
 * `settle/sending` event, with no status change; the hash as soon as the node accepts the
 * transaction; and on success, in one transaction with a compare on the status this run read,
 * the row to failed with the hash, the time, the refunded outcome and the failure reason, with
 * `settle/ok`. A row already failed keeps the reason it failed for. With `send` false nothing is
 * written and nothing is sent: the result says what would be.
 */
export async function refundUnfiledCase(
  d: SettleDeps,
  caseId: string,
  opts: { send: boolean },
): Promise<UnfiledRefund> {
  const nowSec = () => Math.floor((d.now ?? Date.now)() / 1000);
  const row = d.cases.find(caseId);
  if (!row) refuse(`no pilot case ${caseId}`);
  if (row.mode !== d.stage.mode)
    refuse(`case ${caseId} is a ${row.mode} case and this stage is ${d.stage.mode}`);
  if (row.status === "filing" || row.status === "filing_unknown") refuse(filingInDoubt(row));
  if (!UNFILED_REFUND_STATUSES.has(row.status))
    refuse(
      `case ${caseId} is ${row.status}; its escrow is not refunded this way, which acts at funded, submitted, contested or failed`,
    );
  if (row.jobId === null) refuse(`case ${caseId} has no job id`);
  const jobId = BigInt(row.jobId);
  checkOwnConfig(d.chain, row);
  // As for a settling row: an earlier send may still be running, before its broadcast or its
  // hash's write; one whose hash the row holds is held only until its outcome is on the trail.
  refuseWhileSendMayRun(d.cases, caseId, nowSec(), { outcomeEndsSend: row.settleTxHash !== null });
  // A failed row may also hold the hash of a settle sent before it was failed.
  const held = row.settleAction;
  let landed: Hex | null = null;
  if (row.settleTxHash !== null) {
    const hash = row.settleTxHash as Hex;
    const receipt = await receiptStatus(d, hash);
    if (receipt === null)
      refuse(
        held === "claimRefund"
          ? `case ${caseId}'s claimRefund ${hash} has no receipt yet; wait until it is mined or dropped: once the network dropped it, pilot:settle --case ${caseId} --dropped clears it; then run again`
          : `case ${caseId}'s ${held ?? "settle transaction"} ${hash} has no receipt yet; wait until it is mined, then run again`,
      );
    if (receipt === "success") landed = hash;
  }

  await checkConnectedChain(d, row);
  const escrow = await d.chain.job.escrowState(jobId);
  checkEscrowIsOwn(row, jobId, escrow);
  const now = nowSec();
  // The expiry first: before it the case is still alive, whatever the chain shows.
  if (!refundTimeReached(escrow.expiredAt, now)) throw notYetExpired(escrow.expiredAt);
  const read: UnfiledEscrowRead = {
    status: statusName(escrow.status),
    budgetAtomic: escrow.budget.toString(),
    expiredAt: Number(escrow.expiredAt),
    refundMarginSeconds: Number(REFUND_CLOCK_MARGIN_SECONDS),
  };
  if (landed !== null && (held === null || held === "none" || escrow.status !== STATUS_AFTER[held]))
    refuse(
      `case ${caseId}'s ${held ?? "settle transaction"} ${landed} succeeded but the chain shows job ${jobId} ${statusName(escrow.status)}; read the chain before acting`,
    );
  if (escrow.status === JobStatusOnChain.completed)
    refuse(
      `the chain shows job ${jobId} Completed, its escrow released to the provider, so there is nothing to refund; read the chain before acting`,
    );
  if (escrow.status === JobStatusOnChain.rejected || escrow.status === JobStatusOnChain.expired) {
    const settlement = decideSettlement({ kind: "pending" }, escrow, now) as NoAction;
    const record = unfiledRecordOf(row, escrow, now, landed);
    if (opts.send && record !== null) writeUnfiledRecord(d, row, record);
    return { settlement, escrow: read, record, written: opts.send && record !== null };
  }
  if (escrow.status !== JobStatusOnChain.funded && escrow.status !== JobStatusOnChain.submitted)
    refuse(
      `the chain shows job ${jobId} ${statusName(escrow.status)}, which holds no escrow to refund; read the chain before acting`,
    );
  const settlement = decideSettlement({ kind: "pending" }, escrow, now, {
    claimRefundOnly: true,
  }) as Extract<Settlement, { action: "claimRefund" }>;
  const call = {
    action: "claimRefund" as const,
    jobId: jobId.toString(),
    from: d.chain.addresses.referee,
    to: d.chain.jobContract,
  };
  if (!opts.send) return { settlement, escrow: read, send: call };
  await checkRefereeCanSend(d, jobId, escrow);

  // The row says what is about to be sent before it is sent, at the status it holds: the case is
  // not moved to settling, a status the cap counts.
  d.cases.transaction(() => {
    refuseWhileSendMayRun(d.cases, caseId, nowSec(), {
      outcomeEndsSend: row.settleTxHash !== null,
    });
    const current = d.cases.find(caseId);
    // A hash or an action written since this run read the row is another run's send.
    if (current?.settleTxHash !== row.settleTxHash || current.settleAction !== row.settleAction)
      refuse(`pilot case ${caseId} moved while this command ran`);
    if (!d.cases.advance(caseId, row.status, row.status, { settleAction: "claimRefund" }))
      refuse(`pilot case ${caseId} moved from ${row.status} while this command ran`);
    d.cases.recordEvent(caseId, "settle", "sending", null, "claimRefund");
  });
  const txHash = await sendFromReferee(
    d,
    caseId,
    jobId,
    { status: row.status, settleTxHash: row.settleTxHash },
    "claimRefund",
    null,
  );
  const failed = recordLanded(d, caseId, row.status, "failed", "claimRefund", txHash, {
    settleTxHash: txHash,
    settledAt: nowSec(),
    escrowOutcome: "refunded",
    ...(row.status === "failed" ? {} : { error: REFUNDED_BY_CLAIM }),
  });
  settledLine(failed, "claimRefund", txHash, "failed");
  return { settlement, escrow: read, send: call, txHash };
}

/**
 * What the row records of an escrow the chain shows refunded: failed, with our hash when its
 * receipt says it succeeded, the action the chain agrees with, the time, the refunded outcome and
 * the failure reason; a row already failed keeps its reason. Null for a row that already records
 * the refund.
 */
function unfiledRecordOf(
  row: PilotCaseRecord,
  escrow: EscrowState,
  at: number,
  hash: Hex | null,
): UnfiledRecord | null {
  if (row.status === "failed" && row.escrowOutcome === "refunded") return null;
  return {
    status: "failed",
    settleAction: actionOnRecord(row, escrow.status, hash),
    settleTxHash: hash,
    settledAt: at,
    escrowOutcome: "refunded",
    ...(row.status === "failed"
      ? {}
      : { error: hash === null ? REFUNDED_ELSEWHERE : REFUNDED_BY_CLAIM }),
    event: {
      step: "settle",
      status: "chain",
      ref: hash,
      detail: chainShows(escrow.status, hash, row.settleAction !== null),
    },
  };
}

/** The record written in one transaction, while the row is still as this run read it. */
function writeUnfiledRecord(d: SettleDeps, row: PilotCaseRecord, record: UnfiledRecord): void {
  const { event, status, ...patch } = record;
  d.cases.transaction(() => {
    const current = d.cases.find(row.caseId);
    if (current?.settleTxHash !== row.settleTxHash || current.settleAction !== row.settleAction)
      refuse(`pilot case ${row.caseId} moved while this command ran`);
    if (!d.cases.advance(row.caseId, row.status, status, patch))
      refuse(`pilot case ${row.caseId} moved from ${row.status} while this command ran`);
    d.cases.recordEvent(row.caseId, event.step, event.status, event.ref, event.detail);
  });
  settledLine(row, record.settleAction, record.settleTxHash, "failed");
}
