/**
 * THE REFUND-OVERDUE ALERT (F-A-2a Task 14b): a CRITICAL ops line when a refund owed on an
 * abandoned company is overdue, `FORMATION_REFUND_DAYS` (default 14) after the abandon.
 *
 * A paid customer who gives up before doola is abandoned (Task 12) with the payment left
 * `settled`: the refund is a transfer an operator signs from the revenue wallet by hand and
 * records with `formation:refund`. Nothing in the software makes that transfer, so nothing in the
 * software would notice it was never made. This leg is what notices: every tick, each settled
 * payment of an abandoned company with no refund recorded is aged from the abandon's stamp
 * (`companies.updated_at`), and once it is `refundDays` old, one line a day names the company,
 * the payment and how many days the refund is late. No amount, no address, no person.
 *
 * The database is real (in memory). Every id and address is an invention.
 */
import type DatabaseType from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import { abandonFormedCompany } from "../../src/formation/abandonFormed";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { Hex } from "../../src/types";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";
import {
  AMORTISED_EVERY_N_TICKS,
  FormationSweeper,
  type FormationSweeperDeps,
} from "../../src/workflow/formationSweeper";
import { MemoryDocumentStore, fakeDoola } from "../helpers/formationFakes";
import { REVENUE, paymentCfg } from "../helpers/formationPayment";

const TENANT = getAddress("0x00000000000000000000000000000000000000e1");
const PAYER = getAddress("0x00000000000000000000000000000000000000e7");
const AMOUNT = 399_000_000n;
const SETTLED_TX = `0x${"cc".repeat(32)}` as Hex;
const REFUND_TX = `0x${"dd".repeat(32)}` as Hex;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** The abandon's stamp in the clock-driven cases: 09:00 UTC, so a few hours either way stays
 *  inside the same UTC day. */
const ABANDONED_AT = Date.parse("2026-10-20T09:00:00Z");
/** The sweeper's clock, `days` (and `hours`) after the abandon. */
const daysLater = (days: number, hours = 0) => ABANDONED_AT + days * DAY + hours * HOUR;

let db: DatabaseType.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let payments: SqliteFormationPaymentRepository;
let now: number;
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  now = daysLater(15);
  printed = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/**
 * A sweeper with no payment block: this deployment settles nothing (or no longer does), and the
 * payment rows it already holds are still read, as `formationPayment.payments` is wired on every
 * deployment. `refundDays` is the only switch.
 */
function sweeper(over: Partial<FormationSweeperDeps> = {}): FormationSweeper {
  const doola = fakeDoola();
  return new FormationSweeper({
    repo,
    companies,
    requests,
    parties,
    documents: new SqliteDocumentIndexRepository(db),
    docStore: new MemoryDocumentStore(),
    events: new SqliteDoolaEventRepository(db),
    doola: doola.api,
    environment: "production",
    intervalMs: 60_000,
    now: () => now,
    payments,
    refundDays: 14,
    ...over,
  });
}

/** A company formed for a legal body, with its party bound. */
function company(status: CompanyStatus = "ready"): string {
  const partyId = parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Example",
    email: "person@example.com",
    phone: "+12125550100",
    line1: "1 Example Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  const companyId = companies.create({
    tenantId: TENANT,
    status,
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Example Works", "Example Labs", "Example Studio"),
    businessPurpose: "Operating software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
  expect(parties.bindToCompany(partyId, companyId, TENANT)).toBe(true);
  return companyId;
}

let nonce = 0;
/** A formation payment for the company, quoted, then settled unless told otherwise. */
function payment(companyId: string, status: "quoted" | "settled" = "settled"): string {
  nonce += 1;
  const paymentId = payments.create({
    companyId,
    product: "formation",
    amountUsdc: AMOUNT,
    nonce: `0x${nonce.toString(16).padStart(64, "0")}` as Hex,
    validBefore: Math.floor(ABANDONED_AT / 1000) + 1800,
    payTo: REVENUE,
  });
  if (status === "quoted") return paymentId;
  expect(
    payments.markSettling(paymentId, { payerAddress: PAYER, signature: `0x${"11".repeat(65)}` }),
  ).toBe(true);
  expect(payments.markSettled(paymentId, SETTLED_TX)).toBe(true);
  return paymentId;
}

/** Abandon the company through the tenant's own door (Task 12), which stamps `updated_at`. */
function abandon(companyId: string): void {
  abandonFormedCompany(
    {
      companies,
      parties,
      requests,
      payment: paymentCfg(payments),
      transaction: (fn) => db.transaction(fn)(),
    },
    TENANT,
    companyId,
  );
}

/** Pin the abandon's stamp to an instant of the test's clock. */
function stampAbandon(companyId: string, at = ABANDONED_AT): void {
  db.prepare("UPDATE companies SET updated_at = ? WHERE company_id = ?").run(
    sqliteUtcTimestamp(at),
    companyId,
  );
}

/** A paid company abandoned by its tenant at `ABANDONED_AT`, its refund not recorded. */
function owed(): { companyId: string; paymentId: string } {
  const companyId = company();
  const paymentId = payment(companyId);
  abandon(companyId);
  stampAbandon(companyId);
  return { companyId, paymentId };
}

const overdueLines = () =>
  printed
    .filter((line) => line.includes('"opslog":"formation_refund_overdue"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

// ── the repository's reader ──────────────────────────────────────────────────────────────────

describe("listSettledAwaitingRefund", () => {
  test("lists a settled payment of an abandoned company, aged from the abandon's own stamp", () => {
    const companyId = company();
    const paymentId = payment(companyId);
    db.prepare("UPDATE companies SET updated_at = ? WHERE company_id = ?").run(
      "2026-01-01 00:00:00",
      companyId,
    );
    expect(payments.listSettledAwaitingRefund()).toEqual([]);

    abandon(companyId);

    const stamp = companies.find(companyId)!.updatedAt;
    expect(stamp).not.toBe("2026-01-01 00:00:00");
    expect(payments.listSettledAwaitingRefund()).toEqual([
      { paymentId, companyId, abandonedAt: stamp },
    ]);
  });

  test("never lists a refunded payment, a ready company's payment, or a payment never settled", () => {
    const refunded = owed();
    expect(payments.markRefunded(refunded.paymentId, REFUND_TX)).toBe(true);
    // Paid and still going: nothing is owed back.
    payment(company("ready"));
    // Abandoned with a quote nobody paid: the abandon expired it, and nothing was taken.
    const unpaid = company("draft");
    payment(unpaid, "quoted");
    abandon(unpaid);
    stampAbandon(unpaid);

    expect(payments.listSettledAwaitingRefund()).toEqual([]);
  });
});

// ── the sweeper leg ──────────────────────────────────────────────────────────────────────────

describe("the refund-overdue line", () => {
  test("day 15 with refundDays 14: one CRITICAL line, one day overdue, ids only", async () => {
    const { companyId, paymentId } = owed();

    await sweeper().tick();

    const lines = overdueLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      severity: "CRITICAL",
      companyId,
      paymentId,
      daysOverdue: 1,
    });
    // Exactly these fields: no amount, no address, no tenant, no transaction hash.
    expect(Object.keys(lines[0]!).sort()).toEqual(
      ["at", "companyId", "daysOverdue", "level", "opslog", "paymentId", "severity"].sort(),
    );
    const line = JSON.stringify(lines[0]);
    for (const leaked of [AMOUNT.toString(), PAYER, REVENUE, TENANT, SETTLED_TX])
      expect(line.toLowerCase()).not.toContain(leaked.toLowerCase());
  });

  test("day 13 writes nothing, nor a second short of day 14; day 14 itself is zero days overdue", async () => {
    owed();
    const s = sweeper();

    now = daysLater(13);
    await s.tick();
    now = daysLater(14) - 1000;
    await s.tick();
    expect(overdueLines()).toHaveLength(0);

    now = daysLater(14);
    await s.tick();
    expect(overdueLines()).toEqual([expect.objectContaining({ daysOverdue: 0 })]);
  });

  test("once per company per UTC day: a second tick the same day writes none, the next day one", async () => {
    const { companyId } = owed();
    const s = sweeper();

    now = daysLater(15);
    await s.tick();
    // A later tick the same UTC day, not an amortised one: the leg runs on every tick.
    now = daysLater(15, 6);
    await s.tick();
    expect(overdueLines()).toHaveLength(1);

    now = daysLater(16);
    await s.tick();
    expect(overdueLines()).toEqual([
      expect.objectContaining({ companyId, daysOverdue: 1 }),
      expect.objectContaining({ companyId, daysOverdue: 2 }),
    ]);
  });

  test("each company owed a refund has its own line", async () => {
    const first = owed();
    const second = owed();

    await sweeper().tick();

    expect(
      overdueLines()
        .map((l) => l.companyId)
        .sort(),
    ).toEqual([first.companyId, second.companyId].sort());
  });

  test("a recorded refund leaves the list: the next day writes nothing", async () => {
    const { paymentId } = owed();
    const s = sweeper();
    await s.tick();
    expect(overdueLines()).toHaveLength(1);

    // What `formation:refund --yes` records.
    expect(payments.markRefunded(paymentId, REFUND_TX)).toBe(true);
    now = daysLater(16);
    await s.tick();

    expect(overdueLines()).toHaveLength(1);
  });

  test("a settled payment on a ready company is never listed, however old", async () => {
    const companyId = company("ready");
    payment(companyId);
    stampAbandon(companyId, ABANDONED_AT - 60 * DAY);

    await sweeper().tick();

    expect(overdueLines()).toHaveLength(0);
  });

  test("refundDays absent: the leg does nothing", async () => {
    owed();
    now = daysLater(40);

    await sweeper({ refundDays: undefined }).tick();

    expect(overdueLines()).toHaveLength(0);
  });

  test("yesterday's de-duplication keys are pruned on the amortised tick", async () => {
    const { companyId } = owed();
    const s = sweeper();
    const warned = (s as unknown as { warned: Set<string> }).warned;

    // Tick 0 is amortised: the line, and today's key.
    await s.tick();
    expect([...warned]).toEqual([`${companyId}:refund:2026-11-04`]);

    // The next day, up to and including the next amortised tick.
    now = daysLater(16);
    for (let i = 0; i < AMORTISED_EVERY_N_TICKS; i++) await s.tick();

    expect([...warned]).toEqual([`${companyId}:refund:2026-11-05`]);
    expect(overdueLines()).toHaveLength(2);
  });
});

// ── the setting ──────────────────────────────────────────────────────────────────────────────

describe("FORMATION_REFUND_DAYS", () => {
  const BASE = {
    ARC_TESTNET_RPC_URL: "https://rpc.example",
    PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  };

  test("absent reads 14", () => {
    expect(loadConfig(BASE).formation?.refundDays).toBe(14);
  });

  test("takes a whole number of days from 1 to 60", () => {
    expect(loadConfig({ ...BASE, FORMATION_REFUND_DAYS: "1" }).formation?.refundDays).toBe(1);
    expect(loadConfig({ ...BASE, FORMATION_REFUND_DAYS: "30" }).formation?.refundDays).toBe(30);
    expect(loadConfig({ ...BASE, FORMATION_REFUND_DAYS: "60" }).formation?.refundDays).toBe(60);
  });

  test("0 is refused, and so is anything outside 1 to 60 or not a whole number", () => {
    for (const refused of ["0", "-1", "61", "2.5", "fourteen"])
      expect(() => loadConfig({ ...BASE, FORMATION_REFUND_DAYS: refused }), refused).toThrow(
        /FORMATION_REFUND_DAYS/,
      );
  });
});
