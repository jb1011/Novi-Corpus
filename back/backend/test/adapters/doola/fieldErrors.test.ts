/**
 * doola's FIELD-LEVEL reason, read by ONE function (`summarizeDoolaFields`), and what of it
 * `describeDoolaError` hands every ops line and every stored step error.
 *
 * The properties pinned here are the ones a looser reader would lose quietly:
 *  - a field path is repeated only when it passes the allowlist (letters, digits, `_`, `.`, `[`,
 *    `]`, at most 100 characters, nothing SSN-shaped);
 *  - doola's per-field message is kept only for the company's own fields (`DOOLA_MESSAGE_FIELDS`),
 *    never for any field of a refused customer, and is redacted, then capped;
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
  keepsDoolaFieldMessage,
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

test("REDACTION: a nine-digit run in a kept field's message never survives", () => {
  const [entry] = summarizeDoolaFields({
    description: { code: "E_INVALID", message: `reference ${NINE_DIGITS} is not valid` },
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

test("MESSAGES: kept for the company's own fields, dropped (path and code kept) for a person's", () => {
  const summary = summarizeDoolaFields({
    description: { code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
    "nameOptions[0].name": { code: "E_NAME", message: "name is not available" },
    "addresses[1].provider": { code: "E_PROVIDER", message: "provider must be registeredAgent" },
    "requestedServices[0].variant": { code: "E_VARIANT", message: "variant is not offered" },
    "responsibleParty.email": { code: "E_EMAIL", message: "ada@example.com is not a valid email" },
    "members[0].legalFirstName": { code: "E_NAME", message: "Ada contains invalid characters" },
    "addresses[0].address.line1": {
      code: "E_LINE",
      message: "1 Analytical Way is not deliverable",
    },
    "responsibleParty.ssn": { code: "E_INVALID", message: `ssn ${NINE_DIGITS} is not valid` },
  });
  expect(summary).toEqual([
    { field: "description", code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
    { field: "nameOptions[0].name", code: "E_NAME", message: "name is not available" },
    {
      field: "addresses[1].provider",
      code: "E_PROVIDER",
      message: "provider must be registeredAgent",
    },
    { field: "requestedServices[0].variant", code: "E_VARIANT", message: "variant is not offered" },
    { field: "responsibleParty.email", code: "E_EMAIL" },
    { field: "members[0].legalFirstName", code: "E_NAME" },
    { field: "addresses[0].address.line1", code: "E_LINE" },
    { field: "responsibleParty.ssn", code: "E_INVALID" },
  ]);
  const printed = JSON.stringify(summary);
  for (const quoted of ["ada@example.com", "Ada contains", "Analytical", NINE_DIGITS])
    expect(printed, quoted).not.toContain(quoted);
});

test("the message allowlist: exactly the company's own paths, and nothing that merely looks close", () => {
  for (const kept of [
    "description",
    "industry",
    "state",
    "entityType",
    "nameOptions",
    "nameOptions[2]",
    "nameOptions[0].name",
    "nameOptions[1].entityTypeEnding",
    "nameOptions[0].position",
    "requestedServices",
    "requestedServices[0]",
    "requestedServices[0].service",
    "services",
    "services[0].status",
    "addresses[0].provider",
    "addresses[1].type",
  ])
    expect(keepsDoolaFieldMessage(kept), kept).toBe(true);
  for (const dropped of [
    "responsibleParty",
    "responsibleParty.email",
    "responsibleParty.address.phone",
    "members",
    "members[0].legalLastName",
    "addresses",
    "addresses[0]",
    "addresses[0].address",
    "addresses[0].address.line1",
    "addresses[0].address.phone",
    "nameOptions[0].other",
    "descriptionX",
    "servicesX",
    "email",
    "phone",
    "ssn",
    "doolaCustomerId",
  ])
    expect(keepsDoolaFieldMessage(dropped), dropped).toBe(false);
});

test("a refused CUSTOMER keeps no message at all, even on a path the company list allows", () => {
  const fields = {
    email: { code: "E_EMAIL", message: "ada@example.com is not a valid email" },
    phoneNumber: { code: "E_PHONE", message: "+12125550100 is not a phone number" },
    // The customer body has no such field; if doola ever named one, the body still wins.
    description: { code: "E_X", message: "whatever doola said" },
  };
  expect(summarizeDoolaFields(fields, { body: "customer" })).toEqual([
    { field: "email", code: "E_EMAIL" },
    { field: "phoneNumber", code: "E_PHONE" },
    { field: "description", code: "E_X" },
  ]);
  const described = describeDoolaError(
    new DoolaApiError(
      "E_VALIDATION_FAILED",
      400,
      "one or more fields are invalid",
      "req_c",
      fields,
    ),
    { body: "customer" },
  );
  expect(described.fieldErrors!.every((f) => f.message === undefined)).toBe(true);
  expect(described.message).toBe(
    "E_VALIDATION_FAILED: one or more fields are invalid (email: E_EMAIL, phoneNumber: E_PHONE, description: E_X)",
  );
  expect(JSON.stringify(described)).not.toContain("ada@example.com");
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
    // A person's field: the path survives, doola's sentence about it does not.
    { field: "members[0].address.phone" },
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
