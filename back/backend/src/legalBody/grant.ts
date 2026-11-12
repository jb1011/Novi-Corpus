/**
 * A GRANT: the company's written permission for its agent, saying which acts the agent may make in
 * the company's name and up to which amount. The guardian chooses it in a form, and it is written
 * into the Charter's Schedule A before the guardian adopts the Charter. Every amount is a whole
 * number of USDC. Every limit is declared: written into the Charter, for the agent and for anyone
 * who deals with it to read.
 *
 * `parseGrantChoices` turns the guardian's choices into one canonical value, or refuses them field
 * by field, every broken rule in one pass. A value is refused, never cleaned or converted, so one
 * set of choices has one spelling.
 */
import type { FieldProblem } from "./textRules";

export const GRANT_AMOUNT_MAX = 1_000_000_000; // whole USDC

export type GrantAbove = "guardian_signature" | "not_allowed";
/** A kind of act with one amount, per act. */
export type GrantActSetting =
  | { allowed: false }
  | { allowed: true; perAct: number; above: GrantAbove };
/** Buying, paying, engaging a contractor: per act and per thirty days. */
export type GrantSpendSetting =
  | { allowed: false }
  | { allowed: true; perAct: number; per30Days: number; above: GrantAbove };
/** One of the four acts of the Charter's section 5.6. */
export type GrantHeavySetting =
  | { mode: "not_allowed" }
  | { mode: "guardian_signature" }
  | { mode: "alone"; perAct: number };

export type GrantChoices = {
  acts: {
    provideServices: GrantActSetting;
    acceptEngagement: GrantActSetting;
    issueInvoice: GrantActSetting;
    receivePayment: { allowed: boolean };
    buy: GrantSpendSetting;
    pay: GrantSpendSetting;
    engageContractor: GrantSpendSetting;
  };
  heavyActs: {
    employ: GrantHeavySetting;
    borrow: GrantHeavySetting;
    guarantee: GrantHeavySetting;
    transferProperty: GrantHeavySetting;
  };
  counterparties: "anyone" | "active_legal_body";
  /** The last UTC day the grant is in force, `YYYY-MM-DD`, or null: until revoked. */
  endsOn: string | null;
};

const ROOT_KEYS = ["acts", "heavyActs", "counterparties", "endsOn"] as const;
const ACT_KINDS = [
  "provideServices",
  "acceptEngagement",
  "issueInvoice",
  "receivePayment",
  "buy",
  "pay",
  "engageContractor",
] as const;
const HEAVY_ACTS = ["employ", "borrow", "guarantee", "transferProperty"] as const;
const ACT_SETTING_KEYS = ["allowed", "perAct", "above"] as const;
const SPEND_SETTING_KEYS = ["allowed", "perAct", "per30Days", "above"] as const;
const RECEIVE_PAYMENT_KEYS = ["allowed"] as const;
const HEAVY_SETTING_KEYS = ["mode", "perAct"] as const;
const ABOVE = ["guardian_signature", "not_allowed"] as const;
const MODES = ["not_allowed", "guardian_signature", "alone"] as const;
const COUNTERPARTIES = ["anyone", "active_legal_body"] as const;

const MUST_BE_AN_OBJECT = "must be an object";
const NOT_A_FIELD = "is not a field of a grant";
const REQUIRED = "is required";
const TRUE_OR_FALSE = "must be true or false";
/** Names `GRANT_AMOUNT_MAX`, written out. */
const AMOUNT = "must be a whole number of USDC from 1 to 1,000,000,000";
const AT_LEAST_PER_ACT = "must be at least the amount per act";
const ABOVE_PROBLEM = "must be guardian_signature or not_allowed";
const ABSENT_WHEN_NOT_ALLOWED = "must be absent when the act is not allowed";
const INVOICES_NEED_PAYMENT = "must be true when invoices are allowed";
const MODE_PROBLEM = "must be not_allowed, guardian_signature or alone";
const ABSENT_UNLESS_ALONE = "must be absent unless the mode is alone";
const COUNTERPARTIES_PROBLEM = "must be anyone or active_legal_body";
const DATE_PROBLEM = "must be null or a calendar date written YYYY-MM-DD";
const AFTER_TODAY = "must be after today (UTC)";

type Fields = Record<string, unknown>;
/**
 * Reads one value at `field`. Returns it, or returns undefined only after recording at least one
 * problem; it may also return a value after recording one, as the whole is refused then.
 */
type Reader<T> = (field: string, raw: unknown, problems: FieldProblem[]) => T | undefined;

/** A non-null object that is not an array. */
const isFields = (v: unknown): v is Fields =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** The value `o` holds as its own under `key`; never an inherited one. */
const own = (o: Fields, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);
const at = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);
const refuse = (problems: FieldProblem[], field: string, problem: string): undefined => {
  problems.push({ field, problem });
  return undefined;
};

/** Each key of `o` other than `keys` is a problem, and so is each of `required` that `o` lacks. */
function checkKeys(
  path: string,
  o: Fields,
  keys: readonly string[],
  required: readonly string[],
  problems: FieldProblem[],
): void {
  for (const key of Object.keys(o))
    if (!keys.includes(key)) problems.push({ field: at(path, key), problem: NOT_A_FIELD });
  for (const key of required)
    if (!Object.hasOwn(o, key)) problems.push({ field: at(path, key), problem: REQUIRED });
}

/** The key `o` holds, through `read`. A missing key returns undefined: `checkKeys` reported it. */
function member<T>(
  o: Fields,
  path: string,
  key: string,
  read: Reader<T>,
  problems: FieldProblem[],
): T | undefined {
  return Object.hasOwn(o, key) ? read(at(path, key), o[key], problems) : undefined;
}

/** A plain object with only the keys a grant has at `field`, every one of them required. */
function container(
  field: string,
  raw: unknown,
  keys: readonly string[],
  problems: FieldProblem[],
): Fields | undefined {
  if (!isFields(raw)) return refuse(problems, field, MUST_BE_AN_OBJECT);
  checkKeys(field, raw, keys, keys, problems);
  return raw;
}

const readAmount: Reader<number> = (field, raw, problems) =>
  typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= GRANT_AMOUNT_MAX
    ? raw
    : refuse(problems, field, AMOUNT);

/** One of `values`, compared exactly. */
function readOneOf<T extends string>(
  field: string,
  raw: unknown,
  values: readonly T[],
  problem: string,
  problems: FieldProblem[],
): T | undefined {
  const found = values.find((v) => v === raw);
  return found === undefined ? refuse(problems, field, problem) : found;
}

/**
 * The start every act's setting shares: a plain object, with only `keys`, and an `allowed` that is
 * true or false. Returns the object when the act is allowed. When it is not, records each other
 * value it holds and returns false. When `allowed` is not a boolean, the setting means nothing yet:
 * returns undefined, and its other values go unchecked.
 */
function readAllowed(
  field: string,
  raw: unknown,
  keys: readonly string[],
  problems: FieldProblem[],
): Fields | false | undefined {
  if (!isFields(raw)) return refuse(problems, field, MUST_BE_AN_OBJECT);
  checkKeys(field, raw, keys, [], problems);
  const allowed = own(raw, "allowed");
  if (typeof allowed !== "boolean") return refuse(problems, at(field, "allowed"), TRUE_OR_FALSE);
  if (allowed) return raw;
  for (const key of keys)
    if (key !== "allowed" && Object.hasOwn(raw, key))
      problems.push({ field: at(field, key), problem: ABSENT_WHEN_NOT_ALLOWED });
  return false;
}

const readAct: Reader<GrantActSetting> = (field, raw, problems) => {
  const o = readAllowed(field, raw, ACT_SETTING_KEYS, problems);
  if (o === undefined) return undefined;
  if (o === false) return { allowed: false };
  const perAct = readAmount(at(field, "perAct"), own(o, "perAct"), problems);
  const above = readOneOf(at(field, "above"), own(o, "above"), ABOVE, ABOVE_PROBLEM, problems);
  if (perAct === undefined || above === undefined) return undefined;
  return { allowed: true, perAct, above };
};

const readSpend: Reader<GrantSpendSetting> = (field, raw, problems) => {
  const o = readAllowed(field, raw, SPEND_SETTING_KEYS, problems);
  if (o === undefined) return undefined;
  if (o === false) return { allowed: false };
  const perAct = readAmount(at(field, "perAct"), own(o, "perAct"), problems);
  const per30Days = readAmount(at(field, "per30Days"), own(o, "per30Days"), problems);
  if (perAct !== undefined && per30Days !== undefined && per30Days < perAct)
    problems.push({ field: at(field, "per30Days"), problem: AT_LEAST_PER_ACT });
  const above = readOneOf(at(field, "above"), own(o, "above"), ABOVE, ABOVE_PROBLEM, problems);
  if (perAct === undefined || per30Days === undefined || above === undefined) return undefined;
  return { allowed: true, perAct, per30Days, above };
};

const readReceivePayment: Reader<{ allowed: boolean }> = (field, raw, problems) => {
  const o = readAllowed(field, raw, RECEIVE_PAYMENT_KEYS, problems);
  return o === undefined ? undefined : { allowed: o !== false };
};

/** The `allowed` a kind of act holds, when its setting is a plain object; read for the rule that
 *  ties two kinds together, which applies only when both values are true or false. */
const allowedOf = (acts: Fields, kind: string): unknown => {
  const setting = own(acts, kind);
  return isFields(setting) ? own(setting, "allowed") : undefined;
};

const readActs: Reader<GrantChoices["acts"]> = (field, raw, problems) => {
  const o = container(field, raw, ACT_KINDS, problems);
  if (o === undefined) return undefined;
  const provideServices = member(o, field, "provideServices", readAct, problems);
  const acceptEngagement = member(o, field, "acceptEngagement", readAct, problems);
  const issueInvoice = member(o, field, "issueInvoice", readAct, problems);
  const receivePayment = member(o, field, "receivePayment", readReceivePayment, problems);
  const buy = member(o, field, "buy", readSpend, problems);
  const pay = member(o, field, "pay", readSpend, problems);
  const engageContractor = member(o, field, "engageContractor", readSpend, problems);
  if (allowedOf(o, "issueInvoice") === true && allowedOf(o, "receivePayment") === false)
    problems.push({
      field: at(at(field, "receivePayment"), "allowed"),
      problem: INVOICES_NEED_PAYMENT,
    });
  if (
    provideServices === undefined ||
    acceptEngagement === undefined ||
    issueInvoice === undefined ||
    receivePayment === undefined ||
    buy === undefined ||
    pay === undefined ||
    engageContractor === undefined
  )
    return undefined;
  return {
    provideServices,
    acceptEngagement,
    issueInvoice,
    receivePayment,
    buy,
    pay,
    engageContractor,
  };
};

/** When `mode` is not one of its three values, the setting means nothing yet: its `perAct` goes
 *  unchecked. */
const readHeavyAct: Reader<GrantHeavySetting> = (field, raw, problems) => {
  if (!isFields(raw)) return refuse(problems, field, MUST_BE_AN_OBJECT);
  checkKeys(field, raw, HEAVY_SETTING_KEYS, [], problems);
  const mode = readOneOf(at(field, "mode"), own(raw, "mode"), MODES, MODE_PROBLEM, problems);
  if (mode === undefined) return undefined;
  if (mode === "alone") {
    const perAct = readAmount(at(field, "perAct"), own(raw, "perAct"), problems);
    return perAct === undefined ? undefined : { mode, perAct };
  }
  if (Object.hasOwn(raw, "perAct"))
    problems.push({ field: at(field, "perAct"), problem: ABSENT_UNLESS_ALONE });
  return { mode };
};

const readHeavyActs: Reader<GrantChoices["heavyActs"]> = (field, raw, problems) => {
  const o = container(field, raw, HEAVY_ACTS, problems);
  if (o === undefined) return undefined;
  const employ = member(o, field, "employ", readHeavyAct, problems);
  const borrow = member(o, field, "borrow", readHeavyAct, problems);
  const guarantee = member(o, field, "guarantee", readHeavyAct, problems);
  const transferProperty = member(o, field, "transferProperty", readHeavyAct, problems);
  if (
    employ === undefined ||
    borrow === undefined ||
    guarantee === undefined ||
    transferProperty === undefined
  )
    return undefined;
  return { employ, borrow, guarantee, transferProperty };
};

const readCounterparties: Reader<GrantChoices["counterparties"]> = (field, raw, problems) =>
  readOneOf(field, raw, COUNTERPARTIES, COUNTERPARTIES_PROBLEM, problems);

/** Exactly four digits, two and two: no sign, no time, no other digit than 0 to 9. */
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A day that exists in the Gregorian calendar, written `YYYY-MM-DD`. */
function isCalendarDate(s: string): boolean {
  const m = DATE.exec(s);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const last = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return last !== undefined && day >= 1 && day <= last;
}

/** `null`, or a calendar day after `todayUtc`. Two days written `YYYY-MM-DD` compare as text. */
const readEndsOn =
  (todayUtc: string): Reader<string | null> =>
  (field, raw, problems) => {
    if (raw === null) return null;
    if (typeof raw !== "string" || !isCalendarDate(raw))
      return refuse(problems, field, DATE_PROBLEM);
    return raw > todayUtc ? raw : refuse(problems, field, AFTER_TODAY);
  };

/** `todayUtc` is `YYYY-MM-DD`. Never throws on any input. */
export function parseGrantChoices(
  raw: unknown,
  todayUtc: string,
): { choices: GrantChoices } | { problems: FieldProblem[] } {
  if (!isFields(raw)) return { problems: [{ field: "grant", problem: MUST_BE_AN_OBJECT }] };
  const problems: FieldProblem[] = [];
  checkKeys("", raw, ROOT_KEYS, ROOT_KEYS, problems);
  const acts = member(raw, "", "acts", readActs, problems);
  const heavyActs = member(raw, "", "heavyActs", readHeavyActs, problems);
  const counterparties = member(raw, "", "counterparties", readCounterparties, problems);
  const endsOn = member(raw, "", "endsOn", readEndsOn(todayUtc), problems);
  if (
    problems.length > 0 ||
    acts === undefined ||
    heavyActs === undefined ||
    counterparties === undefined ||
    endsOn === undefined
  )
    return { problems };
  return { choices: { acts, heavyActs, counterparties, endsOn } };
}

/** The UTC calendar day of a time in milliseconds, `YYYY-MM-DD`. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
