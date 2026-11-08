import { readFileSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { companyFiled, stepStateOf } from "../formation/status";
import { sha256Of } from "../legalBody/evidence";
import { opsLog } from "../observability/opsLog";
import { type CompanyRecord, SqliteCompanyRepository } from "../persistence/companyRepository";
import {
  DAO_SUPPLEMENT_DOC_TYPE,
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../persistence/documentIndexRepository";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteFormationRepository } from "../persistence/formationRepository";
import { SqliteLegalBodyRepository } from "../persistence/legalBodyRepository";
import type { FormationPin } from "../types";
import { OPERATOR_NAME, osUser, parseOperator, print, refuse, withDatabase } from "./operator";

/**
 * THE OPERATOR'S COMMANDS over a company Novi formed for a legal body, for what doola does by hand
 * and its API never reports: `company:dao-supplement` records doola's amended articles (the DAO
 * supplement to the company's articles) as an operator document of the company.
 *
 * Every command opens the database itself, through the configuration, prints ONE JSON object on
 * success and throws on a refusal (the entry point prints the message and exits non-zero). The
 * writing commands keep the rules of `company:check` (`cli/companyChecks.ts`):
 *  - without `--yes` they print what they would write and write nothing;
 *  - the rules and the write run in ONE immediate transaction, so nothing lands between them;
 *  - each write has one ops line, which carries ids, booleans and the operator: never a path, a
 *    file's bytes or a company's name.
 *
 * The supplement is RECORDED, never claimed: what the company view shows is when it was recorded
 * and the hash of its bytes, and no sentence calls the company a DAO from that alone.
 */

/** The formation provider whose companies these commands take: the one every pin names. */
const DOOLA: FormationPin["provider"] = "doola";
/** The platform writes under `system` (the legal-body events' own actor), so no operator may type
 *  it: a row under it would read as one nobody decided. */
const RESERVED_OPERATOR = { name: "system", purpose: "what the platform records by itself" };
const NEXT = "nothing was written: run the same command with --yes to record this";

/** The largest document the operator records, in bytes: 10 MiB. */
export const DAO_SUPPLEMENT_MAX_BYTES = 10 * 1024 * 1024;
/** The five bytes every PDF starts with. */
const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");

interface Stores {
  db: Database.Database;
  companies: SqliteCompanyRepository;
  requests: SqliteFormationRepository;
  documents: SqliteDocumentIndexRepository;
  bodies: SqliteLegalBodyRepository;
}

function storesOf(db: Database.Database): Stores {
  return {
    db,
    companies: new SqliteCompanyRepository(db),
    requests: new SqliteFormationRepository(db),
    documents: new SqliteDocumentIndexRepository(db),
    bodies: new SqliteLegalBodyRepository(db),
  };
}

/**
 * The company, held to what both commands need of it: filed through doola, for a legal body, and
 * filed by the State (`await_filing` confirmed, `companyFiled`, the rule the order door reads).
 */
function formedLegalBodyCompany(s: Stores, companyId: string): CompanyRecord {
  const company = s.companies.find(companyId);
  if (!company) refuse(`no company ${companyId}`);
  if (company.provider !== DOOLA)
    refuse(
      `company ${companyId} was not formed through doola (provider ${company.provider}): these commands take a company Novi formed`,
    );
  if (company.purposeKind !== "legal_body")
    refuse(`company ${companyId} was formed for agents, not for a legal body`);
  const steps = s.requests.stepsOf(companyId);
  if (!companyFiled(steps))
    refuse(
      `the State's filing of company ${companyId} is not confirmed yet (await_filing is ${stepStateOf(steps, "await_filing") ?? "missing"})`,
    );
  return company;
}

// ── company:dao-supplement ───────────────────────────────────────────────────────────────────

interface SupplementOptions {
  document: string;
  operator: string;
  replace?: boolean;
  yes?: boolean;
}

/** A file system call on `--document`, its failure refused by its code: never by the path. */
function readable<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    return refuse(
      `--document cannot be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
    );
  }
}

/**
 * The document's bytes: a file, not empty, at most 10 MiB, starting with the five bytes every PDF
 * starts with. Like a customer's upload, it is never parsed beyond those five bytes and its hash.
 * The size is asked before the file is read, so an oversized file is never read into memory, and
 * once more after, in case the file grew in between.
 */
function readSupplement(path: string): Buffer {
  const stat = readable(() => statSync(path));
  if (!stat.isFile()) refuse("--document must name a file");
  const over = () => refuse("--document is over 10 MiB");
  if (stat.size > DAO_SUPPLEMENT_MAX_BYTES) over();
  const bytes = readable(() => readFileSync(path));
  if (bytes.length === 0) refuse("--document is empty");
  if (bytes.length > DAO_SUPPLEMENT_MAX_BYTES) over();
  if (!PDF_SIGNATURE.equals(bytes.subarray(0, PDF_SIGNATURE.length)))
    refuse("--document is not a PDF: its bytes do not start with %PDF-");
  return bytes;
}

/**
 * Records doola's amended articles on a formed legal-body company: the bytes in the document
 * store, then their row in the index (`docType = dao_supplement`, `source = operator`, the hash in
 * the customer-upload spelling, `created_at` the database's own clock, which the view's
 * `latestOfType` orders by), then a note on every legal body of the company. A second recording
 * is refused unless `--replace`: the index keeps both rows and the view shows the latest. The same
 * file twice is refused either way: its row id is derived from its hash, and a row is never
 * rewritten.
 */
function recordDaoSupplement(companyId: string, opts: SupplementOptions): void {
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();
  const bytes = readSupplement(opts.document);
  const sha256 = sha256Of(bytes);
  const providerDocId = `operator:${DAO_SUPPLEMENT_DOC_TYPE}:${sha256}`;
  const docId = documentIndexId(companyId, providerDocId);
  // The whole hash in the name, without its 0x, as a customer's upload is named.
  const path = documentStoreName(companyId, DAO_SUPPLEMENT_DOC_TYPE, sha256.slice(2));
  const document = { docId, sha256, size: bytes.length };

  withDatabase((db, docStoreDir) => {
    const s = storesOf(db);
    const docStore = new FileDocumentStore(docStoreDir);
    const found = db
      .transaction(() => {
        formedLegalBodyCompany(s, companyId);
        const same = s.documents.findByProviderDocId(companyId, providerDocId);
        if (same !== undefined)
          refuse(
            `this file is already recorded on company ${companyId} as document ${same.id}: the index keeps one row per file`,
          );
        const latest = s.documents
          .latestOfType(DAO_SUPPLEMENT_DOC_TYPE, [companyId])
          .get(companyId);
        if (latest !== undefined && opts.replace !== true)
          refuse(
            `company ${companyId} already has amended articles recorded (document ${latest.id}, ${latest.createdAt} UTC): pass --replace to record this file as the latest; the index keeps both`,
          );
        const bodies = s.bodies.listByCompany(companyId).map((b) => b.legalBodyId);
        if (opts.yes !== true) return { latest, bodies, recordedAt: undefined };
        // The bytes first, so the row never points at a file that is not there.
        docStore.putBytes(path, bytes);
        const inserted = s.documents.insert({
          id: docId,
          companyId,
          docType: DAO_SUPPLEMENT_DOC_TYPE,
          sha256,
          contentType: "application/pdf",
          size: bytes.length,
          providerDocId,
          path,
          source: "operator",
        });
        // Unreachable: the lookup above found no row for this file, in this transaction.
        if (!inserted) throw new Error(`document index: ${docId} was indexed twice`);
        for (const id of bodies)
          s.bodies.recordEvent(id, "note", `operator:${operator}`, null, {
            act: "dao_supplement_recorded",
            docId,
          });
        return { latest, bodies, recordedAt: s.documents.findOwned(companyId, docId)?.createdAt };
      })
      .immediate();

    if (found.recordedAt === undefined) {
      print({
        recorded: false,
        companyId,
        wouldRecord: { ...document, docType: DAO_SUPPLEMENT_DOC_TYPE, source: "operator" },
        replaces: found.latest?.id ?? null,
        legalBodies: found.bodies,
        next: NEXT,
      });
      return;
    }
    opsLog("dao_supplement_recorded", { companyId, docId, operator });
    print({
      recorded: true,
      companyId,
      document: { ...document, recordedAt: found.recordedAt },
      replaced: found.latest?.id ?? null,
      legalBodies: found.bodies,
      operator,
      operatorOsUser,
    });
  });
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

export function registerFormedCompanyCommands(program: Command): void {
  program
    .command("company:dao-supplement")
    .argument("<companyId>", "the company Novi formed for a legal body, filed by the State")
    .description(
      "record doola's amended articles (the DAO supplement doola files by hand) as an operator document of a formed company; the company view shows the latest one recorded",
    )
    .requiredOption("--document <path.pdf>", "the PDF doola sent, at most 10 MiB")
    .requiredOption("--operator <name>", `who records: ${OPERATOR_NAME.source}`)
    .option(
      "--replace",
      "record it although the company already has one: the index keeps both, the view shows this one",
    )
    .option("--yes", "confirm: record the document")
    .action((companyId: string, opts: SupplementOptions) => recordDaoSupplement(companyId, opts));
}
