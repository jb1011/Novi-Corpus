/**
 * The company's pot once it exists: the guardian's actions on the SAME pot, each one transaction
 * the guardian sends (`runPotAction`): change the allowance, stop it, take the money back, start
 * again, and move the allowance to a new key. One pot for life: there is never a second one.
 *
 * The context of each is built from the click's own reads of the registry and the pot
 * (`potActionContext`), never from what the card was drawn with; then the sentences of its
 * failures, and what the card shows after the receipt (`potActionFailureView`,
 * `potActionDoneView`, `potActionAfter`), and the ceiling typed for it (`potCeilingCheck`).
 *
 * Then the two USDC transfers of the card, "Add money" (to the noted pot) and "Send fee money" (to
 * the agent's key), each one `transfer` the guardian sends (`runPotTransfer`), with the amount
 * typed for it (`potTransferAmount`) and what the card says before and after; and what the card
 * says when taking the pot off the public record, or putting it back, was refused
 * (`potRecordFailureView`).
 *
 * Nothing here holds a key, writes to a browser store or reads a clock.
 */
import type { Address, Hex, OrderPotView } from "@/lib/api/types";
import type { AgentWalletRead } from "./agentWallet";
import { formatNative, type PotCallContext } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { sameAddress } from "./flow";
import { registerSendFailure } from "./identity";
import {
  formatUsdcUnits,
  parseUsdcAmount,
  POT_AGENT_GAS_MAX_UNITS,
  POT_CEILING_MAX_USDC,
  POT_EXEC_GAS_CAP,
  POT_FUND_MAX_UNITS,
  POT_TRANSFER_GAS_CAP,
  unitsToWei,
  USDC_UNIT,
} from "./safePot";
import type { PotCeilingCap, PotRaw, PotReading } from "./safePotRules";
import {
  causeNamed,
  chainRefused,
  MONEY_SHORT,
  potServedRefusal,
  type PotPreflightProblem,
} from "./safePotRun";
import {
  potCreatedView,
  potFeeLines,
  potFormCheck,
  potGasLimit,
  potProblemSentence,
  potRefusalSentence,
  potServerNext,
} from "./safePotStep";

const POT = LEGAL_BODY_COPY.pot;

type Environment = "sandbox" | "production";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isAddress = (x: unknown): x is Address => typeof x === "string" && ADDRESS.test(x);

// ---------------------------------------------------------------------------------------------
// The guardian's actions on the same pot: change, stop, take back, start again, a new key
// ---------------------------------------------------------------------------------------------

/** The guardian's five Safe actions, each one `execTransaction` the guardian sends on the noted
 *  pot. One pot for life: starting again and moving the allowance to a new key are done on the
 *  same Safe, never by a second one. */
export type PotSafeAction = "change" | "stop" | "withdraw" | "start_again" | "new_key";

const SAFE_ACTIONS: readonly string[] = ["change", "stop", "withdraw", "start_again", "new_key"];

/** Whether a card's action is one of the five (Task 13 draws the others). */
export const isPotSafeAction = (action: string): action is PotSafeAction =>
  SAFE_ACTIONS.includes(action);

/** The three that set a ceiling, typed in their own field. */
export const potActionTakesCeiling = (action: PotSafeAction): boolean =>
  action === "change" || action === "start_again" || action === "new_key";

/** The allowlist's context of one of them (`potExecCall`). */
export type PotExecContext = Extract<
  PotCallContext,
  { kind: "change" | "stop" | "withdraw" | "restore" }
>;

const ZERO = BigInt(0);
const ZERO_ADDRESS = /^0x0{40}$/;
const MAX_CEILING_UNITS = BigInt(POT_CEILING_MAX_USDC) * USDC_UNIT;
/** Safe's `execTransaction` answering true: the 32-byte word 1. */
const TRUE_WORD = /^0x0{63}1$/;

/** A ceiling under the form's rules, in units: a whole number of USDC from 1 to
 *  POT_CEILING_MAX_USDC. The grant's cap is the form's to check (`potCeilingCheck`). */
const ceilingAllowed = (units: unknown): units is bigint =>
  typeof units === "bigint" &&
  units >= USDC_UNIT &&
  units <= MAX_CEILING_UNITS &&
  units % USDC_UNIT === ZERO;

/** A wallet of the agent's own: an address, never the zero address or the guardian's. */
const agentsOwn = (wallet: unknown, guardian: Address): wallet is Address =>
  isAddress(wallet) && !ZERO_ADDRESS.test(wallet) && !sameAddress(wallet, guardian);

/** A reading of a pot of the guardian's alone: any but `absent` and `not_the_guardians`. */
const guardiansAlone = (r: PotReading): boolean =>
  r.state === "ceiling_read" || r.state === "stopped" || r.state === "limits_not_read";

/** A list as read, copied; null when the read holds no list. */
const listOf = (list: unknown): Address[] | null =>
  Array.isArray(list) ? [...(list as Address[])] : null;

/**
 * The context of one of the guardian's Safe actions, from THIS click's reads: `agentWallet` is the
 * key the registry names in the click, and `raw` and `reading` the pot read for it at one block.
 * Never the card's: what the card was drawn with is not read here. Each is `refused` unless:
 *  - change: the pot reads `ceiling_read` (its one key is the registry's), with a new ceiling
 *    under the form's rules. The running period and what was taken in it are kept (V6);
 *  - stop: a pot of the guardian's alone with something listed: every delegate and every module
 *    of the raw read, the pot's own keys whatever the registry names. It names no amount (V9),
 *    so nothing the agent does while the guardian signs can make it fail;
 *  - withdraw: a pot of the guardian's alone with no module on and a balance above 0: the whole
 *    balance as read, in native wei (V10);
 *  - start_again: a stopped pot whose key list is complete, a restore for the registry's key with
 *    a new ceiling (V11; V13's shape when the registry names a new key);
 *  - new_key: `other_delegate`, the registry's key absent from a complete list of the pot's keys
 *    and not the guardian's, a restore for it with a new ceiling (V12). A stopped pot reads
 *    `stopped` whatever key the registry names: its start again is then for the new key.
 * A restore is always for the registry's key of the click (Ruling R19: after a changed-key setup
 * the pot's key is the note's first one, never the registry's), and `runPotAction` sends it only
 * when that key is also the one the card named (Ruling R23).
 */
export function potActionContext(
  action: PotSafeAction,
  p: {
    pot: Address;
    guardian: Address;
    agentWallet: Address;
    raw: PotRaw;
    reading: PotReading;
    newCeilingUnits?: bigint;
  },
): PotExecContext | { problem: "refused" } {
  const refused = { problem: "refused" as const };
  const { pot, guardian, agentWallet, raw, reading } = p;
  const delegates = listOf(raw.delegates?.list);
  const modules = listOf(raw.modules?.list);
  if (delegates === null || modules === null || !guardiansAlone(reading)) return refused;
  const restore = (): PotExecContext | { problem: "refused" } =>
    ceilingAllowed(p.newCeilingUnits) && agentsOwn(agentWallet, guardian)
      ? {
          kind: "restore",
          pot,
          guardian,
          agentWallet,
          ceilingUnits: p.newCeilingUnits,
          delegates,
          modules,
        }
      : refused;
  switch (action) {
    case "change":
      if (reading.state !== "ceiling_read" || !agentsOwn(agentWallet, guardian)) return refused;
      if (!ceilingAllowed(p.newCeilingUnits)) return refused;
      return { kind: "change", pot, guardian, agentWallet, ceilingUnits: p.newCeilingUnits };
    case "stop":
      if (delegates.length === 0 && modules.length === 0) return refused;
      return { kind: "stop", pot, guardian, delegates, modules };
    case "withdraw": {
      const balanceWei: unknown = raw.balanceWei;
      if (modules.length !== 0 || typeof balanceWei !== "bigint" || balanceWei <= ZERO)
        return refused;
      return { kind: "withdraw", pot, guardian, modules, balanceWei };
    }
    case "start_again":
      if (reading.state !== "stopped" || raw.delegates.next !== 0) return refused;
      return restore();
    case "new_key":
      if (
        reading.state !== "limits_not_read" ||
        reading.problem !== "other_delegate" ||
        raw.delegates.next !== 0 ||
        delegates.some((d) => sameAddress(d, agentWallet))
      )
        return refused;
      return restore();
  }
}

/** True when the simulated `execTransaction` answered true: exactly the 32-byte word 1. */
export function potExecSimulationOk(returnData: Hex): boolean {
  return typeof returnData === "string" && TRUE_WORD.test(returnData);
}

/** The exact call the allowlist accepted for a context: the pot's address and the calldata. */
export type PotExecChecked = { to: Address; data: Hex };

/** The click's own reads: the registry's key, then the pot read for it (null when the registry
 *  names no address: nothing was read for it). */
export type PotActionRead = {
  agentWallet: AgentWalletRead;
  raw: PotRaw | null;
  reading: PotReading | null;
};

/** What one action's click does, each the card's own closure. */
export type PotActionDeps = {
  /** Whether the card is still on screen (its lifetime): asked after every await and right
   *  before the send, so a person who left gets no wallet prompt. */
  alive(): boolean;
  /** Fresh reads made in this click: the registry's `getAgentWallet` through `readAgentWallet`,
   *  then `readPotRaw` and `potReading` for it when it is an address. Throws when the chain
   *  cannot be read. */
  read(): Promise<PotActionRead>;
  preflight(): { ok: true } | { ok: false; problem: PotPreflightProblem };
  /** The allowlist's answer on the exact request (`potExecCall` at POT_EXEC_GAS_CAP, then
   *  `allowedCall`): the call it accepted, or its refusal's code. Nothing reaches the chain before. */
  check(ctx: PotExecContext): { ok: true; call: PotExecChecked } | { ok: false; problem: string };
  /** The eth_call of the accepted call from the guardian: the return data. Throws on a revert. */
  simulate(call: PotExecChecked): Promise<Hex>;
  /** eth_estimateGas of the same call, with NO fee field. Throws on a revert. */
  estimate(call: PotExecChecked): Promise<bigint>;
  /** The guardian's balance in native wei, read again when the node says the money is short. */
  readBalance(): Promise<bigint>;
  /** The account connected NOW, right before the send. */
  account(): Address | null;
  /** The allowlist's door to the wallet (`potExecCall` with the gas decided here). */
  send(
    ctx: PotExecContext,
    gas: bigint,
  ): Promise<{ ok: true; hash: Hex } | { ok: false; problem: string }>;
};

export type PotActionProblem =
  | PotPreflightProblem
  | "read_failed"
  | "agent_wallet"
  | "would_revert"
  | "declined"
  | "no_gas"
  /** The card was gone: nothing more was done, and nothing is shown. */
  | "left";

/** A failed action. `balanceWei` is the guardian's balance read again when the node said the
 *  money is short of the fee. */
export type PotActionFailure = {
  ok: false;
  problem: PotActionProblem;
  cause?: unknown;
  balanceWei?: bigint;
};

/** The cause of a `refused` whose click read the pot other than the card showed it. */
export const POT_ACTION_MOVED = "pot_moved";

const LEFT_ACTION: PotActionFailure = { ok: false, problem: "left" };

/** A simulation or an estimate that threw: the money short of the fee (the guardian's balance read
 *  again, `no_gas` with it), a refusal of the chain (`would_revert`), or a node that did not
 *  answer (`read_failed`). */
async function actionChainFailure(cause: unknown, d: PotActionDeps): Promise<PotActionFailure> {
  if (causeNamed(cause, MONEY_SHORT)) {
    let balanceWei: bigint;
    try {
      balanceWei = await d.readBalance();
    } catch (e) {
      return d.alive() ? { ok: false, problem: "read_failed", cause: e } : LEFT_ACTION;
    }
    if (!d.alive()) return LEFT_ACTION;
    return { ok: false, problem: "no_gas", balanceWei };
  }
  return { ok: false, problem: chainRefused(cause) ? "would_revert" : "read_failed", cause };
}

/**
 * One of the guardian's Safe actions, in this order, stopping at the first that fails, and asking
 * the card's lifetime after EVERY await and right before the send (`left`):
 *  1. the click's reads (`read_failed`, with the error as `cause`; a registry that could not be
 *     read too);
 *  2. a registry key of the agent's own (`agent_wallet` for none, the zero address or the
 *     guardian's);
 *  3. for a start again or a new key, the registry's key of the click is the one the card's panel
 *     named (`shownAgentWallet`, in any letter case), else `refused` with cause POT_ACTION_MOVED
 *     (Ruling R23): the guardian never signs the allowance over to a key they were not shown. The
 *     restore is still built from the click's read, so it is for a key both shown and read;
 *  4. `potActionContext` from THAT read (`refused`, cause POT_ACTION_MOVED): never the card's;
 *  5. the page's own checks (their problem);
 *  6. the allowlist on the exact request (`refused`, with its code as `cause`);
 *  7. the simulation from the guardian, and `potExecSimulationOk` (`would_revert`);
 *  8. the estimate, and `potGasLimit` under POT_EXEC_GAS_CAP (`would_revert`). For 7 and 8, a
 *     throw is `no_gas` when the node says the money is short (the balance read again), else
 *     `would_revert` only when the chain refused it, else `read_failed`;
 *  9. the account connected now is the guardian's, else `refused` with
 *     `wallet_is_not_the_guardian`, and nothing is sent;
 * 10. the one transaction through the allowlist, its outcomes read as `runPotCreate` reads them.
 * The answer names the registry's key of the click: the pot is read back against it.
 */
export async function runPotAction(
  action: PotSafeAction,
  p: {
    pot: Address;
    guardian: Address;
    /** The key the card's panel names: for a start again or a new key, the key the allowance
     *  goes to, which the click's own read must name too. */
    shownAgentWallet: Address;
    newCeilingUnits?: bigint;
  },
  d: PotActionDeps,
): Promise<{ ok: true; hash: Hex; agentWallet: Address } | PotActionFailure> {
  // 1.
  let fresh: PotActionRead;
  try {
    fresh = await d.read();
  } catch (cause) {
    return d.alive() ? { ok: false, problem: "read_failed", cause } : LEFT_ACTION;
  }
  if (!d.alive()) return LEFT_ACTION;
  // 2.
  const wallet = fresh.agentWallet;
  if (wallet === "unreadable") return { ok: false, problem: "read_failed" };
  if (!agentsOwn(wallet, p.guardian)) return { ok: false, problem: "agent_wallet" };
  if (fresh.raw === null || fresh.reading === null) return { ok: false, problem: "read_failed" };
  // 3.
  if (
    (action === "start_again" || action === "new_key") &&
    !sameAddress(wallet, p.shownAgentWallet)
  )
    return { ok: false, problem: "refused", cause: POT_ACTION_MOVED };
  // 4.
  const ctx = potActionContext(action, {
    pot: p.pot,
    guardian: p.guardian,
    agentWallet: wallet,
    raw: fresh.raw,
    reading: fresh.reading,
    newCeilingUnits: p.newCeilingUnits,
  });
  if ("problem" in ctx) return { ok: false, problem: "refused", cause: POT_ACTION_MOVED };
  // 5.
  const pre = d.preflight();
  if (!pre.ok) return { ok: false, problem: pre.problem };
  // 6.
  const checked = d.check(ctx);
  if (!checked.ok) return { ok: false, problem: "refused", cause: checked.problem };
  // 7.
  let returned: Hex;
  try {
    returned = await d.simulate(checked.call);
  } catch (cause) {
    return d.alive() ? actionChainFailure(cause, d) : LEFT_ACTION;
  }
  if (!d.alive()) return LEFT_ACTION;
  if (!potExecSimulationOk(returned)) return { ok: false, problem: "would_revert" };
  // 8.
  let estimate: bigint;
  try {
    estimate = await d.estimate(checked.call);
  } catch (cause) {
    return d.alive() ? actionChainFailure(cause, d) : LEFT_ACTION;
  }
  if (!d.alive()) return LEFT_ACTION;
  const gas = potGasLimit(estimate, POT_EXEC_GAS_CAP);
  if (gas === null) return { ok: false, problem: "would_revert" };
  // 9.
  if (!sameAddress(d.account(), p.guardian))
    return { ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" };
  if (!d.alive()) return LEFT_ACTION;
  // 10.
  let sent: { ok: true; hash: Hex } | { ok: false; problem: string };
  try {
    sent = await d.send(ctx, gas);
  } catch (cause) {
    const failure = registerSendFailure(cause);
    if (failure.kind === "rejected") return { ok: false, problem: "declined", cause };
    if (failure.kind === "no_gas") return { ok: false, problem: "no_gas", cause };
    return { ok: false, problem: chainRefused(cause) ? "would_revert" : "refused", cause };
  }
  if (!sent.ok) return { ok: false, problem: "refused", cause: sent.problem };
  return { ok: true, hash: sent.hash, agentWallet: wallet };
}

/** A failed action's sentences (Task 10's), and whether the card reads the pot again: a click that
 *  read the pot other than the card showed it says so, and the card is read again. */
export function potActionFailureView(
  f: PotActionFailure,
  p: { environment: Environment; guardian: Address },
): { lines: string[]; reread: boolean } {
  const say = (line: string, reread = false) => ({ lines: [line], reread });
  const problem = f.problem;
  switch (problem) {
    case "left":
      return { lines: [], reread: false };
    case "refused":
      if (f.cause === POT_ACTION_MOVED) return say(POT.actionMoved, true);
      if (typeof f.cause === "string") return say(potRefusalSentence(f.cause, p));
      return say(POT.problems.refused);
    case "not_this_wallet":
      return say(potProblemSentence({ problem, guardian: p.guardian }));
    case "wrong_network":
      return say(potProblemSentence({ problem, environment: p.environment }));
    case "no_gas":
      return say(
        f.balanceWei === undefined
          ? POT.problems.no_gas
          : fillCopy(POT.feeShort, { balance: formatNative(f.balanceWei) }),
      );
    default:
      return say(potProblemSentence({ problem }));
  }
}

/** Read the pot again for this key: after a receipt that went through (`confirmed`), or one not
 *  seen in time, whose receipt is asked again first. */
export type PotReadAgain = {
  agentWallet: Address;
  ceilingUnits: bigint | null;
  hash: Hex;
  confirmed: boolean;
};

/** Where one transaction of the card is, for its actions `A`. `checking` is the click before the
 *  wallet opens; `sending` is the wallet open; `done` is the pot read again after the receipt. */
export type PotCardStage<A extends string> =
  | { at: "idle" }
  | { at: "checking"; action: A }
  | { at: "sending"; action: A }
  | { at: "waiting"; action: A; hash: Hex }
  | { at: "done"; action: A; ok: boolean; lines: string[]; hash: Hex }
  | {
      at: "problem";
      action: A;
      lines: string[];
      hash: Hex | null;
      again: PotReadAgain | null;
    };

/** Where one of the guardian's Safe actions is. */
export type PotActionStage = PotCardStage<PotSafeAction>;

/**
 * After an action's receipt, the pot read again (against `agentWallet`, the registry's key of the
 * click) in its own sentences: a change, a start again or a new key is done (`ok`) only when it
 * reads `ceiling_read` with the ceiling asked (`potCreatedView`); a stop or a take back once it
 * reads `stopped`. A start again or a new key that is done names the key that may take now (the
 * click's, which Ruling R23 makes the one the card named). Anything else is the warning's own
 * lines, and the card claims nothing more.
 */
export function potActionDoneView(
  action: PotSafeAction,
  reading: PotReading,
  ceilingUnits: bigint | null,
  agentWallet: Address,
): { ok: boolean; lines: string[] } {
  if (!potActionTakesCeiling(action))
    return { ok: reading.state === "stopped", lines: potCreatedView(reading, ZERO).lines };
  if (ceilingUnits === null) return { ok: false, lines: potCreatedView(reading, ZERO).lines };
  const view = potCreatedView(reading, ceilingUnits);
  if (!view.ok || action === "change") return view;
  return { ok: true, lines: [fillCopy(POT.shownAgent, { address: agentWallet }), ...view.lines] };
}

/** The lines under an action's result: one pot for life, under the stop's. */
export function potActionAfter(stage: PotActionStage): string[] {
  return stage.at === "done" && stage.action === "stop" ? [POT.onePot] : [];
}

/** A ceiling typed in an action's field, by the form's rule (`potFormCheck`) and the grant's cap:
 *  its units, or the sentence that refuses it. */
export function potCeilingCheck(
  ceiling: string,
  cap: PotCeilingCap,
): { ok: true; ceilingUnits: bigint } | { ok: false; line: string } {
  const checked = potFormCheck({ ceiling, fund: "", agentGas: "" }, cap, "contract");
  if (checked.ok) return { ok: true, ceilingUnits: checked.ceilingUnits };
  return { ok: false, line: checked.ceiling ?? POT.problems.refused };
}

// ---------------------------------------------------------------------------------------------
// Add money and send fee money: one USDC transfer each
// ---------------------------------------------------------------------------------------------

/** The guardian's two USDC transfers: "Add money" to the noted pot, "Send fee money" to the
 *  agent's key. Each is one `transfer` on the table's USDC, the ERC-20 face of the same balance,
 *  in USDC units (6 decimals): never a value sent. */
export type PotTransfer = "add_money" | "fee_money";

const TRANSFERS: readonly string[] = ["add_money", "fee_money"];

/** Whether a card's action is one of the two transfers. */
export const isPotTransfer = (action: string): action is PotTransfer => TRANSFERS.includes(action);

/** The allowlist's context of one of them (`potTransferCall`). */
export type PotTransferContext = Extract<PotCallContext, { kind: "add_money" | "fee_money" }>;

/**
 * The amount typed for a transfer, in UNITS, or the sentence under its field: "" is `empty`; six
 * decimals at most (`too_precise`); at most POT_FUND_MAX_UNITS for the pot (`too_large`) and
 * POT_AGENT_GAS_MAX_UNITS, 1 USDC, for the fee money (`gas_too_large`); never 0 (`zero`); anything
 * else is not an amount.
 */
export function potTransferAmount(
  kind: PotTransfer,
  raw: string,
): { ok: true; amountUnits: bigint } | { ok: false; sentence: string } {
  if (raw === "") return { ok: false, sentence: POT.amountProblems.empty };
  const units = parseUsdcAmount(raw, kind === "add_money" ? POT_FUND_MAX_UNITS : POT_AGENT_GAS_MAX_UNITS);
  if (typeof units !== "bigint") {
    if (units.problem === "too_large" && kind === "fee_money")
      return { ok: false, sentence: POT.amountProblems.gas_too_large };
    return { ok: false, sentence: POT.amountProblems[units.problem] };
  }
  if (units === ZERO) return { ok: false, sentence: POT.amountProblems.zero };
  return { ok: true, amountUnits: units };
}

/** A transfer's button: the amount it will send once the field reads one, formatted from its
 *  units ("Add 5 USDC", "Send 0.1 USDC"); the panel's title before. */
export function potTransferSendLabel(kind: PotTransfer, raw: string): string {
  const amount = potTransferAmount(kind, raw);
  if (kind === "add_money")
    return amount.ok
      ? fillCopy(POT.addMoneySend, { amount: formatUsdcUnits(amount.amountUnits) })
      : POT.addMoneyTitle;
  return amount.ok
    ? fillCopy(POT.feeMoneySend, { amount: formatUsdcUnits(amount.amountUnits) })
    : POT.feeMoneyTitle;
}

/** The click's own reads: the registry's key, the pot read for it (null when the registry names no
 *  address), and the guardian's balance in native wei. */
export type PotTransferRead = {
  agentWallet: AgentWalletRead;
  raw: PotRaw | null;
  reading: PotReading | null;
  guardianBalanceWei: bigint;
};

/** What one transfer's click does, each the card's own closure. */
export type PotTransferDeps = {
  /** Whether the card is still on screen (its lifetime): asked after every await and right
   *  before the send. */
  alive(): boolean;
  /** Fresh reads made in this click: the registry's `getAgentWallet` through `readAgentWallet`,
   *  `readPotRaw` and `potReading` for it at a fresh block, and the guardian's `getBalance`.
   *  Throws when the chain cannot be read. */
  read(): Promise<PotTransferRead>;
  /** `GET /pot`, a request made now, for Add money only: the money goes only to the pot noted,
   *  and on the record, as the server holds it now. Throws when it fails. */
  readNoted(): Promise<OrderPotView | null>;
  preflight(): { ok: true } | { ok: false; problem: PotPreflightProblem };
  /** The allowlist's answer on the exact request (`potTransferCall` at POT_TRANSFER_GAS_CAP, then
   *  `allowedCall`): the call it accepted, or its refusal's code. Nothing reaches the chain before. */
  check(ctx: PotTransferContext): { ok: true; call: PotExecChecked } | { ok: false; problem: string };
  /** The eth_call of the accepted transfer from the guardian: the return data (true is the
   *  32-byte word 1). Throws on a revert. */
  simulate(call: PotExecChecked): Promise<Hex>;
  /** eth_estimateGas of the same call, with NO fee field. Throws on a revert. */
  estimate(call: PotExecChecked): Promise<bigint>;
  /** The guardian's balance in native wei, read again when the node says the money is short. */
  readBalance(): Promise<bigint>;
  /** The account connected NOW, right before the send. */
  account(): Address | null;
  /** The allowlist's door to the wallet (`potTransferCall` with the gas decided here). */
  send(
    ctx: PotTransferContext,
    gas: bigint,
  ): Promise<{ ok: true; hash: Hex } | { ok: false; problem: string }>;
};

/** A failed transfer: an action's problem; the noted pot that could not be read from the server;
 *  or the guardian's balance (read in the click, or again when the node said the money is short)
 *  under the amount, with both in native wei. */
export type PotTransferFailure =
  | { ok: false; problem: PotActionProblem; cause?: unknown }
  | { ok: false; problem: "pot_unreadable"; cause?: unknown }
  | { ok: false; problem: "not_enough"; balanceWei: bigint; totalWei: bigint };

const LEFT_TRANSFER: PotTransferFailure = { ok: false, problem: "left" };
const MOVED: PotTransferFailure = { ok: false, problem: "refused", cause: POT_ACTION_MOVED };

/** A simulation or an estimate of a transfer that threw: the money short (the guardian's balance
 *  read again, `not_enough` with it and the amount), a refusal of the chain (`would_revert`), or a
 *  node that did not answer (`read_failed`). */
async function transferChainFailure(
  cause: unknown,
  totalWei: bigint,
  d: PotTransferDeps,
): Promise<PotTransferFailure> {
  if (causeNamed(cause, MONEY_SHORT)) {
    let balanceWei: bigint;
    try {
      balanceWei = await d.readBalance();
    } catch (e) {
      return d.alive() ? { ok: false, problem: "read_failed", cause: e } : LEFT_TRANSFER;
    }
    if (!d.alive()) return LEFT_TRANSFER;
    return { ok: false, problem: "not_enough", balanceWei, totalWei };
  }
  return { ok: false, problem: chainRefused(cause) ? "would_revert" : "read_failed", cause };
}

/**
 * One USDC transfer of the guardian's, in this order, stopping at the first that fails, and asking
 * the card's lifetime after EVERY await and right before the send (`left`):
 *  0. an amount that is a bigint above 0, else `refused` with nothing read;
 *  1. the click's reads (`read_failed`, with the error as `cause`; a registry that could not be
 *     read too);
 *  2. a registry key of the agent's own (`agent_wallet` for none, the zero address or the
 *     guardian's);
 *  3. the kind's own rules, from THAT read (`refused`, cause POT_ACTION_MOVED, the card reads
 *     again, unless said otherwise):
 *     - add money: a pot that reads `ceiling_read` or `stopped` (so it holds the pot's code, is the
 *       guardian's alone, and after a changed-key setup the new key is set first); then `GET /pot`
 *       read now (`pot_unreadable` when it fails) names this pot, on the record. The context is
 *       the noted pot and the amount;
 *     - fee money: the registry's key of the click is the one the card's panel named
 *       (`shownAgentWallet`, in any letter case; Ruling R23 applied to money: the guardian never
 *       sends to a key they were not shown), and it holds no code (`refused` with the allowlist's
 *       own code, `fee_money_contract_wallet`). The context is that key and the amount;
 *  4. the guardian's balance read in the click under the amount in wei (`not_enough`);
 *  5. the page's own checks (their problem);
 *  6. the allowlist on the exact request (`refused`, with its code as `cause`);
 *  7. the simulation from the guardian, and `potExecSimulationOk` of its answer (`would_revert`);
 *  8. the estimate, and `potGasLimit` under POT_TRANSFER_GAS_CAP (`would_revert`). For 7 and 8, a
 *     throw is `not_enough` when the node says the money is short (the balance read again), else
 *     `would_revert` only when the chain refused it, else `read_failed`;
 *  9. the account connected now is the guardian's, else `refused` with
 *     `wallet_is_not_the_guardian`, and nothing is sent;
 * 10. the one transfer through the allowlist, its outcomes read as `runPotCreate` reads them.
 * The answer names the registry's key of the click: the pot and the key are read back against it.
 */
export async function runPotTransfer(
  kind: PotTransfer,
  p: {
    pot: Address;
    guardian: Address;
    /** The key the fee money panel names: the click's own read must name it too. */
    shownAgentWallet: Address;
    amountUnits: bigint;
  },
  d: PotTransferDeps,
): Promise<{ ok: true; hash: Hex; agentWallet: Address } | PotTransferFailure> {
  // 0.
  const amountUnits: unknown = p.amountUnits;
  if (typeof amountUnits !== "bigint" || amountUnits <= ZERO) return { ok: false, problem: "refused" };
  const totalWei = unitsToWei(amountUnits);
  // 1.
  let fresh: PotTransferRead;
  try {
    fresh = await d.read();
  } catch (cause) {
    return d.alive() ? { ok: false, problem: "read_failed", cause } : LEFT_TRANSFER;
  }
  if (!d.alive()) return LEFT_TRANSFER;
  // 2.
  const wallet = fresh.agentWallet;
  if (wallet === "unreadable") return { ok: false, problem: "read_failed" };
  if (!agentsOwn(wallet, p.guardian)) return { ok: false, problem: "agent_wallet" };
  const { raw, reading } = fresh;
  const balance: unknown = fresh.guardianBalanceWei;
  if (raw === null || reading === null || typeof balance !== "bigint")
    return { ok: false, problem: "read_failed" };
  // 3.
  let ctx: PotTransferContext;
  if (kind === "add_money") {
    if (reading.state !== "ceiling_read" && reading.state !== "stopped") return MOVED;
    let noted: OrderPotView | null;
    try {
      noted = await d.readNoted();
    } catch (cause) {
      return d.alive() ? { ok: false, problem: "pot_unreadable", cause } : LEFT_TRANSFER;
    }
    if (!d.alive()) return LEFT_TRANSFER;
    if (noted === null || !sameAddress(noted.address, p.pot) || noted.onRecord !== true) return MOVED;
    ctx = { kind: "add_money", pot: p.pot, guardian: p.guardian, amountUnits };
  } else {
    if (!sameAddress(wallet, p.shownAgentWallet)) return MOVED;
    if (raw.agentHasCode !== false)
      return { ok: false, problem: "refused", cause: "fee_money_contract_wallet" };
    ctx = { kind: "fee_money", guardian: p.guardian, agentWallet: wallet, agentHasCode: false, amountUnits };
  }
  // 4.
  if (balance < totalWei) return { ok: false, problem: "not_enough", balanceWei: balance, totalWei };
  // 5.
  const pre = d.preflight();
  if (!pre.ok) return { ok: false, problem: pre.problem };
  // 6.
  const checked = d.check(ctx);
  if (!checked.ok) return { ok: false, problem: "refused", cause: checked.problem };
  // 7.
  let returned: Hex;
  try {
    returned = await d.simulate(checked.call);
  } catch (cause) {
    return d.alive() ? transferChainFailure(cause, totalWei, d) : LEFT_TRANSFER;
  }
  if (!d.alive()) return LEFT_TRANSFER;
  if (!potExecSimulationOk(returned)) return { ok: false, problem: "would_revert" };
  // 8.
  let estimate: bigint;
  try {
    estimate = await d.estimate(checked.call);
  } catch (cause) {
    return d.alive() ? transferChainFailure(cause, totalWei, d) : LEFT_TRANSFER;
  }
  if (!d.alive()) return LEFT_TRANSFER;
  const gas = potGasLimit(estimate, POT_TRANSFER_GAS_CAP);
  if (gas === null) return { ok: false, problem: "would_revert" };
  // 9.
  if (!sameAddress(d.account(), p.guardian))
    return { ok: false, problem: "refused", cause: "wallet_is_not_the_guardian" };
  if (!d.alive()) return LEFT_TRANSFER;
  // 10.
  let sent: { ok: true; hash: Hex } | { ok: false; problem: string };
  try {
    sent = await d.send(ctx, gas);
  } catch (cause) {
    const failure = registerSendFailure(cause);
    if (failure.kind === "rejected") return { ok: false, problem: "declined", cause };
    if (failure.kind === "no_gas") return { ok: false, problem: "no_gas", cause };
    return { ok: false, problem: chainRefused(cause) ? "would_revert" : "refused", cause };
  }
  if (!sent.ok) return { ok: false, problem: "refused", cause: sent.problem };
  return { ok: true, hash: sent.hash, agentWallet: wallet };
}

/** A failed transfer's sentences: money short names what the wallet holds and what is needed; a
 *  noted pot the server could not answer for says so; every other problem is the actions' own
 *  (`potActionFailureView`), a pot not as the card showed it read again. */
export function potTransferFailureView(
  f: PotTransferFailure,
  p: { environment: Environment; guardian: Address },
): { lines: string[]; reread: boolean } {
  if (f.problem === "not_enough")
    return {
      lines: [potProblemSentence({ problem: "not_enough", balanceWei: f.balanceWei, totalWei: f.totalWei })],
      reread: false,
    };
  if (f.problem === "pot_unreadable")
    return { lines: [potProblemSentence({ problem: "pot_unreadable" })], reread: false };
  return potActionFailureView(f, p);
}

/** Where one transfer of the card is. */
export type PotTransferStage = PotCardStage<PotTransfer>;

/** After a transfer's receipt, what the chain shows now of what it moved: the pot's balance after
 *  Add money; what the agent's key holds after Send fee money, with the low mark's warning. */
export function potTransferDoneView(kind: PotTransfer, raw: PotRaw): { ok: boolean; lines: string[] } {
  if (kind === "add_money")
    return { ok: true, lines: [fillCopy(POT.shownBalance, { balance: formatUsdcUnits(raw.balanceUnits) })] };
  return { ok: true, lines: potFeeLines(raw) };
}

// ---------------------------------------------------------------------------------------------
// The public record: take the pot off it, or put it back
// ---------------------------------------------------------------------------------------------

/** The refusals after which the card reads the noted pot and the record again: one pot for life,
 *  a pot still being set up, an address another legal body holds, and a removal already done (a
 *  retry after a lost answer). */
const RECORD_REREAD: readonly string[] = ["pot_exists", "pot_pending", "pot_taken", "pot_not_on_record"];

/**
 * Taking the pot off the public record, or putting it back, refused by the server: what the card
 * says, and whether it reads the noted pot and the record again. A removal already done
 * (`pot_not_on_record`, a retry after a lost answer) says nothing and reads again: the card then
 * shows the pot as off the record. `pot_exists`, `pot_pending` and `pot_taken`, and any code the
 * server's next step reads again for, say the server's own sentence and read again. Any other
 * refusal says the server's sentence. With no answer the server wrote (a timeout, a gateway's
 * error, a request that never came back) the request may have landed: the sentence claims nothing
 * about the record, and the pot and the record are read again to show where it stands.
 */
export function potRecordFailureView(e: unknown): { lines: string[]; reread: boolean } {
  const served = potServedRefusal(e);
  if (served === null) return { lines: [POT.recordAnswerLost], reread: true };
  if (served.code === "pot_not_on_record") return { lines: [], reread: true };
  const next = potServerNext(served.code);
  const reread =
    RECORD_REREAD.includes(served.code) || next === "reread_pot" || next === "reread_record";
  return { lines: [served.line], reread };
}

// ---------------------------------------------------------------------------------------------
// One action at a time on the card (Ruling R25)
// ---------------------------------------------------------------------------------------------

/**
 * The card's one lock, without React: `take` holds it for one click and answers false while
 * another click holds it; `release` gives it back. `onBusy` hears each change, so the card can
 * disable every other action while one is in flight (a quick guardian never opens two wallet
 * prompts at once).
 */
export function potCardLockCore(onBusy: (busy: boolean) => void): {
  held: () => boolean;
  take: () => boolean;
  release: () => void;
} {
  let holding = false;
  return {
    held: () => holding,
    take: () => {
      if (holding) return false;
      holding = true;
      onBusy(true);
      return true;
    },
    release: () => {
      if (!holding) return;
      holding = false;
      onBusy(false);
    },
  };
}
