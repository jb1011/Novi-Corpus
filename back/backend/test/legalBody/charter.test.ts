import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { expect, test } from "vitest";
import { CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1 } from "../../src/legalBody/texts/adoptionStatement";
import {
  type CharterFields,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_1,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_2,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_4,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_5,
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

const CHARTERS = [
  LEGAL_BODY_CHARTER_2026_11_DRAFT_1,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_2,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_4,
  LEGAL_BODY_CHARTER_2026_11_DRAFT_5,
];
const WITH = { ...FIELDS, scheduleA: "No grant is in force." };

const PINS = {
  "2026-11-draft-1": "f869917a35368abee55855d15291059efd1fea95c6edee110524c6face3c6d2c",
  "2026-11-draft-2": "acf6cb2415cba17874d3c7505b7289d66dfd9148e6d584783035fad912a2a0b8",
  "2026-11-draft-4": "2bc1eb1c387ef9ac7e2d9ad3bae6365ab7c01fce6d30afd29c562f8382ef9ca6",
  "2026-11-draft-5": "763f52ac1447c7f9f796140586840233d6ef104316360e86545fd3e339e68cfb",
} as const;

test("each version of the Charter is a draft of the agreement text under its own name, and none is the served one", () => {
  expect(LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS.slice(-4)).toEqual(CHARTERS);
  for (const text of CHARTERS) {
    expect(text.id).toBe("legal-body-operating-agreement");
    expect(text.status).toBe("draft");
    expect(sha256(text.template)).toBe(PINS[text.version as keyof typeof PINS]);
  }
  expect(CHARTERS.map((t) => t.version)).toEqual(Object.keys(PINS));
  expect(LEGAL_BODY_OPERATING_AGREEMENT.version).toBe("2026-10-draft-1");
});

test.each([
  ["2026-11-draft-4", LEGAL_BODY_CHARTER_2026_11_DRAFT_4],
  ["2026-11-draft-5", LEGAL_BODY_CHARTER_2026_11_DRAFT_5],
] as const)("a version that states a notice states it on its sixth line: %s", (_version, text) => {
  expect(text.template.split("\n")[5]).toBe(
    "Notice: this document is a fixed form. It is not a substitute for the advice of an attorney. Novi Corpus is not a law firm and does not give legal advice (section 12).",
  );
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
  const after = LEGAL_BODY_CHARTER_2026_11_DRAFT_2.template.split("\n");
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
  const doc = LEGAL_BODY_CHARTER_2026_11_DRAFT_5.render(WITH);
  expect(doc).toContain(
    "## Schedule A. Grants in force\n\nNo grant is in force.\n\n## Schedule B.",
  );
  expect(doc).toContain('# Legal Body Charter of "Example Holdings LLC"');
  expect(doc).not.toMatch(/\{[A-Za-z]/);
  const smuggled = LEGAL_BODY_CHARTER_2026_11_DRAFT_5.render({ ...WITH, scheduleA: "{guardian}" });
  expect(smuggled).toContain("## Schedule A. Grants in force\n\n{guardian}\n");
});

test("a Charter without its Schedule A is refused, never rendered", () => {
  expect(() => LEGAL_BODY_CHARTER_2026_11_DRAFT_5.render(FIELDS as CharterFields)).toThrow(
    'legal text "legal-body-operating-agreement": placeholder {scheduleA} has no string field',
  );
});

test("the sentence of adoption is one line of plain text, with no field", () => {
  const s = CHARTER_ADOPTION_STATEMENT_2026_11_DRAFT_1;
  expect(sha256(s)).toBe("2784f8deea2e2722532d7478b5d032a9740a76868b1a3d7f40fcfafeceb6dc23");
  expect(s).toHaveLength(483);
  expect(s).toMatch(/^[\x20-\x7e]+$/);
  expect(s).not.toMatch(/[{}]/);
  expect(
    s.startsWith(
      "I control the wallet this message names as guardian, and I am the only member of the Company",
    ),
  ).toBe(true);
  expect(s.endsWith("I confirm each point of its section 13.")).toBe(true);
});
