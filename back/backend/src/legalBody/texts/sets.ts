import { SCHEDULE_A_WORDING } from "../grant";
import type { LegalText } from "./index";
import { type CharterFields, LEGAL_BODY_CHARTER_2026_11_DRAFT_4 } from "./legalBodyCharter";
import {
  type AgreementFields,
  LEGAL_BODY_OPERATING_AGREEMENT,
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS,
} from "./operatingAgreement";
import {
  DECLARATION_OF_AUTHORITY_2026_11_DRAFT_2,
  STATEMENT_OF_AUTHORITY,
  type StatementFields,
} from "./statementOfAuthority";

/**
 * THE PAIRS OF TEXTS: each version of the agreement, tagged by what it takes to render, and the
 * two texts a deployment serves together, the agreement and the declaration.
 *
 * A pair is written here by naming its two texts, never found by matching version names: the
 * Charter's version and the declaration's are not the same name. Every door reads the pair its
 * dependencies hold, never a constant, so the composition chooses it once.
 */

/** A version of the agreement text, tagged by what it takes to render. */
export type AgreementText =
  | { readonly kind: "plain"; readonly text: LegalText<AgreementFields> }
  | {
      readonly kind: "charter";
      readonly text: LegalText<CharterFields>;
      /** The Schedule A wording this version is written with, or null: a version no order is
       *  placed on. */
      readonly scheduleAWording: string | null;
    };

/** The Schedule A wording of each Charter version, by its version name. A Charter version of the
 *  list with no entry here stops this module from loading. */
const SCHEDULE_A_WORDING_OF_VERSION: ReadonlyMap<string, string | null> = new Map([
  ["2026-11-draft-1", null],
  ["2026-11-draft-2", null],
  ["2026-11-draft-4", SCHEDULE_A_WORDING],
]);

/** A version whose template has no `{scheduleA}` renders from the agreement's fields alone. */
function rendersWithoutScheduleA(
  text: LegalText<CharterFields>,
): text is LegalText<AgreementFields> {
  return !text.template.includes("{scheduleA}");
}

function tagged(text: LegalText<CharterFields>): AgreementText {
  if (rendersWithoutScheduleA(text)) return Object.freeze({ kind: "plain", text });
  const scheduleAWording = SCHEDULE_A_WORDING_OF_VERSION.get(text.version);
  if (scheduleAWording === undefined)
    throw new Error(`legal texts: version "${text.version}" of the agreement has no tag`);
  return Object.freeze({ kind: "charter", text, scheduleAWording });
}

/** Every version, oldest first: the entries of LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS, tagged. */
export const AGREEMENT_TEXTS: readonly AgreementText[] = Object.freeze(
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.map(tagged),
);

export function agreementTextOfVersion(version: string): AgreementText | undefined {
  return AGREEMENT_TEXTS.find((entry) => entry.text.version === version);
}

/** The two texts a deployment serves together. Paired here by name, never by equal version
 *  names. */
export interface LegalTextSet {
  readonly agreement: AgreementText;
  readonly declaration: LegalText<StatementFields>;
}

/**
 * The pair every deployment serves: the October agreement and the October statement. Read when it
 * is called, so a test that replaces either export is read at that moment.
 */
export function servedLegalTexts(): LegalTextSet {
  return Object.freeze({
    agreement: Object.freeze({ kind: "plain", text: LEGAL_BODY_OPERATING_AGREEMENT }),
    declaration: STATEMENT_OF_AUTHORITY,
  });
}

/** Charter draft 4 with declaration draft 2. Selected by nothing in `src`. */
export const CHARTER_LEGAL_TEXTS: LegalTextSet = Object.freeze({
  agreement: tagged(LEGAL_BODY_CHARTER_2026_11_DRAFT_4),
  declaration: DECLARATION_OF_AUTHORITY_2026_11_DRAFT_2,
});

/** Throws unless an order can be placed on `set`: a Charter must be written with
 *  SCHEDULE_A_WORDING. */
export function assertSetUsable(set: LegalTextSet): void {
  const { agreement } = set;
  if (agreement.kind === "charter" && agreement.scheduleAWording !== SCHEDULE_A_WORDING)
    throw new Error(
      `legal texts: version "${agreement.text.version}" of the agreement has no Schedule A wording this deployment writes`,
    );
}
