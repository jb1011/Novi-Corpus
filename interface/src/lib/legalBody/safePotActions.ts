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
 * Nothing here holds a key, writes to a browser store or reads a clock.
 */
import type { Address, Hex } from "@/lib/api/types";
import type { AgentWalletRead } from "./agentWallet";
import { formatNative, type PotCallContext } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { sameAddress } from "./flow";
import { registerSendFailure } from "./identity";
import { POT_CEILING_MAX_USDC, POT_EXEC_GAS_CAP, USDC_UNIT } from "./safePot";
import type { PotCeilingCap, PotRaw, PotReading } from "./safePotRules";
import { causeNamed, chainRefused, MONEY_SHORT, type PotPreflightProblem } from "./safePotRun";
import {
  potCreatedView,
  potFormCheck,
  potGasLimit,
  potProblemSentence,
  potRefusalSentence,
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

/** Where one action of the card is. `checking` is the click before the wallet opens; `sending` is
 *  the wallet open; `done` is the pot read again after the receipt. */
export type PotActionStage =
  | { at: "idle" }
  | { at: "checking"; action: PotSafeAction }
  | { at: "sending"; action: PotSafeAction }
  | { at: "waiting"; action: PotSafeAction; hash: Hex }
  | { at: "done"; action: PotSafeAction; ok: boolean; lines: string[]; hash: Hex }
  | {
      at: "problem";
      action: PotSafeAction;
      lines: string[];
      hash: Hex | null;
      again: PotReadAgain | null;
    };

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
