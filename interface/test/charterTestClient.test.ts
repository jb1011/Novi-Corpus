/**
 * The test page's own calls, against a stubbed `fetch`: each goes through the site's proxy with
 * the session's bearer token, and a refusal is the API's own code and sentence.
 *
 * The amounts here are made up.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

const TOKEN = "session-token-for-tests";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Fresh modules, with `API_URL` at its default. */
async function load() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_API_URL", undefined);
  const config = await import("@/lib/api/config");
  const calls = await import("@/lib/charterTest/client");
  const { ApiError } = await import("@/lib/api/types");
  return { API_URL: config.API_URL, calls, ApiError };
}

type Seen = { url: string; init: RequestInit };

function stubFetch(answer: () => Response): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init });
      return answer();
    }),
  );
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headerOf = (seen: Seen, name: string) => new Headers(seen.init.headers).get(name);

describe("the grant doors", () => {
  test("the form is a GET with the session's token and no body", async () => {
    const { API_URL, calls } = await load();
    const seen = stubFetch(() => json({ takesGrant: false }));
    expect(await calls.getGrantForm(TOKEN)).toEqual({ takesGrant: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${API_URL}/legal-body-orders/grant-form`);
    expect(seen[0].init.method).toBe("GET");
    expect(seen[0].init.body).toBeUndefined();
    expect(headerOf(seen[0], "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("the preview posts the grant under `grant`, as given", async () => {
    const { API_URL, calls } = await load();
    const seen = stubFetch(() => json({ grant: { number: 1 } }));
    const grant = { acts: { buy: { allowed: true, perAct: "7.5" } }, endsOn: null };
    expect(await calls.previewGrant(TOKEN, grant)).toEqual({ grant: { number: 1 } });
    expect(seen[0].url).toBe(`${API_URL}/legal-body-orders/grant-preview`);
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ grant });
    expect(headerOf(seen[0], "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("an order's grant is read at the order's own path", async () => {
    const { API_URL, calls } = await load();
    const seen = stubFetch(() => json({ grant: null }));
    expect(await calls.getOrderGrant(TOKEN, "lb_a/b")).toEqual({ grant: null });
    expect(seen[0].url).toBe(`${API_URL}/legal-body-orders/lb_a%2Fb/grant`);
    expect(seen[0].init.method).toBe("GET");
  });
});

describe("the order", () => {
  test("with a grant, the body is the company and the grant", async () => {
    const { API_URL, calls } = await load();
    const seen = stubFetch(() => json({ id: "lb_1" }, 201));
    const grant = { counterparties: "anyone" };
    expect(await calls.placeOrder(TOKEN, "co_1", grant)).toEqual({ id: "lb_1" });
    expect(seen[0].url).toBe(`${API_URL}/legal-body-orders`);
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ companyId: "co_1", grant });
  });

  test("with none, the body has no `grant` key at all", async () => {
    const { calls } = await load();
    const seen = stubFetch(() => json({ id: "lb_1" }, 201));
    await calls.placeOrder(TOKEN, "co_1", undefined);
    expect(String(seen[0].init.body)).toBe('{"companyId":"co_1"}');
  });

  test("a grant of null is sent as null, for the server to answer", async () => {
    const { calls } = await load();
    const seen = stubFetch(() => json({ id: "lb_1" }, 201));
    await calls.placeOrder(TOKEN, "co_1", null);
    expect(String(seen[0].init.body)).toBe('{"companyId":"co_1","grant":null}');
  });
});

describe("the adoption message", () => {
  test("a POST with no body, answered as served", async () => {
    const { API_URL, calls } = await load();
    const served = { typedData: { primaryType: "LegalBodyCharterAdoption" }, issuedAt: "1800000000" };
    const seen = stubFetch(() => json(served));
    expect(await calls.requestAdoptionMessage(TOKEN, "lb_1")).toEqual(served);
    expect(seen[0].url).toBe(`${API_URL}/legal-body-orders/lb_1/adoption-message`);
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBeUndefined();
  });
});

describe("a refusal", () => {
  test("is the API's own status, code, sentence and details", async () => {
    const { calls, ApiError } = await load();
    const details = [{ field: "grant", problem: "must allow at least one act" }];
    stubFetch(() =>
      json({ error: { code: "grant_not_valid", message: "The grant is not valid.", details } }, 400),
    );
    const thrown = await calls.previewGrant(TOKEN, {}).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      status: 400,
      code: "grant_not_valid",
      message: "The grant is not valid.",
      details,
    });
  });
});
