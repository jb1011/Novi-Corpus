/**
 * The sandbox auto-completion of a legal-body filing (F-A-2a, Task 13).
 *
 * doola's test environment never files with the State: a sandbox filing stays `SUBMITTED` until
 * somebody calls its playground. A local or testnet box gets no webhook either, and the next poll
 * of a row that was never polled is a day away. So on a sandbox deployment the sweeper calls the
 * playground for a legal-body company five minutes after its filing opened, then advances the
 * company at once: the filing, the documents and the filed name land in the same tick, read back
 * through the ordinary processor. Five minutes after the filing, the EIN follows the same way.
 *
 * Every test runs the real filing step (`runFormationCreateProvider`) against `fakeSandboxDoola`,
 * then pins the rows to the injected clock.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sqliteUtcTimestamp, syntheticFormationParty } from "../../src/formation";
import { withEntityEnding } from "../../src/formation/intake";
import { companyFiled, documentsFetched, einIssued } from "../../src/formation/status";
import { filingFacts } from "../../src/legalBody/filings";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository, parseDetail } from "../../src/persistence/formationRepository";
import { calendarDateOfUtcMidnight, wyomingDate } from "../../src/util/wyomingCalendar";
import { filingDateToUnix } from "../../src/workflow/formationProcessor";
import { runFormationCreateProvider } from "../../src/workflow/formationProvider";
import {
  FormationSweeper,
  type FormationSweeperDeps,
  SANDBOX_AUTOCOMPLETE_DELAY_MS,
} from "../../src/workflow/formationSweeper";
import {
  COMPANY_ID,
  COMPANY_KEY,
  type FakeDoola,
  MemoryDocumentStore,
  TENANT,
  fakeSandboxDoola,
  seedCompany,
} from "../helpers/formationFakes";

const MINUTE = 60_000;
/** The stand-in filing number of doola's company `cmp-1`: doola's sandbox files with none. */
const STAND_IN = "TEST-STANDIN-D36A9A6177333DB7";
let now = Date.parse("2026-08-21T12:00:00Z");

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let events: SqliteDoolaEventRepository;
let parties: SqliteFormationPartyRepository;
let docStore: MemoryDocumentStore;
let doola: FakeDoola;

function deps(over: Partial<FormationSweeperDeps> = {}): FormationSweeperDeps {
  return {
    repo,
    companies,
    requests,
    documents,
    parties,
    docStore,
    events,
    doola: doola.api,
    environment: "sandbox",
    fetchImpl: doola.fetchImpl,
    lookupImpl: doola.lookupImpl,
    intervalMs: 60_000,
    now: () => now,
    ...over,
  };
}

const sweeper = (over: Partial<FormationSweeperDeps> = {}) => new FormationSweeper(deps(over));

/** Pin every row to the INJECTED clock: SQLite stamps CURRENT_TIMESTAMP from the wall clock, and
 *  the five-minute delay is a comparison between the two. */
function stampRows(at: number) {
  db.prepare(
    "UPDATE formation_requests SET created_at = ?, updated_at = ?, facts_updated_at = ? WHERE company_id = ?",
  ).run(sqliteUtcTimestamp(at), sqliteUtcTimestamp(at), sqliteUtcTimestamp(at), COMPANY_KEY);
}

/** A ready company with a synthetic party, filed through the real filing step: `create_provider`
 *  confirmed with doola's company id, the three later steps pending. */
async function openFiling(over: Parameters<typeof seedCompany>[1] = { purposeKind: "legal_body" }) {
  seedCompany(companies, over);
  const partyId = parties.create({
    tenantId: TENANT,
    ...syntheticFormationParty("party-1"),
    synthetic: true,
  });
  parties.bindToCompany(partyId, COMPANY_KEY, TENANT);
  await runFormationCreateProvider({
    company: companies.find(COMPANY_KEY)!,
    companies,
    repo,
    requests,
    parties,
    doola: doola.api,
    environment: "sandbox",
  });
  expect(rowOf("create_provider")).toMatchObject({ state: "confirmed", providerRef: COMPANY_ID });
  stampRows(now);
}

const steps = () => requests.stepsOf(COMPANY_KEY);
const rowOf = (step: string) => steps().find((s) => s.step === step);
const marks = () =>
  parseDetail<{ autocompletedAt?: number; einAutocompletedAt?: number }>(
    rowOf("create_provider")?.detail ?? null,
  );
const callsOf = (method: string) => doola.calls.filter((c) => c.startsWith(`${method}:`));

/** The ops lines one tick writes, parsed. */
async function tickLogged(s: FormationSweeper): Promise<Record<string, unknown>[]> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await s.tick();
    return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  now = Date.parse("2026-08-21T12:00:00Z");
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  events = new SqliteDoolaEventRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  docStore = new MemoryDocumentStore();
  doola = fakeSandboxDoola({}, { now: () => now });
});
afterEach(() => db.close());

test("four minutes after the filing opened, the playground is not called", async () => {
  await openFiling();
  now += 4 * MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toEqual([]);
  expect(companyFiled(steps())).toBe(false);
});

test("six minutes after: one playground call, and the filing, documents and name land in the same tick", async () => {
  await openFiling();
  now += 6 * MINUTE;
  const lines = await tickLogged(sweeper());

  expect(callsOf("playgroundCompleteFormation")).toEqual([
    `playgroundCompleteFormation:${COMPANY_ID}`,
  ]);
  // Read back through the ordinary processor, in the same tick: no webhook, no day-long poll.
  expect(companyFiled(steps())).toBe(true);
  expect(documentsFetched(steps())).toBe(true);
  expect(rowOf("fetch_documents")?.state).toBe("confirmed");
  const company = companies.find(COMPANY_KEY)!;
  expect(company.legalNameFiled).toBe(withEntityEnding(company.nameOptions[0]!.name));
  expect(company.filingNumber).toBe(STAND_IN);
  expect(company.filedAt).toBe(filingDateToUnix(wyomingDate(Math.floor(now / 1000))));
  // The EIN waits for its own five minutes.
  expect(callsOf("playgroundCompleteEin")).toEqual([]);
  expect(einIssued(steps())).toBe(false);

  // The marker, and an ops line of ids only.
  expect(marks().autocompletedAt).toBe(now);
  const line = lines.find((l) => l.opslog === "sandbox_filing_autocompleted");
  expect(line).toBeDefined();
  const { opslog: _event, at: _at, ...fields } = line!;
  expect(fields).toEqual({ companyId: COMPANY_KEY, providerRef: COMPANY_ID });
});

test("at 03:00 UTC the playground files under Wyoming's date, the day before, and the statement's facts read the filing as verified", async () => {
  // 02:54 UTC on 21 August, so the call is at 03:00 UTC: 21:00 on 20 August in Cheyenne. doola
  // reports the State's date, and the State's day is still the 20th.
  now = Date.parse("2026-08-21T02:54:00Z");
  await openFiling();
  now += 6 * MINUTE;
  await sweeper().tick();

  expect(companyFiled(steps())).toBe(true);
  const company = companies.find(COMPANY_KEY)!;
  expect(company.filedAt).toBe(filingDateToUnix("2026-08-20"));
  expect(
    parseDetail<{ filingDate?: string }>(rowOf("await_filing")?.detail ?? null).filingDate,
  ).toBe("2026-08-20");
  // The statement's filing facts, composed as its `recordedFacts` composes them: the stored date
  // against Wyoming's today, at the same instant. A date after today would read `unverified`.
  const today = wyomingDate(Math.floor(now / 1000));
  expect(today).toBe("2026-08-20");
  expect(
    filingFacts({
      formationDate: calendarDateOfUtcMidnight(company.filedAt!),
      lastReport: null,
      today,
    }),
  ).toMatchObject({ filedAt: "2026-08-20", filingStatus: "not_yet_due", nextDue: "2027-08-01" });
});

test("a second tick makes no second playground call", async () => {
  await openFiling();
  now += 6 * MINUTE;
  await sweeper().tick();
  now += MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
  expect(callsOf("playgroundCompleteEin")).toEqual([]);
});

// ── after the call: read again until the filing shows (fix round 1) ──────────────────────────
//
// The marker stops a second playground call, so a completion whose first read learned nothing
// would otherwise wait for the day-long poll. While the call is under thirty minutes old the leg
// reads again, never calling the playground twice, at most once per five minutes per company:
// every failed read doubles the waiting row's poll interval. One sweeper instance per test here,
// because the spacing is the process's own memory.

test("doola shows the filing late: no second playground call, and a read after the spacing files it", async () => {
  await openFiling();
  const real = doola.api.playgroundCompleteFormation;
  let requested = 0;
  // The playground answers, and doola's company still reads unfiled (an eventually consistent
  // sandbox).
  doola.api.playgroundCompleteFormation = async () => {
    requested++;
    return { triggeredEvents: [] };
  };
  const s = sweeper();
  now += 6 * MINUTE;
  await s.tick();
  expect(requested).toBe(1);
  expect(companyFiled(steps())).toBe(false);
  expect(marks().autocompletedAt).toBe(now);
  expect(callsOf("getCompany")).toHaveLength(1);

  // A minute later, inside the spacing: nothing is read again.
  now += MINUTE;
  await s.tick();
  expect(callsOf("getCompany")).toHaveLength(1);

  // doola catches up. Five minutes after the first read, the leg reads again and files.
  await real(COMPANY_ID);
  now += 4 * MINUTE;
  await s.tick();
  expect(callsOf("getCompany")).toHaveLength(2);
  expect(companyFiled(steps())).toBe(true);
  expect(documentsFetched(steps())).toBe(true);
  expect(requested).toBe(1);
});

test("the read right after the call fails: one playground call, and the read five minutes later files it", async () => {
  await openFiling();
  doola.state.failNext = { getCompany: true };
  const s = sweeper();
  now += 6 * MINUTE;
  await s.tick();
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
  expect(callsOf("getCompany")).toHaveLength(1);
  expect(companyFiled(steps())).toBe(false);

  // Inside the spacing: nothing re-advances.
  now += MINUTE;
  await s.tick();
  now += MINUTE;
  await s.tick();
  expect(callsOf("getCompany")).toHaveLength(1);

  now += 3 * MINUTE;
  await s.tick();
  expect(callsOf("getCompany")).toHaveLength(2);
  expect(companyFiled(steps())).toBe(true);
  expect(documentsFetched(steps())).toBe(true);
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
});

test("the reads after a call stop once the call is thirty minutes old", async () => {
  await openFiling();
  // doola never shows the filing.
  doola.api.playgroundCompleteFormation = async () => ({ triggeredEvents: [] });
  const s = sweeper();
  now += 6 * MINUTE;
  await s.tick();
  for (let i = 0; i < 9; i++) {
    now += 5 * MINUTE;
    await s.tick();
  }
  // The read right after the call, then one at +5, +10, +15, +20 and +25 minutes; none from +30
  // to +45. The poll is the backstop after that.
  expect(callsOf("getCompany")).toHaveLength(6);
  expect(companyFiled(steps())).toBe(false);
});

test("an advance that throws after the call logs its own line, and the marker stands", async () => {
  await openFiling();
  vi.spyOn(documents, "storedTypes").mockImplementationOnce(() => {
    throw new Error("index unavailable");
  });
  now += 6 * MINUTE;
  const lines = await tickLogged(sweeper());
  expect(marks().autocompletedAt).toBe(now);
  expect(lines.find((l) => l.opslog === "sandbox_autocomplete_advance_failed")).toMatchObject({
    level: "warn",
    companyId: COMPANY_KEY,
    step: "await_filing",
    message: "index unavailable",
  });
  expect(lines.find((l) => l.opslog === "formation_poll_failed")).toBeUndefined();
});

// ── a finished target step is never brought back (fix round 1) ───────────────────────────────

test.each([
  ["await_filing", "failed"],
  ["await_filing", "abandoned"],
  ["await_ein", "failed"],
  ["await_ein", "abandoned"],
] as const)("an %s row that is %s is never completed by the playground", async (step, state) => {
  await openFiling();
  if (step === "await_ein") {
    now += 6 * MINUTE;
    await sweeper().tick();
    expect(companyFiled(steps())).toBe(true);
    stampRows(now);
  }
  // Parked with a retry 32 minutes away (attempt 5), so in this tick only the sandbox leg could
  // touch the row.
  db.prepare(
    "UPDATE formation_requests SET state = ?, attempt = 5, updated_at = ? WHERE company_id = ? AND step = ?",
  ).run(state, sqliteUtcTimestamp(now), COMPANY_KEY, step);
  now += 6 * MINUTE;
  await sweeper().tick();
  const method = step === "await_filing" ? "playgroundCompleteFormation" : "playgroundCompleteEin";
  expect(callsOf(method)).toEqual([]);
  expect(rowOf(step)?.state).toBe(state);
});

test("six minutes after the filing, one EIN playground call, and the EIN is issued in the same tick", async () => {
  await openFiling();
  now += 6 * MINUTE;
  await sweeper().tick();
  expect(companyFiled(steps())).toBe(true);
  // The filing confirmed on the wall clock; pin it to the injected one.
  stampRows(now);

  now += 4 * MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteEin")).toEqual([]);

  now += 2 * MINUTE;
  const lines = await tickLogged(sweeper());
  expect(callsOf("playgroundCompleteEin")).toEqual([`playgroundCompleteEin:${COMPANY_ID}`]);
  expect(einIssued(steps())).toBe(true);
  expect(companies.find(COMPANY_KEY)?.ein).toBe("12-3456789");
  expect(marks().einAutocompletedAt).toBe(now);
  const line = lines.find((l) => l.opslog === "sandbox_ein_autocompleted");
  expect(line).toBeDefined();
  const { opslog: _event, at: _at, ...fields } = line!;
  expect(fields).toEqual({ companyId: COMPANY_KEY, providerRef: COMPANY_ID });
  // No ops line of the tick carries the EIN.
  expect(lines.some((l) => JSON.stringify(l).includes("12-3456789"))).toBe(false);

  // Fully formed: nothing more is asked of the playground.
  now += 10 * MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
  expect(callsOf("playgroundCompleteEin")).toHaveLength(1);
});

test("an agent company is never completed by the playground", async () => {
  await openFiling({ purposeKind: "agent" });
  now += 6 * MINUTE;
  await sweeper().tick();
  now += 60 * MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toEqual([]);
  expect(callsOf("playgroundCompleteEin")).toEqual([]);
  expect(companyFiled(steps())).toBe(false);
});

test("a production deployment never calls the playground", async () => {
  await openFiling();
  now += 6 * MINUTE;
  await sweeper({ environment: "production" }).tick();
  now += 60 * MINUTE;
  await sweeper({ environment: "production" }).tick();
  expect(callsOf("playgroundCompleteFormation")).toEqual([]);
  expect(callsOf("playgroundCompleteEin")).toEqual([]);
  expect(marks().autocompletedAt).toBeUndefined();
});

test("a company pinned to production is never completed, even on a sandbox deployment", async () => {
  await openFiling();
  db.prepare("UPDATE companies SET environment = 'production' WHERE company_id = ?").run(
    COMPANY_KEY,
  );
  now += 6 * MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toEqual([]);
  expect(marks().autocompletedAt).toBeUndefined();
});

test("a throwing playground call writes no marker, and is made again once the delay has passed, not every tick", async () => {
  await openFiling();
  const real = doola.api.playgroundCompleteFormation;
  let attempts = 0;
  doola.api.playgroundCompleteFormation = async (id) => {
    attempts++;
    if (attempts === 1) throw new Error("doola playground is down");
    return real(id);
  };

  const s = sweeper();
  now += 6 * MINUTE;
  const lines = await tickLogged(s);
  expect(attempts).toBe(1);
  expect(marks().autocompletedAt).toBeUndefined();
  expect(companyFiled(steps())).toBe(false);
  expect(lines.find((l) => l.opslog === "sandbox_filing_autocompleted")).toBeUndefined();
  expect(lines.find((l) => l.opslog === "sandbox_autocomplete_failed")).toMatchObject({
    level: "warn",
    companyId: COMPANY_KEY,
    step: "await_filing",
    message: "doola playground is down",
  });

  // Two more ticks a minute apart: the failure backs off, no second call yet.
  now += MINUTE;
  await s.tick();
  now += MINUTE;
  await s.tick();
  expect(attempts).toBe(1);
  expect(marks().autocompletedAt).toBeUndefined();

  // Five minutes after the failure: the next call, and the filing.
  now += 3 * MINUTE;
  await s.tick();
  expect(attempts).toBe(2);
  expect(companyFiled(steps())).toBe(true);
  expect(marks().autocompletedAt).toBe(now);
});

test("a playground call that keeps failing gives up after six failures with one error line, and the seventh tick makes no call", async () => {
  await openFiling();
  let attempts = 0;
  doola.api.playgroundCompleteFormation = async () => {
    attempts++;
    throw new Error("doola playground is down");
  };

  const s = sweeper();
  const lines: Record<string, unknown>[] = [];
  now += 6 * MINUTE;
  lines.push(...(await tickLogged(s)));
  // Five more failing calls, each one the delay after the last.
  for (let i = 0; i < 5; i++) {
    now += SANDBOX_AUTOCOMPLETE_DELAY_MS;
    lines.push(...(await tickLogged(s)));
  }
  expect(attempts).toBe(6);
  expect(lines.filter((l) => l.opslog === "sandbox_autocomplete_failed")).toHaveLength(6);
  const gaveUp = lines.filter((l) => l.opslog === "sandbox_autocomplete_gave_up");
  expect(gaveUp).toHaveLength(1);
  const { opslog: _event, at: _at, ...fields } = gaveUp[0]!;
  // Ids, a step and a count: no personal data.
  expect(fields).toEqual({
    level: "error",
    companyId: COMPANY_KEY,
    step: "await_filing",
    failures: 6,
  });

  // The seventh tick, the delay later: no call, and no second line.
  now += SANDBOX_AUTOCOMPLETE_DELAY_MS;
  const seventh = await tickLogged(s);
  expect(attempts).toBe(6);
  expect(
    seventh.filter((l) =>
      ["sandbox_autocomplete_failed", "sandbox_autocomplete_gave_up"].includes(String(l.opslog)),
    ),
  ).toEqual([]);
  // The database is untouched: no marker, the filing still open.
  expect(marks().autocompletedAt).toBeUndefined();
  expect(companyFiled(steps())).toBe(false);
});
