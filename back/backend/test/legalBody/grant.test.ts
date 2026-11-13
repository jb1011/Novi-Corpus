/**
 * A grant's choices, parsed into one canonical value or refused field by field: an amount is a
 * plain whole number of USDC, one choice has one spelling, an end is a future calendar day, and a
 * hostile shape is a list of problems, never a throw. Then the grant built from them: its
 * fingerprint, and the Schedule A written from it, compared character for character with three
 * golden texts.
 *
 * Every amount and date here is a made-up fixture.
 */
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  GRANT_AMOUNT_MAX,
  type GrantChoices,
  buildGrant,
  grantAllowsNothing,
  grantDigest,
  parseGrantChoices,
  renderScheduleA,
  utcDay,
} from "../../src/legalBody/grant";
import { A, B } from "../helpers/grantFixtures";

const TODAY = "2026-11-11";
/** The problems, sorted by field: the order they are found in is not part of the contract. */
const problemsOf = (raw: unknown) => {
  const r = parseGrantChoices(raw, TODAY);
  return "problems" in r ? [...r.problems].sort((x, y) => x.field.localeCompare(y.field)) : [];
};
/** A copy of `A`, changed by `fn`: no longer a `GrantChoices`, so it is returned as unknown. */
// biome-ignore lint/suspicious/noExplicitAny: the tests write shapes a grant's type refuses
const edit = (fn: (c: any) => void): unknown => {
  const c = structuredClone(A);
  fn(c);
  return c;
};

test("a full set of choices is returned as given, in a fresh object", () => {
  const r = parseGrantChoices(structuredClone(A), TODAY);
  expect(r).toEqual({ choices: A });
  const raw = structuredClone(A);
  const again = parseGrantChoices(raw, TODAY) as { choices: GrantChoices };
  expect(again.choices.acts).not.toBe(raw.acts);
});

test.each([
  ["200"],
  [200.5],
  [0],
  [-1],
  [1e21],
  [Number.NaN],
  [GRANT_AMOUNT_MAX + 1],
  [null],
  [true],
])(
  "an amount that is not a whole number of USDC in range is refused, never converted: %s",
  (bad) => {
    expect(
      problemsOf(
        edit((c) => {
          c.acts.buy.perAct = bad;
        }),
      ),
    ).toEqual([
      {
        field: "acts.buy.perAct",
        problem: "must be a whole number of USDC from 1 to 1,000,000,000",
      },
    ]);
  },
);

test("the amount problem names the greatest amount", () => {
  // The amount problem writes this number out as 1,000,000,000: change both together.
  expect(GRANT_AMOUNT_MAX).toBe(1_000_000_000);
});

test("the greatest amount is accepted", () => {
  expect(
    "choices" in
      parseGrantChoices(
        edit((c) => {
          c.acts.buy.per30Days = GRANT_AMOUNT_MAX;
        }),
        TODAY,
      ),
  ).toBe(true);
});

test("thirty days cannot hold less than one act", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.acts.pay.per30Days = 199;
      }),
    ),
  ).toEqual([{ field: "acts.pay.per30Days", problem: "must be at least the amount per act" }]);
});

test("one choice has one spelling: an act not allowed carries nothing else", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.acts.buy = { allowed: false, perAct: 5, above: "not_allowed" };
      }),
    ),
  ).toEqual([
    { field: "acts.buy.above", problem: "must be absent when the act is not allowed" },
    { field: "acts.buy.perAct", problem: "must be absent when the act is not allowed" },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        c.heavyActs.borrow = { mode: "guardian_signature", perAct: 5 };
      }),
    ),
  ).toEqual([
    { field: "heavyActs.borrow.perAct", problem: "must be absent unless the mode is alone" },
  ]);
});

test("a missing kind and an unknown key are both refused", () => {
  expect(
    problemsOf(
      edit((c) => {
        Reflect.deleteProperty(c.acts, "pay");
        c.acts.gift = { allowed: true };
        c.note = "x";
      }),
    ),
  ).toEqual([
    { field: "acts.gift", problem: "is not a field of a grant" },
    { field: "acts.pay", problem: "is required" },
    { field: "note", problem: "is not a field of a grant" },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        Reflect.deleteProperty(c.acts.buy, "above");
        Reflect.deleteProperty(c.heavyActs.borrow, "mode");
      }),
    ),
  ).toEqual([
    { field: "acts.buy.above", problem: "must be guardian_signature or not_allowed" },
    { field: "heavyActs.borrow.mode", problem: "must be not_allowed, guardian_signature or alone" },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        c.acts.provideServices.per30Days = 5000;
      }),
    ),
  ).toEqual([{ field: "acts.provideServices.per30Days", problem: "is not a field of a grant" }]);
  expect(
    problemsOf(
      edit((c) => {
        c.acts.receivePayment.perAct = 5;
      }),
    ),
  ).toEqual([{ field: "acts.receivePayment.perAct", problem: "is not a field of a grant" }]);
});

test("invoices need payment to be receivable", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.acts.receivePayment.allowed = false;
      }),
    ),
  ).toEqual([
    { field: "acts.receivePayment.allowed", problem: "must be true when invoices are allowed" },
  ]);
});

test("a heavy act alone needs its amount", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.heavyActs.employ = { mode: "alone" };
      }),
    ),
  ).toEqual([
    {
      field: "heavyActs.employ.perAct",
      problem: "must be a whole number of USDC from 1 to 1,000,000,000",
    },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        c.heavyActs.employ = { mode: "freely" };
      }),
    ),
  ).toEqual([
    { field: "heavyActs.employ.mode", problem: "must be not_allowed, guardian_signature or alone" },
  ]);
});

test("an allowed that is not true or false is the one problem of its setting; its amounts go unchecked, its unknown keys do not", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.acts.buy.allowed = "yes";
      }),
    ),
  ).toEqual([{ field: "acts.buy.allowed", problem: "must be true or false" }]);
  expect(
    problemsOf(
      edit((c) => {
        c.acts.buy = { allowed: "yes", perAct: 0, x: 1 };
      }),
    ),
  ).toEqual([
    { field: "acts.buy.allowed", problem: "must be true or false" },
    { field: "acts.buy.x", problem: "is not a field of a grant" },
  ]);
});

test("a heavy act's mode that is not one of its three values is the one problem of its setting", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.heavyActs.employ = { mode: "freely", perAct: 0 };
      }),
    ),
  ).toEqual([
    { field: "heavyActs.employ.mode", problem: "must be not_allowed, guardian_signature or alone" },
  ]);
});

test("the counterparties are one of two values, compared exactly", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.counterparties = "Anyone";
      }),
    ),
  ).toEqual([{ field: "counterparties", problem: "must be anyone or active_legal_body" }]);
});

test("a spending act not allowed carries no amount per thirty days", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.acts.pay = { allowed: false, per30Days: 5 };
      }),
    ),
  ).toEqual([
    { field: "acts.pay.per30Days", problem: "must be absent when the act is not allowed" },
  ]);
});

test("a rule between two values is checked only when both values are valid", () => {
  expect(
    problemsOf(
      edit((c) => {
        c.acts.pay = { allowed: true, perAct: 0, per30Days: 1, above: "not_allowed" };
      }),
    ),
  ).toEqual([
    {
      field: "acts.pay.perAct",
      problem: "must be a whole number of USDC from 1 to 1,000,000,000",
    },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        c.acts.issueInvoice.allowed = "yes";
        c.acts.receivePayment.allowed = false;
      }),
    ),
  ).toEqual([{ field: "acts.issueInvoice.allowed", problem: "must be true or false" }]);
});

test.each([["2027-02-30"], ["2027-2-3"], ["2027-12-31T00:00:00Z"], [20271231], [""], ["tomorrow"]])(
  "an end that is not a calendar date is refused: %s",
  (bad) => {
    expect(
      problemsOf(
        edit((c) => {
          c.endsOn = bad;
        }),
      ),
    ).toEqual([{ field: "endsOn", problem: "must be null or a calendar date written YYYY-MM-DD" }]);
  },
);

test("an end today or before today is refused; tomorrow is taken", () => {
  for (const day of ["2026-11-11", "2026-11-10", "1999-01-01"])
    expect(
      problemsOf(
        edit((c) => {
          c.endsOn = day;
        }),
      ),
    ).toEqual([{ field: "endsOn", problem: "must be after today (UTC)" }]);
  expect(
    "choices" in
      parseGrantChoices(
        edit((c) => {
          c.endsOn = "2026-11-12";
        }),
        TODAY,
      ),
  ).toBe(true);
  expect(
    "choices" in
      parseGrantChoices(
        edit((c) => {
          c.endsOn = "2028-02-29";
        }),
        TODAY,
      ),
  ).toBe(true);
});

test.each([[null], [[]], ["grant"], [7], [undefined]])(
  "what is not an object is one problem, never a throw: %s",
  (bad) => {
    expect(problemsOf(bad)).toEqual([{ field: "grant", problem: "must be an object" }]);
  },
);

test("hostile keys are fields like any other, and no prototype is touched", () => {
  const raw = JSON.parse(JSON.stringify(A));
  Object.defineProperty(raw, "__proto__", { value: { polluted: true }, enumerable: true });
  raw.acts.constructor = { allowed: true };
  expect(problemsOf(raw)).toEqual(
    expect.arrayContaining([
      { field: "__proto__", problem: "is not a field of a grant" },
      { field: "acts.constructor", problem: "is not a field of a grant" },
    ]),
  );
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(
    problemsOf(
      edit((c) => {
        c.acts.buy = null;
        c.heavyActs = [];
      }),
    ),
  ).toEqual(
    expect.arrayContaining([
      { field: "acts.buy", problem: "must be an object" },
      { field: "heavyActs", problem: "must be an object" },
    ]),
  );
});

test("the UTC day of a time", () => {
  expect(utcDay(Date.UTC(2026, 10, 11, 23, 59, 59))).toBe("2026-11-11");
  expect(utcDay(Date.UTC(2027, 0, 1, 0, 0, 0))).toBe("2027-01-01");
});

// ── The grant, its fingerprint and its Schedule A ─────────────────────────────────────────────

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The Schedule A of fixture `A`, then of fixture `B`, as the reference texts write them: copied
 *  from those texts, never retyped. Each has no trailing newline. */
const GOLDEN_A = [
  "Grant 1, version 1. Digest 0xb88cefedad48bffc885596dc29fb3c8f935774498147ed74e48395e110eb4dc1. In force from the creation of the Legal Body until revoked. Counterparties: anyone.",
  "",
  "Acts of section 5.2:",
  "",
  "- (a) entering agreements for services the Company provides: the agent alone, up to 2,000 USDC per agreement; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (b) accepting engagements: the agent alone, up to 2,000 USDC per engagement; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (c) issuing invoices in the Company's name: the agent alone, up to 2,000 USDC per invoice, payable only to the wallet named in Schedule B; above that amount, not allowed;",
  "- (d) receiving payment to the wallet named in Schedule B: allowed;",
  "- (e) buying goods or services: the agent alone, up to 200 USDC per purchase and 1,000 USDC per thirty days; above those amounts, only with the Guardian Wallet's signature beside the agent's;",
  "- (f) paying: the agent alone, up to 200 USDC per payment and 1,000 USDC per thirty days; above those amounts, not allowed;",
  "- (g) engaging a contractor for work: the agent alone, up to 500 USDC per engagement and 1,000 USDC per thirty days; above those amounts, only with the Guardian Wallet's signature beside the agent's.",
  "",
  "Acts of section 5.6:",
  "",
  "- (h) employing a person: not allowed;",
  "- (i) borrowing: not allowed;",
  "- (j) guaranteeing anyone's obligation: not allowed;",
  "- (k) transferring or encumbering the Company's property, other than paying within this grant: only with the Guardian Wallet's signature beside the agent's.",
  "",
  "Amounts are in USDC, or the same value at the time of the act (section 5.2). Every limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
].join("\n");
const GOLDEN_B = [
  "Grant 1, version 1. Digest 0xb9ed4f5f32f26a3c0ca454e9810af42b9a1397ba68be335090cf03283e6ec11b. In force from the creation of the Legal Body until the end of 31 December 2027 (UTC), unless revoked earlier. Counterparties: only a party whose own legal body reads active in Novi Corpus's record at the time of the act.",
  "",
  "Acts of section 5.2:",
  "",
  "- (a) entering agreements for services the Company provides: the agent alone, up to 1,250,000 USDC per agreement; above that amount, not allowed;",
  "- (b) accepting engagements: not allowed;",
  "- (c) issuing invoices in the Company's name: not allowed;",
  "- (d) receiving payment to the wallet named in Schedule B: not allowed;",
  "- (e) buying goods or services: not allowed;",
  "- (f) paying: the agent alone, up to 1 USDC per payment and 1 USDC per thirty days; above those amounts, only with the Guardian Wallet's signature beside the agent's;",
  "- (g) engaging a contractor for work: not allowed.",
  "",
  "Acts of section 5.6:",
  "",
  "- (h) employing a person: the agent alone, up to 3,000 USDC per employment; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (i) borrowing: only with the Guardian Wallet's signature beside the agent's;",
  "- (j) guaranteeing anyone's obligation: the agent alone, up to 1 USDC per guarantee; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (k) transferring or encumbering the Company's property, other than paying within this grant: not allowed.",
  "",
  "Amounts are in USDC, or the same value at the time of the act (section 5.2). Every limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
].join("\n");
/** The Schedule A of `coSigned` below, as its reference text writes it: copied from that text,
 *  never retyped. It has no trailing newline. */
const GOLDEN_CO_SIGNED = [
  "Grant 1, version 1. Digest 0x65e5d3aad6a2995070d7cac1d54b5cf8c4ff651403367c187cefbb2f4883bcf5. In force from the creation of the Legal Body until the end of 31 December 2027 (UTC), unless revoked earlier. Counterparties: only a party whose own legal body reads active in Novi Corpus's record at the time of the act.",
  "",
  "Acts of section 5.2:",
  "",
  "- (a) entering agreements for services the Company provides: not allowed;",
  "- (b) accepting engagements: not allowed;",
  "- (c) issuing invoices in the Company's name: not allowed;",
  "- (d) receiving payment to the wallet named in Schedule B: not allowed;",
  "- (e) buying goods or services: not allowed;",
  "- (f) paying: not allowed;",
  "- (g) engaging a contractor for work: not allowed.",
  "",
  "Acts of section 5.6:",
  "",
  "- (h) employing a person: not allowed;",
  "- (i) borrowing: only with the Guardian Wallet's signature beside the agent's;",
  "- (j) guaranteeing anyone's obligation: not allowed;",
  "- (k) transferring or encumbering the Company's property, other than paying within this grant: not allowed.",
  "",
  "Amounts are in USDC, or the same value at the time of the act (section 5.2). Every limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
].join("\n");

const grantA = buildGrant(A, { number: 1, version: 1 });
const grantB = buildGrant(B, { number: 1, version: 1 });
/** Fixture `A` with the greatest amount, as the amount for thirty days of buying. */
const greatest = structuredClone(A);
greatest.acts.buy = {
  allowed: true,
  perAct: 999,
  per30Days: GRANT_AMOUNT_MAX,
  above: "not_allowed",
};
const grantGreatest = buildGrant(greatest, { number: 1, version: 1 });
/** Fixture `B` with every line not allowed: no kind of section 5.2 and no act of section 5.6. */
const none = structuredClone(B);
none.acts.provideServices = { allowed: false };
none.acts.pay = { allowed: false };
none.heavyActs.employ = { mode: "not_allowed" };
none.heavyActs.borrow = { mode: "not_allowed" };
none.heavyActs.guarantee = { mode: "not_allowed" };
none.heavyActs.transferProperty = { mode: "not_allowed" };
/** The same, with borrowing allowed only with the Guardian Wallet's signature beside the agent's. */
const coSigned = structuredClone(none);
coSigned.heavyActs.borrow = { mode: "guardian_signature" };
const grantCoSigned = buildGrant(coSigned, { number: 1, version: 1 });

const BAD_NUMBER = "grant: number and version must each be a whole number of at least 1";
const BAD_AMOUNT = "grant: an amount must be a whole number of USDC of at least 1";
const BAD_END = "grant: the end date is not a calendar date";

test.each([[0], [-1], [1.5], ["1" as never], [Number.NaN]])(
  "a grant's number that is not a whole number of at least 1 is refused when the grant is built: %s",
  (bad) => {
    expect(() => buildGrant(A, { number: bad, version: 1 })).toThrow(new Error(BAD_NUMBER));
  },
);

test("a grant's version of 0 is refused when the grant is built", () => {
  expect(() => buildGrant(A, { number: 1, version: 0 })).toThrow(new Error(BAD_NUMBER));
});

test.each([[-100], [0], ["200" as never]])(
  "Schedule A refuses to write an amount that is not a whole number of USDC of at least 1: %s",
  (bad) => {
    const choices = structuredClone(A);
    choices.acts.buy = { allowed: true, perAct: bad, per30Days: 1000, above: "guardian_signature" };
    expect(() => renderScheduleA(buildGrant(choices, { number: 1, version: 1 }))).toThrow(
      new Error(BAD_AMOUNT),
    );
  },
);

test("Schedule A refuses to write a missing amount", () => {
  const choices = structuredClone(A);
  Reflect.deleteProperty(choices.acts.buy, "perAct");
  expect(() => renderScheduleA(buildGrant(choices, { number: 1, version: 1 }))).toThrow(
    new Error(BAD_AMOUNT),
  );
});

test.each([["2027-02-30"], ["2027-02-31"], ["2027-03-00"]])(
  "Schedule A refuses an end day that does not exist in its month: %s",
  (endsOn) => {
    expect(() => renderScheduleA(buildGrant({ ...A, endsOn }, { number: 1, version: 1 }))).toThrow(
      new Error(BAD_END),
    );
  },
);

test("Schedule A refuses an end month that does not exist, and writes a leap day", () => {
  expect(() =>
    renderScheduleA(buildGrant({ ...A, endsOn: "2027-13-01" }, { number: 1, version: 1 })),
  ).toThrow(new Error(BAD_END));
  expect(
    renderScheduleA(buildGrant({ ...A, endsOn: "2028-02-29" }, { number: 1, version: 1 })),
  ).toContain("until the end of 29 February 2028 (UTC), unless revoked earlier.");
});

test("the fingerprint of a grant is the keccak256 of its canonical form", () => {
  expect(grantA).toEqual({ schema: "novi.legal-body-grant/1", number: 1, version: 1, choices: A });
  expect(grantDigest(grantA)).toBe(
    "0xb88cefedad48bffc885596dc29fb3c8f935774498147ed74e48395e110eb4dc1",
  );
  expect(grantDigest(grantB)).toBe(
    "0xb9ed4f5f32f26a3c0ca454e9810af42b9a1397ba68be335090cf03283e6ec11b",
  );
});

test("the fingerprint does not depend on the order of keys, and changes with any choice, number or version", () => {
  const reordered = JSON.parse(
    JSON.stringify({
      endsOn: A.endsOn,
      counterparties: A.counterparties,
      heavyActs: A.heavyActs,
      acts: A.acts,
    }),
  );
  expect(grantDigest(buildGrant(reordered, { number: 1, version: 1 }))).toBe(grantDigest(grantA));
  const changed = structuredClone(A);
  (changed.acts.pay as { perAct: number }).perAct = 201;
  expect(grantDigest(buildGrant(changed, { number: 1, version: 1 }))).not.toBe(grantDigest(grantA));
  expect(grantDigest(buildGrant(A, { number: 2, version: 1 }))).not.toBe(grantDigest(grantA));
  expect(grantDigest(buildGrant(A, { number: 1, version: 2 }))).not.toBe(grantDigest(grantA));
});

test("Schedule A is written from the choices, character for character", () => {
  expect(renderScheduleA(grantA)).toBe(GOLDEN_A);
  expect(renderScheduleA(grantB)).toBe(GOLDEN_B);
  expect(sha256(renderScheduleA(grantA))).toBe(
    "24c1b56b51dbbf408b74c47448271aec26ee6ebbab4f386dd90053600fef6467",
  );
  expect(sha256(renderScheduleA(grantB))).toBe(
    "5b57b600bf5c70fdbbf5a118335c3a2ffb794252e036f6872732752613ce6edc",
  );
});

test("Schedule A holds only ASCII, no brace and no trailing newline, and never says enforced", () => {
  for (const text of [
    renderScheduleA(grantA),
    renderScheduleA(grantB),
    renderScheduleA(grantGreatest),
    renderScheduleA(grantCoSigned),
  ]) {
    expect(text).toMatch(/^[\n\x20-\x7e]+$/);
    expect(text).not.toMatch(/[{}]/);
    expect(text.endsWith("\n")).toBe(false);
    expect(text).not.toMatch(/enforced/i);
  }
});

test("the greatest amount is written in full, with its commas", () => {
  expect(renderScheduleA(grantGreatest)).toContain(
    "- (e) buying goods or services: the agent alone, up to 999 USDC per purchase and 1,000,000,000 USDC per thirty days; above those amounts, not allowed;",
  );
});

test("an end date is written as a day, without a leading zero", () => {
  const dated = { ...structuredClone(A), endsOn: "2027-01-01" };
  expect(renderScheduleA(buildGrant(dated, { number: 1, version: 1 }))).toContain(
    "until the end of 1 January 2027 (UTC), unless revoked earlier. Counterparties: anyone.",
  );
});

test("a grant that allows nothing is no grant", () => {
  expect(grantAllowsNothing(none)).toBe(true);
  expect(renderScheduleA(buildGrant(none, { number: 1, version: 1 }))).toBe(
    "No grant is in force.",
  );
  expect(grantAllowsNothing(A)).toBe(false);
  // One act of section 5.6 left to the agent alone is a grant.
  const alone = structuredClone(none);
  alone.heavyActs.guarantee = { mode: "alone", perAct: 1 };
  expect(grantAllowsNothing(alone)).toBe(false);
});

test("an act of section 5.6 allowed only with the Guardian Wallet's signature is a grant", () => {
  expect(grantAllowsNothing(coSigned)).toBe(false);
  expect(grantDigest(grantCoSigned)).toBe(
    "0x65e5d3aad6a2995070d7cac1d54b5cf8c4ff651403367c187cefbb2f4883bcf5",
  );
  expect(renderScheduleA(grantCoSigned)).toBe(GOLDEN_CO_SIGNED);
  expect(sha256(renderScheduleA(grantCoSigned))).toBe(
    "324ea0ef524f8cd352a2f03c175f6a31a2fb94ac8b1674330c449388acede130",
  );
});
