/**
 * The company's pot on REST: `POST /legal-body-orders/:id/pot`, the guardian's note of the pot's
 * address with its birth details and declaration, before the setup transaction; and
 * `GET /legal-body-orders/:id/pot`, the note as the guardian's page reads it. Mounted beside the
 * order doors only where the deployment wires the pot, and answering only while the pot's seven
 * contracts are verified (Rulings R1 and R11).
 *
 * The doors over a real in-memory database, a fake registry and a fake chain port, on a fixed
 * clock. G, A and P are the real run's public addresses, never a key, and V3 the pinned vector;
 * every other key is one of anvil's published test accounts, every other address a placeholder.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import {
  JWT_SECRET,
  type LegalBodyStores,
  OTHER_FACTORY,
  answerOf,
  call,
  legalBodyOrderDeps,
  openLegalBodyStores,
  sessionOf,
} from "../helpers/legalBodyFixtures";
import {
  A,
  G,
  V3_ADDRESS,
  V3_INPUT,
  fakePotChain,
  fakeRegistry,
  potBody,
  potDeps,
} from "../helpers/potFixtures";

/** The clock: 2026-11-24T12:00:00Z. */
const NOW_MS = Date.parse("2026-11-24T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;

/** anvil's published accounts #3 and #4: a stranger with a verified human, and a tenant with
 *  none, never real wallets. */
const stranger = ANVIL_ACCOUNT_3;

const potPath = (id: string) => `/legal-body-orders/${id}/pot`;

let s: LegalBodyStores;
let registry: ReturnType<typeof fakeRegistry>;
let chain: ReturnType<typeof fakePotChain>;
let offered: boolean;
/** G's session: G is the real run's guardian, whose key no test holds, so its token is signed
 *  directly over its address. */
let guardianToken: string;

beforeEach(async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  s = openLegalBodyStores(db);
  registry = fakeRegistry();
  chain = fakePotChain();
  offered = true;
  vi.spyOn(console, "log").mockImplementation(() => {});
  recordHuman(s.store, stranger.address, "pot-stranger", NOW_MS - 60_000);
  guardianToken = await sessionOf({ address: G } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** The API over this test's database: the order doors (with `orders` over their defaults), and
 *  the pot's deps unless `pot` is false. */
function makeApp(o: { orders?: Partial<LegalBodyOrderDeps>; pot?: boolean } = {}) {
  const requests = new SqliteFormationRepository(s.db);
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    now: () => NOW_MS,
    repo: new SqliteEntityRepository(s.db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: { declarations: s.declarations, checks: s.checks },
    legalBodyOrders: legalBodyOrderDeps(s, { now: () => NOW_MS, ...o.orders }),
    legalBodyPot:
      o.pot === false
        ? undefined
        : potDeps(s, {
            registry: { getAgentWallet: registry.getAgentWallet },
            chain: chain.port,
            now: () => NOW_MS,
            offered: () => offered,
          }),
    apiKeys: new SqliteApiKeyStore(s.db),
    passkeys: new SqlitePasskeyStore(s.db),
    jobs: new SqliteJobRepository(s.db),
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

/** A linked body of G whose agent's wallet the registry names as A. */
function linkedBody(): LegalBodyRecord {
  const row = potBody(s, { nowMs: NOW_MS });
  registry.wallets.set(row.agentId as string, A);
  return row;
}

const post = async (app: App, id: string, body: unknown, token = guardianToken) =>
  answerOf(await call(app, "POST", potPath(id), token, body as object));
const read = async (app: App, id: string, token = guardianToken) =>
  answerOf(await call(app, "GET", potPath(id), token));

const rows = () => s.db.prepare("SELECT * FROM pot_declarations").all();

/** A REST refusal: the house envelope, with the code's fixed sentence. */
const refused = (status: number, code: string) => ({
  status,
  body: { error: { code, message: LEGAL_BODY_SENTENCES[code] } },
});

const V3_VIEW = {
  address: V3_ADDRESS,
  onRecord: true,
  declaredAt: NOW_S,
  birth: { saltNonce: "1", agentWallet: A, ceilingUnits: "50000000" },
};

describe("POST and GET /legal-body-orders/:id/pot", () => {
  test("the note: 200 with the view, and the read answers the same; before it, { pot: null }", async () => {
    const row = linkedBody();
    const app = makeApp();
    expect(await read(app, row.legalBodyId)).toEqual({
      status: 200,
      body: { pot: null },
      text: JSON.stringify({ pot: null }),
    });
    const noted = await post(app, row.legalBodyId, V3_INPUT);
    expect(noted).toMatchObject({ status: 200, body: V3_VIEW });
    expect(await read(app, row.legalBodyId)).toMatchObject({ status: 200, body: { pot: V3_VIEW } });
    expect(rows()).toHaveLength(1);
  });

  test("the refusals: 400 pot_invalid, 400 pot_declaration_required, 409 pot_address_mismatch, each with its sentence and nothing else", async () => {
    const row = linkedBody();
    const app = makeApp();
    expect(
      await post(app, row.legalBodyId, { ...V3_INPUT, ceilingUnits: "2500000" }),
    ).toMatchObject(refused(400, "pot_invalid"));
    expect(
      await post(app, row.legalBodyId, { ...V3_INPUT, declarationVersion: "pot-declaration-0" }),
    ).toMatchObject(refused(400, "pot_declaration_required"));
    const mismatch = await post(app, row.legalBodyId, { ...V3_INPUT, saltNonce: "2" });
    expect(mismatch).toMatchObject(refused(409, "pot_address_mismatch"));
    // The answer names no address and no hash.
    expect(Object.keys(mismatch.body.error).sort()).toEqual(["code", "message"]);
    expect(mismatch.text).not.toMatch(/0x/i);
    expect(rows()).toEqual([]);
  });

  test("a body that is not linked: 409 order_closed; a row of another factory: 409 other_deployment; neither reads the chain", async () => {
    const app = makeApp();
    const deployed = potBody(s, { nowMs: NOW_MS, state: "deployed" });
    expect(await post(app, deployed.legalBodyId, V3_INPUT)).toMatchObject(
      refused(409, "order_closed"),
    );
    const row = linkedBody();
    const elsewhere = makeApp({
      orders: { deployment: { chainId: CHAIN_ID, factory: OTHER_FACTORY } },
    });
    expect(await post(elsewhere, row.legalBodyId, V3_INPUT)).toMatchObject(
      refused(409, "other_deployment"),
    );
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(chain.port.codeHash).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("another tenant's body and an unknown id: one 404 on both doors", async () => {
    const row = linkedBody();
    const app = makeApp();
    const token = await sessionOf(stranger);
    for (const id of [row.legalBodyId, `lb_${"0".repeat(36)}`]) {
      expect(await post(app, id, V3_INPUT, token), id).toMatchObject(refused(404, "not_found"));
      expect(await read(app, id, token), id).toMatchObject(refused(404, "not_found"));
    }
  });

  test("the throttle: an empty tenant bucket is 429 rate_limited, with no read of the order, the registry or the chain, and nothing stored", async () => {
    const row = linkedBody();
    const findOwned = vi.spyOn(s.repo, "findOwned");
    const app = makeApp({ orders: { tenantBucket: () => ({ take: () => false }) } });
    expect(await post(app, row.legalBodyId, V3_INPUT)).toMatchObject(refused(429, "rate_limited"));
    expect(findOwned).not.toHaveBeenCalled();
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("the token is taken after the real-human check and before the order is read: a probe of an unknown id spends one", async () => {
    const row = linkedBody();
    let tokens = 1;
    const take = vi.fn(() => tokens-- > 0);
    const app = makeApp({ orders: { tenantBucket: () => ({ take }) } });
    // A tenant with no verification is refused first, and spends nothing.
    const unverified = await sessionOf(ANVIL_ACCOUNT_4);
    expect(await post(app, row.legalBodyId, V3_INPUT, unverified)).toMatchObject({
      status: 403,
      body: { error: { code: "guardian_not_verified" } },
    });
    expect(take).not.toHaveBeenCalled();
    expect(await post(app, `lb_${"0".repeat(36)}`, V3_INPUT)).toMatchObject(
      refused(404, "not_found"),
    );
    expect(await post(app, row.legalBodyId, V3_INPUT)).toMatchObject(refused(429, "rate_limited"));
    expect(take).toHaveBeenCalledTimes(2);
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("the read takes no token and checks the real human first", async () => {
    const row = linkedBody();
    const take = vi.fn(() => false);
    const app = makeApp({ orders: { tenantBucket: () => ({ take }) } });
    expect(await read(app, row.legalBodyId)).toMatchObject({ status: 200, body: { pot: null } });
    expect(take).not.toHaveBeenCalled();
    const unverified = await sessionOf(ANVIL_ACCOUNT_4);
    expect(await read(app, row.legalBodyId, unverified)).toMatchObject({
      status: 403,
      body: { error: { code: "guardian_not_verified" } },
    });
  });

  test("no session: 401; a body that is not JSON: 400; one over 8 KiB: 413", async () => {
    const row = linkedBody();
    const app = makeApp();
    expect((await call(app, "POST", potPath(row.legalBodyId), undefined, V3_INPUT)).status).toBe(
      401,
    );
    expect((await call(app, "GET", potPath(row.legalBodyId), undefined)).status).toBe(401);
    expect(
      await answerOf(await call(app, "POST", potPath(row.legalBodyId), guardianToken, "{not json")),
    ).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
    expect(
      await post(app, row.legalBodyId, { ...V3_INPUT, saltNonce: "1".repeat(9_000) }),
    ).toMatchObject(refused(413, "payload_too_large"));
    expect(rows()).toEqual([]);
  });

  test("without the pot's deps neither door is mounted: 404", async () => {
    const row = linkedBody();
    const app = makeApp({ pot: false });
    expect(
      (await call(app, "POST", potPath(row.legalBodyId), guardianToken, V3_INPUT)).status,
    ).toBe(404);
    expect((await call(app, "GET", potPath(row.legalBodyId), guardianToken)).status).toBe(404);
  });

  test("while the pot's contracts are not verified both doors answer 409 pot_not_offered, before the token and any read, and answer again once they are", async () => {
    const row = linkedBody();
    const take = vi.fn(() => true);
    const findOwned = vi.spyOn(s.repo, "findOwned");
    const app = makeApp({ orders: { tenantBucket: () => ({ take }) } });
    offered = false;
    for (const answer of [
      await post(app, row.legalBodyId, V3_INPUT),
      await read(app, row.legalBodyId),
    ]) {
      expect(answer).toMatchObject(refused(409, "pot_not_offered"));
      // The sentence is fixed: no hash, no address, no reason of the check.
      expect(answer.text).not.toMatch(/0x|mismatch|unreadable/i);
    }
    expect(take).not.toHaveBeenCalled();
    expect(findOwned).not.toHaveBeenCalled();
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    offered = true;
    expect(await post(app, row.legalBodyId, V3_INPUT)).toMatchObject({
      status: 200,
      body: V3_VIEW,
    });
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the treasury's composition guard does: the pot's start-up check is started, never awaited, so
 * the server boots in every outcome; its flag is what the pot's deps answer; the deps exist only
 * where the order doors' do and the chain has a pot table; and they are handed to the API after the
 * treasury's, the check's retry stopped at shutdown.
 */
test("the composition root starts the pot's check without waiting for it, and wires the pot's deps over its flag", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  expect(main).not.toMatch(/await\s+assertPotContracts/);
  expect(main).toMatch(/^ {2}const potTable = potAddresses\(cfg\.chainId\);$/m);
  const gateAt = main.indexOf("const potGate");
  expect(gateAt, "the pot's gate was not found").toBeGreaterThan(0);
  const gate = main.slice(gateAt, main.indexOf(": undefined;", gateAt));
  expect(gate).toMatch(/legalBodyOrders && potTable/);
  expect(gate).toMatch(/startPotContractsGate\(\{/);
  expect(gate).toMatch(/check: \(\) => assertPotContracts\(publicClient, potTable\)/);
  const potAt = main.indexOf("const legalBodyPot");
  expect(potAt, "the pot's deps were not found").toBeGreaterThan(gateAt);
  const built = main.slice(potAt, main.indexOf(": undefined;", potAt));
  expect(built).toMatch(/legalBodyOrders && potTable && potGate/);
  expect(built).toMatch(/repo: new SqliteLegalBodyPotRepository\(db\)/);
  expect(built).toMatch(/registry: arc,/);
  expect(built).toMatch(/bodies: legalBodyOrders\.repo,/);
  expect(built).toMatch(/chain: new SafePotChain\(\{ publicClient, addresses: potTable \}\)/);
  expect(built).toMatch(/chainId: cfg\.chainId,/);
  expect(built).toMatch(/grants: legalBodyOrders\.grants,/);
  expect(built).toMatch(/docStore,/);
  expect(built).toMatch(/offered: potGate\.offered,/);
  expect(main).toMatch(/^ {4}legalBodyTreasury,\n(?: {4}\/\/.*\n)* {4}legalBodyPot,$/m);
  expect(main).toMatch(/\.\.\.\(potGate \? \[potGate\] : \[\]\)/);
});
