/**
 * doola's FIELD-LEVEL reason, read by ONE function (`summarizeDoolaFields`), and what of it
 * `describeDoolaError` hands every ops line and every stored step error.
 *
 * The properties pinned here are the ones a looser reader would lose quietly:
 *  - a field path is repeated only when its first segment is one of the refused request's own
 *    fields and the rest is `.name` or `[i]` segments (at most 100 characters, nothing
 *    SSN-shaped), and a code only when it is an identifier;
 *  - every entry left out is counted;
 *  - a refused customer's top-level sentence is withheld;
 *  - doola's per-field message is kept only for the company's own fields (`DOOLA_MESSAGE_FIELDS`),
 *    never for any field of a refused customer, and is redacted, then capped;
 *  - a submitted value is NEVER read, whatever key doola echoes it under;
 *  - the result is bounded, and a malformed map is `[]`, never a throw.
 *
 * Every value here is an invention. The nine-digit run is the shape the redactor exists for.
 */
import { expect, test } from "vitest";
import {
  CUSTOMER_TEXT_WITHHELD,
  DoolaApiError,
  describeDoolaError,
} from "../../../src/adapters/doola/doolaClient";
import {
  DOOLA_FIELD_LIMIT,
  DOOLA_FIELD_MESSAGE_MAX,
  fieldErrorsClause,
  isDoolaFieldPath,
  keepsDoolaFieldMessage,
  readDoolaFields,
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

test("PATH RULE: a path is one of the refused body's OWN fields, then `.name` or `[i]` segments", () => {
  for (const ok of [
    "description",
    "nameOptions[1].name",
    "members[0].address.phone",
    "responsibleParty.address.postalCode",
    "requestedServices[0].variant",
    "addresses[1].provider",
    "executiveMembers[0].legalLastName",
  ])
    expect(isDoolaFieldPath(ok), ok).toBe(true);
  for (const ok of ["email", "phoneNumber", "firstName", "lastName", "countryOfResidence"])
    expect(isDoolaFieldPath(ok, "customer"), ok).toBe(true);

  for (const bad of [
    "",
    "has space",
    "person@example.test",
    "a;b",
    "a-b",
    "a/b",
    "name\nnext",
    "Café",
    `description.${"x".repeat(100)}`,
    // Not a field of the company request at all.
    "Q16",
    "requested_services",
    "descriptionX",
    "email",
    // Legal by a character class alone, and exactly what must never be repeated.
    NINE_DIGITS,
    `members[${NINE_DIGITS}]`,
    "members[123].name",
    "description.5551234567",
    "nameOptions..name",
    "nameOptions[0]name",
  ])
    expect(isDoolaFieldPath(bad), JSON.stringify(bad)).toBe(false);

  // Each body has its own fields: the person's are not the company's, and the reverse.
  expect(isDoolaFieldPath("description", "customer")).toBe(false);
  expect(isDoolaFieldPath("phoneNumber", "company")).toBe(false);

  // A refused key is DROPPED, not repaired: its neighbours still come through.
  expect(
    summarizeDoolaFields({
      "has space": { code: "E_X", message: "m" },
      [NINE_DIGITS]: { code: "E_X", message: "m" },
      description: { code: "E_FIELD_TOO_LONG" },
    }),
  ).toEqual([{ field: "description", code: "E_FIELD_TOO_LONG" }]);
});

test("a VALUE used as a key or a code is dropped: phone numbers, an EIN, a dotted name", () => {
  // Shapes a character class would let through, and that are a person's or a company's data.
  const values = ["5551234567", "555-123-4567", "12-3456789", "john.smith"];
  for (const v of values) {
    expect(isDoolaFieldPath(v), v).toBe(false);
    expect(isDoolaFieldPath(v, "customer"), v).toBe(false);
  }
  // As keys: every one is dropped and counted, and nothing of it is repeated.
  const asKeys = readDoolaFields(Object.fromEntries(values.map((v) => [v, { code: "E_X" }])));
  expect(asKeys).toEqual({ fieldErrors: [], dropped: values.length });
  // As codes on a known path: the path stays, the code goes.
  for (const v of values) {
    expect(summarizeDoolaFields({ description: { code: v } }), v).toEqual([
      { field: "description" },
    ]);
    expect(summarizeDoolaFields({ email: { code: v } }, { body: "customer" }), v).toEqual([
      { field: "email" },
    ]);
  }
  // An identifier still passes.
  for (const code of ["E_FIELD_TOO_LONG", "Size", "NotBlank", "E_INVALID_PHONE"])
    expect(summarizeDoolaFields({ description: { code } }), code).toEqual([
      { field: "description", code },
    ]);
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

test("BOUNDED: at most DOOLA_FIELD_LIMIT fields, in doola's order, and the rest COUNTED", () => {
  const many = Object.fromEntries(
    Array.from({ length: DOOLA_FIELD_LIMIT + 5 }, (_, i) => [
      `members[${i}].ownershipPercent`,
      { code: "E_X" },
    ]),
  );
  const { fieldErrors, dropped } = readDoolaFields(many);
  expect(fieldErrors).toHaveLength(DOOLA_FIELD_LIMIT);
  expect(fieldErrors[0]!.field).toBe("members[0].ownershipPercent");
  expect(dropped).toBe(5);
});

test("DROPPED keys are counted: the path rule, the bound and a malformed map", () => {
  expect(readDoolaFields({ description: { code: "E_X" }, "a b": {}, john: {} })).toEqual({
    fieldErrors: [{ field: "description", code: "E_X" }],
    dropped: 2,
  });
  expect(readDoolaFields(undefined).dropped).toBe(0);
  expect(readDoolaFields(null).dropped).toBe(0);
  expect(readDoolaFields({}).dropped).toBe(0);
  expect(readDoolaFields("description").dropped).toBe(1);
  expect(readDoolaFields(["description", "industry"]).dropped).toBe(2);
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

test("a refused CUSTOMER keeps no message at all, and only the customer request's own paths", () => {
  const fields = {
    email: { code: "E_EMAIL", message: "ada@example.com is not a valid email" },
    phoneNumber: { code: "E_PHONE", message: "+12125550100 is not a phone number" },
    // Not a field of the customer request: dropped, and counted.
    description: { code: "E_X", message: "whatever doola said" },
  };
  expect(readDoolaFields(fields, { body: "customer" })).toEqual({
    fieldErrors: [
      { field: "email", code: "E_EMAIL" },
      { field: "phoneNumber", code: "E_PHONE" },
    ],
    dropped: 1,
  });
});

test("a refused CUSTOMER's top-level sentence is WITHHELD: the code and the field paths stay", () => {
  const described = describeDoolaError(
    new DoolaApiError(
      "E_VALIDATION_FAILED",
      400,
      "customer with email ada@example.com and phone +12125550100 already exists",
      "req_c",
      {
        email: { code: "E_EMAIL", message: "ada@example.com is taken" },
        "a b": {},
      },
    ),
    { body: "customer" },
  );
  expect(described).toEqual({
    message: `E_VALIDATION_FAILED: ${CUSTOMER_TEXT_WITHHELD} (email: E_EMAIL)`,
    code: "E_VALIDATION_FAILED",
    requestId: "req_c",
    fieldErrors: [{ field: "email", code: "E_EMAIL" }],
    fieldErrorsDropped: 1,
  });
  for (const quoted of ["ada@example.com", "+12125550100", "already exists"])
    expect(JSON.stringify(described), quoted).not.toContain(quoted);

  // The COMPANY body keeps doola's sentence, as before.
  const company = describeDoolaError(
    new DoolaApiError("E_VALIDATION_FAILED", 400, "one or more fields are invalid"),
  );
  expect(company.message).toBe("E_VALIDATION_FAILED: one or more fields are invalid");
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
