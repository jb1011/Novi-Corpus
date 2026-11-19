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

/** What a pair's agreement says of the legal body's contract, by name. Proved on chain at start. */
export type LegalBodyContractFacts = "fixed_copy_cancellable_dissolution";

/** What a production deployment must have built before it serves a pair. */
export const PRODUCTION_NEEDS = [
  "presence_check_at_grant",
  "email_notice_at_grant",
  "guardian_notice_before_adoption",
  "guardian_residence_scope",
] as const;
export type ProductionNeed = (typeof PRODUCTION_NEEDS)[number];

/** The needs this build has built. None yet: the step that builds one adds its name here. */
export const PRODUCTION_NEEDS_BUILT: ReadonlySet<ProductionNeed> = new Set<ProductionNeed>();

/** How a refusal names each need a production deployment has not built. */
const PHRASE_OF_NEED: Readonly<Record<ProductionNeed, string>> = Object.freeze({
  presence_check_at_grant: "the presence check before a grant is served for signature",
  email_notice_at_grant: "the notice by email before a grant is served for signature",
  guardian_notice_before_adoption: "the Guardian's notice shown before the adoption",
  guardian_residence_scope: "the check of where the Guardian lives",
});

/** The two texts a deployment serves together. Paired here by name, never by equal version
 *  names. */
export interface LegalTextSet {
  readonly agreement: AgreementText;
  readonly declaration: LegalText<StatementFields>;
  /** What the agreement says of the legal body's contract, or null: nothing a start check reads. */
  readonly contractFacts: LegalBodyContractFacts | null;
  /** What a production deployment must have built before it serves this pair. */
  readonly productionNeeds: readonly ProductionNeed[];
}

/** Whether the pair `set` takes an order on a declaration made under `wordingVersion`: the version
 *  is the one of the pair's declaration. It says nothing else of the company. The order door and
 *  the company view read this rule here; the cap on a tenant's open declared companies applies it
 *  in its count (`countCustomerOpenByTenant`). */
export function declarationAccepted(set: LegalTextSet, wordingVersion: string): boolean {
  return wordingVersion === set.declaration.version;
}

/** The October agreement and the October statement: the pair a deployment serves when it names none. */
export function octoberLegalTexts(): LegalTextSet {
  return Object.freeze({
    agreement: Object.freeze({ kind: "plain", text: LEGAL_BODY_OPERATING_AGREEMENT }),
    declaration: STATEMENT_OF_AUTHORITY,
    contractFacts: null,
    productionNeeds: Object.freeze([]),
  });
}

/** Charter draft 5 with declaration draft 2. Selected only by its agreement's version, at start. */
export const CHARTER_LEGAL_TEXTS: LegalTextSet = Object.freeze({
  agreement: tagged(LEGAL_BODY_CHARTER_2026_11_DRAFT_5),
  declaration: DECLARATION_OF_AUTHORITY_2026_11_DRAFT_2,
  contractFacts: "fixed_copy_cancellable_dissolution",
  productionNeeds: Object.freeze([...PRODUCTION_NEEDS]),
});

/**
 * The pairs a deployment can name, by their agreement's version, in the list's order. A later pair
 * is one more entry.
 */
const PAIR_OF_VERSION: ReadonlyMap<string, () => LegalTextSet> = new Map<
  string,
  () => LegalTextSet
>([
  ["2026-10-draft-1", octoberLegalTexts],
  ["2026-11-draft-5", () => CHARTER_LEGAL_TEXTS],
]);

/** The agreement versions a deployment can name, in the list's order. */
export const SELECTABLE_AGREEMENT_VERSIONS: readonly string[] = Object.freeze([
  ...PAIR_OF_VERSION.keys(),
]);

/** The pair a deployment serves: the one whose agreement has this version; the October pair when
 *  no version is named. Throws for any other name. */
export function legalTextsOf(version: string | undefined): LegalTextSet {
  if (version === undefined) return octoberLegalTexts();
  const pair = PAIR_OF_VERSION.get(version);
  if (pair === undefined)
    throw new Error(
      `Invalid config: LEGAL_BODY_AGREEMENT_VERSION must be one of: ${SELECTABLE_AGREEMENT_VERSIONS.join(", ")}`,
    );
  return pair();
}

/** Throws unless `environment` may serve `set`: a production deployment needs every one of the
 *  pair's production needs built. */
export function assertProductionNeedsBuilt(
  set: LegalTextSet,
  environment: "sandbox" | "production",
  built: ReadonlySet<ProductionNeed>,
): void {
  if (environment !== "production") return;
  const missing = set.productionNeeds.filter((need) => !built.has(need));
  if (missing.length === 0) return;
  throw new Error(
    `Invalid config: LEGAL_BODY_AGREEMENT_VERSION ${set.agreement.text.version} cannot be served on a production deployment yet. Not built: ${missing.map((need) => PHRASE_OF_NEED[need]).join("; ")}`,
  );
}

/** Throws when `set` states facts of the legal body's contract and the deployment names no
 *  legal-body factory: there is nothing to prove them against, so the pair is not served. */
export function assertContractFactsProvable(set: LegalTextSet, factory: string | undefined): void {
  if (set.contractFacts === null || factory !== undefined) return;
  throw new Error(
    `Invalid config: LEGAL_BODY_AGREEMENT_VERSION ${set.agreement.text.version} needs LEGAL_BODY_FACTORY_ADDRESS: what this version says of the legal body's contract is proved against that factory at start`,
  );
}

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
