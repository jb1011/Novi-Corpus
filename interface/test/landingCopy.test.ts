/**
 * The home page's words, read as data.
 *
 * Every string `landing/copy.ts` exports is walked, through its arrays and objects, and none may
 * carry an em dash, the treasury, spending or "our agents": the home page leads with the legal
 * body, and the treasury is the full product's, named only on its own card. Numbers are not
 * words: `ONBOARDING_STEP_COUNT` stays, for the full product's card and the wizard's own test.
 */
import { describe, expect, test } from "vitest";
import * as copy from "@/components/landing/copy";

/** Every string under a value, with the path it was found at. */
function strings(value: unknown, path: string): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  }
  return [];
}

const found = Object.entries(copy).flatMap(([name, value]) => strings(value, name));

describe("the landing copy", () => {
  test("the walk reads the copy, not nothing", () => {
    const paths = found.map((s) => s.path);
    expect(paths).toContain("HERO_SUB");
    expect(paths).toContain("CLOSING_CHIPS[2]");
    expect(paths).toContain("STATS[3].detail");
    expect(found.length).toBeGreaterThan(20);
  });

  test.each(["—", "treasury", "spending", "our agents"])("no string says %j", (word) => {
    const offending = found.filter((s) => s.text.toLowerCase().includes(word)).map((s) => s.path);
    expect(offending).toEqual([]);
  });

  test("the hero title reads as one sentence", () => {
    expect(copy.HERO_TITLE.join(" ")).toBe("A legal body for your agent.");
  });

  test("the hero keeps the Wyoming DAO LLC", () => {
    expect(copy.HERO_SUB).toContain("Wyoming DAO LLC");
  });

  test("the step count stays, a number", () => {
    expect(typeof copy.ONBOARDING_STEP_COUNT).toBe("number");
  });

  test("the full product's buttons are gone", () => {
    for (const name of ["CREATE_COMPANY_CTA", "ONBOARDING_STEPS_HEADING", "SEE_THE_STEPS_CTA"]) {
      expect(Object.keys(copy)).not.toContain(name);
    }
  });
});
