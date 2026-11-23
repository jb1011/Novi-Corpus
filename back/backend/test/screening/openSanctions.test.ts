/**
 * The person screener over OpenSanctions' match API (identity check plan, Task 5). What is pinned:
 *  1. the exact request: the URL with its query, the method, the two headers and no other, the
 *     JSON body (and the birth date left out when there is none), no redirect followed;
 *  2. the verdict: one result with `match: true` is a hit, results that all say `match: false`
 *     are clear;
 *  3. what is an error and never a verdict: a non-2xx, a timeout, a body that cannot be read, a
 *     per-query status other than 200, each with one ops line `person_screen_error { status }`;
 *  4. what never leaves the screener: the name, the birth date, the key.
 *
 * The fakes build NATIVE `Response` objects, so the capped body read runs over a real stream.
 * The person is made up.
 */
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toSecret } from "../../src/formation/pii";
import {
  OPENSANCTIONS_TIMEOUT_MS,
  OpenSanctionsPersonScreener,
} from "../../src/screening/personScreener";

/** A made-up key. Never a real one. */
const KEY_TEXT = "osk_fixtureKeyNotARealOne0000";
const KEY = toSecret(KEY_TEXT);

/** A made-up person. */
const NAME = "Mara Quillfeather";
const BIRTH_DATE = "1984-03-17";

/** The request for the default settings, spelled out rather than built, so the test pins it. */
const URL_DEFAULT =
  "https://api.opensanctions.org/match/default?algorithm=logic-v2&threshold=0.8&limit=5";

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

/** One result as the match API returns it. Its caption is a made-up listed person. */
function result(id: string, score: number, match: boolean) {
  return {
    id,
    caption: "Fixture Listed Person",
    schema: "Person",
    score,
    match,
    features: { name_literal_match: score },
    datasets: ["fixture_sanctions"],
    properties: { name: ["Fixture Listed Person"] },
  };
}

/** The match API's answer for query `q`. */
function answer(results: unknown[], status = 200) {
  return {
    responses: {
      q: { status, results, total: { value: results.length, relation: "eq" }, query: {} },
    },
    limit: 5,
  };
}

function screener(
  responses: FakeResponse[],
  opts: { dataset?: string; threshold?: number; timeoutMs?: number } = {},
) {
  const f = fakeFetch(responses);
  return {
    s: new OpenSanctionsPersonScreener({
      apiKey: KEY,
      dataset: opts.dataset ?? "default",
      threshold: opts.threshold ?? 0.8,
      fetch: f.fetch,
      timeoutMs: opts.timeoutMs,
    }),
    calls: f.calls,
  };
}

/** Every console method opsLog or anything else could write through. */
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  spies = CONSOLE_METHODS.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every line written to the console during the test, as text. */
function written(): string[] {
  return spies.flatMap((s) => s.mock.calls.map((args) => args.map((a) => String(a)).join(" ")));
}

/** The ops lines written during the test, parsed. */
function opsLines(): Record<string, unknown>[] {
  return written()
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => typeof l.opslog === "string");
}

/** Exactly one ops line, `person_screen_error`, carrying the status and nothing else. */
function expectOneErrorLine(status: number | string) {
  const lines = opsLines();
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line.opslog).toBe("person_screen_error");
  expect(line.status).toBe(status);
  expect(Object.keys(line).sort()).toEqual(["at", "opslog", "status"]);
}

describe("the request, pinned", () => {
  test("the exact URL, method, headers and body, and no redirect followed", async () => {
    const { s, calls } = screener([{ status: 200, body: answer([]) }]);
    await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(URL_DEFAULT);
    expect(call.method).toBe("POST");
    expect(call.headers).toEqual({
      Authorization: `ApiKey ${KEY_TEXT}`,
      "Content-Type": "application/json",
    });
    expect(call.redirect).toBe("error");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toBe(
      '{"queries":{"q":{"schema":"Person","properties":{"name":["Mara Quillfeather"],"birthDate":["1984-03-17"]}}}}',
    );
  });

  test("the body leaves the birth date out when there is none", async () => {
    const { s, calls } = screener([{ status: 200, body: answer([]) }]);
    await s.screenPerson({ name: NAME, birthDate: null });
    const body = JSON.parse(calls[0]!.body ?? "null");
    expect(body).toEqual({
      queries: { q: { schema: "Person", properties: { name: [NAME] } } },
    });
    expect(calls[0]!.body).not.toContain("birthDate");
  });

  test("the dataset and the threshold are the constructor's", async () => {
    const { s, calls } = screener([{ status: 200, body: answer([]) }], {
      dataset: "sanctions",
      threshold: 0.7,
    });
    await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE });
    expect(calls[0]!.url).toBe(
      "https://api.opensanctions.org/match/sanctions?algorithm=logic-v2&threshold=0.7&limit=5",
    );
  });

  test("a dataset that is not a plain path segment, or a threshold out of range, is refused", () => {
    const make = (dataset: string, threshold: number) => () =>
      new OpenSanctionsPersonScreener({ apiKey: KEY, dataset, threshold });
    expect(make("../admin", 0.8)).toThrow();
    expect(make("default?x=1", 0.8)).toThrow();
    expect(make("", 0.8)).toThrow();
    expect(make("default", 0)).toThrow();
    expect(make("default", 1.2)).toThrow();
    expect(make("default", Number.NaN)).toThrow();
  });
});

describe("the verdict", () => {
  test("one result with match: true is a hit", async () => {
    const { s } = screener([
      {
        status: 200,
        body: answer([
          result("Q1", 0.91, true),
          result("Q2", 0.6, false),
          result("Q3", 0.55, false),
        ]),
      },
    ]);
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("hit");
    expect(opsLines()).toHaveLength(0);
  });

  test("three results all with match: false are clear", async () => {
    const { s } = screener([
      {
        status: 200,
        body: answer([
          result("Q1", 0.79, false),
          result("Q2", 0.6, false),
          result("Q3", 0.55, false),
        ]),
      },
    ]);
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("clear");
    expect(opsLines()).toHaveLength(0);
  });

  test("no results is clear", async () => {
    const { s } = screener([{ status: 200, body: answer([]) }]);
    expect(await s.screenPerson({ name: NAME, birthDate: null })).toBe("clear");
  });

  test("a readable match is a hit even beside an unreadable result, in either order", async () => {
    const unreadable = { id: "Q2", score: 0.99, match: "yes" };
    for (const results of [
      [result("Q1", 0.95, true), unreadable],
      [unreadable, result("Q1", 0.95, true)],
      [null, result("Q1", 0.95, true)],
    ]) {
      const { s } = screener([{ status: 200, body: answer(results) }]);
      expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("hit");
    }
    expect(opsLines()).toHaveLength(0);
  });
});

describe("an error is never a verdict", () => {
  for (const status of [500, 429, 401, 400]) {
    test(`HTTP ${status} is an error, with one ops line carrying the status`, async () => {
      const { s } = screener([{ status, body: { detail: `${NAME} ${BIRTH_DATE}` } }]);
      expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
      expectOneErrorLine(status);
    });
  }

  test("a request that does not answer in time is an error, and is aborted", async () => {
    let seen: AbortSignal | undefined;
    const f = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    const s = new OpenSanctionsPersonScreener({
      apiKey: KEY,
      dataset: "default",
      threshold: 0.8,
      fetch: f,
      timeoutMs: 20,
    });
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    expect(seen?.aborted).toBe(true);
    expectOneErrorLine("timeout");
  });

  test("the default deadline is 10 seconds", () => {
    expect(OPENSANCTIONS_TIMEOUT_MS).toBe(10_000);
  });

  test("an empty object is an error", async () => {
    const { s } = screener([{ status: 200, body: {} }]);
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    expectOneErrorLine("unreadable");
  });

  test("a body that is not JSON is an error", async () => {
    const { s } = screener([{ status: 200, text: `${NAME} is not JSON` }]);
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    expectOneErrorLine("unreadable");
  });

  test("results that are not a list, or an unreadable result with no readable match, are an error", async () => {
    const bodies = [
      { responses: { q: { status: 200, results: "none" } } },
      { responses: { q: { status: 200 } } },
      { responses: { other: answer([]).responses.q } },
      answer([result("Q1", 0.5, false), { id: "Q2", score: 0.99, match: "yes" }]),
      answer([null]),
    ];
    for (const body of bodies) {
      const { s } = screener([{ status: 200, body }]);
      expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    }
    const lines = opsLines();
    expect(lines).toHaveLength(bodies.length);
    for (const line of lines) expect(line.status).toBe("unreadable");
  });

  test("a per-query status other than 200 inside a 200 answer is an error", async () => {
    const { s } = screener([{ status: 200, body: answer([], 400) }]);
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    expectOneErrorLine("query_400");
  });

  test("a request that does not complete is an error", async () => {
    const f = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${NAME}`);
    }) as unknown as typeof fetch;
    const s = new OpenSanctionsPersonScreener({
      apiKey: KEY,
      dataset: "default",
      threshold: 0.8,
      fetch: f,
    });
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    expectOneErrorLine("unreachable");
  });

  test("a body over the size cap is an error", async () => {
    const { s } = screener([{ status: 200, text: `{"pad":"${"x".repeat(2 * 1024 * 1024)}"}` }]);
    expect(await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE })).toBe("error");
    expectOneErrorLine("unreadable");
  });

  test("a blank name or a birth date not shaped YYYY-MM-DD is an error, and nothing is sent", async () => {
    const { s, calls } = screener([{ status: 200, body: answer([]) }]);
    expect(await s.screenPerson({ name: "   ", birthDate: BIRTH_DATE })).toBe("error");
    expect(await s.screenPerson({ name: NAME, birthDate: "17/03/1984" })).toBe("error");
    expect(calls).toHaveLength(0);
    const lines = opsLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.status).toBe("invalid_query");
  });
});

describe("what never leaves the screener", () => {
  test("the name, the birth date and the key appear in no console or ops output", async () => {
    const leaky = { detail: `${NAME} born ${BIRTH_DATE}`, key: KEY_TEXT };
    const cases: FakeResponse[][] = [
      [{ status: 200, body: answer([result("Q1", 0.95, true)]) }],
      [{ status: 200, body: answer([result("Q1", 0.5, false)]) }],
      [{ status: 500, body: leaky }],
      [{ status: 429, body: leaky }],
      [{ status: 422, body: leaky }],
      [{ status: 200, body: answer([], 500) }],
      [{ status: 200, text: `${NAME} ${BIRTH_DATE} not JSON` }],
      [{ status: 200, body: {} }],
    ];
    for (const responses of cases) {
      const { s } = screener(responses);
      await s.screenPerson({ name: NAME, birthDate: BIRTH_DATE });
    }
    const hanging = new OpenSanctionsPersonScreener({
      apiKey: KEY,
      dataset: "default",
      threshold: 0.8,
      fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      timeoutMs: 20,
    });
    await hanging.screenPerson({ name: NAME, birthDate: BIRTH_DATE });

    const out = written().join("\n");
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("Mara");
    expect(out).not.toContain("Quillfeather");
    expect(out).not.toContain(BIRTH_DATE);
    expect(out).not.toContain("1984");
    expect(out).not.toContain(KEY_TEXT);
    // Only the error ops line is ever written: a verdict writes nothing.
    for (const line of opsLines()) expect(line.opslog).toBe("person_screen_error");
  });

  test("an inspected or serialized screener shows no key", () => {
    const { s } = screener([]);
    expect(inspect(s)).not.toContain(KEY_TEXT);
    expect(JSON.stringify(s)).not.toContain(KEY_TEXT);
    expect(String(s)).not.toContain(KEY_TEXT);
  });
});
