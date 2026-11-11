import { redactPii } from "../../formation/pii";

/**
 * doola's FIELD-LEVEL reason for a refusal, kept (2026-11-11).
 *
 * A validation failure comes back as `E_VALIDATION_FAILED: one or more fields are invalid`, and
 * the sentence that matters is one level down: doola's envelope carries `error.fields`, keyed by
 * the refused field, each with a `{code, message}` of its own. `DoolaApiError` always kept that
 * map, and nothing ever read it, so a filing refused for a 109-character `description` parked
 * with a log line that never said which field. This module is the one reader.
 *
 * It keeps three things per field and nothing else:
 *
 *  - the field PATH, only when it names a field of the body doola refused: its FIRST segment is
 *    a top-level property of that request (`DOOLA_COMPANY_REQUEST_FIELDS` or
 *    `DOOLA_CUSTOMER_REQUEST_FIELDS`), every later segment is `.name` (a letter, then letters,
 *    digits or `_`) or a short index `[0]`..`[99]`, the whole is at most 100 characters, and
 *    nothing `redactPii` would change. A character class alone let a VALUE used as a key through
 *    (`5551234567`, `john.smith`); a key must now be one of our own field names. A key outside
 *    the rule is dropped rather than repaired, and counted (`dropped`);
 *  - doola's per-field `code`, only when it reads as an identifier (`DOOLA_FIELD_CODE`: a
 *    letter, then letters, digits or `_`), so a number or a dotted name is never taken for one;
 *  - doola's per-field `message`, ONLY for a field of the company's own (`DOOLA_MESSAGE_FIELDS`)
 *    and never for any field of a refused customer (the responsible person's body), through
 *    `redactPii` and cut to `DOOLA_FIELD_MESSAGE_MAX`. Every other field keeps its path and code.
 *
 * NEVER a submitted value. doola may echo the value it refused under a key of its own (`value`,
 * `rejectedValue`, anything), and none of those is read: only `code` and `message` are. A field
 * whose detail is a bare string rather than an object is listed by its path alone, for the same
 * reason: a bare string beside a field name is as likely to be the value as a reason.
 *
 * Where each part may go is decided by the readers, not here: the ops line carries what is kept
 * (`fieldErrors`), the step's stored error names the path and the code, and the company view
 * carries the paths only (`park.refusedFields`).
 */

/** One field doola refused, as doola named it. Never the value that was sent. */
export interface DoolaFieldError {
  /** The field's path, as doola keyed it: `description`, `members[0].address.phone`. */
  field: string;
  /** doola's machine code for this field, when it gave one that reads as a code. */
  code?: string;
  /** doola's sentence for this field: redacted, and at most `DOOLA_FIELD_MESSAGE_MAX` long. */
  message?: string;
}

/**
 * The top-level properties of doola's `CreateCompanyRequest`, the body `POST /v1/partner/companies`
 * takes: `components.schemas.CreateCompanyRequest.properties` in the published OpenAPI document
 * (cited at the top of `types.ts`), read 2026-11-11. The first segment of a refused field's path
 * on a company refusal must be one of these.
 */
export const DOOLA_COMPANY_REQUEST_FIELDS: readonly string[] = [
  "addresses",
  "ccorpValuation",
  "description",
  "doolaCustomerId",
  "entityType",
  "executiveMembers",
  "industry",
  "members",
  "nameOptions",
  "requestedServices",
  "responsibleParty",
  "services",
  "state",
];

/**
 * The top-level properties of doola's `CreateCustomerRequestDto`, the body
 * `POST /v1/partner/customers` takes: `components.schemas.CreateCustomerRequestDto.properties` in
 * the same document, read 2026-11-11. The first segment of a refused field's path on a customer
 * refusal must be one of these.
 */
export const DOOLA_CUSTOMER_REQUEST_FIELDS: readonly string[] = [
  "countryOfResidence",
  "email",
  "firstName",
  "lastName",
  "phoneNumber",
];

/** A path's shape: a first segment, then `.name` or `[index]` segments. The first segment is
 *  then checked against the refused body's own fields. */
const DOOLA_FIELD_PATH = /^([A-Za-z][A-Za-z0-9_]*)(?:\.[A-Za-z][A-Za-z0-9_]*|\[\d{1,2}\])*$/;
/** The longest path we repeat. */
const DOOLA_FIELD_PATH_MAX = 100;
/** A per-field code we will repeat: an identifier, never a sentence, a number or a dotted name. */
const DOOLA_FIELD_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The longest per-field message an ops line carries. Longer is cut, and says so with "...". */
export const DOOLA_FIELD_MESSAGE_MAX = 160;
/** At most this many fields per refusal. doola's create body has about a dozen top-level fields. */
export const DOOLA_FIELD_LIMIT = 10;

/**
 * The fields whose doola MESSAGE we keep: the company's own, which carry no personal data.
 *
 * doola's per-field text can quote what was submitted, and for most of the create body that is
 * the responsible person: a name, an email, a phone number, an address line. `redactPii` removes
 * SSN shapes and nothing else, so it cannot make such a sentence safe for a log line. These
 * paths, and only these, describe the company itself:
 *
 *  - `description`, `industry`, `state`, `entityType`;
 *  - `nameOptions`, `nameOptions[i]`, and `nameOptions[i].name`, `.entityTypeEnding`, `.position`
 *    (the company's name candidates, never a person's name);
 *  - `requestedServices` and `services`, with any sub-path;
 *  - `addresses[i].provider` and `addresses[i].type`, and NOT `addresses[i].address.*`, whose
 *    lines can be a person's.
 *
 * Every other path (`responsibleParty.*`, `members.*`, any address line, email, phone, names,
 * ssn) keeps its path and code and loses the message. So does every field of a `createCustomer`
 * refusal, whatever its path: that whole body is the person (`summarizeDoolaFields`'s `body`).
 * A path missing from this list costs an operator one sentence; a path wrongly on it puts
 * somebody's data in journald, so it is narrow on purpose.
 */
export const DOOLA_MESSAGE_FIELDS: readonly RegExp[] = [
  /^(description|industry|state|entityType)$/,
  /^nameOptions(\[\d+\](\.(name|entityTypeEnding|position))?)?$/,
  /^(requestedServices|services)([.[][A-Za-z0-9_.[\]]*)?$/,
  /^addresses\[\d+\]\.(provider|type)$/,
];

/** Whether doola's message for this path may be kept (see `DOOLA_MESSAGE_FIELDS`). */
export function keepsDoolaFieldMessage(path: string): boolean {
  return DOOLA_MESSAGE_FIELDS.some((rule) => rule.test(path));
}

/**
 * Which body doola refused. `company` is the create body (and the default, for the reads that
 * share this reader): paths must start with one of `DOOLA_COMPANY_REQUEST_FIELDS`, and messages
 * are kept for `DOOLA_MESSAGE_FIELDS` only. `customer` is the responsible person's own body: paths
 * must start with one of `DOOLA_CUSTOMER_REQUEST_FIELDS`, and no message is kept for any field.
 */
export type DoolaRefusedBody = "company" | "customer";

const REQUEST_FIELDS: Record<DoolaRefusedBody, readonly string[]> = {
  company: DOOLA_COMPANY_REQUEST_FIELDS,
  customer: DOOLA_CUSTOMER_REQUEST_FIELDS,
};

/**
 * Whether a string may be repeated as a field path of the refused `body`: the path shape, a
 * first segment that is one of that body's own fields, the length bound, and nothing `redactPii`
 * would rewrite.
 *
 * Exported because the company view re-checks what it reads back from `detail`: the blob is a
 * column anyone with the database can write, and the view's rule is that it carries field names
 * and codes, never free text.
 */
export function isDoolaFieldPath(
  path: unknown,
  body: DoolaRefusedBody = "company",
): path is string {
  if (typeof path !== "string" || path.length > DOOLA_FIELD_PATH_MAX) return false;
  const first = DOOLA_FIELD_PATH.exec(path)?.[1];
  return first !== undefined && REQUEST_FIELDS[body].includes(first) && redactPii(path) === path;
}

function isFieldCode(code: unknown): code is string {
  return typeof code === "string" && DOOLA_FIELD_CODE.test(code) && redactPii(code) === code;
}

/** Redact FIRST, then cut: cutting first could leave the first digits of an SSN at the end of the
 *  kept text, too short for the redactor to recognise and still the start of the number. */
function boundedMessage(raw: string): string | undefined {
  const text = redactPii(raw.trim());
  if (!text) return undefined;
  if (text.length <= DOOLA_FIELD_MESSAGE_MAX) return text;
  return `${text.slice(0, DOOLA_FIELD_MESSAGE_MAX - 3)}...`;
}

/**
 * How many entries doola sent that we did not keep: a malformed map counts what it held (an
 * array its length, any other non-object value one), a kept map counts every key the path rule
 * refused and every key past `DOOLA_FIELD_LIMIT`. Zero means nothing was left out.
 */
function malformedCount(fields: unknown): number {
  if (fields === undefined || fields === null) return 0;
  return Array.isArray(fields) ? fields.length : 1;
}

/**
 * Read doola's `error.fields` into at most `DOOLA_FIELD_LIMIT` entries, in doola's order, and
 * COUNT what was left out (`dropped`), so a refusal whose every key was refused still says that
 * doola named some.
 *
 * Takes `unknown` because the map is a partner surface we do not control: anything that is not
 * a plain object of field entries yields no entries, never a throw, since this runs on the error
 * path of a filing and must not become the reason that path fails.
 */
export function readDoolaFields(
  fields: unknown,
  opts: { body?: DoolaRefusedBody } = {},
): { fieldErrors: DoolaFieldError[]; dropped: number } {
  const body = opts.body ?? "company";
  const personBody = body === "customer";
  if (!fields || typeof fields !== "object" || Array.isArray(fields))
    return { fieldErrors: [], dropped: malformedCount(fields) };
  const out: DoolaFieldError[] = [];
  let dropped = 0;
  for (const [path, detail] of Object.entries(fields as Record<string, unknown>)) {
    if (out.length >= DOOLA_FIELD_LIMIT || !isDoolaFieldPath(path, body)) {
      dropped++;
      continue;
    }
    const entry: DoolaFieldError = { field: path };
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      // `code` and `message` ONLY. Any other key, a `value` above all, is never read.
      const { code, message } = detail as { code?: unknown; message?: unknown };
      if (isFieldCode(code)) entry.code = code;
      // The message only for the company's own fields, and never from the person's body.
      if (!personBody && keepsDoolaFieldMessage(path)) {
        const bounded = typeof message === "string" ? boundedMessage(message) : undefined;
        if (bounded) entry.message = bounded;
      }
    }
    out.push(entry);
  }
  return { fieldErrors: out, dropped };
}

/** `readDoolaFields`'s entries alone, for the readers that need no count. */
export function summarizeDoolaFields(
  fields: unknown,
  opts: { body?: DoolaRefusedBody } = {},
): DoolaFieldError[] {
  return readDoolaFields(fields, opts).fieldErrors;
}

/**
 * The fields as a clause for a step's stored error: ` (description: E_FIELD_TOO_LONG, name)`.
 *
 * Paths and codes only. doola's per-field sentences stay on the ops line: the error column
 * reaches the company's event trail, and a code is enough there to say what was refused.
 */
export function fieldErrorsClause(fieldErrors: readonly DoolaFieldError[]): string {
  if (fieldErrors.length === 0) return "";
  return ` (${fieldErrors.map((f) => (f.code ? `${f.field}: ${f.code}` : f.field)).join(", ")})`;
}
