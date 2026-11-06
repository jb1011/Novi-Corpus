/**
 * The email sender interface (`src/email/sender.ts`) and its two senders: the provider adapter
 * (`src/email/resend.ts`), driven here against a `fetch` stub so the exact request it makes and
 * the way it reads each answer are pinned without a network, and the console sender, which
 * stands in for it on a deployment that sends nothing and never prints an address or a body.
 *
 * Every address here is a placeholder on example.com, every key a placeholder.
 */
import { afterEach, expect, test, vi } from "vitest";
import { type EmailFetch, RequestLimiter, ResendEmailSender } from "../../src/email/resend";
import {
  CONTACT_UPSERT_SKIPPED,
  ConsoleEmailSender,
  EmailSendError,
  type OutboundEmail,
} from "../../src/email/sender";

const KEY = "re_test_placeholder";
const FROM = "Novi Corpus <filings@example.com>";
const TO = "guardian@example.com";

const EMAIL: OutboundEmail = {
  to: TO,
  subject: "Your filing has landed",
  text: "the plain body, with a link only the guardian may see",
  html: "<p>the html body, with a link only the guardian may see</p>",
  idempotencyKey: "filing_landed:company_1",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
}

/** A fetch stub that records each request and answers with `answers` in turn (the last one
 *  repeats). */
function stubFetch(...answers: Array<{ status: number; body?: unknown }>): {
  fetch: EmailFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: EmailFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
      signal: init.signal,
    });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)] as {
      status: number;
      body?: unknown;
    };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    });
  };
  return { fetch, calls };
}

/** A limiter that never waits: the requests these tests make are never rate-limited. */
const noWait = () => new RequestLimiter(1000, 1000);

function sender(
  fetch: EmailFetch,
  extra: Partial<ConstructorParameters<typeof ResendEmailSender>[0]> = {},
) {
  return new ResendEmailSender({ apiKey: KEY, from: FROM, fetch, limiter: noWait(), ...extra });
}

/** The EmailSendError `fn` rejects with. */
async function sendErrorOf(fn: () => Promise<unknown>): Promise<EmailSendError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof EmailSendError) return err;
    throw err;
  }
  throw new Error("expected an EmailSendError, the call resolved");
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("send posts to the emails endpoint with the three headers and exactly the documented keys", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: { id: "msg_1" } });
  await sender(fetch).send(EMAIL);
  expect(calls).toHaveLength(1);
  const call = calls[0] as Call;
  expect(call.url).toBe("https://api.resend.com/emails");
  expect(call.method).toBe("POST");
  expect(call.headers).toEqual({
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    "Idempotency-Key": EMAIL.idempotencyKey,
  });
  expect(call.body).toEqual({
    from: FROM,
    to: [TO],
    subject: EMAIL.subject,
    text: EMAIL.text,
    html: EMAIL.html,
  });
});

test("send carries reply_to when the sender has one and the tags when the email has them", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: { id: "msg_1" } });
  const tags = [{ name: "kind", value: "filing_landed" }];
  await sender(fetch, { replyTo: "support@example.com" }).send({ ...EMAIL, tags });
  expect(calls[0]?.body).toEqual({
    from: FROM,
    to: [TO],
    subject: EMAIL.subject,
    text: EMAIL.text,
    html: EMAIL.html,
    reply_to: "support@example.com",
    tags,
  });
});

test("a 2xx answer's id is the provider message id", async () => {
  const { fetch } = stubFetch({
    status: 200,
    body: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" },
  });
  expect(await sender(fetch).send(EMAIL)).toEqual({
    providerMessageId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  });
});

test("a 2xx answer without an id is an invalid response, not retried", async () => {
  for (const body of [{}, { id: "" }, { id: 7 }, undefined]) {
    const { fetch } = stubFetch({ status: 200, body });
    const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
    expect(
      { status: err.status, code: err.code, retryable: err.retryable },
      JSON.stringify(body),
    ).toEqual({
      status: 200,
      code: "invalid_response",
      retryable: false,
    });
  }
});

test("429 is retryable, with the provider's error name as the code", async () => {
  const { fetch } = stubFetch({
    status: 429,
    body: { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" },
  });
  const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
  expect(err).toBeInstanceOf(EmailSendError);
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: 429,
    code: "rate_limit_exceeded",
    retryable: true,
  });
});

test("5xx is retryable; an answer with no readable name is coded by its status", async () => {
  for (const [status, body, code] of [
    [500, { statusCode: 500, name: "application_error", message: "boom" }, "application_error"],
    [503, undefined, "http_503"],
    [502, "<html>bad gateway</html>", "http_502"],
  ] as const) {
    const { fetch } = stubFetch({ status, body });
    const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
    expect(
      { status: err.status, code: err.code, retryable: err.retryable },
      String(status),
    ).toEqual({
      status,
      code,
      retryable: true,
    });
  }
});

test("422 is not retryable", async () => {
  const { fetch } = stubFetch({
    status: 422,
    body: { statusCode: 422, name: "missing_required_field", message: "Missing `to` field." },
  });
  const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: 422,
    code: "missing_required_field",
    retryable: false,
  });
});

test("409 (the same key with a different payload) is not retryable, coded invalid_idempotent_request", async () => {
  const { fetch } = stubFetch({
    status: 409,
    body: {
      statusCode: 409,
      name: "invalid_idempotent_request",
      message: "Same idempotency key used with a different request payload.",
    },
  });
  const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: 409,
    code: "invalid_idempotent_request",
    retryable: false,
  });
});

test("409 with the same key still in flight is retryable, coded concurrent_idempotent_requests", async () => {
  const { fetch } = stubFetch({
    status: 409,
    body: {
      statusCode: 409,
      name: "concurrent_idempotent_requests",
      message: "Same idempotency key used while original request is still in progress.",
    },
  });
  const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: 409,
    code: "concurrent_idempotent_requests",
    retryable: true,
  });
});

test("any other 409 is not retryable", async () => {
  for (const body of [{ name: "resource_locked" }, undefined]) {
    const { fetch } = stubFetch({ status: 409, body });
    const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
    expect(err.retryable, JSON.stringify(body)).toBe(false);
  }
});

test("the error never carries the provider's message, which can quote the address", async () => {
  const { fetch } = stubFetch({
    status: 422,
    body: { statusCode: 422, name: "validation_error", message: `Invalid \`to\` field: ${TO}` },
  });
  const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
  expect(err.message).not.toContain(TO);
  expect(err.message).not.toContain("Invalid");
  expect(JSON.stringify(err)).not.toContain(TO);
});

test("a name that is not a plain code is not carried either: the status codes it", async () => {
  const { fetch } = stubFetch({ status: 400, body: { name: `bad ${TO}` } });
  const err = await sendErrorOf(() => sender(fetch).send(EMAIL));
  expect(err.code).toBe("http_400");
});

test("a timeout is retryable, with no status", async () => {
  const hang: EmailFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  const err = await sendErrorOf(() => sender(hang, { timeoutMs: 20 }).send(EMAIL));
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: null,
    code: "timeout",
    retryable: true,
  });
});

test("the timeout is 10 seconds by default, through AbortSignal.timeout", async () => {
  const spy = vi.spyOn(AbortSignal, "timeout");
  const { fetch, calls } = stubFetch({ status: 200, body: { id: "msg_1" } });
  await sender(fetch).send(EMAIL);
  expect(spy).toHaveBeenCalledWith(10_000);
  expect(calls[0]?.signal).toBe(spy.mock.results[0]?.value);
});

test("a network error is retryable, with no status", async () => {
  const down: EmailFetch = async () => {
    throw new TypeError("fetch failed");
  };
  const err = await sendErrorOf(() => sender(down).send(EMAIL));
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: null,
    code: "network_error",
    retryable: true,
  });
});

/** A fetch that answers `status` with a body whose stream fails, or never ends, part way. */
function brokenBody(status: number, how: "errors" | "hangs"): EmailFetch {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          if (how === "errors") controller.error(new TypeError("terminated"));
        },
      }),
      { status },
    );
}

test("a timeout during the body read is retryable, with no status", async () => {
  const err = await sendErrorOf(() =>
    sender(brokenBody(200, "hangs"), { timeoutMs: 20 }).send(EMAIL),
  );
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: null,
    code: "timeout",
    retryable: true,
  });
});

test("a body read cut short on a 2xx is a request without an answer, retryable", async () => {
  const err = await sendErrorOf(() => sender(brokenBody(200, "errors")).send(EMAIL));
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: null,
    code: "network_error",
    retryable: true,
  });
});

test("a body read cut short on a refusal: the status decides, not retryable", async () => {
  for (const status of [400, 403, 409, 422]) {
    const err = await sendErrorOf(() => sender(brokenBody(status, "errors")).send(EMAIL));
    expect(
      { status: err.status, code: err.code, retryable: err.retryable },
      String(status),
    ).toEqual({ status, code: `http_${status}`, retryable: false });
  }
  const timedOut = await sendErrorOf(() =>
    sender(brokenBody(422, "hangs"), { timeoutMs: 20 }).send(EMAIL),
  );
  expect({ status: timedOut.status, code: timedOut.code, retryable: timedOut.retryable }).toEqual({
    status: 422,
    code: "http_422",
    retryable: false,
  });
});

test("a body read cut short on 429 or 5xx stays retryable", async () => {
  for (const status of [429, 500, 503]) {
    const err = await sendErrorOf(() => sender(brokenBody(status, "errors")).send(EMAIL));
    expect(err.retryable, String(status)).toBe(true);
  }
});

test("an idempotency key outside 1 to 256 characters is refused before any request", async () => {
  const { fetch, calls } = stubFetch({ status: 200, body: { id: "msg_1" } });
  for (const key of ["", "k".repeat(257)]) {
    const err = await sendErrorOf(() => sender(fetch).send({ ...EMAIL, idempotencyKey: key }));
    expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
      status: null,
      code: "invalid_idempotency_key",
      retryable: false,
    });
  }
  expect(calls).toHaveLength(0);
  await sender(fetch).send({ ...EMAIL, idempotencyKey: "k".repeat(256) });
  expect(calls).toHaveLength(1);
});

test("upsertContact posts the contact with its segment, and the answer's id is the contact id", async () => {
  const { fetch, calls } = stubFetch({ status: 201, body: { object: "contact", id: "ct_1" } });
  const out = await sender(fetch).upsertContact({ email: TO, segmentId: "seg_1" });
  expect(out).toEqual({ providerContactId: "ct_1" });
  const call = calls[0] as Call;
  expect(call.url).toBe("https://api.resend.com/contacts");
  expect(call.method).toBe("POST");
  expect(call.headers).toEqual({
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  });
  expect(call.body).toEqual({ email: TO, segments: [{ id: "seg_1" }] });
});

test("upsertContact carries unsubscribed when the caller states it", async () => {
  const { fetch, calls } = stubFetch({ status: 201, body: { object: "contact", id: "ct_1" } });
  await sender(fetch).upsertContact({ email: TO, unsubscribed: true, segmentId: "seg_1" });
  expect(calls[0]?.body).toEqual({ email: TO, unsubscribed: true, segments: [{ id: "seg_1" }] });
});

test("upsertContact reads a refusal the way send does", async () => {
  const { fetch } = stubFetch({ status: 503, body: { name: "service_unavailable" } });
  const err = await sendErrorOf(() =>
    sender(fetch).upsertContact({ email: TO, segmentId: "seg_1" }),
  );
  expect({ status: err.status, code: err.code, retryable: err.retryable }).toEqual({
    status: 503,
    code: "service_unavailable",
    retryable: true,
  });
});

test("without a segment id upsertContact is a no-op that logs contact_upsert_skipped, never the address", async () => {
  const { fetch, calls } = stubFetch({ status: 201, body: { object: "contact", id: "ct_1" } });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const out = await sender(fetch).upsertContact({ email: TO });
  expect(out).toEqual({ providerContactId: CONTACT_UPSERT_SKIPPED });
  expect(calls).toHaveLength(0);
  const lines = log.mock.calls.map((c) => String(c[0]));
  expect(lines.map((l) => JSON.parse(l).opslog)).toEqual(["contact_upsert_skipped"]);
  expect(lines.join("\n")).not.toContain(TO);
});

test("at most 8 requests a second, shared by send and upsertContact", async () => {
  let clock = 0;
  const limiter = new RequestLimiter(8, 1000, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const startedAt: number[] = [];
  const fetch: EmailFetch = async (url) => {
    startedAt.push(clock);
    return new Response(
      JSON.stringify(url.endsWith("/contacts") ? { object: "contact", id: "ct" } : { id: "msg" }),
      { status: 200 },
    );
  };
  const s = new ResendEmailSender({ apiKey: KEY, from: FROM, fetch, limiter });
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => s.send({ ...EMAIL, idempotencyKey: `k${i}` })),
    s.upsertContact({ email: TO, segmentId: "seg_1" }),
    s.send({ ...EMAIL, idempotencyKey: "k8" }),
  ]);
  expect(startedAt).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1000, 1000]);
});

test("the limiter's window slides: a slot frees one second after the request that took it", async () => {
  let clock = 0;
  const limiter = new RequestLimiter(2, 1000, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const at: number[] = [];
  await limiter.acquire();
  at.push(clock);
  clock = 400;
  await limiter.acquire();
  at.push(clock);
  await limiter.acquire(); // waits for the first slot, free at 1000
  at.push(clock);
  await limiter.acquire(); // waits for the second, free at 1400
  at.push(clock);
  expect(at).toEqual([0, 400, 1000, 1400]);
});

test("every sender in one process shares one limiter unless a test hands it its own", () => {
  const { fetch } = stubFetch({ status: 200, body: { id: "msg_1" } });
  const a = new ResendEmailSender({ apiKey: KEY, from: FROM, fetch });
  const b = new ResendEmailSender({ apiKey: KEY, from: FROM, fetch });
  expect(a.limiter).toBe(b.limiter);
});

test("the production limiter allows 8 requests a second", () => {
  const { fetch } = stubFetch({ status: 200, body: { id: "msg_1" } });
  const { limiter } = new ResendEmailSender({ apiKey: KEY, from: FROM, fetch });
  expect({ max: limiter.max, windowMs: limiter.windowMs }).toEqual({ max: 8, windowMs: 1000 });
});

test("the limiter's default clock is monotonic: performance.now, never the wall clock", async () => {
  const monotonic = vi.spyOn(performance, "now");
  const wall = vi.spyOn(Date, "now");
  await new RequestLimiter(1, 1000).acquire();
  expect(monotonic).toHaveBeenCalled();
  expect(wall).not.toHaveBeenCalled();
});

test("the provider sender's kind is its provider", () => {
  const { fetch } = stubFetch({ status: 200, body: { id: "msg_1" } });
  expect(sender(fetch).kind).toBe("resend");
  expect(new ConsoleEmailSender().kind).toBe("console");
});

/** Everything written to stdout and stderr while `fn` runs, through console or the streams. */
async function captureOutput(fn: () => Promise<unknown>): Promise<string> {
  const out: string[] = [];
  const keep = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  for (const m of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, m).mockImplementation(keep);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  return out.join("\n");
}

test("the console sender logs its kind, the subject and the key, never the address or the body", async () => {
  let result: unknown;
  const output = await captureOutput(async () => {
    result = await new ConsoleEmailSender().send(EMAIL);
  });
  expect(result).toEqual({ providerMessageId: `console:${EMAIL.idempotencyKey}` });
  expect(output).not.toContain(TO);
  expect(output).not.toContain("guardian@");
  expect(output).not.toContain(EMAIL.text);
  expect(output).not.toContain("only the guardian may see");
  const lines = output.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  const { opslog, at: _at, ...fields } = JSON.parse(lines[0] as string);
  expect(opslog).toBe("email_console");
  expect(fields).toEqual({
    kind: "console",
    subject: EMAIL.subject,
    idempotencyKey: EMAIL.idempotencyKey,
  });
});

test("the console sender prints the text body only when asked, and never the address", async () => {
  const email: OutboundEmail = {
    ...EMAIL,
    subject: `A note for ${TO}`,
    text: `Hello ${TO.toUpperCase()}, confirm here: https://www.example.com/waitlist/confirm?token=wlc_0`,
  };
  for (const showBody of [undefined, false, true]) {
    const output = await captureOutput(async () => {
      await new ConsoleEmailSender(showBody === undefined ? undefined : { showBody }).send(email);
    });
    expect(output.toLowerCase(), String(showBody)).not.toContain(TO);
    expect(output, String(showBody)).not.toContain(email.html);
    const { opslog, at: _at, ...fields } = JSON.parse(output.trim());
    expect(opslog).toBe("email_console");
    if (showBody)
      expect(fields).toEqual({
        kind: "console",
        subject: "A note for <recipient>",
        idempotencyKey: EMAIL.idempotencyKey,
        text: "Hello <recipient>, confirm here: https://www.example.com/waitlist/confirm?token=wlc_0",
      });
    else
      expect(fields, String(showBody)).toEqual({
        kind: "console",
        subject: "A note for <recipient>",
        idempotencyKey: EMAIL.idempotencyKey,
      });
  }
});

test("the console sender refuses the key the provider would refuse", async () => {
  const err = await sendErrorOf(() =>
    new ConsoleEmailSender().send({ ...EMAIL, idempotencyKey: "k".repeat(257) }),
  );
  expect({ code: err.code, retryable: err.retryable }).toEqual({
    code: "invalid_idempotency_key",
    retryable: false,
  });
});

test("the console sender's upsertContact never prints the address, and skips without a segment", async () => {
  let withSegment: unknown;
  let withoutSegment: unknown;
  const output = await captureOutput(async () => {
    withSegment = await new ConsoleEmailSender().upsertContact({ email: TO, segmentId: "seg_1" });
    withoutSegment = await new ConsoleEmailSender().upsertContact({ email: TO });
  });
  expect(output).not.toContain(TO);
  expect(withSegment).toEqual({ providerContactId: "console:contact" });
  expect(withoutSegment).toEqual({ providerContactId: CONTACT_UPSERT_SKIPPED });
  const events = output
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  expect(events.map((e) => e.opslog)).toEqual(["email_console_contact", "contact_upsert_skipped"]);
  expect(events[0]).toMatchObject({ kind: "console", segmentId: "seg_1" });
});
