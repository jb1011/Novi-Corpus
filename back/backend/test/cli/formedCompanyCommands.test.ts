/**
 * The operator's commands over a company Novi formed for a legal body: `company:dao-supplement`,
 * which records doola's amended articles (the DAO supplement doola files by hand) as an operator
 * document of the company.
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCompanyViews } from "../../src/api/views";
import { buildCli } from "../../src/cli/index";
import { companyNameOptions } from "../../src/formation/intake";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  DAO_SUPPLEMENT_DOC_TYPE,
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { ANVIL_ACCOUNT_2, CHAIN_ID, FACTORY } from "../helpers/customerCompanyFixtures";
import { seedCompany } from "../helpers/formationFakes";

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

    // One ops line: ids and the operator, never a path, a file name or a byte of the file.
    expect(ops).toEqual([
      expect.objectContaining({
        opslog: "dao_supplement_recorded",
        companyId,
        docId,
        operator: OPERATOR,
      }),
    ]);
    expect(Object.keys(ops[0] as object).sort()).toEqual(
      ["at", "companyId", "docId", "operator", "opslog"].sort(),
    );
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
    for (const more of [["--yes"], ["--replace", "--yes"]])
      expect(await refusal(supplementArgs(companyId, path, ...more))).toBe(
        `refusing: this file is already recorded on company ${companyId} as document ${output.document.docId}: the index keeps one row per file`,
      );
    expect(supplementRows(companyId)).toHaveLength(1);
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
