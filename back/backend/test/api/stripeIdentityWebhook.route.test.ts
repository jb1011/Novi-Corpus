/**
 * The Stripe Identity webhook (`src/api/routes/stripeIdentityWebhook.ts`): Stripe's call when an
 * identity session changes. It is public and authenticated by Stripe's signature alone, and it is
 * a wake-up signal, never a source of facts: it reads the event id, the type, `livemode`, the
 * session's `vs_` id and `client_reference_id`, finds our session, and asks the session service to
 * read that session back from the provider. These tests hold it to that, and to the properties
 * that keep the endpoint trustworthy and alive (the doola receiver's): every signature failure is
 * one constant 401 and never a 500; a stale but authentic event is a 200; an event for another
 * mode or another session is a 200 that does nothing; the ack goes out before the read.
 *
 * The database is real (in memory), the provider a fake held in memory. Every name and birth date
 * is a made-up fixture, every tenant an invented address, the secrets constant test values; and
 * no line written to the console by any test may hold the fixture's names, its birth date, the
 * provider's session id or a signature (checked after each test).
 */
import { createHmac } from "node:crypto";
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
import {
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  type StripeIdentityWebhookDeps,
  parseStripeEvent,
} from "../../src/api/routes/stripeIdentityWebhook";
import { toSecret } from "../../src/formation/pii";
import { type IdentitySessionDeps, startSession } from "../../src/identity/sessions";
import { identityState } from "../../src/identity/state";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqliteIdentitySessionRepository } from "../../src/persistence/identitySessionRepository";
import type { PersonScreener, ScreenVerdict } from "../../src/screening/personScreener";
import { TaskTracker } from "../../src/util/taskTracker";
import { TEST_PII_RING, recordHuman, worldFor } from "../helpers/customerCompanyFixtures";
import { openLegalBodyStores } from "../helpers/legalBodyFixtures";

const DAY = 86_400_000;
const MINUTE = 60_000;
/** 20 November 2026, 12:00 UTC: when the session starts. */
const T0 = Date.UTC(2026, 10, 20, 12);
const SECRET = "whsec_test_current";
const PREVIOUS = "whsec_test_previous";
const FLOW = "vf_test_flow";

/** The guardian's typed name, made up, and the document's as the provider extracts it. */
const TYPED = { firstName: "Ottilie", lastName: "Brandwick" } as const;
const ON_DOCUMENT = { firstName: "OTTILIE", lastName: "BRANDWICK" } as const;
/** A made-up birth date, as the provider gives it. */
const DOB = { year: 1987, month: 3, day: 14 } as const;
/** Names a forged payload claims; the receiver never reads them, so they reach nothing. */
const CLAIMED = { first_name: "Mallory", last_name: "Forgewell" } as const;
/** What no console line may hold. The signatures are checked per test (they change with `t`). */
const NEVER_LOGGED = [
  "ottilie",
  "brandwick",
  "1987-03-14",
  "mallory",
  "forgewell",
  "vs_",
  "whsec_",
  "v1=",
];

const tenant = (n: number): Address =>
  getAddress(`0x${"cd".repeat(18)}${n.toString(16).padStart(4, "0")}`);
const GUARDIAN = tenant(1);

// ── the fake provider ───────────────────────────────────────────────────────────────────────

/** The provider, in memory: sessions by their `vs_` id, and what each test makes the person do. */
class FakeProvider implements IdentityProviderClient {
  readonly sessions = new Map<string, ProviderSession>();
  reads = 0;
  /** An error the next read throws once. */
  failNextRead: Error | undefined;
  /** While set (`holdReads`), every read waits for it: the ack can then be shown to precede the
   *  read. The read answers the session as it stood when the read began. */
  hold: Promise<void> | undefined;
  #release: (() => void) | undefined;
  /** Reads under way now, and the most there ever were at once. */
  inflight = 0;
  maxInflight = 0;
  #count = 0;
  #urls = 0;

  async createSession(input: Parameters<IdentityProviderClient["createSession"]>[0]) {
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
    const s = this.sessions.get(ref);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (this.hold !== undefined) await this.hold;
      this.reads += 1;
      const err = this.failNextRead;
      this.failNextRead = undefined;
      if (err) throw err;
      if (s === undefined) throw new StripeNotFound(404, "Stripe Identity retrieve: HTTP 404");
      const waiting = s.status === "requires_input" && s.redaction === null;
      return {
        ...s,
        url: waiting ? this.#freshUrl() : null,
        outputs:
          s.outputs === null ? null : { ...s.outputs, dob: opts.withDob ? s.outputs.dob : null },
      };
    } finally {
      this.inflight -= 1;
    }
  }

  async cancelSession(ref: string): Promise<void> {
    this.update(ref, { status: "canceled" });
  }

  async redactSession(ref: string): Promise<void> {
    this.update(ref, { redaction: "processing" });
  }

  /** Every read from now on waits until `releaseReads`. */
  holdReads(): void {
    this.hold = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  /** Lets the held reads go; also called after each test, so a failed assertion cannot hang it. */
  releaseReads(): void {
    this.#release?.();
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

/** The sanctions screen, in memory: it counts the people it is asked about, and clears them. */
class FakeScreener implements PersonScreener {
  screens = 0;

  async screenPerson(): Promise<ScreenVerdict> {
    this.screens += 1;
    return "clear";
  }
}

// ── the harness ─────────────────────────────────────────────────────────────────────────────

let db: Database.Database;
let sessions: SqliteIdentitySessionRepository;
let provider: FakeProvider;
let tasks: TaskTracker;
let identityCheck: IdentitySessionDeps;
let now: number;
let output: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  const s = openLegalBodyStores(db);
  sessions = new SqliteIdentitySessionRepository(db);
  const world = worldFor(s.store);
  recordHuman(s.store, GUARDIAN, `0xnullifier-${GUARDIAN}`, T0 - DAY);
  provider = new FakeProvider();
  tasks = new TaskTracker("identity_session");
  now = T0;
  identityCheck = {
    identity: {
      repo: new SqliteIdentityRepository(db),
      pii: TEST_PII_RING,
      reverifyYears: 3,
      blockedCountries: new Set(["PRK"]),
      now: () => now,
      nameHmacKey: Buffer.alloc(32, 5),
      automatic: true,
    },
    world,
    sessions,
    provider,
    // A sandbox without a screener key: the search is not run.
    screener: undefined,
    environment: "sandbox",
    flowId: FLOW,
    webOrigin: "https://testnet.example.com",
    limits: { sessionDays: 14, maxPerDay: 3, attemptsPerSession: 3, redactAfterDays: 7 },
    tasks,
    now: () => now,
  };
  output = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
});

afterEach(async () => {
  // Every deferred read is joined before the database closes, a held one let go first.
  provider.releaseReads();
  await tasks.settled();
  vi.restoreAllMocks();
  db.close();
  for (const line of output)
    for (const word of NEVER_LOGGED) expect(line.toLowerCase(), line).not.toContain(word);
});

const WEBHOOK: StripeIdentityWebhookDeps = {
  webhookSecret: toSecret(SECRET),
  webhookSecretPrevious: toSecret(PREVIOUS),
  environment: "sandbox",
};

/** The API with the webhook wired, unless a block is null. */
function makeApp(
  opts: { check?: IdentitySessionDeps | null; webhook?: StripeIdentityWebhookDeps | null } = {},
) {
  const check = opts.check === undefined ? identityCheck : opts.check;
  const webhook = opts.webhook === undefined ? WEBHOOK : opts.webhook;
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    repo: new SqliteEntityRepository(db),
    identityCheck: check ?? undefined,
    stripeIdentity: webhook ?? undefined,
  };
  return buildApiApp(deps as ApiDeps);
}

type App = ReturnType<typeof makeApp>;

const seconds = (ms: number): number => Math.floor(ms / 1000);

/** A `Stripe-Signature` header: `t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
function sign(body: string, opts: { secret?: string; t?: number } = {}): string {
  const t = opts.t ?? seconds(now);
  const v1 = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

/** A Stripe event about one identity session, with what a real one carries beside the five fields
 *  the receiver reads: the object's status, its last error's sentence, and (forged) names. */
function event(
  over: {
    id?: string;
    type?: string;
    livemode?: unknown;
    ref?: string | null;
    reference?: string | null;
  } = {},
): string {
  return JSON.stringify({
    id: over.id ?? "evt_test_1",
    object: "event",
    api_version: "2025-01-27",
    created: seconds(now),
    type: over.type ?? "identity.verification_session.verified",
    livemode: "livemode" in over ? over.livemode : false,
    pending_webhooks: 1,
    data: {
      object: {
        id: over.ref === undefined ? "vs_unknown" : over.ref,
        object: "identity.verification_session",
        client_reference_id: over.reference === undefined ? null : over.reference,
        status: "verified",
        last_error: { code: null, reason: "A sentence the receiver never reads." },
        verified_outputs: { ...CLAIMED, dob: { year: 1990, month: 1, day: 1 } },
      },
    },
  });
}

/** One POST to the webhook; no session token, ever: the route is public. */
async function post(
  app: App,
  body: string,
  opts: { signature?: string; env?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return await app.request(`/webhooks/stripe-identity/${opts.env ?? "sandbox"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.signature === undefined ? {} : { [STRIPE_SIGNATURE_HEADER]: opts.signature }),
      ...opts.headers,
    },
    body,
  });
}

/** POST a correctly signed body. */
const deliver = (app: App, body: string, opts: { secret?: string; t?: number } = {}) =>
  post(app, body, { signature: sign(body, opts) });

/** The guardian's session, open at the provider: our id and the provider's. */
async function openSession(): Promise<{ sessionId: string; ref: string }> {
  const { sessionId } = await startSession(identityCheck, GUARDIAN, TYPED);
  const row = sessions.byId(sessionId);
  if (row === undefined) throw new Error("no session row");
  return { sessionId, ref: row.providerRef };
}

/** The ops lines of one event name, parsed. */
function opsLines(name: string): Record<string, unknown>[] {
  return output
    .filter((line) => line.startsWith('{"opslog"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((l) => l.opslog === name);
}

/** Every webhook ops line, by name. */
const webhookLines = () =>
  output
    .filter((line) => line.startsWith('{"opslog":"identity_webhook_'))
    .map((line) => (JSON.parse(line) as { opslog: string }).opslog);

// ── the tests ───────────────────────────────────────────────────────────────────────────────

describe("the Stripe Identity webhook: what is mounted, where", () => {
  test("a request on the wrong environment path answers 404 before any signature work, and wakes nothing", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    const body = event({ ref, reference: sessionId });
    for (const env of ["production", "staging", "SANDBOX"]) {
      const res = await post(app, body, { signature: sign(body), env });
      expect(res.status, env).toBe(404);
    }
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
  });

  test("without the Stripe block, or without the identity check, the route is not mounted: 404", async () => {
    const body = event();
    for (const app of [makeApp({ webhook: null }), makeApp({ check: null })])
      expect((await post(app, body, { signature: sign(body) })).status).toBe(404);
  });

  test("the webhook's environment must be the identity check's: a mismatch refuses to build the app", () => {
    expect(() => makeApp({ webhook: { ...WEBHOOK, environment: "production" } })).toThrow(
      /environment/,
    );
  });

  test("the route is public: a signed event with no session token is answered by the signature check, not by the session protection", async () => {
    const app = makeApp();
    const body = event({ type: "customer.created" });
    expect((await deliver(app, body)).status).toBe(200);
    const refused = await post(app, body, { signature: "t=1,v1=00" });
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("invalid signature");
  });
});

describe("the Stripe Identity webhook: the signature", () => {
  test("a missing, malformed or wrong signature answers one constant 401, never a 500, and wakes nothing", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    const body = event({ ref, reference: sessionId });
    const t = seconds(now);
    const good = sign(body).split(",v1=")[1] as string;
    const cases: Record<string, string | undefined> = {
      missing: undefined,
      empty: "",
      "no t": `v1=${good}`,
      "no v1": `t=${t}`,
      "two t": `t=${t},t=${t},v1=${good}`,
      "t not a number": `t=soon,v1=${good}`,
      // The case that would make timingSafeEqual throw without the length check.
      "odd-length v1": `t=${t},v1=${good.slice(0, 63)}`,
      "short v1": `t=${t},v1=${good.slice(0, 32)}`,
      "non-hex v1": `t=${t},v1=${"zz".repeat(32)}`,
      "v0 only": `t=${t},v0=${good}`,
      "wrong secret": sign(body, { secret: "whsec_attacker" }),
      "signed for another t": `t=${t + 1},v1=${good}`,
      "signed over another body": sign(`${body} `),
    };
    const texts = new Set<string>();
    for (const [name, signature] of Object.entries(cases)) {
      const res = await post(app, body, { signature });
      expect(res.status, name).toBe(401);
      texts.add(await res.text());
    }
    // One body across every failure: the endpoint is not an oracle for which check failed.
    expect(texts.size).toBe(1);
    expect([...texts][0]).toBe(
      JSON.stringify({ error: { code: "unauthorized", message: "invalid signature" } }),
    );
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
    expect(opsLines("identity_webhook_unauthorized")).toHaveLength(Object.keys(cases).length);
  });

  test("the previous secret also verifies, so a rotation drops nothing", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    const body = event({ ref, reference: sessionId });
    const res = await deliver(app, body, { secret: PREVIOUS });
    expect(res.status).toBe(200);
    await tasks.settled();
    expect(provider.reads).toBe(1);
  });

  test("a stale but authentic event answers 200, wakes nothing and leaves one ops line with its id", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    const body = event({ ref, reference: sessionId });
    const tolerance = STRIPE_WEBHOOK_TOLERANCE_SECONDS;
    for (const t of [seconds(now) - tolerance - 1, seconds(now) + tolerance + 1]) {
      const res = await deliver(app, body, { t });
      expect(res.status, String(t)).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
    const stale = opsLines("identity_webhook_stale");
    expect(stale).toHaveLength(2);
    expect(stale[0]).toMatchObject({
      environment: "sandbox",
      eventId: "evt_test_1",
      type: "identity.verification_session.verified",
    });
    // Within the tolerance on either side is fresh.
    expect((await deliver(app, body, { t: seconds(now) - tolerance })).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(1);
  });

  test("the signature is checked against the deps' clock, in seconds", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    const body = event({ ref, reference: sessionId });
    // Signed now; the box's clock then moves ten minutes on: the same signature is stale.
    const signature = sign(body);
    now += 10 * MINUTE;
    expect((await post(app, body, { signature })).status).toBe(200);
    expect(track).not.toHaveBeenCalled();
    expect(opsLines("identity_webhook_stale")).toHaveLength(1);
  });
});

describe("the Stripe Identity webhook: the body", () => {
  test("a body over 256 KiB answers 413, even correctly signed (a size refusal is not a signature verdict)", async () => {
    const app = makeApp();
    const big = JSON.stringify({
      id: "evt_test_1",
      pad: "x".repeat(STRIPE_WEBHOOK_MAX_BODY_BYTES),
    });
    const res = await deliver(app, big);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
    expect(opsLines("identity_webhook_oversize")).toHaveLength(1);
  });

  test("a declared Content-Length over the cap is refused before a byte is read", async () => {
    const app = makeApp();
    const body = event();
    const res = await post(app, body, {
      signature: sign(body),
      headers: { "content-length": String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1) },
    });
    expect(res.status).toBe(413);
  });

  test("a correctly signed body that is not an event answers 200 and wakes nothing", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const bodies = [
      "<html>gateway error</html>",
      "[]",
      JSON.stringify({ type: "identity.verification_session.verified", livemode: false }),
      JSON.stringify({ id: "evt_test_1", livemode: false }),
      event({ livemode: "false" }),
    ];
    for (const body of bodies) expect((await deliver(app, body)).status, body).toBe(200);
    expect(track).not.toHaveBeenCalled();
    expect(opsLines("identity_webhook_unparsable")).toHaveLength(bodies.length);
  });

  test("an event of another type answers 200 and does nothing, not even an ops line", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    for (const type of [
      "customer.created",
      "identity.verification_report.created",
      "identity.verification_sessions.verified",
    ]) {
      const res = await deliver(app, event({ type, ref, reference: sessionId }));
      expect(res.status, type).toBe(200);
    }
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
    expect(webhookLines()).toEqual([]);
  });
});

describe("the Stripe Identity webhook: which session it wakes", () => {
  test("an event in the other mode answers 200, wakes nothing, and is dropped with the reason mode", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    const res = await deliver(app, event({ livemode: true, ref, reference: sessionId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
    expect(opsLines("identity_webhook_dropped")).toEqual([
      expect.objectContaining({
        environment: "sandbox",
        eventId: "evt_test_1",
        type: "identity.verification_session.verified",
        reason: "mode",
      }),
    ]);
  });

  test("on a production deployment the rule turns over: a test-mode event is the one dropped", async () => {
    const production = { ...identityCheck, environment: "production" as const };
    const app = makeApp({ check: production, webhook: { ...WEBHOOK, environment: "production" } });
    const track = vi.spyOn(tasks, "track");
    const testMode = event({ livemode: false });
    expect(
      (await post(app, testMode, { signature: sign(testMode), env: "production" })).status,
    ).toBe(200);
    const liveMode = event({ livemode: true });
    expect(
      (await post(app, liveMode, { signature: sign(liveMode), env: "production" })).status,
    ).toBe(200);
    expect(track).not.toHaveBeenCalled();
    // The live event passed the mode check and found no session.
    expect(opsLines("identity_webhook_dropped").map((l) => l.reason)).toEqual([
      "mode",
      "unknown_session",
    ]);
    // And the sandbox path is the wrong one there.
    expect((await post(app, liveMode, { signature: sign(liveMode) })).status).toBe(404);
  });

  test("an event for a session we do not hold answers 200, wakes nothing, and is dropped as unknown_session", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId } = await openSession();
    for (const body of [
      event({ ref: "vs_elsewhere", reference: sessionId }),
      event({ ref: null, reference: sessionId }),
    ])
      expect((await deliver(app, body)).status).toBe(200);
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
    const dropped = opsLines("identity_webhook_dropped");
    expect(dropped.map((l) => l.reason)).toEqual(["unknown_session", "unknown_session"]);
    // Our session id is not named on a drop: the event did not prove it was about it.
    for (const line of dropped) expect(line).not.toHaveProperty("sessionId");
  });

  test("an event whose reference is not the session's own answers 200, wakes nothing, and is dropped as unknown_session", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { ref } = await openSession();
    for (const reference of [null, "0".repeat(32), ""])
      expect((await deliver(app, event({ ref, reference }))).status).toBe(200);
    expect(track).not.toHaveBeenCalled();
    expect(provider.reads).toBe(0);
    expect(opsLines("identity_webhook_dropped").map((l) => l.reason)).toEqual([
      "unknown_session",
      "unknown_session",
      "unknown_session",
    ]);
  });
});

describe("the Stripe Identity webhook: the wake-up", () => {
  test("a verified event for an open session runs one read that completes it; a redelivery runs a second that changes nothing", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    provider.verify(ref);
    now += 2 * MINUTE;
    const body = event({ ref, reference: sessionId });

    const res = await deliver(app, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(track).toHaveBeenCalledTimes(1);
    await tasks.settled();
    const completed = sessions.byId(sessionId);
    expect(completed?.closedAt).toBe(now);
    expect(completed?.completedCheckId).not.toBeNull();
    expect(identityState(identityCheck.identity.repo, GUARDIAN, now, "sandbox")).toBe("verified");
    const rows = identityCheck.identity.repo.list(GUARDIAN).length;
    const reads = provider.reads;
    expect(opsLines("identity_webhook_received")).toEqual([
      expect.objectContaining({
        environment: "sandbox",
        eventId: "evt_test_1",
        type: "identity.verification_session.verified",
        sessionId,
      }),
    ]);

    // Stripe delivers the same event again: one more task, and the closed session takes nothing.
    now += MINUTE;
    expect((await deliver(app, body)).status).toBe(200);
    expect(track).toHaveBeenCalledTimes(2);
    await tasks.settled();
    expect(sessions.byId(sessionId)).toEqual(completed);
    expect(identityCheck.identity.repo.list(GUARDIAN)).toHaveLength(rows);
    expect(provider.reads).toBe(reads);
    expect(opsLines("identity_webhook_received")).toHaveLength(2);
  });

  test("the ack goes out before the read: the answer is 200 while the read is still waiting", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    provider.verify(ref);
    provider.holdReads();
    const res = await deliver(app, event({ ref, reference: sessionId }));
    expect(res.status).toBe(200);
    expect(tasks.size).toBe(1);
    expect(provider.reads).toBe(0);
    expect(sessions.byId(sessionId)?.closedAt).toBeNull();
    provider.releaseReads();
    await tasks.settled();
    expect(sessions.byId(sessionId)?.closedAt).not.toBeNull();
  });

  test("two events for one session delivered back to back run one read at a time, and the screener is called once for one verified result", async () => {
    const screener = new FakeScreener();
    identityCheck.screener = screener;
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    provider.verify(ref);
    provider.holdReads();
    // Stripe's pair for one result, moments apart: the second arrives while the first is read.
    for (const [n, type] of ["processing", "verified"].entries()) {
      const body = event({
        id: `evt_test_${n}`,
        type: `identity.verification_session.${type}`,
        ref,
        reference: sessionId,
      });
      expect((await deliver(app, body)).status, type).toBe(200);
    }
    expect(provider.inflight).toBe(1);
    expect(tasks.size).toBe(1);
    provider.releaseReads();
    await tasks.settled();
    expect(provider.maxInflight).toBe(1);
    // The read that followed found the session completed, and read nothing.
    expect(provider.reads).toBe(1);
    expect(screener.screens).toBe(1);
    expect(sessions.byId(sessionId)?.closedAt).not.toBeNull();
    expect(identityState(identityCheck.identity.repo, GUARDIAN, now, "sandbox")).toBe("verified");
    expect(
      identityCheck.identity.repo.list(GUARDIAN).filter((r) => r.status === "passed"),
    ).toHaveLength(1);
    expect(opsLines("identity_webhook_received").map((l) => l.eventId)).toEqual([
      "evt_test_0",
      "evt_test_1",
    ]);
  });

  test("an event that arrives during a read is not lost: one more read follows it, and sees the change it told of", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    provider.update(ref, { status: "processing" });
    provider.holdReads();
    const processing = event({
      id: "evt_test_0",
      type: "identity.verification_session.processing",
      ref,
      reference: sessionId,
    });
    expect((await deliver(app, processing)).status).toBe(200);
    // The first read began on a session still being processed; the result lands during it.
    provider.verify(ref);
    const verified = event({ id: "evt_test_1", ref, reference: sessionId });
    expect((await deliver(app, verified)).status).toBe(200);
    expect(provider.inflight).toBe(1);
    provider.releaseReads();
    await tasks.settled();
    expect(provider.maxInflight).toBe(1);
    expect(provider.reads).toBe(2);
    expect(sessions.byId(sessionId)?.closedAt).not.toBeNull();
    expect(identityState(identityCheck.identity.repo, GUARDIAN, now, "sandbox")).toBe("verified");
  });

  test("the event's own claims are never read: a verified event for a session still waiting at the provider completes nothing", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    // The event says verified and carries names; the provider says the person has not finished.
    const res = await deliver(app, event({ ref, reference: sessionId }));
    expect(res.status).toBe(200);
    await tasks.settled();
    const session = sessions.byId(sessionId);
    expect(session?.closedAt).toBeNull();
    expect(session?.lastStatus).toBe("requires_input");
    expect(session?.completedCheckId).toBeNull();
    expect(identityState(identityCheck.identity.repo, GUARDIAN, now, "sandbox")).toBe("pending");
  });

  test("every identity session event type wakes the same read", async () => {
    const app = makeApp();
    const track = vi.spyOn(tasks, "track");
    const { sessionId, ref } = await openSession();
    const types = ["created", "processing", "requires_input", "verified", "canceled", "redacted"];
    for (const [n, type] of types.entries()) {
      const body = event({
        id: `evt_test_${n}`,
        type: `identity.verification_session.${type}`,
        ref,
        reference: sessionId,
      });
      expect((await deliver(app, body)).status, type).toBe(200);
      await tasks.settled();
    }
    expect(track).toHaveBeenCalledTimes(types.length);
    expect(provider.reads).toBe(types.length);
  });

  test("a read that fails still leaves the 200, and one ops line with the refusal's code, never its words", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    provider.failNextRead = new StripeUnavailable(503, "Stripe Identity retrieve: HTTP 503");
    const res = await deliver(app, event({ ref, reference: sessionId }));
    expect(res.status).toBe(200);
    await expect(tasks.settled()).resolves.toBe(true);
    expect(sessions.byId(sessionId)?.closedAt).toBeNull();
    expect(opsLines("identity_webhook_sync_failed")).toEqual([
      expect.objectContaining({
        level: "warn",
        eventId: "evt_test_1",
        sessionId,
        failure: "identity_provider_unavailable",
      }),
    ]);
    // The tracker's own failure line, which carries an error's message, is never reached.
    expect(opsLines("identity_session_failed")).toEqual([]);
  });

  test("an error that is not the provider's is logged by its name, never its message", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    provider.failNextRead = Object.assign(new Error("upstream refused it for a named person"), {
      status: 418,
    });
    expect((await deliver(app, event({ ref, reference: sessionId }))).status).toBe(200);
    await tasks.settled();
    const failed = opsLines("identity_webhook_sync_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.failure).toBe("Error");
    expect(JSON.stringify(failed[0])).not.toContain("named person");
  });

  test("no console line holds the payload, the provider's session id or the signature", async () => {
    const app = makeApp();
    const { sessionId, ref } = await openSession();
    provider.verify(ref);
    const body = event({ ref, reference: sessionId });
    const signature = sign(body);
    expect((await post(app, body, { signature })).status).toBe(200);
    await tasks.settled();
    const digest = signature.split(",v1=")[1] as string;
    for (const line of output) {
      expect(line).not.toContain(ref);
      expect(line).not.toContain(digest);
      expect(line).not.toContain("A sentence the receiver never reads.");
    }
  });
});

describe("parseStripeEvent", () => {
  test("keeps the five fields the receiver may read, and nothing else", () => {
    const parsed = parseStripeEvent(event({ ref: "vs_test9", reference: "ab".repeat(16) }));
    expect(parsed).toEqual({
      eventId: "evt_test_1",
      type: "identity.verification_session.verified",
      livemode: false,
      providerRef: "vs_test9",
      clientReferenceId: "ab".repeat(16),
    });
  });

  test("an event without a session object keeps its id, type and mode, and null refs", () => {
    expect(
      parseStripeEvent(
        JSON.stringify({ id: "evt_x", type: "customer.created", livemode: true, data: {} }),
      ),
    ).toEqual({
      eventId: "evt_x",
      type: "customer.created",
      livemode: true,
      providerRef: null,
      clientReferenceId: null,
    });
  });

  test("refuses what is not an event: no id, no type, a mode that is not a boolean, not JSON", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ type: "t", livemode: false }),
      JSON.stringify({ id: "", type: "t", livemode: false }),
      JSON.stringify({ id: "evt_x", livemode: false }),
      JSON.stringify({ id: "evt_x", type: 7, livemode: false }),
      JSON.stringify({ id: "evt_x", type: "t" }),
      JSON.stringify({ id: "evt_x", type: "t", livemode: "true" }),
    ])
      expect(parseStripeEvent(raw), raw).toBeNull();
  });
});
