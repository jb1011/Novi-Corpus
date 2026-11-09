import { readFileSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { hasEntityEnding } from "../formation/intake";
import { companyFiled, stepStateOf } from "../formation/status";
import { COMPANY_NAME } from "../legalBody/companyFields";
import { sha256Of, startsAsPdf } from "../legalBody/evidence";
import { type FieldProblem, applyTextRule } from "../legalBody/textRules";
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
import {
  type LegalBodyRecord,
  SqliteLegalBodyRepository,
  isDraftExpired,
} from "../persistence/legalBodyRepository";
import type { FormationPin } from "../types";
import { matchFiledNameAgainst } from "../workflow/formationProcessor";
import { OPERATOR_NAME, osUser, parseOperator, print, refuse, withDatabase } from "./operator";

/**
 * THE OPERATOR'S COMMANDS over a company Novi formed for a legal body, for what doola does by hand
 * or its API cannot settle:
 *  - `company:dao-supplement` records doola's amended articles (the DAO supplement to the
 *    company's articles) as an operator document of the company;
 *  - `company:filed-name` sets the company's filed name from the State's record, when doola's
 *    reported name matched none of the stored options (so the processor stored none), or corrects
 *    it before any agreement prints it.
 *
 * Every command opens the database itself, through the configuration, prints ONE JSON object on
 * success and throws on a refusal (the entry point prints the message and exits non-zero). The
 * writing commands keep the rules of `company:check` (`cli/companyChecks.ts`):
 *  - without `--yes` they print what they would write and write nothing;
 *  - the rules and the write run in ONE immediate transaction, so nothing lands between them;
 *  - each write has one ops line, which carries ids, booleans, the operator and the OS user that
 *    ran the command: never a path, a file's bytes or a company's name;
 *  - every legal body of the company gets a note event under `operator:<name>`, with ids only.
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
 * The company, held to what both commands need of it: filed through doola, for a legal body, not
 * abandoned (the order door never takes an abandoned company, `companyEligible`), and filed by the
 * State (`await_filing` confirmed, `companyFiled`, the rule the order door reads).
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
  if (company.status === "abandoned")
    refuse(`company ${companyId} is abandoned: nothing can be recorded on it`);
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
  if (!startsAsPdf(bytes)) refuse("--document is not a PDF: its bytes do not start with %PDF-");
  return bytes;
}

/**
 * Records doola's amended articles on a formed legal-body company: their row in the index
 * (`docType = dao_supplement`, `source = operator`, the hash in the customer-upload spelling,
 * `created_at` the database's own clock, which the view's `latestOfType` orders by), a note on
 * every legal body of the company, then the bytes in the document store. A second recording is
 * refused unless `--replace`: the index keeps both rows and the view shows the latest. The same
 * file twice is refused either way: its row id is derived from its hash, and a row is never
 * rewritten.
 *
 * The bytes are written LAST, inside the transaction: a statement that fails rolls the row and the
 * notes back before any file exists, and a failed file write rolls them back too. Other
 * connections see the row only once the transaction commits, after the file is in place, so a row
 * never points at a file that is not there.
 *
 * The company is checked before the file is read, so a wrong company id is refused as such
 * whatever `--document` names; the transaction checks it again, since the check before it holds
 * no lock.
 */
function recordDaoSupplement(companyId: string, opts: SupplementOptions): void {
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();

  withDatabase((db, docStoreDir) => {
    const s = storesOf(db);
    formedLegalBodyCompany(s, companyId);
    const bytes = readSupplement(opts.document);
    const sha256 = sha256Of(bytes);
    const providerDocId = `operator:${DAO_SUPPLEMENT_DOC_TYPE}:${sha256}`;
    const docId = documentIndexId(companyId, providerDocId);
    // The whole hash in the name, without its 0x, as a customer's upload is named.
    const path = documentStoreName(companyId, DAO_SUPPLEMENT_DOC_TYPE, sha256.slice(2));
    const document = { docId, sha256, size: bytes.length };
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
        if (opts.yes !== true) return { written: false as const, latest, bodies };
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
        const row = s.documents.findOwned(companyId, docId);
        // Unreachable: the row was inserted above, in this transaction.
        if (row === undefined) throw new Error(`document index: ${docId} vanished`);
        // Last: see above.
        docStore.putBytes(path, bytes);
        return { written: true as const, latest, bodies, recordedAt: row.createdAt };
      })
      .immediate();

    if (!found.written) {
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
    opsLog("dao_supplement_recorded", { companyId, docId, operator, operatorOsUser });
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

// ── company:filed-name ───────────────────────────────────────────────────────────────────────

/** The advice `company:filed-name` gives; neither refuses: the State's record is the truth. */
const NO_STORED_OPTION =
  "matches no stored option: the State's record is the truth, so it is written as typed; check it against the record once more";
const NO_ENTITY_ENDING =
  "no entity ending (LLC, L.L.C., Limited Liability Company): the State's record of an LLC carries its ending; check the name";
/** The order door holds a formed company to its filed name AND its filing number
 *  (`filedCompanyNames`); this build has no command that records the number. */
const NO_FILING_NUMBER =
  "the company has no filing number: it cannot be ordered until one is recorded";

interface FiledNameOptions {
  name: string;
  operator: string;
  replace?: boolean;
  yes?: boolean;
}

/**
 * The name as the State's record prints it, held to the agreement's field rule for a company name
 * (`COMPANY_NAME`, the rule the order door holds a filed name to before its agreement prints it):
 * a name the rule refuses is refused with the rule's reason, and one the rule would change (a
 * space at an end, a run of spaces, a character NFC rewrites) is refused too, never cleaned, since
 * the order door prints a filed name only as it stands (`passesAsItStands`). What passes is stored
 * exactly as typed.
 */
function parseFiledName(value: string): string {
  const problems: FieldProblem[] = [];
  const held = applyTextRule("--name", value, COMPANY_NAME, problems);
  const [problem] = problems;
  if (problem !== undefined) refuse(`${problem.field} ${problem.problem}`);
  if (held !== value)
    refuse(
      "--name would be changed by the agreement's field rule (a space at an end, a run of spaces, or a character NFC rewrites): type it exactly as the State's record prints it",
    );
  return value;
}

/**
 * Whether a legal body of the company holds an agreement that prints the company's current name
 * and may still stand behind it: `open`, an order on its way (a draft within its 24 hours, a
 * reserved or a deployed row); `linked`, a body that is linked, or was and can be again
 * (`markLinked` takes a broken or a superseded body back to linked). An expired draft, a lapsed
 * reservation and an abandoned order hold nothing. A state this build does not know is `unknown`,
 * which refuses a replacement like the other two: the rule fails closed.
 */
export function holdsFiledName(
  body: Pick<LegalBodyRecord, "bindingState" | "createdAt">,
  nowMs: number,
): "open" | "linked" | "unknown" | undefined {
  switch (body.bindingState) {
    case "draft":
      return isDraftExpired(body, nowMs) ? undefined : "open";
    case "reserved":
    case "deployed":
      return "open";
    case "linked":
    case "broken":
    case "superseded":
      return "linked";
    case "lapsed":
    case "abandoned":
      return undefined;
    default: {
      // A state added to `BindingState` and not placed above fails to compile here.
      const unplaced: never = body.bindingState;
      void unplaced;
      return "unknown";
    }
  }
}

/**
 * A replacement is refused while an agreement printing the current name can still be signed or
 * stands: an agreement is never signed with a superseded name, and a linked body's statement must
 * not state a name its frozen agreement does not print (a change of legal name after linking is a
 * matter for counsel, not for this command).
 */
function assertNoAgreementPrintsIt(bodies: LegalBodyRecord[], nowMs: number): void {
  const unknown = bodies.find((b) => holdsFiledName(b, nowMs) === "unknown");
  if (unknown !== undefined)
    refuse(
      `this company has a legal body in a state this command does not know (${unknown.bindingState}); its agreement may print the current name`,
    );
  if (bodies.some((b) => holdsFiledName(b, nowMs) === "linked"))
    refuse("this company has a linked legal body; its agreement prints the current name");
  const open = bodies.find((b) => holdsFiledName(b, nowMs) === "open");
  if (open === undefined) return;
  refuse(
    `this company has an open legal-body order; its agreement prints the current name${
      open.bindingState === "draft"
        ? `: the order ${open.legalBodyId} must be abandoned first (its guardian abandons the draft, or it expires 24 hours after it was ordered)`
        : ""
    }`,
  );
}

/**
 * Sets a formed legal-body company's filed name from the State's record: the operator's exact
 * string, which the State's record is, so it is written even when it matches none of the stored
 * options or carries no entity ending (the output then carries `warnings`, in the dry run and the
 * write alike). A name already set is replaced only with `--replace`, and only while no agreement
 * prints it. Every legal body the company has (only closed ones can remain by then) gets a note.
 *
 * Written through `recordFilingFacts`, the writer of every filing fact: its COALESCE keeps a value
 * against a NULL only, so a different name replaces the one held, and nothing else on the row
 * moves.
 */
function recordFiledName(companyId: string, opts: FiledNameOptions): void {
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();
  const name = parseFiledName(opts.name);

  withDatabase((db) => {
    const s = storesOf(db);
    const nowMs = Date.now();
    const found = db
      .transaction(() => {
        const company = formedLegalBodyCompany(s, companyId);
        const bodies = s.bodies.listByCompany(companyId);
        const previous = company.legalNameFiled;
        if (previous === null) {
          // A first-time set. No order can exist yet: the order door reads the filed name
          // (`companyNamesForOrder`) and refuses a company that holds none, and nothing clears a
          // name once it is set. Asked all the same, so the command never rests on that.
          if (bodies.length > 0)
            refuse(
              `company ${companyId} holds no filed name but has a legal-body order, which the order door never writes: find out how before setting one`,
            );
        } else {
          if (opts.replace !== true)
            refuse(`company ${companyId} already holds a filed name: pass --replace to correct it`);
          if (previous === name)
            refuse(`company ${companyId} already holds this filed name: nothing to replace`);
          assertNoAgreementPrintsIt(bodies, nowMs);
        }
        const matched = matchFiledNameAgainst(company.nameOptions, name) !== null;
        const numbered = company.filingNumber !== null;
        const legalBodies = bodies.map((b) => b.legalBodyId);
        if (opts.yes !== true) return { previous, matched, numbered, legalBodies, written: false };
        // Unreachable when false: the name differs from the one held, in this transaction.
        if (!s.companies.recordFilingFacts(companyId, { legalNameFiled: name }))
          throw new Error(`company ${companyId}: the filed name did not change`);
        for (const id of legalBodies)
          s.bodies.recordEvent(id, "note", `operator:${operator}`, null, {
            act: "filed_name_recorded",
            companyId,
          });
        return { previous, matched, numbered, legalBodies, written: true };
      })
      .immediate();

    const advice = [
      ...(found.matched ? [] : [NO_STORED_OPTION]),
      // Every company these commands take is a legal-body company (`formedLegalBodyCompany`).
      ...(hasEntityEnding(name) ? [] : [NO_ENTITY_ENDING]),
      ...(found.numbered ? [] : [NO_FILING_NUMBER]),
    ];
    const warnings = advice.length === 0 ? {} : { warnings: advice };
    if (!found.written) {
      print({
        recorded: false,
        companyId,
        current: found.previous,
        wouldRecord: { legalNameFiled: name },
        matched: found.matched,
        ...warnings,
        legalBodies: found.legalBodies,
        next: NEXT,
      });
      return;
    }
    // Never the name: ids, booleans and the operator only.
    opsLog("filed_name_recorded", {
      companyId,
      matched: found.matched,
      replaced: found.previous !== null,
      operator,
      operatorOsUser,
    });
    print({
      recorded: true,
      companyId,
      legalNameFiled: name,
      replaced: found.previous,
      matched: found.matched,
      ...warnings,
      legalBodies: found.legalBodies,
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

  program
    .command("company:filed-name")
    .argument("<companyId>", "the company Novi formed for a legal body, filed by the State")
    .description(
      "set a formed company's filed name, its full legal name as the State's record prints it, when doola's reported name matched none of the stored options, or correct it before any agreement prints it",
    )
    .requiredOption(
      "--name <text>",
      "the full legal name as the State's record prints it, its entity ending included",
    )
    .requiredOption("--operator <name>", `who sets it: ${OPERATOR_NAME.source}`)
    .option(
      "--replace",
      "correct a filed name the company already holds; refused while an open order or a linked legal body prints it",
    )
    .option("--yes", "confirm: set the filed name")
    .action((companyId: string, opts: FiledNameOptions) => recordFiledName(companyId, opts));
}
