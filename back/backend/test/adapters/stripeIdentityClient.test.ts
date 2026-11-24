/**
 * The Stripe Identity client (identity check plan, Task 4). What is pinned here:
 *  1. the exact requests: the URL, the method, the headers (and no other: no `Stripe-Version`, the
 *     account's default version applies), the form body of a create, the expand parameters of a
 *     read (both forms of ruling R3: with the birth date and without it);
 *  2. the four error classes, by HTTP status, all of them `StripeError`s carrying the status;
 *  3. the 10 s deadline, which aborts the request;
 *  4. what never leaves the client: the key, a response body, Stripe's `last_error.reason`.
 *
 * The fakes build NATIVE `Response` objects (the doola client test's convention): a cast object
 * cannot exercise the body stream the client reads under its cap.
 */
import { inspect } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  STRIPE_IDENTITY_SESSIONS_URL,
  STRIPE_TIMEOUT_MS,
  StripeError,
  StripeIdentityClient,
  StripeKeyRejected,
  StripeNotFound,
  StripeUnavailable,
} from "../../src/adapters/stripe/identityClient";
import { toSecret } from "../../src/formation/pii";

/** A made-up restricted key of the test mode's shape. Never a real key. */
const KEY_TEXT = "rk_test_fixtureKeyNotARealOne0000";
const KEY = toSecret(KEY_TEXT);

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const VS = "vs_1FixtureSessionAbc";
const RETURN_URL = "https://app.example.com/legal-body?identityCheck=returned";
const FLOW_ID = "vf_1FixtureFlow";
/** The session's URL, spelled out rather than built, so the test pins it. */
const SESSION_URL =
  "https://api.stripe.com/v1/identity/verification_sessions/vs_1FixtureSessionAbc";
/** RETURN_URL, form-encoded. */
const RETURN_URL_FORM = "https%3A%2F%2Fapp.example.com%2Flegal-body%3FidentityCheck%3Dreturned";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
  signal?: AbortSignal | null;
}

interface FakeResponse {
  status: number;
  body?: unknown;
  text?: string;
}

function fakeFetch(responses: FakeResponse[]): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
      redirect: init?.redirect,
      signal: init?.signal,
    });
    const r = responses[Math.min(i++, responses.length - 1)] ?? { status: 200 };
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status });
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

/** A session as Stripe answers a create: fresh, waiting for the person, with its URL. */
const CREATED = {
  id: VS,
  object: "identity.verification_session",
  client_reference_id: SESSION_ID,
  created: 1763900000,
  last_error: null,
  last_verification_report: null,
  livemode: false,
  redaction: null,
  status: "requires_input",
  type: "document",
  url: "https://verify.stripe.com/start/test_fixtureUrl",
  verified_outputs: null,
};

/** A session as Stripe answers a read with both expands: verified, its report an object. */
const VERIFIED = {
  ...CREATED,
  status: "verified",
  url: null,
  last_verification_report: {
    id: "vr_1FixtureReport",
    object: "identity.verification_report",
    created: 1763900300,
    livemode: false,
    type: "document",
    document: { status: "verified", type: "passport", issuing_country: "FR", error: null },
    selfie: { status: "verified", error: null },
  },
  verified_outputs: {
    first_name: "Jenny",
    last_name: "Rosen",
    dob: { day: 4, month: 7, year: 1990 },
  },
};

function client(responses: FakeResponse[], timeoutMs?: number) {
  const f = fakeFetch(responses);
  return { c: new StripeIdentityClient({ key: KEY, fetch: f.fetch, timeoutMs }), calls: f.calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the requests, pinned", () => {
  test("a create posts the form body to the sessions URL with exactly the three headers", async () => {
    const { c, calls } = client([{ status: 200, body: CREATED }]);
    const out = await c.createSession({
      flowId: FLOW_ID,
      clientReferenceId: SESSION_ID,
      returnUrl: RETURN_URL,
      idempotencyKey: SESSION_ID,
    });
    expect(out).toEqual({
      providerRef: VS,
      url: "https://verify.stripe.com/start/test_fixtureUrl",
      livemode: false,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/identity/verification_sessions");
    expect(call.url).toBe(STRIPE_IDENTITY_SESSIONS_URL);
    expect(call.method).toBe("POST");
    // Exactly these three: no Stripe-Version, so the account's default version applies.
    expect(call.headers).toEqual({
      Authorization: `Bearer ${KEY_TEXT}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": SESSION_ID,
    });
    // No type, no options, no metadata, no provided_details: the flow carries the settings.
    expect(call.body).toBe(
      `verification_flow=${FLOW_ID}&client_reference_id=${SESSION_ID}&return_url=${RETURN_URL_FORM}`,
    );
    expect(new URLSearchParams(call.body).get("return_url")).toBe(RETURN_URL);
  });

  test("a read with the birth date expands the verified outputs, the birth date and the report", async () => {
    const { c, calls } = client([{ status: 200, body: VERIFIED }]);
    const s = await c.retrieveSession(VS, { withDob: true });
    expect(calls[0]!.url).toBe(
      `${SESSION_URL}?expand[]=verified_outputs&expand[]=verified_outputs.dob&expand[]=last_verification_report`,
    );
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers).toEqual({ Authorization: `Bearer ${KEY_TEXT}` });
    expect(calls[0]!.body).toBeUndefined();
    expect(s.id).toBe(VS);
    expect(s.status).toBe("verified");
    expect(s.outputs?.dob).toEqual({ year: 1990, month: 7, day: 4 });
    expect(s.report?.id).toBe("vr_1FixtureReport");
  });

  test("a read without the birth date expands the verified outputs and the report, never the birth date (rulings R3, R19)", async () => {
    const noDob = { ...VERIFIED, verified_outputs: { first_name: "Jenny", last_name: "Rosen" } };
    const { c, calls } = client([{ status: 200, body: noDob }]);
    const s = await c.retrieveSession(VS, { withDob: false });
    expect(calls[0]!.url).toBe(
      `${SESSION_URL}?expand[]=verified_outputs&expand[]=last_verification_report`,
    );
    // The names come with it: a verified session read this way can still be recorded.
    expect(s.outputs).toMatchObject({ firstName: "Jenny", lastName: "Rosen" });
    expect(s.outputs?.dob).toBeNull();
  });

  test("a cancel posts to the session's cancel URL, with no idempotency key", async () => {
    const { c, calls } = client([{ status: 200, body: { ...CREATED, status: "canceled" } }]);
    await expect(c.cancelSession(VS)).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`${SESSION_URL}/cancel`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({
      Authorization: `Bearer ${KEY_TEXT}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  test("a redact posts to the session's redact URL, with no idempotency key", async () => {
    const { c, calls } = client([
      { status: 200, body: { ...CREATED, redaction: { status: "processing" } } },
    ]);
    await expect(c.redactSession(VS)).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe(`${SESSION_URL}/redact`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers).toEqual({
      Authorization: `Bearer ${KEY_TEXT}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  test("redirects are never followed (the key would ride along)", async () => {
    const { c, calls } = client([{ status: 200, body: VERIFIED }]);
    await c.retrieveSession(VS, { withDob: true });
    expect(calls[0]!.redirect).toBe("error");
  });

  test("a session reference that is not a Stripe session id is refused before any request", async () => {
    const { c, calls } = client([{ status: 200, body: VERIFIED }]);
    await expect(c.retrieveSession("../../charges", { withDob: true })).rejects.toBeInstanceOf(
      StripeError,
    );
    await expect(c.cancelSession("vs_abc/../x")).rejects.toBeInstanceOf(StripeError);
    await expect(c.redactSession("")).rejects.toBeInstanceOf(StripeError);
    expect(calls).toHaveLength(0);
  });
});

describe("the errors, by status", () => {
  const cases: [number, new (...a: never[]) => StripeError][] = [
    [401, StripeKeyRejected],
    [403, StripeKeyRejected],
    [404, StripeNotFound],
    [429, StripeUnavailable],
    [500, StripeUnavailable],
    [502, StripeUnavailable],
    [503, StripeUnavailable],
  ];
  for (const [status, cls] of cases) {
    test(`HTTP ${status} throws ${cls.name}, a StripeError carrying the status`, async () => {
      const { c } = client([{ status, body: { error: { type: "api_error" } } }]);
      const e = await c.retrieveSession(VS, { withDob: true }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(cls);
      expect(e).toBeInstanceOf(StripeError);
      expect((e as StripeError).status).toBe(status);
    });
  }

  test("any other failing status throws a plain StripeError with that status", async () => {
    const { c } = client([
      {
        status: 400,
        body: { error: { type: "invalid_request_error", code: "parameter_unknown" } },
      },
    ]);
    const e = await c.retrieveSession(VS, { withDob: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StripeError);
    expect(e).not.toBeInstanceOf(StripeKeyRejected);
    expect(e).not.toBeInstanceOf(StripeNotFound);
    expect(e).not.toBeInstanceOf(StripeUnavailable);
    expect((e as StripeError).status).toBe(400);
    // Stripe's machine code is kept, for the caller's ops line; its sentence is not.
    expect((e as StripeError).code).toBe("parameter_unknown");
  });

  test("the create maps its failures the same way", async () => {
    const { c } = client([{ status: 401, body: {} }]);
    await expect(
      c.createSession({
        flowId: FLOW_ID,
        clientReferenceId: SESSION_ID,
        returnUrl: RETURN_URL,
        idempotencyKey: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(StripeKeyRejected);
  });

  test("cancel and redact map their failures the same way", async () => {
    const a = client([{ status: 404, body: {} }]);
    await expect(a.c.cancelSession(VS)).rejects.toBeInstanceOf(StripeNotFound);
    const b = client([{ status: 503, text: "<html>down</html>" }]);
    await expect(b.c.redactSession(VS)).rejects.toBeInstanceOf(StripeUnavailable);
  });

  test("a network failure throws StripeUnavailable with no status", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const c = new StripeIdentityClient({ key: KEY, fetch: f });
    const e = await c.retrieveSession(VS, { withDob: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StripeUnavailable);
    expect((e as StripeError).status).toBeNull();
  });

  test("a success whose body cannot be read throws StripeUnavailable (no verdict reached us)", async () => {
    const html = client([{ status: 200, text: "<html>a proxy page</html>" }]);
    await expect(html.c.retrieveSession(VS, { withDob: true })).rejects.toBeInstanceOf(
      StripeUnavailable,
    );
    const shape = client([{ status: 200, body: { id: VS, status: "verified" } }]);
    await expect(shape.c.retrieveSession(VS, { withDob: true })).rejects.toBeInstanceOf(
      StripeUnavailable,
    );
    const noUrl = client([{ status: 200, body: { ...CREATED, url: null } }]);
    await expect(
      noUrl.c.createSession({
        flowId: FLOW_ID,
        clientReferenceId: SESSION_ID,
        returnUrl: RETURN_URL,
        idempotencyKey: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(StripeUnavailable);
  });
});

describe("the deadline", () => {
  test("the default deadline is 10 seconds", () => {
    expect(STRIPE_TIMEOUT_MS).toBe(10_000);
  });

  test("a request that does not answer in time throws StripeUnavailable and is aborted", async () => {
    let seen: AbortSignal | undefined;
    const f = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const c = new StripeIdentityClient({ key: KEY, fetch: f, timeoutMs: 20 });
    const e = await c.retrieveSession(VS, { withDob: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StripeUnavailable);
    expect((e as StripeError).status).toBeNull();
    expect(seen?.aborted).toBe(true);
  });
});

describe("what never leaves the client", () => {
  test("an error carries neither the response body nor the key", async () => {
    const body = {
      error: {
        type: "invalid_request_error",
        code: "resource_missing",
        message: "Jenny Rosen, 1 Fixture Street, the reason text",
      },
    };
    for (const status of [400, 401, 404, 500]) {
      const { c } = client([{ status, body }]);
      const e = await c.retrieveSession(VS, { withDob: true }).catch((x: unknown) => x);
      const shown = `${String(e)} ${(e as Error).message} ${inspect(e)} ${JSON.stringify(e)}`;
      expect(shown).not.toContain("Jenny");
      expect(shown).not.toContain("Fixture Street");
      expect(shown).not.toContain(KEY_TEXT);
    }
  });

  test("an unreadable success does not quote the body in its error", async () => {
    const { c } = client([{ status: 200, text: "Jenny Rosen is not JSON" }]);
    const e = await c.retrieveSession(VS, { withDob: true }).catch((x: unknown) => x);
    expect(inspect(e)).not.toContain("Jenny");
  });

  test("the client logs nothing, and an inspected client shows no key", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { c } = client([
      { status: 200, body: VERIFIED },
      { status: 400, body: { error: { message: "Jenny Rosen" } } },
    ]);
    await c.retrieveSession(VS, { withDob: true });
    await c.retrieveSession(VS, { withDob: true }).catch(() => undefined);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(inspect(c)).not.toContain(KEY_TEXT);
    expect(JSON.stringify(c)).not.toContain(KEY_TEXT);
  });
});
