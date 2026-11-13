/**
 * The assisted completion of a paid formed company (F-A-2a, Task 14): `formation:record-filed`
 * and `formation:record-ein`, for a filing doola did by hand outside its API.
 *
 * The rule under test is the design's §14 sentence: the operator's record writes the rows the saga
 * writes for an API filing, apart from the provider ref, which is `manual:<operator>` so the saga
 * never polls the company afterwards. One test files company A through the sandbox doola and the
 * processor and records company B by hand with the same name, number and date, and compares them
 * row by row; the others hold each refusal to "nothing written".
 *
 * Each command opens the database and the document store itself, through the configuration, so
 * every test works in a temporary data directory, as `formedCompanyCommands.test.ts` does.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import { buildCli } from "../../src/cli/index";
import { syntheticFormationParty } from "../../src/formation";
import { companyNameOptions } from "../../src/formation/intake";
import { encryptSsn, parsePiiKey } from "../../src/formation/pii";
import { companyFiled, einIssued, providerRefOf } from "../../src/formation/status";
import { agreementDocNames } from "../../src/legalBody/agreement";
import { type LegalBodyOrderDeps, createOrder } from "../../src/legalBody/orders";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import {
  type FormationStep,
  SqliteFormationRepository,
  parseDetail,
} from "../../src/persistence/formationRepository";
import { calendarDateOfUtcMidnight } from "../../src/util/wyomingCalendar";
import { advanceFormation, filingDateToUnix } from "../../src/workflow/formationProcessor";
import { runFormationCreateProvider } from "../../src/workflow/formationProvider";
import { FormationSweeper } from "../../src/workflow/formationSweeper";
import { ACTION, ANVIL_ACCOUNT_2, recordHuman } from "../helpers/customerCompanyFixtures";
import {
  type FakeDoola,
  MemoryDocumentStore,
  fakeSandboxDoola,
  seedCompany,
} from "../helpers/formationFakes";
import { legalBodyOrderDeps, openLegalBodyStores } from "../helpers/legalBodyFixtures";

/** anvil's published account #2: a test key, never a real wallet. */
const tenant: Address = ANVIL_ACCOUNT_2.address;
const OPERATOR = "ops.example";
const MANUAL_REF = `manual:${OPERATOR}`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The injected clock the sandbox playground files company A on: a day before any real today. */
const FILING_CLOCK = Date.parse("2026-11-02T12:00:00Z");
/** The filing number doola gives company A in the comparison: the production shape, since doola's
 *  sandbox files with none. */
const DOOLA_FILING = "2026-000451190";
/** When every fixture company row was created (SQLite UTC text): before every filing date typed. */
const CREATED_AT = "2026-10-30 09:00:00";
const STEPS: FormationStep[] = ["create_provider", "await_filing", "fetch_documents", "await_ein"];

/** A test key for the SSN ring: never a deployment's. */
const RING = { current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY") };
/** The refusal of a create that may exist at doola, for one company. */
const mayHoldCompany = (companyId: string) =>
  `refusing: a create went out to doola for company ${companyId} and its answer was lost: doola may hold the company. Ask doola whether it holds one for this company's customer. If it does, do not record: the saga's next retry re-sends the same key and doola answers with that company, or its lookup by the customer finds it, and the saga adopts it. If doola confirms it holds none, run again with --doola-confirmed-no-company`;
const FILED_BEFORE_CREATED =
  "the filing date is before the company was created at Novi: check it against the State's record";
const NO_STORED_OPTION = /^matches no stored option/;
const NO_ENTITY_ENDING =
  "no entity ending (LLC, L.L.C., Limited Liability Company): the State's record of an LLC carries its ending; check the name";

let dir: string;
let db: Database.Database;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let parties: SqliteFormationPartyRepository;
let entities: SqliteEntityRepository;
let docStore: FileDocumentStore;
/** Every line written to standard output, the commands' and the ops lines alike. */
let printed: string[];
let n = 0;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "record-filed-"));
  // The commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  entities = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(join(dir, "documents"));
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/**
 * A company Novi forms through doola for a legal body, paid (`ready`), its responsible party bound
 * (the synthetic party of a sandbox), nothing filed: the company an operator records by hand.
 * `party: "none"` binds none; `"erased"` binds one and erases it.
 */
function paidCompany(
  opts: {
    names?: [string, ...string[]];
    purposeKind?: "agent" | "legal_body";
    provider?: string;
    status?: "draft" | "ready";
    party?: "bound" | "none" | "erased";
  } = {},
): string {
  const companyId = seedCompany(companies, {
    companyId: `paid-${++n}`,
    tenantId: tenant,
    status: opts.status ?? "ready",
    provider: opts.provider ?? "doola",
    purposeKind: opts.purposeKind ?? "legal_body",
    nameOptions: companyNameOptions(...(opts.names ?? ["Lantern Works", "Lantern Works Two"])),
    businessPurpose: "Software services.",
  });
  // Created before every filing date the fixtures type, so none of them warns that the filing
  // predates the company; the test of that warning moves this stamp itself.
  db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(CREATED_AT, companyId);
  const party = opts.party ?? "bound";
  if (party !== "none") {
    const partyId = parties.create({
      tenantId: tenant,
      ...syntheticFormationParty(`party-${n}`),
      synthetic: true,
    });
    expect(parties.bindToCompany(partyId, companyId, tenant)).toBe(true);
    if (party === "erased") expect(parties.erase(partyId)).toBe(true);
  }
  return companyId;
}

const advanceDeps = (fake: FakeDoola) => ({
  repo: entities,
  companies,
  requests,
  documents,
  docStore: new MemoryDocumentStore(),
  doola: fake.api,
  environment: "sandbox" as const,
  fetchImpl: fake.fetchImpl,
  lookupImpl: fake.lookupImpl,
  now: () => FILING_CLOCK,
});

/**
 * Company A's path, Task 13's: the real filing step against the sandbox doola, the playground's
 * filing, then the ordinary processor reading it back. doola's sandbox files with no number;
 * `filingNumber` gives one, as doola does on production.
 */
async function filedThroughTheApi(
  companyId: string,
  fake: FakeDoola,
  opts: { filingNumber?: string } = {},
): Promise<void> {
  await runFormationCreateProvider({
    company: companies.find(companyId)!,
    companies,
    repo: entities,
    requests,
    parties,
    doola: fake.api,
    environment: "sandbox",
  });
  const ref = providerRefOf(requests.stepsOf(companyId));
  expect(ref).toMatch(/^cmp-\d+$/);
  await fake.api.playgroundCompleteFormation(ref!);
  if (opts.filingNumber !== undefined)
    fake.state.company = { ...fake.state.company, formationFilingNumber: opts.filingNumber };
  await advanceFormation(advanceDeps(fake), companyId);
  expect(companyFiled(requests.stepsOf(companyId))).toBe(true);
}

/** A small PDF, different for every label. */
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, "latin1");
const sha256Of = (bytes: Uint8Array): Hex =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;

/** Writes `bytes` to a file of the data directory, as the operator copies doola's file to the box,
 *  and returns its path. */
function fileOf(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

const isOpsLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed;
  } catch {
    return false;
  }
};

interface Run<T> {
  /** The one JSON object the command printed. */
  output: T;
  /** The ops lines it wrote, parsed. */
  ops: Record<string, unknown>[];
  /** Everything it wrote to standard output. */
  lines: string[];
}

async function run<T = Record<string, unknown>>(args: string[]): Promise<Run<T>> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const lines = printed.slice(from);
  const outputs = lines.filter((line) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  return {
    output: JSON.parse(outputs[0] as string) as T,
    ops: lines.filter(isOpsLine).map((line) => JSON.parse(line) as Record<string, unknown>),
    lines,
  };
}

/** The refusal's message. A refusal writes no ops line. */
async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from).filter(isOpsLine)).toEqual([]);
  return message;
}

/** The files in the document store the commands write to. */
const storeFiles = (): string[] =>
  existsSync(join(dir, "documents")) ? readdirSync(join(dir, "documents")).sort() : [];

/** The OS user the commands record beside the operator's name. */
const OS_USER = userInfo().username;

interface Filing {
  number?: string;
  date?: string;
  name?: string;
  articles?: string;
  operator?: string;
}

const recordFiledArgs = (companyId: string, f: Filing, ...more: string[]) => [
  "formation:record-filed",
  companyId,
  "--filing-number",
  f.number ?? "2026-000451207",
  "--filed-at",
  f.date ?? "2026-11-02",
  "--legal-name",
  f.name ?? "Lantern Works LLC",
  "--articles",
  f.articles ?? fileOf(`articles-${++n}.pdf`, pdf(`articles ${n}`)),
  "--operator",
  f.operator ?? OPERATOR,
  ...more,
];

const recordEinArgs = (companyId: string, ...more: string[]) => [
  "formation:record-ein",
  companyId,
  "--operator",
  OPERATOR,
  ...more,
];

const rowOf = (companyId: string, step: FormationStep) =>
  requests.stepsOf(companyId).find((r) => r.step === step);

/** Everything a record-filed may write for one company, so "nothing written" is one comparison. */
const writtenFor = (companyId: string) => ({
  steps: requests.stepsOf(companyId),
  company: companies.find(companyId),
  documents: documents.listByCompany(companyId),
  files: storeFiles(),
});

const entityEventCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

/** The order stores over the test's own connection. */
function orderDeps(): LegalBodyOrderDeps {
  const s = openLegalBodyStores(db, new MemoryDocumentStore());
  if (s.store.findByTenant(tenant, ACTION) === undefined)
    recordHuman(s.store, tenant, "3101", Date.now());
  return legalBodyOrderDeps(s, {
    chain: {} as LegalBodyChainPort,
    maxOpenPerTenant: 50,
    maxOrdersPerTenantPerDay: 50,
  });
}

interface FiledRecorded {
  recorded: true;
  companyId: string;
  legalNameFiled: string;
  filingNumber: string;
  filedAt: number;
  matched: boolean;
  warnings?: string[];
  document: { docId: string; sha256: string; size: number };
  operator: string;
  operatorOsUser: string;
  next: string;
}

// ── The §14 comparison ────────────────────────────────────────────────────────────────────────

describe("formation:record-filed, against the saga's own rows", () => {
  test("a filing recorded by hand writes the rows an API filing writes, apart from its manual: ref, and the order door takes both alike", async () => {
    const fake = fakeSandboxDoola({}, { now: () => FILING_CLOCK });
    const a = paidCompany();
    // With doola's own number, so both rows carry the same number in the same place: a sandbox
    // stand-in lives on the company row only, never in the step's detail.
    await filedThroughTheApi(a, fake, { filingNumber: DOOLA_FILING });
    const filedA = companies.find(a)!;
    // doola lists it under the first option and its ending; the processor stored that candidate's
    // full name.
    expect(filedA).toMatchObject({
      legalNameFiled: "Lantern Works LLC",
      filingNumber: DOOLA_FILING,
    });
    const date = calendarDateOfUtcMidnight(filedA.filedAt!);
    expect(date).toBe("2026-11-02");

    const b = paidCompany();
    expect(requests.stepsOf(b)).toEqual([]);
    const bytes = pdf("articles of organization, company b");
    const sha256 = sha256Of(bytes);
    const { output, ops, lines } = await run<FiledRecorded>(
      recordFiledArgs(
        b,
        {
          number: filedA.filingNumber!,
          date: date!,
          name: filedA.legalNameFiled!,
          articles: fileOf("articles-b.pdf", bytes),
        },
        "--yes",
      ),
    );

    // Step by step: the same states.
    for (const step of STEPS) expect(rowOf(b, step)?.state, step).toBe(rowOf(a, step)?.state);
    expect(STEPS.map((step) => rowOf(b, step)?.state)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "pending",
    ]);
    // The filing's facts in await_filing's detail: the same number and the same date, in the
    // processor's own `AwaitFilingDetail` keys (`filingDate`, yyyy-MM-dd), and the date again in
    // the unix seconds `filed_at` holds.
    const detailA = parseDetail<{ filingNumber?: string; filingDate?: string }>(
      rowOf(a, "await_filing")!.detail,
    );
    const detailB = parseDetail<{
      filingNumber?: string;
      filingDate?: string;
      filedAt?: number;
      recordedBy?: string;
    }>(rowOf(b, "await_filing")!.detail);
    expect(detailB.filingNumber).toBe(detailA.filingNumber);
    expect(detailB.filingDate).toBe(detailA.filingDate);
    expect(detailB.filedAt).toBe(filingDateToUnix(detailA.filingDate));
    expect(detailB).toEqual({
      filingNumber: DOOLA_FILING,
      filingDate: "2026-11-02",
      filedAt: filedA.filedAt,
      recordedBy: OPERATOR,
    });

    // The company rows: the same filing facts, the same status.
    const pick = (id: string) => {
      const c = companies.find(id)!;
      return {
        filedAt: c.filedAt,
        filingNumber: c.filingNumber,
        legalNameFiled: c.legalNameFiled,
        status: c.status,
      };
    };
    expect(pick(b)).toEqual(pick(a));
    expect(pick(b).status).toBe("ready");

    // The provider ref differs by design: doola's company id on A, the operator's record on B,
    // on create_provider and on the EIN step it waits on.
    expect(providerRefOf(requests.stepsOf(a))).toBe("cmp-1");
    expect(providerRefOf(requests.stepsOf(b))).toBe(MANUAL_REF);
    expect(rowOf(b, "await_ein")).toMatchObject({
      state: "pending",
      providerRef: MANUAL_REF,
      nextPollAt: null,
    });
    expect(parseDetail<Record<string, unknown>>(rowOf(b, "create_provider")!.detail)).toEqual({
      recordedBy: OPERATOR,
      recordedAt: expect.any(Number),
    });
    const docId = documentIndexId(b, `operator:ArticlesOfOrganization:${sha256}`);
    // fetch_documents' detail in the processor's `FetchDocumentsDetail` shape: `stored` lists
    // each document by its provider document id, type and hash, as the processor maps the index
    // rows; `missing` is empty. The operator's handle beside them.
    type FetchDocuments = {
      stored?: { docId: string; type: string; sha256: string }[];
      missing?: string[];
    };
    const fetchedA = parseDetail<FetchDocuments>(rowOf(a, "fetch_documents")!.detail);
    const fetchedB = parseDetail<FetchDocuments>(rowOf(b, "fetch_documents")!.detail);
    expect(fetchedB).toEqual({
      stored: [
        {
          docId: `operator:ArticlesOfOrganization:${sha256}`,
          type: "ArticlesOfOrganization",
          sha256,
        },
      ],
      missing: [],
      recordedBy: OPERATOR,
    });
    expect(fetchedA.missing).toEqual([]);
    expect(fetchedA.stored!.map((doc) => Object.keys(doc).sort())).toEqual(
      fetchedA.stored!.map(() => ["docId", "sha256", "type"]),
    );
    // What the processor writes from the index, B's row matches.
    expect(fetchedB.stored).toEqual(
      documents
        .listByCompany(b)
        .map((r) => ({ docId: r.providerDocId, type: r.docType, sha256: r.sha256 })),
    );
    expect(companyFiled(requests.stepsOf(a))).toBe(true);
    expect(companyFiled(requests.stepsOf(b))).toBe(true);

    // The articles: an operator's document of B, its bytes in the store.
    const articles = documents.listByCompany(b);
    expect(articles).toEqual([
      expect.objectContaining({
        id: docId,
        companyId: b,
        docType: "ArticlesOfOrganization",
        sha256,
        contentType: "application/pdf",
        size: bytes.length,
        providerDocId: `operator:ArticlesOfOrganization:${sha256}`,
        path: documentStoreName(b, "ArticlesOfOrganization", sha256.slice(2)),
        source: "operator",
        expiresAt: null,
      }),
    ]);
    expect(docStore.getBytes(articles[0]!.path).equals(bytes)).toBe(true);

    // The `formationFiled` event, as the processor writes it, reaches no entity on either side:
    // a legal-body company has none attached.
    expect(entities.listByCompany(a)).toEqual([]);
    expect(entities.listByCompany(b)).toEqual([]);
    expect(entityEventCount()).toBe(0);

    // The order door takes both, and both agreements print the same name and number.
    const deps = orderDeps();
    const termsOf = (companyId: string) =>
      deps.docStore.get(agreementDocNames(createOrder(deps, tenant, { companyId }).id).terms);
    const [termsA, termsB] = [termsOf(a), termsOf(b)];
    for (const terms of [termsA, termsB]) {
      expect(terms).toContain('# Operating Agreement of "Lantern Works LLC"');
      expect(terms).toContain(`with filing number "${DOOLA_FILING}"`);
    }

    // One JSON object, naming the next command; one ops line of ids and the operator.
    expect(output).toEqual({
      recorded: true,
      companyId: b,
      legalNameFiled: "Lantern Works LLC",
      filingNumber: DOOLA_FILING,
      filedAt: filedA.filedAt,
      matched: true,
      document: { docId, sha256, size: bytes.length },
      operator: OPERATOR,
      operatorOsUser: OS_USER,
      next: "formation:record-ein when the IRS letter arrives",
    });
    expect(ops).toEqual([
      {
        opslog: "formation_recorded_filed",
        at: expect.any(String),
        companyId: b,
        matched: true,
        operator: OPERATOR,
        operatorOsUser: OS_USER,
      },
    ]);
    const opsText = lines.filter(isOpsLine).join("\n");
    for (const leak of ["Lantern", DOOLA_FILING, "articles-b", dir])
      expect(opsText).not.toContain(leak);
  });

  test("record-filed refuses a company the API filed, and a company already recorded, writing nothing", async () => {
    const fake = fakeSandboxDoola({}, { now: () => FILING_CLOCK });
    const a = paidCompany();
    await filedThroughTheApi(a, fake);
    const beforeA = writtenFor(a);
    expect(await refusal(recordFiledArgs(a, {}, "--yes"))).toBe(
      "refusing: the API filed this company: nothing to record",
    );
    expect(writtenFor(a)).toEqual(beforeA);

    const b = paidCompany();
    await run(recordFiledArgs(b, {}, "--yes"));
    const beforeB = writtenFor(b);
    for (const operator of [OPERATOR, "ops.other"])
      expect(await refusal(recordFiledArgs(b, { operator }, "--yes")), operator).toBe(
        `refusing: the filing of company ${b} is already recorded by ${OPERATOR}`,
      );
    expect(writtenFor(b)).toEqual(beforeB);
  });

  test("two sweeper ticks after the record ask doola nothing for the recorded company, and its rows do not move", async () => {
    const fake = fakeSandboxDoola({}, { now: () => FILING_CLOCK });
    // An API company beside it, so the ticks are seen to work.
    const a = paidCompany();
    await filedThroughTheApi(a, fake);
    const b = paidCompany();
    await run(recordFiledArgs(b, {}, "--yes"));
    const before = writtenFor(b);
    const callsBefore = fake.calls.length;

    let now = Date.now() + 6 * 60_000;
    const sweeper = new FormationSweeper({
      repo: entities,
      companies,
      requests,
      documents,
      parties,
      docStore: new MemoryDocumentStore(),
      events: new SqliteDoolaEventRepository(db),
      doola: fake.api,
      environment: "sandbox",
      fetchImpl: fake.fetchImpl,
      lookupImpl: fake.lookupImpl,
      intervalMs: 60_000,
      now: () => now,
    });
    // Past the sandbox leg's five minutes, then past the day a never-polled row waits.
    await sweeper.tick();
    now += 2 * DAY_MS;
    await sweeper.tick();

    const calls = fake.calls.slice(callsBefore);
    // The ticks did work: the sandbox leg issued A's EIN.
    expect(calls).toContain("playgroundCompleteEin:cmp-1");
    expect(einIssued(requests.stepsOf(a))).toBe(true);
    // Nothing for B: no call under its manual ref or its id, and no new filing opened.
    expect(calls.filter((c) => c.includes(MANUAL_REF) || c.includes(b))).toEqual([]);
    expect(calls.filter((c) => /^create(Customer|Company):/.test(c))).toEqual([]);
    expect(writtenFor(b)).toEqual(before);
  });
});

// ── The rest of record-filed ──────────────────────────────────────────────────────────────────

describe("formation:record-filed", () => {
  test("the dry run prints what it would write and writes nothing: no row, no fact, no document, no file, no ops line", async () => {
    const companyId = paidCompany();
    const bytes = pdf("dry run");
    const sha256 = sha256Of(bytes);
    const before = writtenFor(companyId);
    const { output, ops } = await run<Record<string, unknown>>(
      recordFiledArgs(companyId, { articles: fileOf("dry.pdf", bytes) }),
    );
    expect(output).toMatchObject({
      recorded: false,
      companyId,
      wouldRecord: {
        legalNameFiled: "Lantern Works LLC",
        filingNumber: "2026-000451207",
        filedAt: filingDateToUnix("2026-11-02"),
        providerRef: MANUAL_REF,
        document: {
          docId: documentIndexId(companyId, `operator:ArticlesOfOrganization:${sha256}`),
          sha256,
          size: bytes.length,
        },
      },
      matched: true,
      next: "nothing was written: run the same command with --yes to record this",
    });
    expect(ops).toEqual([]);
    expect(writtenFor(companyId)).toEqual(before);
    expect(before.steps).toEqual([]);
    expect(storeFiles()).toEqual([]);
  });

  test("a create_provider that failed with no provider ref is recorded from failed, and its error is cleared", async () => {
    const companyId = paidCompany();
    expect(requests.claimAllSteps(companyId)).toBe(true);
    expect(
      requests.transition(companyId, "create_provider", "pending", "failed", {
        error: "doola is down",
      }),
    ).toBe(true);
    await run(recordFiledArgs(companyId, {}, "--yes"));
    expect(rowOf(companyId, "create_provider")).toMatchObject({
      state: "confirmed",
      providerRef: MANUAL_REF,
      error: null,
    });
    expect(companyFiled(requests.stepsOf(companyId))).toBe(true);
  });

  test("a create that went out to doola with its answer lost, or whose detail cannot be read, is refused, writing nothing, until doola confirms it holds no company", async () => {
    // The body went out under the attempt's key and the answer was lost: a failure that never
    // burns the attempt (an outage), so the next retry re-sends the same key.
    const sent = paidCompany();
    requests.claimAllSteps(sent);
    const attempt = rowOf(sent, "create_provider")!.attempt;
    expect(
      requests.transition(sent, "create_provider", "pending", "failed", {
        detail: JSON.stringify({ customerId: "cus-1", companySentAttempt: attempt }),
        error: "doola did not answer",
      }),
    ).toBe(true);
    // A detail that is not JSON proves nothing either way, so it reads as sent.
    const unreadable = paidCompany();
    requests.claimAllSteps(unreadable);
    expect(
      requests.transition(unreadable, "create_provider", "pending", "pending", {
        detail: "{not json",
      }),
    ).toBe(true);

    for (const companyId of [sent, unreadable]) {
      const before = writtenFor(companyId);
      for (const more of [["--yes"], []])
        expect(await refusal(recordFiledArgs(companyId, {}, ...more)), companyId).toBe(
          mayHoldCompany(companyId),
        );
      expect(writtenFor(companyId)).toEqual(before);
    }

    // doola confirmed it holds none: recorded, and the ops line says the create was one that
    // went out.
    const { ops } = await run(recordFiledArgs(sent, {}, "--doola-confirmed-no-company", "--yes"));
    expect(rowOf(sent, "create_provider")).toMatchObject({
      state: "confirmed",
      providerRef: MANUAL_REF,
      error: null,
    });
    expect(companyFiled(requests.stepsOf(sent))).toBe(true);
    expect(ops).toEqual([
      {
        opslog: "formation_recorded_filed",
        at: expect.any(String),
        companyId: sent,
        matched: true,
        frozenCreate: true,
        operator: OPERATOR,
        operatorOsUser: OS_USER,
      },
    ]);
    await run(recordFiledArgs(unreadable, {}, "--doola-confirmed-no-company", "--yes"));
    expect(companyFiled(requests.stepsOf(unreadable))).toBe(true);

    // A create doola refused burned its attempt, so its key is not live: no flag needed, and the
    // line carries no frozenCreate.
    const refused = paidCompany();
    requests.claimAllSteps(refused);
    expect(
      requests.transition(refused, "create_provider", "pending", "failed", {
        detail: JSON.stringify({ companySentAttempt: attempt - 1 }),
      }),
    ).toBe(true);
    const plain = await run(recordFiledArgs(refused, {}, "--yes"));
    expect(plain.ops).toHaveLength(1);
    expect(plain.ops[0]).not.toHaveProperty("frozenCreate");
  });

  test("the party's SSN is erased in the record's own transaction, as the API path erases it when doola's company id lands; the dry run keeps it", async () => {
    const companyId = paidCompany();
    const party = parties.findByCompanyId(companyId)!;
    expect(
      parties.storeSsn(
        party.partyId,
        companyId,
        encryptSsn(RING, "123-45-6789", { partyId: party.partyId, companyId }),
      ),
    ).toBe(true);
    await run(recordFiledArgs(companyId, {}));
    expect(parties.ssnState(companyId)).toMatchObject({ hasSsn: true });

    const { ops } = await run(recordFiledArgs(companyId, {}, "--yes"));
    expect(parties.ssnState(companyId)).toEqual({
      hasSsn: false,
      ssnErasedReason: "provider_persisted",
    });
    expect(parties.findSsnByCompanyId(companyId)).toBeUndefined();
    // The erasure's own audit line, the company, the reason and the environment only, then the
    // record's.
    expect(ops).toEqual([
      {
        opslog: "formation_ssn_erased",
        at: expect.any(String),
        companyId,
        reason: "provider_persisted",
        environment: "sandbox",
      },
      expect.objectContaining({ opslog: "formation_recorded_filed", companyId }),
    ]);
  });

  test("a create being sent, a create doola answered, and an abandoned or partial filing are refused, writing nothing", async () => {
    const submitted = paidCompany();
    requests.claimAllSteps(submitted);
    requests.transition(submitted, "create_provider", "pending", "submitted");

    const adopting = paidCompany();
    requests.claimAllSteps(adopting);
    requests.transition(adopting, "create_provider", "pending", "failed", { providerRef: "cmp-9" });

    const partial = paidCompany();
    requests.claimAllSteps(partial);
    requests.transition(partial, "await_filing", "pending", "submitted");

    const cases: [string, string][] = [
      [submitted, "refusing: a create is being sent to doola: wait for it"],
      [
        adopting,
        `refusing: doola holds a company for company ${adopting} (create_provider has a provider ref): the saga adopts it; nothing to record`,
      ],
      [
        partial,
        `refusing: the await_filing step of company ${partial} is submitted, not pending: find out why before recording`,
      ],
    ];
    for (const [companyId, expected] of cases) {
      const before = writtenFor(companyId);
      expect(await refusal(recordFiledArgs(companyId, {}, "--yes")), companyId).toBe(expected);
      expect(writtenFor(companyId)).toEqual(before);
    }
  });

  test("refuses a company that is not a paid formed legal-body company with its party, before the file is read", async () => {
    // The file does not exist: each company refusal comes first.
    const missing = join(dir, "missing.pdf");
    const cases: [string, string][] = [["no-such-company", "refusing: no company no-such-company"]];
    const declared = paidCompany({ provider: "customer" });
    cases.push([
      declared,
      `refusing: company ${declared} was not formed through doola (provider customer): these commands take a company Novi formed`,
    ]);
    const forAgents = paidCompany({ purposeKind: "agent" });
    cases.push([
      forAgents,
      `refusing: company ${forAgents} was formed for agents, not for a legal body`,
    ]);
    const abandoned = paidCompany();
    expect(companies.setStatus(abandoned, "ready", "abandoned")).toBe(true);
    cases.push([
      abandoned,
      `refusing: company ${abandoned} is abandoned: nothing can be recorded on it`,
    ]);
    const unpaid = paidCompany({ status: "draft" });
    cases.push([
      unpaid,
      `refusing: company ${unpaid} is not paid (status draft): only a paid company is filed`,
    ]);
    for (const party of ["none", "erased"] as const) {
      const companyId = paidCompany({ party });
      cases.push([
        companyId,
        `refusing: company ${companyId} has no formation party: a paid formed company always has one; find out why before recording`,
      ]);
    }
    for (const [companyId, expected] of cases) {
      const before = writtenFor(companyId);
      expect(
        await refusal(recordFiledArgs(companyId, { articles: missing }, "--yes")),
        companyId,
      ).toBe(expected);
      expect(writtenFor(companyId)).toEqual(before);
    }
  });

  test("--filed-at: a date that is not on the calendar, or after today in UTC, is refused with nothing written; today is taken", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-10T23:59:00Z"));
    const companyId = paidCompany();
    const before = writtenFor(companyId);
    const cases: [string, string][] = [
      // Date.parse reads it as 2 March.
      ["2026-02-30", "refusing: --filed-at must be a date of the calendar, written YYYY-MM-DD"],
      ["2026-2-3", "refusing: --filed-at must be a date of the calendar, written YYYY-MM-DD"],
      ["11/02/2026", "refusing: --filed-at must be a date of the calendar, written YYYY-MM-DD"],
      [
        "2026-11-11",
        "refusing: --filed-at is after today's date in UTC (2026-11-10): the State cannot have filed the company yet",
      ],
      // A calendar date, but before the unix epoch: no filing of a company Novi forms.
      [
        "1969-12-31",
        "refusing: --filed-at is before 1970-01-01: check it against the State's record",
      ],
      [
        "0001-01-01",
        "refusing: --filed-at is before 1970-01-01: check it against the State's record",
      ],
    ];
    for (const [date, expected] of cases) {
      expect(await refusal(recordFiledArgs(companyId, { date }, "--yes")), date).toBe(expected);
      expect(writtenFor(companyId)).toEqual(before);
    }
    const { output } = await run<FiledRecorded>(
      recordFiledArgs(companyId, { date: "2026-11-10" }, "--yes"),
    );
    expect(output.filedAt).toBe(Date.parse("2026-11-10T00:00:00Z") / 1000);
    expect(companies.find(companyId)?.filedAt).toBe(output.filedAt);
  });

  test("a filing date before the company row was created is written, with a warning in the dry run and the write; the creation day itself is not warned", async () => {
    const companyId = paidCompany();
    db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(
      "2026-11-03 18:30:00",
      companyId,
    );
    const { output: dry } = await run<{ warnings?: string[] }>(
      recordFiledArgs(companyId, { date: "2026-11-02" }),
    );
    expect(dry.warnings).toEqual([FILED_BEFORE_CREATED]);
    const { output } = await run<FiledRecorded>(
      recordFiledArgs(companyId, { date: "2026-11-02" }, "--yes"),
    );
    expect(output.warnings).toEqual([FILED_BEFORE_CREATED]);
    expect(companies.find(companyId)?.filedAt).toBe(filingDateToUnix("2026-11-02"));

    // Its warning comes after the name's.
    const other = paidCompany();
    db.prepare("UPDATE companies SET created_at = ? WHERE company_id = ?").run(
      "2026-11-03 18:30:00",
      other,
    );
    const { output: all } = await run<{ warnings?: string[] }>(
      recordFiledArgs(other, { date: "2026-11-02", name: "Lantern Labs" }),
    );
    expect(all.warnings).toEqual([
      expect.stringMatching(NO_STORED_OPTION),
      NO_ENTITY_ENDING,
      FILED_BEFORE_CREATED,
    ]);
    // Filed on the day the row was created: no warning.
    const { output: sameDay } = await run<{ warnings?: string[] }>(
      recordFiledArgs(other, { date: "2026-11-03" }),
    );
    expect(sameDay.warnings).toBeUndefined();
  });

  test("--filing-number is held to the agreement's filing-number rule, refused and never cleaned", async () => {
    const companyId = paidCompany();
    const before = writtenFor(companyId);
    const cases: [string, string | RegExp][] = [
      ["2026_000451207", "refusing: --filing-number may hold only A-Z, a-z, 0-9 and hyphens"],
      ["202", "refusing: --filing-number must be 4 to 32 characters long"],
      ['2026"0451', "refusing: --filing-number holds a double quote"],
      [
        " 2026-000451207",
        /^refusing: --filing-number would be changed by the agreement's field rule/,
      ],
      [
        "2026-000451207 ",
        /^refusing: --filing-number would be changed by the agreement's field rule/,
      ],
    ];
    for (const [number, expected] of cases) {
      const message = await refusal(recordFiledArgs(companyId, { number }, "--yes"));
      if (typeof expected === "string") expect(message, number).toBe(expected);
      else expect(message, number).toMatch(expected);
      expect(writtenFor(companyId)).toEqual(before);
    }
  });

  test("--filing-number in the sandbox stand-in space is refused for a production company, on the filing key, and nothing is written", async () => {
    const companyId = paidCompany();
    db.prepare("UPDATE companies SET environment = 'production' WHERE company_id = ?").run(
      companyId,
    );
    const before = writtenFor(companyId);
    for (const number of [
      "TEST-STANDIN-D36A9A6177333DB7",
      "TEST-STAND-IN-0001",
      "test-standin-0001",
    ])
      expect(await refusal(recordFiledArgs(companyId, { number }, "--yes")), number).toBe(
        "refusing: --filing-number is in the range kept for sandbox stand-ins (TEST-STANDIN-): record a production company's filing with the number on the State's record",
      );
    expect(writtenFor(companyId)).toEqual(before);
    // The State's number goes through.
    await run(recordFiledArgs(companyId, {}, "--yes"));
    expect(companies.find(companyId)?.filingNumber).toBe("2026-000451207");
  });

  test("--legal-name is stored exactly as typed: a name with no entity ending is written with the warning, one that matches no option with its own", async () => {
    const beacon = paidCompany({ names: ["Beacon Works", "Beacon Works Two"] });
    const { output } = await run<FiledRecorded>(
      recordFiledArgs(beacon, { name: "Beacon Works" }, "--yes"),
    );
    expect(output).toMatchObject({ recorded: true, legalNameFiled: "Beacon Works", matched: true });
    expect(output.warnings).toEqual([NO_ENTITY_ENDING]);
    expect(companies.find(beacon)?.legalNameFiled).toBe("Beacon Works");

    // Neither a stored option nor an ending: both warnings, in the dry run too.
    const other = paidCompany();
    const { output: dry } = await run<{ warnings: string[]; matched: boolean }>(
      recordFiledArgs(other, { name: "Lantern Labs" }),
    );
    expect(dry.matched).toBe(false);
    expect(dry.warnings).toEqual([expect.stringMatching(NO_STORED_OPTION), NO_ENTITY_ENDING]);

    // A name the rule would change is refused as typed, under its own flag.
    expect(await refusal(recordFiledArgs(other, { name: "Lantern  Works LLC" }, "--yes"))).toMatch(
      /^refusing: --legal-name would be changed by the agreement's field rule/,
    );
    expect(await refusal(recordFiledArgs(other, { name: 'Lantern "Works" LLC' }, "--yes"))).toBe(
      "refusing: --legal-name holds a double quote",
    );
    expect(companies.find(other)?.legalNameFiled).toBeNull();
  });

  test("--articles is held to the operator document rules, under its own flag, and nothing is written", async () => {
    const companyId = paidCompany();
    const before = writtenFor(companyId);
    const cases: [string, string][] = [
      [
        fileOf("text.pdf", Buffer.from("not a pdf")),
        "refusing: --articles is not a PDF: its bytes do not start with %PDF-",
      ],
      [fileOf("empty.pdf", Buffer.alloc(0)), "refusing: --articles is empty"],
      [join(dir, "missing.pdf"), "refusing: --articles cannot be read (ENOENT)"],
      [dir, "refusing: --articles must name a file"],
    ];
    for (const [articles, expected] of cases) {
      expect(await refusal(recordFiledArgs(companyId, { articles }, "--yes")), expected).toBe(
        expected,
      );
      expect(writtenFor(companyId).steps).toEqual(before.steps);
      expect(writtenFor(companyId).documents).toEqual([]);
    }
  });

  test("refuses the reserved operator name system, and a name the operator rule refuses", async () => {
    const companyId = paidCompany();
    expect(await refusal(recordFiledArgs(companyId, { operator: "system" }, "--yes"))).toMatch(
      /^refusing: --operator system is reserved/,
    );
    expect(await refusal(recordFiledArgs(companyId, { operator: "Ops Example" }, "--yes"))).toMatch(
      /^refusing: --operator must match/,
    );
    expect(requests.stepsOf(companyId)).toEqual([]);
  });
});

// ── record-ein ────────────────────────────────────────────────────────────────────────────────

describe("formation:record-ein", () => {
  test("with --ein: confirms the EIN step of a recorded company and stores the EIN, and no line it prints carries the value", async () => {
    const b = paidCompany();
    await run(recordFiledArgs(b, {}, "--yes"));
    expect(einIssued(requests.stepsOf(b))).toBe(false);

    const { output, ops, lines } = await run<Record<string, unknown>>(
      recordEinArgs(b, "--ein", "12-3456789", "--yes"),
    );
    expect(einIssued(requests.stepsOf(b))).toBe(true);
    expect(companies.find(b)?.ein).toBe("12-3456789");
    expect(rowOf(b, "await_ein")).toMatchObject({ state: "confirmed", providerRef: MANUAL_REF });
    expect(parseDetail(rowOf(b, "await_ein")!.detail)).toEqual({
      recordedBy: OPERATOR,
      observedAt: expect.any(Number),
    });
    expect(output).toEqual({
      recorded: true,
      companyId: b,
      withValue: true,
      operator: OPERATOR,
      operatorOsUser: OS_USER,
    });
    expect(ops).toEqual([
      {
        opslog: "formation_recorded_ein",
        at: expect.any(String),
        companyId: b,
        withValue: true,
        operator: OPERATOR,
        operatorOsUser: OS_USER,
      },
    ]);
    for (const line of lines) expect(line).not.toContain("3456789");
    // A legal-body company has no entity, so the `formationEin` event reaches none.
    expect(entityEventCount()).toBe(0);

    // A second EIN on a company that holds one: refused, whatever its value.
    for (const ein of ["12-3456789", "98-7654321"])
      expect(await refusal(recordEinArgs(b, "--ein", ein, "--yes")), ein).toBe(
        `refusing: company ${b} already holds an EIN: nothing to record`,
      );
    expect(companies.find(b)?.ein).toBe("12-3456789");
  });

  test("an EIN step confirmed without a value takes the EIN later, once; without --ein a second run is refused", async () => {
    const b = paidCompany();
    await run(recordFiledArgs(b, {}, "--yes"));
    await run(recordEinArgs(b, "--yes"));
    const confirmed = rowOf(b, "await_ein");
    expect(confirmed?.state).toBe("confirmed");
    expect(companies.find(b)?.ein).toBeNull();

    expect(await refusal(recordEinArgs(b, "--yes"))).toBe(
      `refusing: the EIN step of company ${b} is already recorded (await_ein is confirmed): pass --ein to store the EIN it lacks`,
    );

    // The dry run of the addition writes nothing.
    const { output: dry, ops: dryOps } = await run<Record<string, unknown>>(
      recordEinArgs(b, "--ein", "12-3456789"),
    );
    expect(dry).toMatchObject({ recorded: false, wouldRecord: { withValue: true } });
    expect(dryOps).toEqual([]);
    expect(companies.find(b)?.ein).toBeNull();

    const { output, ops, lines } = await run<Record<string, unknown>>(
      recordEinArgs(b, "--ein", "12-3456789", "--yes"),
    );
    expect(output).toEqual({
      recorded: true,
      companyId: b,
      withValue: true,
      operator: OPERATOR,
      operatorOsUser: OS_USER,
    });
    expect(ops).toEqual([
      {
        opslog: "formation_recorded_ein",
        at: expect.any(String),
        companyId: b,
        withValue: true,
        operator: OPERATOR,
        operatorOsUser: OS_USER,
      },
    ]);
    for (const line of lines) expect(line).not.toContain("3456789");
    expect(companies.find(b)?.ein).toBe("12-3456789");
    // The step itself stays as the first run confirmed it.
    expect(rowOf(b, "await_ein")).toEqual(confirmed);

    expect(await refusal(recordEinArgs(b, "--ein", "98-7654321", "--yes"))).toBe(
      `refusing: company ${b} already holds an EIN: nothing to record`,
    );
    expect(companies.find(b)?.ein).toBe("12-3456789");
  });

  test("without --ein: the step is confirmed with no value stored; the dry run writes nothing", async () => {
    const b = paidCompany();
    await run(recordFiledArgs(b, {}, "--yes"));
    const before = writtenFor(b);
    const { output: dry, ops: dryOps } = await run<Record<string, unknown>>(recordEinArgs(b));
    expect(dry).toMatchObject({ recorded: false, companyId: b, wouldRecord: { withValue: false } });
    expect(dryOps).toEqual([]);
    expect(writtenFor(b)).toEqual(before);

    const { output } = await run<Record<string, unknown>>(recordEinArgs(b, "--yes"));
    expect(output).toMatchObject({ recorded: true, withValue: false });
    expect(einIssued(requests.stepsOf(b))).toBe(true);
    expect(companies.find(b)?.ein).toBeNull();
  });

  test("refuses a company the API tracks, one with no record, and an EIN not written NN-NNNNNNN", async () => {
    const fake = fakeSandboxDoola({}, { now: () => FILING_CLOCK });
    const a = paidCompany();
    await filedThroughTheApi(a, fake);
    const beforeA = writtenFor(a);
    expect(await refusal(recordEinArgs(a, "--ein", "12-3456789", "--yes"))).toBe(
      "refusing: the API tracks this company's EIN: nothing to record",
    );
    expect(writtenFor(a)).toEqual(beforeA);

    const unrecorded = paidCompany();
    expect(await refusal(recordEinArgs(unrecorded, "--yes"))).toBe(
      `refusing: company ${unrecorded} has no filing recorded by hand: formation:record-filed records it first`,
    );
    expect(requests.stepsOf(unrecorded)).toEqual([]);

    const b = paidCompany();
    await run(recordFiledArgs(b, {}, "--yes"));
    for (const ein of ["123456789", "12-345678", "12-34567890", "AB-3456789"])
      expect(await refusal(recordEinArgs(b, "--ein", ein, "--yes")), ein).toBe(
        "refusing: --ein must be written NN-NNNNNNN: two digits, a hyphen and seven digits",
      );
    expect(einIssued(requests.stepsOf(b))).toBe(false);
    expect(companies.find(b)?.ein).toBeNull();
  });
});
