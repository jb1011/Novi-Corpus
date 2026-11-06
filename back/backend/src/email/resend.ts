import { opsLog } from "../observability/opsLog";
import { readCappedText } from "../util/readStreamCapped";
import {
  CONTACT_UPSERT_SKIPPED,
  EmailSendError,
  type EmailSender,
  type OutboundEmail,
  assertIdempotencyKey,
} from "./sender";

/**
 * THE RESEND ADAPTER: `EmailSender` over Resend's REST API (official docs, read 4 November).
 *
 *  - `send`: `POST /emails` with `Authorization: Bearer <key>`, `Content-Type: application/json`
 *    and `Idempotency-Key: <key>` (1 to 256 characters, kept 24 hours; the same key with a
 *    different payload answers 409 `invalid_idempotent_request`). The answer is `{ id }`.
 *  - `upsertContact`: `POST /contacts` with the address and its segment (`segments` is an array
 *    of `{ id }` objects; the Audiences API is deprecated, segments and topics replace it).
 *  - 429, 5xx and a 409 `concurrent_idempotent_requests` (the same key still in flight) are
 *    retryable; every other 4xx is not, `invalid_idempotent_request` included. A timeout or a
 *    network error is retryable, unless the status of a refusal had already arrived: then the
 *    status decides. Errors are coded by Resend's error `name` (`rate_limit_exceeded`,
 *    `validation_error`, ...) and never carry its `message`, which can quote the address.
 *  - A 10 second timeout per request (`AbortSignal.timeout`, as `monitor/alerts.ts` does), and at
 *    most 8 requests a second from one process, `send` and `upsertContact` together, under
 *    Resend's limit of 10 a second per team. Each process has its own limiter: the API's
 *    `email_deliver` job and a manual `scheduler:run email_deliver` both send, each serially
 *    (one row at a time) under its own limiter; the other email commands only enqueue.
 *
 * Nothing here logs the key, an address or a body.
 */

const EMAILS_URL = "https://api.resend.com/emails";
const CONTACTS_URL = "https://api.resend.com/contacts";

export const RESEND_TIMEOUT_MS = 10_000;
export const RESEND_MAX_REQUESTS_PER_SECOND = 8;
/** Resend's answers are a few hundred bytes; anything past this is not one of them. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Resend's error names are snake_case codes. Anything else is not carried. */
const ERROR_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The part of `fetch` the adapter uses: injected so a test drives it without a network. */
export type EmailFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

/**
 * At most `max` requests in any `windowMs`: a sliding window over the start times of the last
 * `max` requests, taken in arrival order. `acquire` resolves when the caller may start its request.
 * The clock (`performance.now` by default) and the sleep are injectable for tests.
 */
export class RequestLimiter {
  private readonly starts: number[] = [];
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly max: number,
    readonly windowMs: number,
    seams: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    // Monotonic: a wall-clock step (NTP, a manual change) must neither stall sends nor let a burst
    // through, and a test's fake timers must not desynchronise it from its own sleeps.
    this.now = seams.now ?? (() => performance.now());
    this.sleep = seams.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  acquire(): Promise<void> {
    const turn = this.tail.then(() => this.take());
    // The chain must survive a rejected turn, or one failure would wedge every later caller.
    this.tail = turn.catch(() => {});
    return turn;
  }

  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.starts.length > 0 && (this.starts[0] as number) <= t - this.windowMs)
        this.starts.shift();
      if (this.starts.length < this.max) {
        this.starts.push(t);
        return;
      }
      await this.sleep((this.starts[0] as number) + this.windowMs - t);
    }
  }
}

/** The one limiter of this process: every adapter instance shares it unless handed its own. */
const PROCESS_LIMITER = new RequestLimiter(RESEND_MAX_REQUESTS_PER_SECOND, 1000);

export interface ResendSenderOptions {
  apiKey: string;
  /** `Name <address>` or an address. */
  from: string;
  replyTo?: string;
  /** Defaults to the global fetch. */
  fetch?: EmailFetch;
  /** Defaults to RESEND_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to the process-wide limiter. */
  limiter?: RequestLimiter;
}

/** The body was larger than any answer Resend writes: read as no body at all. */
class ResponseTooLarge extends Error {}

export class ResendEmailSender implements EmailSender {
  readonly kind = "resend" as const;
  readonly limiter: RequestLimiter;
  private readonly fetch: EmailFetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ResendSenderOptions) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? RESEND_TIMEOUT_MS;
    this.limiter = opts.limiter ?? PROCESS_LIMITER;
  }

  async send(e: OutboundEmail): Promise<{ providerMessageId: string }> {
    assertIdempotencyKey(e.idempotencyKey);
    const id = await this.post(
      EMAILS_URL,
      {
        from: this.opts.from,
        to: [e.to],
        subject: e.subject,
        text: e.text,
        html: e.html,
        ...(this.opts.replyTo ? { reply_to: this.opts.replyTo } : {}),
        ...(e.tags && e.tags.length > 0 ? { tags: e.tags } : {}),
      },
      { "Idempotency-Key": e.idempotencyKey },
    );
    return { providerMessageId: id };
  }

  async upsertContact(c: {
    email: string;
    unsubscribed?: boolean;
    segmentId?: string;
  }): Promise<{ providerContactId: string }> {
    if (!c.segmentId) {
      opsLog("contact_upsert_skipped", { kind: this.kind });
      return { providerContactId: CONTACT_UPSERT_SKIPPED };
    }
    // `unsubscribed` only when the caller states it: a write that did not mean to change a
    // contact's subscription must not send `false` for it.
    const id = await this.post(CONTACTS_URL, {
      email: c.email,
      ...(c.unsubscribed === undefined ? {} : { unsubscribed: c.unsubscribed }),
      segments: [{ id: c.segmentId }],
    });
    return { providerContactId: id };
  }

  /** One request: the limiter, the timeout, the capped read, the id or the coded refusal. */
  private async post(
    url: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    await this.limiter.acquire();
    // After the limiter, so a wait for a slot never eats into the request's own 10 seconds.
    const signal = AbortSignal.timeout(this.timeoutMs);
    const unanswered = () =>
      signal.aborted
        ? new EmailSendError(null, "timeout", true)
        : new EmailSendError(null, "network_error", true);

    let res: Awaited<ReturnType<EmailFetch>>;
    try {
      res = await this.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      throw unanswered();
    }

    let parsed: unknown;
    try {
      const text = await readCappedText(
        {
          body: res.body,
          contentLength: res.headers?.get("content-length"),
          readAll: async () => Buffer.from(await res.text(), "utf8"),
        },
        MAX_RESPONSE_BYTES,
        { declared: () => new ResponseTooLarge(), streamed: () => new ResponseTooLarge() },
        signal,
      );
      parsed = text ? JSON.parse(text) : undefined;
    } catch (err) {
      // An oversized or unparsable body is no body: the status alone decides. A read cut short
      // by the timeout or the network is a request without an answer, unless its status already
      // says the request was refused outright: then the status decides, and a refusal is not
      // retried because its body went missing.
      if (
        !(err instanceof ResponseTooLarge) &&
        !(err instanceof SyntaxError) &&
        !refusedOutright(res.status)
      )
        throw unanswered();
      parsed = undefined;
    }

    const status = res.status;
    if (status >= 200 && status < 300) {
      const id = (parsed as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || id === "")
        throw new EmailSendError(status, "invalid_response", false);
      return id;
    }
    const name = (parsed as { name?: unknown } | undefined)?.name;
    const code = typeof name === "string" && ERROR_NAME.test(name) ? name : `http_${status}`;
    throw new EmailSendError(
      status,
      code,
      !refusedOutright(status) || (status === 409 && code === "concurrent_idempotent_requests"),
    );
  }
}

/** A 3xx or a 4xx other than 429: the request was refused, and the same request would be refused
 *  again. (One 409 is the exception, decided by its code: `concurrent_idempotent_requests`.) */
function refusedOutright(status: number): boolean {
  return status >= 300 && status < 500 && status !== 429;
}
