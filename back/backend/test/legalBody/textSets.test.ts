import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { assertDraftsServable } from "../../src/legalBody/draftTextRefusal";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1 } from "../../src/legalBody/texts/adoptionStatement";
import { LEGAL_BODY_CHARTER_2026_11_DRAFT_5 } from "../../src/legalBody/texts/legalBodyCharter";
import {
  LEGAL_BODY_OPERATING_AGREEMENT,
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS,
} from "../../src/legalBody/texts/operatingAgreement";
import {
  AGREEMENT_TEXTS,
  type AgreementText,
  CHARTER_LEGAL_TEXTS,
  adoptionStatementOfVersion,
  agreementTextOfVersion,
  assertSetUsable,
  servedLegalTexts,
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
  const served = servedLegalTexts();
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
    expect(() => assertSetUsable({ agreement, declaration: STATEMENT_OF_AUTHORITY })).toThrow(
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

test("no order is placed on a Charter version that has no words of adoption", () => {
  const charter = CHARTER_LEGAL_TEXTS.agreement;
  if (charter.kind !== "charter") throw new Error("the Charter pair holds a Charter");
  expect(() =>
    assertSetUsable({ ...CHARTER_LEGAL_TEXTS, agreement: { ...charter, adoptionStatement: null } }),
  ).toThrow(
    new Error('legal texts: version "2026-11-draft-5" of the agreement has no words of adoption'),
  );
});

test("nothing in src selects the Charter pair, and the doors read the pair they are given", () => {
  const files = sourcesUnder(SRC);
  const naming = (name: string) =>
    files.filter((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(join(SRC, f), "utf8")));
  expect(naming("CHARTER_LEGAL_TEXTS")).toEqual(["legalBody/texts/sets.ts"]);
  expect(naming("LEGAL_BODY_OPERATING_AGREEMENT").sort()).toEqual([
    "api/app.ts",
    "formation/company.ts",
    "legalBody/texts/operatingAgreement.ts",
    "legalBody/texts/sets.ts",
  ]);
  expect(naming("STATEMENT_OF_AUTHORITY").sort()).toEqual([
    "api/app.ts",
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
