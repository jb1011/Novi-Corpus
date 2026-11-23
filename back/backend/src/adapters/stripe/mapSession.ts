import type { DocumentType, Liveness } from "../../identity/types";
import { alpha3Of } from "./countries";

/**
 * Stripe's VerificationSession, read into the adapter's own shape, and that shape mapped to the
 * one outcome the identity session service acts on (identity check plan, Task 4). Pure: no
 * network, no clock, no database.
 *
 * What is read is a closed list, and everything else in Stripe's answer is left where it lies:
 * `id`, `livemode`, `status`, `client_reference_id`, `url`, `last_error.code` (never its
 * `reason`, a sentence that can quote the document), `redaction.status`, the extracted first and
 * last name and the birth date, and from the last verification report its id, its creation time,
 * the document's type and issuing country and the selfie's status. The address, the document
 * number, the file ids and the client secret ride in the same JSON and are never copied out.
 *
 * Stripe's extracted names are carried only as far as the comparison with the name the guardian
 * typed (the name of record is the guardian's own; Stripe's data is not passed on).
 */

export { alpha3Of };

export type ProviderSessionStatus = "requires_input" | "processing" | "verified" | "canceled";

/** One Stripe VerificationSession, as the adapter reads it. */
export type ProviderSession = {
  /** Stripe's session id, `vs_...`: the row's `provider_ref`. */
  id: string;
  livemode: boolean;
  status: ProviderSessionStatus;
  /** Ours: the identity session id, sent at create and echoed back. */
  clientReferenceId: string | null;
  /**
   * The short-lived URL the person opens (Stripe: never stored, never logged, shown only to the
   * person). Present while the session waits for the person; null otherwise.
   */
  url: string | null;
  /** `last_error.code` only. */
  lastErrorCode: string | null;
  redaction: "processing" | "redacted" | null;
  outputs: {
    firstName: string;
    lastName: string;
    /** Null when the read did not expand it (ruling R3) or Stripe did not serve it. */
    dob: { year: number; month: number; day: number } | null;
  } | null;
  report: {
    /** `vr_...`: each attempt makes a new report, so it also counts attempts (ruling R5). */
    id: string;
    /** Unix SECONDS, as Stripe sends it. */
    created: number;
    documentType: "passport" | "id_card" | "driving_license" | null;
    /** ISO 3166-1 alpha-2, upper case, as Stripe sends it. */
    issuingCountry: string | null;
    selfieStatus: "verified" | "unverified" | null;
  } | null;
};

/** What a session means for the identity record. */
export type ProviderOutcome =
  | { kind: "pending" }
  | { kind: "attempt_failed"; code: string; final: boolean }
  | { kind: "canceled" }
  | {
      kind: "verified";
      /** Stripe's extracted names: compared with the typed names, then dropped. */
      names: { first: string; last: string };
      /** `YYYY-MM-DD`, or null when it was not read. Handed to the screen, never stored. */
      dob: string | null;
      /** ISO 3166-1 alpha-3, or null when the document's country is not an assigned code. */
      country: string | null;
      documentType: DocumentType | null;
      liveness: Liveness;
      reportId: string;
      /** Unix MILLISECONDS: the report's creation. */
      completedAt: number;
    };

/**
 * A session the adapter cannot read, or a read that has no outcome. The message names the field
 * and never its value: a value in a session can be a person's.
 */
export class UnreadableSession extends Error {
  constructor(
    readonly field: string,
    detail = "cannot be read",
  ) {
    super(`Stripe verification session: ${field} ${detail}`);
    this.name = "UnreadableSession";
  }
}

/**
 * Stripe's ids: a prefix and an alphanumeric body. Checked, not only typed, because the client
 * puts a session id into a request path: a value with a `/` or `..` in it is never a session.
 */
export const STRIPE_SESSION_ID = /^vs_[A-Za-z0-9]{1,250}$/;
const STRIPE_REPORT_ID = /^vr_[A-Za-z0-9]{1,250}$/;
/** Stripe's machine codes are snake_case (`document_expired`, `selfie_face_mismatch`). */
const STRIPE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

const STATUSES: readonly ProviderSessionStatus[] = [
  "requires_input",
  "processing",
  "verified",
  "canceled",
];
const DOCUMENT_TYPES = ["passport", "id_card", "driving_license"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read one VerificationSession, as JSON already parsed.
 *
 * THROWS `UnreadableSession` on a shape it cannot read: the session's identity and state (`id`,
 * `object`, `livemode`, `status`, `redaction`) and the fields whose meaning would change if they
 * were guessed (`client_reference_id`, `url`, `last_error.code`, an expanded report's id and
 * time). The facts are read leniently instead: a document type Stripe adds later is null, an
 * issuing country that is not two letters is null, a birth date with a missing or impossible part
 * is null, names that are absent leave `outputs` null. Each null is visible to the caller.
 *
 * A session under redaction (`redaction` set) keeps its id, mode, status and reference, and
 * nothing else is read: Stripe replaces its personal fields with placeholders, which are not
 * facts, and a placeholder the parser refused would stop the redaction from ever being recorded.
 */
export function parseProviderSession(json: unknown): ProviderSession {
  if (!isRecord(json)) throw new UnreadableSession("session");
  if (json.object !== undefined && json.object !== "identity.verification_session")
    throw new UnreadableSession("object");
  const { id, livemode, status } = json;
  if (typeof id !== "string" || !STRIPE_SESSION_ID.test(id)) throw new UnreadableSession("id");
  if (typeof livemode !== "boolean") throw new UnreadableSession("livemode");
  if (typeof status !== "string" || !STATUSES.includes(status as ProviderSessionStatus))
    throw new UnreadableSession("status");
  const redaction = readRedaction(json.redaction);
  const base = { id, livemode, status: status as ProviderSessionStatus, redaction };

  if (redaction !== null) {
    const ref = json.client_reference_id;
    return {
      ...base,
      clientReferenceId: typeof ref === "string" ? ref : null,
      url: null,
      lastErrorCode: null,
      outputs: null,
      report: null,
    };
  }

  return {
    ...base,
    clientReferenceId: readClientReference(json.client_reference_id),
    url: readUrl(json.url),
    lastErrorCode: readLastErrorCode(json.last_error),
    outputs: readOutputs(json.verified_outputs),
    report: readReport(json.last_verification_report),
  };
}

function readRedaction(v: unknown): ProviderSession["redaction"] {
  if (v === undefined || v === null) return null;
  if (!isRecord(v) || (v.status !== "processing" && v.status !== "redacted"))
    throw new UnreadableSession("redaction.status");
  return v.status;
}

function readClientReference(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new UnreadableSession("client_reference_id");
  return v;
}

/** The person is sent to this URL, so it must be an https URL, nothing else. */
function readUrl(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new UnreadableSession("url");
  let protocol: string;
  try {
    protocol = new URL(v).protocol;
  } catch {
    throw new UnreadableSession("url");
  }
  if (protocol !== "https:") throw new UnreadableSession("url");
  return v;
}

/** The code, never the reason. */
function readLastErrorCode(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) throw new UnreadableSession("last_error");
  const code = v.code;
  if (code === undefined || code === null) return null;
  if (typeof code !== "string" || !STRIPE_CODE.test(code))
    throw new UnreadableSession("last_error.code");
  return code;
}

function readOutputs(v: unknown): ProviderSession["outputs"] {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) throw new UnreadableSession("verified_outputs");
  const first = v.first_name;
  const last = v.last_name;
  if (typeof first !== "string" || typeof last !== "string") return null;
  if (first.trim() === "" || last.trim() === "") return null;
  return { firstName: first, lastName: last, dob: readDob(v.dob) };
}

/** A four-digit year, a month, and a day that exists in that month; anything else is null. */
function readDob(v: unknown): { year: number; month: number; day: number } | null {
  if (!isRecord(v)) return null;
  const { year, month, day } = v;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number") return null;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return { year, month, day };
}

/** An unexpanded report (its id only) reads as no report: the client always expands it. */
function readReport(v: unknown): ProviderSession["report"] {
  if (v === undefined || v === null || typeof v === "string") return null;
  if (!isRecord(v)) throw new UnreadableSession("last_verification_report");
  const { id, created, document, selfie } = v;
  if (typeof id !== "string" || !STRIPE_REPORT_ID.test(id))
    throw new UnreadableSession("last_verification_report.id");
  if (typeof created !== "number" || !Number.isSafeInteger(created) || created <= 0)
    throw new UnreadableSession("last_verification_report.created");
  const doc = isRecord(document) ? document : null;
  const type = doc?.type;
  const country = doc?.issuing_country;
  const selfieStatus = isRecord(selfie) ? selfie.status : undefined;
  return {
    id,
    created,
    documentType: DOCUMENT_TYPES.find((t) => t === type) ?? null,
    issuingCountry:
      typeof country === "string" && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null,
    selfieStatus:
      selfieStatus === "verified" || selfieStatus === "unverified" ? selfieStatus : null,
  };
}

/** The codes that end a session at once: no retry on the same session can change them. */
const FINAL_CODES: ReadonlySet<string> = new Set([
  "consent_declined",
  "under_supported_age",
  "country_not_supported",
]);

/** Stripe's document types to the record's. */
const DOCUMENT_TYPE_OF: Readonly<
  Record<NonNullable<NonNullable<ProviderSession["report"]>["documentType"]>, DocumentType>
> = {
  passport: "passport",
  id_card: "identity_card",
  driving_license: "driving_licence",
};

function isoDate(d: { year: number; month: number; day: number }): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

/**
 * The outcome of one read.
 *
 * - `verified`: the document's facts (the birth date as `YYYY-MM-DD` or null, the alpha-3
 *   country, the record's document type, the liveness from the selfie, the report's id and its
 *   creation as the completion time).
 * - `requires_input` with an error code: a failed attempt, `final` for a code no retry can change.
 * - `requires_input` without one (nobody has tried yet) and `processing`: pending.
 * - `canceled`: canceled.
 *
 * THROWS `UnreadableSession` for a session under redaction (its fields are placeholders, not
 * facts: the caller handles the redaction before asking for an outcome) and for a verified session
 * read without its outputs or its report (nothing could be recorded from it).
 */
export function outcomeOf(s: ProviderSession): ProviderOutcome {
  if (s.redaction !== null)
    throw new UnreadableSession("redaction", "is set: a session under redaction has no outcome");
  switch (s.status) {
    case "processing":
      return { kind: "pending" };
    case "canceled":
      return { kind: "canceled" };
    case "requires_input":
      return s.lastErrorCode === null
        ? { kind: "pending" }
        : {
            kind: "attempt_failed",
            code: s.lastErrorCode,
            final: FINAL_CODES.has(s.lastErrorCode),
          };
    case "verified": {
      const { outputs, report } = s;
      if (outputs === null) throw new UnreadableSession("verified_outputs");
      if (report === null) throw new UnreadableSession("last_verification_report");
      return {
        kind: "verified",
        names: { first: outputs.firstName, last: outputs.lastName },
        dob: outputs.dob === null ? null : isoDate(outputs.dob),
        country: report.issuingCountry === null ? null : alpha3Of(report.issuingCountry),
        documentType: report.documentType === null ? null : DOCUMENT_TYPE_OF[report.documentType],
        liveness:
          report.selfieStatus === "verified"
            ? "passed"
            : report.selfieStatus === "unverified"
              ? "failed"
              : "not_run",
        reportId: report.id,
        completedAt: report.created * 1000,
      };
    }
  }
}
