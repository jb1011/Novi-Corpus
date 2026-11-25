/**
 * The company's pot: the screens' view model, each piece pure.
 *
 * The pot is a Safe the guardian owns alone; the agent's own key takes USDC from it up to a ceiling
 * in each fixed thirty-day period, through Safe's AllowanceModule. `safePot.ts` holds its bytes,
 * `safePotRules.ts` what a reading of it lets a page say, and `chain.ts` the allowlist every
 * transaction passes. Here, what the screens decide from those:
 *
 *  - which card the done page shows (`potCard`), and what the grant lets the form offer
 *    (`potGrantView`, `potCeilingHint`);
 *  - the form, its start and its check (`potFormStart`, `potFormCheck`);
 *  - the setup's plan from one click's reads (`potSaltNonce`, `potPlan`, `potSetupContext`), its
 *    review (`potReviewLines`), and the checks before and at the wallet (`potSendPreflight`,
 *    `potSimulationOk`, `potGasLimit`);
 *  - the sentence of every problem a click can meet: its own (`potProblemSentence`), the
 *    allowlist's (`potRefusalSentence`), and the next step after a refusal of the server's pot
 *    doors, whose own sentence the screen shows as served (`potServerNext`);
 *  - what a reading says and offers (`potReadingView`, `potCreatedView`), the public record's
 *    sentence (`potRecordSentence`), and the agent's two commands (`potAgentCommands`).
 *
 * ONE POT FOR LIFE. Once the noted address holds code, nothing here offers a setup again; a noted
 * address that never got code is set up again only at THAT address, from its own birth details,
 * so a setup still on its way and a second one can never make two pots.
 *
 * Nothing here reads a clock, a chain or a wallet: time and answers come in as values. Amounts are
 * exact bigints, USDC units with 6 decimals and native wei with 18, and every amount a sentence
 * says is formatted from the value that is sent, never added up again. Addresses are compared
 * without regard to letter case.
 */
import { decodeFunctionResult, getAddress } from "viem";
import type {
  Address,
  Hex,
  LegalBodyOrderView,
  LegalBodyStatementJson,
  OrderPotView,
  PotBirthNote,
  PotBlock,
} from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { agentWalletOwed, agentWalletStanding, type AgentWalletRead } from "./agentWallet";
import { formatNative, walletKindOf, type PotCallContext, type WalletKind } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { sameAddress, type LegalBodyNotice } from "./flow";
import { networkName } from "./identity";
import {
  formatUsdcUnits,
  multicall3Abi,
  parseCeilingUsdc,
  parseUsdcAmount,
  POT_AGENT_GAS_DEFAULT,
  POT_AGENT_GAS_MAX_UNITS,
  POT_FEE_LOW_WEI,
  POT_FUND_MAX_UNITS,
  POT_PERIOD_MINUTES,
  potAddresses,
  potInitializer,
  potSetupCalls,
  potStopArgs,
  predictPotAddress,
  unitsToWei,
  USDC_UNIT,
  type PotAddresses,
} from "./safePot";
import type { PotCeilingCap, PotRaw, PotReading } from "./safePotRules";

const POT = LEGAL_BODY_COPY.pot;

type Environment = "sandbox" | "production";

const ZERO = BigInt(0);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
/** A whole number as the server serves one: no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
/** A 32-byte word holding an address: twelve zero bytes, then its twenty. */
const ADDRESS_WORD = /^0x0{24}([0-9a-fA-F]{40})$/;
/** A grant's last day, as the server serves it. */
const CALENDAR_DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** `key` is the table's own key, never one it inherits. */
const owns = (table: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);
/** viem's getCode answers undefined for no code; a node may answer `0x`. */
const hasCode = (code: Hex | undefined): boolean => code !== undefined && code !== "0x";
/** Units of USDC as a person reads them: "5.1", "50", "0.000001". */
const usdc = (units: bigint): string => formatUsdcUnits(units);
/** A day, from unix seconds. */
const day = (unixSeconds: number): string => formatDate(unixSeconds * 1000);
/** An address as a command shows it: checksummed when it is one. */
const checksummed = (a: Address): string => (ADDRESS.test(a) ? getAddress(a.toLowerCase()) : a);

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

export type PotCard = "hidden" | "checking" | "offer" | "manage";

/**
 * The done page's pot card, in this order:
 *  - hidden: `/config` has no pot; the chain is not in the pot's table; there is no order, or it is
 *    not `linked`, is revoked or is of another chain; a notice is shown; or the record's agent
 *    wallet is unset, the guardian's, or not an address (the wallet card shows then);
 *  - checking: the record, the noted pot, the grant or, for a note, its reading is not there yet;
 *  - offer: no note, or a note whose address has no code (set up again only at THAT address), for
 *    a grant that allows some spending, none, or could not be read (the step then says so and
 *    offers no form until it reads);
 *  - hidden, in place of offer, for a grant that allows none of buying, paying and engaging a
 *    contractor: a pot would have nothing to release, and the server refuses it;
 *  - manage: any other reading, on the record or off it, whatever the grant.
 * One pot for life: once the noted address holds code, `offer` never comes back.
 */
export function potCard(p: {
  potOffered: boolean;
  chainId: number;
  order: LegalBodyOrderView | null;
  notice: LegalBodyNotice | undefined;
  record: LegalBodyStatementJson | null;
  /** `GET /pot`'s answer: undefined while it is read, null for no note. */
  noted: OrderPotView | null | undefined;
  /** The noted address's reading: null while it is read. */
  reading: PotReading | null;
  /** The order's grant as a cap (`potCeilingCapFromGrant`): null while it is read, "unreadable"
   *  when the read failed. */
  cap: PotCeilingCap | "unreadable" | null;
}): PotCard {
  if (p.potOffered !== true) return "hidden";
  if (potAddresses(p.chainId) === null) return "hidden";
  const order = p.order;
  if (
    order === null ||
    order.state !== "linked" ||
    order.revoked !== false ||
    order.chainId !== p.chainId
  )
    return "hidden";
  if (p.notice !== undefined) return "hidden";
  if (p.record === null) return "checking";
  const wallet: unknown = p.record.agentWallet;
  if (
    typeof wallet !== "string" ||
    !ADDRESS.test(wallet) ||
    agentWalletOwed(wallet as Address, order.guardian)
  )
    return "hidden";
  if (p.noted === undefined || p.cap === null) return "checking";
  const offer: PotCard =
    p.cap !== "unreadable" && p.cap.kind === "no_spending" ? "hidden" : "offer";
  if (p.noted === null) return offer;
  if (p.reading === null) return "checking";
  return p.reading.state === "absent" ? offer : "manage";
}

/**
 * What the grant lets the setup offer: no form for a grant that allows none of buying, paying and
 * engaging a contractor (a pot would have nothing to release, and the server refuses it); for a
 * grant with a last day, the line that the pot does not stop by itself on it. The day is a UTC
 * calendar day, formatted at its noon so every time zone but the farthest reads the same day.
 */
export function potGrantView(cap: PotCeilingCap): { form: boolean; lines: string[] } {
  if (cap.kind === "no_spending") return { form: false, lines: [POT.grantNoSpending] };
  if (cap.kind === "capped" && typeof cap.endsOn === "string" && CALENDAR_DAY.test(cap.endsOn)) {
    const noon = Date.parse(`${cap.endsOn}T12:00:00Z`);
    if (Number.isFinite(noon))
      return { form: true, lines: [fillCopy(POT.grantEnds, { date: formatDate(noon) })] };
  }
  return { form: true, lines: [] };
}

/** The cap in units, or null for a cap that is not a whole number of USDC (never a broken one
 *  read as no cap). */
function capUnits(cap: Extract<PotCeilingCap, { kind: "capped" }>): bigint | null {
  return Number.isSafeInteger(cap.maxUsdc) && cap.maxUsdc > 0
    ? BigInt(cap.maxUsdc) * USDC_UNIT
    : null;
}

/** The line beside the ceiling field: `ceilingMax` with the cap's amount, or `ceilingNoGrant`; a
 *  grant that allows no spending has no field, and says so. */
export function potCeilingHint(cap: PotCeilingCap): string {
  if (cap.kind === "capped") return fillCopy(POT.ceilingMax, { cap: String(cap.maxUsdc) });
  if (cap.kind === "no_spending") return POT.grantNoSpending;
  return POT.ceilingNoGrant;
}

// ---------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------

/** What the guardian typed, as typed. It lives in the screen's state only, never in a store. */
export type PotForm = { ceiling: string; fund: string; agentGas: string };

/** A noted ceiling in units, when it is a whole number of USDC above 0; else null. */
function notedCeiling(birth: PotBirthNote): bigint | null {
  const raw: unknown = birth.ceilingUnits;
  if (typeof raw !== "string" || !CANONICAL_DECIMAL.test(raw)) return null;
  const units = BigInt(raw);
  return units > ZERO && units % USDC_UNIT === ZERO ? units : null;
}

/**
 * The form as it opens. The ceiling is EMPTY whatever the cap, but for the noted pot that never
 * got code (`again`), whose own ceiling it holds: another would make a second pot. Fee money is
 * POT_AGENT_GAS_DEFAULT for a plain key, and empty for a delegated key or a contract wallet, which
 * take none. Nothing to put in the pot yet.
 */
export function potFormStart(agentWalletKind: WalletKind, again?: PotBirthNote | null): PotForm {
  const noted = again ? notedCeiling(again) : null;
  return {
    ceiling: noted === null ? "" : usdc(noted),
    fund: "",
    agentGas: agentWalletKind === "key" ? POT_AGENT_GAS_DEFAULT : "",
  };
}

export type PotFormCheck =
  | { ok: true; ceilingUnits: bigint; fundWei: bigint; agentGasWei: bigint }
  /** The sentence under each field that was refused. */
  | { ok: false; ceiling?: string; fund?: string; agentGas?: string };

/** The ceiling in units, or the sentence that refuses it. */
function ceilingOf(raw: string, cap: PotCeilingCap): bigint | string {
  if (cap.kind === "no_spending") return POT.grantNoSpending;
  const units = parseCeilingUsdc(raw);
  if (typeof units !== "bigint") return POT.ceilingProblems[units.problem];
  if (cap.kind === "capped") {
    const max = capUnits(cap);
    if (max === null) return POT.grantUnreadable;
    if (units > max)
      return fillCopy(POT.ceilingProblems.above_grant, { amount: String(cap.maxUsdc) });
  }
  return units;
}

/**
 * The three fields, each checked with its own sentence: the ceiling a whole number of USDC from 1
 * to POT_CEILING_MAX_USDC and at most a `capped` cap's `maxUsdc` (a grant that allows no spending
 * takes none); the pot's money and the fee money, "" for 0, six decimals at most, the money at most
 * POT_FUND_MAX_UNITS and the fee money at most 1 USDC. For any wallet but a plain key the fee money
 * is not read and is 0 whatever was typed. The two amounts come back in native wei, the ceiling in
 * units.
 */
export function potFormCheck(
  form: PotForm,
  cap: PotCeilingCap,
  agentWalletKind: WalletKind,
): PotFormCheck {
  const ceiling = ceilingOf(form.ceiling, cap);
  const fund = parseUsdcAmount(form.fund, POT_FUND_MAX_UNITS);
  const gas =
    agentWalletKind === "key" ? parseUsdcAmount(form.agentGas, POT_AGENT_GAS_MAX_UNITS) : ZERO;
  if (typeof ceiling === "bigint" && typeof fund === "bigint" && typeof gas === "bigint")
    return {
      ok: true,
      ceilingUnits: ceiling,
      fundWei: unitsToWei(fund),
      agentGasWei: unitsToWei(gas),
    };
  const refused: Extract<PotFormCheck, { ok: false }> = { ok: false };
  if (typeof ceiling === "string") refused.ceiling = ceiling;
  if (typeof fund !== "bigint") refused.fund = POT.amountProblems[fund.problem];
  if (typeof gas !== "bigint")
    refused.agentGas =
      gas.problem === "too_large"
        ? POT.amountProblems.gas_too_large
        : POT.amountProblems[gas.problem];
  return refused;
}

// ---------------------------------------------------------------------------------------------
// The setup's plan
// ---------------------------------------------------------------------------------------------

/**
 * What the setup will send, from one click's reads. `agentWallet` is the key the pot is set up for:
 * the registry's wallet (`registryWallet`, read in the click), or, for the noted pot that never got
 * code when the registry has named another key since (`keyChanged`, Ruling R19), the key the note
 * was made for. `agentWalletKind` is the kind the click read for `agentWallet` (`walletKindOf` of
 * its code), and null when the click read another wallet's code: no fee money is sent then.
 * `value` is the transaction's own value, the sum of the two amounts, in native wei.
 */
export type PotPlan = {
  guardian: Address;
  agentWallet: Address;
  registryWallet: Address;
  keyChanged: boolean;
  agentWalletKind: WalletKind | null;
  ceilingUnits: bigint;
  fundWei: bigint;
  agentGasWei: bigint;
  saltNonce: bigint;
  pot: Address;
  value: bigint;
};

export type PotProblem =
  | "unsupported"
  | "agent_wallet"
  | "pot_exists"
  | "not_enough"
  | "not_this_wallet"
  | "wrong_network"
  | "record_failed"
  | "would_revert"
  | "declined"
  | "reverted"
  | "no_receipt"
  | "read_failed"
  | "refused"
  /** The noted pot that never got code, asked with another ceiling: a second pot. */
  | "noted_pot"
  /** The click's read of the noted pot from the server failed. */
  | "pot_unreadable"
  /** Read again right before the note, the noted pot or the registry's key is not the review's. */
  | "stale_plan"
  /** The wallet could not pay the network fee of the transaction. */
  | "no_gas";

/** A noted pot's birth details as numbers, or null when they do not read. */
type NotedBirth = { saltNonce: bigint; agentWallet: Address; ceilingUnits: bigint };

function notedBirthOf(noted: OrderPotView): NotedBirth | null {
  return birthOf(noted.birth);
}

/** Birth details as numbers: a canonical salt number, a first key that is an address, and a
 *  ceiling that is a whole number of USDC above 0; else null. */
function birthOf(birth: unknown): NotedBirth | null {
  if (typeof birth !== "object" || birth === null) return null;
  const { saltNonce, agentWallet } = birth as Record<string, unknown>;
  const ceilingUnits = notedCeiling(birth as PotBirthNote);
  if (typeof saltNonce !== "string" || !CANONICAL_DECIMAL.test(saltNonce)) return null;
  if (typeof agentWallet !== "string" || !ADDRESS.test(agentWallet)) return null;
  if (ceilingUnits === null) return null;
  return { saltNonce: BigInt(saltNonce), agentWallet: agentWallet as Address, ceilingUnits };
}

/**
 * The pot's address as the browser recomputes it (Ruling R32): from the birth details alone and
 * the order's guardian, the Safe the guardian alone owns, set up for the birth's first key with
 * the table's USDC, the birth's ceiling and the thirty-day period, at the birth's salt number.
 * Null when the birth details do not read, or the table is not the pinned one. The reading rules
 * are sound only for this address (its initializer fixes how the Safe was set up), so the page
 * reads, and acts on, a noted pot only at this address: never at one the server named alone.
 */
export function notedPotAddress(a: PotAddresses, guardian: Address, birth: unknown): Address | null {
  const b = birthOf(birth);
  if (b === null) return null;
  try {
    return predictPotAddress(
      a,
      potInitializer(a, {
        guardian,
        agentWallet: b.agentWallet,
        token: a.usdc,
        ceilingUnits: b.ceilingUnits,
        periodMinutes: POT_PERIOD_MINUTES,
      }),
      b.saltNonce,
    );
  } catch {
    return null;
  }
}

/** The noted pot's address when it is the one its own birth details and the guardian predict, in
 *  any letter case (`notedPotAddress`), checksummed; null for no note, a birth that does not read,
 *  or an address that is not the prediction. */
export function notedPotChecked(
  a: PotAddresses,
  guardian: Address,
  noted: OrderPotView | null | undefined,
): Address | null {
  if (noted === null || noted === undefined) return null;
  const predicted = notedPotAddress(a, guardian, noted.birth);
  if (predicted === null || !sameAddress(predicted, noted.address)) return null;
  return predicted;
}

/** The first key of a noted pot's birth details, when they read; else null. */
export function notedBirthKey(noted: OrderPotView): Address | null {
  return notedBirthOf(noted)?.agentWallet ?? null;
}

/** A registry answer that names an address. */
const isAddressRead = (read: AgentWalletRead): read is Address =>
  typeof read === "string" && ADDRESS.test(read);

/**
 * The salt number the click predicts the pot's address with: the noted pot's own whenever there
 * is a note (one pot for life: a setup made again can only land at THAT address, whatever key the
 * registry names now), otherwise `fresh`, the click's own random number. A note whose birth does
 * not read gives `fresh`, and `potPlan` refuses it.
 */
export function potSaltNonce(p: { noted: OrderPotView | null; fresh: bigint }): bigint {
  const birth = p.noted === null ? null : notedBirthOf(p.noted);
  return birth === null ? p.fresh : birth.saltNonce;
}

const refusePlan = (problem: PotProblem): { ok: false; problem: PotProblem } => ({
  ok: false,
  problem,
});

/**
 * The setup's plan, from this click's reads, in this order:
 *  1. one pot for life: the noted address holding code in this click (`notedCode`) is
 *     `pot_exists`, before anything else, so a card drawn from an older reading never plans a
 *     setup on an address that already holds a pot;
 *  2. a chain in the pot's table (`unsupported`);
 *  3. the registry's wallet read (`read_failed` when it could not be), the agent's own
 *     (`agent_wallet` for none, the zero address or the guardian's);
 *  4. with a note (it never got code): its birth details read, its first key neither zero nor the
 *     guardian's, the note's own salt (`refused`), and the note's own ceiling (`noted_pot`). The
 *     plan is THE NOTED ADDRESS, never another. When the registry still names the note's key, it
 *     carries the form's money and fee money. When the registry names another key now (Ruling
 *     R19), it is set up for the note's first key with no money at all, the pot's and the fee
 *     money both 0: once the Safe holds code, its reading shows a key that is not the registry's,
 *     and the card moves the allowance to the new key on the same Safe;
 *  5. the predicted address holding no code (`pot_exists`), and, for a note, being the noted one
 *     (`refused`);
 *  6. the guardian's balance covering the value (`not_enough`; the fee is the wallet's own
 *     estimate).
 * The wallet's kind is `walletKindOf` of `agentCode`, the registry wallet's code: for any kind but
 * `key`, a delegated key included, `agentGasWei` is 0 whatever the form held, so the review shows
 * what will really be sent.
 */
export function potPlan(p: {
  chainId: number;
  guardian: Address;
  agentWallet: AgentWalletRead;
  /** The code of the registry's wallet, read in the click. */
  agentCode: Hex | undefined;
  checked: Extract<PotFormCheck, { ok: true }>;
  /** `potSaltNonce`'s answer for this click. */
  saltNonce: bigint;
  /** The code at the address the click predicted with that salt. */
  potCode: Hex | undefined;
  /** `GET /pot`'s answer: the note, or null for none. */
  noted: OrderPotView | null;
  /** The code at the noted address, read in the click; undefined with no note. */
  notedCode: Hex | undefined;
  guardianBalanceWei: bigint;
}): { ok: true; plan: PotPlan } | { ok: false; problem: PotProblem } {
  // 1.
  if (p.noted !== null && hasCode(p.notedCode)) return refusePlan("pot_exists");
  // 2.
  const a = potAddresses(p.chainId);
  if (a === null) return refusePlan("unsupported");
  // 3.
  const wallet = p.agentWallet;
  if (wallet === "unreadable") return refusePlan("read_failed");
  if (
    !isAddressRead(wallet) ||
    ZERO_ADDRESS.test(wallet) ||
    agentWalletStanding(wallet, p.guardian) !== "own"
  )
    return refusePlan("agent_wallet");
  // 4.
  let key: Address = wallet;
  let keyChanged = false;
  if (p.noted !== null) {
    const birth = notedBirthOf(p.noted);
    if (
      birth === null ||
      ZERO_ADDRESS.test(birth.agentWallet) ||
      sameAddress(birth.agentWallet, p.guardian)
    )
      return refusePlan("refused");
    if (p.saltNonce !== birth.saltNonce) return refusePlan("refused");
    if (p.checked.ceilingUnits !== birth.ceilingUnits) return refusePlan("noted_pot");
    keyChanged = !sameAddress(birth.agentWallet, wallet);
    if (keyChanged) key = birth.agentWallet;
  }
  const agentWalletKind = keyChanged ? null : walletKindOf(p.agentCode);
  const fundWei = keyChanged ? ZERO : p.checked.fundWei;
  const agentGasWei = agentWalletKind === "key" ? p.checked.agentGasWei : ZERO;
  let built: { pot: Address; value: bigint };
  try {
    built = potSetupCalls(a, {
      guardian: p.guardian,
      agentWallet: key,
      token: a.usdc,
      ceilingUnits: p.checked.ceilingUnits,
      periodMinutes: POT_PERIOD_MINUTES,
      saltNonce: p.saltNonce,
      fundWei,
      agentGasWei,
    });
  } catch {
    return refusePlan("refused");
  }
  // 5.
  if (p.noted !== null && !sameAddress(built.pot, p.noted.address)) return refusePlan("refused");
  if (hasCode(p.potCode)) return refusePlan("pot_exists");
  // 6.
  if (p.guardianBalanceWei < built.value) return refusePlan("not_enough");
  return {
    ok: true,
    plan: {
      guardian: p.guardian,
      agentWallet: key,
      registryWallet: wallet,
      keyChanged,
      agentWalletKind,
      ceilingUnits: p.checked.ceilingUnits,
      fundWei,
      agentGasWei,
      saltNonce: p.saltNonce,
      pot: built.pot,
      value: built.value,
    },
  };
}

/** The allowlist's context of the plan's setup (`potSetupCall`, `CallContext.pot`). For a plan
 *  whose key's kind the click did not read (`keyChanged`), the kind is left out: the allowlist
 *  reads a setup context without it only when it sends no fee money (`readSetupContext` in
 *  `chain.ts`), and such a plan sends none. A kind that was not read is never stated. */
export function potSetupContext(plan: PotPlan): Extract<PotCallContext, { kind: "setup" }> {
  const context: Extract<PotCallContext, { kind: "setup" }> = {
    kind: "setup",
    guardian: plan.guardian,
    agentWallet: plan.agentWallet,
    ceilingUnits: plan.ceilingUnits,
    saltNonce: plan.saltNonce,
    fundWei: plan.fundWei,
    agentGasWei: plan.agentGasWei,
  };
  if (plan.agentWalletKind !== null) context.agentWalletKind = plan.agentWalletKind;
  return context;
}

/** The review's sentence about money: every amount formatted from the plan's own wei values, and
 *  the total from `plan.value`, the transaction's own value. */
function moneyLine(plan: PotPlan): string {
  if (plan.value === ZERO) return POT.reviewNoMoney;
  const total = formatNative(plan.value);
  const fund = plan.fundWei > ZERO;
  const gas = plan.agentGasWei > ZERO;
  if (fund && !gas) return fillCopy(POT.reviewFundOnly, { total });
  if (gas && !fund) return fillCopy(POT.reviewGasOnly, { total });
  return fillCopy(POT.reviewTotal, {
    total,
    fund: formatNative(plan.fundWei),
    gas: formatNative(plan.agentGasWei),
  });
}

/** The review: the only owner, the key, the ceiling, the pot's address, what the wallet will send;
 *  then `periods`, `keepLittle` and `noRecovery`. For a plan made for the note's first key
 *  (`keyChanged`), the key's line names it and the registry's new key, and a line says why nothing
 *  moves and what comes next. The declaration is not a line: it is the tick box. */
export function potReviewLines(plan: PotPlan): string[] {
  const key = plan.keyChanged
    ? fillCopy(POT.reviewAgentNoted, { address: plan.agentWallet, registry: plan.registryWallet })
    : fillCopy(POT.reviewAgent, { address: plan.agentWallet });
  return [
    fillCopy(POT.reviewOwner, { address: plan.guardian }),
    key,
    fillCopy(POT.reviewCeiling, { amount: usdc(plan.ceilingUnits) }),
    fillCopy(POT.reviewAddress, { address: plan.pot }),
    moneyLine(plan),
    ...(plan.keyChanged ? [POT.reviewKeyChanged] : []),
    POT.periods,
    POT.keepLittle,
    POT.noRecovery,
  ];
}

// ---------------------------------------------------------------------------------------------
// Before and at the wallet
// ---------------------------------------------------------------------------------------------

/**
 * Before any wallet prompt of a pot transaction, in this order: the page's own facts, an order
 * that is `linked`, not revoked and of this chain, whose guardian is the plan's and the signed-in
 * tenant's (`refused`); the connected account, the guardian's in any letter case
 * (`not_this_wallet`); the wallet on this chain (`wrong_network`). For the two exits (`exit`:
 * Stop the allowance and Take the money back, Ruling R33) the order need not be linked and may be
 * revoked, as the allowlist reads them: every other fact is checked the same.
 */
export function potSendPreflight(p: {
  order: LegalBodyOrderView | null;
  tenant: Address;
  connected: Address | null;
  walletChainId: number | undefined;
  chainId: number;
  guardian: Address;
  exit?: boolean;
}): { ok: true } | { ok: false; problem: "not_this_wallet" | "wrong_network" | "refused" } {
  const o = p.order;
  if (
    o === null ||
    (p.exit !== true && (o.state !== "linked" || o.revoked !== false)) ||
    o.chainId !== p.chainId ||
    !sameAddress(o.guardian, p.guardian) ||
    !sameAddress(p.tenant, p.guardian)
  )
    return { ok: false, problem: "refused" };
  if (!sameAddress(p.connected, p.guardian)) return { ok: false, problem: "not_this_wallet" };
  if (p.walletChainId !== p.chainId) return { ok: false, problem: "wrong_network" };
  return { ok: true };
}

/**
 * The setup's simulation, its `aggregate3Value` answer: true only when it answers one result for
 * each of the plan's calls (the creation, then the pot's money and the fee money when above 0),
 * every one a success, and the first one's answer is the plan's pot, as one 32-byte word. An
 * answer that does not decode is false.
 */
export function potSimulationOk(plan: PotPlan, returnData: Hex): boolean {
  let results: readonly { success: boolean; returnData: Hex }[];
  try {
    results = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3Value",
      data: returnData,
    });
  } catch {
    return false;
  }
  const calls = 1 + (plan.fundWei > ZERO ? 1 : 0) + (plan.agentGasWei > ZERO ? 1 : 0);
  if (!Array.isArray(results) || results.length !== calls) return false;
  if (!results.every((r) => r.success === true)) return false;
  const word = ADDRESS_WORD.exec(results[0].returnData);
  return word !== null && sameAddress(`0x${word[1]}`, plan.pot);
}

/** The gas limit sent: `(estimate * 13 + 9) / 10` in whole numbers, the proven script's headroom,
 *  at most `cap`; null when the estimate itself is above `cap`, or is none. */
export function potGasLimit(estimate: bigint, cap: bigint): bigint | null {
  if (estimate <= ZERO || estimate > cap) return null;
  const limit = (estimate * BigInt(13) + BigInt(9)) / BigInt(10);
  return limit > cap ? cap : limit;
}

// ---------------------------------------------------------------------------------------------
// The sentences of a click's problems
// ---------------------------------------------------------------------------------------------

/** A click's problem with the values its sentence names, each required by its kind: the
 *  guardian's balance and the total in native wei, the guardian's address, the network, the noted
 *  ceiling in units. The other problems' sentences name nothing. */
type ProblemWithValues = "not_enough" | "not_this_wallet" | "wrong_network" | "noted_pot";
export type PotProblemSay =
  | { problem: "not_enough"; balanceWei: bigint; totalWei: bigint }
  | { problem: "not_this_wallet"; guardian: Address }
  | { problem: "wrong_network"; environment: Environment }
  | { problem: "noted_pot"; notedCeilingUnits: bigint }
  | { problem: Exclude<PotProblem, ProblemWithValues> };

/** A click's own problem, said, every value it names filled. */
export function potProblemSentence(say: PotProblemSay): string {
  switch (say.problem) {
    case "not_enough":
      return fillCopy(POT.problems.not_enough, {
        balance: formatNative(say.balanceWei),
        total: formatNative(say.totalWei),
      });
    case "not_this_wallet":
      return fillCopy(POT.problems.not_this_wallet, { address: say.guardian });
    case "wrong_network":
      return fillCopy(POT.problems.wrong_network, { network: networkName(say.environment) });
    case "noted_pot":
      return fillCopy(POT.problems.noted_pot, { amount: usdc(say.notedCeilingUnits) });
    default:
      return POT.problems[say.problem];
  }
}

/** A refusal of the allowlist or of the wallet's checks (`sendAllowedCall`) for a pot call, before
 *  the wallet opened: each code its own plain sentence, the network and the guardian's address
 *  filled where it names them, and one this page does not know the plain refusal. Never the code
 *  itself. */
export function potRefusalSentence(
  code: string,
  p: { environment: Environment; guardian: Address },
): string {
  const refusals: Readonly<Record<string, string>> = POT.refusals;
  if (!owns(refusals, code)) return POT.problems.refused;
  return fillCopy(refusals[code], { network: networkName(p.environment), address: p.guardian });
}

/** The server's pot doors' codes the screens choose a next step for. The screen shows the
 *  sentence the server served; the code only decides what happens next. */
export const POT_SERVER_CODES = [
  "pot_not_offered",
  "pot_exists",
  "pot_taken",
  "pot_pending",
  "pot_address_mismatch",
  "ceiling_above_grant",
  "grant_allows_no_spending",
  "pot_not_on_record",
  "agent_wallet_required",
  "rate_limited",
  "other_deployment",
  "legal_body_revoked",
  "order_closed",
  "pot_chain_unsupported",
  "not_found",
  "pot_declaration_required",
  "pot_invalid",
] as const;
export type PotServerCode = (typeof POT_SERVER_CODES)[number];

/** What the screen does after a refusal of the server: read the noted pot again (a body that
 *  already has its pot, one whose noted pot is still being set up, or a retry of a removal whose
 *  answer was lost), the grant again, or the
 *  record again (the agent's wallet changed); go back to the form (an address the server will not
 *  note); try again; or stop, where no retry can ever work (the pot is not offered here, the body
 *  is revoked, closed, of another deployment or not this tenant's, or this page sent what the door
 *  does not take). */
export type PotServerNext =
  | "reread_pot"
  | "reread_grant"
  | "reread_record"
  | "back_to_form"
  | "try_again"
  | "stop";

const SERVER_NEXT: Readonly<Record<PotServerCode, PotServerNext>> = {
  pot_not_offered: "stop",
  pot_exists: "reread_pot",
  pot_taken: "back_to_form",
  // Ruling R22: the body's noted pot is still being set up; read it, and the card plans THAT address.
  pot_pending: "reread_pot",
  pot_address_mismatch: "back_to_form",
  ceiling_above_grant: "reread_grant",
  grant_allows_no_spending: "reread_grant",
  pot_not_on_record: "reread_pot",
  agent_wallet_required: "reread_record",
  rate_limited: "try_again",
  other_deployment: "stop",
  legal_body_revoked: "stop",
  order_closed: "stop",
  pot_chain_unsupported: "stop",
  not_found: "stop",
  pot_declaration_required: "stop",
  pot_invalid: "stop",
};

/** The next step after a refusal of the server's pot doors, by its code; any other code, or none
 *  (no answer), is a try again. */
export function potServerNext(code: string | undefined): PotServerNext {
  if (code === undefined || !owns(SERVER_NEXT, code)) return "try_again";
  return SERVER_NEXT[code as PotServerCode];
}

// ---------------------------------------------------------------------------------------------
// What a reading says and offers
// ---------------------------------------------------------------------------------------------

export type PotAction =
  | "change"
  | "stop"
  | "withdraw"
  | "start_again"
  | "new_key"
  | "add_money"
  | "fee_money"
  | "take_off_record"
  | "put_back";

type CeilingRead = Extract<PotReading, { state: "ceiling_read" }>;

/** What was taken in the current period and what is left of the ceiling, until the period's end.
 *  What is left floors at 0: after the guardian lowers the ceiling mid-period, what was taken can
 *  be above it (the module keeps what was spent). */
function spentLine(r: CeilingRead): string {
  const left = r.ceilingUnits > r.spentUnits ? r.ceilingUnits - r.spentUnits : ZERO;
  return fillCopy(POT.shownSpent, {
    spent: usdc(r.spentUnits),
    left: usdc(left),
    date: day(r.periodEndsAt),
  });
}

/** The agent key's fee money, and the low mark's warning under it: for a plain key only. A wallet
 *  with code (a contract wallet or a delegated key) pays its fees its own way, and no fee money is
 *  offered to it, so nothing is said of its balance. The card shows these lines in its "Send fee
 *  money" panel, beside the button they are about. */
export function potFeeLines(raw: PotRaw): string[] {
  if (raw.agentHasCode) return [];
  const lines = [fillCopy(POT.shownFeeMoney, { amount: formatNative(raw.agentBalanceWei) })];
  if (raw.agentBalanceWei < POT_FEE_LOW_WEI) lines.push(POT.feeMoneyLow);
  return lines;
}

/** Whether the stop has something to stop in this raw read: `potStopArgs` is not null for it. */
function stoppable(a: PotAddresses | null, guardian: Address, raw: PotRaw): boolean {
  if (a === null) return false;
  try {
    return (
      potStopArgs(a, { guardian, delegates: raw.delegates.list, modules: raw.modules.list }) !==
      null
    );
  } catch {
    return false;
  }
}

/**
 * What the card says of a reading, and what it offers. Every state but `absent` offers the record
 * action: `take_off_record` when `onRecord`, else `put_back`, never for an order of another
 * deployment (the server refuses it), nor for a pot that is not the guardian's alone (Ruling
 * R26: it can be taken off, never put back). `add_money` only while the pot is on the record:
 * money put in a pot taken off it would not show beside the company.
 *  - ceiling_read: change, stop, add_money, and fee_money unless the agent's wallet holds code;
 *  - stopped: start_again; stop while the add-on is still on (no key, module on); withdraw once no
 *    add-on is on and the pot holds money; add_money; fee_money unless the agent's wallet holds
 *    code;
 *  - limits_not_read: with `other_delegate` and the registry's `agentWallet` (never the guardian's)
 *    not among a complete list of the pot's keys, new_key and stop; otherwise stop when there is
 *    something to stop. No money: after a changed-key setup, the new key is set first;
 *  - not_the_guardians: take_off_record only, while it is on the record;
 *  - absent: nothing (the card offers the setup).
 * The lines: the address and the only owner; for ceiling_read the key, the ceiling, what is left
 * until the period's end (while `nowSeconds` is before it: a reading of an ended period says no
 * amount left) and the balance; for stopped `stoppedLine` and the balance; for limits_not_read the
 * reason and the balance; for not_the_guardians `notYours` and the address; for ceiling_read and
 * stopped, a plain key's fee money, with `feeMoneyLow` under POT_FEE_LOW_WEI (nothing for a wallet
 * with code); and `offRecord` when not `onRecord`.
 */
export function potReadingView(
  reading: PotReading,
  raw: PotRaw,
  p: {
    chainId: number;
    pot: Address;
    guardian: Address;
    /** The agent's wallet the reading was made for: the registry's, read for the card. */
    agentWallet: Address;
    onRecord: boolean;
    /** The order is of this deployment's chain and factory. */
    onThisDeployment: boolean;
    nowSeconds: number;
  },
): { lines: string[]; actions: PotAction[] } {
  if (reading.state === "absent") return { lines: [], actions: [] };
  const a = potAddresses(p.chainId);
  const lines: string[] = [];
  const actions: PotAction[] = [];
  const address = fillCopy(POT.shownAddress, { address: p.pot });
  const owner = fillCopy(POT.shownOwner, { address: p.guardian });

  switch (reading.state) {
    case "ceiling_read":
      lines.push(
        address,
        owner,
        fillCopy(POT.shownAgent, { address: p.agentWallet }),
        fillCopy(POT.shownCeiling, { amount: usdc(reading.ceilingUnits) }),
      );
      if (p.nowSeconds < reading.periodEndsAt) lines.push(spentLine(reading));
      lines.push(fillCopy(POT.shownBalance, { balance: usdc(reading.balanceUnits) }));
      lines.push(...potFeeLines(raw));
      actions.push("change", "stop");
      if (p.onRecord) actions.push("add_money");
      if (!raw.agentHasCode) actions.push("fee_money");
      break;
    case "stopped":
      lines.push(
        address,
        owner,
        POT.stoppedLine,
        fillCopy(POT.shownBalance, { balance: usdc(reading.balanceUnits) }),
        ...potFeeLines(raw),
      );
      actions.push("start_again");
      if (stoppable(a, p.guardian, raw)) actions.push("stop");
      if (raw.modules.list.length === 0 && raw.balanceWei > ZERO) actions.push("withdraw");
      if (p.onRecord) actions.push("add_money");
      if (!raw.agentHasCode) actions.push("fee_money");
      break;
    case "limits_not_read": {
      lines.push(
        address,
        owner,
        fillCopy(POT.limitsNotRead, { reason: POT.limitReasons[reading.problem] }),
        fillCopy(POT.shownBalance, { balance: usdc(reading.balanceUnits) }),
      );
      const newKey =
        reading.problem === "other_delegate" &&
        raw.delegates.next === 0 &&
        !sameAddress(p.agentWallet, p.guardian) &&
        !raw.delegates.list.some((d) => sameAddress(d, p.agentWallet));
      if (newKey) actions.push("new_key", "stop");
      else if (stoppable(a, p.guardian, raw)) actions.push("stop");
      break;
    }
    case "not_the_guardians":
      lines.push(POT.notYours, address);
      break;
  }

  if (p.onRecord) actions.push("take_off_record");
  else if (p.onThisDeployment && reading.state !== "not_the_guardians") actions.push("put_back");
  if (!p.onRecord) lines.push(POT.offRecord);
  return { lines, actions };
}

/**
 * After a setup's or a restore's receipt, the reading in its own sentences: `ok` only for
 * ceiling_read with the plan's ceiling. Any other reading is the silent failure the proof found
 * (the allowance left off): the screen shows these lines as a warning and offers nothing else.
 */
export function potCreatedView(
  reading: PotReading,
  ceilingUnits: bigint,
): { ok: boolean; lines: string[] } {
  switch (reading.state) {
    case "ceiling_read":
      return {
        ok: reading.ceilingUnits === ceilingUnits,
        lines: [
          fillCopy(POT.shownCeiling, { amount: usdc(reading.ceilingUnits) }),
          spentLine(reading),
          fillCopy(POT.shownBalance, { balance: usdc(reading.balanceUnits) }),
        ],
      };
    case "stopped":
      return {
        ok: false,
        lines: [
          POT.stoppedLine,
          fillCopy(POT.shownBalance, { balance: usdc(reading.balanceUnits) }),
        ],
      };
    case "limits_not_read":
      return {
        ok: false,
        lines: [
          fillCopy(POT.limitsNotRead, { reason: POT.limitReasons[reading.problem] }),
          fillCopy(POT.shownBalance, { balance: usdc(reading.balanceUnits) }),
        ],
      };
    case "not_the_guardians":
      return { ok: false, lines: [POT.notYours] };
    case "absent":
      return { ok: false, lines: [POT.waiting] };
  }
}

// ---------------------------------------------------------------------------------------------
// The public record and the agent's side
// ---------------------------------------------------------------------------------------------

/** Units as the record serves them: a canonical decimal string; else null. */
const unitsOf = (raw: unknown): bigint | null =>
  typeof raw === "string" && CANONICAL_DECIMAL.test(raw) ? BigInt(raw) : null;
/** A time as the record serves it: whole unix seconds; else null. */
const secondsOf = (raw: unknown): number | null =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;

/**
 * The public record's sentence for a served block, filled from the block alone: ceiling_read with
 * its ceiling, the end of the current period, its balance and the day it was read; stopped with
 * its balance and that day; limits_not_read naming the pot only; unavailable, no claim. Null for no
 * block and for `former` (a by-agent answer never serves it) or a state this page does not know. A
 * block it cannot read claims nothing and never throws: an amount or a time that does not read
 * names the pot with its limits not read, and an address that does not read names nothing.
 */
export function potRecordSentence(block: PotBlock | null | undefined): string | null {
  if (typeof block !== "object" || block === null) return null;
  if (block.state === "unavailable") return POT.recordUnavailable;
  if (
    block.state !== "ceiling_read" &&
    block.state !== "stopped" &&
    block.state !== "limits_not_read"
  )
    return null;
  const address: unknown = block.address;
  if (typeof address !== "string" || !ADDRESS.test(address)) return POT.recordUnavailable;
  const notRead = fillCopy(POT.recordNotRead, { address });
  if (block.state === "limits_not_read") return notRead;
  const balance = unitsOf(block.balanceUnits);
  const readAt = secondsOf(block.readAt);
  if (balance === null || readAt === null) return notRead;
  if (block.state === "stopped")
    return fillCopy(POT.recordStopped, { address, balance: usdc(balance), date: day(readAt) });
  const ceiling = unitsOf(block.ceilingUnits);
  const ends = secondsOf(block.periodEndsAt);
  if (ceiling === null || ends === null) return notRead;
  return fillCopy(POT.recordCeiling, {
    address,
    amount: usdc(ceiling),
    ends: day(ends),
    balance: usdc(balance),
    date: day(readAt),
  });
}

/** The agent's two commands, with the module, the token, the pot, the agent's key and the RPC
 *  filled in, each address checksummed: the take (PAYEE and UNITS left for the agent) and the read
 *  of what is left. */
export function potAgentCommands(p: {
  addresses: PotAddresses;
  pot: Address;
  agentWallet: Address;
  rpcUrl: string;
}): { take: string; read: string } {
  const values = {
    module: checksummed(p.addresses.allowanceModule),
    token: checksummed(p.addresses.usdc),
    pot: checksummed(p.pot),
    agent: checksummed(p.agentWallet),
    rpc: p.rpcUrl,
  };
  return { take: fillCopy(POT.agentCommand, values), read: fillCopy(POT.agentRead, values) };
}
