import { DECLARANT_NAME, applyTextRule } from "../legalBody/textRules";

/**
 * THE NAME OF RECORD: how a name printed on a document becomes the name the guardian identity
 * record stores, and the rule that name must pass before the record is verified without review.
 *
 * A document prints a surname in capitals ("DUPONT"); the record stores it as a person writes it
 * ("Dupont"). Only a field that is ALL capitals is recased: a mixed-case field ("McAllister") is
 * how the person writes it, and recasing it would be a guess.
 */

const WHITESPACE_RUNS = /\s+/g;
const HAS_LETTER = /\p{L}/u;
/** The first code point of the field, and the one after a space, a hyphen, an apostrophe or a
 *  full stop (so initials such as "J.R." stay initials), when it is not one of those itself: the
 *  space after "J.R." must not be taken as the word start, or the word after it stays lower case. */
const WORD_START = /(^|[ '.-])([^ '.-])/gu;
/** Letters of the Latin script, combining marks, and the punctuation the declarant rule allows. */
const LATIN_NAME = /^[\p{Script=Latin}\p{M} '.-]+$/u;

/**
 * One field: composed (NFC) first, so the record, `/me` and the declaration hold the same bytes
 * however the name was typed; trimmed, inner whitespace collapsed to one space; then, when the
 * field has letters and equals its upper-case form, each word title-cased (a new word after a
 * space, "-", "'" or "."), diacritics kept, and composed again: recasing can itself decompose
 * ("İ" lower-cases to "i" and a combining dot). The plain case forms, never the locale ones (those
 * follow the process's locale, a Turkish one lower-casing "I" to a dotless "ı"), so the result
 * does not depend on the box's settings.
 */
export function nameOfRecord(printed: string): string {
  const value = printed.normalize("NFC").trim().replace(WHITESPACE_RUNS, " ");
  if (!HAS_LETTER.test(value) || value !== value.toUpperCase()) return value;
  return value
    .toLowerCase()
    .replace(WORD_START, (_, before: string, first: string) => before + first.toUpperCase())
    .normalize("NFC");
}

/** The declarant name the declared door compares with: the first name, a space, the last name. */
export function composeDeclarantName(first: string, last: string): string {
  return `${first} ${last}`;
}

/**
 * Both names present, then the composed name through the declared door's own rule
 * (`DECLARANT_NAME`), then through a Latin-script check. Returns the problem, which names the rule
 * and never the value, or null.
 */
export function nameRuleProblem(first: string, last: string): string | null {
  // A document without one of the two leaves the composed name looking whole: " Dupont" passes
  // the declarant rule once trimmed. The record needs both, or an operator's decision.
  if (first.trim() === "" || last.trim() === "") return "name needs both a first and a last name";
  const problems: Array<{ field: string; problem: string }> = [];
  const value = applyTextRule("name", composeDeclarantName(first, last), DECLARANT_NAME, problems);
  if (value === undefined) return `name ${problems[0]?.problem ?? "breaks the declarant rule"}`;
  // Stricter than the door: the record's name goes into a Wyoming filing and the declaration, which need Latin script.
  if (!LATIN_NAME.test(value)) return "name must be written in the Latin script";
  return null;
}

/** The AAD of one encrypted name field: the tenant id and the field, so a ciphertext moved to
 *  another tenant or another field fails to decrypt. */
export const IDENTITY_AAD = (tenantId: string, field: "first" | "last" | "full") =>
  `identity|${tenantId}|${field}`;
