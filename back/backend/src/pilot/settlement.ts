import { type Hex, TransactionReceiptNotFoundError, formatUnits, toHex } from "viem";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import { normaliseRulingValue } from "../adapters/kleros/httpDisputeService";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../errors";
import { JobStatusOnChain } from "../jobs/refund";
import { opsLog } from "../observability/opsLog";
import { publicErrorMessage } from "../workflow/publicError";
import type { PilotCaseRepository } from "./casesRepository";
import type { KlerosStage, PilotChain } from "./composition";
import { withoutEmDash } from "./job";
import { type RulingOutcome, pollOnce, rulingOfStoredRead } from "./ruling";
import type { PilotCaseRecord, PilotStatus } from "./types";

/**
 * THE SETTLEMENT ON ARC: what the referee does with the job's escrow once the ruling is in.
 *
 * `decideSettlement` is pure: the ruling, the escrow as the chain reports it and the clock give
 * one action. `settleCase` reads, decides and, when asked to send, moves the row to `settling`
 * before the transaction and to `settled` after it. Acting once is a property of the chain:
 * `complete` and `reject` revert on a job that is no longer Submitted, and the decision never
 * sends on a job the chain says is settled, so a repeated run reads the chain and stops.
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
 * past the expiry the job can only be refunded, whatever the ruling; before it, only a Submitted
 * job with a pay or refund ruling is acted on, and not in the last ten minutes.
 *
 * `nowSeconds` and the escrow's `expiredAt` are unix seconds; the contract's `claimRefund` needs
 * the clock strictly past `expiredAt`, and the decision waits a further
 * `REFUND_CLOCK_MARGIN_SECONDS`. `coreDisputeId` gives the reason of a `complete` or a
 * `reject`. `claimRefundOnly` takes the expiry path and throws before the expiry.
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
  if (now > escrow.expiredAt + REFUND_CLOCK_MARGIN_SECONDS)
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

function refuse(message: string): never {
  throw new Error(`refusing: ${message}; nothing was sent`);
}

/** The ruling a row at `settling` was acting on, from the action it chose: the decision is taken
 *  again against the chain and the clock, never against a new read. */
function rulingOfAction(action: PilotCaseRecord["settleAction"]): RulingOutcome {
  if (action === "complete") return { kind: "pay" };
  if (action === "reject") return { kind: "refund" };
  return { kind: "pending" };
}

/** The receipt's status, or null while the node has none: the transaction is pending, or was
 *  dropped. Any other failure of the read escapes. */
async function receiptStatus(d: SettleDeps, hash: Hex): Promise<"success" | "reverted" | null> {
  try {
    return (await d.chain.publicClient.getTransactionReceipt({ hash })).status;
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return null;
    throw e;
  }
}

const STATUS_NAME: Record<number, string> = {
  [JobStatusOnChain.completed]: "Completed",
  [JobStatusOnChain.rejected]: "Rejected",
  [JobStatusOnChain.expired]: "Expired",
};

function settledLine(
  row: PilotCaseRecord,
  action: PilotCaseRecord["settleAction"],
  txHash: Hex | null,
): void {
  opsLog("pilot_case_settled", {
    caseId: row.caseId,
    mode: row.mode,
    klerosChain: row.klerosChain,
    action,
    txHash,
    coreDisputeId: row.coreDisputeId,
  });
}

/**
 * Re-reads the ruling (when the stored read is older than 10 minutes; with the ROW's
 * kleros_chain, in the row's mode only) and the escrow, decides, and with `send` advances to
 * settling (action, reason) before the transaction, then to settled with the hash.
 *
 * A row of another mode than the stage's, or at a status no settlement starts from, is refused
 * before any read. A row at `settling` with a stored hash reads that transaction's receipt first:
 * none yet is refused, a success is recorded settled with that hash, and a revert lets the row be
 * decided again from the action it chose, against the chain. An escrow settled elsewhere is
 * recorded settled with no action of ours. A rehearsal row that holds a read is decided from it,
 * whatever its age. With `send` false only the ruling read writes.
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
  // still land is the one thing the adapter says not to do.
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
    ruling = (
      await pollOnce({ stage: d.stage, cases: d.cases, expected: d.expected, now: nowMs }, caseId)
    ).outcome;
    row = d.cases.find(caseId) as PilotCaseRecord;
  }

  await checkConnectedChain(d, row);
  const escrow = await d.chain.job.escrowState(jobId);
  checkEscrowIsOwn(row, jobId, escrow);
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
  if (!opts.send) return { settlement };

  if (settlement.action === "none") {
    if (settlement.why !== "released_elsewhere" && settlement.why !== "refunded_elsewhere")
      return { settlement };
    return recordElsewhere(d, row, escrow, settlement, nowSec(), landed);
  }
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
  return send(d, row, jobId, settlement, nowSec);
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

/** The escrow is settled on chain: the row follows it, with our hash only when its receipt
 *  says our transaction succeeded. */
function recordElsewhere(
  d: SettleDeps,
  row: PilotCaseRecord,
  escrow: EscrowState,
  settlement: NoAction,
  at: number,
  hash: Hex | null,
): { settlement: Settlement } {
  const action = hash === null ? "none" : row.settleAction;
  d.cases.transaction(() => {
    const moved = d.cases.advance(row.caseId, row.status, "settled", {
      settleAction: action,
      settleTxHash: hash,
      settledAt: at,
      escrowOutcome: settlement.outcome ?? null,
    });
    if (!moved) refuse(`pilot case ${row.caseId} moved from ${row.status} while this command ran`);
    d.cases.recordEvent(
      row.caseId,
      "settle",
      "chain",
      hash,
      `the chain shows the job ${STATUS_NAME[escrow.status] ?? escrow.status}${hash === null ? ", moved by a transaction whose hash this row does not hold; the hash of our own send may be unknown" : ""}`,
    );
  });
  settledLine(row, action, hash);
  return { settlement };
}

async function send(
  d: SettleDeps,
  row: PilotCaseRecord,
  jobId: bigint,
  settlement: Extract<Settlement, { action: "complete" | "reject" | "claimRefund" }>,
  nowSec: () => number,
): Promise<{ settlement: Settlement; txHash: Hex }> {
  const { caseId } = row;
  const { action, reason } = settlement;
  // The row says what is about to be sent before it is sent: a crash after the broadcast leaves
  // it at settling, and the next run reads the chain before anything else.
  d.cases.transaction(() => {
    // The decision was made from the ruling this row held. A read that came in since (an appeal,
    // or a verdict read again) may have changed it, and the status alone would not show that.
    const current = d.cases.find(caseId);
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
  let txHash: Hex;
  try {
    if (action === "complete") txHash = await d.chain.job.complete(jobId, reason as Hex);
    else if (action === "reject")
      txHash = await d.chain.job.reject(jobId, reason as Hex, d.chain.wallets.referee);
    else txHash = await d.chain.job.claimRefund(jobId, d.chain.wallets.referee);
  } catch (e) {
    const sent =
      e instanceof ChainTxRevertedError || e instanceof ChainTxUnconfirmedError ? e.txHash : null;
    d.cases.transaction(() => {
      // Only while the row is still ours to write: a concurrent run may have settled it.
      if (sent !== null) d.cases.advance(caseId, "settling", "settling", { settleTxHash: sent });
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
  const settled = d.cases.transaction(() => {
    const moved = d.cases.advance(caseId, "settling", "settled", {
      settleTxHash: txHash,
      settledAt: nowSec(),
      escrowOutcome: settlement.outcome,
    });
    if (moved) d.cases.recordEvent(caseId, "settle", "ok", txHash, action);
    return moved;
  });
  if (!settled) {
    // The transaction succeeded: its hash stays on the trail even though the row moved away.
    d.cases.recordEvent(
      caseId,
      "settle",
      "sent",
      txHash,
      `${action} succeeded after the row left settling`,
    );
    throw new Error(
      `pilot case ${caseId} left settling while ${action} ${txHash} was sent; read the chain before acting`,
    );
  }
  settledLine(settled, action, txHash);
  return { settlement, txHash };
}
