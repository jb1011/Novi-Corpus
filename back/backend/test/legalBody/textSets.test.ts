import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { assertDraftsServable } from "../../src/legalBody/draftTextRefusal";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import {
  CHARTER_ADOPTION_RULE_2026_11_DRAFT_1,
  CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1,
} from "../../src/legalBody/texts/adoptionStatement";
import { LEGAL_BODY_CHARTER_2026_11_DRAFT_5 } from "../../src/legalBody/texts/legalBodyCharter";
import {
  LEGAL_BODY_OPERATING_AGREEMENT,
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS,
} from "../../src/legalBody/texts/operatingAgreement";
import {
  AGREEMENT_TEXTS,
  type AgreementText,
  CHARTER_LEGAL_TEXTS,
  PRODUCTION_NEEDS,
  PRODUCTION_NEEDS_BUILT,
  type ProductionNeed,
  SELECTABLE_AGREEMENT_VERSIONS,
  adoptionRuleOfVersion,
  adoptionStatementOfVersion,
  agreementTextOfVersion,
  assertProductionNeedsBuilt,
  assertSetUsable,
  legalTextsOf,
  octoberLegalTexts,
} from "../../src/legalBody/texts/sets";
import { STATEMENT_OF_AUTHORITY } from "../../src/legalBody/texts/statementOfAuthority";

const SRC = join(import.meta.dirname, "..", "..", "src");

/** Every `.ts` file under `dir`, relative to `src`. */
function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return name.endsWith(".ts") ? [relative(SRC, path).split("\\").join("/")] : [];
  });
}

test("every version of the agreement is tagged, in the list's own order", () => {
  expect(AGREEMENT_TEXTS.map((t) => t.text)).toEqual([...LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS]);
  expect(
    AGREEMENT_TEXTS.map((t) => [
      t.text.version,
      t.kind,
      t.kind === "charter" ? t.scheduleAWording : undefined,
      t.kind === "charter" ? t.adoptionStatement : undefined,
    ]),
  ).toEqual([
    ["2026-10-draft-1", "plain", undefined, undefined],
    ["2026-11-draft-1", "charter", null, null],
    ["2026-11-draft-2", "charter", null, null],
    ["2026-11-draft-4", "charter", null, null],
    ["2026-11-draft-5", "charter", "2026-11-draft-4", CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1],
  ]);
  expect(agreementTextOfVersion("2026-11-draft-5")?.text).toBe(LEGAL_BODY_CHARTER_2026_11_DRAFT_5);
  expect(agreementTextOfVersion("2099-01-draft-1")).toBeUndefined();
});

test("the served pair is the October one, and the Charter is paired with declaration draft 2 by name", () => {
  const served = octoberLegalTexts();
  expect(served.agreement).toEqual({ kind: "plain", text: LEGAL_BODY_OPERATING_AGREEMENT });
  expect(served.declaration).toBe(STATEMENT_OF_AUTHORITY);
  expect(CHARTER_LEGAL_TEXTS.agreement.text.version).toBe("2026-11-draft-5");
  expect(CHARTER_LEGAL_TEXTS.declaration.version).toBe("2026-11-draft-2");
  expect(() => assertSetUsable(served)).not.toThrow();
  expect(() => assertSetUsable(CHARTER_LEGAL_TEXTS)).not.toThrow();
});

test("no order is placed on a Charter version that has no Schedule A wording", () => {
  const retired: [AgreementText, string][] = [
    [AGREEMENT_TEXTS[2] as AgreementText, "2026-11-draft-2"],
    [AGREEMENT_TEXTS[3] as AgreementText, "2026-11-draft-4"],
  ];
  for (const [agreement, version] of retired)
    expect(() =>
      assertSetUsable({
        agreement,
        declaration: STATEMENT_OF_AUTHORITY,
        contractFacts: null,
        productionNeeds: [],
      }),
    ).toThrow(
      new Error(
        `legal texts: version "${version}" of the agreement has no Schedule A wording this deployment writes`,
      ),
    );
});

test("a version's words of adoption are read by its name", () => {
  expect(adoptionStatementOfVersion("2026-11-draft-5")).toBe(
    CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1,
  );
  for (const version of [
    "2026-10-draft-1",
    "2026-11-draft-1",
    "2026-11-draft-2",
    "2026-11-draft-4",
    "2099-01-draft-1",
  ])
    expect(adoptionStatementOfVersion(version), version).toBeNull();
});

test("a version's rule of adoption is read by its name", () => {
  expect(adoptionRuleOfVersion("2026-11-draft-5")).toBe(CHARTER_ADOPTION_RULE_2026_11_DRAFT_1);
  for (const version of [
    "2026-10-draft-1",
    "2026-11-draft-1",
    "2026-11-draft-2",
    "2026-11-draft-4",
    "2099-01-draft-1",
  ])
    expect(adoptionRuleOfVersion(version), version).toBeNull();
});

test("the rule of adoption, whole", () => {
  expect(CHARTER_ADOPTION_RULE_2026_11_DRAFT_1).toBe(
    "The Legal Body Charter is adopted by a Guardian who signs that they are the only member of the company. A company with several members, or whose only member is not its Guardian, cannot adopt it yet.",
  );
  expect(CHARTER_ADOPTION_RULE_2026_11_DRAFT_1).toHaveLength(198);
  expect(CHARTER_ADOPTION_RULE_2026_11_DRAFT_1).toMatch(/^[\x20-\x7e]+$/);
});

test("no order is placed on a Charter version that has no words of adoption", () => {
  const charter = CHARTER_LEGAL_TEXTS.agreement;
  if (charter.kind !== "charter") throw new Error("the Charter pair holds a Charter");
  expect(() =>
    assertSetUsable({ ...CHARTER_LEGAL_TEXTS, agreement: { ...charter, adoptionStatement: null } }),
  ).toThrow(
    new Error('legal texts: version "2026-11-draft-5" of the agreement has no words of adoption'),
  );
});

test("a deployment that names no version serves the October pair", () => {
  expect(legalTextsOf(undefined)).toEqual(octoberLegalTexts());
  expect(legalTextsOf("2026-10-draft-1")).toEqual(octoberLegalTexts());
  expect(legalTextsOf("2026-11-draft-5")).toBe(CHARTER_LEGAL_TEXTS);
});

test("each selectable pair is found by its agreement's version, and can take an order", () => {
  expect(SELECTABLE_AGREEMENT_VERSIONS).toEqual(["2026-10-draft-1", "2026-11-draft-5"]);
  for (const version of SELECTABLE_AGREEMENT_VERSIONS) {
    const set = legalTextsOf(version);
    expect(set.agreement.text.version, version).toBe(version);
    expect(() => assertSetUsable(set), version).not.toThrow();
  }
});

test.each([
  [""],
  ["2026-11-draft-4"],
  ["2026-11-draft-2"],
  ["2026-11-DRAFT-5"],
  [" 2026-11-draft-5"],
  ["latest"],
])("a name that is not a selectable version refuses the start: %s", (name) => {
  expect(() => legalTextsOf(name)).toThrow(
    new Error(
      "Invalid config: LEGAL_BODY_AGREEMENT_VERSION must be one of: 2026-10-draft-1, 2026-11-draft-5",
    ),
  );
});

test("what each pair needs", () => {
  const october = octoberLegalTexts();
  expect(october.contractFacts).toBeNull();
  expect(october.productionNeeds).toEqual([]);
  expect(CHARTER_LEGAL_TEXTS.contractFacts).toBe("fixed_copy_cancellable_dissolution");
  expect(CHARTER_LEGAL_TEXTS.productionNeeds).toEqual([
    "presence_check_at_grant",
    "email_notice_at_grant",
    "guardian_notice_before_adoption",
    "guardian_residence_scope",
  ]);
  expect(CHARTER_LEGAL_TEXTS.productionNeeds).toEqual([...PRODUCTION_NEEDS]);
  expect(PRODUCTION_NEEDS_BUILT.size).toBe(0);
});

test("a production deployment serves the Charter only once every need is built", () => {
  expect(() => assertProductionNeedsBuilt(CHARTER_LEGAL_TEXTS, "production", new Set())).toThrow(
    new Error(
      "Invalid config: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served on a production deployment yet. Not built: the presence check before a grant is served for signature; the notice by email before a grant is served for signature; the Guardian's notice shown before the adoption; the check of where the Guardian lives",
    ),
  );
  const firstThree = new Set<ProductionNeed>([
    "presence_check_at_grant",
    "email_notice_at_grant",
    "guardian_notice_before_adoption",
  ]);
  expect(() => assertProductionNeedsBuilt(CHARTER_LEGAL_TEXTS, "production", firstThree)).toThrow(
    new Error(
      "Invalid config: LEGAL_BODY_AGREEMENT_VERSION 2026-11-draft-5 cannot be served on a production deployment yet. Not built: the check of where the Guardian lives",
    ),
  );
  const all = new Set<ProductionNeed>(PRODUCTION_NEEDS);
  expect(() => assertProductionNeedsBuilt(CHARTER_LEGAL_TEXTS, "production", all)).not.toThrow();
  expect(() => assertProductionNeedsBuilt(CHARTER_LEGAL_TEXTS, "sandbox", new Set())).not.toThrow();
  expect(() =>
    assertProductionNeedsBuilt(octoberLegalTexts(), "production", new Set()),
  ).not.toThrow();
});

test("the pair is chosen once, at start, by the setting", () => {
  const files = sourcesUnder(SRC);
  const naming = (name: string) =>
    files.filter((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(join(SRC, f), "utf8")));
  expect(naming("CHARTER_LEGAL_TEXTS")).toEqual(["legalBody/texts/sets.ts"]);
  expect(naming("legalTextsOf").sort()).toEqual(["api/main.ts", "legalBody/texts/sets.ts"]);
  expect(naming("octoberLegalTexts")).toEqual(["legalBody/texts/sets.ts"]);
  expect(naming("assertLegalBodyContractFacts").sort()).toEqual([
    "adapters/arc/bootVerify.ts",
    "api/main.ts",
  ]);
  expect(naming("assertProductionNeedsBuilt").sort()).toEqual([
    "api/main.ts",
    "legalBody/texts/sets.ts",
  ]);
  expect(naming("legalBodyAgreementVersion").sort()).toEqual(["api/main.ts", "config/env.ts"]);
  expect(naming("LEGAL_BODY_OPERATING_AGREEMENT").sort()).toEqual([
    "legalBody/texts/operatingAgreement.ts",
    "legalBody/texts/sets.ts",
  ]);
  expect(naming("STATEMENT_OF_AUTHORITY").sort()).toEqual([
    "legalBody/texts/sets.ts",
    "legalBody/texts/statementOfAuthority.ts",
  ]);
  expect(naming("LEGAL_BODY_CHARTER_2026_11_DRAFT_5").sort()).toEqual([
    "legalBody/texts/legalBodyCharter.ts",
    "legalBody/texts/operatingAgreement.ts",
    "legalBody/texts/sets.ts",
  ]);
  expect(naming("DECLARATION_OF_AUTHORITY_2026_11_DRAFT_2").sort()).toEqual([
    "legalBody/texts/sets.ts",
    "legalBody/texts/statementOfAuthority.ts",
  ]);
  expect(naming("CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1").sort()).toEqual([
    "legalBody/texts/adoptionStatement.ts",
    "legalBody/texts/sets.ts",
  ]);
  expect(naming("CHARTER_ADOPTION_RULE_2026_11_DRAFT_1").sort()).toEqual([
    "legalBody/texts/adoptionStatement.ts",
    "legalBody/texts/sets.ts",
  ]);
});

test("a draft text is one refusal, through one helper", () => {
  const draft = STATEMENT_OF_AUTHORITY; // a draft
  expect(() => assertDraftsServable("sandbox", [draft])).not.toThrow();
  expect(() => assertDraftsServable("production", [draft])).toThrow(
    expect.objectContaining({
      code: "legal_text_not_approved",
      status: 503,
      message: LEGAL_BODY_SENTENCES.legal_text_not_approved,
    }),
  );
});
