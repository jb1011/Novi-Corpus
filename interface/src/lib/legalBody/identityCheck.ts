import {
  ApiError,
  GUARDIAN_IDENTITY_STATES,
  type GuardianIdentityState,
  type GuardianIdentityView,
  type IdentitySessionView,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";

/**
 * The identity check card, decided as data. World ID proves one real person; the identity check
 * says who. The card derives from the server's two reads (the identity record of
 * `GET /world-id/me` and the open session of `GET /identity-check/session`), never from what a
 * sync answered, so a webhook, the server's job or another tab that moves the check is seen the
 * same way. This module holds the rules and the sentences: no clock, no storage, no request.
 *
 * On these reads `required` is true exactly on production (the server's `identityView`), so the
 * words tell a production check from a test check by it.
 */

const A = LEGAL_BODY_COPY.human.guardianIdentity.automatic;
const G = LEGAL_BODY_COPY.human.guardianIdentity;

/* ── The constants ─────────────────────────────────────────────────────────────────────────── */

/** The query the server puts on the address it sends the person back to:
 *  `{origin}{returnPath}?identityCheck=returned`. */
export const IDENTITY_RETURN_PARAM = "identityCheck";
export const IDENTITY_RETURN_VALUE = "returned";
/** The pages that host the card. Each is a path the server's `RETURN_PATH` takes. */
export type IdentityReturnPath = "/start" | "/legal-body";
export const GUARDIAN_NOTICE_URL = "https://docs.novicorpus.com/policies/guardian-notice/";
/** A verified record may be renewed within this window before it expires: the server's
 *  `RENEWAL_WINDOW_MS`. */
export const RENEWAL_WINDOW_MS = 90 * 86_400_000;
/** While the provider is processing: the two reads this often, a read at the provider every
 *  `READ_SYNC_EVERY_MS`, for `READ_WINDOW_MS` in all. */
export const READ_POLL_MS = 5_000;
export const READ_SYNC_EVERY_MS = 20_000;
export const READ_WINDOW_MS = 180_000;
/** The server answers a second sync within this long `identity_sync_too_soon`: the server's
 *  `IDENTITY_SYNC_MIN_INTERVAL_MS`. */
export const SYNC_MIN_INTERVAL_MS = 5_000;

/* ── The card's state ──────────────────────────────────────────────────────────────────────── */

/** The open session as its query reports it. */
export type SessionRead = IdentitySessionView | "loading" | "unreadable";
/** The read-back of an open session when the card mounts: under way, done, or refused. */
export type Arrival = "pending" | "done" | "failed";

export type IdentityCardKind =
  | "locked"
  | "loading"
  | "unreadable"
  | "start"
  | "start_again"
  | "expired"
  | "revoked"
  | "continue"
  | "retry"
  | "reading"
  | "finishing"
  | "review"
  | "verified"
  | "renewal_due";

export type AutomaticCardView = {
  kind: IdentityCardKind;
  /** A verified record counts, whatever the session is doing. */
  counts: boolean;
  required: boolean;
  /** The record's date, when it counts. */
  verifiedAt: number | null;
  /** When a record in its renewal window is due. */
  dueAt: number | null;
  /** For a retry: the attempts the session has left, and the provider's code of the last one. */
  attemptsLeft: number | null;
  errorCode: string | null;
};

export type IdentityCardView =
  | { kind: "hidden" }
  | { kind: "operator"; state: GuardianIdentityState; verifiedAt: number | null }
  | AutomaticCardView;

/**
 * The card's state, first match wins:
 *  1. no identity block, or neither required nor offered automatically: no card;
 *  2. required, and not automatic: the operator's card, as today;
 *     a state this build does not know, or none: unreadable, whatever the other inputs say;
 *  3. World ID not accepted: locked;
 *  4. the session not read yet, or unreadable;
 *  5. a record under review, whatever the session says;
 *  6. an open session held: for an operator (review) or by the server's own screen (finishing);
 *  7. an open session not held, while its read-back is under way or refused;
 *  8. an open session the provider is processing;
 *  9. an open session whose last attempt failed, with attempts left: retry;
 * 10. any other open session: continue;
 * 11. no session, a record in its renewal window: renewal due, or review when the start said so;
 * 12. no session, a record verified;
 * 13. no session, by the record's state.
 * The start's refusal counts only in row 11: everywhere else the two reads already say it.
 */
export function identityCardView(p: {
  identity: GuardianIdentityView | null | undefined;
  worldAccepted: boolean;
  session: SessionRead;
  arrival: Arrival;
  startRefused: string | null;
  nowMs: number;
}): IdentityCardView {
  const identity = p.identity;
  const automatic = identity?.automatic === true;
  if (!identity || (identity.required !== true && !automatic)) return { kind: "hidden" };
  const counts = identity.state === "verified";
  const verifiedAt = counts ? (identity.verifiedAt ?? null) : null;
  if (!automatic) return { kind: "operator", state: identity.state, verifiedAt };

  const base = {
    counts,
    required: identity.required === true,
    verifiedAt,
    dueAt: null,
    attemptsLeft: null,
    errorCode: null,
  };
  const card = (kind: IdentityCardKind, over: Partial<AutomaticCardView> = {}): AutomaticCardView => ({
    ...base,
    ...over,
    kind,
  });

  // `/world-id/me` is cast, not parsed: a state this build does not know, or none at all, reads
  // as unreadable before any other input is looked at, never as no card at all.
  if (!(GUARDIAN_IDENTITY_STATES as readonly unknown[]).includes(identity.state))
    return card("unreadable");
  if (!p.worldAccepted) return card("locked");
  const session = p.session;
  if (session === "loading" || session === "unreadable") return card(session);
  if (identity.state === "needs_review") return card("review");

  if (session.status === "open") {
    if (session.held === "operator") return card("review");
    if (session.held === "system") return card("finishing");
    if (p.arrival === "pending") return card("loading");
    if (p.arrival === "failed") return card("unreadable");
    if (session.reading) return card("reading");
    if (session.lastErrorCode !== null && session.attemptsLeft > 0)
      return card("retry", { attemptsLeft: session.attemptsLeft, errorCode: session.lastErrorCode });
    return card("continue");
  }

  switch (identity.state) {
    case "verified": {
      const expiresAt = identity.expiresAt;
      if (typeof expiresAt === "number" && expiresAt - p.nowMs <= RENEWAL_WINDOW_MS)
        return p.startRefused === "identity_under_review"
          ? card("review")
          : card("renewal_due", { dueAt: expiresAt });
      return card("verified");
    }
    case "failed":
      return card("start_again");
    case "expired":
      return card("expired");
    case "revoked":
      return card("revoked");
    case "none":
    case "pending":
      return card("start");
  }
}

/* ── The card's words ──────────────────────────────────────────────────────────────────────── */

export type IdentityCardText = {
  /** The record line, when a check counts. */
  record: string | null;
  /** What the check is doing, or null when the record line or the form says it all. */
  status: string | null;
  notes: string[];
  /** The name form and its button, for a state that starts or continues a check. */
  form: { lines: string[]; button: string } | null;
};

/** The button of each state that has the name form. */
const FORM_BUTTONS: Partial<Record<IdentityCardKind, string>> = {
  start: A.buttons.start,
  start_again: A.buttons.startAgain,
  expired: A.buttons.startAgain,
  revoked: A.buttons.runAgain,
  renewal_due: A.buttons.renew,
  continue: A.buttons.continue,
  retry: A.buttons.retry,
};

/**
 * What the card says in a state: the record line, the status sentence, the notes under it, and
 * the form. A production check is required and reads the document; a test check is optional,
 * reads nothing, and says it counts on the testnet only.
 */
export function identityCardText(
  view: AutomaticCardView,
  p: { longWait: boolean; formatDate(ms: number): string },
): IdentityCardText {
  const production = view.required;
  const dated = (ms: number | null): Record<string, string> =>
    ms === null ? {} : { date: p.formatDate(ms) };

  let record: string | null = null;
  if (view.counts) {
    const [on, alone] = production ? [G.verifiedOn, G.verified] : [A.verifiedTestOn, A.verifiedTest];
    record = view.verifiedAt === null ? alone : fillCopy(on, dated(view.verifiedAt));
  }

  const button = FORM_BUTTONS[view.kind];
  const notes: string[] = [];
  if (view.kind === "retry")
    notes.push(
      view.attemptsLeft === 1
        ? A.oneAttemptLeft
        : fillCopy(A.attemptsLeft, { n: String(view.attemptsLeft) }),
    );
  if (view.required && !view.counts) notes.push(A.required);
  if (!view.required && button !== undefined) notes.push(A.optional);
  if (!view.required && view.counts) notes.push(A.testCounts);

  let form: IdentityCardText["form"] = null;
  if (button !== undefined) {
    const again = view.kind === "continue" || view.kind === "retry";
    // The browser keeps no name, so a continue or a retry asks for it again.
    const lines: string[] = again ? [A.form.nameAgain] : [];
    if (!production) lines.push(A.testNote);
    else {
      if (!again) lines.push(A.form.intro);
      lines.push(A.form.nameWhy, A.form.nameHelp);
    }
    form = { lines, button };
  }

  return { record, status: statusOf(view, p.longWait, dated), notes, form };
}

function statusOf(
  view: AutomaticCardView,
  longWait: boolean,
  dated: (ms: number | null) => Record<string, string>,
): string | null {
  switch (view.kind) {
    case "locked":
      return A.locked;
    case "loading":
      return A.loading;
    case "unreadable":
      return A.unreadable;
    case "start":
    case "verified":
      return null;
    case "start_again":
      return A.startAgain;
    case "expired":
      return A.expired;
    case "revoked":
      return A.revoked;
    case "continue":
      return A.continue;
    case "retry":
      return fillCopy(A.retry, { reason: attemptSentence(view.errorCode) });
    case "reading":
      return longWait ? A.readingLong : A.reading;
    case "finishing":
      return A.finishing;
    case "review":
      return A.review;
    case "renewal_due":
      return fillCopy(A.renewalDue, dated(view.dueAt));
  }
}

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

/** Why an attempt did not go through, by the provider's error code; a code without its own
 *  sentence reads as the general one. */
export function attemptSentence(code: string | null): string {
  if (code !== null && hasOwn(A.attempts, code)) return A.attempts[code as keyof typeof A.attempts];
  return A.attempts.other;
}

/* ── What the start may send ───────────────────────────────────────────────────────────────── */

/** The server's rule for one typed name (`typedName` in `back/backend/src/identity/sessions.ts`):
 *  trimmed, 1 to 100 code points, no control, format (a zero-width character, a direction
 *  override), surrogate, private-use or unassigned character. */
const NAME_MAX_CODE_POINTS = 100;
const OTHER_CHARACTER = /\p{C}/u;

function typedName(value: string): string | null {
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > NAME_MAX_CODE_POINTS || OTHER_CHARACTER.test(trimmed)) return null;
  return trimmed;
}

/** The two names as the start sends them, trimmed; or null when either breaks the server's rule,
 *  so the browser never sends a name the server would refuse. */
export function typedNames(input: {
  firstName: string;
  lastName: string;
}): { firstName: string; lastName: string } | null {
  const firstName = typedName(input.firstName);
  const lastName = typedName(input.lastName);
  if (firstName === null || lastName === null) return null;
  return { firstName, lastName };
}

/* ── When the card reads at the provider ───────────────────────────────────────────────────── */

/** Whether the card reads an open session back when it mounts. Never for a held session: that
 *  read would run the server's paid screen again at every visit, and the server reads it again by
 *  itself. */
export function shouldReadBack(session: SessionRead): boolean {
  return typeof session === "object" && session.status === "open" && session.held === null;
}

/** The next step of the wait while the provider is processing: stop once the window is over, a
 *  read at the provider every `READ_SYNC_EVERY_MS`, and the two reads between. */
export function readingStep(p: { elapsedMs: number; sinceSyncMs: number }): "sync" | "poll" | "stop" {
  if (p.elapsedMs >= READ_WINDOW_MS) return "stop";
  if (p.sinceSyncMs >= READ_SYNC_EVERY_MS) return "sync";
  return "poll";
}

/* ── How a refusal reads ───────────────────────────────────────────────────────────────────── */

/**
 * A start the server refused, as the card says it: the code, kept for the card's state (row 11),
 * and the card's own sentence for it, never the server's words. A refusal of the session sends
 * the person to sign in instead. A code without its own sentence, and anything that is not the
 * server's refusal, reads as the general sentence.
 */
export function startRefusal(error: unknown): {
  code: string | null;
  sentence: string | null;
  signIn: boolean;
} {
  if (!(error instanceof ApiError)) return { code: null, sentence: A.refusals.other, signIn: false };
  const code = error.code;
  if (code === "unauthorized") return { code, sentence: null, signIn: true };
  const key = code === "identity_unavailable" ? "identity_provider_unavailable" : code;
  const sentence = hasOwn(A.refusals, key)
    ? A.refusals[key as keyof typeof A.refusals]
    : A.refusals.other;
  return { code, sentence, signIn: false };
}

/**
 * A read at the provider the server refused. Too soon means a read was made a moment ago, so it
 * counts as done; the provider down has its sentence; a refusal of the session sends the person
 * to sign in; anything else says nothing, and the two reads still show where the check stands.
 */
export function syncRefusal(error: unknown): {
  sentence: string | null;
  signIn: boolean;
  counted: boolean;
} {
  const none = { sentence: null, signIn: false, counted: false };
  if (!(error instanceof ApiError)) return none;
  switch (error.code) {
    case "identity_sync_too_soon":
      return { ...none, counted: true };
    case "identity_provider_unavailable":
    case "identity_unavailable":
      return { ...none, sentence: A.refusals.identity_provider_unavailable };
    case "unauthorized":
      return { ...none, signIn: true };
    default:
      return none;
  }
}

/** A read at the provider, as it settled: answered, or refused with this error. */
export type SyncResult = { ok: true } | { ok: false; error: unknown };

/** The read-back on arrival, once it settled: done on an answer, and on a refusal that counts as
 *  one (a read made a moment ago); any other refusal leaves the check unread. */
export function arrivalOf(result: SyncResult): Arrival {
  return result.ok || syncRefusal(result.error).counted ? "done" : "failed";
}

/* ── The return ────────────────────────────────────────────────────────────────────────────── */

/** Whether this page was opened by the provider sending the person back. */
export function returnedFromCheck(params: { get(name: string): string | null }): boolean {
  return params.get(IDENTITY_RETURN_PARAM) === IDENTITY_RETURN_VALUE;
}

/** The provider's page the start answered, when it is an `https:` address; else null, and the
 *  browser goes nowhere. */
export function providerPageUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
