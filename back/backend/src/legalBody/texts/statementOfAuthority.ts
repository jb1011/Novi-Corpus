import type { Address } from "../../types";
import { type LegalText, defineLegalText } from "./index";

/**
 * The statement of authority: the sentence a guardian signs to declare an existing Wyoming LLC as
 * the company behind a legal body.
 *
 * Each field stands between double quotes, which the field rules forbid inside a field, so a name
 * can never be mistaken for the sentence's own words. The final wording is counsel's: when it
 * arrives, it is added as a new version with the status `approved`.
 *
 * From version 2026-11-draft-1 on, the text is called the declaration of authority. The code id,
 * the typed-data domain and the primary type keep their names.
 */
export interface StatementFields {
  declarantName: string;
  declarantTitle: string;
  companyName: string;
  jurisdiction: "WY";
  filingNumber: string;
  guardian: Address;
}

const STATEMENT_2026_10_DRAFT_1 = defineLegalText<StatementFields>({
  id: "statement-of-authority",
  version: "2026-10-draft-1",
  status: "draft",
  template:
    'I, "{declarantName}", "{declarantTitle}" of "{companyName}", a Wyoming limited liability company with filing number "{filingNumber}", declare that I am authorised to bind that company, and that the wallet {guardian} acts as its guardian for this legal body.',
});

export const DECLARATION_OF_AUTHORITY: LegalText<StatementFields> =
  defineLegalText<StatementFields>({
    id: "statement-of-authority",
    version: "2026-11-draft-1",
    status: "draft",
    template:
      'I, "{declarantName}", "{declarantTitle}" of "{companyName}" (the "Company"), a Wyoming limited liability company with filing number "{filingNumber}", declare to NoviCorpus, Inc. ("Novi Corpus") that: (1) I am authorised to bind the Company and to adopt, on its behalf, a supplement to its operating agreement; (2) I personally control the wallet {guardian}, and the Company designates it as its Guardian Wallet with Novi Corpus, authorised to adopt and amend, for the Company, a Legal Body Charter for each legal body recorded for the Company, including by granting, limiting or revoking the agent\'s authority under it, and to act for the Company as regards each such legal body; (3) the Company consents to Novi Corpus publishing its legal name, its filing number, that wallet\'s address and the text of each charter it adopts, with its grants and schedules, in signed statements anyone may read; and (4) I understand that Novi Corpus relies on this declaration and may check it against the public record and the evidence I provide.',
  });

/**
 * Every version of the statement, oldest first. A changed sentence is a NEW entry at the end. An
 * entry is never edited or removed: a stored declaration names the version it was made under.
 */
export const STATEMENT_OF_AUTHORITY_VERSIONS: readonly LegalText<StatementFields>[] = Object.freeze(
  [STATEMENT_2026_10_DRAFT_1, DECLARATION_OF_AUTHORITY],
);

/**
 * The version new declarations are made under. It stays the October draft until the grant step
 * exists: the declaration of authority speaks of a Legal Body Charter, which no door serves yet.
 */
export const STATEMENT_OF_AUTHORITY: LegalText<StatementFields> = STATEMENT_2026_10_DRAFT_1;
