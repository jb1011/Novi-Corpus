/**
 * A grant's choices, parsed into one canonical value or refused field by field: an amount is a
 * plain whole number of US dollars, one choice has one spelling, an end is a future calendar day,
 * and a hostile shape is a list of problems, never a throw. Then the grant built from them by its
 * one checked constructor: its canonical form, its fingerprint, and the Schedule A written from
 * it, compared character for character with three golden texts, and the grant read back from its
 * canonical form.
 *
 * Every amount and date here is a made-up fixture.
 */
import { createHash } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import { expect, test } from "vitest";
import {
  GRANT_ACT_KINDS,
  GRANT_AMOUNT_MAX,
  GRANT_HEAVY_ACTS,
  GRANT_PROBLEMS_MAX,
  type GrantChoices,
  SCHEDULE_A_WORDING,
  buildGrant,
  checkGrantChoices,
  grantAllowsNothing,
  grantEndProblem,
  grantFromCanonical,
  grantLastDayStartsAt,
  parseGrantChoices,
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
  "an amount that is not a whole number of US dollars in range is refused, never converted: %s",
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
        problem: "must be a whole number of US dollars from 1 to 1,000,000,000",
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
      problem: "must be a whole number of US dollars from 1 to 1,000,000,000",
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
      problem: "must be a whole number of US dollars from 1 to 1,000,000,000",
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

test("the shape is checked without a clock: a past end day is a valid shape, and the end rule is its own step", () => {
  const past = edit((c) => {
    c.endsOn = "1999-01-01";
  });
  expect(checkGrantChoices(past)).toEqual({ choices: { ...A, endsOn: "1999-01-01" } });
  expect(problemsOf(past)).toEqual([{ field: "endsOn", problem: "must be after today (UTC)" }]);
  expect(grantEndProblem({ ...A, endsOn: "2026-11-11" }, "2026-11-11")).toEqual({
    field: "endsOn",
    problem: "must be after today (UTC)",
  });
  expect(grantEndProblem({ ...A, endsOn: "2026-11-12" }, "2026-11-11")).toBeNull();
  expect(grantEndProblem(A, "2026-11-11")).toBeNull();
});

test("the shape check refuses what the parser refuses, the end rule aside", () => {
  expect(
    checkGrantChoices(
      edit((c) => {
        c.acts.buy.perAct = "200";
      }),
    ),
  ).toEqual({
    problems: [
      {
        field: "acts.buy.perAct",
        problem: "must be a whole number of US dollars from 1 to 1,000,000,000",
      },
    ],
  });
  expect(
    checkGrantChoices(
      edit((c) => {
        c.endsOn = "2027-02-30";
      }),
    ),
  ).toEqual({
    problems: [{ field: "endsOn", problem: "must be null or a calendar date written YYYY-MM-DD" }],
  });
  expect(checkGrantChoices(null)).toEqual({
    problems: [{ field: "grant", problem: "must be an object" }],
  });
});

test.each([[""], ["11/11/2026"], ["2026-11-31"], ["2026-11-11T00:00:00Z"]])(
  "a today that is not a calendar day is a bug in the caller, and throws: %s",
  (bad) => {
    const error = new Error("grant: today must be a calendar date written YYYY-MM-DD");
    expect(() => parseGrantChoices(structuredClone(A), bad)).toThrow(error);
    expect(() => grantEndProblem(A, bad)).toThrow(error);
  },
);

test("the first second of a grant's last day", () => {
  expect(grantLastDayStartsAt({ ...A, endsOn: "2027-01-15" })).toBe(1_799_971_200);
  expect(grantLastDayStartsAt({ ...A, endsOn: "2027-01-16" })).toBe(1_800_057_600);
  expect(grantLastDayStartsAt({ ...A, endsOn: "2028-02-29" })).toBe(1_835_395_200);
  expect(grantLastDayStartsAt(A)).toBeNull();
});

test("at most twenty problems are listed, then one line says there are more", () => {
  const raw = edit((c) => {
    for (let i = 0; i < 50; i++) c[`k${i}`] = 1;
  });
  const r = parseGrantChoices(raw, TODAY) as { problems: { field: string; problem: string }[] };
  expect(r.problems).toHaveLength(GRANT_PROBLEMS_MAX + 1);
  expect(r.problems.slice(0, 20)).toEqual(
    Array.from({ length: 20 }, (_, i) => ({
      field: `k${i}`,
      problem: "is not a field of a grant",
    })),
  );
  expect(r.problems.at(-1)).toEqual({
    field: "grant",
    problem: "has more problems than the 20 listed",
  });
  // Twenty problems are listed whole, with no last line.
  const twenty = edit((c) => {
    for (let i = 0; i < 20; i++) c[`k${i}`] = 1;
  });
  expect((parseGrantChoices(twenty, TODAY) as { problems: unknown[] }).problems).toHaveLength(20);
});

test("an unknown key is named only when it is a short plain name", () => {
  expect(
    problemsOf(
      edit((c) => {
        c["x".repeat(41)] = 1;
        c["a b"] = 1;
      }),
    ),
  ).toEqual([
    { field: "(unnamed)", problem: "is not a field of a grant" },
    { field: "(unnamed)", problem: "is not a field of a grant" },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        c.acts["<script>"] = 1;
        c.heavyActs[`y${"z".repeat(100_000)}`] = 1;
      }),
    ),
  ).toEqual([
    { field: "acts.(unnamed)", problem: "is not a field of a grant" },
    { field: "heavyActs.(unnamed)", problem: "is not a field of a grant" },
  ]);
  expect(
    problemsOf(
      edit((c) => {
        c["x".repeat(40)] = 1;
      }),
    ),
  ).toEqual([{ field: "x".repeat(40), problem: "is not a field of a grant" }]);
});

test("the eleven keys are one exported list", () => {
  expect(GRANT_ACT_KINDS).toEqual(Object.keys(A.acts));
  expect(GRANT_HEAVY_ACTS).toEqual(Object.keys(A.heavyActs));
});

// ── The grant, its fingerprint and its Schedule A ─────────────────────────────────────────────

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The Schedule A of fixture `A`, then of fixture `B`, then of `coSigned` below, in the wording of
 *  Charter draft 4, as the reference texts write them: copied from those texts, never retyped.
 *  Each has no trailing newline. */
const GOLDEN_A = [
  "Grant 1, version 1. Digest 0xb88cefedad48bffc885596dc29fb3c8f935774498147ed74e48395e110eb4dc1. In force from the time stated in section 5.3(a) until revoked. Counterparties: anyone.",
  "",
  "Acts of section 5.2:",
  "",
  "- (a) entering agreements for services the Company provides: the agent alone, up to USD 2,000 per agreement; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (b) accepting engagements: the agent alone, up to USD 2,000 per engagement; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (c) issuing invoices in the Company's name: the agent alone, up to USD 2,000 per invoice, payable only to the wallet named in Schedule B; above that amount, not allowed;",
  "- (d) receiving payment to the wallet named in Schedule B: allowed;",
  "- (e) buying goods or services: the agent alone, up to USD 200 per purchase and USD 1,000 per thirty days; above those amounts, only with the Guardian Wallet's signature beside the agent's;",
  "- (f) paying: the agent alone, up to USD 200 per payment and USD 1,000 per thirty days; above those amounts, not allowed;",
  "- (g) engaging a contractor for work: the agent alone, up to USD 500 per engagement and USD 1,000 per thirty days; above those amounts, only with the Guardian Wallet's signature beside the agent's.",
  "",
  "Acts of section 5.6:",
  "",
  "- (h) employing a person: not allowed;",
  "- (i) borrowing: not allowed;",
  "- (j) guaranteeing anyone's obligation: not allowed;",
  "- (k) transferring or encumbering the Company's property, other than paying within this grant: only with the Guardian Wallet's signature beside the agent's.",
  "",
  "Amounts are in US dollars (USD); one USDC counts as one US dollar (section 5.2). Every limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
].join("\n");
const GOLDEN_B = [
  "Grant 1, version 1. Digest 0xb9ed4f5f32f26a3c0ca454e9810af42b9a1397ba68be335090cf03283e6ec11b. In force from the time stated in section 5.3(a) until the end of 31 December 2027 (UTC), unless revoked earlier. Counterparties: only a party whose own legal body reads active in Novi Corpus's record at the time of the act.",
  "",
  "Acts of section 5.2:",
  "",
  "- (a) entering agreements for services the Company provides: the agent alone, up to USD 1,250,000 per agreement; above that amount, not allowed;",
  "- (b) accepting engagements: not allowed;",
  "- (c) issuing invoices in the Company's name: not allowed;",
  "- (d) receiving payment to the wallet named in Schedule B: not allowed;",
  "- (e) buying goods or services: not allowed;",
  "- (f) paying: the agent alone, up to USD 1 per payment and USD 1 per thirty days; above those amounts, only with the Guardian Wallet's signature beside the agent's;",
  "- (g) engaging a contractor for work: not allowed.",
  "",
  "Acts of section 5.6:",
  "",
  "- (h) employing a person: the agent alone, up to USD 3,000 per employment; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (i) borrowing: only with the Guardian Wallet's signature beside the agent's;",
  "- (j) guaranteeing anyone's obligation: the agent alone, up to USD 1 per guarantee; above that amount, only with the Guardian Wallet's signature beside the agent's;",
  "- (k) transferring or encumbering the Company's property, other than paying within this grant: not allowed.",
  "",
  "Amounts are in US dollars (USD); one USDC counts as one US dollar (section 5.2). Every limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
].join("\n");
const GOLDEN_CO_SIGNED = [
  "Grant 1, version 1. Digest 0x65e5d3aad6a2995070d7cac1d54b5cf8c4ff651403367c187cefbb2f4883bcf5. In force from the time stated in section 5.3(a) until the end of 31 December 2027 (UTC), unless revoked earlier. Counterparties: only a party whose own legal body reads active in Novi Corpus's record at the time of the act.",
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
  "Every limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
].join("\n");
/** The canonical form of the grant of fixture `B`, number 1 and version 1, as its reference text
 *  writes it: written by hand, key by key, and never produced by a function in this test. It has no
 *  trailing newline. */
const CANONICAL_B =
  '{"choices":{"acts":{"acceptEngagement":{"allowed":false},"buy":{"allowed":false},"engageContractor":{"allowed":false},"issueInvoice":{"allowed":false},"pay":{"above":"guardian_signature","allowed":true,"per30Days":1,"perAct":1},"provideServices":{"above":"not_allowed","allowed":true,"perAct":1250000},"receivePayment":{"allowed":false}},"counterparties":"active_legal_body","endsOn":"2027-12-31","heavyActs":{"borrow":{"mode":"guardian_signature"},"employ":{"mode":"alone","perAct":3000},"guarantee":{"mode":"alone","perAct":1},"transferProperty":{"mode":"not_allowed"}}},"number":1,"schema":"novi.legal-body-grant/1","version":1}';

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
const NOT_CANONICAL = "grant: the choices are not in canonical form";

test.each([[0], [-1], [1.5], ["1" as never], [Number.NaN]])(
  "a grant's number that is not a whole number of at least 1 is refused when the grant is built: %s",
  (bad) => {
    expect(() => buildGrant(A, { number: bad, version: 1 })).toThrow(new Error(BAD_NUMBER));
  },
);

test("a grant's version of 0 is refused when the grant is built", () => {
  expect(() => buildGrant(A, { number: 1, version: 0 })).toThrow(new Error(BAD_NUMBER));
});

test("a grant holds its value, its canonical form, its fingerprint and its Schedule A, each computed once", () => {
  expect(grantA.value).toEqual({
    schema: "novi.legal-body-grant/1",
    number: 1,
    version: 1,
    choices: A,
  });
  expect(grantA.digest).toBe("0xb88cefedad48bffc885596dc29fb3c8f935774498147ed74e48395e110eb4dc1");
  expect(grantB.digest).toBe("0xb9ed4f5f32f26a3c0ca454e9810af42b9a1397ba68be335090cf03283e6ec11b");
  expect(Object.keys(grantA).sort()).toEqual(["canonical", "digest", "scheduleA", "value"]);
  expect(SCHEDULE_A_WORDING).toBe("2026-11-draft-4");
});

test("the canonical form is the one written by hand, and the fingerprint is the keccak256 of its bytes", () => {
  expect(grantB.canonical).toBe(CANONICAL_B);
  expect(keccak256(stringToBytes(CANONICAL_B))).toBe(grantB.digest);
});

test("a grant shares nothing with the choices it was built from, and cannot be changed", () => {
  const choices = structuredClone(A);
  const grant = buildGrant(choices, { number: 1, version: 1 });
  (choices.acts.pay as { perAct: number }).perAct = 999;
  expect(grant.value.choices).toEqual(A);
  expect(Object.isFrozen(grant)).toBe(true);
  expect(Object.isFrozen(grant.value)).toBe(true);
  expect(Object.isFrozen(grant.value.choices.acts.pay)).toBe(true);
  expect(() => {
    (grant.value.choices.acts.pay as { perAct: number }).perAct = 1;
  }).toThrow(TypeError);
});

/** A change `edit` applies: typed by `edit` itself, so no second `any` is written. */
type Change = Parameters<typeof edit>[0];
const NOT_CANONICAL_CASES: [string, Change][] = [
  [
    "one key more",
    (c) => {
      c.note = "x";
    },
  ],
  [
    "an amount as text",
    (c) => {
      c.acts.buy.perAct = "200";
    },
  ],
  [
    "an amount of zero",
    (c) => {
      c.acts.buy.perAct = 0;
    },
  ],
  [
    "a missing amount",
    (c) => {
      Reflect.deleteProperty(c.acts.buy, "perAct");
    },
  ],
  [
    "an act not allowed that carries an amount",
    (c) => {
      c.acts.buy = { allowed: false, perAct: 5 };
    },
  ],
  [
    "a day that does not exist",
    (c) => {
      c.endsOn = "2027-02-30";
    },
  ],
  [
    "a month that does not exist",
    (c) => {
      c.endsOn = "2027-13-01";
    },
  ],
  [
    "a missing kind",
    (c) => {
      Reflect.deleteProperty(c.acts, "pay");
    },
  ],
];
test.each(NOT_CANONICAL_CASES)(
  "choices that are not in canonical form build no grant: %s",
  (_name, change) => {
    expect(() => buildGrant(edit(change) as GrantChoices, { number: 1, version: 1 })).toThrow(
      new Error(NOT_CANONICAL),
    );
  },
);

test("choices that allow nothing build no grant", () => {
  expect(grantAllowsNothing(none)).toBe(true);
  expect(() => buildGrant(none, { number: 1, version: 1 })).toThrow(
    new Error("grant: the choices allow nothing, and a grant allows something"),
  );
  expect(grantAllowsNothing(A)).toBe(false);
});

test.each(GRANT_HEAVY_ACTS.map((act) => [act] as const))(
  "one act of section 5.6 allowed, whichever it is and however, is a grant: %s",
  (act) => {
    const withSignature = structuredClone(none);
    withSignature.heavyActs[act] = { mode: "guardian_signature" };
    expect(grantAllowsNothing(withSignature)).toBe(false);
    const alone = structuredClone(none);
    alone.heavyActs[act] = { mode: "alone", perAct: 1 };
    expect(grantAllowsNothing(alone)).toBe(false);
  },
);

test("a grant whose end day has passed still builds: the shape has no clock", () => {
  const ended = buildGrant(
    { ...structuredClone(A), endsOn: "1999-01-01" },
    { number: 1, version: 1 },
  );
  expect(ended.scheduleA).toContain(
    "until the end of 1 January 1999 (UTC), unless revoked earlier. Counterparties: anyone.",
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
  expect(buildGrant(reordered, { number: 1, version: 1 }).digest).toBe(grantA.digest);
  const changed = structuredClone(A);
  (changed.acts.pay as { perAct: number }).perAct = 201;
  expect(buildGrant(changed, { number: 1, version: 1 }).digest).not.toBe(grantA.digest);
  expect(buildGrant(A, { number: 2, version: 1 }).digest).not.toBe(grantA.digest);
  expect(buildGrant(A, { number: 1, version: 2 }).digest).not.toBe(grantA.digest);
});

test("Schedule A is written from the choices, character for character", () => {
  expect(grantA.scheduleA).toBe(GOLDEN_A);
  expect(grantB.scheduleA).toBe(GOLDEN_B);
  expect(grantCoSigned.scheduleA).toBe(GOLDEN_CO_SIGNED);
  expect(sha256(grantA.scheduleA)).toBe(
    "738f0a878a3e630e697d9b670bab395e80dbfa241fcdb22eed9338c21d509685",
  );
  expect(sha256(grantB.scheduleA)).toBe(
    "461c01994cde9d6099a97d99e01c80ece57399423cf3a578bdce680c8e2a2517",
  );
  expect(sha256(grantCoSigned.scheduleA)).toBe(
    "905ff1e85dc023f83738d25c02edb9d6195b7c5865c4f82b0a4c6ca549c643ca",
  );
  expect(grantCoSigned.digest).toBe(
    "0x65e5d3aad6a2995070d7cac1d54b5cf8c4ff651403367c187cefbb2f4883bcf5",
  );
});

test("a grant that names no amount does not speak of amounts", () => {
  expect(
    grantCoSigned.scheduleA.endsWith(
      "\n\nEvery limit in this grant is declared (section 5.5): nothing of Novi Corpus's stops the agent from exceeding it.",
    ),
  ).toBe(true);
  expect(grantCoSigned.scheduleA).not.toMatch(/USD|US dollar/);
  // One act of section 5.6 left to the agent alone names an amount.
  const alone = structuredClone(coSigned);
  alone.heavyActs.guarantee = { mode: "alone", perAct: 1 };
  expect(buildGrant(alone, { number: 1, version: 1 }).scheduleA).toContain(
    "\n\nAmounts are in US dollars (USD); one USDC counts as one US dollar (section 5.2). Every limit in this grant is declared",
  );
});

test("Schedule A holds only ASCII, no brace and no trailing newline, and never says enforced", () => {
  for (const text of [
    grantA.scheduleA,
    grantB.scheduleA,
    grantGreatest.scheduleA,
    grantCoSigned.scheduleA,
  ]) {
    expect(text).toMatch(/^[\n\x20-\x7e]+$/);
    expect(text).not.toMatch(/[{}]/);
    expect(text.endsWith("\n")).toBe(false);
    expect(text).not.toMatch(/enforced/i);
  }
});

test("the greatest amount is written in full, with its commas", () => {
  expect(grantGreatest.scheduleA).toContain(
    "- (e) buying goods or services: the agent alone, up to USD 999 per purchase and USD 1,000,000,000 per thirty days; above those amounts, not allowed;",
  );
});

test("an end date is written as a day, without a leading zero", () => {
  const dated = { ...structuredClone(A), endsOn: "2027-01-01" };
  expect(buildGrant(dated, { number: 1, version: 1 }).scheduleA).toContain(
    "until the end of 1 January 2027 (UTC), unless revoked earlier. Counterparties: anyone.",
  );
});

test("a leap day builds, and is written as its day", () => {
  expect(buildGrant({ ...A, endsOn: "2028-02-29" }, { number: 1, version: 1 }).scheduleA).toContain(
    "until the end of 29 February 2028 (UTC), unless revoked earlier.",
  );
});

test("a grant read back from its canonical form is the same grant, and anything else is none", () => {
  const read = grantFromCanonical(grantB.canonical);
  expect(read).toEqual(grantB);
  expect(Object.isFrozen(read)).toBe(true);
  for (const bad of [
    "",
    "not json",
    "null",
    "[]",
    `${grantB.canonical}\n`,
    ` ${grantB.canonical}`,
    JSON.stringify(grantB.value), // the same value, keys not in canonical order
    grantB.canonical.replace('"version":1', '"version":1,"x":1'), // one key more
    grantB.canonical.replace("novi.legal-body-grant/1", "novi.legal-body-grant/2"),
    grantB.canonical.replace('"number":1', '"number":"1"'),
    grantB.canonical.replace('"perAct":3000', '"perAct":3000.5'),
  ])
    expect(grantFromCanonical(bad), bad.slice(0, 40)).toBeUndefined();
});
