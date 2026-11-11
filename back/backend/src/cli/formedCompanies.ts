import { readFileSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { isIntakeFrozen } from "../formation/freeze";
import { hasEntityEnding } from "../formation/intake";
import { eraseSsnLogged } from "../formation/ssnErasure";
import {
  MANUAL_REF_PREFIX,
  companyFiled,
  isManualRef,
  providerRefOf,
  stepStateOf,
} from "../formation/status";
import { COMPANY_NAME, FILING_NUMBER } from "../legalBody/companyFields";
import { sha256Of, startsAsPdf } from "../legalBody/evidence";
import { type FieldProblem, type TextRule, applyTextRule } from "../legalBody/textRules";
import { opsLog } from "../observability/opsLog";
import { type CompanyRecord, SqliteCompanyRepository } from "../persistence/companyRepository";
import {
  DAO_SUPPLEMENT_DOC_TYPE,
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../persistence/documentIndexRepository";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../persistence/formationPartyRepository";
import {
  FORMATION_STEP_ORDER,
  type FormationRequestRecord,
  SqliteFormationRepository,
  parseDetail,
} from "../persistence/formationRepository";
import {
  type LegalBodyRecord,
  SqliteLegalBodyRepository,
  isDraftExpired,
} from "../persistence/legalBodyRepository";
import type { FormationPin } from "../types";
import { isCalendarDate } from "../util/wyomingCalendar";
import {
  type REQUIRED_DOCUMENT_TYPES,
  filingDateToUnix,
  matchFiledNameAgainst,
} from "../workflow/formationProcessor";
import { recordCompanyEvent } from "../workflow/formationStep";
import { OPERATOR_NAME, osUser, parseOperator, print, refuse, withDatabase } from "./operator";

/**
 * THE OPERATOR'S COMMANDS over a company Novi formed for a legal body, for what doola does by hand
 * or its API cannot settle:
 *  - `company:dao-supplement` records doola's amended articles (the DAO supplement to the
 *    company's articles) as an operator document of the company;
 *  - `company:filed-name` sets the company's filed name from the State's record, when doola's
 *    reported name matched none of the stored options (so the processor stored none), or corrects
 *    it before any agreement prints it;
 *  - `formation:record-filed` and `formation:record-ein` are the ASSISTED COMPLETION of a paid
 *    company whose filing doola did by hand, outside its API: they write the rows the saga writes
 *    for an API filing, under the provider ref `manual:<operator>`, so the saga never polls the
 *    company afterwards (design F25, §6.13).
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
export const OPERATOR_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

interface Stores {
  db: Database.Database;
  companies: SqliteCompanyRepository;
  requests: SqliteFormationRepository;
  documents: SqliteDocumentIndexRepository;
  bodies: SqliteLegalBodyRepository;
  parties: SqliteFormationPartyRepository;
  entities: SqliteEntityRepository;
}

function storesOf(db: Database.Database): Stores {
  return {
    db,
    companies: new SqliteCompanyRepository(db),
    requests: new SqliteFormationRepository(db),
    documents: new SqliteDocumentIndexRepository(db),
    bodies: new SqliteLegalBodyRepository(db),
    parties: new SqliteFormationPartyRepository(db),
    entities: new SqliteEntityRepository(db),
  };
}

/**
 * The company, held to what every command here needs of it: filed through doola, for a legal body,
 * and not abandoned (the order door never takes an abandoned company, `companyEligible`).
 */
function legalBodyCompany(s: Stores, companyId: string): CompanyRecord {
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
  return company;
}

/**
 * `legalBodyCompany`, filed by the State as well (`await_filing` confirmed, `companyFiled`, the
 * rule the order door reads): what `company:dao-supplement` and `company:filed-name` take.
 */
function formedLegalBodyCompany(s: Stores, companyId: string): CompanyRecord {
  const company = legalBodyCompany(s, companyId);
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

/** The flag a command takes an operator's document under. */
type DocumentFlag = "--document" | "--articles";

/** A file system call on the document's flag, its failure refused by its code, not the path. */
function readable<T>(flag: DocumentFlag, read: () => T): T {
  try {
    return read();
  } catch (err) {
    return refuse(
      `${flag} cannot be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
    );
  }
}

/**
 * The bytes of a document an operator records (`--document`, `--articles`): a file, not empty, at
 * most 10 MiB, starting with the five bytes every PDF starts with. Like a customer's upload, it is
 * never parsed beyond those five bytes and its hash. The size is asked before the file is read, so
 * an oversized file is never read into memory, and once more after, in case the file grew in
 * between. A refusal names the flag, never the path.
 */
function readPdfDocument(flag: DocumentFlag, path: string): Buffer {
  const stat = readable(flag, () => statSync(path));
  if (!stat.isFile()) refuse(`${flag} must name a file`);
  const over = () => refuse(`${flag} is over 10 MiB`);
  if (stat.size > OPERATOR_DOCUMENT_MAX_BYTES) over();
  const bytes = readable(flag, () => readFileSync(path));
  if (bytes.length === 0) refuse(`${flag} is empty`);
  if (bytes.length > OPERATOR_DOCUMENT_MAX_BYTES) over();
  if (!startsAsPdf(bytes)) refuse(`${flag} is not a PDF: its bytes do not start with %PDF-`);
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
    const bytes = readPdfDocument("--document", opts.document);
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
 *  (`filedCompanyNames`). The processor writes the number from doola's poll (`healFilingFacts`
 *  heals a filing confirmed without one); `formation:record-filed` writes it for a filing done by
 *  hand. */
const NO_FILING_NUMBER =
  "the company has no filing number: the API's next poll fills it for a company doola filed; for a filing done by hand, formation:record-filed records it";

interface FiledNameOptions {
  name: string;
  operator: string;
  replace?: boolean;
  yes?: boolean;
}

/**
 * A filed fact as the State's record prints it, held to the agreement's field rule for it (the
 * rule the order door holds the fact to before its agreement prints it): a value the rule refuses
 * is refused with the rule's reason, and one the rule would change (a space at an end, a run of
 * spaces, a character NFC rewrites) is refused too, never cleaned, since the order door prints a
 * filed fact only as it stands (`passesAsItStands`). What passes is stored exactly as typed.
 */
function heldAsTyped(flag: string, value: string, rule: TextRule): string {
  const problems: FieldProblem[] = [];
  const held = applyTextRule(flag, value, rule, problems);
  const [problem] = problems;
  if (problem !== undefined) refuse(`${problem.field} ${problem.problem}`);
  if (held !== value)
    refuse(
      `${flag} would be changed by the agreement's field rule (a space at an end, a run of spaces, or a character NFC rewrites): type it exactly as the State's record prints it`,
    );
  return value;
}

/** The company's full legal name as the State's record prints it (`COMPANY_NAME`). */
function parseFiledName(value: string, flag: "--name" | "--legal-name" = "--name"): string {
  return heldAsTyped(flag, value, COMPANY_NAME);
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

// ── formation:record-filed and formation:record-ein: the assisted completion ──────────────────
//
// A paid formed company whose filing doola did by hand, outside its API (doola's amended articles,
// a filing made through the portal, an API outage). The operator records what the State's record
// says, and the commands write the rows the saga writes for an API filing (`advanceFiling`,
// `advanceDocuments`, `advanceEin` in `workflow/formationProcessor.ts`), with one difference by
// design: the provider ref is `manual:<operator>`, which names no company at doola. The poll
// due-set and the sweeper skip every company that carries one (`manuallyRecorded`), so the saga
// never polls, retries or abandons it afterwards.

/** The Articles' doc type: doola's own `documentType`, so every reader of the index (the view,
 *  the processor's required types) reads the operator's copy as the same document. */
const ARTICLES_DOC_TYPE: (typeof REQUIRED_DOCUMENT_TYPES)[number] = "ArticlesOfOrganization";
const EIN = /^\d{2}-\d{7}$/;
const RECORD_FILED_NEXT = "formation:record-ein when the IRS letter arrives";

/**
 * `legalBodyCompany`, paid and with its responsible party: what both assisted commands take. Paid
 * is `ready`: a `draft` company has nothing settled, and the filer files nothing for it. The party
 * is bound to the company and not erased, as the filer requires before it sends anything.
 */
function paidLegalBodyCompany(s: Stores, companyId: string): CompanyRecord {
  const company = legalBodyCompany(s, companyId);
  if (company.status !== "ready")
    refuse(
      `company ${companyId} is not paid (status ${company.status}): only a paid company is filed`,
    );
  if (s.parties.findByCompanyId(companyId) === undefined)
    refuse(
      `company ${companyId} has no formation party: a paid formed company always has one; find out why before recording`,
    );
  return company;
}

/** The operator a `manual:` ref names. */
const recorder = (ref: string): string => ref.slice(MANUAL_REF_PREFIX.length);

/** Where `formation:record-filed` takes `create_provider` from, and whether its create was frozen
 *  (see `recordableFrom`). */
interface Recordable {
  from: "unopened" | "pending" | "failed";
  frozenCreate: boolean;
}

/**
 * Where `formation:record-filed` takes the company's formation rows from, or a refusal:
 *  - `unopened`: no row at all, the saga never opened the filing; the write opens all four
 *    (`claimAllSteps`);
 *  - `pending` or `failed`: `create_provider` in that state with no provider ref, so no company
 *    exists at doola under it; the three later steps are `pending`, as the saga left them.
 * Refused: a filing already recorded by hand (any row carries a `manual:` ref); a create being sent
 * (`submitted`), which may still return a company; a create the API confirmed; a create doola
 * answered with a company id, which the saga adopts; an abandoned create; and a later step that is
 * not `pending`, which no API filing of an unconfirmed create leaves.
 *
 * And a FROZEN create (`isIntakeFrozen`) unless the operator passes `--doola-confirmed-no-company`:
 * a company body went out under the attempt's live key and its answer was lost (an outage, which
 * never burns the attempt), or its detail cannot be read, which proves nothing either way. doola
 * may hold that company. If it does, a record by hand would stop the saga from ever adopting it;
 * if it does not, the saga's same-key re-send after the outage would file a company on top of the
 * hand filing, unless the record wins first. Only doola can say which, so only the operator's
 * confirmation that doola holds none lets the record through.
 */
function recordableFrom(
  companyId: string,
  steps: FormationRequestRecord[],
  doolaConfirmedNoCompany: boolean,
): Recordable {
  if (steps.length === 0) return { from: "unopened", frozenCreate: false };
  const manual = steps.find((row) => isManualRef(row.providerRef))?.providerRef;
  if (manual)
    refuse(`the filing of company ${companyId} is already recorded by ${recorder(manual)}`);
  const create = steps.find((row) => row.step === "create_provider");
  if (create === undefined)
    refuse(
      `company ${companyId} has formation rows but no create_provider row: find out why before recording`,
    );
  if (create.state === "submitted") refuse("a create is being sent to doola: wait for it");
  if (create.state === "confirmed") refuse("the API filed this company: nothing to record");
  if (create.providerRef !== null)
    refuse(
      `doola holds a company for company ${companyId} (create_provider has a provider ref): the saga adopts it; nothing to record`,
    );
  if (create.state === "abandoned")
    refuse(`the filing of company ${companyId} was abandoned: nothing can be recorded on it`);
  const frozenCreate = isIntakeFrozen(create);
  if (frozenCreate && !doolaConfirmedNoCompany)
    refuse(
      `a create went out to doola for company ${companyId} and its answer was lost: doola may hold the company. Ask doola whether it holds one for this company's customer. If it does, do not record: the saga's next retry re-sends the same key and doola answers with that company, or its lookup by the customer finds it, and the saga adopts it. If doola confirms it holds none, run again with --doola-confirmed-no-company`,
    );
  for (const step of FORMATION_STEP_ORDER) {
    if (step === "create_provider") continue;
    const state = stepStateOf(steps, step);
    if (state !== "pending")
      refuse(
        `the ${step} step of company ${companyId} is ${state ?? "missing"}, not pending: find out why before recording`,
      );
  }
  return { from: create.state, frozenCreate };
}

/** `--filed-at`: a date of the calendar (`Date.parse` reads 2026-02-30 as 2 March, which
 *  `isCalendarDate` refuses), not before 1970-01-01 (the unix seconds `filed_at` holds, which the
 *  statement reads back only from zero, `calendarDateOfUtcMidnight`) and not after today's date in
 *  UTC, as unix seconds at UTC midnight: the value the processor writes from doola's
 *  `formationFilingDate` (`filingDateToUnix`). */
function parseFiledAt(value: string, nowMs: number): number {
  if (!isCalendarDate(value))
    refuse("--filed-at must be a date of the calendar, written YYYY-MM-DD");
  if (value < "1970-01-01")
    refuse("--filed-at is before 1970-01-01: check it against the State's record");
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (value > today)
    refuse(
      `--filed-at is after today's date in UTC (${today}): the State cannot have filed the company yet`,
    );
  const filedAt = filingDateToUnix(value);
  // Unreachable: a calendar date written YYYY-MM-DD always parses.
  if (filedAt === null) throw new Error("--filed-at: a calendar date did not parse");
  return filedAt;
}

/** Advice, never a refusal: doola may file before Novi's company row exists (a filing it began by
 *  hand), so an earlier date may be the State's record; it is more often a typo. */
const FILED_BEFORE_CREATED =
  "the filing date is before the company was created at Novi: check it against the State's record";

interface RecordFiledOptions {
  filingNumber: string;
  filedAt: string;
  legalName: string;
  articles: string;
  operator: string;
  doolaConfirmedNoCompany?: boolean;
  yes?: boolean;
}

/**
 * Records a paid formed company's filing done by hand, in ONE immediate transaction:
 *  - `create_provider` confirmed under `manual:<operator>`, its detail `{ recordedBy, recordedAt }`;
 *  - `await_filing` confirmed, its detail `{ filingNumber, filingDate, filedAt, recordedBy }`: the
 *    processor's `AwaitFilingDetail` keys (`filingDate` as typed, yyyy-MM-dd), and `filed_at`'s
 *    unix seconds;
 *  - `fetch_documents` confirmed, its detail the processor's `FetchDocumentsDetail`,
 *    `{ stored: [{ docId, type, sha256 }], missing: [] }` with `recordedBy` beside it: the Articles
 *    are the documents, recorded by hand, listed by their provider document id as the processor
 *    lists an index row;
 *  - `await_ein` left `pending` under the same manual ref, never polled (`formation:record-ein`
 *    confirms it);
 *  - the filing facts on the company through `recordFilingFacts`, the writer the processor uses,
 *    the name exactly as typed (the State's record is the truth);
 *  - the Articles' index row (`source = operator`), and the `formationFiled` event as the
 *    processor records it (it reaches no entity: a legal-body company has none attached);
 *  - the party's SSN erased (`eraseSsnLogged`, reason `provider_persisted`), as the filer erases
 *    it in the transaction that persists doola's company id: the filing is done, so nothing may
 *    send it again;
 *  - the Articles' bytes LAST, as `recordDaoSupplement` writes them.
 *
 * Every rule is checked before the file is read, so a wrong company is refused as such whatever
 * `--articles` names, and again inside the transaction, since the check before it holds no lock.
 * A create the sweeper starts in between moves `create_provider` first, and the transaction's
 * check then refuses.
 */
function recordFiled(companyId: string, opts: RecordFiledOptions): void {
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();
  const filingNumber = heldAsTyped("--filing-number", opts.filingNumber, FILING_NUMBER);
  const filedAt = parseFiledAt(opts.filedAt, Date.now());
  const legalNameFiled = parseFiledName(opts.legalName, "--legal-name");
  const providerRef = `${MANUAL_REF_PREFIX}${operator}`;

  withDatabase((db, docStoreDir) => {
    const s = storesOf(db);
    const confirmed = opts.doolaConfirmedNoCompany === true;
    paidLegalBodyCompany(s, companyId);
    recordableFrom(companyId, s.requests.stepsOf(companyId), confirmed);
    const bytes = readPdfDocument("--articles", opts.articles);
    const sha256 = sha256Of(bytes);
    const providerDocId = `operator:${ARTICLES_DOC_TYPE}:${sha256}`;
    const docId = documentIndexId(companyId, providerDocId);
    // The whole hash in the name, without its 0x, as `company:dao-supplement` names its file.
    const path = documentStoreName(companyId, ARTICLES_DOC_TYPE, sha256.slice(2));
    const document = { docId, sha256, size: bytes.length };
    const docStore = new FileDocumentStore(docStoreDir);
    const found = db
      .transaction(() => {
        const company = paidLegalBodyCompany(s, companyId);
        const { from, frozenCreate } = recordableFrom(
          companyId,
          s.requests.stepsOf(companyId),
          confirmed,
        );
        const matched = matchFiledNameAgainst(company.nameOptions, legalNameFiled) !== null;
        // `created_at` is SQLite's UTC "YYYY-MM-DD HH:MM:SS": its day against the typed day.
        const filedBeforeCreated = opts.filedAt < company.createdAt.slice(0, 10);
        const facts = { matched, frozenCreate, filedBeforeCreated };
        if (opts.yes !== true) return { written: false as const, ...facts };
        // Unreachable when false: no row existed, in this transaction.
        if (from === "unopened" && !s.requests.claimAllSteps(companyId))
          throw new Error(`company ${companyId}: its formation rows were opened twice`);
        const moved =
          s.requests.transition(
            companyId,
            "create_provider",
            from === "unopened" ? "pending" : from,
            "confirmed",
            {
              providerRef,
              detail: JSON.stringify({ recordedBy: operator, recordedAt: Date.now() }),
              error: null,
            },
          ) &&
          s.requests.transition(companyId, "await_filing", "pending", "confirmed", {
            detail: JSON.stringify({
              filingNumber,
              filingDate: opts.filedAt,
              filedAt,
              recordedBy: operator,
            }),
            error: null,
          }) &&
          // The processor's `FetchDocumentsDetail`: each stored document by its provider document
          // id, type and hash, as it maps the index rows, and nothing missing.
          s.requests.transition(companyId, "fetch_documents", "pending", "confirmed", {
            detail: JSON.stringify({
              stored: [{ docId: providerDocId, type: ARTICLES_DOC_TYPE, sha256 }],
              missing: [],
              recordedBy: operator,
            }),
            error: null,
          }) &&
          // The same ref on the step the company waits on, and no fact: nothing is known yet.
          s.requests.transition(companyId, "await_ein", "pending", "pending", {
            providerRef,
            touchFacts: false,
          });
        // Unreachable: every row was read in its state above, in this transaction.
        if (!moved) throw new Error(`company ${companyId}: a formation row moved while recording`);
        // Unreachable when false: the company held no filing facts, in this transaction.
        if (!s.companies.recordFilingFacts(companyId, { filedAt, filingNumber, legalNameFiled }))
          throw new Error(`company ${companyId}: the filing facts did not change`);
        const inserted = s.documents.insert({
          id: docId,
          companyId,
          docType: ARTICLES_DOC_TYPE,
          sha256,
          contentType: "application/pdf",
          size: bytes.length,
          providerDocId,
          path,
          source: "operator",
        });
        // Unreachable: an unfiled company has no Articles indexed, in this transaction.
        if (!inserted) throw new Error(`document index: ${docId} was indexed twice`);
        recordCompanyEvent(
          s.entities,
          companyId,
          "formationFiled",
          JSON.stringify({ providerRef, filingNumber, filedAt, environment: company.environment }),
        );
        // The filer's own erase and its audit line (`persistRefAndEraseSsn`), in this transaction.
        eraseSsnLogged(s.parties, companyId, "provider_persisted", company.environment);
        // Last: see `recordDaoSupplement`.
        docStore.putBytes(path, bytes);
        return { written: true as const, ...facts };
      })
      .immediate();

    const advice = [
      ...(found.matched ? [] : [NO_STORED_OPTION]),
      ...(hasEntityEnding(legalNameFiled) ? [] : [NO_ENTITY_ENDING]),
      ...(found.filedBeforeCreated ? [FILED_BEFORE_CREATED] : []),
    ];
    const warnings = advice.length === 0 ? {} : { warnings: advice };
    if (!found.written) {
      print({
        recorded: false,
        companyId,
        wouldRecord: { legalNameFiled, filingNumber, filedAt, providerRef, document },
        matched: found.matched,
        ...warnings,
        next: NEXT,
      });
      return;
    }
    // Never the name, the number or a path: ids, booleans and the operator only. `frozenCreate`
    // marks a record made over a create doola may have held, on the operator's confirmation.
    opsLog("formation_recorded_filed", {
      companyId,
      matched: found.matched,
      ...(found.frozenCreate ? { frozenCreate: true } : {}),
      operator,
      operatorOsUser,
    });
    print({
      recorded: true,
      companyId,
      legalNameFiled,
      filingNumber,
      filedAt,
      matched: found.matched,
      ...warnings,
      document,
      operator,
      operatorOsUser,
      next: RECORD_FILED_NEXT,
    });
  });
}

/**
 * What `formation:record-ein` does with the company's `await_ein` row, or a refusal. The row is
 * under a `manual:` ref, which only `formation:record-filed` writes: a company doola filed through
 * the API has its EIN read by the processor (`advanceEin`), never recorded by hand.
 *  - `confirm`: the row is `pending`; it is confirmed, with the EIN when `--ein` gives one;
 *  - `add`: the row was confirmed without a value and the company holds no EIN; `--ein` stores it.
 * A company that already holds an EIN takes no second one, whatever its value.
 */
function einRecordable(
  company: CompanyRecord,
  steps: FormationRequestRecord[],
  ein: string | null,
): { row: FormationRequestRecord; act: "confirm" | "add" } {
  const { companyId } = company;
  const row = steps.find((r) => r.step === "await_ein");
  if (row === undefined || !isManualRef(row.providerRef)) {
    const ref = providerRefOf(steps);
    if (ref !== null && !isManualRef(ref))
      refuse("the API tracks this company's EIN: nothing to record");
    refuse(
      `company ${companyId} has no filing recorded by hand: formation:record-filed records it first`,
    );
  }
  if (ein !== null && company.ein !== null)
    refuse(`company ${companyId} already holds an EIN: nothing to record`);
  if (row.state === "confirmed") {
    if (ein === null)
      refuse(
        `the EIN step of company ${companyId} is already recorded (await_ein is confirmed): pass --ein to store the EIN it lacks`,
      );
    return { row, act: "add" };
  }
  if (row.state !== "pending")
    refuse(
      `the await_ein step of company ${companyId} is ${row.state}, not pending: find out why before recording`,
    );
  // Unreachable through the commands: `formation:record-filed` confirms the filing with the ref.
  if (!companyFiled(steps))
    refuse(
      `the State's filing of company ${companyId} is not confirmed yet (await_filing is ${stepStateOf(steps, "await_filing") ?? "missing"})`,
    );
  return { row, act: "confirm" };
}

interface RecordEinOptions {
  ein?: string;
  operator: string;
  yes?: boolean;
}

/**
 * Confirms the EIN step of a company recorded by hand, when the IRS letter arrives, in ONE
 * immediate transaction: `await_ein` confirmed with `{ recordedBy, observedAt }` (`observedAt` in
 * unix ms, as the processor writes it), the EIN on the company through `recordEin` when `--ein`
 * gives it (the processor's writer; without it, the step is confirmed with no value), and the
 * `formationEin` event as the processor records it, which carries no EIN. A step confirmed without
 * a value takes the EIN later, once: the EIN alone is written, and the step and its event stay as
 * they were. No line it prints carries the EIN: the output and the ops line say only whether one
 * was stored.
 */
function recordEin(companyId: string, opts: RecordEinOptions): void {
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();
  if (opts.ein !== undefined && !EIN.test(opts.ein))
    refuse("--ein must be written NN-NNNNNNN: two digits, a hyphen and seven digits");
  const ein = opts.ein ?? null;
  const withValue = ein !== null;

  withDatabase((db) => {
    const s = storesOf(db);
    const written = db
      .transaction(() => {
        const company = paidLegalBodyCompany(s, companyId);
        const { row, act } = einRecordable(company, s.requests.stepsOf(companyId), ein);
        if (opts.yes !== true) return false;
        if (act === "add") {
          // Unreachable when false: the company held no EIN, in this transaction.
          if (ein === null || !s.companies.recordEin(companyId, ein))
            throw new Error(`company ${companyId}: the EIN did not change`);
          return true;
        }
        const moved = s.requests.transition(companyId, "await_ein", "pending", "confirmed", {
          detail: JSON.stringify({
            ...parseDetail<Record<string, unknown>>(row.detail),
            recordedBy: operator,
            observedAt: Date.now(),
          }),
          error: null,
        });
        // Unreachable: the row was read `pending` above, in this transaction.
        if (!moved) throw new Error(`company ${companyId}: await_ein moved while recording`);
        if (ein !== null) s.companies.recordEin(companyId, ein);
        recordCompanyEvent(
          s.entities,
          companyId,
          "formationEin",
          JSON.stringify({ providerRef: row.providerRef, environment: company.environment }),
        );
        return true;
      })
      .immediate();

    if (!written) {
      print({
        recorded: false,
        companyId,
        wouldRecord: { await_ein: "confirmed", withValue },
        next: NEXT,
      });
      return;
    }
    // Never the EIN: whether one was stored, the id and the operator only.
    opsLog("formation_recorded_ein", { companyId, withValue, operator, operatorOsUser });
    print({ recorded: true, companyId, withValue, operator, operatorOsUser });
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

  program
    .command("formation:record-filed")
    .argument(
      "<companyId>",
      "a paid company Novi forms for a legal body, not filed through the API",
    )
    .description(
      "record the filing of a paid formed company that doola did by hand, outside its API: the rows the saga writes for an API filing, under the provider ref manual:<operator>, so the saga never polls the company",
    )
    .requiredOption("--filing-number <n>", "the filing number on the State's record")
    .requiredOption(
      "--filed-at <YYYY-MM-DD>",
      "the filing date on the State's record, not after today in UTC",
    )
    .requiredOption(
      "--legal-name <text>",
      "the full legal name as the State's record prints it, its entity ending included",
    )
    .requiredOption(
      "--articles <path.pdf>",
      "the Articles of Organization doola sent, at most 10 MiB",
    )
    .requiredOption("--operator <name>", `who records: ${OPERATOR_NAME.source}`)
    .option(
      "--doola-confirmed-no-company",
      "doola confirmed it holds no company for this company's customer, after a create whose answer was lost",
    )
    .option("--yes", "confirm: record the filing")
    .action((companyId: string, opts: RecordFiledOptions) => recordFiled(companyId, opts));

  program
    .command("formation:record-ein")
    .argument("<companyId>", "a company whose filing formation:record-filed recorded")
    .description(
      "confirm the EIN step of a company recorded by hand, when the IRS letter arrives; with --ein, store the EIN as the processor stores one",
    )
    .option(
      "--ein <NN-NNNNNNN>",
      "the EIN on the IRS letter; without it, no value is stored, and a later run with it stores it once",
    )
    .requiredOption("--operator <name>", `who records: ${OPERATOR_NAME.source}`)
    .option("--yes", "confirm: record the EIN step")
    .action((companyId: string, opts: RecordEinOptions) => recordEin(companyId, opts));
}
