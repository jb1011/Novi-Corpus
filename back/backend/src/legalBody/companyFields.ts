import { createHash } from "node:crypto";
import { NAME_CHARSET_SOURCE } from "../formation/intake";
import { type TextRule, applyTextRule } from "./textRules";

/**
 * THE COMPANY FIELDS the legal texts print: a company's name and its Wyoming filing number, which
 * the statement of authority and the operating agreement each print between double quotes. One
 * rule per field, whichever door the company came through: the declared door holds what a guardian
 * declares to them (`customerCompany.ts`), and the order holds a formed company's filed name and
 * number to them before its agreement prints them (`orders.ts`).
 */

/** The characters the formation intake accepts in a Wyoming entity name. */
export const COMPANY_NAME: TextRule = {
  min: 2,
  max: 200,
  chars: new RegExp(`^[${NAME_CHARSET_SOURCE}]+$`),
  charsProblem:
    "may hold only the characters a Wyoming entity name takes: A-Z, a-z, 0-9, spaces and & ' - , . ( ) +",
};

export const FILING_NUMBER: TextRule = {
  min: 4,
  max: 32,
  chars: /^[0-9A-Za-z-]+$/,
  charsProblem: "may hold only A-Z, a-z, 0-9 and hyphens",
};

/**
 * THE SANDBOX STAND-IN FILING NUMBER (design 2026-11-11 §2). doola's sandbox playground files a
 * company with no filing number, and a formed legal-body company cannot be ordered without one. So
 * on a sandbox the processor records a stand-in: this prefix, then the first 16 hex characters, in
 * upper case, of the SHA-256 of doola's company id. 29 characters: it passes FILING_NUMBER and the
 * declared door's sandbox pattern (`TEST-` then 4 to 27 of A-Z, 0-9 and hyphens), and nothing that
 * starts with it can pass for a Wyoming filing id such as `2024-001234567`.
 *
 * The declared door reserves the prefix on a sandbox, so no declared test number is ever one.
 */
export const SANDBOX_STAND_IN_PREFIX = "TEST-STANDIN-";

/**
 * The stand-in filing number of doola's company `doolaCompanyId`. Deterministic, so a re-read
 * computes the same value and the repository then changes nothing. A hash rather than the id
 * itself: doola's ids are mixed-case base62, the sandbox pattern takes upper case only, so
 * upper-casing the id would lose information, and a whole id would not fit after the prefix.
 */
export function sandboxStandInFilingNumber(doolaCompanyId: string): string {
  const digest = createHash("sha256").update(doolaCompanyId, "utf8").digest("hex");
  return `${SANDBOX_STAND_IN_PREFIX}${digest.slice(0, 16).toUpperCase()}`;
}

/**
 * Whether `value` passes `rule` as it stands: the rule refuses nothing in it and would change
 * nothing in it (no space to strip or collapse, no character NFC would rewrite). For a value the
 * platform already holds and is about to print, which is refused when it fails, never cleaned: the
 * text prints exactly what the record holds.
 */
export function passesAsItStands(value: string, rule: TextRule): boolean {
  return applyTextRule("value", value, rule, []) === value;
}

/** Whether the operating agreement can print a formed company's filed name and filing number as
 *  the company's row holds them. */
export function filedNamesPrintable(names: { legalName: string; filingNumber: string }): boolean {
  return (
    passesAsItStands(names.legalName, COMPANY_NAME) &&
    passesAsItStands(names.filingNumber, FILING_NUMBER)
  );
}
