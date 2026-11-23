import { createHmac, timingSafeEqual } from "node:crypto";
import type { Secret } from "../../formation/pii";
import { withDeadline } from "../../util/deadline";
import { readCappedText } from "../../util/readStreamCapped";
import {
  type ProviderSession,
  STRIPE_SESSION_ID,
  UnreadableSession,
  parseProviderSession,
} from "./mapSession";

/**
 * The Stripe Identity client (identity check plan, Task 4): four calls on VerificationSessions,
 * and the check of the signature Stripe puts on a webhook. No database, no clock but the deadline.
 *
 * The requests are pinned to Stripe's documented REST shape, and the tests pin them byte for byte:
 *
 * - Form-encoded bodies, bearer auth with the restricted key. **No `Stripe-Version` header**: the
 *   account's default version applies, the one the dashboard's verification flow was made under.
 * - A create sends `verification_flow`, `client_reference_id` and `return_url` and nothing else:
 *   the flow carries every setting (document types, selfie), so no `type`, `options`, `metadata`
 *   or `provided_details` can disagree with it. Its `Idempotency-Key` is the caller's.
 * - A read expands the verified outputs (which Stripe includes only through an expand, ruling
 *   R19) and the last verification report, and the birth date when asked (ruling R3: Stripe
 *   serves the birth date only under the "recent detailed verification results" permission and
 *   within 48 hours of processing, so the caller retries once without it when Stripe refuses).
 *   Nothing else is expanded: the document number, the address and the images are never asked
 *   for. (The address can still ride in the session's `verified_outputs`; the parser never reads
 *   it, and this client never logs a body.)
 * - Every call is bounded by one deadline (10 s by default) that covers the body read and aborts
 *   the request, and every body is read under a size cap.
 *
 * Errors, by what the caller does next:
 *
 * - 401 and 403: `StripeKeyRejected` (the key is wrong, revoked, or lacks a permission; the caller
 *   logs it CRITICAL, after R3's one retry without the birth date on a refused expand).
 * - 404: `StripeNotFound`.
 * - 429, 5xx, a timeout, a torn connection, a success whose body cannot be read:
 *   `StripeUnavailable`, retryable. No verdict reached us.
 * - Anything else: `StripeError(status)`.
 *
 * Each one is a `StripeError` carrying the HTTP status (null when no HTTP answer arrived) and
 * Stripe's machine `code` when its error body had one. Never Stripe's sentence, never a body,
 * never the key: an error body can quote what was sent, and this client logs nothing at all.
 */

export const STRIPE_IDENTITY_SESSIONS_URL =
  "https://api.stripe.com/v1/identity/verification_sessions";

/** The per-call deadline: the fetch and the body read together. */
export const STRIPE_TIMEOUT_MS = 10_000;

/** A VerificationSession is a few kilobytes; the cap only stops a runaway answer. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

const FORM = "application/x-www-form-urlencoded";
// `verified_outputs` is includable only through an expand (ruling R19): both reads ask for it, or
// a verified session read without the birth date would carry no names and never complete.
const EXPAND_WITH_DOB =
  "?expand[]=verified_outputs&expand[]=verified_outputs.dob&expand[]=last_verification_report";
const EXPAND_WITHOUT_DOB = "?expand[]=verified_outputs&expand[]=last_verification_report";

/** Stripe's machine codes are snake_case; anything else in that slot is not kept. */
const STRIPE_CODE = /^[a-z][a-z0-9_]{0,99}$/;
const STRIPE_REQUEST_ID = /^req_[A-Za-z0-9]{1,100}$/;

/** The provider seam the identity session service calls. Tests fake it; production is Stripe. */
export interface IdentityProviderClient {
  createSession(input: {
    flowId: string;
    clientReferenceId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ providerRef: string; url: string; livemode: boolean }>;
  /** `withDob: true` expands `verified_outputs`, `verified_outputs.dob` and
   *  `last_verification_report`; `withDob: false` expands `verified_outputs` and the report, never
   *  the birth date (rulings R3, R19). */
  retrieveSession(providerRef: string, opts: { withDob: boolean }): Promise<ProviderSession>;
  cancelSession(providerRef: string): Promise<void>;
  redactSession(providerRef: string): Promise<void>;
}

/** Every failure the client throws. */
export class StripeError extends Error {
  /** Stripe's HTTP status; null when no HTTP answer reached us (a timeout, a torn connection). */
  readonly status: number | null;
  /** Stripe's machine code from its error body (`resource_missing`), never its message. */
  readonly code: string | null;
  /** Stripe's `Request-Id`, the first thing its support asks for. */
  readonly requestId: string | null;

  constructor(
    status: number | null,
    message?: string,
    extra: { code?: string | null; requestId?: string | null; cause?: unknown } = {},
  ) {
    super(
      message ?? `Stripe answered HTTP ${status ?? "nothing"}`,
      extra.cause === undefined ? undefined : { cause: extra.cause },
    );
    this.name = "StripeError";
    this.status = status;
    this.code = extra.code ?? null;
    this.requestId = extra.requestId ?? null;
  }
}

/** 401 or 403: the key is refused. The caller logs it CRITICAL. */
export class StripeKeyRejected extends StripeError {
  constructor(...args: ConstructorParameters<typeof StripeError>) {
    super(...args);
    this.name = "StripeKeyRejected";
  }
}

/** 404: no such session under this key. */
export class StripeNotFound extends StripeError {
  constructor(...args: ConstructorParameters<typeof StripeError>) {
    super(...args);
    this.name = "StripeNotFound";
  }
}

/** 429, 5xx, a timeout, a transport failure, an unreadable success: retry later. */
export class StripeUnavailable extends StripeError {
  constructor(...args: ConstructorParameters<typeof StripeError>) {
    super(...args);
    this.name = "StripeUnavailable";
  }
}

type Operation = "create" | "retrieve" | "cancel" | "redact";

interface Answer {
  status: number;
  /** Null when the body could not be read (over the cap, or the read failed). */
  text: string | null;
  requestId: string | null;
}

export class StripeIdentityClient implements IdentityProviderClient {
  readonly #key: Secret;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: { key: Secret; fetch?: typeof fetch; timeoutMs?: number }) {
    this.#key = opts.key;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? STRIPE_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0)
      throw new Error("StripeIdentityClient: timeoutMs must be a positive number");
  }

  async createSession(input: {
    flowId: string;
    clientReferenceId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<{ providerRef: string; url: string; livemode: boolean }> {
    const body = new URLSearchParams([
      ["verification_flow", input.flowId],
      ["client_reference_id", input.clientReferenceId],
      ["return_url", input.returnUrl],
    ]).toString();
    const answer = await this.#call("create", "POST", STRIPE_IDENTITY_SESSIONS_URL, {
      body,
      idempotencyKey: input.idempotencyKey,
    });
    const s = sessionOf("create", answer);
    if (s.url === null)
      throw new StripeUnavailable(answer.status, "Stripe Identity create: the session has no URL", {
        requestId: answer.requestId,
      });
    return { providerRef: s.id, url: s.url, livemode: s.livemode };
  }

  async retrieveSession(providerRef: string, opts: { withDob: boolean }): Promise<ProviderSession> {
    const url = `${sessionUrl(providerRef)}${opts.withDob ? EXPAND_WITH_DOB : EXPAND_WITHOUT_DOB}`;
    return sessionOf("retrieve", await this.#call("retrieve", "GET", url));
  }

  async cancelSession(providerRef: string): Promise<void> {
    await this.#call("cancel", "POST", `${sessionUrl(providerRef)}/cancel`);
  }

  async redactSession(providerRef: string): Promise<void> {
    await this.#call("redact", "POST", `${sessionUrl(providerRef)}/redact`);
  }

  /** One round trip: the headers, the deadline, the size cap, the status mapping. */
  async #call(
    op: Operation,
    method: "GET" | "POST",
    url: string,
    opts: { body?: string; idempotencyKey?: string } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      // The key leaves its `Secret` wrapper here, at the wire, and nowhere else in this module.
      Authorization: `Bearer ${this.#key.reveal()}`,
    };
    if (method === "POST") headers["Content-Type"] = FORM;
    if (opts.idempotencyKey !== undefined) headers["Idempotency-Key"] = opts.idempotencyKey;

    const answer = await withDeadline(
      this.#timeoutMs,
      async (signal): Promise<Answer> => {
        let res: Response;
        try {
          res = await this.#fetch(url, {
            method,
            headers,
            body: method === "POST" ? (opts.body ?? "") : undefined,
            signal,
            // A redirect is never followed: the request would be sent again, key and all, to a
            // host this client did not choose.
            redirect: "error",
          });
        } catch (e) {
          throw new StripeUnavailable(null, `Stripe Identity ${op}: the request did not complete`, {
            cause: e,
          });
        }
        const rawId = res.headers.get("request-id");
        const requestId = rawId !== null && STRIPE_REQUEST_ID.test(rawId) ? rawId : null;
        let text: string | null;
        try {
          text = await readCappedText(
            {
              body: res.body,
              contentLength: res.headers.get("content-length"),
              readAll: async () => Buffer.from(await res.text(), "utf8"),
            },
            MAX_RESPONSE_BYTES,
            {
              declared: () => new Error("over the cap"),
              streamed: () => new Error("over the cap"),
            },
            signal,
          );
        } catch {
          text = null;
        }
        return { status: res.status, text, requestId };
      },
      () => new StripeUnavailable(null, `Stripe Identity ${op}: no answer within the deadline`),
    );

    if (answer.status < 200 || answer.status >= 300) throw errorFor(op, answer);
    return answer;
  }
}

/** The session's URL, after checking the reference is a session id (it goes into the path). */
function sessionUrl(providerRef: string): string {
  if (typeof providerRef !== "string" || !STRIPE_SESSION_ID.test(providerRef))
    throw new StripeError(null, "Stripe Identity: the reference is not a verification session id");
  return `${STRIPE_IDENTITY_SESSIONS_URL}/${providerRef}`;
}

/**
 * A success's body as a session. A body that is not JSON, or not a session the parser can read,
 * is `StripeUnavailable`: no usable verdict reached us. The JSON error is never kept: its message
 * quotes the text it failed on.
 */
function sessionOf(op: Operation, answer: Answer): ProviderSession {
  let json: unknown;
  try {
    json = answer.text === null ? undefined : JSON.parse(answer.text);
  } catch {
    json = undefined;
  }
  if (json === undefined)
    throw new StripeUnavailable(answer.status, `Stripe Identity ${op}: the answer is not JSON`, {
      requestId: answer.requestId,
    });
  try {
    return parseProviderSession(json);
  } catch (e) {
    // The parser's messages name a field, never a value.
    const field = e instanceof UnreadableSession ? e.field : "session";
    throw new StripeUnavailable(
      answer.status,
      `Stripe Identity ${op}: the answer's ${field} cannot be read`,
      { requestId: answer.requestId },
    );
  }
}

/** A failing status to its class. Stripe's machine code is kept; its sentence never is. */
function errorFor(op: Operation, answer: Answer): StripeError {
  const { status, requestId } = answer;
  const extra = { code: stripeCodeOf(answer.text), requestId };
  const message = `Stripe Identity ${op}: HTTP ${status}`;
  if (status === 401 || status === 403) return new StripeKeyRejected(status, message, extra);
  if (status === 404) return new StripeNotFound(status, message, extra);
  if (status === 429 || status >= 500) return new StripeUnavailable(status, message, extra);
  return new StripeError(status, message, extra);
}

function stripeCodeOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && STRIPE_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

// ── the webhook signature ────────────────────────────────────────────────────────────────────

/**
 * A `v1` digest's bytes, or undefined when it is not hex. `Buffer.from(s, "hex")` silently stops
 * at the first invalid pair, so the shape is checked before decoding (the doola receiver's rule).
 */
function decodeHexDigest(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value))
    return undefined;
  return Buffer.from(value, "hex");
}

/**
 * Check a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`.
 *
 * The signed payload is `${t}.${rawBody}` (the timestamp exactly as the header spells it), the
 * digest HMAC-SHA256 with the endpoint's signing secret, in hex. Keys other than `t` and `v1`
 * are ignored (Stripe's `v0` is its test scheme). A header with no `t`, two `t`, a `t` that is not
 * a whole number, or no readable `v1` is `"bad"`.
 *
 * Every `v1` is compared against every secret (the current one and, during a rotation, the
 * previous one), with `timingSafeEqual` after a length check (it throws on unequal lengths, and a
 * throw in the receiver would be a 500), and no early return, so the time taken does not say
 * which secret or which entry matched.
 *
 * `"stale"` means authentic but older (or further ahead) than the tolerance: it is decided only
 * after a signature matched. Anything that fails is `"bad"`. Nothing here throws.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined,
  secrets: (string | undefined)[],
  nowSeconds: number,
  toleranceSeconds: number,
): "ok" | "stale" | "bad" {
  if (!header) return "bad";
  let timestamp: string | undefined;
  let timestamps = 0;
  const provided: Buffer[] = [];
  for (const item of header.split(",")) {
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const key = item.slice(0, eq).trim();
    const value = item.slice(eq + 1).trim();
    if (key === "t") {
      timestamps += 1;
      timestamp = value;
    } else if (key === "v1") {
      const digest = decodeHexDigest(value);
      if (digest) provided.push(digest);
    }
  }
  if (timestamps !== 1 || timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return "bad";
  if (provided.length === 0) return "bad";

  const payload = `${timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac("sha256", secret).update(payload, "utf8").digest();
    for (const candidate of provided) {
      if (candidate.length !== expected.length) continue;
      if (timingSafeEqual(candidate, expected)) matched = true;
    }
  }
  if (!matched) return "bad";
  // Written as "within the tolerance" so a clock that is not a number fails closed (stale).
  return Math.abs(nowSeconds - Number(timestamp)) <= toleranceSeconds ? "ok" : "stale";
}
