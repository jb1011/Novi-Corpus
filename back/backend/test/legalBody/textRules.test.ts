/**
 * The field rules a declaration and the name of record share, in their own module: the declared
 * door (`customerCompany.ts`) and the name of record (`identity/names.ts`) both read them from
 * `textRules.ts`, which imports neither, so the two no longer import each other.
 *
 * Every name here is a made-up fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DECLARANT_NAME, type FieldProblem, applyTextRule } from "../../src/legalBody/textRules";

const src = join(import.meta.dirname, "..", "..", "src");
/** The modules a source file imports from, as written. */
const importsOf = (...path: string[]): string[] =>
  [...readFileSync(join(src, ...path), "utf8").matchAll(/^import[^;]*? from "([^"]+)";/gms)].map(
    (m) => m[1] as string,
  );

test("the name of record and the declared door take the rule from textRules.ts, which imports neither: no import cycle", () => {
  expect(importsOf("identity", "names.ts")).toContain("../legalBody/textRules");
  expect(importsOf("identity", "names.ts")).not.toContain("../legalBody/customerCompany");
  expect(importsOf("legalBody", "customerCompany.ts")).toContain("./textRules");
  expect(importsOf("legalBody", "textRules.ts")).toEqual([]);
});

test("applyTextRule normalises the spaces of a declarant name, and records a refusal by its rule, never its value", () => {
  const problems: FieldProblem[] = [];
  expect(applyTextRule("declarantName", "  Jean   Dupont ", DECLARANT_NAME, problems)).toBe(
    "Jean Dupont",
  );
  expect(problems).toEqual([]);

  expect(applyTextRule("declarantName", "Jean\tDupont", DECLARANT_NAME, problems)).toBeUndefined();
  expect(applyTextRule("declarantName", "Jean Dupont 2", DECLARANT_NAME, problems)).toBeUndefined();
  expect(applyTextRule("declarantName", undefined, DECLARANT_NAME, problems)).toBeUndefined();
  expect(problems).toEqual([
    { field: "declarantName", problem: "holds a control or invisible character" },
    {
      field: "declarantName",
      problem: "may hold only letters, spaces, apostrophes, hyphens and full stops",
    },
    { field: "declarantName", problem: "is required" },
  ]);
});
