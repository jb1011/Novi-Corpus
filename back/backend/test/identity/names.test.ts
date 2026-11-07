/**
 * The name of record: how a printed name becomes the name the identity record stores, and the
 * rule that name must pass before the record can be verified without review.
 *
 * Every name here is a made-up fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  IDENTITY_AAD,
  composeDeclarantName,
  nameOfRecord,
  nameRuleProblem,
} from "../../src/identity/names";

test("an all-capitals field is title-cased, word by word", () => {
  expect(nameOfRecord("DUPONT")).toBe("Dupont");
  expect(nameOfRecord("DE LA FUENTE")).toBe("De La Fuente");
});

test("title-casing keeps diacritics", () => {
  expect(nameOfRecord("ÉLODIE")).toBe("Élodie");
});

test("one spelling per name: a decomposed input (NFD) comes out composed (NFC), recased or not", () => {
  const decomposedCapitals = "E\u0301LODIE";
  const decomposed = "E\u0301lodie";
  expect(decomposed).not.toBe(decomposed.normalize("NFC"));

  expect(nameOfRecord(decomposedCapitals)).toBe("\u00C9lodie");
  expect(nameOfRecord(decomposed)).toBe("\u00C9lodie");
  expect(nameOfRecord("  MU\u0308LLER ")).toBe("M\u00FCller");
});

test("one spelling per name: the recased result is composed (NFC) too, and a name of record is its own name of record", () => {
  // Lower-casing a dotted capital I gives "i" and a combining dot, which title-casing leaves
  // decomposed; a J with a caron has no capital composed form but a lower-case one.
  const dotted = nameOfRecord("\u0130LKER");
  expect(dotted).toBe("\u0130lker");
  expect(dotted).toBe(dotted.normalize("NFC"));
  const caron = nameOfRecord("AJ\u030CA");
  expect(caron).toBe("A\u01F0a");
  expect(caron).toBe(caron.normalize("NFC"));

  for (const printed of ["\u0130LKER", "\u00C9LODIE", "O'BRIEN", "DE LA FUENTE", "AJ\u030CA"]) {
    const once = nameOfRecord(printed);
    expect(nameOfRecord(once), printed).toBe(once);
  }
});

test("title-casing starts a new word after a hyphen and after an apostrophe", () => {
  expect(nameOfRecord("JEAN-PIERRE")).toBe("Jean-Pierre");
  expect(nameOfRecord("O'BRIEN")).toBe("O'Brien");
});

test("title-casing starts a new word after a full stop: initials printed in capitals stay initials", () => {
  expect(nameOfRecord("J.R.")).toBe("J.R.");
  expect(nameOfRecord("J.R. DUPONT")).toBe("J.R. Dupont");
});

test("title-casing reads no locale: the plain case forms, never the locale ones that follow the box's settings", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "identity", "names.ts"),
    "utf8",
  );
  expect(source).not.toMatch(/\.toLocale(Upper|Lower)Case\(/);
});

test("title-casing works outside Latin script, final sigma included", () => {
  expect(nameOfRecord("ΠΑΠΑΔΟΠΟΥΛΟΣ")).toBe("Παπαδοπουλος");
});

test("a mixed-case field is left as printed", () => {
  expect(nameOfRecord("McAllister")).toBe("McAllister");
});

test("spaces are trimmed at the ends and collapsed inside", () => {
  expect(nameOfRecord("  Ana   María ")).toBe("Ana María");
});

test("a field with no letters is not title-cased", () => {
  expect(nameOfRecord("  -  ")).toBe("-");
});

test("the declarant name is the first name, a space, the last name", () => {
  expect(composeDeclarantName("Jean", "Dupont")).toBe("Jean Dupont");
});

test("a Latin name passes the rule", () => {
  expect(nameRuleProblem("Jean", "Dupont")).toBeNull();
});

test("Latin with diacritics, apostrophes and spaces passes the rule", () => {
  expect(nameRuleProblem("Élodie", "O'Brien")).toBeNull();
  expect(nameRuleProblem("Ana María", "De La Fuente")).toBeNull();
});

test("a name in Han script fails the rule", () => {
  expect(typeof nameRuleProblem("王", "伟")).toBe("string");
});

test("a name in Greek script fails the rule", () => {
  expect(typeof nameRuleProblem("Γιώργος", "Παπαδοπουλος")).toBe("string");
});

test("the declarant rule still applies: a character it refuses fails", () => {
  expect(typeof nameRuleProblem("Jean", "Dupont3")).toBe("string");
  expect(typeof nameRuleProblem("Jean", 'Du"pont')).toBe("string");
});

test("an empty first or last name fails the rule, so a record without one lands in review", () => {
  expect(typeof nameRuleProblem("", "Dupont")).toBe("string");
  expect(typeof nameRuleProblem("Jean", "")).toBe("string");
  expect(typeof nameRuleProblem(nameOfRecord("   "), "Dupont")).toBe("string");
});

test("the AAD binds the tenant id and the field", () => {
  expect(IDENTITY_AAD("0xAbC", "first")).toBe("identity|0xAbC|first");
  expect(IDENTITY_AAD("0xAbC", "full")).toBe("identity|0xAbC|full");
});
