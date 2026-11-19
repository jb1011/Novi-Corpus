/**
 * The grant form of the Charter flow's test page: the served form read, the form's state, and the
 * grant the state sends.
 *
 * The page is written for one schema of a grant, named by `GRANT_SCHEMA`. A served form under any
 * other name is not drawn. What the server serves is used as served: the greatest amount, the
 * settings offered for each of the four acts of `heavyActs`, the text's id, version and status,
 * and the notice.
 *
 * Nothing here chooses for the Guardian. The state starts with every act not allowed, every amount
 * empty, and no setting, counterparty or end chosen, and `grantFromState` sends exactly what the
 * state holds: a choice not made is a key left out, and a value typed is sent as typed, so the
 * server's own refusal is what the page shows. Nothing is checked here, and nothing is cleaned.
 *
 * A line is named by its key in the schema and a setting by its value in the schema. What a choice
 * means is said by the server alone, in the Schedule A text the preview serves.
 */

/** The one schema this page draws. */
export const GRANT_SCHEMA = "novi.legal-body-grant/1";

/** The seven lines of `acts`, in the schema's order, each with the shape of its setting: an amount
 *  per act (`act`), allowed or not (`flag`), or an amount per act and per thirty days (`spend`). */
export const ACT_LINES = [
  { key: "provideServices", kind: "act" },
  { key: "acceptEngagement", kind: "act" },
  { key: "issueInvoice", kind: "act" },
  { key: "receivePayment", kind: "flag" },
  { key: "buy", kind: "spend" },
  { key: "pay", kind: "spend" },
  { key: "engageContractor", kind: "spend" },
] as const;
export type ActKey = (typeof ACT_LINES)[number]["key"];
export type ActLineKind = (typeof ACT_LINES)[number]["kind"];

/** The four lines of `heavyActs`, in the schema's order. */
export const HEAVY_ACTS = ["employ", "borrow", "guarantee", "transferProperty"] as const;
export type HeavyAct = (typeof HEAVY_ACTS)[number];

export const ABOVE_VALUES = ["guardian_signature", "not_allowed"] as const;
export type Above = (typeof ABOVE_VALUES)[number];
export const HEAVY_MODES = ["not_allowed", "guardian_signature", "alone"] as const;
export type HeavyMode = (typeof HEAVY_MODES)[number];
export const COUNTERPARTY_VALUES = ["anyone", "active_legal_body"] as const;
export type Counterparties = (typeof COUNTERPARTY_VALUES)[number];

/**
 * The three rules of the schema that never vary, each in the exact words the server answers when
 * it is broken. The server does not serve them; the page shows each beside its line.
 */
export const FIXED_RULES = {
  /** Beside `acts.receivePayment.allowed`. */
  receivePayment: "must be true when invoices are allowed",
  /** Beside `acts.<buy|pay|engageContractor>.per30Days`. */
  per30Days: "must be at least the amount per act",
  /** Beside `endsOn`. */
  endsOn: "must be after today (UTC)",
} as const;

// ---------------------------------------------------------------------------------------------
// The served form
// ---------------------------------------------------------------------------------------------

export type ServedGrantForm = {
  text: { id: string; version: string; status: string };
  schema: typeof GRANT_SCHEMA;
  amountMax: number;
  /** The settings offered for each act, in the order served. */
  heavyActModes: Record<HeavyAct, readonly HeavyMode[]>;
  notice: string | null;
};

/**
 * - `none`: this deployment's agreement takes no grant, and an order is placed without one;
 * - `form`: the form to draw;
 * - `unreadable`: an answer this page cannot draw, with the first thing wrong with it: not an
 *   object, `takesGrant` not a boolean, another schema, a text without its id, version and status,
 *   an `amountMax` that is not a whole number of at least 1, an act of `heavyActs` whose settings
 *   are not a list of the schema's modes with `not_allowed` among them, or a notice that is
 *   neither text nor null.
 */
export type GrantFormRead =
  | { kind: "none" }
  | { kind: "form"; form: ServedGrantForm }
  | { kind: "unreadable"; problem: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const unreadable = (problem: string): GrantFormRead => ({ kind: "unreadable", problem });

/** The grant form door's answer, read as untrusted JSON. Never throws. */
export function readGrantForm(answer: unknown): GrantFormRead {
  if (!isRecord(answer)) return unreadable("not_an_object");
  if (answer.takesGrant === false) return { kind: "none" };
  if (answer.takesGrant !== true) return unreadable("takes_grant");
  if (answer.schema !== GRANT_SCHEMA) return unreadable("schema");
  const text = answer.text;
  if (
    !isRecord(text) ||
    typeof text.id !== "string" ||
    typeof text.version !== "string" ||
    typeof text.status !== "string"
  )
    return unreadable("text");
  const amountMax = answer.amountMax;
  if (typeof amountMax !== "number" || !Number.isSafeInteger(amountMax) || amountMax < 1)
    return unreadable("amount_max");
  const served = answer.heavyActModes;
  if (!isRecord(served)) return unreadable("heavy_act_modes");
  const heavyActModes = {} as Record<HeavyAct, readonly HeavyMode[]>;
  for (const act of HEAVY_ACTS) {
    const modes = served[act];
    if (
      !Array.isArray(modes) ||
      !modes.every((m): m is HeavyMode => HEAVY_MODES.some((known) => known === m)) ||
      // Every line opens at `not_allowed`: a form that does not offer it cannot open as it must.
      !modes.includes("not_allowed")
    )
      return unreadable("heavy_act_modes");
    heavyActModes[act] = modes;
  }
  const notice = answer.notice;
  if (notice !== null && typeof notice !== "string") return unreadable("notice");
  return {
    kind: "form",
    form: {
      text: { id: text.id, version: text.version, status: text.status },
      schema: GRANT_SCHEMA,
      amountMax,
      heavyActModes,
      notice,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The form's state
// ---------------------------------------------------------------------------------------------

/** One line of `acts`. The amounts are the text typed; `above` is empty until chosen. A `flag`
 *  line reads `allowed` alone, an `act` line never reads `per30Days`. */
export type ActLineState = {
  allowed: boolean;
  perAct: string;
  per30Days: string;
  above: "" | Above;
};

/** One line of `heavyActs`. `perAct` is the text typed, read only when the mode is `alone`. */
export type HeavyLineState = { mode: HeavyMode; perAct: string };

export type GrantFormState = {
  acts: Record<ActKey, ActLineState>;
  heavyActs: Record<HeavyAct, HeavyLineState>;
  /** Empty until chosen. */
  counterparties: "" | Counterparties;
  /** Which end is chosen: none yet, no end (`null`), or a date. */
  ends: "" | "none" | "date";
  /** The date typed, read only when `ends` is `date`. */
  endsOn: string;
};

/** The state a form opens in: every act not allowed, every amount empty, nothing chosen. It cannot
 *  be sent as an order yet: the server refuses choices that allow nothing. */
export function emptyGrantFormState(): GrantFormState {
  const line = (): ActLineState => ({ allowed: false, perAct: "", per30Days: "", above: "" });
  const heavy = (): HeavyLineState => ({ mode: "not_allowed", perAct: "" });
  return {
    acts: {
      provideServices: line(),
      acceptEngagement: line(),
      issueInvoice: line(),
      receivePayment: line(),
      buy: line(),
      pay: line(),
      engageContractor: line(),
    },
    heavyActs: {
      employ: heavy(),
      borrow: heavy(),
      guarantee: heavy(),
      transferProperty: heavy(),
    },
    counterparties: "",
    ends: "",
    endsOn: "",
  };
}

// ---------------------------------------------------------------------------------------------
// The grant the state sends
// ---------------------------------------------------------------------------------------------

/** A whole number written the one way JSON writes it: no sign, no leading zero, no fraction. */
const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/;

/**
 * An amount as it is sent: nothing typed is no key at all; a whole number typed in its one
 * spelling, and small enough to be exact, is that number; anything else is sent as the text typed,
 * for the server to refuse.
 */
function amountOf(typed: string): { value: number | string } | null {
  const text = typed;
  if (text === "") return null;
  if (WHOLE_NUMBER.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return { value: n };
  }
  return { value: text };
}

function withAmount(o: Record<string, unknown>, key: string, typed: string): void {
  const amount = amountOf(typed);
  if (amount !== null) o[key] = amount.value;
}

function actSetting(kind: ActLineKind, line: ActLineState): Record<string, unknown> {
  if (kind === "flag" || !line.allowed) return { allowed: line.allowed };
  const o: Record<string, unknown> = { allowed: true };
  withAmount(o, "perAct", line.perAct);
  if (kind === "spend") withAmount(o, "per30Days", line.per30Days);
  if (line.above !== "") o.above = line.above;
  return o;
}

function heavySetting(line: HeavyLineState): Record<string, unknown> {
  const o: Record<string, unknown> = { mode: line.mode };
  if (line.mode === "alone") withAmount(o, "perAct", line.perAct);
  return o;
}

/**
 * The `grant` the form sends, to the preview and to the order alike. Every line is sent. A setting
 * not chosen (`above`, `counterparties`, the end) is a key left out, never a value of the page's.
 */
export function grantFromState(state: GrantFormState): Record<string, unknown> {
  const acts: Record<string, unknown> = {};
  for (const { key, kind } of ACT_LINES) acts[key] = actSetting(kind, state.acts[key]);
  const heavyActs: Record<string, unknown> = {};
  for (const act of HEAVY_ACTS) heavyActs[act] = heavySetting(state.heavyActs[act]);
  const grant: Record<string, unknown> = { acts, heavyActs };
  if (state.counterparties !== "") grant.counterparties = state.counterparties;
  if (state.ends === "none") grant.endsOn = null;
  if (state.ends === "date") grant.endsOn = state.endsOn;
  return grant;
}

/** One spelling of a grant, to tell whether a preview was made for the choices now on the form. */
export function grantKey(grant: Record<string, unknown>): string {
  return JSON.stringify(grant);
}

/**
 * Whether the order can be placed. An order freezes its agreement for good, so it is open only
 * when a company is chosen and the form was read, and either this deployment's agreement takes no
 * grant, or a preview of exactly the choices now on the form came back and its answer reads as a
 * grant: the Schedule A of those choices is then on screen. A preview of other choices, or one
 * whose answer is not a grant this page can read, keeps it closed.
 */
export function orderCanBePlaced(input: {
  companyId: string | null;
  /** The served form, read, or null while it is not. */
  read: GrantFormRead | null;
  /** The `grantKey` of the choices now on the form. */
  key: string;
  /** The last preview that came back: the key of the choices it was made for, and the answer. */
  previewed: { key: string; answer: unknown } | null;
}): boolean {
  const { companyId, read, key, previewed } = input;
  if (companyId === null || read === null) return false;
  if (read.kind === "none") return true;
  if (read.kind !== "form") return false;
  if (previewed === null || previewed.key !== key) return false;
  const served = readServedGrant(previewed.answer);
  return served !== null && served !== "unreadable";
}

// ---------------------------------------------------------------------------------------------
// A grant as a door shows it
// ---------------------------------------------------------------------------------------------

export type ServedGrant = {
  number: number;
  version: number;
  digest: string;
  wording: string;
  /** The choices as served, shown as JSON. */
  choices: unknown;
  /** Schedule A as the agreement states it, word for word. */
  scheduleA: string;
};

/**
 * The answer of the preview (`{ grant }`) or of an order's grant (`{ grant }`, null for an order
 * with none), read as untrusted JSON: the grant, `null`, or `unreadable`. Never throws.
 */
export function readServedGrant(answer: unknown): ServedGrant | null | "unreadable" {
  if (!isRecord(answer) || !("grant" in answer)) return "unreadable";
  const g = answer.grant;
  if (g === null) return null;
  if (
    !isRecord(g) ||
    typeof g.number !== "number" ||
    typeof g.version !== "number" ||
    typeof g.digest !== "string" ||
    typeof g.wording !== "string" ||
    typeof g.scheduleA !== "string"
  )
    return "unreadable";
  return {
    number: g.number,
    version: g.version,
    digest: g.digest,
    wording: g.wording,
    choices: g.choices,
    scheduleA: g.scheduleA,
  };
}
