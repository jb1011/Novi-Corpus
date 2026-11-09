/**
 * The treasury of record on REST: `POST /legal-body-orders/:id/treasury`, the guardian's
 * declaration of the wallet its agent pays from, and the `treasury` block the two public lookup
 * answers serve beside the signed statement, unsigned, and only while the registry still shows that
 * wallet as the agent's (Ruling 3).
 *
 * The doors, the statement service and the lookups over a real in-memory database, a fake chain
 * and a fake registry that reads the same wallets, on a fixed clock. Every key is one of anvil's
 * published test accounts, every other address a placeholder, every link and name an invention.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, getAddress, zeroAddress } from "viem";
import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { statementForAgent } from "../../src/legalBody/statements";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqliteLegalBodyTreasuryRepository } from "../../src/persistence/legalBodyTreasuryRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { ANVIL_ACCOUNT_2, ANVIL_ACCOUNT_3, CHAIN_ID } from "../helpers/customerCompanyFixtures";
import {
  JWT_SECRET,
  OTHER_FACTORY,
  answerOf,
  call,
  legalBodyOrderDeps,
  sessionOf,
} from "../helpers/legalBodyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FakeStatementChain,
  type StatementStores,
  TENANT,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

/** anvil's published account #2 is the tenant of every body here; #3 holds no verification. */
const guardian = ANVIL_ACCOUNT_2;
const unverified = ANVIL_ACCOUNT_3;

/** Placeholders: the smart wallet the agent pays from, and another one. */
const WALLET = getAddress("0x0000000000000000000000000000000000c0ffee");
const ELSEWHERE = getAddress("0x00000000000000000000000000000000000e15e0");
/** An invented page where a provider shows a wallet's limits. */
const LIMITS = "https://limits.example.test/wallets/0001";

const treasuryPath = (id: string) => `/legal-body-orders/${id}/treasury`;
const byAgent = "/legal-bodies/by-agent/42";
const byAddress = (a: Address) => `/legal-bodies/${a}`;
/** The memo's window: a lookup after it reads again. */
const MEMO_WINDOW_MS = 15_000;

let s: StatementStores;
let treasuries: SqliteLegalBodyTreasuryRepository;
let chain: FakeStatementChain;
let clock: number;
/** The registry: it reads the fake chain's wallets, so the door and the statement agree. */
let getAgentWallet: Mock<(agentId: bigint) => Promise<Address>>;
let printed: string[];

beforeEach(() => {
  s = openStatementStores();
  treasuries = new SqliteLegalBodyTreasuryRepository(s.db);
  chain = new FakeStatementChain();
  clock = CLOCK_MS;
  getAgentWallet = vi.fn(
    async (agentId: bigint) => chain.wallets.get(agentId.toString()) ?? zeroAddress,
  );
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

// biome-ignore lint/suspicious/noExplicitAny: an ops line, read field by field
type OpsLine = Record<string, any>;

/** The ops lines printed for `event`, each without its `opslog` and `at` fields. */
function opsLines(event: string): OpsLine[] {
  return printed.flatMap((line) => {
    try {
      const { opslog, at: _at, ...fields } = JSON.parse(line) as OpsLine;
      return opslog === event ? [fields] : [];
    } catch {
      return [];
    }
  });
}

/**
 * The API over this test's database: the order doors (with `orders` over their defaults), the
 * treasury's deps unless `treasury` is false, the statement by agent and the lookup by address,
 * whose resolver knows no full-product address.
 */
function makeApp(o: { orders?: Partial<LegalBodyOrderDeps>; treasury?: boolean } = {}) {
  const requests = new SqliteFormationRepository(s.db);
  const readBudget = { take: () => true };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: CHAIN_ID,
    now: () => clock,
    repo: new SqliteEntityRepository(s.db),
    companies: s.companies,
    docStore: s.docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations: s.declarations,
      checks: s.checks,
      hasLinkedLegalBody: (companyId) => s.repo.hasLinkedForCompany(companyId),
    },
    legalBodyOrders: legalBodyOrderDeps(s, { now: () => clock, ...o.orders }),
    legalBodyTreasury:
      o.treasury === false ? undefined : { repo: treasuries, registry: { getAgentWallet } },
    legalBodyStatements: statementDeps(s, chain, { now: () => clock, readBudget }),
    legalBody: {
      resolver: { resolve: async () => ({ kind: "none" }) },
      readBudget: readBudget as never,
      links: {
        transparency: "https://www.example.test/transparency",
        metadataBase: "https://api.example.test",
      },
      network: "testnet",
    },
    apiKeys: new SqliteApiKeyStore(s.db),
    passkeys: new SqlitePasskeyStore(s.db),
    jobs: new SqliteJobRepository(s.db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}
type App = ReturnType<typeof makeApp>;

/** A linked body of the tenant for agent 42, linked on chain too, the registry showing `wallet`
 *  as the agent's wallet (the attach done). */
function linkedBody(wallet: Address = WALLET): LegalBodyRecord {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  const row = bodyIn("linked", s, companyId);
  chain.link(row, { wallet });
  return row;
}

const declareOver = async (app: App, id: string, body: unknown, token?: string) =>
  answerOf(
    await call(app, "POST", treasuryPath(id), token ?? (await sessionOf(guardian)), body as object),
  );

const lookup = async (app: App, path: string) => {
  const res = await answerOf(await app.request(path));
  expect(res.status, path).toBe(200);
  return res.body;
};

const rows = () => s.db.prepare("SELECT * FROM treasury_declarations").all();

/** Records the operator's revocation of the body, as `legal-body:revoke` does: an event, with the
 *  row left in its state. */
const revoke = (row: LegalBodyRecord) =>
  s.repo.recordEvent(row.legalBodyId, "revoked", "operator:ops.example", null, {
    reason: "Recorded for a test.",
  });

/** A REST refusal: the house envelope, with the code's fixed sentence. */
const refused = (status: number, code: string) => ({
  status,
  body: { error: { code, message: LEGAL_BODY_SENTENCES[code] } },
});

describe("the door, POST /legal-body-orders/:id/treasury", () => {
  test("declares the wallet the registry shows: 200 with the view, never checked by Novi; the event and the ops line carry no link", async () => {
    const row = linkedBody();
    const app = makeApp();
    const res = await declareOver(app, row.legalBodyId, {
      address: WALLET,
      provider: "crossmint",
      limitsReadableAt: LIMITS,
      registryTxHash: `0x${"ab".repeat(32)}`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: WALLET,
      provider: "crossmint",
      providerName: null,
      limitsReadableAt: LIMITS,
      declaredBy: "guardian",
      declaredAt: CLOCK_S,
      checkedByNovi: false,
    });
    expect(getAgentWallet.mock.calls).toEqual([[42n]]);
    expect(rows()).toHaveLength(1);
    const events = s.repo.listEvents(row.legalBodyId).filter((e) => e.kind === "note");
    expect(events.map((e) => [e.actor, e.detail])).toEqual([
      ["tenant", { act: "treasury_declared", provider: "crossmint" }],
    ]);
    expect(opsLines("legal_body_treasury_declared")).toEqual([
      { legalBodyId: row.legalBodyId, provider: "crossmint" },
    ]);
    expect(`${printed.join("\n")}${JSON.stringify(events)}`).not.toContain("limits.example");
  });

  test("the throttle: an empty tenant bucket is 429 rate_limited, with no read of the order or the registry and nothing stored", async () => {
    const row = linkedBody();
    const findOwned = vi.spyOn(s.repo, "findOwned");
    const app = makeApp({ orders: { tenantBucket: () => ({ take: () => false }) } });
    expect(
      await declareOver(app, row.legalBodyId, { address: WALLET, provider: "own_key" }),
    ).toMatchObject(refused(429, "rate_limited"));
    expect(findOwned).not.toHaveBeenCalled();
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("the token is taken after the real-human check and before the order is read: a probe of an unknown id spends one", async () => {
    const row = linkedBody();
    let tokens = 1;
    const take = vi.fn(() => tokens-- > 0);
    const app = makeApp({ orders: { tenantBucket: () => ({ take }) } });
    // A tenant with no verification is refused first, and spends nothing.
    expect(
      await declareOver(
        app,
        row.legalBodyId,
        { address: WALLET, provider: "own_key" },
        await sessionOf(unverified),
      ),
    ).toMatchObject({ status: 403, body: { error: { code: "guardian_not_verified" } } });
    expect(take).not.toHaveBeenCalled();
    // The probe: the one token, then the uniform 404.
    expect(
      await declareOver(app, `lb_${"0".repeat(36)}`, { address: WALLET, provider: "own_key" }),
    ).toMatchObject(refused(404, "not_found"));
    // The real order now finds the bucket empty.
    expect(
      await declareOver(app, row.legalBodyId, { address: WALLET, provider: "own_key" }),
    ).toMatchObject(refused(429, "rate_limited"));
    expect(take).toHaveBeenCalledTimes(2);
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("a body that is not linked: 409 order_closed, with no registry read", async () => {
    const companyId = readyCompany(s);
    s.checks.append(passedCheck(companyId));
    const row = bodyIn("deployed", s, companyId);
    expect(
      await declareOver(makeApp(), row.legalBodyId, { address: WALLET, provider: "own_key" }),
    ).toMatchObject(refused(409, "order_closed"));
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("a registryTxHash that is not 32 bytes of hex: 400 treasury_invalid", async () => {
    const row = linkedBody();
    const app = makeApp();
    for (const registryTxHash of [
      "0x1234",
      `0x${"ab".repeat(31)}`,
      `0x${"zz".repeat(32)}`,
      "ab".repeat(32),
    ])
      expect(
        await declareOver(app, row.legalBodyId, {
          address: WALLET,
          provider: "crossmint",
          registryTxHash,
        }),
        registryTxHash,
      ).toMatchObject(refused(400, "treasury_invalid"));
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("an http: link and another provider with no name: 400 treasury_invalid", async () => {
    const row = linkedBody();
    const app = makeApp();
    for (const body of [
      { address: WALLET, provider: "crossmint", limitsReadableAt: "http://limits.example.test/" },
      { address: WALLET, provider: "other" },
    ])
      expect(await declareOver(app, row.legalBodyId, body)).toMatchObject(
        refused(400, "treasury_invalid"),
      );
    expect(rows()).toEqual([]);
  });

  test("a link whose written authority is not the host it leads to: 400 treasury_invalid; a plain link is stored as written", async () => {
    const row = linkedBody();
    const app = makeApp();
    for (const limitsReadableAt of ["https:///path", "https://:@limits.example.test/x"])
      expect(
        await declareOver(app, row.legalBodyId, {
          address: WALLET,
          provider: "crossmint",
          limitsReadableAt,
        }),
        limitsReadableAt,
      ).toMatchObject(refused(400, "treasury_invalid"));
    expect(rows()).toEqual([]);
    const accepted = await declareOver(app, row.legalBodyId, {
      address: WALLET,
      provider: "crossmint",
      limitsReadableAt: LIMITS,
    });
    expect(accepted).toMatchObject({ status: 200, body: { limitsReadableAt: LIMITS } });
    expect(rows()).toHaveLength(1);
  });

  test("an address the registry does not show: 409 treasury_wallet_mismatch", async () => {
    const row = linkedBody();
    expect(
      await declareOver(makeApp(), row.legalBodyId, { address: ELSEWHERE, provider: "circle" }),
    ).toMatchObject(refused(409, "treasury_wallet_mismatch"));
    expect(rows()).toEqual([]);
  });

  test("a row of another factory is read-only here: 409 other_deployment, with no registry read", async () => {
    const companyId = readyCompany(s);
    s.checks.append(passedCheck(companyId));
    const row = bodyIn("linked", s, companyId, { factory: OTHER_FACTORY });
    expect(
      await declareOver(makeApp(), row.legalBodyId, { address: WALLET, provider: "own_key" }),
    ).toMatchObject(refused(409, "other_deployment"));
    expect(getAgentWallet).not.toHaveBeenCalled();
  });

  test("no session: 401; a body that is not JSON: 400; one over 8 KiB: 413", async () => {
    const row = linkedBody();
    const app = makeApp();
    expect((await call(app, "POST", treasuryPath(row.legalBodyId), undefined, {})).status).toBe(
      401,
    );
    const token = await sessionOf(guardian);
    expect(
      await answerOf(await call(app, "POST", treasuryPath(row.legalBodyId), token, "{not json")),
    ).toMatchObject({ status: 400, body: { error: { code: "validation_error" } } });
    expect(
      await answerOf(
        await call(app, "POST", treasuryPath(row.legalBodyId), token, {
          address: WALLET,
          provider: "other",
          providerName: "x".repeat(9_000),
        }),
      ),
    ).toMatchObject(refused(413, "payload_too_large"));
    expect(rows()).toEqual([]);
  });

  test("without the treasury's deps the door is not mounted, and the lookups serve treasury null", async () => {
    const row = linkedBody();
    const app = makeApp({ treasury: false });
    const token = await sessionOf(guardian);
    const res = await call(app, "POST", treasuryPath(row.legalBodyId), token, {
      address: WALLET,
      provider: "own_key",
    });
    expect(res.status).toBe(404);
    const body = await lookup(app, byAgent);
    expect(body.statement).not.toBeNull();
    expect(body.treasury).toBeNull();
  });
});

describe("a body Novi no longer states as in force", () => {
  test("a linked body the operator revoked: 409 legal_body_revoked, no row and no event, and both lookups serve no block", async () => {
    const row = linkedBody();
    revoke(row);
    const app = makeApp();
    expect(
      await declareOver(app, row.legalBodyId, { address: WALLET, provider: "crossmint" }),
    ).toMatchObject(refused(409, "legal_body_revoked"));
    expect(getAgentWallet).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(s.repo.listEvents(row.legalBodyId).filter((e) => e.kind === "note")).toEqual([]);
    // By agent first: its statement logs the wallet the lookup by address finds the body by.
    for (const path of [byAgent, byAddress(WALLET)]) {
      const body = await lookup(app, path);
      expect(body.standing, path).toBe("inactive");
      expect(body.treasury, path).toBeNull();
    }
  });

  test("a declaration made while active is served beside an active statement, and null once the standing reads inactive, the wallet still matching", async () => {
    const row = linkedBody();
    const app = makeApp();
    const declared = await declareOver(app, row.legalBodyId, {
      address: WALLET,
      provider: "own_key",
    });
    expect(declared.status).toBe(200);
    const active = await lookup(app, byAgent);
    expect(active.standing).toBe("active");
    expect(active.treasury).toEqual(declared.body);

    revoke(row);
    clock += MEMO_WINDOW_MS;
    for (const path of [byAgent, byAddress(WALLET)]) {
      const body = await lookup(app, path);
      expect(body.standing, path).toBe("inactive");
      expect(body.statement.message.agentWallet, path).toBe(WALLET);
      expect(body.treasury, path).toBeNull();
    }
    expect(rows()).toHaveLength(1);
  });

  test("a body whose company is not paid for yet reads pending: the block is served", async () => {
    const companyId = readyCompany(s, { status: "draft" });
    s.checks.append(passedCheck(companyId));
    const row = bodyIn("linked", s, companyId);
    chain.link(row, { wallet: WALLET });
    const app = makeApp();
    const declared = await declareOver(app, row.legalBodyId, {
      address: WALLET,
      provider: "circle",
    });
    expect(declared.status).toBe(200);
    const body = await lookup(app, byAgent);
    expect(body.standing).toBe("pending");
    expect(body.treasury).toEqual(declared.body);
  });
});

describe("the lookups serve the block beside the signed statement, unsigned", () => {
  test("by agent and by address: null before a declaration, the block after; the statement is the one the service signs, with its 33 fields", async () => {
    const row = linkedBody();
    const app = makeApp();
    const before = await lookup(app, byAgent);
    expect(before.treasury).toBeNull();
    expect(Object.keys(before).slice(-2)).toEqual(["statement", "treasury"]);

    const declared = await declareOver(app, row.legalBodyId, {
      address: WALLET,
      provider: "other",
      providerName: "Example Wallets",
      limitsReadableAt: LIMITS,
    });
    expect(declared.status).toBe(200);

    clock += MEMO_WINDOW_MS;
    const after = await lookup(app, byAgent);
    expect(after.treasury).toEqual(declared.body);
    expect(after.treasury.checkedByNovi).toBe(false);
    expect(Object.keys(after).slice(-2)).toEqual(["statement", "treasury"]);
    // The signed statement: exactly what the service signs at this instant, its 33 fields, and
    // nothing of the declaration in it.
    const direct = await statementForAgent(statementDeps(s, chain, { now: () => clock }), "42");
    if (direct.kind !== "statement") throw new Error(`expected a statement, got ${direct.kind}`);
    expect(after.statement).toEqual(direct.statement);
    expect(Object.keys(after.statement.message)).toHaveLength(33);
    expect(after.statement.domain.version).toBe("2");
    expect(JSON.stringify(after.statement)).not.toContain("limits.example");
    expect(JSON.stringify(after.statement)).not.toContain("Example Wallets");

    // By address: the wallet the statements logged for the agent.
    const byWallet = await lookup(app, byAddress(WALLET));
    expect(byWallet).toMatchObject({ legalBody: true, agentId: "42", treasury: declared.body });
    expect(Object.keys(byWallet).slice(-2)).toEqual(["statement", "treasury"]);
  });

  test("Ruling 3: a wallet changed on chain after the declaration is served as null, and the block again once the wallet matches; the rows are untouched", async () => {
    const row = linkedBody();
    const app = makeApp();
    const declared = await declareOver(app, row.legalBodyId, {
      address: WALLET,
      provider: "crossmint",
    });
    expect(declared.status).toBe(200);
    expect((await lookup(app, byAgent)).treasury).toEqual(declared.body);

    // The registry's wallet moves elsewhere, by a transaction this deployment never saw.
    chain.wallets.set("42", ELSEWHERE);
    clock += MEMO_WINDOW_MS;
    const moved = await lookup(app, byAgent);
    expect(moved.statement.message.agentWallet).toBe(ELSEWHERE);
    expect(moved.treasury).toBeNull();
    const byNewWallet = await lookup(app, byAddress(ELSEWHERE));
    expect(byNewWallet).toMatchObject({ legalBody: true, agentId: "42", treasury: null });
    // The declared wallet is no longer the agent's: not a legal body's wallet at all.
    expect((await lookup(app, byAddress(WALLET))).legalBody).toBe(false);

    // Back to the declared wallet: the block is served again.
    chain.wallets.set("42", WALLET);
    clock += MEMO_WINDOW_MS;
    expect((await lookup(app, byAgent)).treasury).toEqual(declared.body);
    expect((await lookup(app, byAddress(WALLET))).treasury).toEqual(declared.body);
    expect(rows()).toHaveLength(1);
  });

  test("only the latest declaration is the record: an older one whose wallet the registry shows again is not served", async () => {
    const row = linkedBody();
    const app = makeApp();
    expect(
      (await declareOver(app, row.legalBodyId, { address: WALLET, provider: "crossmint" })).status,
    ).toBe(200);
    chain.wallets.set("42", ELSEWHERE);
    clock += 60_000;
    const second = await declareOver(app, row.legalBodyId, {
      address: ELSEWHERE,
      provider: "circle",
    });
    expect(second.status).toBe(200);
    clock += MEMO_WINDOW_MS;
    expect((await lookup(app, byAgent)).treasury).toEqual(second.body);
    chain.wallets.set("42", WALLET);
    clock += MEMO_WINDOW_MS;
    expect((await lookup(app, byAgent)).treasury).toBeNull();
  });

  test("a database read of the record that fails: the lookups' flat 503, no-store, one ops line naming the error", async () => {
    linkedBody();
    const app = makeApp();
    // A first statement logs the agent's wallet: the candidate the lookup by address finds it by.
    expect((await lookup(app, byAgent)).treasury).toBeNull();
    vi.spyOn(treasuries, "latest").mockImplementation(() => {
      throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { name: "SqliteError" });
    });
    clock += MEMO_WINDOW_MS;
    for (const path of [byAgent, byAddress(WALLET)]) {
      printed = [];
      const res = await app.request(path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      const text = await res.text();
      expect(JSON.parse(text), path).toEqual({
        error: "unavailable",
        message: "could not check right now; try again shortly",
      });
      expect(text, path).not.toContain("SQLITE");
      expect(opsLines("legal_body_statement_db_failed"), path).toEqual([
        { errorName: "SqliteError" },
      ]);
    }
  });
});

/**
 * The composition root boots against a chain and has no injectable seam, so this reads the file,
 * as the other composition guards do: the treasury's deps exist exactly where the order doors' do,
 * over the database the legal-body store writes through (a declaration and its event are one of
 * its transactions), check against the process's adapter (whose registry is `cfg.identityRegistry`,
 * the one the statements read), and are handed to the API after the statement's.
 */
test("the composition root builds the treasury's deps beside the order doors' and hands them to the API", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const at = main.indexOf("const legalBodyTreasury");
  expect(at, "the treasury's deps were not found").toBeGreaterThan(0);
  const built = main.slice(at, main.indexOf(": undefined;", at));
  expect(built).toMatch(
    /= legalBodyOrders\n\s+\? \{ repo: new SqliteLegalBodyTreasuryRepository\(db\), registry: arc \}\n/,
  );
  expect(main).toMatch(
    /^ {2}const legalBodies =\n\s+cfg\.legalBodyFactory && cfg\.controllerAddress \? new SqliteLegalBodyRepository\(db\) : undefined;$/m,
  );
  expect(main).toMatch(/^ {2}const arc = new ArcAdapter\(\{$/m);
  expect(main).toMatch(/^ {4}identityRegistry: cfg\.identityRegistry,$/m);
  expect(main).toMatch(/^ {4}legalBodyStatements,\n(?: {4}\/\/.*\n)* {4}legalBodyTreasury,$/m);
});
