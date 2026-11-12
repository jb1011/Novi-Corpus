/**
 * A grant's choices, parsed into one canonical value or refused field by field: an amount is a
 * plain whole number of USDC, one choice has one spelling, an end is a future calendar day, and a
 * hostile shape is a list of problems, never a throw.
 *
 * Every amount and date here is a made-up fixture.
 */
import { expect, test } from "vitest";
import {
  GRANT_AMOUNT_MAX,
  type GrantChoices,
  parseGrantChoices,
  utcDay,
} from "../../src/legalBody/grant";
import { A } from "../helpers/grantFixtures";

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
