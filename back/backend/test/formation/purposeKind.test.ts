/**
 * `companies.purpose_kind`: what a company is FOR. `agent` stands behind agents of the full
 * product; `legal_body` stands behind a legal body and never behind an agent.
 *
 * The column is NOT NULL with DEFAULT 'agent', which is the truth for every row written before it
 * existed except a customer's own declared company: a backfill on every boot gives those rows
 * `legal_body`, so a customer row an older build writes after a rollback is corrected by the next
 * boot of this one. The formed door's cap reads `countChargeableFormedLegalBodies`, the
 * `countChargeableByTenant` shape over every tenant.
 *
 * Every tenant, name and id here is an invention.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type NewCompany, SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";

/** The `companies` table exactly as it was created before `purpose_kind` existed. */
const COMPANIES_BEFORE_PURPOSE_KIND = `
  CREATE TABLE companies (
    company_id  TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('draft','ready','abandoned')),
    provider    TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
    synthetic   INTEGER NOT NULL DEFAULT 0,
    name_options    TEXT NOT NULL,
    business_purpose TEXT NOT NULL,
    industry_label  TEXT NOT NULL,
    intake_synthesized INTEGER NOT NULL DEFAULT 0,
    legal_name_filed TEXT,
    filed_at       INTEGER,
    filing_number  TEXT,
    ein            TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_companies_tenant_created
    ON companies(tenant_id, created_at DESC);
`;

/** A row the way any build before this one wrote it: no purpose column to name. */
function insertLegacy(db: Database.Database, companyId: string, provider: string): void {
  db.prepare(
    `INSERT INTO companies (company_id, tenant_id, status, provider, environment,
                            name_options, business_purpose, industry_label)
     VALUES (?, ?, 'ready', ?, 'sandbox', '[]', 'p', 'i')`,
  ).run(companyId, TENANT, provider);
}

/**
 * A database as the build before this one left it: every table of this build, but `companies` in
 * its shape before `purpose_kind`. SQLite cannot drop a column that carries a CHECK, so the table
 * is dropped, with foreign keys off, and created again in that shape.
 */
function previousBuildDatabase(): Database.Database {
  const db = openDatabase(":memory:");
  migrate(db);
  db.pragma("foreign_keys = OFF");
  db.exec(`DROP TABLE companies; ${COMPANIES_BEFORE_PURPOSE_KIND}`);
  db.pragma("foreign_keys = ON");
  return db;
}

const purposeOf = (db: Database.Database, companyId: string) =>
  (
    db.prepare("SELECT purpose_kind AS p FROM companies WHERE company_id = ?").get(companyId) as {
      p: string;
    }
  ).p;

const updatedAtOf = (db: Database.Database, companyId: string) =>
  (
    db.prepare("SELECT updated_at AS u FROM companies WHERE company_id = ?").get(companyId) as {
      u: string;
    }
  ).u;

function company(over: Partial<NewCompany> = {}): NewCompany {
  return {
    tenantId: TENANT,
    status: "ready",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Example Works", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "Example purpose.",
    industryLabel: "Software development",
    intakeSynthesized: false,
    purposeKind: "agent",
    ...over,
  };
}

describe("the column", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
  });
  afterEach(() => db.close());

  test("a fresh database has purpose_kind, NOT NULL with default 'agent', and no backfill marker", () => {
    const col = (
      db.prepare("PRAGMA table_info(companies)").all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).find((c) => c.name === "purpose_kind");
    expect(col).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'agent'" });
    // A writer that names no purpose gets the default.
    insertLegacy(db, "co_default", "doola");
    expect(purposeOf(db, "co_default")).toBe("agent");
    // The backfill runs on every boot, so it keeps no marker.
    expect(db.prepare("SELECT key FROM meta WHERE key LIKE 'purpose_kind%'").all()).toEqual([]);
  });

  test("the CHECK refuses any value but the two purposes", () => {
    insertLegacy(db, "co_check", "doola");
    expect(() =>
      db.prepare("UPDATE companies SET purpose_kind = 'other' WHERE company_id = 'co_check'").run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("UPDATE companies SET purpose_kind = NULL WHERE company_id = 'co_check'").run(),
    ).toThrow(/NOT NULL/);
  });

  test("create round-trips purposeKind, and the record reads it back", () => {
    const companies = new SqliteCompanyRepository(db);
    const lb = companies.create(company({ purposeKind: "legal_body" }));
    const agent = companies.create(company({ purposeKind: "agent" }));
    expect(companies.find(lb)!.purposeKind).toBe("legal_body");
    expect(companies.find(agent)!.purposeKind).toBe("agent");
    expect(purposeOf(db, lb)).toBe("legal_body");
    expect(
      companies
        .listByTenant(TENANT)
        .map((c) => c.purposeKind)
        .sort(),
    ).toEqual(["agent", "legal_body"]);
  });
});

describe("a database created before the column existed", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(COMPANIES_BEFORE_PURPOSE_KIND);
    insertLegacy(db, "co_customer", "customer");
    insertLegacy(db, "co_doola", "doola");
  });
  afterEach(() => db.close());

  test("migrate adds the column: a customer's company reads legal_body, a doola one agent", () => {
    migrate(db);
    expect(purposeOf(db, "co_customer")).toBe("legal_body");
    expect(purposeOf(db, "co_doola")).toBe("agent");
    const companies = new SqliteCompanyRepository(db);
    expect(companies.find("co_customer")!.purposeKind).toBe("legal_body");
    expect(companies.find("co_doola")!.purposeKind).toBe("agent");
    // The column the ALTER added carries the same CHECK as the fresh DDL.
    expect(() =>
      db.prepare("UPDATE companies SET purpose_kind = 'other' WHERE company_id = 'co_doola'").run(),
    ).toThrow(/CHECK/);
  });

  test("the backfill runs on every boot: a customer row written as agent is corrected, a doola row is never touched", () => {
    migrate(db);
    // A rollback to the build before, then forward again: that build names no purpose, so the
    // customer company it writes reads agent, and so does one it wrote over.
    db.prepare(
      "UPDATE companies SET purpose_kind = 'agent' WHERE company_id = 'co_customer'",
    ).run();
    insertLegacy(db, "co_customer_after_rollback", "customer");
    expect(purposeOf(db, "co_customer_after_rollback")).toBe("agent");
    // A doola row of either purpose, stamped so a write to it would show.
    insertLegacy(db, "co_doola_legal_body", "doola");
    db.prepare(
      "UPDATE companies SET purpose_kind = 'legal_body' WHERE company_id = 'co_doola_legal_body'",
    ).run();
    db.prepare(
      "UPDATE companies SET updated_at = '2026-01-02 03:04:05' WHERE provider = 'doola'",
    ).run();

    migrate(db);
    expect(purposeOf(db, "co_customer")).toBe("legal_body");
    expect(purposeOf(db, "co_customer_after_rollback")).toBe("legal_body");
    expect(purposeOf(db, "co_doola")).toBe("agent");
    expect(purposeOf(db, "co_doola_legal_body")).toBe("legal_body");
    for (const id of ["co_doola", "co_doola_legal_body"])
      expect(updatedAtOf(db, id), id).toBe("2026-01-02 03:04:05");

    // A further boot finds nothing to correct and changes nothing.
    const before = db.prepare("SELECT * FROM companies ORDER BY company_id").all();
    migrate(db);
    expect(db.prepare("SELECT * FROM companies ORDER BY company_id").all()).toEqual(before);
  });
});

test("the repository is constructed, and reads and moves a company, on a database this build has not migrated", () => {
  // `formation:abandon` constructs it without migrating, so the statements that name the column
  // are prepared on first use.
  const db = previousBuildDatabase();
  try {
    const companies = new SqliteCompanyRepository(db);
    insertLegacy(db, "co_older", "doola");
    db.prepare("UPDATE companies SET status = 'draft' WHERE company_id = 'co_older'").run();
    const found = companies.find("co_older")!;
    expect(found).toMatchObject({ companyId: "co_older", status: "draft", provider: "doola" });
    // There is no column to read it from.
    expect(found.purposeKind).toBeUndefined();
    expect(companies.setStatus("co_older", "draft", "abandoned")).toBe(true);
    expect(companies.find("co_older")!.status).toBe("abandoned");
  } finally {
    db.close();
  }
});

describe("countChargeableFormedLegalBodies", () => {
  let db: Database.Database;
  let companies: SqliteCompanyRepository;
  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    companies = new SqliteCompanyRepository(db);
  });
  afterEach(() => db.close());

  const pay = (companyId: string, status: string) =>
    db
      .prepare(
        `INSERT INTO formation_payments (payment_id, company_id, status, amount_usdc, nonce, valid_before)
         VALUES (?, ?, ?, '399000000', ?, 1)`,
      )
      .run(`pay-${companyId}-${status}`, companyId, status, `nonce-${companyId}-${status}`);

  test("it counts formed legal-body companies that are ready or carry a live payment, over every tenant", () => {
    expect(companies.countChargeableFormedLegalBodies()).toBe(0);

    // Counted: ready; a draft with a quoted payment; a draft with a settling one; another tenant's.
    companies.create(company({ purposeKind: "legal_body", status: "ready" }));
    const quoted = companies.create(company({ purposeKind: "legal_body", status: "draft" }));
    pay(quoted, "quoted");
    const settling = companies.create(company({ purposeKind: "legal_body", status: "draft" }));
    pay(settling, "settling");
    companies.create(company({ purposeKind: "legal_body", status: "ready", tenantId: OTHER }));

    // Not counted: a draft with no payment, or with an expired one; an abandoned one; a
    // customer's own company; a doola company for agents.
    companies.create(company({ purposeKind: "legal_body", status: "draft" }));
    const expired = companies.create(company({ purposeKind: "legal_body", status: "draft" }));
    pay(expired, "expired");
    companies.create(company({ purposeKind: "legal_body", status: "abandoned" }));
    companies.create(company({ purposeKind: "legal_body", status: "ready", provider: "customer" }));
    companies.create(company({ purposeKind: "agent", status: "ready" }));
    const agentQuoted = companies.create(company({ purposeKind: "agent", status: "draft" }));
    pay(agentQuoted, "quoted");

    expect(companies.countChargeableFormedLegalBodies()).toBe(4);
    // The tenant quota is a different question and is unchanged by the purpose.
    expect(companies.countChargeableByTenant(TENANT)).toBe(5);
  });
});
