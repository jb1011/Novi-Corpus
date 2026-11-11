/**
 * doola's FIELD-LEVEL reason, read by ONE function (`summarizeDoolaFields`), and what of it
 * `describeDoolaError` hands every ops line and every stored step error.
 *
 * The properties pinned here are the ones a looser reader would lose quietly:
 *  - a field path is repeated only when it passes the allowlist (letters, digits, `_`, `.`, `[`,
 *    `]`, at most 100 characters, nothing SSN-shaped);
 *  - doola's per-field message is redacted, then capped;
 *  - a submitted value is NEVER read, whatever key doola echoes it under;
 *  - the result is bounded, and a malformed map is `[]`, never a throw.
 *
 * Every value here is an invention. The nine-digit run is the shape the redactor exists for.
 */
import { expect, test } from "vitest";
import { DoolaApiError, describeDoolaError } from "../../../src/adapters/doola/doolaClient";
import {
  DOOLA_FIELD_LIMIT,
  DOOLA_FIELD_MESSAGE_MAX,
  fieldErrorsClause,
  isDoolaFieldPath,
  summarizeDoolaFields,
} from "../../../src/adapters/doola/fieldErrors";

const NINE_DIGITS = "123456789";

test("doola's nested `{field: {code, message}}` is read into path, code and message", () => {
  expect(
    summarizeDoolaFields({
      description: { code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
    }),
  ).toEqual([
    { field: "description", code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
  ]);
});

test("ALLOWLIST: a path is letters, digits, `_`, `.`, `[` and `]`, or it is dropped", () => {
  for (const ok of [
    "description",
    "nameOptions[1].name",
    "members[0].address.phone",
    "responsibleParty.address.postalCode",
    "Q16",
    "requested_services",
  ])
    expect(isDoolaFieldPath(ok), ok).toBe(true);

  for (const bad of [
    "",
    "has space",
    "person@example.test",
    "a;b",
    "a-b",
    "a/b",
    "name\nnext",
    "Café",
    "x".repeat(101),
    // Legal by the character class alone, and exactly what must never be repeated.
    NINE_DIGITS,
    `members[${NINE_DIGITS}]`,
  ])
    expect(isDoolaFieldPath(bad), JSON.stringify(bad)).toBe(false);

  // A refused key is DROPPED, not repaired: its neighbours still come through.
  expect(
    summarizeDoolaFields({
      "has space": { code: "E_X", message: "m" },
      [NINE_DIGITS]: { code: "E_X", message: "m" },
      description: { code: "E_FIELD_TOO_LONG" },
    }),
  ).toEqual([{ field: "description", code: "E_FIELD_TOO_LONG" }]);
});

test("a per-field CODE is kept only when it reads as an identifier", () => {
  const [entry] = summarizeDoolaFields({
    description: { code: "must not be longer than fifty", message: "too long" },
  });
  expect(entry).toEqual({ field: "description", message: "too long" });
  const [digits] = summarizeDoolaFields({ description: { code: NINE_DIGITS } });
  expect(digits).toEqual({ field: "description" });
});

test("REDACTION: a nine-digit run in a field's message never survives", () => {
  const [entry] = summarizeDoolaFields({
    "responsibleParty.ssn": { code: "E_INVALID", message: `ssn ${NINE_DIGITS} is not valid` },
  });
  expect(entry!.message).toContain("[redacted]");
  expect(entry!.message).not.toContain(NINE_DIGITS);
  expect(JSON.stringify(entry)).not.toContain(NINE_DIGITS);
});

test("NO VALUE, EVER: only `code` and `message` are read, whatever else doola echoes", () => {
  const value = "Operates a fleet of agents that sell the owner's products online";
  const summary = summarizeDoolaFields({
    description: {
      code: "E_FIELD_TOO_LONG",
      message: "size must be between 1 and 50",
      value,
      rejectedValue: value,
      invalidValue: value,
      input: { description: value },
    },
    // A bare string beside a field name is as likely to BE the value as a reason about it: the
    // path is kept, the string is not.
    "members[0].legalFirstName": value,
    "addresses[0]": [value],
  });
  expect(summary).toEqual([
    { field: "description", code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
    { field: "members[0].legalFirstName" },
    { field: "addresses[0]" },
  ]);
  expect(JSON.stringify(summary)).not.toContain(value);
});

test("LENGTH CAP: a long field message is cut to the cap and says it was cut", () => {
  const [entry] = summarizeDoolaFields({
    description: { code: "E_X", message: `${"long reason ".repeat(60)}` },
  });
  expect(entry!.message!.length).toBe(DOOLA_FIELD_MESSAGE_MAX);
  expect(entry!.message!.endsWith("...")).toBe(true);
  // Redacted BEFORE the cut: a run that straddles the cap is not left half visible. Cut first,
  // this would keep the run's first five digits, which no redactor would then recognise.
  const straddling = `${"x".repeat(DOOLA_FIELD_MESSAGE_MAX - 9)} ${NINE_DIGITS} tail`;
  const [cut] = summarizeDoolaFields({ description: { message: straddling } });
  expect(cut!.message).not.toMatch(/\d{3}/);
});

test("BOUNDED: at most DOOLA_FIELD_LIMIT fields, in doola's order", () => {
  const many = Object.fromEntries(
    Array.from({ length: DOOLA_FIELD_LIMIT + 5 }, (_, i) => [`field${i}`, { code: "E_X" }]),
  );
  const summary = summarizeDoolaFields(many);
  expect(summary).toHaveLength(DOOLA_FIELD_LIMIT);
  expect(summary[0]!.field).toBe("field0");
});

test("a malformed map is `[]`, never a throw: this runs on a filing's error path", () => {
  for (const junk of [undefined, null, "description", 42, ["description"], true])
    expect(summarizeDoolaFields(junk), String(junk)).toEqual([]);
  expect(summarizeDoolaFields({ description: null })).toEqual([{ field: "description" }]);
});

test("describeDoolaError names the fields in `message` and carries them as `fieldErrors`", () => {
  const described = describeDoolaError(
    new DoolaApiError("E_VALIDATION_FAILED", 400, "one or more fields are invalid", "req_1", {
      description: { code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
      "members[0].address.phone": { message: `bad number ${NINE_DIGITS}` },
    }),
  );
  // Paths and codes in the message, which is what reaches the step's error and the event trail.
  expect(described.message).toBe(
    "E_VALIDATION_FAILED: one or more fields are invalid (description: E_FIELD_TOO_LONG, members[0].address.phone)",
  );
  expect(described.code).toBe("E_VALIDATION_FAILED");
  expect(described.requestId).toBe("req_1");
  expect(described.fieldErrors).toEqual([
    { field: "description", code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
    { field: "members[0].address.phone", message: "bad number [redacted]" },
  ]);
  // doola's per-field SENTENCES stay out of the message: the ops line carries them, not the trail.
  expect(described.message).not.toContain("size must be");
});

test("describeDoolaError adds NO `fieldErrors` key when doola named no field", () => {
  const plain = describeDoolaError(new DoolaApiError("E_INTERNAL", 500, "doola is down", "req_2"));
  expect(plain).toEqual({
    message: "E_INTERNAL: doola is down",
    code: "E_INTERNAL",
    requestId: "req_2",
  });
  expect("fieldErrors" in plain).toBe(false);
  // …nor when every key it named was refused by the allowlist.
  const dropped = describeDoolaError(
    new DoolaApiError("E_VALIDATION_FAILED", 400, "invalid", undefined, { "a b": {} }),
  );
  expect("fieldErrors" in dropped).toBe(false);
  expect(dropped.message).toBe("E_VALIDATION_FAILED: invalid");
});

test("the clause is empty with no fields, and path-only where doola gave no code", () => {
  expect(fieldErrorsClause([])).toBe("");
  expect(fieldErrorsClause([{ field: "description" }, { field: "name", code: "E_X" }])).toBe(
    " (description, name: E_X)",
  );
});
