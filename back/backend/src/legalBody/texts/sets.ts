import { SCHEDULE_A_WORDING } from "../grant";
import {
  CHARTER_ADOPTION_RULE_2026_11_DRAFT_1,
  CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1,
} from "./adoptionStatement";
import type { LegalText } from "./index";
import { type CharterFields, LEGAL_BODY_CHARTER_2026_11_DRAFT_5 } from "./legalBodyCharter";
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
 * THE PAIRS OF TEXTS: each version of the agreement, tagged by its name with what it takes to
 * render, and the two texts a deployment serves together, the agreement and the declaration.
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
      /** The words its adoption is signed with, or null: a version no order is placed on. */
      readonly adoptionStatement: string | null;
    };

/** What a version's tag holds: its kind, and for a Charter its Schedule A wording and its words of
 *  adoption. */
type Tag =
  | { readonly kind: "plain" }
  | {
      readonly kind: "charter";
      readonly scheduleAWording: string | null;
      readonly adoptionStatement: string | null;
    };

/**
 * The tag of each version of the agreement, by its version name. The name decides the tag, and the
 * template is held to it when this module loads: a version of the list with no entry here, a
 * `plain` version whose template takes a Schedule A, or a `charter` version whose template takes
 * none, stops this module from loading.
 */
const TAG_OF_VERSION: ReadonlyMap<string, Tag> = new Map<string, Tag>([
  ["2026-10-draft-1", { kind: "plain" }],
  ["2026-11-draft-1", { kind: "charter", scheduleAWording: null, adoptionStatement: null }],
  ["2026-11-draft-2", { kind: "charter", scheduleAWording: null, adoptionStatement: null }],
  ["2026-11-draft-4", { kind: "charter", scheduleAWording: null, adoptionStatement: null }],
  [
    "2026-11-draft-5",
    {
      kind: "charter",
      scheduleAWording: SCHEDULE_A_WORDING,
      adoptionStatement: CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1,
    },
  ],
]);

/** A version whose template has no `{scheduleA}` renders from the agreement's fields alone. The
 *  compiler's proof for the `plain` arm: the tag decides the kind, this guard only checks it. */
function rendersWithoutScheduleA(
  text: LegalText<CharterFields>,
): text is LegalText<AgreementFields> {
  return !text.template.includes("{scheduleA}");
}

function tagged(text: LegalText<CharterFields>): AgreementText {
  const { version } = text;
  const tag = TAG_OF_VERSION.get(version);
  if (tag === undefined)
    throw new Error(`legal texts: version "${version}" of the agreement has no tag`);
  if (tag.kind === "plain") {
    if (!rendersWithoutScheduleA(text))
      throw new Error(
        `legal texts: version "${version}" of the agreement is tagged plain and its template takes a Schedule A`,
      );
    return Object.freeze({ kind: "plain", text });
  }
  if (rendersWithoutScheduleA(text))
    throw new Error(
      `legal texts: version "${version}" of the agreement is tagged charter and its template takes no Schedule A`,
    );
  return Object.freeze({
    kind: "charter",
    text,
    scheduleAWording: tag.scheduleAWording,
    adoptionStatement: tag.adoptionStatement,
  });
}

/** Every version, oldest first: the entries of LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS, tagged. */
export const AGREEMENT_TEXTS: readonly AgreementText[] = Object.freeze(
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.map(tagged),
);

export function agreementTextOfVersion(version: string): AgreementText | undefined {
  return AGREEMENT_TEXTS.find((entry) => entry.text.version === version);
}

/** The words the adoption of a text of this version is signed with, or null: a version adopted by
 *  the adoption's fields alone, or one this build does not know. */
export function adoptionStatementOfVersion(version: string): string | null {
  const entry = agreementTextOfVersion(version);
  return entry?.kind === "charter" ? entry.adoptionStatement : null;
}

/** What the adoption of a text of this version asks of the company, or null: its adoption asks
 *  nothing in words, or this build does not know the version. */
export function adoptionRuleOfVersion(version: string): string | null {
  // The rule belongs to the words of adoption: other words bring their own rule, or none.
  return adoptionStatementOfVersion(version) === CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1
    ? CHARTER_ADOPTION_RULE_2026_11_DRAFT_1
    : null;
}

/** The two texts a deployment serves together. Paired here by name, never by equal version
 *  names. */
export interface LegalTextSet {
  readonly agreement: AgreementText;
  readonly declaration: LegalText<StatementFields>;
}

/** The October agreement and the October statement: the pair a deployment serves when it names none. */
export function octoberLegalTexts(): LegalTextSet {
  return Object.freeze({
    agreement: Object.freeze({ kind: "plain", text: LEGAL_BODY_OPERATING_AGREEMENT }),
    declaration: STATEMENT_OF_AUTHORITY,
  });
}

/** Charter draft 5 with declaration draft 2. Selected by nothing in `src`. */
export const CHARTER_LEGAL_TEXTS: LegalTextSet = Object.freeze({
  agreement: tagged(LEGAL_BODY_CHARTER_2026_11_DRAFT_5),
  declaration: DECLARATION_OF_AUTHORITY_2026_11_DRAFT_2,
});

/** Throws unless an order can be placed on `set`: a Charter must be written with
 *  SCHEDULE_A_WORDING, and must have words of adoption. */
export function assertSetUsable(set: LegalTextSet): void {
  const { agreement } = set;
  if (agreement.kind !== "charter") return;
  if (agreement.scheduleAWording !== SCHEDULE_A_WORDING)
    throw new Error(
      `legal texts: version "${agreement.text.version}" of the agreement has no Schedule A wording this deployment writes`,
    );
  if (agreement.adoptionStatement === null)
    throw new Error(
      `legal texts: version "${agreement.text.version}" of the agreement has no words of adoption`,
    );
}
