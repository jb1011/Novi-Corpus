import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { expect, test } from "vitest";
import {
  type CharterFields,
  LEGAL_BODY_CHARTER,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_1,
} from "../../src/legalBody/texts/legalBodyCharter";
import {
  type AgreementFields,
  LEGAL_BODY_OPERATING_AGREEMENT,
  LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS,
} from "../../src/legalBody/texts/operatingAgreement";

/** Invented company values, and addresses derived from anvil's published test keys only. */
const GUARDIAN = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FACTORY = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const REGISTRY = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");

const FIELDS: AgreementFields = {
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  jurisdiction: "WY",
  guardian: GUARDIAN,
  amendmentDelaySeconds: 172_800,
  chainId: 31_337,
  factory: FACTORY,
  identityRegistry: REGISTRY,
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const CHARTER_SHA256 = "acf6cb2415cba17874d3c7505b7289d66dfd9148e6d584783035fad912a2a0b8";
const CHARTER_DRAFT_1_SHA256 = "f869917a35368abee55855d15291059efd1fea95c6edee110524c6face3c6d2c";
const CHARTERS = [LEGAL_BODY_CHARTER_2026_11_DRAFT_1, LEGAL_BODY_CHARTER];
const WITH = { ...FIELDS, scheduleA: "No grant is in force." };

test("the Charter is a draft version of the agreement text, and is not the served one", () => {
  expect(LEGAL_BODY_CHARTER.id).toBe("legal-body-operating-agreement");
  expect(LEGAL_BODY_CHARTER.version).toBe("2026-11-draft-2");
  expect(LEGAL_BODY_CHARTER.status).toBe("draft");
  expect(sha256(LEGAL_BODY_CHARTER.template)).toBe(CHARTER_SHA256);
  expect(LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.at(-1)).toBe(LEGAL_BODY_CHARTER);
  // Draft 1 stays listed just before it, unchanged.
  expect(LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.at(-2)).toBe(LEGAL_BODY_CHARTER_2026_11_DRAFT_1);
  expect(LEGAL_BODY_CHARTER_2026_11_DRAFT_1.id).toBe("legal-body-operating-agreement");
  expect(LEGAL_BODY_CHARTER_2026_11_DRAFT_1.version).toBe("2026-11-draft-1");
  expect(LEGAL_BODY_CHARTER_2026_11_DRAFT_1.status).toBe("draft");
  expect(sha256(LEGAL_BODY_CHARTER_2026_11_DRAFT_1.template)).toBe(CHARTER_DRAFT_1_SHA256);
  expect(LEGAL_BODY_OPERATING_AGREEMENT.version).toBe("2026-10-draft-1");
});

test("in each version, its placeholders are the five of the agreement and scheduleA, and nothing else", () => {
  for (const charter of CHARTERS) {
    const names = new Set(
      [...charter.template.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]),
    );
    expect([...names].sort()).toEqual([
      "companyName",
      "factory",
      "filingNumber",
      "guardian",
      "identityRegistry",
      "scheduleA",
    ]);
    // No brace outside a placeholder, ASCII only, one trailing newline.
    expect(charter.template.replace(/\{[A-Za-z][A-Za-z0-9]*\}/g, "")).not.toMatch(/[{}]/);
    expect(charter.template).toMatch(/^[\n\x20-\x7e]+$/);
    expect(charter.template.endsWith(".\n")).toBe(true);
    expect(charter.template.endsWith("\n\n")).toBe(false);
  }
});

test("draft 2 of the Charter differs from draft 1 in two lines", () => {
  const before = LEGAL_BODY_CHARTER_2026_11_DRAFT_1.template.split("\n");
  const after = LEGAL_BODY_CHARTER.template.split("\n");
  expect(after.length).toBe(before.length);
  const changed = before.flatMap((line, i) => (line === after[i] ? [] : [[line, after[i]]]));
  // The third paragraph of section 4, then 5.1: in each pair, both lines keep the opening words.
  const section4 = expect.stringMatching(/^The wallet recorded for the Agent Identity/);
  const section51 = expect.stringMatching(/^5\.1 /);
  expect(changed).toEqual([
    [section4, section4],
    [section51, section51],
  ]);
});

test("Schedule A is rendered in its place, and a value is never read as a placeholder", () => {
  const doc = LEGAL_BODY_CHARTER.render(WITH);
  expect(doc).toContain(
    "## Schedule A. Grants in force\n\nNo grant is in force.\n\n## Schedule B.",
  );
  expect(doc).toContain('# Legal Body Charter of "Example Holdings LLC"');
  expect(doc).not.toMatch(/\{[A-Za-z]/);
  const smuggled = LEGAL_BODY_CHARTER.render({ ...WITH, scheduleA: "{guardian}" });
  expect(smuggled).toContain("## Schedule A. Grants in force\n\n{guardian}\n");
});

test("a Charter without its Schedule A is refused, never rendered", () => {
  expect(() => LEGAL_BODY_CHARTER.render(FIELDS as CharterFields)).toThrow(
    'legal text "legal-body-operating-agreement": placeholder {scheduleA} has no string field',
  );
});
