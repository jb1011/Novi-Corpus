/**
 * THE FIELD RULES a declaration's text fields and the name of record share: what a field may hold,
 * and the one function that holds a value to a rule. The declared door (`customerCompany.ts`)
 * applies them to every field it takes, and the name of record (`identity/names.ts`) to the name it
 * composes, so both read them here. This module imports nothing, so neither of them imports the
 * other.
 */

/** One field that broke a rule. `problem` names the rule, never the value. */
export interface FieldProblem {
  field: string;
  problem: string;
}

/** A control, format (a zero-width character, a direction override), surrogate, private-use or
 *  unassigned character. */
const CONTROL_OR_INVISIBLE = /\p{C}/u;
/** A separator other than U+0020: a non-breaking space, a line separator, an ideographic space. */
const OTHER_SPACE = /(?! )\p{Z}/u;
const SPACES_AT_THE_ENDS = /^ +| +$/g;
const SPACE_RUNS = / {2,}/g;

export interface TextRule {
  /** Inclusive, in code points, after the spaces are normalised. */
  min: number;
  max: number;
  /** The characters the field may hold, as a whole-string test. */
  chars: RegExp;
  charsProblem: string;
  /** A further pattern the value must match. */
  also?: { pattern: RegExp; problem: string };
}

export const DECLARANT_NAME: TextRule = {
  min: 2,
  max: 120,
  chars: /^[\p{L}\p{M} '.-]+$/u,
  charsProblem: "may hold only letters, spaces, apostrophes, hyphens and full stops",
};

/**
 * One field through the field rules, in their order: NFC; then a field holding a control or
 * invisible character, a space other than U+0020, or a double quote is refused, never cleaned (a
 * tab or a non-breaking space is not turned into a space); then the U+0020 at the ends are stripped
 * and runs of them collapsed to one; then the length, in code points, and the characters.
 * Returns the normalised value, or records the problem and returns undefined.
 */
export function applyTextRule(
  field: string,
  raw: unknown,
  rule: TextRule,
  problems: FieldProblem[],
): string | undefined {
  const refuse = (problem: string): undefined => {
    problems.push({ field, problem });
    return undefined;
  };
  if (raw === undefined || raw === null) return refuse("is required");
  if (typeof raw !== "string") return refuse("must be text");
  const nfc = raw.normalize("NFC");
  if (CONTROL_OR_INVISIBLE.test(nfc)) return refuse("holds a control or invisible character");
  if (OTHER_SPACE.test(nfc)) return refuse("holds a space other than a plain space");
  if (nfc.includes('"')) return refuse("holds a double quote");
  const value = nfc.replace(SPACES_AT_THE_ENDS, "").replace(SPACE_RUNS, " ");
  const length = [...value].length;
  if (length < rule.min || length > rule.max)
    return refuse(`must be ${rule.min} to ${rule.max} characters long`);
  if (!rule.chars.test(value)) return refuse(rule.charsProblem);
  if (rule.also && !rule.also.pattern.test(value)) return refuse(rule.also.problem);
  return value;
}
