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
 *  - the field PATH, only when it passes `DOOLA_FIELD_PATH`: letters, digits, `_`, `.`, `[` and
 *    `]`, at most 100 characters, and nothing `redactPii` would change. That is the vocabulary of
 *    a field name in OUR request body (`description`, `members[0].address.phone`). A key outside
 *    it is dropped rather than repaired: a key we cannot read as a field name is not one we
 *    repeat;
 *  - doola's per-field `code`, only when it reads as a machine code (`DOOLA_FIELD_CODE`);
 *  - doola's per-field `message`, through `redactPii` and cut to `DOOLA_FIELD_MESSAGE_MAX`.
 *
 * NEVER a submitted value. doola may echo the value it refused under a key of its own (`value`,
 * `rejectedValue`, anything), and none of those is read: only `code` and `message` are. A field
 * whose detail is a bare string rather than an object is listed by its path alone, for the same
 * reason: a bare string beside a field name is as likely to be the value as a reason.
 *
 * Where each part may go is decided by the readers, not here: the ops line carries all three
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

/** A field path we will repeat. See the module comment for why it is this narrow. */
const DOOLA_FIELD_PATH = /^[A-Za-z0-9_.[\]]{1,100}$/;
/** A per-field code we will repeat: an identifier, never a sentence. */
const DOOLA_FIELD_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** The longest per-field message an ops line carries. Longer is cut, and says so with "...". */
export const DOOLA_FIELD_MESSAGE_MAX = 160;
/** At most this many fields per refusal. doola's create body has about a dozen top-level fields. */
export const DOOLA_FIELD_LIMIT = 10;

/**
 * Whether a string may be repeated as a field path: the allowlist, and nothing `redactPii` would
 * rewrite (a nine-digit run is a legal path by the character class alone).
 *
 * Exported because the company view re-checks what it reads back from `detail`: the blob is a
 * column anyone with the database can write, and the view's rule is that it carries field names
 * and codes, never free text.
 */
export function isDoolaFieldPath(path: unknown): path is string {
  return typeof path === "string" && DOOLA_FIELD_PATH.test(path) && redactPii(path) === path;
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
 * Read doola's `error.fields` into at most `DOOLA_FIELD_LIMIT` entries, in doola's order.
 *
 * Takes `unknown` because the map is a partner surface we do not control: anything that is not
 * a plain object of field entries yields `[]`, never a throw, since this runs on the error path
 * of a filing and must not become the reason that path fails.
 */
export function summarizeDoolaFields(fields: unknown): DoolaFieldError[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  const out: DoolaFieldError[] = [];
  for (const [path, detail] of Object.entries(fields as Record<string, unknown>)) {
    if (out.length >= DOOLA_FIELD_LIMIT) break;
    if (!isDoolaFieldPath(path)) continue;
    const entry: DoolaFieldError = { field: path };
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      // `code` and `message` ONLY. Any other key, a `value` above all, is never read.
      const { code, message } = detail as { code?: unknown; message?: unknown };
      if (isFieldCode(code)) entry.code = code;
      const bounded = typeof message === "string" ? boundedMessage(message) : undefined;
      if (bounded) entry.message = bounded;
    }
    out.push(entry);
  }
  return out;
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
