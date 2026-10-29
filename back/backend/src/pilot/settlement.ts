import { type Hex, toHex } from "viem";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import { normaliseRulingValue } from "../adapters/kleros/httpDisputeService";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../errors";
import { JobStatusOnChain } from "../jobs/refund";
import { opsLog } from "../observability/opsLog";
import { publicErrorMessage } from "../workflow/publicError";
import type { PilotCaseRepository } from "./casesRepository";
import type { KlerosStage, PilotChain } from "./composition";
import { withoutEmDash } from "./job";
import { type RulingOutcome, pollOnce } from "./ruling";
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

/** The Kleros dispute id as a 32-byte number: the `reason` of `complete` and `reject`, readable
 *  on the explorer. */
export function reasonFor(coreDisputeId: string): Hex {
  return toHex(BigInt(coreDisputeId), { size: 32 });
}

const isoOf = (unixSeconds: bigint | number) => new Date(Number(unixSeconds) * 1000).toISOString();

function notYetExpired(expiredAt: bigint): Error {
  return new Error(
    `refusing: the job expires at ${isoOf(expiredAt)}; no claimRefund before then, and nothing was sent`,
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
 * the clock strictly past `expiredAt`. `coreDisputeId` gives the reason of a `complete` or a
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
  if (now > escrow.expiredAt) return { action: "claimRefund", reason: null, outcome: "refunded" };
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

/** The ruling of a row at `ruled`: final by construction, its options checked when it was read. */
function rulingOfRuledRow(row: PilotCaseRecord): RulingOutcome {
  if (row.rulingRoundCount !== null && row.rulingRoundCount > 1)
    return {
      kind: "appealed",
      roundCount: row.rulingRoundCount,
      value: row.rulingValue ?? "",
      tied: row.rulingTied === 1,
    };
  if (row.rulingTied === 1) return { kind: "tied" };
  const value = normaliseRulingValue(row.rulingValue);
  if (value === 0n) return { kind: "refused" };
  if (value === 1n) return { kind: "pay" };
  if (value === 2n) return { kind: "refund" };
  return { kind: "unexpected", value: row.rulingValue ?? "" };
}

/** The ruling a row at `settling` was acting on, from the action it chose: the decision is taken
 *  again against the chain and the clock, never against a new read. */
function rulingOfAction(action: PilotCaseRecord["settleAction"]): RulingOutcome {
  if (action === "complete") return { kind: "pay" };
  if (action === "reject") return { kind: "refund" };
  return { kind: "pending" };
}

/** The row's stored hash when its transaction is mined and succeeded; null otherwise, which says
 *  another transaction moved the escrow. */
async function landedHash(d: SettleDeps, row: PilotCaseRecord): Promise<Hex | null> {
  if (row.settleTxHash === null) return null;
  const hash = row.settleTxHash as Hex;
  try {
    const receipt = await d.chain.publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? hash : null;
  } catch {
    return null;
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
 * before any read. A row at `settling` is decided again from the action it chose: an escrow the
 * chain shows settled is recorded with the stored hash when that transaction succeeded (null when
 * another one moved it), and a Submitted one is sent again. An escrow settled elsewhere is
 * recorded settled with no action of ours. With `send` false only the ruling read writes.
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

  let ruling: RulingOutcome;
  if (row.status === "settling" || row.status === "settled")
    ruling = rulingOfAction(row.settleAction);
  // The expiry path does not depend on the ruling, so a Kleros outage does not hold it up.
  else if (opts.claimRefundOnly) ruling = { kind: "pending" };
  else if (
    row.status === "ruled" &&
    row.rulingReadAt !== null &&
    nowSec() - row.rulingReadAt < RULING_FRESH_SECONDS
  )
    ruling = rulingOfRuledRow(row);
  else {
    ruling = (
      await pollOnce({ stage: d.stage, cases: d.cases, expected: d.expected, now: nowMs }, caseId)
    ).outcome;
    row = d.cases.find(caseId) as PilotCaseRecord;
  }

  const escrow = await d.chain.job.escrowState(jobId);
  const settlement = decideSettlement(ruling, escrow, nowSec(), {
    acceptRound: opts.acceptRound,
    claimRefundOnly: opts.claimRefundOnly,
    coreDisputeId: row.coreDisputeId ?? undefined,
  });

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
    return recordElsewhere(d, row, escrow, settlement, nowSec());
  }
  return send(d, row, jobId, settlement, nowSec);
}

/** The escrow is settled on chain: the row follows it, with our hash only if ours did it. */
async function recordElsewhere(
  d: SettleDeps,
  row: PilotCaseRecord,
  escrow: EscrowState,
  settlement: NoAction,
  at: number,
): Promise<{ settlement: Settlement }> {
  const hash = row.status === "settling" ? await landedHash(d, row) : null;
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
      `the chain shows the job ${STATUS_NAME[escrow.status] ?? escrow.status}${hash === null ? ", moved by another transaction" : ""}`,
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
      if (sent !== null) d.cases.patch(caseId, { settleTxHash: sent });
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
    if (!moved)
      throw new Error(
        `pilot case ${caseId} left settling while ${action} ${txHash} was sent; read the chain before acting`,
      );
    d.cases.recordEvent(caseId, "settle", "ok", txHash, action);
    return moved;
  });
  settledLine(settled, action, txHash);
  return { settlement, txHash };
}
