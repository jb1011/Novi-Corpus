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
 * The guardian's actions on the pot once it exists live in `safePotActions.ts`.
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
import { POT_SETUP_GAS_CAP, potAddresses, potStopArgs } from "./safePot";
import type { PotRaw, PotReading } from "./safePotRules";
import {
  notedBirthKey,
  notedPotChecked,
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

/** The setup step's stage. The sentences of the last answer live beside it, in the step. The
 *  review keeps the note its plan was made from (null for none): "Create the pot" reads the noted
 *  pot again and stops when it is not that one. `checking` is "Create the pot" before the wallet
 *  opens; `sending` is the wallet open. */
export type PotStage =
  | { at: "form" }
  | { at: "review"; plan: PotPlan; noted: OrderPotView | null; declared: boolean }
  | { at: "checking"; plan: PotPlan }
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

/** A read's answer or its error, never a throw. */
const settle = <T,>(read: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; cause: unknown }> =>
  read.then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );

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
  // 1. A failed read of the noted pot is the server's, said as such (`pot_unreadable`); the
  // others are the chain's.
  const [notedRead, walletRead, balanceRead] = await Promise.all([
    settle(d.readNoted()),
    settle(d.readRegistryWallet()),
    settle(d.readBalance()),
  ]);
  if (!notedRead.ok)
    return { ok: false, say: { problem: "pot_unreadable" }, kind: null, cause: notedRead.cause };
  if (!walletRead.ok) return readFailed(walletRead.cause);
  if (!balanceRead.ok) return readFailed(balanceRead.cause);
  const noted = notedRead.value;
  const wallet = walletRead.value;
  const balanceWei = balanceRead.value;
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
  /** Whether the step is still on screen (its lifetime): asked after every await, so a person who
   *  left gets no note and no wallet prompt. */
  alive(): boolean;
  preflight(): { ok: true } | { ok: false; problem: PotPreflightProblem };
  /** The eth_call of the request from the guardian, with its value: the return data. Throws on a
   *  revert. */
  simulate(): Promise<Hex>;
  /** eth_estimateGas of the same request, with NO fee field. Throws on a revert. */
  estimate(): Promise<bigint>;
  /** The guardian's balance in native wei, read again when the simulation or the estimate found
   *  the money short. Throws when it fails. */
  readBalance(): Promise<bigint>;
  /** `GET /pot`, a request made now, right before the note. Throws when it fails. */
  readNoted(): Promise<OrderPotView | null>;
  /** `getAgentWallet(agentId)` read now, right before the note, through `readAgentWallet`. */
  readRegistryWallet(): Promise<AgentWalletRead>;
  /** The note to the server (`declareOrderPot`, with the birth details and
   *  POT_DECLARATION_VERSION). Throws when it is refused or fails. */
  declare(): Promise<void>;
  /** The account connected NOW, right before the send: never the one of the click's start. */
  account(): Address | null;
  /** The allowlist's door to the wallet, with the gas limit decided here. */
  send(gas: bigint): Promise<{ ok: true; hash: Hex } | { ok: false; problem: string }>;
};

export type PotCreateProblem =
  | PotPreflightProblem
  | "would_revert"
  | "read_failed"
  | "record_failed"
  | "declined"
  | "pot_unreadable"
  | "stale_plan"
  | "no_gas"
  /** The step was gone: nothing more was done, and nothing is shown. */
  | "left";

export type PotCreateFailure =
  | { ok: false; problem: PotCreateProblem; cause?: unknown }
  /** The money fell short since the review: the balance read again, and the plan's own value. */
  | { ok: false; problem: "not_enough"; balanceWei: bigint; totalWei: bigint };

const LEFT: PotCreateFailure = { ok: false, problem: "left" };

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

/** Whether an error of `e`'s causes carries viem's `name`. Shared with `safePotActions.ts`. */
export const causeNamed = (e: unknown, name: string): boolean =>
  causesOf(e).some(
    (x) => typeof x === "object" && x !== null && (x as { name?: unknown }).name === name,
  );

/** viem's name for a node's refusal of a plain call, an estimate or a send: its code 3, or its
 *  words "execution reverted". A node that could not answer never carries it. */
const NODE_REVERT = "ExecutionRevertedError";
/** viem's name for a node's answer that the sender's balance does not cover the value (and the
 *  fee, when it asks one). */
export const MONEY_SHORT = "InsufficientFundsError";

/**
 * Whether the chain refused what was asked. viem names a revert two ways: through a contract call
 * `ContractFunctionRevertedError` (`isRevert` reads it, with its care for a node's internal error);
 * and for a plain `call`, an `estimateGas` or a send, `ExecutionRevertedError` inside its own
 * wrapper (`CallExecutionError`, `EstimateGasExecutionError`, `TransactionExecutionError`), which
 * `isRevert` alone does not see. A network failure or a timeout is neither.
 */
export function chainRefused(cause: unknown): boolean {
  return isRevert(cause) || causeNamed(cause, NODE_REVERT);
}

/**
 * Whether the plan still holds, read again right before the note: the noted pot is the one the
 * review planned from (none, when it planned with none; else a note of the plan's own address),
 * and the registry still names the key the review read (`plan.registryWallet`), in any letter
 * case. A registry that names none, or another key, does not hold.
 */
export function potPlanHolds(p: {
  plan: PotPlan;
  reviewed: OrderPotView | null;
  latest: OrderPotView | null;
  registry: AgentWalletRead;
}): boolean {
  const note =
    p.reviewed === null
      ? p.latest === null
      : p.latest !== null && sameAddress(p.latest.address, p.plan.pot);
  return note && isAddress(p.registry) && sameAddress(p.registry, p.plan.registryWallet);
}

/** A simulation or an estimate that threw: the money short (the guardian's balance read again,
 *  `not_enough` with the plan's own value), a refusal of the chain (`would_revert`), or a node
 *  that did not answer (`read_failed`). */
async function chainFailure(
  plan: PotPlan,
  cause: unknown,
  d: PotCreateDeps,
): Promise<PotCreateFailure> {
  if (causeNamed(cause, MONEY_SHORT)) {
    let balanceWei: bigint;
    try {
      balanceWei = await d.readBalance();
    } catch (e) {
      return d.alive() ? { ok: false, problem: "read_failed", cause: e } : LEFT;
    }
    if (!d.alive()) return LEFT;
    return { ok: false, problem: "not_enough", balanceWei, totalWei: plan.value };
  }
  return { ok: false, problem: chainRefused(cause) ? "would_revert" : "read_failed", cause };
}

/**
 * "Create the pot", in this order, stopping at the first that fails, and asking the step's
 * lifetime after EVERY await (`left`: a person who left gets no note and no wallet prompt):
 *  1. the page's own checks (their problem);
 *  2. the simulation, and `potSimulationOk` (`would_revert`);
 *  3. the estimate, and `potGasLimit` under POT_SETUP_GAS_CAP (`would_revert`). For 2 and 3, a
 *     throw is `not_enough` when the node says the money is short (the balance read again), else
 *     `would_revert` only when the chain refused it (`chainRefused`), else `read_failed`;
 *  4. the noted pot (`GET /pot`) and the registry's key read again, together: a failed read of the
 *     note is `pot_unreadable`, of the registry `read_failed`; a note that is not the review's, or
 *     a key that is not the plan's, is `stale_plan` (`potPlanHolds`), and nothing is noted; and the
 *     account connected now is the guardian's (as in 6), so a switched wallet leaves no note;
 *  5. the note of the pot and its declaration on the server (`record_failed`, with the error as
 *     `cause`): the server holds the declaration and the address before anything reaches the
 *     wallet;
 *  6. the account connected now is the guardian's, else `refused` with the allowlist's
 *     `wallet_is_not_the_guardian` as `cause`, and nothing is sent;
 *  7. the one transaction through the allowlist: a refusal is `refused`, with its code as `cause`;
 *     the wallet's no (`registerSendFailure`) is `declined`; a wallet that cannot pay the fee is
 *     `no_gas`; any other throw is `would_revert` only if the chain refused it, else `refused`.
 * `reviewed` is the note the plan was made from (null for none).
 */
export async function runPotCreate(
  plan: PotPlan,
  reviewed: OrderPotView | null,
  d: PotCreateDeps,
): Promise<{ ok: true; hash: Hex } | PotCreateFailure> {
  // 1.
  const pre = d.preflight();
  if (!pre.ok) return { ok: false, problem: pre.problem };

  // 2.
  let returned: Hex;
  try {
    returned = await d.simulate();
  } catch (cause) {
    return d.alive() ? chainFailure(plan, cause, d) : LEFT;
  }
  if (!d.alive()) return LEFT;
  if (!potSimulationOk(plan, returned)) return { ok: false, problem: "would_revert" };

  // 3.
  let estimate: bigint;
  try {
    estimate = await d.estimate();
  } catch (cause) {
    return d.alive() ? chainFailure(plan, cause, d) : LEFT;
  }
  if (!d.alive()) return LEFT;
  const gas = potGasLimit(estimate, POT_SETUP_GAS_CAP);
  if (gas === null) return { ok: false, problem: "would_revert" };

  // 4.
  const [latest, registry] = await Promise.all([
    settle(d.readNoted()),
    settle(d.readRegistryWallet()),
  ]);
  if (!d.alive()) return LEFT;
  if (!latest.ok) return { ok: false, problem: "pot_unreadable", cause: latest.cause };
  if (!registry.ok) return { ok: false, problem: "read_failed", cause: registry.cause };
  if (registry.value === "unreadable") return { ok: false, problem: "read_failed" };
  if (!potPlanHolds({ plan, reviewed, latest: latest.value, registry: registry.value }))
    return { ok: false, problem: "stale_plan" };
  // An account switched since the click leaves no note either.
  if (!sameAddress(d.account(), plan.guardian))
    return { ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" };

  // 5.
  try {
    await d.declare();
  } catch (cause) {
    return d.alive() ? { ok: false, problem: "record_failed", cause } : LEFT;
  }
  if (!d.alive()) return LEFT;

  // 6.
  if (!sameAddress(d.account(), plan.guardian))
    return { ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" };

  // 7.
  let sent: { ok: true; hash: Hex } | { ok: false; problem: string };
  try {
    sent = await d.send(gas);
  } catch (cause) {
    const failure = registerSendFailure(cause);
    if (failure.kind === "rejected") return { ok: false, problem: "declined", cause };
    if (failure.kind === "no_gas") return { ok: false, problem: "no_gas", cause };
    return { ok: false, problem: chainRefused(cause) ? "would_revert" : "refused", cause };
  }
  if (!sent.ok) return { ok: false, problem: "refused", cause: sent.problem };
  return { ok: true, hash: sent.hash };
}

// ---------------------------------------------------------------------------------------------
// After a refusal
// ---------------------------------------------------------------------------------------------

/** A refusal of the server's pot doors as the server wrote it: its code and its own sentence; null
 *  for no answer the server wrote (a timeout, an answer that is not the house envelope, no words).
 *  Shared with `safePotActions.ts`. */
export function potServedRefusal(e: unknown): { code: string; line: string } | null {
  if (
    e instanceof ApiError &&
    e.code !== TIMEOUT_CODE &&
    e.code !== "http_error" &&
    typeof e.message === "string" &&
    e.message.trim() !== ""
  )
    return { code: e.code, line: e.message };
  return null;
}

/** A failed note of the pot: the server's own sentence and the next step its code chooses; with
 *  no answer the server wrote, this page's own sentence and a try again. */
export function potNoteFailure(e: unknown): { next: PotServerNext; line: string } {
  const served = potServedRefusal(e);
  if (served !== null) return { next: potServerNext(served.code), line: served.line };
  return { next: "try_again", line: POT.problems.record_failed };
}

/**
 * Where the screen goes after "Create the pot" failed, and what it says:
 *  - review, the plan and the tick kept, for what the guardian can change in the wallet or by
 *    trying again: another account or network, the wallet's no, a node or a server that did not
 *    answer, a wallet that cannot pay the fee, a refusal of the allowlist (its own sentence), a
 *    note the server will take on a retry;
 *  - form, for a note the server refuses for what was chosen (and the grant or the record read
 *    again first when its code says so), for money that fell short since the review, and for a
 *    plan that no longer holds (the noted pot read again: review again);
 *  - problem, with Change something, for a chain that would refuse the transaction, or a pot the
 *    server already holds (the noted pot read again);
 *  - problem with nothing to click, where no retry can work: the page's own refusal before the
 *    wallet, or the server's stop. (`left` is never shown: the step is gone.)
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
    case "not_enough":
      return {
        to: "form",
        lines: [
          potProblemSentence({
            problem: "not_enough",
            balanceWei: f.balanceWei,
            totalWei: f.totalWei,
          }),
        ],
      };
    case "pot_unreadable":
    case "no_gas":
      return { to: "review", lines: [potProblemSentence({ problem: f.problem })] };
    case "stale_plan":
      return { to: "form", lines: [POT.problems.stale_plan], reread: "pot" };
    case "left":
      return { to: "problem", then: "none", lines: [] };
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

/** Whether the done page reads the pot for its FULL card (the grant, and the noted pot's raw facts
 *  for the record's agent wallet): only where `/config.legalBodies.pot` is true, on a chain in the
 *  pot's table, for a linked order that is not revoked, of this chain, with no notice beside it.
 *  Otherwise the full card reads nothing; the noted pot itself (`GET /pot`, Ruling R24) and the
 *  exit card's chain reads (`potExitAt`, Ruling R33) are read apart. */
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

/**
 * Where the EXIT CARD reads the pot (Ruling R33), or null when it has no place: Stop the allowance
 * and Take the money back stay reachable whatever happened to the legal body or the pot's flag.
 * The exit card stands wherever the full card does not: the pot's flag off, an order not linked
 * or revoked, a notice beside it (another deployment on this chain among them), or a record read
 * that names no agent wallet of the agent's own. While the full card may still show (its reads
 * allowed and the record not read yet), it has no place. It needs a noted pot, on the record or
 * taken off it, whose address the browser recomputes from its own birth details (Ruling R32), of
 * an order on the configured chain, which has a pot table. It reads the pot at that address,
 * against the record's agent wallet when it names one of the agent's own, otherwise against the
 * birth's first key: the reading is used only for whether the pot is the guardian's alone, its
 * lists and its balance, which do not depend on the key. Its reads are the browser's own, whatever
 * the flag: nothing of the server's pot doors but `GET /pot`, which takes no flag (Ruling R27).
 */
export function potExitAt(p: {
  potOffered: boolean;
  chainId: number;
  order: LegalBodyOrderView | null;
  notice: LegalBodyNotice | undefined;
  record: LegalBodyStatementJson | null;
  /** The record's read has answered (whatever it said). */
  recordRead: boolean;
  noted: OrderPotView | null | undefined;
}): { pot: Address; agentWallet: Address } | null {
  const o = p.order;
  if (o === null || p.noted === null || p.noted === undefined) return null;
  const a = potAddresses(p.chainId);
  if (a === null || o.chainId !== p.chainId) return null;
  const wallet = potRecordWallet(p.record, o.guardian);
  const fullCard =
    potReadsAllowed({ potOffered: p.potOffered, chainId: p.chainId, order: o, notice: p.notice }) &&
    (!p.recordRead || wallet !== null);
  if (fullCard) return null;
  const pot = notedPotChecked(a, o.guardian, p.noted);
  const birthKey = notedBirthKey(p.noted);
  if (pot === null || birthKey === null) return null;
  return { pot, agentWallet: wallet ?? birthKey };
}

/** What the exit card offers. */
export type PotExitOffer = "stop" | "withdraw" | "take_off_record";

/**
 * What the exit card offers for the pot as read (`potExitAt`'s address and key), or null when it
 * offers nothing: a pot that holds no pot's code or is not the guardian's alone shows no exit
 * card. Otherwise, in this order: "Stop the allowance" while the raw read lists a delegate or the
 * pot's module on (what `potStopArgs` has to stop); "Take the money back" while no module is on and
 * the balance is above 0; "Take the pot off the public record" while it is on the record. Never a
 * setup, money, a change or a restore.
 */
export function potExitOffers(
  raw: PotRaw,
  reading: PotReading,
  p: { chainId: number; guardian: Address; onRecord: boolean },
): PotExitOffer[] | null {
  if (reading.state === "absent" || reading.state === "not_the_guardians") return null;
  const a = potAddresses(p.chainId);
  if (a === null) return null;
  const offers: PotExitOffer[] = [];
  let stoppable = false;
  try {
    stoppable =
      potStopArgs(a, {
        guardian: p.guardian,
        delegates: raw.delegates.list,
        modules: raw.modules.list,
      }) !== null;
  } catch {
    stoppable = false;
  }
  if (stoppable) offers.push("stop");
  const balanceWei: unknown = raw.balanceWei;
  if (
    Array.isArray(raw.modules.list) &&
    raw.modules.list.length === 0 &&
    typeof balanceWei === "bigint" &&
    balanceWei > BigInt(0)
  )
    offers.push("withdraw");
  if (p.onRecord === true) offers.push("take_off_record");
  return offers.length === 0 ? null : offers;
}

/** The review's line for a wallet that takes no fee money, as this click read it: a delegated key
 *  or a contract wallet pays its fees its own way, so whatever the form held, none is sent. */
export function potReviewNote(plan: PotPlan): string | null {
  return plan.agentWalletKind === "delegated" || plan.agentWalletKind === "contract"
    ? POT.gasContract
    : null;
}

/** What the done page's pot card shows before the pot is read; once it is, the card is the pot's
 *  own (`PotManage`). */
export type PotCardShown =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "offer" }
  | { kind: "unreadable" };
