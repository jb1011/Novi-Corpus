/**
 * The identity session service (`src/identity/sessions.ts`): a guardian starts an identity check,
 * is sent to the provider, and the server writes the identity record itself from the provider's
 * result, after screening the person against the sanctions lists; later it asks the provider to
 * delete the session.
 *
 * The database is real (in memory). The provider and the screener are fakes held in memory, each
 * test setting what they answer next. Every name and birth date is a made-up fixture, every
 * tenant an invented address, the keys constant test keys; and no line written to the console by
 * any test may hold the fixture's names or its birth date (checked after each test).
 */
import type Database from "better-sqlite3";
import { type Address, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type IdentityProviderClient,
  StripeError,
  StripeIdentityClient,
  StripeKeyRejected,
  StripeNotFound,
  StripeUnavailable,
} from "../../src/adapters/stripe/identityClient";
import type { ProviderSession } from "../../src/adapters/stripe/mapSession";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import { ApiError } from "../../src/errors";
import { decryptText, encryptText, nameHmac, toSecret } from "../../src/formation/pii";
import { IDENTITY_AAD } from "../../src/identity/names";
import {
  IDENTITY_SESSION_AAD,
  type IdentitySessionDeps,
  sessionView,
  startSession,
  sweepSessions,
  syncSession,
} from "../../src/identity/sessions";
import { currentRecord, identityState } from "../../src/identity/state";
import type { ReviewReasonCode } from "../../src/identity/types";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type EncryptedName,
  type GuardianIdentityCheck,
  type NewGuardianIdentityCheck,
  type NewIdentityEvent,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import {
  type IdentitySession,
  SqliteIdentitySessionRepository,
} from "../../src/persistence/identitySessionRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { PersonScreener } from "../../src/screening/personScreener";
import { TaskTracker } from "../../src/util/taskTracker";
import {
  TEST_PII_RING,
  passedIdentityRow,
  recordHuman,
  worldFor,
} from "../helpers/customerCompanyFixtures";

const DAY = 86_400_000;
const MINUTE = 60_000;
/** 20 November 2026, 12:00 UTC: when the first session starts. */
const T0 = Date.UTC(2026, 10, 20, 12);
const FINGERPRINT_KEY = Buffer.alloc(32, 5);
const ORIGIN = "https://testnet.example.com";
const FLOW = "vf_test_flow";

/** The guardian's typed name, made up, and the document's as the provider extracts it. */
const TYPED = { firstName: "Ottilie", lastName: "Brandwick" } as const;
const ON_DOCUMENT = { firstName: "OTTILIE", lastName: "BRANDWICK" } as const;
/** A made-up birth date, as the provider gives it and as the screen takes it. */
const DOB = { year: 1987, month: 3, day: 14 } as const;
const DOB_TEXT = "1987-03-14";
/** The one sample person Stripe's test mode returns for everyone, made up here, and the name a
 *  tester types to match it. */
const SAMPLE_PERSON = { firstName: "SAMPLA", lastName: "TESTWORTH" } as const;
const SAMPLE_TYPED = { firstName: "Sampla", lastName: "Testworth" } as const;
/** What no console line may hold. */
const NEVER_LOGGED = ["ottilie", "brandwick", "sampla", "testworth", DOB_TEXT, "19870314"];

/** A tenant id as the session spells it: EIP-55 checksummed, with letters for the checksum. */
const tenant = (n: number): Address =>
  getAddress(`0x${"ab".repeat(18)}${n.toString(16).padStart(4, "0")}`);
const GUARDIAN = tenant(1);
const nullifierOf = (t: string) => `0xnullifier-${t.slice(2, 12)}`;

// ── the fakes ───────────────────────────────────────────────────────────────────────────────

/** The provider, in memory: sessions by their `vs_` id, and what each test makes the person do. */
class FakeProvider implements IdentityProviderClient {
  readonly sessions = new Map<string, ProviderSession>();
  readonly created: Parameters<IdentityProviderClient["createSession"]>[0][] = [];
  readonly reads: { ref: string; withDob: boolean }[] = [];
  readonly canceled: string[] = [];
  readonly redacted: string[] = [];
  /** The mode the provider's sessions report: a sandbox deployment's by default. */
  livemode = false;
  /** Errors the next calls throw, in order; then the calls answer. */
  readonly failNext = {
    create: [] as Error[],
    retrieve: [] as Error[],
    cancel: [] as Error[],
    redact: [] as Error[],
  };
  #count = 0;
  #urls = 0;

  async createSession(input: Parameters<IdentityProviderClient["createSession"]>[0]) {
    this.created.push(input);
    const err = this.failNext.create.shift();
    if (err) throw err;
    this.#count += 1;
    const id = `vs_test${this.#count}`;
    this.sessions.set(id, {
      id,
      livemode: this.livemode,
      status: "requires_input",
      clientReferenceId: input.clientReferenceId,
      url: null,
      lastErrorCode: null,
      redaction: null,
      outputs: null,
      report: null,
    });
    return { providerRef: id, url: this.#freshUrl(), livemode: this.livemode };
  }

  async retrieveSession(ref: string, opts: { withDob: boolean }): Promise<ProviderSession> {
    this.reads.push({ ref, withDob: opts.withDob });
    const err = this.failNext.retrieve.shift();
    if (err) throw err;
    const s = this.sessions.get(ref);
    if (s === undefined) throw new StripeNotFound(404, "Stripe Identity retrieve: HTTP 404");
    const waiting = s.status === "requires_input" && s.redaction === null;
    return {
      ...s,
      url: waiting ? this.#freshUrl() : null,
      outputs:
        s.outputs === null ? null : { ...s.outputs, dob: opts.withDob ? s.outputs.dob : null },
      report: s.report === null ? null : { ...s.report },
    };
  }

  async cancelSession(ref: string): Promise<void> {
    this.canceled.push(ref);
    const err = this.failNext.cancel.shift();
    if (err) throw err;
    const s = this.sessions.get(ref);
    if (s === undefined) throw new StripeNotFound(404, "Stripe Identity cancel: HTTP 404");
    // Stripe cancels a session only while it waits for the person.
    if (s.status !== "requires_input")
      throw new StripeError(400, "Stripe Identity cancel: HTTP 400");
    this.sessions.set(ref, { ...s, status: "canceled" });
  }

  async redactSession(ref: string): Promise<void> {
    this.redacted.push(ref);
    const err = this.failNext.redact.shift();
    if (err) throw err;
    const s = this.sessions.get(ref);
    if (s === undefined) throw new StripeNotFound(404, "Stripe Identity redact: HTTP 404");
    // Stripe redacts a session waiting for the person (canceling it too) or a verified one.
    if (s.status !== "requires_input" && s.status !== "verified")
      throw new StripeError(400, "Stripe Identity redact: HTTP 400");
    this.sessions.set(ref, {
      ...s,
      status: s.status === "requires_input" ? "canceled" : s.status,
      redaction: "processing",
    });
  }

  #freshUrl(): string {
    this.#urls += 1;
    return `https://verify.stripe.com/start/test_url_${this.#urls}`;
  }

  /** The session as the person (or the provider) leaves it. */
  update(ref: string, patch: Partial<ProviderSession>): void {
    const s = this.sessions.get(ref);
    if (s === undefined) throw new Error(`no fake session ${ref}`);
    this.sessions.set(ref, { ...s, ...patch });
  }

  /** The person passed the document and the selfie. */
  verify(
    ref: string,
    over: {
      names?: { firstName: string; lastName: string };
      dob?: { year: number; month: number; day: number } | null;
      country?: string | null;
      selfie?: "verified" | "unverified" | null;
      reportId?: string;
      createdMs?: number;
    } = {},
  ): void {
    this.update(ref, {
      status: "verified",
      lastErrorCode: null,
      outputs: { ...(over.names ?? ON_DOCUMENT), dob: over.dob === undefined ? DOB : over.dob },
      report: {
        id: over.reportId ?? `vr_${ref.slice(3)}done`,
        created: Math.floor((over.createdMs ?? T0 + MINUTE) / 1000),
        documentType: "passport",
        issuingCountry: over.country === undefined ? "FR" : over.country,
        selfieStatus: over.selfie === undefined ? "verified" : over.selfie,
      },
    });
  }

  /** One failed attempt, its own report. */
  fail(ref: string, code: string, reportId: string): void {
    this.update(ref, {
      status: "requires_input",
      lastErrorCode: code,
      report: {
        id: reportId,
        created: Math.floor(T0 / 1000),
        documentType: "passport",
        issuingCountry: "FR",
        selfieStatus: "unverified",
      },
    });
  }
}

class FakeScreener implements PersonScreener {
  readonly queries: { name: string; birthDate: string | null }[] = [];
  answer: "clear" | "hit" | "error" = "clear";
  async screenPerson(q: { name: string; birthDate: string | null }) {
    this.queries.push(q);
    return this.answer;
  }
}

// ── the harness ─────────────────────────────────────────────────────────────────────────────

let db: Database.Database;
let repo: SqliteIdentityRepository;
let sessions: SqliteIdentitySessionRepository;
let store: SqliteWorldStore;
let world: WorldIdDeps;
let provider: FakeProvider;
let screener: FakeScreener;
let now: number;
let output: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteIdentityRepository(db);
  sessions = new SqliteIdentitySessionRepository(db);
  store = new SqliteWorldStore(db);
  world = worldFor(store);
  for (const n of [1, 2, 3, 4]) recordHuman(store, tenant(n), nullifierOf(tenant(n)), T0 - DAY);
  provider = new FakeProvider();
  screener = new FakeScreener();
  now = T0;
  output = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  // No console line of any test holds the fixture's names or its birth date.
  for (const line of output)
    for (const word of NEVER_LOGGED) expect(line.toLowerCase(), line).not.toContain(word);
});

function deps(over: Partial<IdentitySessionDeps> = {}): IdentitySessionDeps {
  return {
    identity: {
      repo,
      pii: TEST_PII_RING,
      reverifyYears: 3,
      blockedCountries: new Set(["PRK"]),
      now: () => now,
      nameHmacKey: FINGERPRINT_KEY,
    },
    world,
    sessions,
    provider,
    screener,
    environment: "sandbox",
    flowId: FLOW,
    webOrigin: ORIGIN,
    limits: { sessionDays: 14, maxPerDay: 3, attemptsPerSession: 3, redactAfterDays: 7 },
    tasks: new TaskTracker("identity_session"),
    now: () => now,
    ...over,
  };
}

/** A production deployment: the provider in live mode. */
function production(over: Partial<IdentitySessionDeps> = {}): IdentitySessionDeps {
  provider.livemode = true;
  return deps({ environment: "production", ...over });
}

/** The ops lines written, parsed. */
function opsLines(event?: string): Record<string, unknown>[] {
  return output
    .filter((line) => line.startsWith('{"opslog"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((l) => event === undefined || l.opslog === event);
}

/** The refusal a promise rejects with, which must be an ApiError. */
async function refusal(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected a refusal");
}

/** A session started for `tenantId`, with its provider ref. */
async function started(
  d: IdentitySessionDeps = deps(),
  tenantId: string = GUARDIAN,
  input: { firstName: string; lastName: string; returnPath?: string } = TYPED,
): Promise<{ sessionId: string; ref: string; url: string; session: () => IdentitySession }> {
  const answer = await startSession(d, tenantId, input);
  const row = sessions.byId(answer.sessionId);
  if (row === undefined) throw new Error("no session row");
  return {
    sessionId: answer.sessionId,
    ref: row.providerRef,
    url: answer.url,
    session: () => sessions.byId(answer.sessionId) as IdentitySession,
  };
}

/** A row appended with an event, as an operator's command would write it. */
function appended(
  row: NewGuardianIdentityCheck,
  kind: NewIdentityEvent["kind"] = "recorded",
): GuardianIdentityCheck {
  return repo.append(row, {
    kind,
    at: row.completedAt ?? row.startedAt,
    actor: "ops.example",
    actorOsUser: "ops",
    reasonCode: null,
    reason: null,
  });
}

/** A pass of the tenant recorded by an operator, completed `at`, due `expiresAt`. */
function passFor(tenantId: string, at: number, expiresAt: number): GuardianIdentityCheck {
  return appended({
    ...passedIdentityRow(tenantId, { at, expiresAt }),
    environment: "sandbox",
    synthetic: true,
  });
}

const typedOf = (s: IdentitySession) => {
  const names = s.typedNames;
  if (names === null) throw new Error("no typed names");
  const open = (field: "first" | "last", name: EncryptedName) =>
    decryptText(
      TEST_PII_RING,
      { ...name, keyId: names.keyId },
      IDENTITY_SESSION_AAD(s.sessionId, field),
    );
  return { first: open("first", names.first), last: open("last", names.last) };
};

const namesOf = (row: GuardianIdentityCheck) => {
  const names = row.names;
  if (names === null) throw new Error("no names");
  const open = (field: "first" | "last", name: EncryptedName) =>
    decryptText(TEST_PII_RING, { ...name, keyId: names.keyId }, IDENTITY_AAD(row.tenantId, field));
  return { first: open("first", names.first), last: open("last", names.last), full: names.full };
};

const latestRow = (tenantId: string = GUARDIAN) => repo.latest(tenantId) as GuardianIdentityCheck;

/**
 * A session parked for an operator, on the environment of `d`: its verified result is refused by
 * the record's rules (`plan_refused`), being a renewal whose result completed before the pass it
 * would renew. The session stays open, its last read `verified`.
 */
async function parkedSession(d: IdentitySessionDeps, tenantId: string = GUARDIAN) {
  appended({
    ...passedIdentityRow(tenantId, { at: T0 - DAY, expiresAt: T0 + 30 * DAY }),
    environment: d.environment,
    synthetic: d.environment === "sandbox",
  });
  const s = await started(d, tenantId);
  provider.verify(s.ref, { createdMs: T0 - 2 * DAY });
  expect(await syncSession(d, s.sessionId)).toBe("unchanged");
  expect(s.session()).toMatchObject({ closedAt: null, lastStatus: "verified" });
  return s;
}

/** The level of a parked session's lines: CRITICAL on production, a warning on a sandbox. */
const parkedLevel = (environment: "sandbox" | "production") =>
  environment === "production" ? { level: "error", severity: "CRITICAL" } : { level: "warn" };

/** An operator's refusal of the tenant's open attempt, written now. */
function operatorRefuses(tenantId: string = GUARDIAN): void {
  const begun = [...repo.list(tenantId)]
    .reverse()
    .find((r) => r.status === "started") as GuardianIdentityCheck;
  appended(
    {
      ...begun,
      status: "failed",
      supersedesCheckId: begun.checkId,
      completedAt: now,
      operator: "ops.example",
      operatorOsUser: "ops",
    },
    "refused",
  );
}

// ── start ───────────────────────────────────────────────────────────────────────────────────

describe("startSession", () => {
  test("rule 1: without a World ID row the start is refused 403 guardian_not_verified; on production a waiver row is refused too, on a sandbox any row is taken", async () => {
    const stranger = tenant(9);
    const noRow = await refusal(startSession(deps(), stranger, TYPED));
    expect([noRow.code, noRow.status, noRow.message]).toEqual([
      "guardian_not_verified",
      403,
      "the guardian must complete World ID verification first",
    ]);

    const waived = tenant(8);
    recordHuman(store, waived, nullifierOf(waived), T0 - DAY, "waiver");
    const onProduction = await refusal(startSession(production(), waived, TYPED));
    expect([onProduction.code, onProduction.status]).toEqual(["guardian_not_verified", 403]);
    expect(provider.created).toHaveLength(0);
    expect(repo.list(waived)).toEqual([]);

    provider.livemode = false;
    const onSandbox = await startSession(deps(), waived, TYPED);
    expect(onSandbox.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("rule 2: verified with more than 90 days left is refused 409 identity_already_verified, a review 409 identity_under_review; within 90 days of the expiry a start goes on", async () => {
    passFor(tenant(1), T0 - 100 * DAY, T0 + 91 * DAY);
    const verified = await refusal(startSession(deps(), tenant(1), TYPED));
    expect([verified.code, verified.status]).toEqual(["identity_already_verified", 409]);

    appended({
      ...passedIdentityRow(tenant(2), { at: T0 - DAY, expiresAt: T0 + 1000 * DAY }),
      status: "needs_review",
      reviewReasons: ["provider_flag"],
    });
    const review = await refusal(startSession(deps(), tenant(2), TYPED));
    expect([review.code, review.status]).toEqual(["identity_under_review", 409]);
    expect(provider.created).toHaveLength(0);

    passFor(tenant(3), T0 - 1000 * DAY, T0 + 89 * DAY);
    await expect(startSession(deps(), tenant(3), TYPED)).resolves.toMatchObject({
      sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });

  test("rule 2: a review as the latest row refuses the start 409 identity_under_review, even while the pass under it still counts", async () => {
    // A pass in its renewal window, and a renewal's review on top of it: the state reads verified.
    passFor(GUARDIAN, T0 - 1000 * DAY, T0 + 30 * DAY);
    appended({
      ...passedIdentityRow(GUARDIAN, { at: T0 - DAY, expiresAt: T0 + 1000 * DAY }),
      environment: "sandbox",
      synthetic: true,
      status: "needs_review",
      reviewReasons: ["provider_flag"],
    });
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("verified");

    const review = await refusal(startSession(deps(), GUARDIAN, TYPED));
    expect([review.code, review.status]).toEqual(["identity_under_review", 409]);
    expect(provider.created).toHaveLength(0);
  });

  test("rule 3: a renewal whose open session's result lands in review answers 409 identity_under_review, and opens no session over the review", async () => {
    appended(passedIdentityRow(GUARDIAN, { at: T0 - 1000 * DAY, expiresAt: T0 + 30 * DAY }));
    const d = production();
    const s = await started(d);
    provider.verify(s.ref, { names: { firstName: "Ottilie-Rose", lastName: "BRANDWICK" } });

    const review = await refusal(startSession(d, GUARDIAN, TYPED));
    expect([review.code, review.status]).toEqual(["identity_under_review", 409]);
    expect(latestRow()).toMatchObject({ status: "needs_review", reviewReasons: ["name_mismatch"] });
    expect(provider.created).toHaveLength(1);
    expect(sessions.openForTenant(GUARDIAN)).toBeUndefined();
  });

  test("rule 2: a record of another person than the account's current World ID row does not block the account's own check", async () => {
    // The pass copied a nullifier the account's World row no longer holds.
    appended({
      ...passedIdentityRow(GUARDIAN, { at: T0 - DAY, expiresAt: T0 + 1000 * DAY }),
      nullifier: "0xnullifier-someone-else",
    });

    await expect(startSession(deps(), GUARDIAN, TYPED)).resolves.toBeDefined();
  });

  test("rule 3: a second start while the session waits for the person reuses it: the typed names replaced, a fresh URL, no second row and no second provider session", async () => {
    const first = await started(deps(), GUARDIAN, { firstName: "Ottilie", lastName: "Brandwik" });

    now = T0 + 5 * MINUTE;
    const again = await startSession(deps(), GUARDIAN, TYPED);

    expect(again.sessionId).toBe(first.sessionId);
    expect(again.url).toMatch(/^https:\/\//);
    expect(again.url).not.toBe(first.url);
    expect(again.expiresAt).toBe(now + 2 * DAY);
    expect(provider.created).toHaveLength(1);
    expect(repo.list(GUARDIAN)).toHaveLength(1);
    expect(typedOf(first.session())).toEqual({ first: "Ottilie", last: "Brandwick" });
    // The read that found it waiting never asked for the birth date.
    expect(provider.reads).toEqual([{ ref: first.ref, withDob: false }]);
  });

  test("rule 3: an open session whose result has come is completed first: a pass answers 409 identity_already_verified, a result still being read 409 identity_under_review", async () => {
    const done = await started(deps(), tenant(1));
    provider.verify(done.ref);
    const verified = await refusal(startSession(deps(), tenant(1), TYPED));
    expect([verified.code, verified.status]).toEqual(["identity_already_verified", 409]);
    expect(done.session().closedAt).not.toBeNull();
    expect(latestRow(tenant(1)).status).toBe("passed");

    const reading = await started(deps(), tenant(2));
    provider.update(reading.ref, { status: "processing" });
    const underReview = await refusal(startSession(deps(), tenant(2), TYPED));
    expect([underReview.code, underReview.status]).toEqual(["identity_under_review", 409]);
    expect(reading.session().closedAt).toBeNull();
    expect(provider.created).toHaveLength(2);
  });

  test("rule 3: an open session canceled at the provider, or past its days, is closed as abandoned and a new one opens", async () => {
    const canceled = await started(deps(), tenant(1));
    provider.update(canceled.ref, { status: "canceled" });
    const next = await startSession(deps(), tenant(1), TYPED);
    expect(next.sessionId).not.toBe(canceled.sessionId);
    expect(canceled.session().closedAt).toBe(T0);

    const old = await started(deps(), tenant(2));
    now = T0 + 14 * DAY;
    const fresh = await startSession(deps(), tenant(2), TYPED);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    // Waiting for the person, it is redacted (which cancels it too), the request marked.
    expect(old.session()).toMatchObject({
      closedAt: now,
      redactDueAt: now + 7 * DAY,
      redactionRequestedAt: now,
    });
    expect(provider.redacted).toEqual([old.ref]);
    expect(provider.canceled).toEqual([]);

    for (const t of [tenant(1), tenant(2)]) {
      const rows = repo.list(t);
      // started, the abandon, started again
      expect(rows.map((r) => r.status)).toEqual(["started", "failed", "started"]);
      expect(repo.events((rows[1] as GuardianIdentityCheck).checkId)[0]).toMatchObject({
        kind: "recorded",
        actor: "system",
        reasonCode: "abandoned",
      });
    }
  });

  test("rule 3: a failed attempt not yet counted is counted at the start, and the one that reaches the limit closes the session before a new one opens", async () => {
    const s = await started(deps({ limits: { ...deps().limits, attemptsPerSession: 1 } }));
    provider.fail(s.ref, "document_unverified_other", "vr_attempt1");

    const next = await startSession(
      deps({ limits: { ...deps().limits, attemptsPerSession: 1 } }),
      GUARDIAN,
      TYPED,
    );

    expect(next.sessionId).not.toBe(s.sessionId);
    expect(s.session()).toMatchObject({ failedAttempts: 1 });
    expect(s.session().closedAt).not.toBeNull();
  });

  test("rule 4: the fourth session started within 24 hours is refused 429 identity_session_limit, closed sessions counted", async () => {
    for (let i = 0; i < 3; i += 1) {
      const s = await started();
      provider.update(s.ref, { status: "canceled" });
      expect(await syncSession(deps(), s.sessionId)).toBe("closed");
      now += MINUTE;
    }

    const limit = await refusal(startSession(deps(), GUARDIAN, TYPED));
    expect([limit.code, limit.status]).toEqual(["identity_session_limit", 429]);
    expect(provider.created).toHaveLength(3);

    now = T0 + DAY + MINUTE;
    await expect(startSession(deps(), GUARDIAN, TYPED)).resolves.toBeDefined();
  });

  test.each<[string, { firstName: string; lastName: string; returnPath?: string }]>([
    ["an empty first name", { ...TYPED, firstName: "" }],
    ["a blank last name", { ...TYPED, lastName: "   " }],
    ["a name of 101 characters", { ...TYPED, firstName: "a".repeat(101) }],
    ["a control character", { ...TYPED, firstName: "Otti\u0000lie" }],
    ["an invisible format character", { ...TYPED, lastName: "Brand​wick" }],
    ["a return path off the site", { ...TYPED, returnPath: "https://elsewhere.example/x" }],
    ["a return path with a query", { ...TYPED, returnPath: "/legal-body?x=1" }],
  ])(
    "rule 5: %s is refused 400 validation_error, before the provider is called",
    async (_what, input) => {
      const bad = await refusal(startSession(deps(), GUARDIAN, input));

      expect([bad.code, bad.status]).toEqual(["validation_error", 400]);
      expect(provider.created).toHaveLength(0);
      // The refusal never echoes what was typed.
      expect(bad.message).not.toContain("Otti");
      expect(bad.message).not.toContain("Brand");
    },
  );

  test("rule 5: each name is trimmed and may hold 100 characters, counted as code points; the return path defaults to /legal-body", async () => {
    // 100 code points, 200 UTF-16 units.
    const long = "𝒜".repeat(100);
    const s = await started(deps(), GUARDIAN, { firstName: `  ${long} `, lastName: " Brandwick " });

    expect(typedOf(s.session())).toEqual({ first: long, last: "Brandwick" });
    expect(s.session().returnPath).toBe("/legal-body");
    expect(provider.created[0]?.returnUrl).toBe(`${ORIGIN}/legal-body?identityCheck=returned`);
  });

  test("rule 6: the provider session is created with the flow, our session id as reference and idempotency key, and the return URL on our site", async () => {
    const s = await started(deps(), GUARDIAN, { ...TYPED, returnPath: "/legal-body/human" });

    expect(provider.created).toEqual([
      {
        flowId: FLOW,
        clientReferenceId: s.sessionId,
        returnUrl: `${ORIGIN}/legal-body/human?identityCheck=returned`,
        idempotencyKey: s.sessionId,
      },
    ]);
    expect(s.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  test("rule 6: a provider session in the wrong mode is refused 503 with a CRITICAL line; an unavailable provider or a refused key 503, the key CRITICAL; nothing written", async () => {
    provider.livemode = true;
    const mode = await refusal(startSession(deps(), GUARDIAN, TYPED));
    expect([mode.code, mode.status]).toEqual(["identity_provider_unavailable", 503]);
    expect(opsLines("identity_provider_mode_mismatch")[0]).toMatchObject({
      severity: "CRITICAL",
    });

    provider.livemode = false;
    provider.failNext.create.push(new StripeUnavailable(503, "Stripe Identity create: HTTP 503"));
    const down = await refusal(startSession(deps(), GUARDIAN, TYPED));
    expect([down.code, down.status]).toEqual(["identity_provider_unavailable", 503]);

    provider.failNext.create.push(new StripeKeyRejected(401, "Stripe Identity create: HTTP 401"));
    const key = await refusal(startSession(deps(), GUARDIAN, TYPED));
    expect([key.code, key.status]).toEqual(["identity_provider_unavailable", 503]);
    expect(opsLines("identity_provider_key_rejected")[0]).toMatchObject({
      severity: "CRITICAL",
    });

    expect(repo.list(GUARDIAN)).toEqual([]);
    expect(sessions.openForTenant(GUARDIAN)).toBeUndefined();
  });

  test("rule 7: one transaction writes the started row by the system and the session with the typed names sealed to it; one ops line with ids only", async () => {
    const s = await started();

    const row = latestRow();
    expect(row).toMatchObject({
      status: "started",
      provider: "stripe",
      providerRef: s.ref,
      subject: s.sessionId,
      nullifier: nullifierOf(GUARDIAN),
      startedAt: T0,
      completedAt: null,
      names: null,
      environment: "sandbox",
      synthetic: true,
      operator: null,
    });
    expect(repo.events(row.checkId)).toMatchObject([
      { kind: "recorded", actor: "system", actorOsUser: null, reasonCode: "session_started" },
    ]);
    const session = s.session();
    expect(session).toMatchObject({
      tenantId: GUARDIAN,
      nullifier: nullifierOf(GUARDIAN),
      provider: "stripe",
      providerRef: s.ref,
      environment: "sandbox",
      livemode: false,
      createdAt: T0,
      startedCheckId: row.checkId,
    });
    expect(typedOf(session)).toEqual({ first: "Ottilie", last: "Brandwick" });
    // Sealed to the session and the field: moved, they do not open.
    const names = session.typedNames as NonNullable<IdentitySession["typedNames"]>;
    expect(() =>
      decryptText(
        TEST_PII_RING,
        { ...names.first, keyId: names.keyId },
        IDENTITY_SESSION_AAD(s.sessionId, "last"),
      ),
    ).toThrow();
    expect(opsLines("identity_session_started")).toMatchObject([
      { tenant: GUARDIAN.slice(0, 10), sessionId: s.sessionId },
    ]);
  });

  test("rule 8: the answer is our session id, the provider's URL and its expiry 48 hours on, never the provider's session id", async () => {
    const answer = await startSession(deps(), GUARDIAN, TYPED);

    expect(answer).toEqual({
      sessionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      url: "https://verify.stripe.com/start/test_url_1",
      expiresAt: T0 + 2 * DAY,
    });
    expect(JSON.stringify(answer)).not.toContain("vs_");
  });

  test("two starts at once open one session: the second reuses it and cancels the provider session it opened", async () => {
    const [a, b] = await Promise.all([
      startSession(deps(), GUARDIAN, TYPED),
      startSession(deps(), GUARDIAN, TYPED),
    ]);

    expect(b.sessionId).toBe(a.sessionId);
    expect(provider.created).toHaveLength(2);
    expect(provider.canceled).toEqual(["vs_test2"]);
    expect(repo.list(GUARDIAN)).toHaveLength(1);
    expect(sessions.countCreatedSince(GUARDIAN, T0 - DAY)).toBe(1);
  });

  /** The provider's create, with `write` run while it answers: an operator's row landing then. */
  function writeDuringCreate(write: () => void): void {
    const create = provider.createSession.bind(provider);
    provider.createSession = async (input) => {
      const answer = await create(input);
      write();
      return answer;
    };
  }

  test.each<[string, "needs_review" | "passed", string]>([
    ["an operator's review", "needs_review", "identity_under_review"],
    ["an operator's pass", "passed", "identity_already_verified"],
  ])(
    "%s written while the provider creates the session is not buried: no started row, the provider session canceled, and the start answers its rule (%s, 409 %s)",
    async (_who, status, code) => {
      writeDuringCreate(() =>
        appended({
          ...passedIdentityRow(GUARDIAN, { at: now, expiresAt: now + 1000 * DAY }),
          environment: "sandbox",
          synthetic: true,
          status,
          reviewReasons: status === "needs_review" ? ["watchlist_hit"] : [],
        }),
      );

      const refused = await refusal(startSession(deps(), GUARDIAN, TYPED));

      expect([refused.code, refused.status]).toEqual([code, 409]);
      expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual([status]);
      expect(provider.created).toHaveLength(1);
      expect(provider.canceled).toEqual(["vs_test1"]);
      expect(sessions.openForTenant(GUARDIAN)).toBeUndefined();
      expect(sessions.countCreatedSince(GUARDIAN, T0 - DAY)).toBe(0);
      expect(opsLines("identity_session_started")).toEqual([]);
    },
  );

  /** `write` run once, during the provider's next call of `op`: an operator's row landing then. */
  function writeDuring(op: "retrieveSession" | "redactSession", write: () => void): void {
    const call = provider[op].bind(provider) as (...args: unknown[]) => Promise<unknown>;
    let written = false;
    (provider as unknown as Record<string, unknown>)[op] = async (...args: unknown[]) => {
      const answer = await call(...args);
      if (!written) {
        written = true;
        write();
      }
      return answer;
    };
  }

  /** An operator's row of the guardian, a review with a sanctions hit or a pass, written now. */
  const operatorRow = (status: "needs_review" | "passed") => () =>
    appended({
      ...passedIdentityRow(GUARDIAN, { at: now, expiresAt: now + 1000 * DAY }),
      environment: "sandbox",
      synthetic: true,
      status,
      reviewReasons: status === "needs_review" ? ["watchlist_hit"] : [],
    });

  test.each<[string, "needs_review" | "passed", string]>([
    ["an operator's review", "needs_review", "identity_under_review"],
    ["an operator's pass", "passed", "identity_already_verified"],
  ])(
    "%s written while the reuse reads an open session that a final code closes is not buried: the session closes without a row, no new session opens, and the start answers its rule (%s, 409 %s)",
    async (_who, status, code) => {
      const s = await started();
      provider.fail(s.ref, "consent_declined", "vr_attempt1");
      now = T0 + MINUTE;
      writeDuring("retrieveSession", operatorRow(status));

      const refused = await refusal(startSession(deps(), GUARDIAN, TYPED));

      expect([refused.code, refused.status]).toEqual([code, 409]);
      expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", status]);
      expect(s.session()).toMatchObject({ closedAt: now, completedCheckId: null });
      expect(opsLines("identity_session_superseded")).toEqual([
        expect.objectContaining({ sessionId: s.sessionId }),
      ]);
      expect(provider.created).toHaveLength(1);
      expect(sessions.openForTenant(GUARDIAN)).toBeUndefined();
    },
  );

  test("an operator's review written while the reuse ends an expired session at the provider is not buried either: 409 identity_under_review, no new session", async () => {
    const s = await started();
    now = T0 + 14 * DAY;
    writeDuring("redactSession", operatorRow("needs_review"));

    const refused = await refusal(startSession(deps(), GUARDIAN, TYPED));

    expect([refused.code, refused.status]).toEqual(["identity_under_review", 409]);
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "needs_review"]);
    expect(s.session()).toMatchObject({ closedAt: now, completedCheckId: null });
    expect(provider.created).toHaveLength(1);
  });

  test("a row written during the provider call twice in a row answers 503: each provider session canceled, nothing opened", async () => {
    // An operator's failed row stands in no start's way, so the start tries once more.
    writeDuringCreate(() =>
      appended({
        ...passedIdentityRow(GUARDIAN, { at: now, expiresAt: now + 1000 * DAY }),
        environment: "sandbox",
        synthetic: true,
        status: "failed",
        expiresAt: null,
        names: null,
        nameHmac: null,
      }),
    );

    const refused = await refusal(startSession(deps(), GUARDIAN, TYPED));

    expect([refused.code, refused.status]).toEqual(["identity_provider_unavailable", 503]);
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(provider.canceled).toEqual(["vs_test1", "vs_test2"]);
    expect(sessions.openForTenant(GUARDIAN)).toBeUndefined();
  });
});

// ── sync ────────────────────────────────────────────────────────────────────────────────────

describe("syncSession", () => {
  test("a session still being read writes nothing to the record and answers processing", async () => {
    const s = await started();
    provider.update(s.ref, { status: "processing" });

    expect(await syncSession(deps(), s.sessionId)).toBe("processing");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started"]);
    expect(s.session()).toMatchObject({ lastStatus: "processing", closedAt: null });
  });

  test("a verified session completes to passed under the typed names, screened with the typed name and the birth date; the session closed, its names erased, its redaction due in 7 days", async () => {
    const s = await started();
    provider.verify(s.ref, { createdMs: T0 + MINUTE });
    now = T0 + 2 * MINUTE;

    expect(await syncSession(deps(), s.sessionId)).toBe("completed");

    const row = latestRow();
    expect(row).toMatchObject({
      status: "passed",
      supersedesCheckId: null,
      provider: "stripe",
      providerRef: s.ref,
      subject: s.sessionId,
      nullifier: nullifierOf(GUARDIAN),
      startedAt: T0,
      completedAt: T0 + MINUTE,
      expiresAt: Date.UTC(2029, 10, 20, 12, 1),
      documentCountry: "FRA",
      documentType: "passport",
      documentExpired: false,
      liveness: "passed",
      watchlist: "clear",
      reviewReasons: [],
      environment: "sandbox",
      synthetic: true,
      operator: null,
    });
    // The typed name is the name of record, not the document's capitals.
    expect(namesOf(row)).toEqual({ first: "Ottilie", last: "Brandwick", full: null });
    expect(repo.events(row.checkId)).toMatchObject([
      {
        kind: "recorded",
        actor: "system",
        provider: "stripe",
        providerEventId: `vr_${s.ref.slice(3)}done`,
      },
    ]);
    expect(screener.queries).toEqual([{ name: "Ottilie Brandwick", birthDate: DOB_TEXT }]);
    expect(provider.reads.at(-1)).toEqual({ ref: s.ref, withDob: true });
    expect(s.session()).toMatchObject({
      closedAt: now,
      completedCheckId: row.checkId,
      reportId: `vr_${s.ref.slice(3)}done`,
      redactDueAt: now + 7 * DAY,
      typedNames: null,
      dobUnavailable: false,
    });
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("verified");
    expect(opsLines("identity_session_completed")).toMatchObject([
      { sessionId: s.sessionId, status: "passed", reviewReasons: [] },
    ]);
  });

  test("on production the typed name and the document's disagree: the row lands in review with name_mismatch under the typed names, and the session waits for the decision before its redaction date", async () => {
    const d = production();
    const s = await started(d);
    provider.verify(s.ref, { names: { firstName: "Ottilie-Rose", lastName: "BRANDWICK" } });

    expect(await syncSession(d, s.sessionId)).toBe("completed");

    const row = latestRow();
    expect(row).toMatchObject({ status: "needs_review", reviewReasons: ["name_mismatch"] });
    expect(namesOf(row)).toMatchObject({ first: "Ottilie", last: "Brandwick" });
    expect(s.session()).toMatchObject({ redactDueAt: null, typedNames: null });
    expect(s.session().closedAt).not.toBeNull();
  });

  test("a renewal: on a guardian verified for 30 more days, the state stays verified while the session runs, and the pass it completes supersedes the earlier one", async () => {
    const pass = passFor(GUARDIAN, T0 - 1000 * DAY, T0 + 30 * DAY);
    const s = await started();
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("verified");
    expect(currentRecord(repo, GUARDIAN, now, "sandbox")?.checkId).toBe(pass.checkId);

    provider.verify(s.ref);
    expect(await syncSession(deps(), s.sessionId)).toBe("completed");

    const row = latestRow();
    expect(row).toMatchObject({ status: "passed", supersedesCheckId: pass.checkId });
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("verified");
    expect(currentRecord(repo, GUARDIAN, now, "sandbox")?.checkId).toBe(row.checkId);
  });

  test("a renewal that lands in review keeps the earlier pass counting through the review", async () => {
    // On production, where the names are compared: a production pass, a production session.
    const pass = appended(
      passedIdentityRow(GUARDIAN, { at: T0 - 1000 * DAY, expiresAt: T0 + 30 * DAY }),
    );
    const d = production();
    const s = await started(d);
    provider.verify(s.ref, { names: { firstName: "Ottilie-Rose", lastName: "BRANDWICK" } });

    expect(await syncSession(d, s.sessionId)).toBe("completed");

    expect(latestRow()).toMatchObject({
      status: "needs_review",
      reviewReasons: ["name_mismatch"],
      supersedesCheckId: pass.checkId,
    });
    expect(identityState(repo, GUARDIAN, now, "production")).toBe("verified");
    expect(currentRecord(repo, GUARDIAN, now, "production")?.checkId).toBe(pass.checkId);
  });

  test("on a sandbox the names are not compared: test mode returns one sample person, and a typed name that differs from it passes, recorded as typed", async () => {
    const s = await started();
    provider.verify(s.ref, { names: SAMPLE_PERSON });

    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    const row = latestRow();
    expect(row).toMatchObject({ status: "passed", reviewReasons: [], synthetic: true });
    expect(namesOf(row)).toMatchObject({ first: "Ottilie", last: "Brandwick" });
  });

  test("on a sandbox the duplicate rule does not run: a second account verified with the same sample person passes", async () => {
    for (const t of [tenant(1), tenant(2)]) {
      const s = await started(deps(), t, SAMPLE_TYPED);
      provider.verify(s.ref, { names: SAMPLE_PERSON });
      expect(await syncSession(deps(), s.sessionId)).toBe("completed");
      expect(latestRow(t)).toMatchObject({ status: "passed", reviewReasons: [] });
    }
  });

  test("on production a second account with the same name and document country lands in review with duplicate_identity", async () => {
    const d = production();
    for (const t of [tenant(1), tenant(2)]) {
      const s = await started(d, t);
      provider.verify(s.ref);
      expect(await syncSession(d, s.sessionId)).toBe("completed");
    }
    expect(latestRow(tenant(1))).toMatchObject({ status: "passed" });
    expect(latestRow(tenant(2))).toMatchObject({
      status: "needs_review",
      reviewReasons: ["duplicate_identity"],
    });
  });

  test("a screen that errors leaves the session waiting with no row, the time it began kept; a later sync completes it once the screen answers", async () => {
    const s = await started();
    provider.verify(s.ref);
    screener.answer = "error";

    expect(await syncSession(deps(), s.sessionId)).toBe("screen_pending");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started"]);
    expect(s.session()).toMatchObject({ screenPendingSince: T0, closedAt: null });
    expect(opsLines("identity_screen_pending")).toMatchObject([{ sessionId: s.sessionId }]);

    now = T0 + 5 * MINUTE;
    expect(await syncSession(deps(), s.sessionId)).toBe("screen_pending");
    expect(s.session().screenPendingSince).toBe(T0);

    screener.answer = "clear";
    now = T0 + 10 * MINUTE;
    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({ status: "passed", watchlist: "clear" });
    expect(s.session().screenPendingSince).toBeNull();
  });

  test("a sanctions hit lands the check in review with watchlist_hit", async () => {
    const s = await started();
    provider.verify(s.ref);
    screener.answer = "hit";

    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({
      status: "needs_review",
      watchlist: "hit",
      reviewReasons: ["watchlist_hit"],
    });
  });

  test("a birth date the provider did not serve: the screen runs on the name alone, the row completes, and the session says the birth date was not read", async () => {
    const s = await started();
    provider.verify(s.ref, { dob: null });

    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(screener.queries).toEqual([{ name: "Ottilie Brandwick", birthDate: null }]);
    expect(latestRow().status).toBe("passed");
    expect(s.session().dobUnavailable).toBe(true);
    expect(opsLines("identity_dob_not_read")).toMatchObject([{ sessionId: s.sessionId }]);
  });

  test.each<[string, Error]>([
    [
      "a key refused the birth date (403)",
      new StripeKeyRejected(403, "Stripe Identity retrieve: HTTP 403"),
    ],
    ["a request refused (400)", new StripeError(400, "Stripe Identity retrieve: HTTP 400")],
  ])(
    "%s: the session is read again without it, once; the check completes and no key alarm is raised",
    async (_what, refused) => {
      const s = await started();
      provider.verify(s.ref);
      provider.failNext.retrieve.push(refused);

      expect(await syncSession(deps(), s.sessionId)).toBe("completed");
      expect(provider.reads.slice(-2)).toEqual([
        { ref: s.ref, withDob: true },
        { ref: s.ref, withDob: false },
      ]);
      expect(screener.queries).toEqual([{ name: "Ottilie Brandwick", birthDate: null }]);
      expect(s.session().dobUnavailable).toBe(true);
      expect(opsLines("identity_dob_not_read")).toHaveLength(1);
      expect(opsLines("identity_provider_key_rejected")).toEqual([]);
    },
  );

  test("through the provider's client, the read without the birth date still carries the names (ruling R19): the session completes, the birth date unread", async () => {
    // Stripe as its documentation describes it: the names only when `verified_outputs` is
    // expanded, and here the birth date's expand refused (no recent-results permission).
    let reference: string | null = null;
    const stripe = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const expands = url.searchParams.getAll("expand[]");
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      const base = {
        id: "vs_test1",
        object: "identity.verification_session",
        livemode: false,
        client_reference_id: reference,
        last_error: null,
        redaction: null,
      };
      if (init?.method === "POST") {
        reference = new URLSearchParams(String(init.body)).get("client_reference_id");
        return json(200, {
          ...base,
          client_reference_id: reference,
          status: "requires_input",
          url: "https://verify.stripe.com/start/test_fixture",
          verified_outputs: null,
          last_verification_report: null,
        });
      }
      if (expands.includes("verified_outputs.dob"))
        return json(403, { error: { type: "invalid_request_error", code: "permission_denied" } });
      return json(200, {
        ...base,
        status: "verified",
        url: null,
        verified_outputs: expands.includes("verified_outputs")
          ? { first_name: ON_DOCUMENT.firstName, last_name: ON_DOCUMENT.lastName }
          : null,
        last_verification_report: {
          id: "vr_test1done",
          object: "identity.verification_report",
          created: Math.floor((T0 + MINUTE) / 1000),
          document: { status: "verified", type: "passport", issuing_country: "FR" },
          selfie: { status: "verified" },
        },
      });
    }) as typeof fetch;
    const d = deps({
      provider: new StripeIdentityClient({ key: toSecret("rk_test_fixture"), fetch: stripe }),
    });
    const s = await started(d);

    expect(await syncSession(d, s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({ status: "passed", reviewReasons: [] });
    expect(namesOf(latestRow())).toMatchObject({ first: "Ottilie", last: "Brandwick" });
    expect(screener.queries).toEqual([{ name: "Ottilie Brandwick", birthDate: null }]);
    expect(s.session().dobUnavailable).toBe(true);
    expect(opsLines("identity_provider_key_rejected")).toEqual([]);
  });

  test("a key refused on the read without the birth date too raises the CRITICAL key line and answers 503; nothing written", async () => {
    const s = await started();
    provider.verify(s.ref);
    provider.failNext.retrieve.push(
      new StripeKeyRejected(403, "Stripe Identity retrieve: HTTP 403"),
      new StripeKeyRejected(401, "Stripe Identity retrieve: HTTP 401"),
    );

    const failed = await refusal(syncSession(deps(), s.sessionId));
    expect([failed.code, failed.status]).toEqual(["identity_provider_unavailable", 503]);
    expect(opsLines("identity_provider_key_rejected")).toMatchObject([{ severity: "CRITICAL" }]);
    expect(repo.list(GUARDIAN)).toHaveLength(1);
  });

  test("the third failed attempt writes the failed row, selfie_mismatch, and closes the session; a failure read twice counts once", async () => {
    const s = await started();

    provider.fail(s.ref, "selfie_face_mismatch", "vr_attempt1");
    expect(await syncSession(deps(), s.sessionId)).toBe("attempt_failed");
    expect(await syncSession(deps(), s.sessionId)).toBe("attempt_failed");
    expect(s.session()).toMatchObject({
      failedAttempts: 1,
      lastErrorCode: "selfie_face_mismatch",
    });
    expect(sessionView(deps(), GUARDIAN)).toMatchObject({ attemptsLeft: 2 });

    provider.fail(s.ref, "selfie_face_mismatch", "vr_attempt2");
    expect(await syncSession(deps(), s.sessionId)).toBe("attempt_failed");
    provider.fail(s.ref, "selfie_face_mismatch", "vr_attempt3");
    now = T0 + 30 * MINUTE;
    expect(await syncSession(deps(), s.sessionId)).toBe("closed");

    const row = latestRow();
    expect(row).toMatchObject({ status: "failed", names: null, completedAt: now, startedAt: T0 });
    expect(repo.events(row.checkId)).toMatchObject([
      {
        kind: "recorded",
        actor: "system",
        reasonCode: "selfie_mismatch",
        reason: "stripe requires_input: selfie_face_mismatch",
        provider: "stripe",
        providerEventId: `${s.ref}:failed:3`,
      },
    ]);
    expect(s.session()).toMatchObject({
      failedAttempts: 3,
      closedAt: now,
      completedCheckId: row.checkId,
      redactDueAt: now + 7 * DAY,
      typedNames: null,
    });
    expect(sessionView(deps(), GUARDIAN)).toEqual({ status: "none" });
  });

  test("a failed attempt is counted even when a read while it was processing already named its report", async () => {
    const s = await started();
    provider.fail(s.ref, "document_unverified_other", "vr_attempt1");
    await syncSession(deps(), s.sessionId);
    // The next attempt is being read, its report already named.
    provider.update(s.ref, {
      status: "processing",
      lastErrorCode: null,
      report: {
        ...(provider.sessions.get(s.ref)?.report as NonNullable<ProviderSession["report"]>),
        id: "vr_attempt2",
      },
    });
    expect(await syncSession(deps(), s.sessionId)).toBe("processing");
    provider.fail(s.ref, "document_unverified_other", "vr_attempt2");

    expect(await syncSession(deps(), s.sessionId)).toBe("attempt_failed");
    expect(s.session()).toMatchObject({ failedAttempts: 2, reportId: "vr_attempt2" });
  });

  test.each<[string, string]>([
    ["consent_declined", "consent_declined"],
    ["document_expired", "document_expired"],
    ["document_unverified_other", "document_unverified"],
    ["document_type_not_supported", "document_unverified"],
    ["selfie_document_missing_photo", "selfie_mismatch"],
    ["under_supported_age", "other"],
    ["id_number_mismatch", "other"],
  ])("a failure coded %s is recorded with the reason code %s", async (code, reasonCode) => {
    const d = deps({ limits: { ...deps().limits, attemptsPerSession: 1 } });
    const s = await started(d);
    provider.fail(s.ref, code, "vr_attempt1");

    expect(await syncSession(d, s.sessionId)).toBe("closed");
    expect(repo.events(latestRow().checkId)[0]?.reasonCode).toBe(reasonCode);
  });

  test("consent declined closes the session at once, on the first attempt", async () => {
    const s = await started();
    provider.fail(s.ref, "consent_declined", "vr_attempt1");

    expect(await syncSession(deps(), s.sessionId)).toBe("closed");
    expect(latestRow().status).toBe("failed");
    expect(repo.events(latestRow().checkId)[0]).toMatchObject({ reasonCode: "consent_declined" });
    expect(s.session().failedAttempts).toBe(1);
  });

  test("a session canceled at the provider is closed with a failed row, abandoned", async () => {
    const s = await started();
    provider.update(s.ref, { status: "canceled" });

    expect(await syncSession(deps(), s.sessionId)).toBe("closed");
    expect(latestRow().status).toBe("failed");
    expect(repo.events(latestRow().checkId)[0]).toMatchObject({
      reasonCode: "abandoned",
      providerEventId: `${s.ref}:canceled`,
    });
    expect(s.session()).toMatchObject({ redactDueAt: T0 + 7 * DAY });
  });

  test("a read in the other mode, or naming another session, is dropped: nothing written, one ops line with the reason", async () => {
    const s = await started();
    provider.verify(s.ref);

    provider.update(s.ref, { livemode: true });
    expect(await syncSession(deps(), s.sessionId)).toBe("dropped");
    provider.update(s.ref, { livemode: false, clientReferenceId: "f".repeat(32) });
    expect(await syncSession(deps(), s.sessionId)).toBe("dropped");

    expect(repo.list(GUARDIAN)).toHaveLength(1);
    expect(s.session()).toMatchObject({ lastReadAt: null, closedAt: null });
    expect(opsLines("identity_session_dropped")).toMatchObject([
      { sessionId: s.sessionId, reason: "mode" },
      { sessionId: s.sessionId, reason: "reference" },
    ]);
  });

  test("a session the provider redacted writes nothing to the record and is marked redacted", async () => {
    const s = await started();
    provider.update(s.ref, { redaction: "processing" });
    expect(await syncSession(deps(), s.sessionId)).toBe("redacted");
    expect(s.session().redactedAt).toBeNull();

    provider.update(s.ref, { redaction: "redacted" });
    expect(await syncSession(deps(), s.sessionId)).toBe("redacted");

    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started"]);
    expect(s.session()).toMatchObject({ redactedAt: T0 });
  });

  test("a document from a country outside ISO 3166-1 lands in review with provider_flag, never passed", async () => {
    const s = await started();
    provider.verify(s.ref, { country: "XK" });

    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({
      status: "needs_review",
      reviewReasons: ["provider_flag"] satisfies ReviewReasonCode[],
      documentCountry: null,
    });
  });

  test("on a sandbox without a screener the pass records the search as not run", async () => {
    const s = await started(deps({ screener: undefined }));
    provider.verify(s.ref);

    expect(await syncSession(deps({ screener: undefined }), s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({ status: "passed", watchlist: "not_run" });
  });

  test("on production a verified session with the face match and a clear screen passes, not synthetic", async () => {
    const d = production();
    const s = await started(d);
    provider.verify(s.ref);

    expect(await syncSession(d, s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({
      status: "passed",
      environment: "production",
      synthetic: false,
      liveness: "passed",
      watchlist: "clear",
    });
    expect(identityState(repo, GUARDIAN, now, "production")).toBe("verified");
  });

  test("a result the rules refuse leaves the session open for an operator: the read recorded, one ops line without the rule's sentence, unchanged", async () => {
    const d = production();
    const s = await started(d);
    // On production a pass needs the face match.
    provider.verify(s.ref, { selfie: "unverified" });
    now = T0 + MINUTE;

    expect(await syncSession(d, s.sessionId)).toBe("unchanged");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started"]);
    expect(s.session()).toMatchObject({ closedAt: null, lastStatus: "verified", lastReadAt: now });
    expect(opsLines("identity_session_refused")).toEqual([
      expect.objectContaining({ sessionId: s.sessionId, reason: "plan_refused" }),
    ]);
    expect(output.join("\n")).not.toContain("--liveness");
  });

  test.each(["sandbox", "production"] as const)(
    "on %s the refusal line of a parked session is loud, for both reasons and once each: CRITICAL on production, a warning on a sandbox",
    async (environment) => {
      const d = environment === "production" ? production() : deps();
      const refused = await parkedSession(d, tenant(1));
      // A session holding no typed names: there is no name of record to write.
      const nameless = await started(d, tenant(2));
      sessions.eraseTypedNames(nameless.sessionId, now);
      provider.verify(nameless.ref);
      expect(await syncSession(d, nameless.sessionId)).toBe("unchanged");
      // Later passes look at both and write no second refusal line.
      for (const minutes of [10, 20]) {
        now = T0 + minutes * MINUTE;
        await sweepSessions(d, now);
      }

      const lines = opsLines("identity_session_refused");
      expect(lines).toEqual([
        expect.objectContaining({
          sessionId: refused.sessionId,
          reason: "plan_refused",
          ...parkedLevel(environment),
        }),
        expect.objectContaining({
          sessionId: nameless.sessionId,
          reason: "no_typed_names",
          ...parkedLevel(environment),
        }),
      ]);
      if (environment === "sandbox")
        for (const l of lines) expect(l).not.toHaveProperty("severity");
    },
  );

  test("the two reviews the adapter raises itself with provider_flag carry their cause on the completion event; any other completion carries none", async () => {
    const revoke = (t: string) => {
      const pass = passFor(t, T0 - 1000 * DAY, T0 + 30 * DAY);
      appended(
        {
          ...pass,
          status: "revoked",
          supersedesCheckId: pass.checkId,
          expiresAt: null,
          names: null,
          nameHmac: null,
        },
        "revoked",
      );
    };
    const completed = async (t: string, country?: string) => {
      const s = await started(deps(), t);
      provider.verify(s.ref, country === undefined ? {} : { country });
      expect(await syncSession(deps(), s.sessionId)).toBe("completed");
      const row = latestRow(t);
      return {
        status: row.status,
        reviewReasons: row.reviewReasons,
        documentCountry: row.documentCountry,
        event: repo.events(row.checkId)[0],
      };
    };
    const systemRecorded = { kind: "recorded", actor: "system" };

    // A document country outside ISO 3166-1 (Kosovo's XK).
    expect(await completed(tenant(1), "XK")).toMatchObject({
      status: "needs_review",
      reviewReasons: ["provider_flag"],
      documentCountry: null,
      event: { ...systemRecorded, reasonCode: "country_outside_iso" },
    });
    // A result after a revocation.
    revoke(tenant(2));
    expect(await completed(tenant(2))).toMatchObject({
      status: "needs_review",
      reviewReasons: ["provider_flag"],
      documentCountry: "FRA",
      event: { ...systemRecorded, reasonCode: "after_revocation" },
    });
    // Both: the revocation is named, the empty document country shows the other cause.
    revoke(tenant(3));
    expect(await completed(tenant(3), "XK")).toMatchObject({
      documentCountry: null,
      event: { ...systemRecorded, reasonCode: "after_revocation" },
    });
    // A pass, and a review for another reason.
    expect(await completed(tenant(4))).toMatchObject({
      status: "passed",
      event: { ...systemRecorded, reasonCode: null },
    });
    recordHuman(store, tenant(5), nullifierOf(tenant(5)), T0 - DAY);
    screener.answer = "hit";
    expect(await completed(tenant(5))).toMatchObject({
      status: "needs_review",
      reviewReasons: ["watchlist_hit"],
      event: { ...systemRecorded, reasonCode: null },
    });
  });

  test("a refused result is screened once: later sweeps neither read it at the provider nor screen it again; an operator's row closes it without a row of its own", async () => {
    const d = production();
    const s = await started(d);
    provider.verify(s.ref, { selfie: "unverified" });
    now = T0 + MINUTE;
    expect(await syncSession(d, s.sessionId)).toBe("unchanged");
    const reads = provider.reads.length;

    for (const at of [10, 20, 30]) {
      now = T0 + at * MINUTE;
      expect(await sweepSessions(d, now)).toMatchObject({ synced: 1, errors: 0 });
    }
    expect(screener.queries).toHaveLength(1);
    expect(provider.reads).toHaveLength(reads);
    expect(opsLines("identity_session_refused")).toHaveLength(1);
    // Looked at, so the sweep's queue moves past it.
    expect(s.session()).toMatchObject({ lastReadAt: T0 + 30 * MINUTE, closedAt: null });

    // An operator's row: the next sweep closes the session, writing nothing over it.
    now = T0 + 40 * MINUTE;
    repo.append(
      {
        ...latestRow(),
        status: "failed",
        supersedesCheckId: latestRow().checkId,
        completedAt: now,
        operator: "ops.example",
        operatorOsUser: "ops",
      },
      {
        kind: "refused",
        at: now,
        actor: "ops.example",
        actorOsUser: "ops",
        reasonCode: "other",
        reason: null,
      },
    );
    now = T0 + 50 * MINUTE;
    await sweepSessions(d, now);
    expect(s.session()).toMatchObject({
      closedAt: now,
      completedCheckId: null,
      redactDueAt: now + 7 * DAY,
    });
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "failed"]);
    expect(screener.queries).toHaveLength(1);
    expect(opsLines("identity_session_refused")).toHaveLength(1);
    expect(opsLines("identity_session_superseded")).toHaveLength(1);

    now = T0 + 15 * DAY;
    expect(await sweepSessions(d, now)).toMatchObject({ abandoned: 0 });
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "failed"]);
  });

  test("an operator's pass written while the session waits for the screen: the sweep at day 15 closes the session without a failed row, its redaction due", async () => {
    const s = await started();
    provider.verify(s.ref);
    screener.answer = "error";
    expect(await syncSession(deps(), s.sessionId)).toBe("screen_pending");

    // The runbook's path: the operator searched by hand and recorded the pass over the started row.
    now = T0 + DAY;
    const pass = passFor(GUARDIAN, now, now + 1000 * DAY);
    now = T0 + 15 * DAY;

    expect(await sweepSessions(deps(), now)).toMatchObject({ abandoned: 0, errors: 0 });
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "passed"]);
    expect(latestRow().checkId).toBe(pass.checkId);
    expect(s.session()).toMatchObject({
      closedAt: now,
      completedCheckId: null,
      redactDueAt: now + 7 * DAY,
      typedNames: null,
    });
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("verified");
    expect(opsLines("identity_session_superseded")).toEqual([
      expect.objectContaining({ sessionId: s.sessionId }),
    ]);
    expect(opsLines("identity_session_closed")).toEqual([]);
  });

  test("an operator's refusal written while the session is open: a verified result then writes no pass, the session closes without a row and nobody is screened", async () => {
    const s = await started();
    const begun = latestRow();
    now = T0 + MINUTE;
    appended(
      {
        ...begun,
        status: "failed",
        supersedesCheckId: begun.checkId,
        completedAt: now,
        operator: "ops.example",
        operatorOsUser: "ops",
      },
      "refused",
    );
    provider.verify(s.ref);
    now = T0 + 2 * MINUTE;

    expect(await syncSession(deps(), s.sessionId)).toBe("closed");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "failed"]);
    expect(screener.queries).toEqual([]);
    expect(s.session()).toMatchObject({
      closedAt: now,
      completedCheckId: null,
      redactDueAt: now + 7 * DAY,
      typedNames: null,
    });
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("failed");
    expect(opsLines("identity_session_superseded")).toEqual([
      expect.objectContaining({ sessionId: s.sessionId }),
    ]);
  });

  test("an operator's row written while the session is open: a result read while the screen runs writes no row either", async () => {
    const s = await started();
    provider.verify(s.ref);
    // The operator writes the refusal while the screen is out.
    screener.screenPerson = async (q) => {
      screener.queries.push(q);
      const begun = repo.list(GUARDIAN)[0] as GuardianIdentityCheck;
      appended(
        {
          ...begun,
          status: "failed",
          supersedesCheckId: begun.checkId,
          completedAt: now,
          operator: "ops.example",
          operatorOsUser: "ops",
        },
        "refused",
      );
      return "clear";
    };

    expect(await syncSession(deps(), s.sessionId)).toBe("closed");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "failed"]);
    expect(s.session()).toMatchObject({ completedCheckId: null, redactDueAt: now + 7 * DAY });
  });

  test("an operator's row written while the session waits for the person: the failed attempt that reaches the limit writes no failed row of its own", async () => {
    const d = deps({ limits: { ...deps().limits, attemptsPerSession: 1 } });
    const s = await started(d);
    const begun = latestRow();
    appended(
      {
        ...begun,
        status: "failed",
        supersedesCheckId: begun.checkId,
        completedAt: now,
        operator: "ops.example",
        operatorOsUser: "ops",
      },
      "refused",
    );
    provider.fail(s.ref, "document_unverified_other", "vr_attempt1");

    expect(await syncSession(d, s.sessionId)).toBe("closed");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "failed"]);
    expect(s.session()).toMatchObject({ completedCheckId: null, redactDueAt: now + 7 * DAY });
  });

  test("an operator's row written while the session waits for the person: the next start closes it without a row and opens a new session", async () => {
    const s = await started();
    const begun = latestRow();
    now = T0 + MINUTE;
    appended(
      {
        ...begun,
        status: "failed",
        supersedesCheckId: begun.checkId,
        completedAt: now,
        operator: "ops.example",
        operatorOsUser: "ops",
      },
      "refused",
    );

    const next = await startSession(deps(), GUARDIAN, TYPED);

    expect(next.sessionId).not.toBe(s.sessionId);
    expect(s.session()).toMatchObject({ closedAt: now, completedCheckId: null });
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "failed", "started"]);
  });

  test("the duplicate check sees another account's pass while that account's renewal runs: its started row does not hide it", async () => {
    // Another account, verified on production with the same name and document country, has
    // begun its renewal.
    const other = tenant(2);
    const otherPass = appended({
      ...passedIdentityRow(other, { at: T0 - DAY, expiresAt: T0 + 60 * DAY }),
      nameHmac: nameHmac(FINGERPRINT_KEY, "Ottilie", "Brandwick"),
      documentCountry: "FRA",
    });
    appended({
      ...otherPass,
      status: "started",
      completedAt: null,
      expiresAt: null,
      names: null,
      nameHmac: null,
      documentCountry: null,
      operator: null,
      operatorOsUser: null,
    });
    const d = production();
    const s = await started(d);
    provider.verify(s.ref);

    expect(await syncSession(d, s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({
      status: "needs_review",
      reviewReasons: ["duplicate_identity"],
    });
  });

  test("a revocation during an open session is not undone: the verified result writes no pass, and the state stays revoked", async () => {
    const pass = passFor(GUARDIAN, T0 - 1000 * DAY, T0 + 30 * DAY);
    const s = await started();
    now = T0 + MINUTE;
    appended(
      {
        ...pass,
        status: "revoked",
        supersedesCheckId: pass.checkId,
        expiresAt: null,
        names: null,
        nameHmac: null,
      },
      "revoked",
    );
    provider.verify(s.ref);
    now = T0 + 2 * MINUTE;

    expect(await syncSession(deps(), s.sessionId)).toBe("closed");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["passed", "started", "revoked"]);
    expect(identityState(repo, GUARDIAN, now, "sandbox")).toBe("revoked");
  });

  test.each(["sandbox", "production"] as const)(
    "on %s a result after a revocation lands in review with provider_flag, never passed: the start stays open and an operator decides",
    async (environment) => {
      const d = environment === "production" ? production() : deps();
      const pass = appended({
        ...passedIdentityRow(GUARDIAN, { at: T0 - 1000 * DAY, expiresAt: T0 + 30 * DAY }),
        environment,
        synthetic: environment === "sandbox",
      });
      appended(
        {
          ...pass,
          status: "revoked",
          supersedesCheckId: pass.checkId,
          expiresAt: null,
          names: null,
          nameHmac: null,
        },
        "revoked",
      );
      const s = await started(d);
      provider.verify(s.ref);

      expect(await syncSession(d, s.sessionId)).toBe("completed");
      expect(latestRow()).toMatchObject({
        status: "needs_review",
        reviewReasons: ["provider_flag"],
        supersedesCheckId: null,
      });
      expect(identityState(repo, GUARDIAN, now, environment)).toBe("needs_review");
    },
  );

  test("a pass after the revocation, an operator's, lifts the rule: the next result passes as a renewal", async () => {
    const pass = passFor(GUARDIAN, T0 - 1000 * DAY, T0 + 30 * DAY);
    appended(
      {
        ...pass,
        status: "revoked",
        supersedesCheckId: pass.checkId,
        expiresAt: null,
        names: null,
        nameHmac: null,
      },
      "revoked",
    );
    const again = passFor(GUARDIAN, T0 - DAY, T0 + 30 * DAY);
    const s = await started();
    provider.verify(s.ref);

    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(latestRow()).toMatchObject({ status: "passed", supersedesCheckId: again.checkId });
  });

  test("a closed session is unchanged, and not read again", async () => {
    const s = await started();
    provider.verify(s.ref);
    await syncSession(deps(), s.sessionId);
    const reads = provider.reads.length;

    expect(await syncSession(deps(), s.sessionId)).toBe("unchanged");
    expect(provider.reads).toHaveLength(reads);
  });

  test("two syncs at once complete the session once: one row, the other answers unchanged", async () => {
    const s = await started();
    provider.verify(s.ref);

    const outcomes = await Promise.all([
      syncSession(deps(), s.sessionId),
      syncSession(deps(), s.sessionId),
    ]);

    expect(outcomes.sort()).toEqual(["completed", "unchanged"]);
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started", "passed"]);
  });

  test("names typed again while a result is read are not recorded under the earlier screen: that read answers unchanged, the next records the new names", async () => {
    const s = await started(deps(), GUARDIAN, { firstName: "Ottilie", lastName: "Brandwik" });
    provider.verify(s.ref);

    // The sync has read the session and its names; the person types them again meanwhile.
    const reading = syncSession(deps(), s.sessionId);
    const seal = (field: "first" | "last", value: string) => {
      const { ciphertext, iv } = encryptText(
        TEST_PII_RING,
        value,
        IDENTITY_SESSION_AAD(s.sessionId, field),
      );
      return { ciphertext, iv };
    };
    sessions.setTypedNames(
      s.sessionId,
      {
        first: seal("first", "Ottilie"),
        last: seal("last", "Brandwick"),
        keyId: TEST_PII_RING.current.id,
      },
      now,
    );

    expect(await reading).toBe("unchanged");
    expect(repo.list(GUARDIAN).map((r) => r.status)).toEqual(["started"]);
    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(namesOf(latestRow())).toMatchObject({ first: "Ottilie", last: "Brandwick" });
    expect(screener.queries.at(-1)).toEqual({ name: "Ottilie Brandwick", birthDate: DOB_TEXT });
  });
});

// ── view ────────────────────────────────────────────────────────────────────────────────────

describe("sessionView", () => {
  test("none without an open session; an open one's id, start, attempts left, last code, and whether its result is being read", async () => {
    expect(sessionView(deps(), GUARDIAN)).toEqual({ status: "none" });

    const s = await started();
    expect(sessionView(deps(), GUARDIAN)).toEqual({
      status: "open",
      sessionId: s.sessionId,
      startedAt: T0,
      attemptsLeft: 3,
      lastErrorCode: null,
      reading: false,
      held: null,
    });

    provider.fail(s.ref, "document_unverified_other", "vr_attempt1");
    await syncSession(deps(), s.sessionId);
    expect(sessionView(deps(), GUARDIAN)).toMatchObject({
      attemptsLeft: 2,
      lastErrorCode: "document_unverified_other",
      reading: false,
      held: null,
    });

    provider.update(s.ref, { status: "processing", lastErrorCode: null });
    await syncSession(deps(), s.sessionId);
    expect(sessionView(deps(), GUARDIAN)).toMatchObject({ reading: true, held: null });
  });

  test("a session the provider verified is held, never reading: by the system while its screen has no verdict, for an operator once the rules refused it", async () => {
    const s = await started();
    provider.verify(s.ref);
    screener.answer = "error";
    expect(await syncSession(deps(), s.sessionId)).toBe("screen_pending");
    expect(sessionView(deps(), GUARDIAN)).toMatchObject({
      status: "open",
      reading: false,
      held: "system",
    });

    screener.answer = "clear";
    now = T0 + 10 * MINUTE;
    expect(await syncSession(deps(), s.sessionId)).toBe("completed");
    expect(sessionView(deps(), GUARDIAN)).toEqual({ status: "none" });

    const parked = await parkedSession(deps(), tenant(2));
    expect(sessionView(deps(), tenant(2))).toMatchObject({
      status: "open",
      sessionId: parked.sessionId,
      reading: false,
      held: "operator",
    });
  });
});

// ── sweep ───────────────────────────────────────────────────────────────────────────────────

describe("sweepSessions", () => {
  const zero = { synced: 0, abandoned: 0, redactRequested: 0, redacted: 0, errors: 0 };

  test("an open session of 15 days waiting for the person is redacted at the provider, which cancels it, and closed as abandoned", async () => {
    const s = await started();
    now = T0 + 15 * DAY;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, abandoned: 1, redactRequested: 1 });
    expect(provider.redacted).toEqual([s.ref]);
    expect(provider.canceled).toEqual([]);
    expect(provider.sessions.get(s.ref)).toMatchObject({
      status: "canceled",
      redaction: "processing",
    });
    expect(s.session().redactionRequestedAt).toBe(now);
    expect(latestRow().status).toBe("failed");
    expect(repo.events(latestRow().checkId)[0]).toMatchObject({
      actor: "system",
      reasonCode: "abandoned",
      providerEventId: `${s.ref}:abandoned`,
    });
    expect(s.session()).toMatchObject({ closedAt: now, redactDueAt: now + 7 * DAY });
  });

  test("an old session redaction does not take is canceled instead; one the provider no longer has, or can no longer cancel, is closed as abandoned all the same", async () => {
    // Read last while its result was being processed: neither redaction nor cancel takes it.
    const processing = await started(deps(), tenant(1));
    provider.update(processing.ref, { status: "processing" });
    await syncSession(deps(), processing.sessionId);
    // Gone at the provider.
    const gone = await started(deps(), tenant(2));
    provider.update(gone.ref, { status: "processing" });
    await syncSession(deps(), gone.sessionId);
    provider.sessions.delete(gone.ref);
    // Last read waiting, but processing at the provider since: the redaction is refused, and the
    // cancel too.
    const moved = await started(deps(), tenant(3));
    await syncSession(deps(), moved.sessionId);
    provider.update(moved.ref, { status: "processing" });
    now = T0 + 15 * DAY;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, abandoned: 3 });
    for (const s of [processing, gone, moved])
      expect(s.session()).toMatchObject({ closedAt: now, redactionRequestedAt: null });
    expect(provider.redacted).toEqual([moved.ref]);
    expect(provider.canceled).toEqual([processing.ref, gone.ref, moved.ref]);
    expect(opsLines("identity_redaction_refused")).toMatchObject([
      { sessionId: moved.sessionId, op: "redact", status: 400 },
    ]);
  });

  test("a provider refusing a redaction for good (404, 400) is asked again only a week later, and the sweep moves on to redact the others", async () => {
    const all = [] as Awaited<ReturnType<typeof started>>[];
    // Three countries: one name under one country on two accounts would be a duplicate review.
    for (const [n, country] of [
      [1, "FR"],
      [2, "DE"],
      [3, "IT"],
    ] as const) {
      const s = await started(deps(), tenant(n));
      provider.verify(s.ref, { country });
      await syncSession(deps(), s.sessionId);
      all.push(s);
    }
    const [gone, refusing, fine] = all as [(typeof all)[0], (typeof all)[0], (typeof all)[0]];
    provider.sessions.delete(gone.ref); // deleted test data: 404 at the read
    provider.update(refusing.ref, { status: "canceled" }); // 400 at the redaction
    now = T0 + 7 * DAY;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, redactRequested: 3 });
    for (const s of all) expect(s.session().redactionRequestedAt).toBe(now);
    expect(provider.redacted).toEqual([refusing.ref, fine.ref]);
    expect(provider.sessions.get(fine.ref)?.redaction).toBe("processing");
    expect(opsLines("identity_redaction_refused")).toMatchObject([
      { sessionId: gone.sessionId, op: "retrieve", status: 404 },
      { sessionId: refusing.sessionId, op: "redact", status: 400 },
    ]);
    expect(opsLines("identity_sessions_sweep_error")).toEqual([]);

    // Not asked again within the week; a refused key stays an error and is not marked.
    expect(await sweepSessions(deps(), now + DAY)).toEqual(zero);
    expect(opsLines("identity_redaction_refused")).toHaveLength(2);
  });

  test("a refused key during the redaction stays an error, the request not marked", async () => {
    const s = await started();
    provider.verify(s.ref);
    await syncSession(deps(), s.sessionId);
    provider.failNext.redact.push(new StripeKeyRejected(403, "Stripe Identity redact: HTTP 403"));
    now = T0 + 7 * DAY;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, errors: 1 });
    expect(s.session().redactionRequestedAt).toBeNull();
    expect(opsLines("identity_provider_key_rejected")).toMatchObject([{ severity: "CRITICAL" }]);
    expect(opsLines("identity_redaction_refused")).toEqual([]);
  });

  test("open sessions not read in the last two minutes are synced; one read just now waits", async () => {
    const waiting = await started(deps(), tenant(1));
    const fresh = await started(deps(), tenant(2));
    provider.verify(waiting.ref);
    now = T0 + 10 * MINUTE;
    await syncSession(deps(), fresh.sessionId);
    now += MINUTE;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, synced: 1 });
    expect(waiting.session().closedAt).toBe(now);
    expect(fresh.session().lastReadAt).toBe(now - MINUTE);
  });

  test("a session due for redaction is redacted at the provider and marked requested; once the provider says redacted it is marked redacted", async () => {
    const s = await started();
    provider.verify(s.ref);
    await syncSession(deps(), s.sessionId);
    expect(s.session().redactDueAt).toBe(T0 + 7 * DAY);

    now = T0 + 7 * DAY;
    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, redactRequested: 1 });
    expect(provider.redacted).toEqual([s.ref]);
    expect(s.session()).toMatchObject({ redactionRequestedAt: now, redactedAt: null });

    // Requested a moment ago: not asked again.
    expect(await sweepSessions(deps(), now + DAY)).toEqual(zero);

    provider.update(s.ref, { redaction: "redacted" });
    now = T0 + 15 * DAY;
    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, redacted: 1 });
    expect(provider.redacted).toEqual([s.ref]);
    expect(s.session().redactedAt).toBe(now);
  });

  test("a review's session gets its redaction date once the operator decides it, and not before", async () => {
    const accepted = await started(deps(), tenant(1));
    provider.verify(accepted.ref, { country: "XK" });
    await syncSession(deps(), accepted.sessionId);
    // A name_mismatch review: on production, where the names are compared.
    const corrected = await started(production(), tenant(2));
    provider.verify(corrected.ref, { names: { firstName: "Ottilie-Rose", lastName: "BRANDWICK" } });
    await syncSession(production(), corrected.sessionId);
    expect(latestRow(tenant(2)).reviewReasons).toEqual(["name_mismatch"]);

    now = T0 + DAY;
    expect(await sweepSessions(deps(), now)).toEqual(zero);
    expect(accepted.session().redactDueAt).toBeNull();
    expect(corrected.session().redactDueAt).toBeNull();

    // The operator's decisions: an acceptance, and a name correction (a name_mismatch review is
    // settled with identity:correct-name), each a passed row superseding the review.
    for (const [t, kind] of [
      [tenant(1), "accepted"],
      [tenant(2), "name_corrected"],
    ] as const) {
      const review = latestRow(t);
      const { checkId: _id, namesErasedAt: _erased, ...facts } = review;
      appended(
        {
          ...facts,
          ...passedIdentityRow(t, {
            at: review.completedAt as number,
            expiresAt: review.expiresAt as number,
          }),
          environment: "sandbox",
          synthetic: true,
          supersedesCheckId: review.checkId,
        },
        kind,
      );
    }
    now = T0 + 2 * DAY;
    expect(await sweepSessions(deps(), now)).toEqual(zero);
    expect(accepted.session().redactDueAt).toBe(now + 7 * DAY);
    expect(corrected.session().redactDueAt).toBe(now + 7 * DAY);
  });

  test("a row over a review that is not a decision ends its wait all the same: the review is no longer the standing row, and its session gets its redaction date", async () => {
    const s = await started();
    provider.verify(s.ref, { country: "XK" });
    await syncSession(deps(), s.sessionId);
    const review = latestRow();
    // identity:record over the review: a new check, not a decision on it.
    appended({
      ...passedIdentityRow(GUARDIAN, {
        at: review.completedAt as number,
        expiresAt: review.expiresAt as number,
      }),
      environment: "sandbox",
      synthetic: true,
      supersedesCheckId: review.checkId,
    });

    now = T0 + DAY;
    expect(await sweepSessions(deps(), now)).toEqual(zero);
    expect(s.session().redactDueAt).toBe(now + 7 * DAY);
  });

  test("a review buried under a newer started row is no longer the standing row: its session gets its redaction date", async () => {
    const s = await started();
    provider.verify(s.ref, { country: "XK" });
    await syncSession(deps(), s.sessionId);
    const review = latestRow();
    // A started row written over the review, as a start could before it refused one.
    appended({
      ...review,
      status: "started",
      supersedesCheckId: null,
      completedAt: null,
      expiresAt: null,
      names: null,
      nameHmac: null,
      documentCountry: null,
      reviewReasons: [],
      operator: null,
      operatorOsUser: null,
    });

    now = T0 + DAY;
    await sweepSessions(deps(), now);
    expect(s.session().redactDueAt).toBe(now + 7 * DAY);
  });

  test("a correction that leaves the check in review keeps it waiting; the decision after it dates the session", async () => {
    const s = await started();
    provider.verify(s.ref, { country: "XK" });
    await syncSession(deps(), s.sessionId);
    const review = latestRow();
    const { checkId: _id, namesErasedAt: _erased, ...facts } = review;
    const corrected = appended(
      { ...facts, supersedesCheckId: review.checkId, operator: "ops.example" },
      "name_corrected",
    );

    now = T0 + DAY;
    await sweepSessions(deps(), now);
    expect(s.session().redactDueAt).toBeNull();

    const { checkId: _cid, namesErasedAt: _cerased, ...correctedFacts } = corrected;
    appended(
      {
        ...correctedFacts,
        status: "failed",
        supersedesCheckId: corrected.checkId,
        expiresAt: null,
        names: null,
        nameHmac: null,
        reviewReasons: [],
      },
      "refused",
    );
    now = T0 + 2 * DAY;
    await sweepSessions(deps(), now);
    expect(s.session().redactDueAt).toBe(now + 7 * DAY);
  });

  test("a review waiting more than 7 days for a decision raises one warning per sweep, with its days, until it is decided", async () => {
    const s = await started();
    provider.verify(s.ref, { country: "XK" });
    await syncSession(deps(), s.sessionId);
    const review = latestRow();

    now = T0 + 6 * DAY;
    await sweepSessions(deps(), now);
    expect(opsLines("identity_review_waiting")).toEqual([]);

    now = T0 + 8 * DAY;
    await sweepSessions(deps(), now);
    expect(opsLines("identity_review_waiting")).toEqual([
      expect.objectContaining({ sessionId: s.sessionId, days: 8, level: "warn" }),
    ]);

    const { checkId: _id, namesErasedAt: _erased, ...facts } = review;
    appended(
      {
        ...facts,
        status: "failed",
        supersedesCheckId: review.checkId,
        expiresAt: null,
        names: null,
        nameHmac: null,
        reviewReasons: [],
        operator: "ops.example",
      },
      "refused",
    );
    now = T0 + 9 * DAY;
    await sweepSessions(deps(), now);
    expect(opsLines("identity_review_waiting")).toHaveLength(1);
    expect(s.session().redactDueAt).toBe(now + 7 * DAY);
  });

  test("a screen pending for more than 24 hours raises one CRITICAL line per sweep, with its hours, until the screen answers", async () => {
    const s = await started();
    provider.verify(s.ref);
    screener.answer = "error";
    expect(await syncSession(deps(), s.sessionId)).toBe("screen_pending");

    now = T0 + 23 * 3_600_000;
    await sweepSessions(deps(), now);
    expect(opsLines("identity_screen_pending_stale")).toEqual([]);

    for (const hours of [25, 26]) {
      now = T0 + hours * 3_600_000;
      await sweepSessions(deps(), now);
    }
    expect(opsLines("identity_screen_pending_stale")).toEqual([
      expect.objectContaining({
        sessionId: s.sessionId,
        hours: 25,
        level: "error",
        severity: "CRITICAL",
      }),
      expect.objectContaining({ sessionId: s.sessionId, hours: 26, severity: "CRITICAL" }),
    ]);

    screener.answer = "clear";
    now = T0 + 27 * 3_600_000;
    await sweepSessions(deps(), now);
    expect(s.session().closedAt).toBe(now);
    expect(opsLines("identity_screen_pending_stale")).toHaveLength(2);
  });

  test.each(["sandbox", "production"] as const)(
    "on %s a session waiting for an operator raises a line at each pass, with its age in hours, CRITICAL on production and a warning on a sandbox; none once an operator's row closes it",
    async (environment) => {
      const d = environment === "production" ? production() : deps();
      const s = await parkedSession(d);
      expect(opsLines("identity_session_waiting_operator")).toEqual([]);

      for (const hours of [2, 3]) {
        now = T0 + hours * 3_600_000;
        await sweepSessions(d, now);
      }
      const lines = opsLines("identity_session_waiting_operator");
      expect(lines).toEqual([
        expect.objectContaining({
          sessionId: s.sessionId,
          ageHours: 2,
          ...parkedLevel(environment),
        }),
        expect.objectContaining({
          sessionId: s.sessionId,
          ageHours: 3,
          ...parkedLevel(environment),
        }),
      ]);
      if (environment === "sandbox")
        for (const l of lines) expect(l).not.toHaveProperty("severity");

      // An operator's row: the next pass closes the session, and the line stops.
      now = T0 + 3 * 3_600_000 + 30 * MINUTE;
      operatorRefuses();
      for (const hours of [4, 5]) {
        now = T0 + hours * 3_600_000;
        await sweepSessions(d, now);
      }
      expect(s.session().closedAt).toBe(T0 + 4 * 3_600_000);
      expect(opsLines("identity_session_waiting_operator")).toHaveLength(2);
    },
  );

  test("a screen pending for more than 24 hours raises its CRITICAL line even when the sweep's read of the session throws", async () => {
    const s = await started();
    provider.verify(s.ref);
    screener.answer = "error";
    expect(await syncSession(deps(), s.sessionId)).toBe("screen_pending");
    provider.failNext.retrieve.push(
      new StripeUnavailable(503, "Stripe Identity retrieve: HTTP 503"),
    );
    now = T0 + 25 * 3_600_000;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, errors: 1 });
    expect(opsLines("identity_screen_pending_stale")).toEqual([
      expect.objectContaining({ sessionId: s.sessionId, hours: 25, severity: "CRITICAL" }),
    ]);
  });

  test("a session verified at the provider and not completed within its days closes with reason code other and its cause, not as abandoned; one left waiting for the person is abandoned", async () => {
    const refused = await parkedSession(deps(), tenant(1));
    // Its typed names lost: refused with no_typed_names.
    const nameless = await started(deps(), tenant(2));
    sessions.eraseTypedNames(nameless.sessionId, now);
    provider.verify(nameless.ref);
    expect(await syncSession(deps(), nameless.sessionId)).toBe("unchanged");
    const pending = await started(deps(), tenant(3));
    provider.verify(pending.ref);
    screener.answer = "error";
    expect(await syncSession(deps(), pending.sessionId)).toBe("screen_pending");
    const waiting = await started(deps(), tenant(4));
    now = T0 + 15 * DAY;

    expect(await sweepSessions(deps(), now)).toMatchObject({ abandoned: 4, errors: 0 });
    const closing = (t: string) => {
      const row = latestRow(t);
      return { status: row.status, event: repo.events(row.checkId)[0] };
    };
    const verifiedThen = (cause: string) => ({
      status: "failed",
      event: {
        actor: "system",
        reasonCode: "other",
        reason: `verified at the provider; not completed within 14 days (${cause})`,
      },
    });
    expect(closing(tenant(1))).toMatchObject(verifiedThen("plan_refused"));
    expect(closing(tenant(2))).toMatchObject(verifiedThen("no_typed_names"));
    expect(closing(tenant(3))).toMatchObject(verifiedThen("screen_pending"));
    expect(closing(tenant(4))).toMatchObject({
      status: "failed",
      event: { reasonCode: "abandoned", reason: "no result within 14 days" },
    });
    expect(opsLines("identity_session_closed").map((l) => [l.sessionId, l.reasonCode])).toEqual([
      [refused.sessionId, "other"],
      [nameless.sessionId, "other"],
      [pending.sessionId, "other"],
      [waiting.sessionId, "abandoned"],
    ]);
  });

  test("an error on one session is counted and logged, never thrown, and the others are still swept", async () => {
    const broken = await started(deps(), tenant(1));
    const fine = await started(deps(), tenant(2));
    provider.verify(fine.ref);
    provider.failNext.retrieve.push(
      new StripeUnavailable(503, "Stripe Identity retrieve: HTTP 503"),
    );
    now = T0 + 10 * MINUTE;

    expect(await sweepSessions(deps(), now)).toEqual({ ...zero, synced: 1, errors: 1 });
    expect(broken.session().closedAt).toBeNull();
    expect(fine.session().closedAt).toBe(now);
    expect(opsLines("identity_sessions_sweep_error")).toMatchObject([
      { sessionId: broken.sessionId, step: "sync" },
    ]);
  });
});
