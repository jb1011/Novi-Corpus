/**
 * The legal-body order and the guardian identity record: the order is a second door, and on
 * production it holds the guardian to the same record the declared door does.
 *
 * On production `createOrder` checks the World row first (`assertRealHuman`), then the guardian's
 * identity record (`assertIdentityVerified`), before the agreement's wording and before any row,
 * event or file is written. A verified record goes on exactly as today: the agreement's wording is
 * still a draft, which a production deployment does not serve, so the next answer is the wording's
 * 503. On a sandbox the record is never read and the order is born a draft, as today.
 *
 * The database is real (in memory); the chain is never called. Every name, company and filing
 * number is an invention, the PII key a constant test key, and every key one of anvil's published
 * test accounts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { LegalBodyChainPort } from "../../src/adapters/arc/legalBodyChain";
import { buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { ApiError } from "../../src/errors";
import { IDENTITY_NOT_VERIFIED_MESSAGE, type IdentityDeps } from "../../src/identity/state";
import { type LegalBodyOrderDeps, createOrder } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type IdentityRepository,
  SqliteIdentityRepository,
} from "../../src/persistence/identityRepository";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_4,
  TEST_PII_RING,
  identityOver,
  recordHuman,
  recordIdentity,
} from "../helpers/customerCompanyFixtures";
import {
  type LegalBodyStores,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** The guardian, verified by World ID, and a tenant that never verified: anvil's accounts. */
const guardian = ANVIL_ACCOUNT_2.address;
const unverified = ANVIL_ACCOUNT_4.address;

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const DAY_MS = 24 * 60 * 60 * 1000;

let s: LegalBodyStores;
let identityRepo: SqliteIdentityRepository;
let identity: IdentityDeps;
/** The identity clock, in milliseconds: the real time, as the order doors' own clock is. */
let nowMs: number;

beforeEach(() => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  identityRepo = new SqliteIdentityRepository(db);
  nowMs = Date.now();
  identity = identityOver(identityRepo, () => nowMs);
  recordHuman(s.store, guardian, "3001", nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** A passed identity record of `tenant`, completed a month ago and due for renewal at
 *  `expiresAt`, written through the repository as the operator's command writes one. */
function passedRecord(expiresAt: number, tenant: Address = guardian): void {
  recordIdentity(identityRepo, tenant, { at: nowMs - 30 * DAY_MS, expiresAt });
}

/** A verified guardian: a passed record due for renewal in three years. */
const verified = (tenant: Address = guardian): void =>
  passedRecord(nowMs + 3 * 365 * DAY_MS, tenant);

/** The order deps of a production deployment, the identity record wired over the real
 *  repository; the chain is never called. */
function production(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, {
    chain: {} as LegalBodyChainPort,
    environment: "production",
    identity,
    ...over,
  });
}

/** A checked customer company of `owner`: its declaration and one passed check. */
const company = (owner: Address = guardian): string =>
  customerCompany(s, owner, { humanNullifier: owner === guardian ? "3001" : "3999" });

/** The refusal `run` threw, checked for its code and status. */
function refused(run: () => unknown, code: string, status: number): ApiError {
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(ApiError);
  const err = caught as ApiError;
  expect({ code: err.code, status: err.status }).toEqual({ code, status });
  return err;
}

const countRows = (table: string): number =>
  (s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Nothing of an order was written: no row, no event, no agreement file. */
function nothingWritten(): void {
  expect(countRows("legal_bodies")).toBe(0);
  expect(countRows("legal_body_events")).toBe(0);
  expect(s.docStore.files.size).toBe(0);
}

describe("on production the order requires a verified guardian identity record", () => {
  test("a guardian with a World row and no identity record: 403 guardian_identity_not_verified, before any row is written", () => {
    const companyId = company();
    const err = refused(
      () => createOrder(production(), guardian, { companyId }),
      "guardian_identity_not_verified",
      403,
    );
    expect(err.message).toBe(IDENTITY_NOT_VERIFIED_MESSAGE);
    nothingWritten();
  });

  test("an expired record: 403 guardian_identity_not_verified, nothing written", () => {
    passedRecord(nowMs - DAY_MS);
    refused(
      () => createOrder(production(), guardian, { companyId: company() }),
      "guardian_identity_not_verified",
      403,
    );
    nothingWritten();
  });

  test("the identity record not wired on production: 503 identity_unavailable, nothing written", () => {
    verified();
    refused(
      () => createOrder(production({ identity: undefined }), guardian, { companyId: company() }),
      "identity_unavailable",
      503,
    );
    nothingWritten();
  });

  test("the World row comes first: a tenant that never verified is answered guardian_not_verified, whatever its identity record", () => {
    verified(unverified);
    refused(
      () => createOrder(production(), unverified, { companyId: company(unverified) }),
      "guardian_not_verified",
      403,
    );
    nothingWritten();
  });

  test("a verified record: the order goes on as today, to the wording's check (a draft agreement is not served on production)", () => {
    verified();
    const err = refused(
      () => createOrder(production(), guardian, { companyId: company() }),
      "legal_text_not_approved",
      503,
    );
    expect(err.message).toBe(LEGAL_BODY_SENTENCES.legal_text_not_approved);
    nothingWritten();
  });

  test("the door answers the refusal as it is: POST /legal-body-orders, 403 guardian_identity_not_verified", async () => {
    // The API as the composition root builds it, with the order doors only.
    const app = buildApiApp({
      webOrigin: "*",
      jwtSecret: JWT_SECRET,
      legalBodyOrders: production(),
    } as never);
    const { token } = await signSession(guardian, JWT_SECRET, 3600, Math.floor(nowMs / 1000));
    const res = await app.request("/legal-body-orders", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ companyId: company() }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "guardian_identity_not_verified",
      message: IDENTITY_NOT_VERIFIED_MESSAGE,
    });
    nothingWritten();
  });
});

describe("on a sandbox nothing changes, and the identity record is never read", () => {
  test("the order is born a draft, without one identity read", () => {
    let reads = 0;
    const refuse = (): never => {
      reads += 1;
      throw new Error("a sandbox order read the identity record");
    };
    const repo: IdentityRepository = {
      append: refuse,
      latest: refuse,
      list: refuse,
      events: refuse,
      findById: refuse,
      passedElsewhere: refuse,
      eraseNames: refuse,
      erasureCandidates: refuse,
      transaction: refuse,
    };
    const untouchable: IdentityDeps = {
      repo,
      pii: TEST_PII_RING,
      reverifyYears: 3,
      blockedCountries: new Set(),
      now: refuse,
    };
    const view = createOrder(
      production({ environment: "sandbox", identity: untouchable }),
      guardian,
      { companyId: company() },
    );
    expect(view.state).toBe("draft");
    expect(countRows("legal_bodies")).toBe(1);
    expect(reads).toBe(0);
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the other composition guards do: the order doors are handed the identity record main.ts
 * builds where the PII key is set.
 */
test("the composition root hands the order doors the identity record", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const at = main.indexOf("const legalBodyOrders =");
  expect(at, "the order deps were not found").toBeGreaterThan(0);
  const orders = main.slice(at, main.indexOf(": undefined;", at));
  expect(orders).toMatch(/^ {10}identity,$/m);
  expect(main.indexOf("const identity: IdentityDeps | undefined = cfg.pii")).toBeLessThan(at);
});
