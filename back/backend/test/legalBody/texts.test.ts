import { createHash } from "node:crypto";
import type { Address } from "viem";
import { expect, test } from "vitest";
import { buildStatementMessage } from "../../src/legalBody/statement";
import { LegalTextNotApprovedError, assertTextsServable } from "../../src/legalBody/texts/index";
import {
  DECLARATION_OF_AUTHORITY,
  STATEMENT_OF_AUTHORITY,
  STATEMENT_OF_AUTHORITY_VERSIONS,
  type StatementFields,
} from "../../src/legalBody/texts/statementOfAuthority";

/** Invented values only: no real person, company, filing number or wallet. */
const GUARDIAN = "0x00000000000000000000000000000000000A11cE" as Address;
const FIELDS: StatementFields = {
  declarantName: "Ada Example",
  declarantTitle: "Manager",
  companyName: "Example Holdings LLC",
  jurisdiction: "WY",
  filingNumber: "TEST-0001",
  guardian: GUARDIAN,
};

/**
 * The sha256 of every version's template. A changed sentence is a NEW version: add its line here
 * and its entry at the end of STATEMENT_OF_AUTHORITY_VERSIONS. Never change or remove a line that
 * exists: a stored declaration names the version it was made under.
 */
const TEMPLATE_SHA256_BY_VERSION: Readonly<Record<string, string>> = {
  "2026-10-draft-1": "d52f3f7c91511c81462707c28c35976e1cd8b59f9fda863d342eb39fc48e8075",
  "2026-11-draft-1": "ac384bae187ac5a347e361617a1c2f5933bea85ee4d611031d50ed294559ce48",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

test("the statement of authority is a draft under its own id", () => {
  expect(STATEMENT_OF_AUTHORITY.id).toBe("statement-of-authority");
  expect(STATEMENT_OF_AUTHORITY.version).toBe("2026-10-draft-1");
  expect(STATEMENT_OF_AUTHORITY.status).toBe("draft");
});

test("render puts each field in its place, between quotes", () => {
  expect(STATEMENT_OF_AUTHORITY.render(FIELDS)).toBe(
    'I, "Ada Example", "Manager" of "Example Holdings LLC", a Wyoming limited liability company with filing number "TEST-0001", declare that I am authorised to bind that company, and that the wallet 0x00000000000000000000000000000000000A11cE acts as its guardian for this legal body.',
  );
});

test("render never trims or changes a field, and a `$` in a field is plain text", () => {
  const rendered = STATEMENT_OF_AUTHORITY.render({
    ...FIELDS,
    declarantName: "  Ada   Example  ",
    declarantTitle: "$& and $1 and $$",
  });
  expect(
    rendered.startsWith('I, "  Ada   Example  ", "$& and $1 and $$" of "Example Holdings'),
  ).toBe(true);
});

test("a field that holds a placeholder is not substituted again", () => {
  const rendered = STATEMENT_OF_AUTHORITY.render({
    ...FIELDS,
    companyName: "{guardian}",
    declarantName: "{declarantTitle}",
  });
  expect(rendered).toContain('I, "{declarantTitle}", "Manager" of "{guardian}", a Wyoming');
  // The wallet appears once: in its own place, not where the company name holds its placeholder.
  expect(rendered.split(GUARDIAN)).toHaveLength(2);
  expect(rendered).toContain(`the wallet ${GUARDIAN} acts as its guardian`);
});

test("a placeholder with no field is refused, never rendered as undefined", () => {
  const { filingNumber: _drop, ...missing } = FIELDS;
  expect(() => STATEMENT_OF_AUTHORITY.render(missing as unknown as StatementFields)).toThrow(
    /\{filingNumber\}/,
  );
});

test("each version's template is pinned by its sha256, and no version leaves the module", () => {
  for (const text of STATEMENT_OF_AUTHORITY_VERSIONS) {
    expect(text.id).toBe("statement-of-authority");
    expect(
      sha256(text.template),
      `The template of version "${text.version}" changed. A changed sentence is a new version: restore this one, add the new sentence as a new entry at the end of STATEMENT_OF_AUTHORITY_VERSIONS, and pin its hash in TEMPLATE_SHA256_BY_VERSION.`,
    ).toBe(TEMPLATE_SHA256_BY_VERSION[text.version]);
  }
  // Every pinned version is still in the module, in order, and none is listed twice.
  expect(STATEMENT_OF_AUTHORITY_VERSIONS.map((t) => t.version)).toEqual(
    Object.keys(TEMPLATE_SHA256_BY_VERSION),
  );
  // The served version is one of the listed versions; which one a deployment serves is not this list's order.
  expect(STATEMENT_OF_AUTHORITY_VERSIONS).toContain(STATEMENT_OF_AUTHORITY);
  expect(STATEMENT_OF_AUTHORITY_VERSIONS.at(-1)).toBe(DECLARATION_OF_AUTHORITY);
});

test("the declaration of authority renders its one sentence, each field between quotes", () => {
  expect(DECLARATION_OF_AUTHORITY.version).toBe("2026-11-draft-1");
  expect(DECLARATION_OF_AUTHORITY.status).toBe("draft");
  expect(DECLARATION_OF_AUTHORITY.render(FIELDS)).toBe(
    'I, "Ada Example", "Manager" of "Example Holdings LLC" (the "Company"), a Wyoming limited liability company with filing number "TEST-0001", declare to NoviCorpus, Inc. ("Novi Corpus") that: (1) I am authorised to bind the Company and to adopt, on its behalf, a supplement to its operating agreement; (2) I personally control the wallet 0x00000000000000000000000000000000000A11cE, and the Company designates it as its Guardian Wallet with Novi Corpus, authorised to adopt and amend, for the Company, a Legal Body Charter for each legal body recorded for the Company, including by granting, limiting or revoking the agent\'s authority under it, and to act for the Company as regards each such legal body; (3) the Company consents to Novi Corpus publishing its legal name, its filing number, that wallet\'s address and the text of each charter it adopts, with its grants and schedules, in signed statements anyone may read; and (4) I understand that Novi Corpus relies on this declaration and may check it against the public record and the evidence I provide.',
  );
});

test("the signed message of a declaration carries the new sentence and its version", () => {
  const message = buildStatementMessage(FIELDS, DECLARATION_OF_AUTHORITY, 1_800_000_000n);
  expect(message.statement).toBe(DECLARATION_OF_AUTHORITY.render(FIELDS));
  expect(message.wordingVersion).toBe("2026-11-draft-1");
});

test("a draft is served on sandbox only: production refuses it and names the text", () => {
  const approved = { ...STATEMENT_OF_AUTHORITY, status: "approved" as const };
  expect(() => assertTextsServable("sandbox", [STATEMENT_OF_AUTHORITY])).not.toThrow();
  expect(() => assertTextsServable("production", [approved])).not.toThrow();
  // A spread copy keeps a working render: the approved copy says the same sentence.
  expect(approved.render(FIELDS)).toBe(STATEMENT_OF_AUTHORITY.render(FIELDS));

  let refused: unknown;
  try {
    assertTextsServable("production", [approved, STATEMENT_OF_AUTHORITY]);
  } catch (err) {
    refused = err;
  }
  expect(refused).toBeInstanceOf(LegalTextNotApprovedError);
  expect(refused).toMatchObject({
    textId: "statement-of-authority",
    version: STATEMENT_OF_AUTHORITY.version,
  });
  expect((refused as Error).message).toContain("statement-of-authority");
  // An environment that is neither value is held to the production rule.
  expect(() => assertTextsServable("staging" as never, [STATEMENT_OF_AUTHORITY])).toThrow(
    LegalTextNotApprovedError,
  );
});
