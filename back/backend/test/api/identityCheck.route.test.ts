/**
 * The identity check routes (`src/api/routes/identityCheck.ts`): the guardian's identity step in
 * the browser. `POST /identity-check/sessions` starts a check (or reuses the one under way) and
 * answers our session id, the provider's URL and its expiry; `GET /identity-check/session` shows
 * the open session, ids and counts only; `POST /identity-check/sync` reads the tenant's open
 * session back from the provider, at most once every 5 seconds per tenant, and answers the
 * outcome and the identity state. Every rule of a check is the service's (`identity/sessions.ts`);
 * these tests hold the routes to what they add: the session, the body's shape, the throttle, the
 * cache header, and answers that never carry the provider's session id, a name or a birth date.
 *
 * The database is real (in memory). The provider is a fake held in memory, each test making the
 * person do what it needs. Every name and birth date is a made-up fixture, every tenant an
 * invented address, the keys constant test keys; and no line written to the console by any test
 * may hold the fixture's names or its birth date (checked after each test).
 */
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type IdentityProviderClient,
  StripeNotFound,
  StripeUnavailable,
} from "../../src/adapters/stripe/identityClient";
import type { ProviderSession } from "../../src/adapters/stripe/mapSession";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { signSession } from "../../src/auth/session";
import type { IdentitySessionDeps } from "../../src/identity/sessions";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqliteIdentitySessionRepository } from "../../src/persistence/identitySessionRepository";
import { TaskTracker } from "../../src/util/taskTracker";
import { TEST_PII_RING, recordHuman, worldFor } from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import {
  JWT_SECRET,
  type Json,
  type LegalBodyStores,
  answerOf,
  call,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** 20 November 2026, 12:00 UTC: when the first session starts. */
const T0 = Date.UTC(2026, 10, 20, 12);
const ORIGIN = "https://testnet.example.com";
const FLOW = "vf_test_flow";

/** The guardian's typed name, made up, and the document's as the provider extracts it. */
const TYPED = { firstName: "Ottilie", lastName: "Brandwick" } as const;
const ON_DOCUMENT = { firstName: "OTTILIE", lastName: "BRANDWICK" } as const;
/** A made-up birth date, as the provider gives it. */
const DOB = { year: 1987, month: 3, day: 14 } as const;
/** What no answer of the three routes and no console line may hold. */
const NEVER_SHOWN = ["ottilie", "brandwick", "1987-03-14", "19870314", "vs_", "vr_"];
const NEVER_LOGGED = ["ottilie", "brandwick", "1987-03-14", "19870314"];

/** A tenant id as the session spells it: EIP-55 checksummed. */
const tenant = (n: number): Address =>
  getAddress(`0x${"cd".repeat(18)}${n.toString(16).padStart(4, "0")}`);
const GUARDIAN = tenant(1);
const OTHER = tenant(2);
/** A signed-in account with no World row. */
const UNVERIFIED = tenant(9);

const ROUTES = [
  ["POST", "/identity-check/sessions"],
  ["GET", "/identity-check/session"],
  ["POST", "/identity-check/sync"],
] as const;

// ── the fake provider ───────────────────────────────────────────────────────────────────────

/** The provider, in memory: sessions by their `vs_` id, and what each test makes the person do. */
class FakeProvider implements IdentityProviderClient {
  readonly sessions = new Map<string, ProviderSession>();
  readonly created: Parameters<IdentityProviderClient["createSession"]>[0][] = [];
  reads = 0;
  /** An error the next create, or the next read, throws once. */
  failNextCreate: Error | undefined;
  failNextRead: Error | undefined;
  #count = 0;
  #urls = 0;

  async createSession(input: Parameters<IdentityProviderClient["createSession"]>[0]) {
    this.created.push(input);
    const err = this.failNextCreate;
    this.failNextCreate = undefined;
    if (err) throw err;
    this.#count += 1;
    const id = `vs_test${this.#count}`;
    this.sessions.set(id, {
      id,
      livemode: false,
      status: "requires_input",
      clientReferenceId: input.clientReferenceId,
      url: null,
      lastErrorCode: null,
      redaction: null,
      outputs: null,
      report: null,
    });
    return { providerRef: id, url: this.#freshUrl(), livemode: false };
  }

  async retrieveSession(ref: string, opts: { withDob: boolean }): Promise<ProviderSession> {
    this.reads += 1;
    const err = this.failNextRead;
    this.failNextRead = undefined;
    if (err) throw err;
    const s = this.sessions.get(ref);
    if (s === undefined) throw new StripeNotFound(404, "Stripe Identity retrieve: HTTP 404");
    const waiting = s.status === "requires_input" && s.redaction === null;
    return {
      ...s,
      url: waiting ? this.#freshUrl() : null,
      outputs:
        s.outputs === null ? null : { ...s.outputs, dob: opts.withDob ? s.outputs.dob : null },
    };
  }

  async cancelSession(ref: string): Promise<void> {
    this.update(ref, { status: "canceled" });
  }

  async redactSession(ref: string): Promise<void> {
    this.update(ref, { redaction: "processing" });
  }

  #freshUrl(): string {
    this.#urls += 1;
    return `https://verify.example.test/start/test_url_${this.#urls}`;
  }

  update(ref: string, patch: Partial<ProviderSession>): void {
    const s = this.sessions.get(ref);
    if (s === undefined) throw new Error(`no fake session ${ref}`);
    this.sessions.set(ref, { ...s, ...patch });
  }

  /** The person passed the document and the selfie; the document reads the typed name. */
  verify(ref: string): void {
    this.update(ref, {
      status: "verified",
      lastErrorCode: null,
      outputs: { ...ON_DOCUMENT, dob: DOB },
      report: {
        id: `vr_${ref.slice(3)}done`,
        created: Math.floor((T0 + MINUTE) / 1000),
        documentType: "passport",
        issuingCountry: "FR",
        selfieStatus: "verified",
      },
    });
  }
}

// ── the harness ─────────────────────────────────────────────────────────────────────────────

let db: Database.Database;
let s: LegalBodyStores;
let sessions: SqliteIdentitySessionRepository;
let world: WorldIdDeps;
let provider: FakeProvider;
let identityCheck: IdentitySessionDeps;
let now: number;
let output: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  sessions = new SqliteIdentitySessionRepository(db);
  world = worldFor(s.store);
  for (const t of [GUARDIAN, OTHER]) recordHuman(s.store, t, `0xnullifier-${t}`, T0 - DAY);
  provider = new FakeProvider();
  now = T0;
  const identity = {
    repo: new SqliteIdentityRepository(db),
    pii: TEST_PII_RING,
    reverifyYears: 3,
    blockedCountries: new Set(["PRK"]),
    now: () => now,
    nameHmacKey: Buffer.alloc(32, 5),
    automatic: true,
  };
  identityCheck = {
    identity,
    world,
    sessions,
    provider,
    // A sandbox without a screener key: the search is not run.
    screener: undefined,
    environment: "sandbox",
    flowId: FLOW,
    webOrigin: ORIGIN,
    limits: { sessionDays: 14, maxPerDay: 3, attemptsPerSession: 3, redactAfterDays: 7 },
    tasks: new TaskTracker("identity_session"),
    now: () => now,
  };
  output = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  for (const line of output)
    for (const word of NEVER_LOGGED) expect(line.toLowerCase(), line).not.toContain(word);
});

/** The API over this test's database: World ID, the identity record, the order doors of a
 *  sandbox (so `/world-id/me` carries the identity block), and the identity check unless `check`
 *  is null. */
function makeApp(check: IdentitySessionDeps | null = identityCheck) {
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo: new SqliteEntityRepository(db),
    documents: new SqliteDocumentIndexRepository(db),
    docStore: new DeletableMemoryDocumentStore(),
    worldId: world,
    identity: identityCheck.identity,
    legalBodyOrders: legalBodyOrderDeps(s, { world, environment: "sandbox" }),
    identityCheck: check ?? undefined,
  };
  return buildApiApp(deps as ApiDeps);
}

type App = ReturnType<typeof makeApp>;

async function tokenOf(tenantId: Address): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

/** One request, its status, body, raw text and Cache-Control header. */
async function ask(
  app: App,
  method: "GET" | "POST",
  path: string,
  tenantId: Address | undefined,
  body?: string | object,
): Promise<{ status: number; body: Json; text: string; cache: string | null }> {
  const res = await call(
    app,
    method,
    path,
    tenantId === undefined ? undefined : await tokenOf(tenantId),
    body,
  );
  const cache = res.headers.get("cache-control");
  return { ...(await answerOf(res)), cache };
}

const start = (app: App, tenantId: Address = GUARDIAN, body: string | object = TYPED) =>
  ask(app, "POST", "/identity-check/sessions", tenantId, body);
const view = (app: App, tenantId: Address = GUARDIAN) =>
  ask(app, "GET", "/identity-check/session", tenantId);
const sync = (app: App, tenantId: Address = GUARDIAN) =>
  ask(app, "POST", "/identity-check/sync", tenantId);

/** The provider's ref of one of our sessions. */
function refOf(sessionId: string): string {
  const row = sessions.byId(sessionId);
  if (row === undefined) throw new Error("no session row");
  return row.providerRef;
}

/** No answer text holds the provider's ids, the fixture's names or its birth date. */
function expectNothingShown(texts: string[]): void {
  for (const text of texts)
    for (const word of NEVER_SHOWN) expect(text.toLowerCase(), text).not.toContain(word);
}

// ── the tests ───────────────────────────────────────────────────────────────────────────────

describe("the identity check routes", () => {
  test("without the identity check on this deployment, each route answers 404 identity_check_not_offered", async () => {
    const app = makeApp(null);
    for (const [method, path] of ROUTES) {
      const answer = await ask(app, method, path, GUARDIAN, method === "POST" ? TYPED : undefined);
      expect(answer.status, path).toBe(404);
      expect(answer.body.error.code, path).toBe("identity_check_not_offered");
    }
    expect(provider.created).toHaveLength(0);
  });

  test("without a session, each route answers 401 and nothing is asked of the provider", async () => {
    const app = makeApp();
    for (const [method, path] of ROUTES) {
      const answer = await ask(app, method, path, undefined, method === "POST" ? TYPED : undefined);
      expect(answer.status, path).toBe(401);
    }
    // Without the deps too: the prefix is protected before the routes are reached.
    for (const [method, path] of ROUTES)
      expect((await ask(makeApp(null), method, path, undefined)).status, path).toBe(401);
    expect(provider.created).toHaveLength(0);
    expect(provider.reads).toBe(0);
  });

  test("POST /identity-check/sessions answers 201 with our session id, the provider's URL and its expiry 48 hours on, and nothing else, uncached", async () => {
    const answer = await start(makeApp(), GUARDIAN, { ...TYPED, returnPath: "/legal-body/orders" });
    expect(answer.status).toBe(201);
    expect(answer.cache).toBe("private, no-store");
    expect(Object.keys(answer.body).sort()).toEqual(["expiresAt", "sessionId", "url"]);
    expect(answer.body.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(answer.body.url).toBe("https://verify.example.test/start/test_url_1");
    expect(answer.body.expiresAt).toBe(T0 + 48 * HOUR);
    // The provider's session is created under our id, and returns the person to the path given.
    expect(provider.created).toEqual([
      {
        flowId: FLOW,
        clientReferenceId: answer.body.sessionId,
        returnUrl: `${ORIGIN}/legal-body/orders?identityCheck=returned`,
        idempotencyKey: answer.body.sessionId,
      },
    ]);
    expectNothingShown([answer.text]);
  });

  test("a second POST while the session is open answers the same session id and a fresh URL, and the provider makes no second session", async () => {
    const app = makeApp();
    const first = await start(app);
    now += MINUTE;
    const second = await start(app);
    expect(second.status).toBe(201);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect(second.body.url).toMatch(/^https:\/\/verify\.example\.test\/start\/test_url_\d+$/);
    expect(second.body.url).not.toBe(first.body.url);
    expect(second.body.expiresAt).toBe(T0 + MINUTE + 48 * HOUR);
    expect(provider.created).toHaveLength(1);
    expectNothingShown([first.text, second.text]);
  });

  test("the fourth distinct session in a day answers 429 identity_session_limit", async () => {
    const app = makeApp();
    const ids = new Set<string>();
    for (let n = 0; n < 3; n += 1) {
      const answer = await start(app);
      expect(answer.status).toBe(201);
      ids.add(answer.body.sessionId);
      // The person leaves: the provider cancels the session, and the next start closes it.
      provider.update(refOf(answer.body.sessionId), { status: "canceled" });
      now += HOUR;
    }
    expect(ids.size).toBe(3);
    const fourth = await start(app);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe("identity_session_limit");
    expect(fourth.cache).toBe("private, no-store");
    expect(provider.created).toHaveLength(3);
  });

  test("GET /identity-check/session reads none, then open with ids and counts only, then none once a sync completed it", async () => {
    const app = makeApp();
    const before = await view(app);
    expect(before.status).toBe(200);
    expect(before.cache).toBe("private, no-store");
    expect(before.body).toEqual({ status: "none" });

    const started = await start(app);
    const open = await view(app);
    expect(open.status).toBe(200);
    expect(open.cache).toBe("private, no-store");
    expect(open.body).toEqual({
      status: "open",
      sessionId: started.body.sessionId,
      startedAt: T0,
      attemptsLeft: 3,
      lastErrorCode: null,
      reading: false,
    });

    provider.verify(refOf(started.body.sessionId));
    expect((await sync(app)).body.outcome).toBe("completed");
    const after = await view(app);
    expect(after.body).toEqual({ status: "none" });
    expectNothingShown([before.text, open.text, after.text]);
  });

  test("POST /identity-check/sync completes a verified session, answers completed and verified, and /world-id/me then reads verified under the typed names", async () => {
    const app = makeApp();
    const started = await start(app);
    provider.verify(refOf(started.body.sessionId));
    now += 2 * MINUTE;
    const answer = await sync(app);
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("private, no-store");
    expect(answer.body).toEqual({ outcome: "completed", state: "verified" });
    expectNothingShown([answer.text]);

    const res = await app.request("/world-id/me", {
      headers: { authorization: `Bearer ${await tokenOf(GUARDIAN)}` },
    });
    expect(res.status).toBe(200);
    const me = (await res.json()) as Json;
    expect(me.identity).toMatchObject({
      required: false,
      automatic: true,
      state: "verified",
      firstName: TYPED.firstName,
      lastName: TYPED.lastName,
    });
  });

  test("POST /identity-check/sync without an open session answers unchanged and the state, and reads nothing at the provider", async () => {
    const answer = await sync(makeApp());
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("private, no-store");
    expect(answer.body).toEqual({ outcome: "unchanged", state: "none" });
    expect(provider.reads).toBe(0);
  });

  test("a session still waiting for the person syncs as processing, its state pending", async () => {
    const app = makeApp();
    await start(app);
    const answer = await sync(app);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ outcome: "processing", state: "pending" });
  });

  test("a second sync within 5 seconds answers 429 identity_sync_too_soon, uncached; a refused call does not move the window, which is the tenant's own and the app's own", async () => {
    const app = makeApp();
    await start(app);
    expect((await sync(app)).status).toBe(200);
    const readsAfterFirst = provider.reads;

    now = T0 + 4_999;
    const tooSoon = await sync(app);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.cache).toBe("private, no-store");
    expect(tooSoon.body.error.code).toBe("identity_sync_too_soon");
    expect(tooSoon.body.error.message).toBe(
      "the identity check was read a moment ago: wait a few seconds before reading it again",
    );
    expect(provider.reads).toBe(readsAfterFirst);

    // Another tenant is not held by this tenant's call, nor is another app by this one's.
    expect((await sync(app, OTHER)).status).toBe(200);
    expect((await sync(makeApp())).status).toBe(200);

    // Five seconds after the call that was answered, not after the refused one.
    now = T0 + 5_000;
    expect((await sync(app)).status).toBe(200);
  });

  test("a body the route cannot read answers 400 validation_error, and nothing is asked of the provider", async () => {
    const app = makeApp();
    const bodies: (string | object)[] = [
      "{not json",
      { lastName: TYPED.lastName },
      { firstName: 7, lastName: TYPED.lastName },
      { ...TYPED, returnPath: 42 },
      // The service's own rules: a name too long, a return path off this site.
      { firstName: "x".repeat(101), lastName: TYPED.lastName },
      { ...TYPED, returnPath: "https://elsewhere.example.com/" },
    ];
    for (const body of bodies) {
      const answer = await start(app, GUARDIAN, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body.error.code, JSON.stringify(body)).toBe("validation_error");
      expectNothingShown([answer.text]);
    }
    expect(provider.created).toHaveLength(0);
  });

  test("a body over 4 KiB answers 413 payload_too_large before it is read, and nothing is asked of the provider", async () => {
    const answer = await start(makeApp(), GUARDIAN, { ...TYPED, firstName: "x".repeat(5_000) });
    expect(answer.status).toBe(413);
    expect(answer.body.error.code).toBe("payload_too_large");
    expect(provider.created).toHaveLength(0);
  });

  test("the service's refusals pass through: 403 without a World row, 409 once verified", async () => {
    const app = makeApp();
    const unverified = await start(app, UNVERIFIED);
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe("guardian_not_verified");

    const started = await start(app);
    provider.verify(refOf(started.body.sessionId));
    expect((await sync(app)).body.outcome).toBe("completed");
    const again = await start(app);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("identity_already_verified");
  });

  test("an unavailable provider answers 503 identity_provider_unavailable, in our own words", async () => {
    const app = makeApp();
    provider.failNextCreate = new StripeUnavailable(503, "Stripe Identity create: HTTP 503");
    const answer = await start(app);
    expect(answer.status).toBe(503);
    expect(answer.body.error.code).toBe("identity_provider_unavailable");
    expect(answer.text.toLowerCase()).not.toContain("stripe");
  });

  test("an error the service did not choose answers 500 internal_error with a fixed sentence, never its own message, and one ops line naming the route", async () => {
    const app = makeApp();
    await start(app);
    provider.failNextRead = Object.assign(new Error("upstream refused vs_test1 for Ottilie"), {
      status: 418,
    });
    const answer = await sync(app);
    expect(answer.status).toBe(500);
    expect(answer.cache).toBe("private, no-store");
    expect(answer.body.error).toEqual({
      code: "internal_error",
      message: "something went wrong on our side: try again in a moment",
    });
    expectNothingShown([answer.text]);
    const lines = output
      .filter((line) => line.startsWith('{"opslog"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((l) => l.opslog === "identity_check_route_failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: "sync", errorName: "Error" });
  });

  test("no answer of a whole check carries the provider's session id, a name or a birth date", async () => {
    const app = makeApp();
    const texts: string[] = [];
    const first = await start(app);
    texts.push(first.text, (await start(app)).text, (await view(app)).text);
    now += 10_000;
    texts.push((await sync(app)).text);
    provider.verify(refOf(first.body.sessionId));
    now += 10_000;
    texts.push((await sync(app)).text, (await view(app)).text, (await start(app)).text);
    now += 1_000;
    // Refused: the last sync was a second ago.
    texts.push((await sync(app)).text);
    now += 5_000;
    texts.push((await sync(app)).text);
    expectNothingShown(texts);
    // The provider's ref itself, whatever its spelling.
    for (const text of texts) expect(text).not.toContain(refOf(first.body.sessionId));
  });
});
