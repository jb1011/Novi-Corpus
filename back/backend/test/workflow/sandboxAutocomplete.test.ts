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
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository, parseDetail } from "../../src/persistence/formationRepository";
import { filingDateToUnix } from "../../src/workflow/formationProcessor";
import { runFormationCreateProvider } from "../../src/workflow/formationProvider";
import { FormationSweeper, type FormationSweeperDeps } from "../../src/workflow/formationSweeper";
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
  expect(company.filingNumber).toBe("PLAYGROUND-FILING");
  expect(company.filedAt).toBe(filingDateToUnix(new Date(now).toISOString().slice(0, 10)));
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

test("a second tick makes no second playground call", async () => {
  await openFiling();
  now += 6 * MINUTE;
  await sweeper().tick();
  now += MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
  expect(callsOf("playgroundCompleteEin")).toEqual([]);
});

test("the marker holds when doola has not shown the filing yet: the call is not repeated", async () => {
  await openFiling();
  // The playground answers, and doola's company still reads unfiled (an eventually consistent
  // sandbox). The poll catches it up; the sweeper does not call the playground again.
  doola.api.playgroundCompleteFormation = async (id) => {
    doola.calls.push(`playgroundCompleteFormation:${id}`);
    return { triggeredEvents: [] };
  };
  now += 6 * MINUTE;
  await sweeper().tick();
  expect(companyFiled(steps())).toBe(false);
  expect(marks().autocompletedAt).toBe(now);

  now += 10 * MINUTE;
  await sweeper().tick();
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
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

test("a throwing playground call writes no marker, and is made again on the next tick", async () => {
  await openFiling();
  const real = doola.api.playgroundCompleteFormation;
  let attempts = 0;
  doola.api.playgroundCompleteFormation = async (id) => {
    attempts++;
    if (attempts === 1) throw new Error("doola playground is down");
    return real(id);
  };

  now += 6 * MINUTE;
  const lines = await tickLogged(sweeper());
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

  now += MINUTE;
  await sweeper().tick();
  expect(attempts).toBe(2);
  expect(companyFiled(steps())).toBe(true);
  expect(marks().autocompletedAt).toBe(now);
});
