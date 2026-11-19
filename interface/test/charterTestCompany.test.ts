/**
 * A company as the test page lists it: which companies are a Guardian's own declarations, and
 * `declared.wordingAccepted` shown as served, or said to be absent.
 */
import { describe, expect, test } from "vitest";
import type { CompanyView } from "@/lib/api/types";
import { isDeclaredCompany, wordingAcceptedShown } from "@/lib/charterTest/company";

const base: CompanyView = {
  companyId: "co_1",
  environment: "sandbox",
  nameOptions: [],
  legalNameFiled: null,
  businessPurpose: "",
  industryLabel: "",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: 1_800_000_000_000,
};
const declared = { companyName: "Local Test Holdings", filingNumber: "TEST-0001", wordingVersion: "2026-11-draft-2" };

/** A company view as it arrives, with keys the shared type does not name yet. */
const served = (over: Record<string, unknown>): CompanyView => ({ ...base, ...over }) as CompanyView;

describe("a Guardian's own declarations", () => {
  test("a customer's company, or any company with a declaration", () => {
    expect(isDeclaredCompany(served({ provider: "customer", declared }))).toBe(true);
    expect(isDeclaredCompany(served({ provider: "customer", declared: null }))).toBe(true);
    expect(isDeclaredCompany(served({ declared }))).toBe(true);
  });

  test("a company from another source, or one from before the key, is not", () => {
    expect(isDeclaredCompany(served({ provider: "formation" }))).toBe(false);
    expect(isDeclaredCompany(served({ provider: "formation", declared: null }))).toBe(false);
    expect(isDeclaredCompany(base)).toBe(false);
  });
});

describe("declared.wordingAccepted, as shown", () => {
  test.each([
    [true, "true"],
    [false, "false"],
    [null, "null"],
    ["true", "unreadable"],
    [1, "unreadable"],
    [undefined, "unreadable"],
  ])("served %j is shown %s", (value, shown) => {
    expect(wordingAcceptedShown(served({ declared: { ...declared, wordingAccepted: value } }))).toBe(shown);
  });

  test("a backend that does not serve the key", () => {
    expect(wordingAcceptedShown(served({ declared }))).toBe("not served");
  });

  test("a company with no declaration to read", () => {
    expect(wordingAcceptedShown(served({ declared: null }))).toBe("no declaration");
    expect(wordingAcceptedShown(base)).toBe("no declaration");
  });
});
