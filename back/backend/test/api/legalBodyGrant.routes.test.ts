/**
 * The three grant doors on REST, which only read: what the form of a grant must hold on this
 * deployment, a grant as the Charter would state it, and an order's grant. Beside them, the order
 * door's own grant: placed with the order, and read back. Mounted with the other order doors,
 * under the session protection, each starting with the real-human check.
 *
 * Two apps: one whose order doors serve the Charter pair (`CHARTER_LEGAL_TEXTS`), which no
 * deployment selects, and one on the October pair, the one every deployment serves. The database
 * is real (in memory) and the chain is never called: every member of the chain port throws. Every
 * amount is a made-up fixture; every name, company and filing number is an invention, and every
 * key is one of anvil's published test accounts.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { GrantChoices } from "../../src/legalBody/grant";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { CHARTER_LEGAL_TEXTS } from "../../src/legalBody/texts/sets";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  type Signer,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import { A } from "../helpers/grantFixtures";
import {
  JWT_SECRET,
  type LegalBodyStores,
  answerOf,
  call,
  customerCompany,
  legalBodyOrderDeps,
  openLegalBodyStores,
  sessionOf,
} from "../helpers/legalBodyFixtures";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. The guardian and a
 *  stranger are verified humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;
/** anvil's published account #1: a test key, signed in and never verified here. */
const unverified = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const ORDERS = "/legal-body-orders";
const FORM = `${ORDERS}/grant-form`;
const PREVIEW = `${ORDERS}/grant-preview`;
const grantPath = (id: string) => `${ORDERS}/${id}/grant`;
const agreementPath = (id: string) => `${ORDERS}/${id}/agreement`;

/** The fingerprint of fixture `A` as grant 1, version 1. */
const DIGEST_A = "0xb88cefedad48bffc885596dc29fb3c8f935774498147ed74e48395e110eb4dc1";
/** sha256 of the Schedule A of fixture `A` as grant 1, version 1. */
const SCHEDULE_A_SHA256 = "738f0a878a3e630e697d9b670bab395e80dbfa241fcdb22eed9338c21d509685";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Choices with every line not allowed: no kind of section 5.2 and no act of section 5.6. */
const none: GrantChoices = {
  acts: {
    provideServices: { allowed: false },
    acceptEngagement: { allowed: false },
    issueInvoice: { allowed: false },
    receivePayment: { allowed: false },
    buy: { allowed: false },
    pay: { allowed: false },
    engageContractor: { allowed: false },
  },
  heavyActs: {
    employ: { mode: "not_allowed" },
    borrow: { mode: "not_allowed" },
    guarantee: { mode: "not_allowed" },
    transferProperty: { mode: "not_allowed" },
  },
  counterparties: "anyone",
  endsOn: null,
};

let db: Database.Database;
let s: LegalBodyStores;
/** Every console line written in the test: the ops lines among them. */
let lines: string[];
let filings = 0;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  recordHuman(s.store, guardian.address, "3001", Date.now());
  recordHuman(s.store, stranger.address, "3002", Date.now());
  recordHuman(s.store, waived.address, "3003", Date.now(), "waiver");
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The API over this test's database, its order doors those of a sandbox deployment with room in
 *  every throttle, on the pair of texts `over` gives (the October pair unless told otherwise). */
function makeApp(over: Partial<LegalBodyOrderDeps> = {}) {
  const requests = new SqliteFormationRepository(db);
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    repo: new SqliteEntityRepository(db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: s.declarations,
      checks: s.checks,
      hasLinkedLegalBody: (companyId) => s.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders: legalBodyOrderDeps(s, over),
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    fullProductAvailable: true,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof makeApp>;

/** The app whose order doors serve Charter draft 4 with declaration draft 2. */
const charterApp = (over: Partial<LegalBodyOrderDeps> = {}) =>
  makeApp({ texts: CHARTER_LEGAL_TEXTS, ...over });
/** The app whose order doors serve the October pair. */
const octoberApp = (over: Partial<LegalBodyOrderDeps> = {}) => makeApp(over);

/** A checked company of `who`, with a filing number no other company of the test holds. */
const company = (who: Signer) =>
  customerCompany(s, who.address, { filingNumber: `TEST-${String(++filings).padStart(4, "0")}` });

/** The rows a table holds, for every order. */
const rowsOf = (table: "legal_bodies" | "charter_grants") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** An order placed through the door: its id. */
async function ordered(app: App, token: string, body: object): Promise<string> {
  const res = await answerOf(await call(app, "POST", ORDERS, token, body));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** The refusal envelope of a code, with its sentence and, when given, its problems. */
const refused = (code: string, details?: { field: string; problem: string }[]) => ({
  error: {
    code,
    message: LEGAL_BODY_SENTENCES[code],
    ...(details === undefined ? {} : { details }),
  },
});

// ── The form ────────────────────────────────────────────────────────────────────────────────

describe("the form of a grant", () => {
  test("the form's rules are served, and they propose no value", async () => {
    const token = await sessionOf(guardian);

    const charter = await answerOf(await call(charterApp(), "GET", FORM, token));
    expect(charter.status).toBe(200);
    expect(charter.body).toEqual({
      takesGrant: true,
      text: { id: "legal-body-operating-agreement", version: "2026-11-draft-4", status: "draft" },
      schema: "novi.legal-body-grant/1",
      amountMax: 1000000000,
      heavyActModes: {
        employ: ["not_allowed", "guardian_signature"],
        borrow: ["not_allowed", "guardian_signature", "alone"],
        guarantee: ["not_allowed", "guardian_signature", "alone"],
        transferProperty: ["not_allowed", "guardian_signature"],
      },
    });

    const october = await answerOf(await call(octoberApp(), "GET", FORM, token));
    expect(october.status).toBe(200);
    expect(october.body).toEqual({ takesGrant: false });
  });

  test("grant-form is never read as an order's id", async () => {
    // A tenant with no order at all: the read door would answer its uniform 404.
    const token = await sessionOf(stranger);
    expect(s.repo.listByTenant(stranger.address)).toEqual([]);
    for (const app of [charterApp(), octoberApp()]) {
      const res = await answerOf(await call(app, "GET", FORM, token));
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("takesGrant");
    }
  });
});

// ── The preview ─────────────────────────────────────────────────────────────────────────────

describe("the preview of a grant", () => {
  test("the preview answers the grant as the order would state it, and writes nothing", async () => {
    const token = await sessionOf(guardian);
    const res = await answerOf(await call(charterApp(), "POST", PREVIEW, token, { grant: A }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["grant"]);
    const { grant } = res.body;
    expect(Object.keys(grant).sort()).toEqual(
      ["choices", "digest", "number", "scheduleA", "version", "wording"].sort(),
    );
    expect(grant.number).toBe(1);
    expect(grant.version).toBe(1);
    expect(grant.digest).toBe(DIGEST_A);
    expect(grant.wording).toBe("2026-11-draft-4");
    expect(grant.choices).toEqual(A);
    expect(sha256(grant.scheduleA)).toBe(SCHEDULE_A_SHA256);

    expect(rowsOf("legal_bodies")).toBe(0);
    expect(rowsOf("charter_grants")).toBe(0);
    expect(s.docStore.files.size).toBe(0);
  });

  test("a preview that is not valid is the order's own refusal", async () => {
    const app = charterApp();
    const token = await sessionOf(guardian);

    const nothingAllowed = await answerOf(await call(app, "POST", PREVIEW, token, { grant: none }));
    expect(nothingAllowed.status).toBe(400);
    expect(nothingAllowed.body).toEqual(
      refused("grant_not_valid", [{ field: "grant", problem: "must allow at least one act" }]),
    );

    const absent = await answerOf(await call(app, "POST", PREVIEW, token, {}));
    expect(absent.status).toBe(400);
    expect(absent.body).toEqual(
      refused("grant_not_valid", [{ field: "grant", problem: "must be an object" }]),
    );

    const notJson = await answerOf(await call(app, "POST", PREVIEW, token, "{not json"));
    expect(notJson.status).toBe(400);
    expect(notJson.body).toEqual({
      error: { code: "validation_error", message: "invalid JSON body" },
    });
  });

  test("the preview is refused where the agreement takes no grant", async () => {
    const app = octoberApp();
    const token = await sessionOf(guardian);
    for (const body of [{ grant: A }, {}]) {
      const res = await answerOf(await call(app, "POST", PREVIEW, token, body));
      expect(res.status).toBe(400);
      expect(res.body).toEqual(refused("grant_not_taken"));
    }
  });
});

// ── An order's grant ────────────────────────────────────────────────────────────────────────

describe("an order's grant", () => {
  test("an order is placed with its grant, and its grant is read back", async () => {
    const app = charterApp();
    const token = await sessionOf(guardian);
    const placed = await answerOf(
      await call(app, "POST", ORDERS, token, { companyId: company(guardian), grant: A }),
    );
    expect(placed.status).toBe(201);
    const id = placed.body.id as string;

    const preview = await answerOf(await call(app, "POST", PREVIEW, token, { grant: A }));
    expect(preview.status).toBe(200);
    const read = await answerOf(await call(app, "GET", grantPath(id), token));
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ grant: preview.body.grant });
    expect(read.body.grant.digest).toBe(DIGEST_A);
    expect(sha256(read.body.grant.scheduleA)).toBe(SCHEDULE_A_SHA256);

    const agreement = await answerOf(await call(app, "GET", agreementPath(id), token));
    expect(agreement.status).toBe(200);
    expect(agreement.body.textVersion).toBe("2026-11-draft-4");
    expect(agreement.body.termsDoc).toContain(read.body.grant.scheduleA);

    // The order's view is the one an October order has: no new key.
    const october = await answerOf(
      await call(octoberApp(), "POST", ORDERS, token, { companyId: company(guardian) }),
    );
    expect(october.status).toBe(201);
    expect(Object.keys(placed.body)).toEqual(Object.keys(october.body));
  });

  test("an order with a grant that is not valid is refused with its problems", async () => {
    const token = await sessionOf(guardian);
    const res = await answerOf(
      await call(charterApp(), "POST", ORDERS, token, {
        companyId: company(guardian),
        grant: { ...A, endsOn: "1999-01-01" },
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      refused("grant_not_valid", [{ field: "endsOn", problem: "must be after today (UTC)" }]),
    );
    expect(rowsOf("legal_bodies")).toBe(0);
    expect(rowsOf("charter_grants")).toBe(0);
  });

  test("an order on the October pair has no grant", async () => {
    const app = octoberApp();
    const token = await sessionOf(guardian);
    const id = await ordered(app, token, { companyId: company(guardian) });

    const read = await answerOf(await call(app, "GET", grantPath(id), token));
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ grant: null });

    const res = await answerOf(
      await call(app, "POST", ORDERS, token, { companyId: company(guardian), grant: A }),
    );
    expect(res.status).toBe(400);
    expect(res.body).toEqual(refused("grant_not_taken"));
    expect(rowsOf("legal_bodies")).toBe(1);
    expect(rowsOf("charter_grants")).toBe(0);
  });

  test("another tenant's order has no grant to show", async () => {
    const app = charterApp();
    const id = await ordered(app, await sessionOf(guardian), {
      companyId: company(guardian),
      grant: A,
    });
    const theirs = await sessionOf(stranger);

    const res = await answerOf(await call(app, "GET", grantPath(id), theirs));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(refused("not_found"));
    // An unknown id gets the very same answer.
    const unknown = await answerOf(await call(app, "GET", grantPath("lb_unknown"), theirs));
    expect(unknown).toMatchObject({ status: res.status, body: res.body });
  });
});

// ── The body limit ──────────────────────────────────────────────────────────────────────────

describe("each JSON door takes a body of at most 8 KiB", () => {
  test("a body over 8 KiB is refused before it is read", async () => {
    const app = charterApp();
    const token = await sessionOf(guardian);
    const companyId = company(guardian);
    /** A grant holding one key of 9,000 characters. */
    const long = { ["k".repeat(9_000)]: true };
    const bodies = [
      { path: ORDERS, body: JSON.stringify({ companyId, grant: long }) },
      { path: PREVIEW, body: JSON.stringify({ grant: long }) },
      // Not JSON at all: a 413, not the reader's 400, since nothing of it was read.
      { path: PREVIEW, body: `{${"k".repeat(9_000)}` },
    ];
    for (const { path, body } of bodies) {
      const res = await answerOf(await call(app, "POST", path, token, body));
      expect(res, path).toMatchObject({ status: 413, body: refused("payload_too_large") });
    }
    expect(rowsOf("legal_bodies")).toBe(0);
    expect(rowsOf("charter_grants")).toBe(0);
    expect(s.docStore.files.size).toBe(0);
  });
});

// ── Who may use the doors ───────────────────────────────────────────────────────────────────

describe("who may use the grant doors", () => {
  /** Each of the three grant doors, with a body where it reads one. */
  const doors = (id: string) =>
    [
      { method: "GET", path: FORM },
      { method: "POST", path: PREVIEW, body: { grant: A } },
      { method: "GET", path: grantPath(id) },
    ] as const;

  test("every door starts with the session and the real human", async () => {
    for (const app of [charterApp(), octoberApp()]) {
      for (const door of doors("lb_any")) {
        const res = await call(
          app,
          door.method,
          door.path,
          undefined,
          "body" in door ? door.body : undefined,
        );
        expect(res.status, `${door.method} ${door.path} without a session`).toBe(401);
      }

      for (const who of [waived, unverified]) {
        // Its order is written through the repository: no door would make it.
        const own = s.repo.create({
          tenantId: who.address,
          companyId: company(who),
          chainId: CHAIN_ID,
          factory: FACTORY,
          amendmentDelay: 172_800,
        });
        const token = await sessionOf(who);
        const list = await answerOf(await call(app, "GET", ORDERS, token));
        expect(list.status).toBe(403);
        for (const door of doors(own.legalBodyId)) {
          const res = await answerOf(
            await call(app, door.method, door.path, token, "body" in door ? door.body : undefined),
          );
          expect(res.status, `${door.method} ${door.path} for ${who.address}`).toBe(list.status);
          expect(res.body.error.code, `${door.method} ${door.path} for ${who.address}`).toBe(
            list.body.error.code,
          );
        }
      }
    }
  });

  test("no door of the three takes a token", async () => {
    const empty = { take: () => false };
    const app = charterApp({
      doorBudget: empty,
      tenantBucket: () => empty,
      identityBucket: () => empty,
    });
    const token = await sessionOf(guardian);
    // Placed on an app with room in every throttle, then read on the one with none.
    const id = await ordered(charterApp(), token, { companyId: company(guardian), grant: A });

    for (const door of doors(id)) {
      const res = await answerOf(
        await call(app, door.method, door.path, token, "body" in door ? door.body : undefined),
      );
      expect(res.status, `${door.method} ${door.path}`).toBe(200);
    }
  });
});
