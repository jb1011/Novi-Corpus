/**
 * The company's pot: the setup's two clicks, as runners over the reads and the writes handed in,
 * and where the screen goes after each answer.
 *
 * `safePotStep.ts` holds what one moment decides (the plan, the review, the checks); here, the
 * order in which the setup's clicks call the outside world:
 *
 *  - "Review" (`runPotReview`): every fact the plan decides on, read FRESH in the click: the noted
 *    pot from the server (never the card's cached answer: a stale "no note" is the one way left to
 *    plan a pot at another address), the registry's agent wallet and the guardian's balance, then
 *    the code at the noted address, then the agent wallet's code and the code at the predicted
 *    address. A failed read stops the click with `read_failed`, and nothing is planned;
 *  - "Create the pot" (`runPotCreate`): the page's own checks, the simulation and the estimate from
 *    the guardian, then the note of the pot with its declaration on the server, and only then the
 *    one transaction through the allowlist. The server holds the declaration and the address before
 *    anything reaches the wallet; a note that fails sends nothing.
 *
 * And, pure: where the screen goes after a refusal (`potCreateFailureView`, `potNoteFailure`), the
 * form's money fields (`potFormMoney`, `potFormBegin`), the salt number of the click's random bytes
 * (`potFreshSalt`), and whether the done page reads anything of the pot at all (`potReadsAllowed`).
 *
 * Nothing here holds a key, writes to a browser store or reads a clock.
 */
import { bytesToBigInt } from "viem";
import { TIMEOUT_CODE } from "@/lib/api/timeout";
import {
  ApiError,
  type Address,
  type Hex,
  type LegalBodyOrderView,
  type LegalBodyStatementJson,
  type OrderPotView,
} from "@/lib/api/types";
import { agentWalletOwed, type AgentWalletRead } from "./agentWallet";
import { walletKindOf, type WalletKind } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { sameAddress, type LegalBodyNotice } from "./flow";
import { isRevert, registerSendFailure } from "./identity";
import { POT_SETUP_GAS_CAP, potAddresses } from "./safePot";
import {
  potFormStart,
  potGasLimit,
  potPlan,
  potProblemSentence,
  potRefusalSentence,
  potSaltNonce,
  potServerNext,
  potSimulationOk,
  type PotForm,
  type PotFormCheck,
  type PotPlan,
  type PotProblem,
  type PotProblemSay,
  type PotServerNext,
} from "./safePotStep";

const POT = LEGAL_BODY_COPY.pot;

type Environment = "sandbox" | "production";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (x: unknown): x is Address => typeof x === "string" && ADDRESS.test(x);
/** A balance no guardian holds: the plan's own refusals, without the balance's. */
const ANY_BALANCE = BigInt(`0x${"f".repeat(64)}`);
/** The salt number's random bytes. */
const SALT_BYTES = 16;

// ---------------------------------------------------------------------------------------------
// What the step keeps
// ---------------------------------------------------------------------------------------------

/** What a problem offers: read the pot's address again (a transaction that may have landed), back
 *  to the form, or nothing (no retry can work). */
export type PotProblemThen = "check_again" | "form" | "none";

/** The setup step's stage. The sentences of the last answer live beside it, in the step. */
export type PotStage =
  | { at: "form" }
  | { at: "review"; plan: PotPlan; declared: boolean }
  | { at: "sending"; plan: PotPlan }
  | { at: "waiting"; plan: PotPlan; hash: Hex }
  | { at: "created"; plan: PotPlan; lines: string[]; ok: boolean }
  | { at: "problem"; problem: PotProblem; plan: PotPlan | null; hash?: Hex; then: PotProblemThen };

// ---------------------------------------------------------------------------------------------
// "Review": the reads of the click
// ---------------------------------------------------------------------------------------------

/** What "Review" reads, each in the click. */
export type PotReviewDeps = {
  /** `GET /pot`, a request made now. Throws when it fails. */
  readNoted(): Promise<OrderPotView | null>;
  /** `getAgentWallet(agentId)`, through `readAgentWallet`: "unreadable" when the read failed. */
  readRegistryWallet(): Promise<AgentWalletRead>;
  /** `getCode`. Throws when it fails. */
  readCode(address: Address): Promise<Hex | undefined>;
  /** The guardian's `getBalance`, in native wei. Throws when it fails. */
  readBalance(): Promise<bigint>;
  /** The click's own random salt number (`potFreshSalt` of 16 random bytes). */
  freshSalt(): bigint;
};

/** The review's answer: the plan, with the note and the agent wallet's kind it was made from; or
 *  the problem with the values its sentence names. `kind` is null when the click did not read the
 *  agent wallet's code. */
export type PotReviewResult =
  | { ok: true; plan: PotPlan; noted: OrderPotView | null; kind: WalletKind | null }
  | { ok: false; say: PotProblemSay; kind: WalletKind | null; cause?: unknown };

const readFailed = (cause: unknown): PotReviewResult => ({
  ok: false,
  say: { problem: "read_failed" },
  kind: null,
  cause,
});

/** A note's first ceiling in units, as `potPlan` read it. */
function notedCeilingUnits(noted: OrderPotView | null): bigint | null {
  const raw: unknown = noted?.birth?.ceilingUnits;
  return typeof raw === "string" && /^[1-9][0-9]{0,77}$/.test(raw) ? BigInt(raw) : null;
}

/** A plan's refusal, with the values its sentence names. `potPlan` never answers the two problems
 *  of the wallet's own checks; a refusal whose values are not there is the plain refusal. */
function sayOf(
  problem: PotProblem,
  v: { noted: OrderPotView | null; balanceWei: bigint; totalWei: bigint | null },
): PotProblemSay {
  switch (problem) {
    case "noted_pot": {
      const units = notedCeilingUnits(v.noted);
      return units === null ? { problem: "refused" } : { problem, notedCeilingUnits: units };
    }
    case "not_enough":
      return v.totalWei === null
        ? { problem: "refused" }
        : { problem, balanceWei: v.balanceWei, totalWei: v.totalWei };
    case "not_this_wallet":
    case "wrong_network":
      return { problem: "refused" };
    default:
      return { problem };
  }
}

/**
 * "Review", after the form's own check: every read the plan decides on, made now, in this order,
 * stopping at the first that fails (`read_failed`, with the error as `cause`):
 *  1. `GET /pot`, the registry's agent wallet and the guardian's balance, together;
 *  2. the code at the noted address, when there is a note: one pot for life is decided first;
 *  3. `potPlan`'s own rules on these reads, so a wallet it refuses has no code read for it;
 *  4. the agent wallet's code (its kind: fee money goes to a plain key only) and the code at the
 *     predicted address, which for a note is the noted address already read.
 * Then `potPlan` on them all. The salt is the note's whenever there is a note (`potSaltNonce`),
 * otherwise the click's own random number.
 */
export async function runPotReview(
  p: { chainId: number; guardian: Address; checked: Extract<PotFormCheck, { ok: true }> },
  d: PotReviewDeps,
): Promise<PotReviewResult> {
  // 1.
  let noted: OrderPotView | null;
  let wallet: AgentWalletRead;
  let balanceWei: bigint;
  try {
    [noted, wallet, balanceWei] = await Promise.all([
      d.readNoted(),
      d.readRegistryWallet(),
      d.readBalance(),
    ]);
  } catch (cause) {
    return readFailed(cause);
  }
  if (noted !== null && !isAddress(noted.address))
    return { ok: false, say: { problem: "refused" }, kind: null };
  // 2.
  let notedCode: Hex | undefined;
  if (noted !== null) {
    try {
      notedCode = await d.readCode(noted.address);
    } catch (cause) {
      return readFailed(cause);
    }
  }
  const base = {
    chainId: p.chainId,
    guardian: p.guardian,
    agentWallet: wallet,
    checked: p.checked,
    saltNonce: potSaltNonce({ noted, fresh: d.freshSalt() }),
    noted,
    notedCode,
  };
  // 3. potPlan's refusals do not depend on the two codes still to read, nor (with this balance)
  // on the balance: the same refusal the full plan would give, in the same order.
  const dry = potPlan({ ...base, agentCode: undefined, potCode: undefined, guardianBalanceWei: ANY_BALANCE });
  if (!dry.ok)
    return { ok: false, say: sayOf(dry.problem, { noted, balanceWei, totalWei: null }), kind: null };
  // 4. The plan passed its wallet rule: the registry names an address of the agent's own. With a
  // note, the predicted address is the noted one (potPlan refuses any other).
  let agentCode: Hex | undefined;
  let potCode: Hex | undefined;
  try {
    [agentCode, potCode] = await Promise.all([
      d.readCode(dry.plan.registryWallet),
      noted !== null ? Promise.resolve(notedCode) : d.readCode(dry.plan.pot),
    ]);
  } catch (cause) {
    return readFailed(cause);
  }
  const kind = walletKindOf(agentCode);
  const reads = { ...base, agentCode, potCode };
  const planned = potPlan({ ...reads, guardianBalanceWei: balanceWei });
  if (planned.ok) return { ok: true, plan: planned.plan, noted, kind };
  // The total the balance does not cover is the plan's own value, for this kind of wallet.
  const total =
    planned.problem === "not_enough" ? potPlan({ ...reads, guardianBalanceWei: ANY_BALANCE }) : null;
  return {
    ok: false,
    say: sayOf(planned.problem, {
      noted,
      balanceWei,
      totalWei: total !== null && total.ok ? total.plan.value : null,
    }),
    kind,
  };
}

/** The salt number of the click's 16 random bytes (`crypto.getRandomValues`). */
export function potFreshSalt(bytes: Uint8Array): bigint {
  if (bytes.length !== SALT_BYTES) throw new Error("a salt number takes 16 random bytes");
  return bytesToBigInt(bytes);
}

// ---------------------------------------------------------------------------------------------
// "Create the pot": before and at the wallet
// ---------------------------------------------------------------------------------------------

/** The page's own checks before the wallet (`potSendPreflight`). */
export type PotPreflightProblem = "not_this_wallet" | "wrong_network" | "refused";

/** What "Create the pot" does before and at the wallet. Each is the component's own closure over
 *  the plan. */
export type PotCreateDeps = {
  preflight(): { ok: true } | { ok: false; problem: PotPreflightProblem };
  /** The eth_call of the request from the guardian, with its value: the return data. Throws on a
   *  revert. */
  simulate(): Promise<Hex>;
  /** eth_estimateGas of the same request, with NO fee field. Throws on a revert. */
  estimate(): Promise<bigint>;
  /** The note to the server (`declareOrderPot`, with the birth details and
   *  POT_DECLARATION_VERSION). Throws when it is refused or fails. */
  declare(): Promise<void>;
  /** The allowlist's door to the wallet, with the gas limit decided here. */
  send(gas: bigint): Promise<{ ok: true; hash: Hex } | { ok: false; problem: string }>;
};

export type PotCreateProblem =
  | PotPreflightProblem
  | "would_revert"
  | "read_failed"
  | "record_failed"
  | "declined";

export type PotCreateFailure = { ok: false; problem: PotCreateProblem; cause?: unknown };

/** Each error of a cause chain, the first one included; a chain that loops ends. */
function causesOf(e: unknown): unknown[] {
  const chain: unknown[] = [];
  let at: unknown = e;
  while (at !== null && at !== undefined && chain.length < 12 && !chain.includes(at)) {
    chain.push(at);
    at = typeof at === "object" ? (at as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** viem's name for a node's refusal of a plain call, an estimate or a send: its code 3, or its
 *  words "execution reverted". A node that could not answer never carries it. */
const NODE_REVERT = "ExecutionRevertedError";

/**
 * Whether the chain refused what was asked. viem names a revert two ways: through a contract call
 * `ContractFunctionRevertedError` (`isRevert` reads it, with its care for a node's internal error);
 * and for a plain `call`, an `estimateGas` or a send, `ExecutionRevertedError` inside its own
 * wrapper (`CallExecutionError`, `EstimateGasExecutionError`, `TransactionExecutionError`), which
 * `isRevert` alone does not see. A network failure or a timeout is neither.
 */
function chainRefused(cause: unknown): boolean {
  if (isRevert(cause)) return true;
  return causesOf(cause).some(
    (x) => typeof x === "object" && x !== null && (x as { name?: unknown }).name === NODE_REVERT,
  );
}

/** A simulation or an estimate that threw: the chain refused it only when the error says it
 *  reverted; a node that could not answer is a read that failed, never a refusal. */
const chainAnswer = (cause: unknown): "would_revert" | "read_failed" =>
  chainRefused(cause) ? "would_revert" : "read_failed";

/**
 * "Create the pot", in this order, stopping at the first that fails: the page's own checks
 * (their problem); the simulation, and `potSimulationOk` (`would_revert`); the estimate, and
 * `potGasLimit` under POT_SETUP_GAS_CAP (`would_revert`); the note of the pot and its declaration
 * on the server (`record_failed`, with the error as `cause`); the one transaction through the
 * allowlist (a refusal is `refused`, with its code as `cause`; the wallet's no, read with
 * `registerSendFailure`, is `declined`; any other throw is `would_revert` only if the chain refused
 * it, else `refused`). A simulation or an estimate that threw without a revert is `read_failed`:
 * the node did not answer, and the chain refused nothing. "The chain refused it" is `isRevert`, or
 * viem's `ExecutionRevertedError` anywhere in the error's causes (`chainRefused`).
 */
export async function runPotCreate(
  plan: PotPlan,
  d: PotCreateDeps,
): Promise<{ ok: true; hash: Hex } | PotCreateFailure> {
  const pre = d.preflight();
  if (!pre.ok) return { ok: false, problem: pre.problem };

  let returned: Hex;
  try {
    returned = await d.simulate();
  } catch (cause) {
    return { ok: false, problem: chainAnswer(cause), cause };
  }
  if (!potSimulationOk(plan, returned)) return { ok: false, problem: "would_revert" };

  let estimate: bigint;
  try {
    estimate = await d.estimate();
  } catch (cause) {
    return { ok: false, problem: chainAnswer(cause), cause };
  }
  const gas = potGasLimit(estimate, POT_SETUP_GAS_CAP);
  if (gas === null) return { ok: false, problem: "would_revert" };

  // The server holds the declaration and the address before anything reaches the wallet.
  try {
    await d.declare();
  } catch (cause) {
    return { ok: false, problem: "record_failed", cause };
  }

  let sent: { ok: true; hash: Hex } | { ok: false; problem: string };
  try {
    sent = await d.send(gas);
  } catch (cause) {
    if (registerSendFailure(cause).kind === "rejected")
      return { ok: false, problem: "declined", cause };
    return { ok: false, problem: chainRefused(cause) ? "would_revert" : "refused", cause };
  }
  if (!sent.ok) return { ok: false, problem: "refused", cause: sent.problem };
  return { ok: true, hash: sent.hash };
}

// ---------------------------------------------------------------------------------------------
// After a refusal
// ---------------------------------------------------------------------------------------------

/** A failed note of the pot: the server's own sentence and the next step its code chooses; with
 *  no answer the server wrote (a timeout, an answer that is not the house envelope, no words),
 *  this page's own sentence and a try again. */
export function potNoteFailure(e: unknown): { next: PotServerNext; line: string } {
  if (
    e instanceof ApiError &&
    e.code !== TIMEOUT_CODE &&
    e.code !== "http_error" &&
    typeof e.message === "string" &&
    e.message.trim() !== ""
  )
    return { next: potServerNext(e.code), line: e.message };
  return { next: "try_again", line: POT.problems.record_failed };
}

/**
 * Where the screen goes after "Create the pot" failed, and what it says:
 *  - review, the plan and the tick kept, for what the guardian can change in the wallet or by
 *    trying again: another account or network, the wallet's no, a node that did not answer, a
 *    refusal of the allowlist (its own sentence), a note the server will take on a retry;
 *  - form, for a note the server refuses for what was chosen (and the grant or the record read
 *    again first when its code says so);
 *  - problem, with Change something, for a chain that would refuse the transaction, or a pot the
 *    server already holds (the noted pot read again);
 *  - problem with nothing to click, where no retry can work: the page's own refusal before the
 *    wallet, or the server's stop.
 */
export type PotFailureView = {
  to: "review" | "form" | "problem";
  then?: "form" | "none";
  lines: string[];
  reread?: "pot" | "grant" | "record";
};

export function potCreateFailureView(
  f: PotCreateFailure,
  p: { environment: Environment; guardian: Address },
): PotFailureView {
  switch (f.problem) {
    case "not_this_wallet":
      return {
        to: "review",
        lines: [potProblemSentence({ problem: f.problem, guardian: p.guardian })],
      };
    case "wrong_network":
      return {
        to: "review",
        lines: [potProblemSentence({ problem: f.problem, environment: p.environment })],
      };
    case "declined":
    case "read_failed":
      return { to: "review", lines: [potProblemSentence({ problem: f.problem })] };
    case "refused":
      if (typeof f.cause === "string")
        return { to: "review", lines: [potRefusalSentence(f.cause, p)] };
      if (f.cause !== undefined) return { to: "review", lines: [POT.problems.refused] };
      return { to: "problem", then: "none", lines: [POT.problems.refused] };
    case "would_revert":
      return { to: "problem", then: "form", lines: [POT.problems.would_revert] };
    case "record_failed": {
      const { next, line } = potNoteFailure(f.cause);
      switch (next) {
        case "try_again":
          return { to: "review", lines: [line] };
        case "back_to_form":
          return { to: "form", lines: [line] };
        case "reread_pot":
          return { to: "problem", then: "form", lines: [line], reread: "pot" };
        case "reread_grant":
          return { to: "form", lines: [line], reread: "grant" };
        case "reread_record":
          return { to: "form", lines: [line], reread: "record" };
        case "stop":
          return { to: "problem", then: "none", lines: [line] };
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The form's money fields
// ---------------------------------------------------------------------------------------------

/** What the form offers for money, and the lines beside it: the pot's money and the fee money for
 *  a plain key (gasLine), or for a kind no click has read yet; the pot's money and `gasContract`
 *  in place of the fee field for a delegated key or a contract wallet; no money field at all for
 *  the noted pot made for another key than the one the record names now (Ruling R19: it is
 *  created with no money, and the new key comes after). */
export type PotFormMoney = { fields: "key" | "no_fee" | "none"; lines: string[] };

/** The noted pot's first key, when it is not the one the record names now. */
function notedForAnotherKey(noted: OrderPotView | null, registryWallet: Address): Address | null {
  const first: unknown = noted?.birth?.agentWallet;
  if (!isAddress(first)) return null;
  return sameAddress(first, registryWallet) ? null : first;
}

/** The form's money fields. `kind` is the last click's read of the agent wallet (null before any
 *  click); `noted` and `registryWallet` are the done page's, for what the form shows only: the
 *  click reads them again before it plans anything. */
export function potFormMoney(p: {
  kind: WalletKind | null;
  noted: OrderPotView | null;
  registryWallet: Address;
}): PotFormMoney {
  const other = notedForAnotherKey(p.noted, p.registryWallet);
  if (other !== null)
    return {
      fields: "none",
      lines: [
        fillCopy(POT.reviewAgentNoted, { address: other, registry: p.registryWallet }),
        POT.reviewKeyChanged,
      ],
    };
  if (p.kind === "delegated" || p.kind === "contract")
    return { fields: "no_fee", lines: [POT.gasContract] };
  return { fields: "key", lines: [POT.gasLine] };
}

/** The form as it opens (`potFormStart`): the ceiling EMPTY but for the noted pot that never got
 *  code, whose own ceiling it holds; nothing to put in the pot; 0.1 USDC of fee money proposed for
 *  a plain key, or a kind not read yet; no money at all where the form shows no money field. */
export function potFormBegin(p: {
  kind: WalletKind | null;
  noted: OrderPotView | null;
  registryWallet: Address;
}): PotForm {
  const start = potFormStart(p.kind ?? "key", p.noted?.birth ?? null);
  return potFormMoney(p).fields === "none" ? { ...start, fund: "", agentGas: "" } : start;
}

// ---------------------------------------------------------------------------------------------
// The done page
// ---------------------------------------------------------------------------------------------

/** Whether the done page reads anything of the pot: only where `/config.legalBodies.pot` is true,
 *  on a chain in the pot's table, for a linked order that is not revoked, of this chain, with no
 *  notice beside it. Otherwise nothing of the pot is asked of the server or the chain. */
export function potReadsAllowed(p: {
  potOffered: boolean;
  chainId: number;
  order: LegalBodyOrderView | null;
  notice: LegalBodyNotice | undefined;
}): boolean {
  const o = p.order;
  return (
    p.potOffered === true &&
    potAddresses(p.chainId) !== null &&
    o !== null &&
    o.state === "linked" &&
    o.revoked === false &&
    o.chainId === p.chainId &&
    p.notice === undefined
  );
}

/** The record's agent wallet the done page reads the pot for: an address of the agent's own, never
 *  the zero address or the guardian's (the wallet card shows then); null otherwise. */
export function potRecordWallet(
  record: LegalBodyStatementJson | null,
  guardian: Address,
): Address | null {
  const wallet: unknown = record?.agentWallet;
  if (!isAddress(wallet) || agentWalletOwed(wallet, guardian)) return null;
  return wallet;
}

/** The review's line for a wallet that takes no fee money, as this click read it: a delegated key
 *  or a contract wallet pays its fees its own way, so whatever the form held, none is sent. */
export function potReviewNote(plan: PotPlan): string | null {
  return plan.agentWalletKind === "delegated" || plan.agentWalletKind === "contract"
    ? POT.gasContract
    : null;
}

/** What the done page's pot card shows. */
export type PotCardShown =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "offer" }
  | { kind: "manage"; lines: string[] }
  | { kind: "unreadable" };
