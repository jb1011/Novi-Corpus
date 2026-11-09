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
