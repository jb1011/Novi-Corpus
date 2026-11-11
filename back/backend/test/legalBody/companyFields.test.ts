/**
 * The sandbox stand-in filing number (design 2026-11-11 §2): what doola's sandbox, which files a
 * company with no filing number, leaves a formed legal-body company holding instead. The two
 * doola ids are inventions: one of the shape doola's ids take (27 characters, mixed-case base62),
 * and the fake doola's first.
 */
import { describe, expect, test } from "vitest";
import {
  FILING_NUMBER,
  SANDBOX_STAND_IN_PREFIX,
  isStandInFilingNumber,
  passesAsItStands,
  sandboxStandInFilingNumber,
} from "../../src/legalBody/companyFields";

/** The declared door's sandbox filing-number pattern (`SANDBOX_FILING_NUMBER` in
 *  `customerCompany.ts`), written out: a stand-in must be a number that door would take. */
const DECLARED_SANDBOX_PATTERN = /^TEST-[0-9A-Z-]{4,27}$/;

describe("sandboxStandInFilingNumber", () => {
  test.each([
    ["3TestStandInExampleId00Ab9z", "TEST-STANDIN-5525A03409A191C3"],
    ["cmp-1", "TEST-STANDIN-D36A9A6177333DB7"],
  ])("%s gives %s", (doolaCompanyId, expected) => {
    expect(sandboxStandInFilingNumber(doolaCompanyId)).toBe(expected);
  });

  test("is the prefix and 16 upper-case hex characters: 29 characters in all", () => {
    const value = sandboxStandInFilingNumber("cmp-1");
    expect(SANDBOX_STAND_IN_PREFIX).toBe("TEST-STANDIN-");
    expect(value.startsWith(SANDBOX_STAND_IN_PREFIX)).toBe(true);
    expect(value.slice(SANDBOX_STAND_IN_PREFIX.length)).toMatch(/^[0-9A-F]{16}$/);
    expect(value).toHaveLength(29);
  });

  test("passes both rules as it stands: the agreement's filing-number rule and the declared door's sandbox pattern", () => {
    for (const id of ["3TestStandInExampleId00Ab9z", "cmp-1", "cmp-2"]) {
      const value = sandboxStandInFilingNumber(id);
      expect(passesAsItStands(value, FILING_NUMBER), id).toBe(true);
      expect(value, id).toMatch(DECLARED_SANDBOX_PATTERN);
    }
  });

  test("is deterministic, and two ids give two numbers", () => {
    expect(sandboxStandInFilingNumber("cmp-1")).toBe(sandboxStandInFilingNumber("cmp-1"));
    expect(sandboxStandInFilingNumber("cmp-1")).not.toBe(sandboxStandInFilingNumber("cmp-2"));
    // Case matters in doola's ids, and survives the hash.
    expect(sandboxStandInFilingNumber("cmp-A")).not.toBe(sandboxStandInFilingNumber("cmp-a"));
  });

  test("can never pass for a Wyoming filing id", () => {
    expect(sandboxStandInFilingNumber("cmp-1")).not.toMatch(/^\d{4}-\d{9}$/);
  });
});

describe("isStandInFilingNumber: the stand-in space, on the filing key", () => {
  test.each([
    sandboxStandInFilingNumber("cmp-1"),
    "TEST-STANDIN-0001",
    // The two dodges of a raw-string prefix: a hyphen added, and one dropped.
    "TEST-STAND-IN-0001",
    "TEST-STANDIND36A9A6177333DB7",
    "test-standin-0001",
    "TESTSTANDIN0001",
  ])("%s is in it", (number) => {
    expect(isStandInFilingNumber(number)).toBe(true);
  });

  test.each(["TEST-0001", "TEST-STAND-0001", "TEST-STANDARD-01", "2026-001234567", "STANDIN-0001"])(
    "%s is not",
    (number) => {
      expect(isStandInFilingNumber(number)).toBe(false);
    },
  );
});
