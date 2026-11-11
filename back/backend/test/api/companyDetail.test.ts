/**
 * `GET /companies/:companyId` (design §7) — the Companies section's detail page.
 *
 * Three properties, and only the first is ordinary:
 *
 *  1. ownership, answered the way every other owner-scoped route answers it: unknown and
 *     not-yours are ONE 404, or the route is an existence oracle over other tenants' ids;
 *  2. the eight-word `state`, which is the one vocabulary the section renders — three facts
 *     (the row's status, a live payment, the derived filing status) combined in ONE place so a
 *     picker, a list and a detail page cannot disagree about the same company;
 *  3. the PARK STATE. A2 gave a filing three ways to stop and wait for a human, all of them
 *     correct and none of them visible; to the owner all three looked like a company that had
 *     simply stopped, and two of the three have an exit only they can take.
 */
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { companyNameOptions } from "../../src/formation/intake";
import { formationSummary } from "../../src/formation/status";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { formedEntity } from "../helpers/formationFakes";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const OWNER = getAddress("0x000000000000000000000000000000000000000a");
const OTHER = getAddress("0x000000000000000000000000000000000000000b");

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let parties: SqliteFormationPartyRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  parties = new SqliteFormationPartyRepository(db);
});
afterEach(() => db.close());

async function token(tenantId: string): Promise<string> {
  const { token } = await signSession(tenantId, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

function app() {
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    documents,
    docStore: { getBytesAsync: async () => Buffer.from("") },
    formationSteps: (id: string) => requests.stepsOf(id),
    formation: { parties },
  } as never);
}

const get = async (companyId: string, tenantId?: string) =>
  app().request(`/companies/${encodeURIComponent(companyId)}`, {
    headers: tenantId ? { authorization: `Bearer ${await token(tenantId)}` } : {},
  });

const detail = async (companyId: string, tenantId = OWNER) =>
  (await (await get(companyId, tenantId)).json()) as Record<string, never>;

function newCompany(over: Partial<Parameters<SqliteCompanyRepository["create"]>[0]> = {}): string {
  return companies.create({
    tenantId: OWNER,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: companyNameOptions("Acme One", "Acme Two", "Acme Three"),
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: "Software development",
    intakeSynthesized: false,
    purposeKind: "agent",
    ...over,
  });
}

/** A bound responsible party, with the §4.6a decision state a test needs. */
function newParty(companyId: string, ssnErasedReason?: string): string {
  const partyId = parties.create({
    tenantId: OWNER,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: "+12125550100",
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  parties.bindToCompany(partyId, companyId, OWNER);
  if (ssnErasedReason)
    db.prepare("UPDATE formation_parties SET ssn_erased_reason = ? WHERE party_id = ?").run(
      ssnErasedReason,
      partyId,
    );
  return partyId;
}

// ── ownership ───────────────────────────────────────────────────────────────────────────────

test("unknown and NOT-YOURS get one identical 404, and the route needs a session", async () => {
  const mine = newCompany();
  expect((await get(mine)).status).toBe(401);

  const theirs = await get(mine, OTHER);
  const missing = await get("nope", OTHER);
  expect(theirs.status).toBe(404);
  expect(missing.status).toBe(404);
  // Identical bodies: the route is not an existence oracle over other tenants' company ids.
  expect(await theirs.text()).toBe(await missing.text());
});

// ── the eight-word state ────────────────────────────────────────────────────────────────────

test("STATE: a ready company with no filing opened reads `ready`, not `none`", async () => {
  // `deriveFormationStatus` says `none` for a company whose `create_provider` row has not been
  // opened, which is correct and reads to an owner as "nothing will ever happen". The section's
  // word for it is `ready`: fileable, not yet filing.
  const id = newCompany();
  const body = await detail(id);
  expect(body.state).toBe("ready");
  expect(body.formationStatus).toBe("none");
});

test("STATE: draft, abandoned and paying take precedence over the sub-saga, in that order", async () => {
  expect((await detail(newCompany({ status: "draft" }))).state).toBe("draft");

  // Abandoned wins over anything a stale sub-saga row says: it is terminal, and it is the
  // company's own column.
  const abandoned = newCompany({ status: "abandoned" });
  requests.claimStep(abandoned, "create_provider");
  requests.transition(abandoned, "create_provider", "pending", "confirmed", { providerRef: "c1" });
  expect((await detail(abandoned)).state).toBe("abandoned");

  // A live quote means the company is not paid for and cannot be filed — the same fact to the
  // owner whether the row says `draft` or `ready`.
  const paying = newCompany();
  db.prepare(
    `INSERT INTO formation_payments (payment_id, company_id, status, amount_usdc, nonce, valid_before)
     VALUES ('pay-1', ?, 'quoted', '399000000', 'ff', 1)`,
  ).run(paying);
  expect((await detail(paying)).state).toBe("paying");
});

test("STATE: a ready company reports its filing status verbatim once one is opened", async () => {
  const id = newCompany();
  requests.claimAllSteps(id);
  expect((await detail(id)).state).toBe("in_progress");

  requests.transition(id, "await_filing", "pending", "confirmed");
  expect((await detail(id)).state).toBe("filed");

  requests.transition(id, "await_ein", "pending", "confirmed");
  expect((await detail(id)).state).toBe("complete");
});

// ── the park state ──────────────────────────────────────────────────────────────────────────

test("PARK: a healthy company reports all three flags false, and no refused fields", async () => {
  const id = newCompany();
  newParty(id);
  expect((await detail(id)).park).toEqual({
    awaitingIntakeEdit: false,
    awaitingPartyEdit: false,
    awaitingSsnDecision: false,
    refusedFields: [],
  });
});

test("PARK: the refused fields are served by PATH only, through the allowlist, while a park holds", async () => {
  // The filer writes the paths doola named beside the flag. The view re-checks every entry, since
  // the blob is a column: a value that is not a field path (a sentence, an email, a nine-digit
  // run) is never served, whoever wrote it there.
  const id = newCompany();
  newParty(id);
  requests.claimStep(id, "create_provider");
  requests.transition(id, "create_provider", "pending", "failed", {
    detail: JSON.stringify({
      awaitingIntakeEdit: true,
      refusedFields: [
        "description",
        "nameOptions[0].name",
        "size must be between 1 and 50",
        "person@example.test",
        "123456789",
        42,
      ],
    }),
  });
  expect((await detail(id)).park).toEqual({
    awaitingIntakeEdit: true,
    awaitingPartyEdit: false,
    awaitingSsnDecision: false,
    refusedFields: ["description", "nameOptions[0].name"],
  });

  // A list with NO flag set describes no park, and is not served.
  const stale = newCompany({
    nameOptions: companyNameOptions("Beta One", "Beta Two", "Beta Three"),
  });
  newParty(stale);
  requests.claimStep(stale, "create_provider");
  requests.transition(stale, "create_provider", "pending", "failed", {
    detail: JSON.stringify({ refusedFields: ["description"] }),
  });
  expect(
    ((await detail(stale)).park as unknown as { refusedFields: string[] }).refusedFields,
  ).toEqual([]);
});

test("PARK: the two `detail` flags are reported SEPARATELY — they have different exits", async () => {
  // `PATCH /companies/:id` rewrites names, purpose, industry and the SSN; NONE of those is what a
  // rejected `createCustomer` objected to. A view that merged them would point an owner at a form
  // that cannot help.
  for (const flag of ["awaitingIntakeEdit", "awaitingPartyEdit"] as const) {
    const id = newCompany();
    newParty(id);
    requests.claimStep(id, "create_provider");
    requests.transition(id, "create_provider", "pending", "failed", {
      detail: JSON.stringify({ [flag]: true }),
    });
    const park = (await detail(id)).park as unknown as Record<string, boolean>;
    expect(park[flag], flag).toBe(true);
    for (const other of ["awaitingIntakeEdit", "awaitingPartyEdit", "awaitingSsnDecision"])
      if (other !== flag) expect(park[other], `${flag} → ${other}`).toBe(false);
  }
});

test("PARK: an SSN the CLOCK erased before the first send is reported as its own decision", async () => {
  // §4.6a. The owner has two exits and only they can take either — re-supply the number, or
  // accept the slower SS-4 route — and until A3 the state was invisible: a company that had
  // simply stopped.
  const id = newCompany();
  newParty(id, "ttl");
  requests.claimStep(id, "create_provider");
  expect((await detail(id)).park).toMatchObject({ awaitingSsnDecision: true });

  // …and it is NOT reported once the body has been sent: a frozen body's SSN question was
  // settled at the first send and is read back from `detail`.
  requests.transition(id, "create_provider", "pending", "submitted");
  expect((await detail(id)).park).toMatchObject({ awaitingSsnDecision: false });
});

test("PARK: a party erased for any OTHER reason is not waiting on a decision", async () => {
  // `provider_persisted` is the ordinary end of every SSN's life. Reporting it as a park would
  // tell every filed company's owner they had something to do.
  const id = newCompany();
  newParty(id, "provider_persisted");
  requests.claimStep(id, "create_provider");
  expect((await detail(id)).park).toMatchObject({ awaitingSsnDecision: false });
});

// ── the rest of the page ────────────────────────────────────────────────────────────────────

test("the page carries the documents, the attached agents and the open required actions", async () => {
  const id = newCompany();
  repo.upsert(formedEntity({ ownerTenantId: OWNER, companyId: id }));
  documents.insert({
    id: documentIndexId(id, "d-aoo"),
    companyId: id,
    docType: "ArticlesOfOrganization",
    sha256: "a".repeat(64),
    contentType: "application/pdf",
    size: 12,
    providerDocId: "d-aoo",
    path: documentStoreName(id, "ArticlesOfOrganization", "d-aoo"),
  });
  requests.claimAllSteps(id);
  requests.transition(id, "create_provider", "pending", "confirmed", { providerRef: "cmp-1" });
  requests.transition(id, "await_filing", "pending", "pending", {
    detail: JSON.stringify({
      requiredActions: [{ code: "FORMATION_NAME_OPTIONS_EXHAUSTED", reason: "Ada Lovelace said" }],
    }),
  });
  companies.recordEin(id, "88-1234567");

  const body = (await detail(id)) as unknown as {
    documents: { type: string }[];
    attachedAgents: unknown[];
    [k: string]: unknown;
  };
  expect(body.documents).toHaveLength(1);
  expect(body.documents[0]).toMatchObject({ type: "ArticlesOfOrganization" });
  expect(body.attachedAgents).toEqual([
    { id: "tenant-a:agent-1", name: "Formation Agent", status: "funded" },
  ]);
  // `agents` is this array's LENGTH, counted from the rows it names rather than from a second
  // query that could disagree with them.
  expect(body.agents).toBe(1);
  expect(body.providerRef).toBe("cmp-1");
  expect(body.ein).toBe("88-1234567");
  // CODES only — never doola's free-text reason, which their operators write and which can name
  // the responsible party.
  expect(body.requiredActions).toEqual(["FORMATION_NAME_OPTIONS_EXHAUSTED"]);
  expect(JSON.stringify(body)).not.toContain("Ada Lovelace");
});

test("a filing recorded by hand serves no provider ref: the operator's manual: handle stays internal, here and in the formation summary", async () => {
  const id = newCompany({ purposeKind: "legal_body" });
  requests.claimAllSteps(id);
  requests.transition(id, "create_provider", "pending", "confirmed", {
    providerRef: "manual:ops.example",
  });
  requests.transition(id, "await_filing", "pending", "confirmed");
  requests.transition(id, "await_ein", "pending", "pending", {
    providerRef: "manual:ops.example",
    touchFacts: false,
  });
  const body = await detail(id);
  expect(body.providerRef).toBeNull();
  expect(body.formationStatus).toBe("filed");
  expect(JSON.stringify(body)).not.toContain("ops.example");

  // The summary every entity surface spreads, the public ones included.
  const company = companies.find(id)!;
  expect(formationSummary(company, requests.stepsOf(id))?.providerRef).toBeNull();
  // doola's own id is served as ever.
  const api = newCompany();
  requests.claimAllSteps(api);
  requests.transition(api, "create_provider", "pending", "confirmed", { providerRef: "cmp-7" });
  expect(formationSummary(companies.find(api)!, requests.stepsOf(api))?.providerRef).toBe("cmp-7");
});

test("NO PII: a bound party's identity is nowhere in the response", async () => {
  const id = newCompany();
  newParty(id, "ttl");
  const printed = JSON.stringify(await detail(id));
  for (const forbidden of ["Ada", "Lovelace", "ada@example.com", "Analytical", "82001"])
    expect(printed, forbidden).not.toContain(forbidden);
});

test("a box that merely DESCRIBES old filings still answers — it just reports no SSN park", async () => {
  // `deps.formation` absent = no doola credentials and no PII surface at all. The company is
  // still real and its documents are still real.
  const id = newCompany();
  newParty(id, "ttl");
  requests.claimStep(id, "create_provider");
  const res = await buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    documents,
    docStore: { getBytesAsync: async () => Buffer.from("") },
    formationSteps: (k: string) => requests.stepsOf(k),
  } as never).request(`/companies/${id}`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).park.awaitingSsnDecision).toBe(false);
});

// ── what the company is for, where it came from, and its DAO supplement ─────────────────────

/** The two dao_supplement rows below are written straight to the index, as the operator's
 *  `company:dao-supplement` command records one: source `operator`, a `0x` hash, the provider
 *  document id `operator:dao_supplement:<sha256>`. `createdAt` is the database's UTC clock text. */
function recordSupplement(companyId: string, sha256: string, createdAt: string): void {
  const providerDocId = `operator:dao_supplement:${sha256}`;
  db.prepare(
    `INSERT INTO documents (id, company_id, doc_type, sha256, content_type, size, provider_doc_id,
                            path, source, created_at)
     VALUES (?, ?, 'dao_supplement', ?, 'application/pdf', 2048, ?, ?, 'operator', ?)`,
  ).run(
    documentIndexId(companyId, providerDocId),
    companyId,
    sha256,
    providerDocId,
    documentStoreName(companyId, "dao_supplement", sha256),
    createdAt,
  );
}

const list = async (tenantId = OWNER) =>
  (
    (await (
      await app().request("/companies", {
        headers: { authorization: `Bearer ${await token(tenantId)}` },
      })
    ).json()) as { companies: Record<string, unknown>[] }
  ).companies;

test("a doola legal-body company says so: purpose legal_body, provider doola, and no DAO supplement yet", async () => {
  const id = newCompany({ purposeKind: "legal_body" });
  expect(await detail(id)).toMatchObject({
    purpose: "legal_body",
    provider: "doola",
    daoSupplement: null,
  });
  expect((await list()).find((c) => c.companyId === id)).toMatchObject({
    purpose: "legal_body",
    provider: "doola",
    daoSupplement: null,
  });
});

test("a doola company for agents: purpose agent, provider doola", async () => {
  const id = newCompany();
  expect(await detail(id)).toMatchObject({
    purpose: "agent",
    provider: "doola",
    daoSupplement: null,
  });
});

test("the DAO supplement is the latest dao_supplement row of the index: its time in unix seconds and its hash", async () => {
  const id = newCompany({ purposeKind: "legal_body" });
  const first = `0x${"1".repeat(64)}`;
  const older = `0x${"2".repeat(64)}`;
  const replaced = `0x${"3".repeat(64)}`;
  recordSupplement(id, first, "2026-11-20 10:00:00");
  expect((await detail(id)).daoSupplement).toEqual({
    recordedAt: Date.UTC(2026, 10, 20, 10) / 1000,
    sha256: first,
  });

  // Written after it but dated before it: not the latest.
  recordSupplement(id, older, "2026-11-20 09:00:00");
  expect((await detail(id)).daoSupplement).toMatchObject({ sha256: first });

  // A replacement in the same second as the first: the one recorded last.
  recordSupplement(id, replaced, "2026-11-20 10:00:00");
  const expected = { recordedAt: Date.UTC(2026, 10, 20, 10) / 1000, sha256: replaced };
  expect((await detail(id)).daoSupplement).toEqual(expected);
  // The list row reads the same, and another company of the tenant reads none.
  const other = newCompany({ purposeKind: "legal_body" });
  const rows = await list();
  expect(rows.find((c) => c.companyId === id)?.daoSupplement).toEqual(expected);
  expect(rows.find((c) => c.companyId === other)?.daoSupplement).toBeNull();
});

test("a box with no document index reads no DAO supplement, and says so with null", async () => {
  const id = newCompany({ purposeKind: "legal_body" });
  recordSupplement(id, `0x${"4".repeat(64)}`, "2026-11-20 10:00:00");
  const res = await buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    docStore: { getBytesAsync: async () => Buffer.from("") },
    formationSteps: (k: string) => requests.stepsOf(k),
  } as never).request(`/companies/${id}`, {
    headers: { authorization: `Bearer ${await token(OWNER)}` },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).daoSupplement).toBeNull();
});
