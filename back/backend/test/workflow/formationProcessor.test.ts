/**
 * Fetch-and-advance (design §5, audit H2/M5).
 *
 * The first test is the important one and the rest support it: the webhook payload LIES — it
 * carries an EIN, a filing number and a filing date that doola's API does not — and every fact
 * that reaches the database comes from the API instead. That is what "a webhook is a wake-up
 * signal, never a source of facts" means operationally, and it is why a leaked webhook secret
 * cannot forge a legal fact.
 */
import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { DOOLA_SIGNATURE_HEADER, type DoolaWakeUp } from "../../src/api/routes/doolaWebhook";
import { companyNameOptions } from "../../src/formation/intake";
import {
  companyFiled,
  deriveFormationStatus,
  documentsFetched,
  einIssued,
  providerRefOf,
} from "../../src/formation/status";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import { TaskTracker } from "../../src/util/taskTracker";
import {
  type FormationEventDeps,
  UNMAPPED_EVENT_GRACE_MS,
  advanceFormation,
  currentPolledStep,
  eventSuggestsRequiredActions,
  filingDateToUnix,
  isFormationFailed,
  isFormationFiled,
  isKnownDoolaEvent,
  matchFiledNameAgainst,
  processDoolaEvent,
} from "../../src/workflow/formationProcessor";
import {
  COMPANY_ID,
  COMPANY_KEY,
  CUSTOMER_ID,
  ENTITY_KEY,
  type FakeDoola,
  MemoryDocumentStore,
  doolaDoc,
  fakeDoola,
  formedEntity,
  listItem,
  seedCompany,
} from "../helpers/formationFakes";

const SECRET = "whsec_current";
const NOW = Date.parse("2026-08-21T12:00:00Z");

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let events: SqliteDoolaEventRepository;
let docStore: MemoryDocumentStore;
let doola: FakeDoola;

function deps(over: Partial<FormationEventDeps> = {}): FormationEventDeps {
  return {
    repo,
    companies,
    requests,
    documents,
    docStore,
    events,
    doola: doola.api,
    environment: "sandbox",
    fetchImpl: doola.fetchImpl,
    lookupImpl: doola.lookupImpl,
    now: () => NOW,
    ...over,
  };
}

/** Seed a pinned entity whose `create_provider` has confirmed — part A's handoff state. */
function seedFormation(over: Parameters<typeof formedEntity>[0] = {}) {
  seedCompany(companies);
  repo.upsert(formedEntity(over));
  requests.claimAllSteps(COMPANY_KEY);
  requests.transition(COMPANY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
    detail: JSON.stringify({ companyId: COMPANY_ID }),
  });
}

const stateOf = (step: string) =>
  requests.stepsOf(COMPANY_KEY).find((s) => s.step === step)?.state ?? "(missing)";
const entity = () => repo.findByIdempotencyKey(ENTITY_KEY);
/** The legal facts live on the COMPANY since 2026-08-26 §3 — one filing, however many agents. */
const company = () => companies.find(COMPANY_KEY);
const detailOf = (step: string) =>
  JSON.parse(requests.stepsOf(COMPANY_KEY).find((s) => s.step === step)?.detail ?? "{}");

const wake = (over: Partial<DoolaWakeUp> = {}): DoolaWakeUp => ({
  eventId: "evt-1",
  eventName: "company_formation_completed",
  providerRef: COMPANY_ID,
  ...over,
});

/**
 * Pin an event's `received_at` to the INJECTED clock. SQLite stamps it from the real wall clock,
 * and an unmapped event is kept only inside `UNMAPPED_EVENT_GRACE_MS` of it measured against
 * `NOW`, so a test that expects one kept must say how old it is rather than inherit the gap
 * between today and `NOW`.
 */
function pinReceivedAt(eventId: string, at: number): void {
  db.prepare("UPDATE doola_webhook_events SET received_at = ? WHERE event_id = ?").run(
    sqliteUtcTimestamp(at),
    eventId,
  );
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  events = new SqliteDoolaEventRepository(db);
  docStore = new MemoryDocumentStore();
  doola = fakeDoola();
});
afterEach(() => db.close());

// ── §3: the FACTS clock moves only on a fact ───────────────────────────────────────────────

test("a filing CONFIRMATION moves facts_updated_at; the next poll of that row does not", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
  };
  const OLD = "2026-01-01 00:00:00";
  const factsOf = (step: string) =>
    requests.stepsOf(COMPANY_KEY).find((s) => s.step === step)!.factsUpdatedAt;
  // Both timestamps are CURRENT_TIMESTAMP at one-second resolution, so "unchanged" is only a
  // real assertion against a value the clock cannot reproduce.
  db.prepare("UPDATE formation_requests SET facts_updated_at = ? WHERE company_id = ?").run(
    OLD,
    COMPANY_KEY,
  );

  // The filing lands: a real fact, and the anchor gate must see it.
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  const afterConfirm = factsOf("await_filing");
  expect(afterConfirm).not.toBe(OLD);

  // The next pass over the SAME confirmed row refreshes its required-actions detail and nothing
  // else. It runs on every tick; moving the fact clock here is what made a formed entity
  // re-derive and re-hash its manifest for the whole four-to-six-week EIN wait.
  db.prepare("UPDATE formation_requests SET facts_updated_at = ? WHERE company_id = ?").run(
    OLD,
    COMPANY_KEY,
  );
  doola.state.requiredActions = [
    { requiredActionId: "ra-1", actionCode: "NAME_UNAVAILABLE", status: "open" },
  ];
  await advanceFormation(deps(), COMPANY_KEY, { requiredActions: true });
  expect(detailOf("await_filing").requiredActions).toHaveLength(1);
  expect(factsOf("await_filing")).toBe(OLD);
});

test("a HEAL on a confirmed row DOES move the fact clock — the amendment survives a crash", async () => {
  // `healFilingFacts` writes real legal facts onto the COMPANY row on a pass over an ALREADY
  // confirmed step, and those facts are what the next manifest version commits to. It used to
  // rely entirely on the in-process anchor fan-out to notice: a crash between the heal write and
  // the fan-out left the amendment unopened, and nothing would ever open it, because the anchor
  // gate reads `facts_updated_at` and the heal had not moved it.
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationFilingDate: "2026-08-19" };
  const OLD = "2026-01-01 00:00:00";
  const factsOf = () =>
    requests.stepsOf(COMPANY_KEY).find((s) => s.step === "await_filing")!.factsUpdatedAt;

  // Confirm the filing WITHOUT a filing number — the shape the heal exists for.
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.filingNumber).toBeNull();
  db.prepare("UPDATE formation_requests SET facts_updated_at = ? WHERE company_id = ?").run(
    OLD,
    COMPANY_KEY,
  );

  // doola learns the number. The step does not move; the FACTS do.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-HEALED-1",
  };
  expect(await advanceFormation(deps(), COMPANY_KEY)).toMatchObject({ advanced: true });
  expect(company()?.filingNumber).toBe("WY-HEALED-1");
  expect(factsOf()).not.toBe(OLD);

  // …and the very next pass, which heals nothing, leaves the clock exactly where it is.
  db.prepare("UPDATE formation_requests SET facts_updated_at = ? WHERE company_id = ?").run(
    OLD,
    COMPANY_KEY,
  );
  expect(await advanceFormation(deps(), COMPANY_KEY)).toMatchObject({ advanced: false });
  expect(factsOf()).toBe(OLD);
});

// ── the wake-up-only rule, proven end to end ───────────────────────────────────────────────

test("the payload LIES and every fact still comes from the API (audit H2)", async () => {
  seedFormation();
  // What doola's API actually says.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationSubmissionStatus: "SUBMITTED",
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-REAL-0001",
    ein: "88-1111111",
    services: [{ name: "Formation", status: "Completed" }],
  };

  const d = deps();
  const tasks = new TaskTracker("doola_webhook_task");
  const app = buildApiApp({
    webOrigin: "https://app.example.com",
    repo,
    now: () => NOW,
    doola: {
      environment: "sandbox",
      webhookSecret: SECRET,
      events,
      tasks,
      process: (w: DoolaWakeUp) => processDoolaEvent(d, w),
    },
  } as never);

  // …and what the WIRE claims. Every one of these is a legal fact, and every one is different.
  const body = JSON.stringify({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    timestamp: NOW - 1000,
    eventPayload: {
      doolaCompanyId: COMPANY_ID,
      ein: "99-9999999",
      formationFilingNumber: "WY-FORGED-6666",
      formationFilingDate: "1999-01-01",
      services: [{ name: "Formation", status: "Completed" }],
    },
  });
  const res = await app.request("/webhooks/doola/sandbox", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DOOLA_SIGNATURE_HEADER]: createHmac("sha256", SECRET).update(body).digest("hex"),
    },
    body,
  });
  expect(res.status).toBe(200);
  await tasks.settled();

  const e = company();
  expect(e?.filingNumber).toBe("WY-REAL-0001");
  expect(e?.ein).toBe("88-1111111");
  expect(e?.filedAt).toBe(filingDateToUnix("2026-08-19"));
  // Not one of the forged values reached the database.
  expect(JSON.stringify(e)).not.toContain("99-9999999");
  expect(JSON.stringify(e)).not.toContain("WY-FORGED-6666");
  // The wake-up cost exactly one authoritative read of each kind.
  expect(doola.calls.filter((c) => c.startsWith("getCompany"))).toHaveLength(1);
});

// ── advancing each step ────────────────────────────────────────────────────────────────────

test("await_filing confirms on the filing date and writes the two legal facts onto the company", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-2026-1234",
  };
  const out = await advanceFormation(deps(), COMPANY_KEY);
  expect(out).toMatchObject({ fetched: true, advanced: true });
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()).toMatchObject({
    filedAt: Date.parse("2026-08-19T00:00:00Z") / 1000,
    filingNumber: "WY-2026-1234",
  });
  // The on-chain-frozen placeholder is untouched: overwriting it would make the row disagree
  // with the chain.
  expect(entity()?.ein).toBe("STUB-NOT-FILED");
  // The audit trail records the filing.
  expect(repo.listEvents(ENTITY_KEY).map((e) => e.step)).toContain("formationFiled");
});

test("a Completed formation SERVICE also confirms the filing", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Completed" }],
  };
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  // No filing date to parse — the fact we do not have is not invented.
  expect(company()?.filedAt).toBeNull();
});

test("nothing filed yet: the step stays where it is and no legal fact is written", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, formationSubmissionStatus: "PENDING" };
  const out = await advanceFormation(deps(), COMPANY_KEY);
  expect(out).toMatchObject({ fetched: true, advanced: false });
  expect(stateOf("await_filing")).toBe("pending");
  expect(company()?.filedAt).toBeFalsy();
  // The intake status is still recorded, so an operator can see what doola thinks.
  expect(detailOf("await_filing").submissionStatus).toBe("PENDING");
});

test("documents are stored, hashed, and fetch_documents confirms only when BOTH required types are in", async () => {
  seedFormation();
  doola.state.documents = [doolaDoc("d-aoo", "ArticlesOfOrganization")];
  await advanceFormation(deps(), COMPANY_KEY);

  // One of two: stored, but the step cannot confirm.
  expect(documents.listByCompany(COMPANY_KEY)).toHaveLength(1);
  expect(stateOf("fetch_documents")).toBe("pending");
  expect(detailOf("fetch_documents").missing).toEqual(["OperatingAgreement"]);

  const stored = documents.listByCompany(COMPANY_KEY)[0]!;
  const bytes = docStore.getBytes(stored.path);
  const { createHash } = await import("node:crypto");
  // The indexed hash is the hash of the bytes on disk — the property PR 3 anchors on-chain.
  expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(stored.size).toBe(bytes.length);
  expect(stored.contentType).toBe("application/pdf");

  doola.state.documents.push(doolaDoc("d-oa", "OperatingAgreement"));
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("fetch_documents")).toBe("confirmed");
  expect(documents.storedTypes(COMPANY_KEY).sort()).toEqual([
    "ArticlesOfOrganization",
    "OperatingAgreement",
  ]);
});

test("an already-stored document is never re-downloaded", async () => {
  seedFormation();
  doola.state.documents = [doolaDoc("d-aoo", "ArticlesOfOrganization")];
  await advanceFormation(deps(), COMPANY_KEY);
  const first = doola.calls.filter((c) => c.startsWith("getDocumentDownloadUrl")).length;
  expect(first).toBe(1);

  await advanceFormation(deps(), COMPANY_KEY);
  expect(doola.calls.filter((c) => c.startsWith("getDocumentDownloadUrl"))).toHaveLength(first);
});

test("one unreadable document does not stop the others from being stored", async () => {
  seedFormation();
  doola.state.documents = [
    doolaDoc("d-broken", "EinLetter"),
    doolaDoc("d-aoo", "ArticlesOfOrganization"),
  ];
  doola.state.failNext = { getDocumentDownloadUrl: true };
  await advanceFormation(deps(), COMPANY_KEY);
  // The Articles of Organization are far too important to be blocked by a bad EIN letter.
  expect(documents.storedTypes(COMPANY_KEY)).toEqual(["ArticlesOfOrganization"]);
  // The step is not failed — a document that did not arrive is a reason to poll again.
  expect(stateOf("fetch_documents")).toBe("pending");
});

test("await_ein confirms on the EIN and writes it on the COMPANY, never on entities.ein", async () => {
  seedFormation();
  doola.state.company = { doolaCompanyId: COMPANY_ID, ein: "12-3456789" };
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_ein")).toBe("confirmed");
  expect(company()?.ein).toBe("12-3456789");
  expect(entity()?.ein).toBe("STUB-NOT-FILED");
  // The EIN is a tax identifier: the audit event records THAT one was issued, not what it is.
  const ev = repo.listEvents(ENTITY_KEY).find((e) => e.step === "formationEin");
  expect(ev?.detail).not.toContain("12-3456789");
});

// ── failure ────────────────────────────────────────────────────────────────────────────────

test("a FAILED formation parks every step that has not already succeeded", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Failed" }],
  };
  const out = await advanceFormation(deps(), COMPANY_KEY);
  expect(out).toMatchObject({ fetched: true, advanced: true });
  for (const step of ["await_filing", "fetch_documents", "await_ein"])
    expect(stateOf(step), step).toBe("failed");
  // `create_provider` succeeded — a company WAS created — and a later failure does not unmake it.
  expect(stateOf("create_provider")).toBe("confirmed");
  // Attempts were burned, which is what walks the sweeper toward the abandon verdict.
  expect(requests.find(COMPANY_KEY, "await_filing")?.attempt).toBe(1);
});

test("FAILED never overrules a step that already confirmed", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
  };
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");

  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationSubmissionStatus: "FAILED",
  };
  await advanceFormation(deps(), COMPANY_KEY);
  // Wyoming filed it. Nothing doola says later un-files it.
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(stateOf("await_ein")).toBe("failed");
});

test("C3: a doola read failure records itself and backs off — it does NOT burn an attempt", async () => {
  // A GET that 502s is not a formation going badly. Nothing was attempted, nothing committed,
  // and nothing about the entity changed. Parking it `failed` (and burning an attempt) meant
  // eight bad minutes at doola could `abandon` a company Wyoming had already filed — and
  // `abandoned` is what erases the responsible party's personal data.
  seedFormation();
  const before = requests.find(COMPANY_KEY, "await_filing")!;
  doola.state.failNext = { getCompany: true };
  const out = await advanceFormation(deps(), COMPANY_KEY);
  expect(out).toMatchObject({ fetched: false, advanced: false });

  const after = requests.find(COMPANY_KEY, "await_filing")!;
  // The state is unchanged, so no tenant surface renders this as a failed formation…
  expect(after.state).toBe(before.state);
  expect(after.attempt).toBe(before.attempt);
  // …but the reason is on the row, and the next read is scheduled rather than immediate.
  expect(after.error).toMatch(/doola read failed/);
  expect(after.nextPollAt).toBeGreaterThan(0);
  // The steps behind it are untouched — one outage is one event, not three.
  expect(stateOf("fetch_documents")).toBe("pending");
  expect(stateOf("await_ein")).toBe("pending");
});

test("C3: one 502 then a healthy read — the status never shows `failed`, and the row un-parks", async () => {
  seedFormation();
  // Whatever put the row in `failed` (an older build, a doola-reported failure since resolved),
  // a successful read proves the reason no longer holds.
  requests.transition(COMPANY_KEY, "await_filing", "pending", "failed", { error: "boom" });

  doola.state.failNext = { getCompany: true };
  await advanceFormation(deps(), COMPANY_KEY);
  // The transient failure did not burn an attempt on the way through.
  expect(requests.find(COMPANY_KEY, "await_filing")?.attempt).toBe(0);

  await advanceFormation(deps(), COMPANY_KEY);
  const row = requests.find(COMPANY_KEY, "await_filing")!;
  expect(row.state).toBe("pending");
  expect(row.error).toBeNull();
  expect(deriveFormationStatus(requests.stepsOf(COMPANY_KEY))).toBe("in_progress");
});

// ── the guards ─────────────────────────────────────────────────────────────────────────────

test("a COMPANY pinned to another environment is refused WITHOUT a provider call (audit M5)", async () => {
  seedFormation();
  // The pin that decides is the COMPANY's since the re-key: it owns the filing, and no entity
  // need exist at all when the first poll runs.
  db.prepare("UPDATE companies SET environment = 'production' WHERE company_id = ?").run(
    COMPANY_KEY,
  );
  const out = await advanceFormation(deps(), COMPANY_KEY);
  expect(out).toMatchObject({ fetched: false, skipped: "environment_pin" });
  // Nothing was called. A config flip cannot route a pinned company at the other host.
  expect(doola.calls).toHaveLength(0);
  // And nothing was failed: this is our misconfiguration, not the entity's problem.
  expect(stateOf("await_filing")).toBe("pending");
});

test("a company with no doola id yet is skipped — create_provider is the sweeper's job", async () => {
  seedCompany(companies);
  repo.upsert(formedEntity());
  requests.claimAllSteps(COMPANY_KEY);
  const out = await advanceFormation(deps(), COMPANY_KEY);
  expect(out).toMatchObject({ fetched: false, skipped: "no_provider_ref" });
  expect(doola.calls).toHaveLength(0);
});

// ── idempotence + concurrency ──────────────────────────────────────────────────────────────

test("re-processing an already-processed event changes nothing (every transition is a CAS)", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
    ein: "12-3456789",
  };
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: COMPANY_ID,
    payload: "{}",
  });

  await processDoolaEvent(deps(), wake());
  const after = company();
  const filedEvents = () => repo.listEvents(ENTITY_KEY).filter((e) => e.step === "formationFiled");
  expect(filedEvents()).toHaveLength(1);

  await processDoolaEvent(deps(), wake());
  await processDoolaEvent(deps(), wake());
  expect(company()).toEqual(after);
  // The audit trail did not grow: the CAS lost, so the write inside it never ran.
  expect(filedEvents()).toHaveLength(1);
});

test("a webhook task and a sweeper tick racing one entity advance it EXACTLY once", async () => {
  seedFormation();
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "WY-1",
  };
  // Both drivers, started together, with the keyed lock bypassed on one of them: correctness is
  // DB-level (audit M13/20), and this is the assertion that says so.
  const [a, b] = await Promise.all([
    processDoolaEvent(deps(), wake()).then(() => "event"),
    advanceFormation(deps(), COMPANY_KEY).then((o) => o.advanced),
  ]);
  expect(a).toBe("event");
  expect(typeof b).toBe("boolean");
  expect(stateOf("await_filing")).toBe("confirmed");
  // Exactly one of the two won the compare-and-set, so exactly one audit event exists.
  expect(repo.listEvents(ENTITY_KEY).filter((e) => e.step === "formationFiled")).toHaveLength(1);
});

// ── the event routing rules ────────────────────────────────────────────────────────────────

test("an event whose company id maps to nothing stays UNPROCESSED for the sweeper", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: "cmp-unknown",
    payload: "{}",
  });
  // A minute old: inside the grace, where the create/webhook race is still possible.
  pinReceivedAt("evt-1", NOW - 60_000);
  await processDoolaEvent(deps(), wake({ providerRef: "cmp-unknown" }));
  expect(events.find("evt-1")?.processedAt).toBeNull();
  expect(doola.calls).toHaveLength(0);
});

test("an event with NO company id stays unprocessed too", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "company_ein_issued",
    providerRef: null,
    payload: "{}",
  });
  // A minute old: inside the grace, the operator's window to see the warning.
  pinReceivedAt("evt-1", NOW - 60_000);
  await processDoolaEvent(deps(), wake({ providerRef: null, eventName: "company_ein_issued" }));
  expect(events.find("evt-1")?.processedAt).toBeNull();
});

/** Run `fn`, returning the ops lines it wrote, parsed. */
async function opsLinesOf(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.map((l) => JSON.parse(l));
}

test("a WEBHOOK-source event past the grace answers retired, with exactly one line", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: "cmp-unknown",
    payload: "{}",
  });
  pinReceivedAt("evt-1", NOW - UNMAPPED_EVENT_GRACE_MS - 1000);

  let result: Awaited<ReturnType<typeof processDoolaEvent>> | undefined;
  const lines = await opsLinesOf(async () => {
    result = await processDoolaEvent(deps(), wake({ providerRef: "cmp-unknown" }));
  });

  expect(result).toMatchObject({ fetched: false, skipped: "unmapped", retired: true });
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
  const retired = lines.filter((l) => l.opslog === "doola_webhook_unmapped_retired");
  expect(retired).toHaveLength(1);
  expect(retired[0]).toMatchObject({ source: "webhook", eventId: "evt-1" });
  expect(lines.filter((l) => l.opslog === "doola_webhook_unmapped")).toHaveLength(0);
  expect(doola.calls).toHaveLength(0);
});

test("a ledger row it cannot find falls back to the warning, and retires nothing", async () => {
  // `find` answers undefined (the row was swept, or never written): there is no receipt time to
  // judge, so the event is treated as inside the grace, exactly as before the rule existed.
  const marked: string[] = [];
  const blind = {
    ...events,
    find: () => undefined,
    markProcessed: (id: string) => {
      marked.push(id);
      return true;
    },
  } as unknown as SqliteDoolaEventRepository;

  let result: Awaited<ReturnType<typeof processDoolaEvent>> | undefined;
  const lines = await opsLinesOf(async () => {
    result = await processDoolaEvent(deps({ events: blind }), wake({ providerRef: "cmp-unknown" }));
  });

  expect(result).toMatchObject({ fetched: false, skipped: "unmapped" });
  expect(result?.retired).toBeUndefined();
  expect(marked).toEqual([]);
  expect(lines.filter((l) => l.opslog === "doola_webhook_unmapped")).toHaveLength(1);
  expect(lines.filter((l) => l.opslog === "doola_webhook_unmapped_retired")).toHaveLength(0);
});

test("when another caller already won the mark, it answers retired and writes no second line", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_completed",
    providerRef: "cmp-unknown",
    payload: "{}",
  });
  pinReceivedAt("evt-1", NOW - UNMAPPED_EVENT_GRACE_MS - 1000);
  // The sweeper's re-drive (or the webhook's task) got there first: its compare-and-set won.
  expect(events.markProcessed("evt-1")).toBe(true);

  let result: Awaited<ReturnType<typeof processDoolaEvent>> | undefined;
  const lines = await opsLinesOf(async () => {
    result = await processDoolaEvent(deps(), wake({ providerRef: "cmp-unknown" }));
  });

  // Past the grace either way, so it is done, and it is not warned about again either.
  expect(result).toMatchObject({ skipped: "unmapped", retired: true });
  expect(lines.filter((l) => String(l.opslog).startsWith("doola_webhook_unmapped"))).toHaveLength(
    0,
  );
});

test("an UNKNOWN event name is left for the sweeper rather than acted on blind", async () => {
  seedFormation();
  events.record({
    eventId: "evt-1",
    eventName: "company_teleported",
    providerRef: COMPANY_ID,
    payload: "{}",
  });
  await processDoolaEvent(deps(), wake({ eventName: "company_teleported" }));
  expect(events.find("evt-1")?.processedAt).toBeNull();
  expect(doola.calls).toHaveLength(0);
});

test("partner_webhook_disabled is CRITICAL, companyless, and retires itself", async () => {
  events.record({
    eventId: "evt-1",
    eventName: "partner_webhook_disabled",
    providerRef: null,
    payload: "{}",
  });
  const lines: string[] = [];
  const orig = console.log;
  console.log = (l: string) => lines.push(l);
  try {
    await processDoolaEvent(
      deps(),
      wake({ eventName: "partner_webhook_disabled", providerRef: null }),
    );
  } finally {
    console.log = orig;
  }
  const critical = lines
    .map((l) => JSON.parse(l))
    .find((l) => l.opslog === "doola_webhook_disabled");
  expect(critical).toMatchObject({ severity: "CRITICAL" });
  // Nothing to re-drive: there is no company, and the recovery is a human in the portal.
  expect(events.find("evt-1")?.processedAt).not.toBeNull();
});

test("a required-actions-shaped event also reads required-actions, and stores codes only", async () => {
  seedFormation();
  doola.state.requiredActions = [
    {
      requiredActionId: "ra-1",
      actionCode: "FORMATION_NAME_OPTIONS_EXHAUSTED",
      status: "OPEN",
      open: true,
      // doola prose that could name a person: never stored, never served.
      reason: "All name options for Ada Lovelace were rejected",
    },
  ];
  events.record({
    eventId: "evt-1",
    eventName: "company_formation_required_action",
    providerRef: COMPANY_ID,
    payload: "{}",
  });
  // Unknown NAME, so the webhook path leaves it — the sweeper drives it. Drive the advance
  // directly with the flag the sweeper sets.
  await advanceFormation(deps(), COMPANY_KEY, { requiredActions: true });
  expect(detailOf("await_filing").requiredActions).toEqual([
    { id: "ra-1", code: "FORMATION_NAME_OPTIONS_EXHAUSTED", status: "OPEN" },
  ]);
  expect(JSON.stringify(detailOf("await_filing"))).not.toContain("Ada Lovelace");
});

// ── the pure helpers ───────────────────────────────────────────────────────────────────────

test("event-name classification", () => {
  for (const n of [
    "company_formation_completed",
    "company_formation_failed",
    "company_ein_issued",
    "partner_webhook_disabled",
    "document_aoo_uploaded",
    "document_operatingagreement_uploaded",
    // The signed SS-4 arrives as a DOCUMENT event, not a signature_* one (fact-checked).
    "document_ss4_uploaded",
  ])
    expect(isKnownDoolaEvent(n), n).toBe(true);
  for (const n of ["company_teleported", "signature_ss4_completed", ""])
    expect(isKnownDoolaEvent(n), n).toBe(false);

  expect(eventSuggestsRequiredActions("company_formation_required_action")).toBe(true);
  expect(eventSuggestsRequiredActions("signature_ss4_reset")).toBe(true);
  expect(eventSuggestsRequiredActions("company_ein_issued")).toBe(false);
});

test("reading doola's company state", () => {
  expect(isFormationFiled({ doolaCompanyId: "c", formationFilingDate: "2026-01-01" })).toBe(true);
  expect(
    isFormationFiled({
      doolaCompanyId: "c",
      services: [{ name: "Formation", status: "Completed" }],
    }),
  ).toBe(true);
  expect(isFormationFiled({ doolaCompanyId: "c", formationSubmissionStatus: "SUBMITTED" })).toBe(
    false,
  );
  expect(
    isFormationFailed({ doolaCompanyId: "c", services: [{ name: "Formation", status: "Failed" }] }),
  ).toBe(true);
  expect(isFormationFailed({ doolaCompanyId: "c", formationSubmissionStatus: "FAILED" })).toBe(
    true,
  );
  expect(isFormationFailed({ doolaCompanyId: "c", formationSubmissionStatus: "PENDING" })).toBe(
    false,
  );

  expect(filingDateToUnix("2026-08-19")).toBe(Date.parse("2026-08-19T00:00:00Z") / 1000);
  for (const bad of [null, undefined, "", "19/08/2026", "2026-08"])
    expect(filingDateToUnix(bad)).toBeNull();
});

test("currentPolledStep names the step an entity is actually waiting on", () => {
  seedFormation();
  expect(currentPolledStep(requests.stepsOf(COMPANY_KEY))).toBe("await_filing");
  requests.transition(COMPANY_KEY, "await_filing", "pending", "confirmed");
  expect(currentPolledStep(requests.stepsOf(COMPANY_KEY))).toBe("fetch_documents");
  requests.transition(COMPANY_KEY, "fetch_documents", "pending", "confirmed");
  expect(currentPolledStep(requests.stepsOf(COMPANY_KEY))).toBe("await_ein");
  requests.transition(COMPANY_KEY, "await_ein", "pending", "confirmed");
  expect(currentPolledStep(requests.stepsOf(COMPANY_KEY))).toBeUndefined();
});

// ── F11 / F12: the shared fact predicates, and the filing-number heal ──────────────────────

test("F11: the fact predicates are the ones every surface shares", () => {
  seedFormation();
  const steps = () => requests.stepsOf(COMPANY_KEY);
  expect(providerRefOf(steps())).toBe(COMPANY_ID);
  expect(companyFiled(steps())).toBe(false);
  expect(documentsFetched(steps())).toBe(false);
  expect(einIssued(steps())).toBe(false);

  requests.transition(COMPANY_KEY, "await_filing", "pending", "confirmed");
  expect(companyFiled(steps())).toBe(true);
  // …and the DERIVED status is built out of the same three, so a surface and the anchor trigger
  // can never disagree about what "filed" means.
  expect(deriveFormationStatus(steps())).toBe("filed");

  requests.transition(COMPANY_KEY, "fetch_documents", "pending", "confirmed");
  expect(documentsFetched(steps())).toBe(true);
  requests.transition(COMPANY_KEY, "await_ein", "pending", "confirmed");
  expect(einIssued(steps())).toBe(true);
  expect(deriveFormationStatus(steps())).toBe("complete");
});

test("F12: a filing confirmed WITHOUT a number gains it on a later poll", async () => {
  seedFormation();
  // doola reports the formation service completed, but the state has not assigned a number yet.
  // The step confirms on that signal alone — and the legal facts are written only inside the
  // CAS that confirms it, so the number used to have no way in, ever.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Completed" }],
  };
  expect(await advanceFormation(deps(), COMPANY_KEY)).toMatchObject({ advanced: true });
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.filingNumber).toBeNull();
  expect(company()?.filedAt).toBeNull();

  // The state assigns one. The next poll takes the confirmed→confirmed branch, which used to
  // refresh the `detail` blob and touch nothing else.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Completed" }],
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "2026-001234567",
  };
  const healed = await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.filingNumber).toBe("2026-001234567");
  expect(company()?.filedAt).toBe(Math.floor(Date.parse("2026-08-19T00:00:00Z") / 1000));
  // It is an ADVANCE: it is precisely the fact the anchor sub-saga is blocked on, so it must
  // reset the poll cadence and wake the fast path rather than wait for the next tick.
  expect(healed.advanced).toBe(true);

  // And it never downgrades: a poll that happens not to return the number leaves it alone.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    services: [{ name: "Formation", status: "Completed" }],
  };
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.filingNumber).toBe("2026-001234567");
});

// ── the filed name, from doola's list: the full legal name for a legal-body company, none for an
//    agent company ──

/** A company for `purposeKind` with the name options given, its `create_provider` confirmed and no
 *  agent attached (a legal-body company never takes one). */
function seedCompanyFiling(
  purposeKind: "agent" | "legal_body",
  nameOptions = companyNameOptions("Formation Agent LLC", "Formation Agent Two LLC"),
) {
  seedCompany(companies, { purposeKind, nameOptions });
  requests.claimAllSteps(COMPANY_KEY);
  requests.transition(COMPANY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
    detail: JSON.stringify({ companyId: COMPANY_ID }),
  });
}

/** doola filing the company, its LIST item naming it `name` (an item with no name when
 *  undefined). The full answer carries no name, as doola's carries none. */
const filedAs = (name: string | undefined) => {
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    doolaCustomerId: CUSTOMER_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "2026-001234567",
  };
  doola.state.listed = [listItem(name)];
};

test("a legal-body company's filed name is its candidate followed by the entity ending: its full legal name", async () => {
  seedCompanyFiling("legal_body");
  // The second option is the one the state accepted, reported in another case and spacing.
  filedAs("  formation agent two ");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.legalNameFiled).toBe("Formation Agent Two LLC");
});

test("an agent company records no name, and listCompanies is never called for it", async () => {
  seedCompanyFiling("agent");
  // doola lists the company under its first option: an agent company never reads the list, so its
  // published manifests are not re-hashed (design 2026-11-11 §1).
  filedAs("Formation Agent LLC");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.legalNameFiled).toBeNull();
  // The next pass, the heal's, reads no name either.
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBeNull();
  expect(doola.calls.filter((c) => c.startsWith("listCompanies"))).toEqual([]);
});

test("a candidate that already ends in an entity ending keeps it once, never twice", async () => {
  // The intake strips ONE trailing ending: "Formation Agent LLC LLC" is stored as
  // "Formation Agent LLC", the only way a stored candidate ends in one.
  const options = companyNameOptions("Formation Agent LLC LLC", "Other Name");
  expect(options[0]?.name).toBe("Formation Agent LLC");
  seedCompanyFiling("legal_body", options);
  filedAs("Formation Agent LLC");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBe("Formation Agent LLC");
});

test("a legal-body company's name healed after the confirmation takes the same full form", async () => {
  seedCompanyFiling("legal_body");
  // Confirmed before doola reports any name: no name is written.
  filedAs(undefined);
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.legalNameFiled).toBeNull();

  filedAs("Formation Agent");
  expect(await advanceFormation(deps(), COMPANY_KEY)).toMatchObject({ advanced: true });
  expect(company()?.legalNameFiled).toBe("Formation Agent LLC");
});

test("a reported name that matches no candidate writes no name, whatever the company is for", async () => {
  seedCompanyFiling("legal_body");
  filedAs("Formation Agent Holdings");
  const lines = await opsLinesOf(() => advanceFormation(deps(), COMPANY_KEY));
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.legalNameFiled).toBeNull();
  // A name that is there and matches nothing is the unmatched warning, not the missing one.
  expect(lines.filter((l) => l.opslog === "formation_filed_name_unmatched")).toHaveLength(1);
  expect(lines.filter((l) => l.opslog === "formation_filed_name_missing")).toEqual([]);
});

test("a legal-body company's held name is never rewritten by a later poll: an operator's correction from the State's record stands", async () => {
  seedCompanyFiling("legal_body");
  filedAs("Formation Agent");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBe("Formation Agent LLC");

  // The operator's correction, as `company:filed-name --replace` writes it.
  expect(companies.recordFilingFacts(COMPANY_KEY, { legalNameFiled: "Formation Agent, LLC" })).toBe(
    true,
  );
  // A later poll matches a stored option again, and learns a new filing number: the number heals,
  // the name stays the operator's.
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    doolaCustomerId: CUSTOMER_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "2026-007654321",
  };
  doola.state.listed = [listItem("Formation Agent")];
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.filingNumber).toBe("2026-007654321");
  expect(company()?.legalNameFiled).toBe("Formation Agent, LLC");
  // Nor does a poll that reports the other option.
  filedAs("Formation Agent Two");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBe("Formation Agent, LLC");
});

test("a legal-body company holding a name when its filing is confirmed keeps it", async () => {
  seedCompanyFiling("legal_body");
  // Set before the confirmation, as an operator's record of the filing may.
  companies.recordFilingFacts(COMPANY_KEY, { legalNameFiled: "Formation Agent Two, LLC" });
  filedAs("Formation Agent");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()?.filingNumber).toBe("2026-001234567");
  expect(company()?.legalNameFiled).toBe("Formation Agent Two, LLC");
});

test("an agent company's held name is left as it is: no name is read for it", async () => {
  seedCompanyFiling("agent");
  companies.recordFilingFacts(COMPANY_KEY, { legalNameFiled: "Formation Agent" });
  filedAs("Formation Agent Two LLC");
  await advanceFormation(deps(), COMPANY_KEY);
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBe("Formation Agent");
  expect(doola.calls.filter((c) => c.startsWith("listCompanies"))).toEqual([]);
});

// ── where the filed name is read: doola's list, for a filed legal-body company holding none ─────

/** What `formation_filed_name_missing` says, whatever its reason. */
const FILED_NAME_MISSING =
  "the company is filed and doola reports no name for it: legal_name_filed stays NULL and the company cannot be ordered until a name is found or an operator runs company:filed-name";

const listCalls = () => doola.calls.filter((c) => c.startsWith("listCompanies"));

test("the name is read from the list at the confirmation, under the customer doola's full answer names", async () => {
  seedCompanyFiling("legal_body");
  filedAs("Formation Agent LLC");
  const lines = await opsLinesOf(() => advanceFormation(deps(), COMPANY_KEY));
  expect(stateOf("await_filing")).toBe("confirmed");
  expect(company()).toMatchObject({
    legalNameFiled: "Formation Agent LLC",
    filingNumber: "2026-001234567",
    filedAt: filingDateToUnix("2026-08-19"),
  });
  expect(listCalls()).toEqual([`listCompanies:${CUSTOMER_ID}`]);
  expect(lines.filter((l) => l.opslog === "formation_filed_name_missing")).toEqual([]);
});

test("with no customer on doola's answer, the list is read under the customer the create recorded", async () => {
  seedCompanyFiling("legal_body");
  requests.transition(COMPANY_KEY, "create_provider", "confirmed", "confirmed", {
    detail: JSON.stringify({ companyId: COMPANY_ID, customerId: "cus-recorded" }),
  });
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    formationFilingDate: "2026-08-19",
    formationFilingNumber: "2026-001234567",
  };
  doola.state.listed = [listItem("Formation Agent", { doolaCustomerId: "cus-recorded" })];
  await advanceFormation(deps(), COMPANY_KEY);
  expect(listCalls()).toEqual(["listCompanies:cus-recorded"]);
  expect(company()?.legalNameFiled).toBe("Formation Agent LLC");
});

test("the list item is chosen by doola's company id, never by name, when the customer has two companies", async () => {
  seedCompanyFiling("legal_body");
  filedAs(undefined);
  // The same guardian formed another company first, and doola answered its email with the same
  // customer. That company's name is OUR first option; ours was filed under the second.
  doola.state.listed = [
    listItem("Formation Agent LLC", { doolaCompanyId: "cmp-other" }),
    listItem("Formation Agent Two LLC"),
  ];
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBe("Formation Agent Two LLC");
});

test("a list read that throws never holds up the confirmation, and the next pass heals the name", async () => {
  seedCompanyFiling("legal_body");
  filedAs("Formation Agent");
  doola.state.failNext = { listCompanies: true };
  const before = requests.find(COMPANY_KEY, "await_filing")!;

  const first = await opsLinesOf(() => advanceFormation(deps(), COMPANY_KEY));
  // Confirmed with its date and number: not parked, no attempt burned, no error recorded.
  const row = requests.find(COMPANY_KEY, "await_filing")!;
  expect(row).toMatchObject({ state: "confirmed", attempt: before.attempt, error: null });
  expect(company()).toMatchObject({
    legalNameFiled: null,
    filingNumber: "2026-001234567",
    filedAt: filingDateToUnix("2026-08-19"),
  });
  expect(first.filter((l) => l.opslog === "formation_filed_name_missing")).toEqual([
    expect.objectContaining({
      level: "warn",
      companyId: COMPANY_KEY,
      providerRef: COMPANY_ID,
      reason: "list_failed",
      error: "doola listCompanies is down",
      message: FILED_NAME_MISSING,
    }),
  ]);

  // The next poll: the list answers, and the heal stores the name, saying where it came from.
  const second = await opsLinesOf(() => advanceFormation(deps(), COMPANY_KEY));
  expect(company()?.legalNameFiled).toBe("Formation Agent LLC");
  expect(second.find((l) => l.opslog === "formation_filing_healed")).toMatchObject({
    companyId: COMPANY_KEY,
    legalNameFiled: "Formation Agent LLC",
    nameSource: "list",
  });
  expect(second.filter((l) => l.opslog === "formation_filed_name_missing")).toEqual([]);
});

describe("each way the list has no name logs one formation_filed_name_missing, and the filing still confirms", () => {
  test.each([
    [
      "no customer id on the answer or the create",
      "no_customer_id",
      () => {
        doola.state.company = {
          doolaCompanyId: COMPANY_ID,
          formationFilingDate: "2026-08-19",
          formationFilingNumber: "2026-001234567",
        };
      },
    ],
    [
      "the list read fails",
      "list_failed",
      () => {
        doola.state.failNext = { listCompanies: true };
      },
    ],
    [
      "the company is not in its customer's list",
      "not_in_list",
      () => {
        doola.state.listed = [listItem("Formation Agent", { doolaCompanyId: "cmp-other" })];
      },
    ],
    [
      "its item has no name",
      "no_name",
      () => {
        doola.state.listed = [listItem(undefined)];
      },
    ],
    [
      "its item's name is blank",
      "no_name",
      () => {
        doola.state.listed = [listItem("   ")];
      },
    ],
  ] as const)("%s: %s", async (_label, reason, setUp) => {
    seedCompanyFiling("legal_body");
    filedAs("Formation Agent");
    setUp();
    const lines = await opsLinesOf(() => advanceFormation(deps(), COMPANY_KEY));
    expect(stateOf("await_filing")).toBe("confirmed");
    expect(company()).toMatchObject({ legalNameFiled: null, filingNumber: "2026-001234567" });
    const missing = lines.filter((l) => l.opslog === "formation_filed_name_missing");
    expect(missing).toHaveLength(1);
    const { opslog: _event, at: _at, ...fields } = missing[0]!;
    // Ids, a reason and the sentence: no name, no person. A failed list adds doola's description.
    if (reason === "list_failed")
      expect(fields).toMatchObject({ reason, error: "doola listCompanies is down" });
    else
      expect(fields).toEqual({
        level: "warn",
        companyId: COMPANY_KEY,
        providerRef: COMPANY_ID,
        reason,
        message: FILED_NAME_MISSING,
      });
    if (reason === "no_customer_id") expect(listCalls()).toEqual([]);
  });
});

test("no list read before the State files: the list name is only our first choice then", async () => {
  seedCompanyFiling("legal_body");
  doola.state.company = {
    doolaCompanyId: COMPANY_ID,
    doolaCustomerId: CUSTOMER_ID,
    formationSubmissionStatus: "SUBMITTED",
  };
  doola.state.listed = [listItem("Formation Agent LLC")];
  await advanceFormation(deps(), COMPANY_KEY);
  expect(stateOf("await_filing")).toBe("pending");
  expect(listCalls()).toEqual([]);
  expect(company()?.legalNameFiled).toBeNull();
});

test("no list read once a name is held, and an operator's name is never rewritten", async () => {
  seedCompanyFiling("legal_body");
  filedAs("Formation Agent");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(company()?.legalNameFiled).toBe("Formation Agent LLC");
  expect(listCalls()).toHaveLength(1);

  // A later pass, then the operator's correction from the State's record, then another pass that
  // lists the other option: the list is never read again, and the operator's name stands.
  await advanceFormation(deps(), COMPANY_KEY);
  expect(companies.recordFilingFacts(COMPANY_KEY, { legalNameFiled: "Formation Agent, LLC" })).toBe(
    true,
  );
  filedAs("Formation Agent Two");
  await advanceFormation(deps(), COMPANY_KEY);
  expect(listCalls()).toHaveLength(1);
  expect(company()?.legalNameFiled).toBe("Formation Agent, LLC");
});

// ── matchFiledNameAgainst: the one rule a reported name is held to, wherever it is reported ─────

describe("matchFiledNameAgainst", () => {
  const options = companyNameOptions("Lantern Works LLC", "Lantern Works Two");

  test("names the stored option a reported name is, under normalizeCompanyName: any case, spacing at the ends or entity ending", () => {
    for (const reported of [
      "Lantern Works",
      "  lantern works ",
      "LANTERN WORKS LLC",
      "Lantern Works, L.L.C.",
      "Lantern Works Limited Liability Company",
    ])
      expect(matchFiledNameAgainst(options, reported), reported).toBe("Lantern Works");
    expect(matchFiledNameAgainst(options, "Lantern Works Two LLC")).toBe("Lantern Works Two");
  });

  test("answers the bare candidate as the intake stored it: the entity ending is the caller's to add", () => {
    // The processor adds it for a legal-body company; the matcher never does.
    expect(matchFiledNameAgainst(options, "Lantern Works LLC")).toBe(options[0]?.name);
    expect(options[0]?.name).toBe("Lantern Works");
  });

  test("null for a name that is none of the options, for a blank or absent name, and with no options", () => {
    for (const reported of [
      "Lantern Works Ltd. Liability Co.",
      "Lantern Workshop",
      "Lantern",
      "",
      "   ",
      null,
      undefined,
    ])
      expect(matchFiledNameAgainst(options, reported), String(reported)).toBeNull();
    expect(matchFiledNameAgainst([], "Lantern Works")).toBeNull();
  });

  test("pure: it reads no database and writes no ops line", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(matchFiledNameAgainst(options, "No Such Name")).toBeNull();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
