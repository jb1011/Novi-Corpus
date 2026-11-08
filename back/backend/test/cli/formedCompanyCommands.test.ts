/**
 * The operator's commands over a company Novi formed for a legal body: `company:dao-supplement`,
 * which records doola's amended articles (the DAO supplement doola files by hand) as an operator
 * document of the company, and `company:filed-name`, which sets the company's filed name from the
 * State's record when doola's reported name matched none of the stored options, or corrects it.
 *
 * Each command opens the database and the document store itself, through the configuration, so
 * every test here works in a temporary data directory: the database file and the document bytes
 * the commands write are both under it, and the test reads them through its own connection and
 * its own file store over the same paths.
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
import { listCompanyViews } from "../../src/api/views";
import { holdsFiledName } from "../../src/cli/formedCompanies";
import { buildCli } from "../../src/cli/index";
import { ApiError } from "../../src/errors";
import { companyNameOptions } from "../../src/formation/intake";
import { agreementDocNames } from "../../src/legalBody/agreement";
import { type LegalBodyOrderDeps, abandonOrder, createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  DAO_SUPPLEMENT_DOC_TYPE,
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import {
  type BindingState,
  SqliteLegalBodyRepository,
} from "../../src/persistence/legalBodyRepository";
import { advanceFormation } from "../../src/workflow/formationProcessor";
import {
  ACTION,
  ANVIL_ACCOUNT_2,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { MemoryDocumentStore, fakeDoola, seedCompany } from "../helpers/formationFakes";
import {
  type LegalBodyStores,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";
import { bodyIn } from "../helpers/legalBodyStatementFixtures";

/** anvil's published account #2: a test key, never a real wallet. */
const tenant: Address = ANVIL_ACCOUNT_2.address;
const OPERATOR = "ops.example";
const FILED_NAME = "Lantern Works LLC";
const FILING_NUMBER = "2026-000451207";
/** Unix seconds, at UTC midnight, as the processor writes `filed_at`. */
const FILED_AT = 1_793_664_000;

let dir: string;
let db: Database.Database;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let legalBodies: SqliteLegalBodyRepository;
let docStore: FileDocumentStore;
/** Every line written to standard output, the commands' and the ops lines alike. */
let printed: string[];
let n = 0;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "formed-companies-"));
  // The commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  legalBodies = new SqliteLegalBodyRepository(db);
  docStore = new FileDocumentStore(join(dir, "documents"));
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/**
 * A company formed through doola for `tenant`, its formation steps opened and `create_provider`
 * confirmed, as the saga leaves them. `filing` says how far the state got: `confirmed` writes the
 * filing facts the processor writes when it confirms `await_filing`; `submitted` leaves the step
 * waiting on the state; `none` leaves it pending.
 */
function formedCompany(
  opts: {
    purposeKind?: "agent" | "legal_body";
    provider?: string;
    filing?: "confirmed" | "submitted" | "none";
    legalNameFiled?: string | null;
  } = {},
): string {
  const companyId = seedCompany(companies, {
    companyId: `formed-${++n}`,
    tenantId: tenant,
    provider: opts.provider ?? "doola",
    purposeKind: opts.purposeKind ?? "legal_body",
    nameOptions: companyNameOptions("Lantern Works", "Lantern Works Two"),
    businessPurpose: "Software services.",
  });
  expect(requests.claimAllSteps(companyId)).toBe(true);
  expect(
    requests.transition(companyId, "create_provider", "pending", "confirmed", {
      providerRef: `doola-${companyId}`,
    }),
  ).toBe(true);
  const filing = opts.filing ?? "confirmed";
  if (filing === "none") return companyId;
  expect(requests.transition(companyId, "await_filing", "pending", filing)).toBe(true);
  companies.recordFilingFacts(companyId, {
    filedAt: FILED_AT,
    filingNumber: FILING_NUMBER,
    legalNameFiled: opts.legalNameFiled === undefined ? FILED_NAME : opts.legalNameFiled,
  });
  return companyId;
}

/** A draft legal body of the company, as the order door's first write leaves it. */
function draftBody(companyId: string): string {
  return legalBodies.create({
    tenantId: tenant,
    companyId,
    chainId: CHAIN_ID,
    factory: FACTORY,
    amendmentDelay: 172_800,
  }).legalBodyId;
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

const supplementRows = (companyId: string) =>
  documents.listByCompany(companyId).filter((d) => d.docType === DAO_SUPPLEMENT_DOC_TYPE);

const supplementArgs = (companyId: string, path: string, ...more: string[]) => [
  "company:dao-supplement",
  companyId,
  "--document",
  path,
  "--operator",
  OPERATOR,
  ...more,
];

/** The company as the tenant's list view serves it. */
const viewOf = (companyId: string) =>
  listCompanyViews(
    { companies, documents, formationSteps: (id) => requests.stepsOf(id) },
    tenant,
  ).find((v) => v.companyId === companyId);

// ── company:dao-supplement ────────────────────────────────────────────────────────────────────

describe("company:dao-supplement", () => {
  test("records the amended articles as an operator document, notes it on each legal body of the company, and the company view shows its hash", async () => {
    const companyId = formedCompany();
    const body = draftBody(companyId);
    const bytes = pdf("amended articles");
    const sha256 = sha256Of(bytes);
    const path = fileOf("amended-articles.pdf", bytes);
    const before = Math.floor(Date.now() / 1000);

    const { output, ops, lines } = await run<{
      recorded: true;
      companyId: string;
      document: { docId: string; sha256: string; size: number };
      replaced: string | null;
      legalBodies: string[];
      operator: string;
    }>(supplementArgs(companyId, path, "--yes"));

    const providerDocId = `operator:dao_supplement:${sha256}`;
    const docId = documentIndexId(companyId, providerDocId);
    expect(output).toMatchObject({
      recorded: true,
      companyId,
      document: { docId, sha256, size: bytes.length },
      replaced: null,
      legalBodies: [body],
      operator: OPERATOR,
    });

    // The index row: an operator's document, in the customer-upload spelling of its hash, with no
    // expiry, its time the database's own clock.
    const [row, ...more] = supplementRows(companyId);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      id: docId,
      companyId,
      docType: "dao_supplement",
      sha256,
      contentType: "application/pdf",
      size: bytes.length,
      providerDocId,
      path: documentStoreName(companyId, "dao_supplement", sha256.slice(2)),
      source: "operator",
      expiresAt: null,
      bytesDeletedAt: null,
    });
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(docStore.getBytes(row?.path as string).equals(bytes)).toBe(true);

    // The view reads the latest such row.
    const supplement = viewOf(companyId)?.daoSupplement;
    expect(supplement?.sha256).toBe(sha256);
    expect(supplement?.recordedAt).toBeGreaterThanOrEqual(before - 1);
    expect(supplement?.recordedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);

    // One note on the company's legal body, under the operator's name.
    const note = legalBodies.listEvents(body).at(-1);
    expect(note).toMatchObject({
      kind: "note",
      actor: `operator:${OPERATOR}`,
      txHash: null,
      detail: { act: "dao_supplement_recorded", docId },
    });

    // One ops line: ids, the operator and the OS user, never a path, a file name or a byte of
    // the file.
    expect(ops).toEqual([
      {
        opslog: "dao_supplement_recorded",
        at: expect.any(String),
        companyId,
        docId,
        operator: OPERATOR,
        operatorOsUser: OS_USER,
      },
    ]);
    const opsText = lines.filter(isOpsLine).join("\n");
    for (const leak of [dir, "amended-articles", "%PDF", FILED_NAME, sha256])
      expect(opsText).not.toContain(leak);
  });

  test("a company with no legal body yet is recorded all the same, with no note", async () => {
    const companyId = formedCompany();
    const { output } = await run(
      supplementArgs(companyId, fileOf("a.pdf", pdf("no body")), "--yes"),
    );
    expect(output).toMatchObject({ recorded: true, legalBodies: [] });
    expect(supplementRows(companyId)).toHaveLength(1);
  });

  test("without --yes it says what it would record and writes nothing: no row, no file, no note, no ops line", async () => {
    const companyId = formedCompany();
    const body = draftBody(companyId);
    const eventsBefore = legalBodies.listEvents(body).length;
    const bytes = pdf("dry run");
    const { output, ops } = await run(supplementArgs(companyId, fileOf("dry.pdf", bytes)));
    expect(output).toMatchObject({
      recorded: false,
      companyId,
      wouldRecord: { sha256: sha256Of(bytes), size: bytes.length, source: "operator" },
      legalBodies: [body],
    });
    expect(output.next).toMatch(/--yes/);
    expect(ops).toEqual([]);
    expect(supplementRows(companyId)).toEqual([]);
    expect(() =>
      docStore.getBytes(documentStoreName(companyId, "dao_supplement", sha256Of(bytes).slice(2))),
    ).toThrow();
    expect(legalBodies.listEvents(body)).toHaveLength(eventsBefore);
  });

  test("refuses a company the State has not filed yet", async () => {
    const path = fileOf("early.pdf", pdf("early"));
    for (const filing of ["none", "submitted"] as const) {
      const companyId = formedCompany({ filing });
      expect(await refusal(supplementArgs(companyId, path, "--yes"))).toMatch(
        /^refusing: the State's filing of company formed-\d+ is not confirmed yet/,
      );
      expect(supplementRows(companyId)).toEqual([]);
    }
  });

  test("refuses a company that is not a doola company formed for a legal body, and an unknown one", async () => {
    const path = fileOf("other.pdf", pdf("other"));
    const forAgents = formedCompany({ purposeKind: "agent" });
    expect(await refusal(supplementArgs(forAgents, path, "--yes"))).toMatch(
      /^refusing: company formed-\d+ was formed for agents, not for a legal body/,
    );
    const declared = formedCompany({ provider: "customer" });
    expect(await refusal(supplementArgs(declared, path, "--yes"))).toMatch(
      /^refusing: company formed-\d+ was not formed through doola \(provider customer\)/,
    );
    expect(await refusal(supplementArgs("no-such-company", path, "--yes"))).toBe(
      "refusing: no company no-such-company",
    );
    expect(supplementRows(forAgents)).toEqual([]);
    expect(supplementRows(declared)).toEqual([]);
  });

  test("refuses a file that is not a PDF, an empty one, one over 10 MiB and one that cannot be read; the refusal names no path", async () => {
    const companyId = formedCompany();
    const cases: [string, string, RegExp][] = [
      [
        "not a PDF",
        fileOf("notes.pdf", Buffer.from("plain text, not a PDF\n")),
        /^refusing: --document is not a PDF/,
      ],
      ["empty", fileOf("empty.pdf", Buffer.alloc(0)), /^refusing: --document is empty/],
      [
        "too large",
        fileOf(
          "large.pdf",
          Buffer.concat([pdf("large"), Buffer.alloc(10 * 1024 * 1024 + 1 - pdf("large").length)]),
        ),
        /^refusing: --document is over 10 MiB/,
      ],
      ["missing", join(dir, "missing.pdf"), /^refusing: --document cannot be read \(ENOENT\)/],
      ["a directory", dir, /^refusing: --document must name a file/],
    ];
    for (const [name, path, expected] of cases) {
      const message = await refusal(supplementArgs(companyId, path, "--yes"));
      expect(message, name).toMatch(expected);
      expect(message, name).not.toContain(dir);
    }
    expect(supplementRows(companyId)).toEqual([]);
  });

  test("exactly 10 MiB is taken", async () => {
    const companyId = formedCompany();
    const head = pdf("ten mebibytes");
    const bytes = Buffer.concat([head, Buffer.alloc(10 * 1024 * 1024 - head.length)]);
    const { output } = await run(supplementArgs(companyId, fileOf("ten.pdf", bytes), "--yes"));
    expect(output).toMatchObject({ recorded: true, document: { size: 10 * 1024 * 1024 } });
  });

  test("a second recording is refused without --replace; with it the index keeps both and the view shows the latest", async () => {
    const companyId = formedCompany();
    const first = pdf("first articles");
    const second = pdf("second articles");
    const { output: one } = await run<{ document: { docId: string } }>(
      supplementArgs(companyId, fileOf("one.pdf", first), "--yes"),
    );

    expect(await refusal(supplementArgs(companyId, fileOf("two.pdf", second), "--yes"))).toMatch(
      new RegExp(
        `^refusing: company ${companyId} already has amended articles recorded \\(document ${one.document.docId}`,
      ),
    );
    expect(supplementRows(companyId)).toHaveLength(1);
    // The refused file never reached the store.
    expect(() =>
      docStore.getBytes(documentStoreName(companyId, "dao_supplement", sha256Of(second).slice(2))),
    ).toThrow();
    expect(storeFiles()).toHaveLength(1);

    const { output: two, ops } = await run<{ replaced: string | null }>(
      supplementArgs(companyId, join(dir, "two.pdf"), "--replace", "--yes"),
    );
    expect(two.replaced).toBe(one.document.docId);
    expect(ops).toHaveLength(1);
    // Both rows stay (listed in no order that says which came first: one second holds both).
    expect(
      supplementRows(companyId)
        .map((r) => r.sha256)
        .sort(),
    ).toEqual([sha256Of(first), sha256Of(second)].sort());
    // The view shows the one recorded last, though both rows carry the same second.
    expect(viewOf(companyId)?.daoSupplement?.sha256).toBe(sha256Of(second));
  });

  test("the same file twice is refused, with --replace too: the index keeps one row per file", async () => {
    const companyId = formedCompany();
    const path = fileOf("same.pdf", pdf("same"));
    const { output } = await run<{ document: { docId: string } }>(
      supplementArgs(companyId, path, "--yes"),
    );
    const stored = storeFiles();
    for (const more of [["--yes"], ["--replace", "--yes"]])
      expect(await refusal(supplementArgs(companyId, path, ...more))).toBe(
        `refusing: this file is already recorded on company ${companyId} as document ${output.document.docId}: the index keeps one row per file`,
      );
    expect(supplementRows(companyId)).toHaveLength(1);
    // The store holds the one file, as it was.
    expect(storeFiles()).toEqual(stored);
    expect(stored).toHaveLength(1);
    expect(
      docStore.getBytes(supplementRows(companyId)[0]?.path as string).equals(pdf("same")),
    ).toBe(true);
  });

  test("a statement that fails inside the write leaves no row, no note and no file: the bytes are written last", async () => {
    const companyId = formedCompany();
    const body = draftBody(companyId);
    const eventsBefore = legalBodies.listEvents(body).length;
    // The note fails after the row is inserted, as any later statement of the write might.
    db.exec(`CREATE TRIGGER test_note_fails BEFORE INSERT ON legal_body_events
             BEGIN SELECT RAISE(ABORT, 'the note cannot be written'); END`);
    expect(
      await refusal(supplementArgs(companyId, fileOf("fails.pdf", pdf("fails")), "--yes")),
    ).toBe("the note cannot be written");
    db.exec("DROP TRIGGER test_note_fails");
    expect(supplementRows(companyId)).toEqual([]);
    expect(legalBodies.listEvents(body)).toHaveLength(eventsBefore);
    expect(storeFiles()).toEqual([]);
  });

  test("refuses an operator name out of the rule, and the reserved name system", async () => {
    const companyId = formedCompany();
    const path = fileOf("op.pdf", pdf("operator"));
    const args = (operator: string) => [
      "company:dao-supplement",
      companyId,
      "--document",
      path,
      "--operator",
      operator,
      "--yes",
    ];
    expect(await refusal(args("Ops Example"))).toMatch(/^refusing: --operator must match/);
    expect(await refusal(args("system"))).toMatch(/^refusing: --operator system is reserved/);
    expect(supplementRows(companyId)).toEqual([]);
  });
});

// ── company:filed-name ────────────────────────────────────────────────────────────────────────

/** A name a Wyoming LLC may carry that `normalizeCompanyName` does not strip an ending from, so it
 *  matches none of the stored options "Lantern Works" and "Lantern Works Two". */
const UNMATCHED_NAME = "Lantern Works Ltd. Liability Co.";

/** The order stores over the test's own connection: the order door and the commands share the
 *  database file. */
function orderStores(): { s: LegalBodyStores; deps: LegalBodyOrderDeps } {
  const s = openLegalBodyStores(db, new MemoryDocumentStore());
  if (s.store.findByTenant(tenant, ACTION) === undefined)
    recordHuman(s.store, tenant, "3101", Date.now());
  const deps = legalBodyOrderDeps(s, {
    chain: {} as LegalBodyChainPort,
    maxOpenPerTenant: 50,
    maxOrdersPerTenantPerDay: 50,
  });
  return { s, deps };
}

function orderRefusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("no refusal");
}

const filedNameArgs = (companyId: string, name: string, ...more: string[]) => [
  "company:filed-name",
  companyId,
  "--name",
  name,
  "--operator",
  OPERATOR,
  ...more,
];

const filedNameOf = (companyId: string) => companies.find(companyId)?.legalNameFiled;

/** A row of the company brought to `state` through the repository's own moves. */
let agents = 100;
function bodyOf(companyId: string, state: BindingState): string {
  const { s } = orderStores();
  agents += 1;
  if (state === "deployed" || state === "linked" || state === "broken" || state === "superseded")
    return bodyIn(state, s, companyId, { agentId: String(agents), tenant }).legalBodyId;
  const id = draftBody(companyId);
  if (state === "draft") return id;
  expect(s.repo.freezeAgreement(id, { hash: `0x${"ab".repeat(32)}`, version: 1 })).toBe(true);
  if (state === "abandoned") {
    expect(s.repo.abandon(id, "test")).toBe(true);
    return id;
  }
  expect(state).toBe("reserved");
  expect(
    s.repo.reserve(id, {
      agentId: String(agents),
      identityOwner: tenant,
      linkDigest: `0x${agents.toString(16).padStart(64, "0")}`,
      linkDeadline: 1_900_000_000,
      linkSignature: "0x01",
      bodyAddress: `0x${agents.toString(16).padStart(40, "0")}`,
      observedAtBlock: 1,
      firstCheckAt: Date.now(),
    }),
  ).toBe("reserved");
  return id;
}

interface FiledNameRecorded {
  recorded: true;
  companyId: string;
  legalNameFiled: string;
  replaced: string | null;
  matched: boolean;
  warnings?: string[];
  legalBodies: string[];
  operator: string;
  operatorOsUser: string;
}

const NO_STORED_OPTION = /^matches no stored option/;
const NO_ENTITY_ENDING =
  "no entity ending (LLC, L.L.C., Limited Liability Company): the State's record of an LLC carries its ending; check the name";

/** One poll of the formation processor, doola reporting the company filed under `name`. */
async function poll(companyId: string, name: string): Promise<void> {
  const doola = fakeDoola({
    company: {
      doolaCompanyId: `doola-${companyId}`,
      name,
      formationFilingDate: "2026-11-02",
      formationFilingNumber: FILING_NUMBER,
    },
  });
  await advanceFormation(
    {
      repo: new SqliteEntityRepository(db),
      companies,
      requests,
      documents,
      docStore: new MemoryDocumentStore(),
      doola: doola.api,
      environment: "sandbox",
      fetchImpl: doola.fetchImpl,
      lookupImpl: doola.lookupImpl,
      now: () => Date.now(),
    },
    companyId,
  );
}

describe("company:filed-name", () => {
  test("doola reports a name that matches no option: no filed name and no order; the operator sets it from the State's record, and the order then prints it", async () => {
    const companyId = formedCompany({ filing: "none" });
    // The processor confirms the filing, with doola's name matching none of the stored options.
    await poll(companyId, UNMATCHED_NAME);
    expect(requests.stepsOf(companyId).find((r) => r.step === "await_filing")?.state).toBe(
      "confirmed",
    );
    expect(companies.find(companyId)).toMatchObject({
      legalNameFiled: null,
      filingNumber: FILING_NUMBER,
    });
    const { deps } = orderStores();
    const refused = orderRefusal(() => createOrder(deps, tenant, { companyId }));
    expect(refused.code).toBe("company_not_eligible");
    expect(refused.message).toBe(LEGAL_BODY_SENTENCES.company_not_eligible);

    const { output, ops, lines } = await run<FiledNameRecorded>(
      filedNameArgs(companyId, UNMATCHED_NAME, "--yes"),
    );
    expect(output).toMatchObject({
      recorded: true,
      companyId,
      legalNameFiled: UNMATCHED_NAME,
      replaced: null,
      matched: false,
      legalBodies: [],
      operator: OPERATOR,
      operatorOsUser: OS_USER,
    });
    // Advice, in the one JSON object: the State's record is the truth, so it is written all the
    // same. The name carries an ending ("Ltd. Liability Co."), so that is the only advice.
    expect(output.warnings).toEqual([expect.stringMatching(NO_STORED_OPTION)]);
    // As typed: the State's record, never a stored option.
    expect(filedNameOf(companyId)).toBe(UNMATCHED_NAME);
    expect(ops).toEqual([
      {
        opslog: "filed_name_recorded",
        at: expect.any(String),
        companyId,
        matched: false,
        replaced: false,
        operator: OPERATOR,
        operatorOsUser: OS_USER,
      },
    ]);
    const opsText = lines.filter((line) => isOpsLine(line)).join("\n");
    for (const leak of ["Lantern", "Ltd", "Liability"]) expect(opsText).not.toContain(leak);

    const view = createOrder(deps, tenant, { companyId });
    expect(view.state).toBe("draft");
    const terms = deps.docStore.get(agreementDocNames(view.id).terms);
    expect(terms).toContain(`# Operating Agreement of "${UNMATCHED_NAME}"`);
  });

  test("a name that is a stored option under normalizeCompanyName is matched, with no warning", async () => {
    const companyId = formedCompany({ legalNameFiled: null });
    const { output } = await run<FiledNameRecorded>(
      filedNameArgs(companyId, "Lantern Works LLC", "--yes"),
    );
    expect(output).toMatchObject({ recorded: true, matched: true, replaced: null });
    expect(output.warnings).toBeUndefined();
    expect(filedNameOf(companyId)).toBe("Lantern Works LLC");
  });

  test("a name with no entity ending is written with --yes, with a warning: the State's record of an LLC carries its ending", async () => {
    const companyId = formedCompany({ legalNameFiled: null });
    // A stored option, so only the missing ending is advised.
    const { output } = await run<FiledNameRecorded>(
      filedNameArgs(companyId, "Lantern Works", "--yes"),
    );
    expect(output).toMatchObject({ recorded: true, matched: true });
    expect(output.warnings).toEqual([NO_ENTITY_ENDING]);
    expect(filedNameOf(companyId)).toBe("Lantern Works");

    // Neither a stored option nor an ending: both, in the dry run too.
    const other = formedCompany({ legalNameFiled: null });
    const { output: dry } = await run<{ warnings: string[] }>(filedNameArgs(other, "Lantern Labs"));
    expect(dry.warnings).toEqual([expect.stringMatching(NO_STORED_OPTION), NO_ENTITY_ENDING]);

    // Every spelling of the ending counts as one.
    for (const name of [
      "Lantern Works L.L.C.",
      "Lantern Works, llc",
      "Lantern Works Limited Liability Company",
      "Lantern Works Ltd. Liability Co.",
    ]) {
      const companyId = formedCompany({ legalNameFiled: null });
      const { output } = await run<FiledNameRecorded>(filedNameArgs(companyId, name));
      expect(output.warnings ?? [], name).not.toContain(NO_ENTITY_ENDING);
    }
  });

  test("without --yes it says what it would set, with the same warning, and writes nothing", async () => {
    const companyId = formedCompany({ legalNameFiled: null });
    const { output, ops } = await run(filedNameArgs(companyId, UNMATCHED_NAME));
    expect(output).toMatchObject({
      recorded: false,
      companyId,
      current: null,
      wouldRecord: { legalNameFiled: UNMATCHED_NAME },
      matched: false,
    });
    expect(output.warnings).toEqual([expect.stringMatching(NO_STORED_OPTION)]);
    expect(output.next).toMatch(/--yes/);
    expect(ops).toEqual([]);
    expect(filedNameOf(companyId)).toBeNull();
  });

  test("a set name is refused without --replace, and corrected with it", async () => {
    const companyId = formedCompany();
    expect(await refusal(filedNameArgs(companyId, "Lantern Works, LLC", "--yes"))).toBe(
      `refusing: company ${companyId} already holds a filed name: pass --replace to correct it`,
    );
    expect(filedNameOf(companyId)).toBe(FILED_NAME);

    const { output, ops } = await run<FiledNameRecorded>(
      filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes"),
    );
    expect(output).toMatchObject({
      recorded: true,
      legalNameFiled: "Lantern Works, LLC",
      replaced: FILED_NAME,
      matched: true,
    });
    expect(ops).toEqual([
      expect.objectContaining({ replaced: true, matched: true, operatorOsUser: OS_USER }),
    ]);
    expect(filedNameOf(companyId)).toBe("Lantern Works, LLC");

    // The same name again replaces nothing.
    expect(
      await refusal(filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes")),
    ).toBe(`refusing: company ${companyId} already holds this filed name: nothing to replace`);
  });

  test("--replace is refused while an open order's agreement prints the current name; once the draft is abandoned, the name is corrected", async () => {
    const companyId = formedCompany();
    const { deps } = orderStores();
    const order = createOrder(deps, tenant, { companyId });

    expect(
      await refusal(filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes")),
    ).toBe(
      `refusing: this company has an open legal-body order; its agreement prints the current name: the order ${order.id} must be abandoned first (its guardian abandons the draft, or it expires 24 hours after it was ordered)`,
    );
    expect(filedNameOf(companyId)).toBe(FILED_NAME);

    await abandonOrder(deps, tenant, order.id);
    const { output } = await run<FiledNameRecorded>(
      filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes"),
    );
    expect(output).toMatchObject({ recorded: true, replaced: FILED_NAME, legalBodies: [order.id] });
    // The abandoned order is told, with ids only.
    expect(legalBodies.listEvents(order.id).at(-1)).toMatchObject({
      kind: "note",
      actor: `operator:${OPERATOR}`,
      txHash: null,
      detail: { act: "filed_name_recorded", companyId },
    });
  });

  test("an operator's correction survives the next poll that matches a stored option", async () => {
    const companyId = formedCompany({ filing: "none" });
    await poll(companyId, "Lantern Works");
    expect(filedNameOf(companyId)).toBe("Lantern Works LLC");
    await run(filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes"));
    expect(filedNameOf(companyId)).toBe("Lantern Works, LLC");
    await poll(companyId, "Lantern Works");
    await poll(companyId, "Lantern Works Two");
    expect(filedNameOf(companyId)).toBe("Lantern Works, LLC");
  });

  test("a draft past its 24 hours no longer holds the name", async () => {
    const companyId = formedCompany();
    bodyOf(companyId, "draft");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      const { output } = await run<FiledNameRecorded>(
        filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes"),
      );
      expect(output).toMatchObject({ recorded: true, replaced: FILED_NAME });
    } finally {
      vi.useRealTimers();
    }
  });

  test("--replace is refused for an order on its way, and for a body that is or was linked; a closed one does not hold the name", async () => {
    const cases: [BindingState, string][] = [
      ["reserved", "an open legal-body order"],
      ["deployed", "an open legal-body order"],
      ["linked", "a linked legal body"],
      ["broken", "a linked legal body"],
      ["superseded", "a linked legal body"],
    ];
    for (const [state, kind] of cases) {
      const companyId = formedCompany();
      bodyOf(companyId, state);
      expect(
        await refusal(filedNameArgs(companyId, "Lantern Works, LLC", "--replace", "--yes")),
        state,
      ).toBe(`refusing: this company has ${kind}; its agreement prints the current name`);
      expect(filedNameOf(companyId), state).toBe(FILED_NAME);
    }

    const closed = formedCompany();
    const body = bodyOf(closed, "abandoned");
    const { output } = await run<FiledNameRecorded>(
      filedNameArgs(closed, "Lantern Works, LLC", "--replace", "--yes"),
    );
    expect(output).toMatchObject({ recorded: true, replaced: FILED_NAME, legalBodies: [body] });
    expect(legalBodies.listEvents(body).at(-1)?.detail).toEqual({
      act: "filed_name_recorded",
      companyId: closed,
    });
  });

  test("a binding state this build does not know holds the name: the rule fails closed", () => {
    const createdAt = "2026-11-08 12:00:00";
    const nowMs = Date.parse("2026-11-08T13:00:00Z");
    const cases: [string, ReturnType<typeof holdsFiledName>][] = [
      ["draft", "open"],
      ["reserved", "open"],
      ["deployed", "open"],
      ["linked", "linked"],
      ["broken", "linked"],
      ["superseded", "linked"],
      ["lapsed", undefined],
      ["abandoned", undefined],
      ["frozen", "unknown"],
    ];
    for (const [state, expected] of cases)
      expect(holdsFiledName({ bindingState: state as BindingState, createdAt }, nowMs), state).toBe(
        expected,
      );
    // A draft past its 24 hours holds nothing.
    expect(
      holdsFiledName({ bindingState: "draft", createdAt }, nowMs + 24 * 60 * 60 * 1000),
    ).toBeUndefined();
  });

  test("a first-time set is refused if the company has any legal-body order at all", async () => {
    // Not reachable through the doors: an order cannot exist without a filed name.
    const companyId = formedCompany({ legalNameFiled: null });
    bodyOf(companyId, "abandoned");
    expect(await refusal(filedNameArgs(companyId, UNMATCHED_NAME, "--yes"))).toMatch(
      new RegExp(`^refusing: company ${companyId} holds no filed name but has a legal-body order`),
    );
    expect(filedNameOf(companyId)).toBeNull();
  });

  test("a name the agreement's field rule refuses is refused with the rule's reason, and one the rule would change is refused as typed", async () => {
    const companyId = formedCompany({ legalNameFiled: null });
    const cases: [string, string][] = [
      ['Lantern "Works" LLC', "refusing: --name holds a double quote"],
      ["Lantern​Works LLC", "refusing: --name holds a control or invisible character"],
      ["Lantern Works LLC", "refusing: --name holds a space other than a plain space"],
      ["L", "refusing: --name must be 2 to 200 characters long"],
      [
        "Lantern {guardian} LLC",
        "refusing: --name may hold only the characters a Wyoming entity name takes: A-Z, a-z, 0-9, spaces and & ' - , . ( ) +",
      ],
    ];
    for (const [name, expected] of cases)
      expect(await refusal(filedNameArgs(companyId, name, "--yes")), name).toBe(expected);
    for (const name of [" Lantern Works LLC", "Lantern Works LLC ", "Lantern  Works LLC"])
      expect(await refusal(filedNameArgs(companyId, name, "--yes")), name).toMatch(
        /^refusing: --name would be changed by the agreement's field rule/,
      );
    expect(filedNameOf(companyId)).toBeNull();
  });

  test("refuses a company the State has not filed, one not formed through doola for a legal body, and an unknown one", async () => {
    for (const filing of ["none", "submitted"] as const) {
      const companyId = formedCompany({ filing, legalNameFiled: null });
      expect(await refusal(filedNameArgs(companyId, UNMATCHED_NAME, "--yes"))).toMatch(
        /^refusing: the State's filing of company formed-\d+ is not confirmed yet/,
      );
    }
    const forAgents = formedCompany({ purposeKind: "agent", legalNameFiled: null });
    expect(await refusal(filedNameArgs(forAgents, UNMATCHED_NAME, "--yes"))).toMatch(
      /^refusing: company formed-\d+ was formed for agents, not for a legal body/,
    );
    const declared = formedCompany({ provider: "customer", legalNameFiled: null });
    expect(await refusal(filedNameArgs(declared, UNMATCHED_NAME, "--yes"))).toMatch(
      /^refusing: company formed-\d+ was not formed through doola \(provider customer\)/,
    );
    expect(await refusal(filedNameArgs("no-such-company", UNMATCHED_NAME, "--yes"))).toBe(
      "refusing: no company no-such-company",
    );
    expect(filedNameOf(forAgents)).toBeNull();
    expect(filedNameOf(declared)).toBeNull();
  });

  test("refuses the reserved operator name system", async () => {
    const companyId = formedCompany({ legalNameFiled: null });
    expect(
      await refusal([
        "company:filed-name",
        companyId,
        "--name",
        UNMATCHED_NAME,
        "--operator",
        "system",
        "--yes",
      ]),
    ).toMatch(/^refusing: --operator system is reserved/);
    expect(filedNameOf(companyId)).toBeNull();
  });
});
