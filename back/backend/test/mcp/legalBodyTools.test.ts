/**
 * The three legal-body tools of the MCP server, for an agent that holds the key of an identity's
 * owner: the message the owner signs, the signed link, and the binding. They act on an order its
 * guardian placed in the browser, as the API key's tenant, under the doors' own rules, and they
 * answer what the doors answer: a result of enums, decimals and hex, or a code and its fixed
 * sentence.
 *
 * The database is real (in memory); the chain is a fake whose answers each test steers. Every name,
 * company and filing number is an invention, and every key is one of anvil's published test
 * accounts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type Address, type Hex, getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CreateOutcome,
  LegalBodyGasTooHighError,
} from "../../src/adapters/arc/legalBodyChain";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { type LegalBodyPotDeps, potForAgent, prepareTake } from "../../src/legalBody/pot";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { REAL_HUMAN_CHECK_CODES } from "../../src/mcp/server";
import { type Capability, SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteLegalBodyPotRepository } from "../../src/persistence/legalBodyPotRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  ANVIL_ACCOUNT_4,
  CHAIN_ID,
  FACTORY,
  recordHuman,
} from "../helpers/customerCompanyFixtures";
import type { MemoryDocumentStore } from "../helpers/formationFakes";
import {
  type FakeLinkChainMembers,
  H,
  IDENTITY_OWNER,
  JWT_SECRET,
  type Json,
  LINK_HEAD,
  type LegalBodyStores,
  TransportFailure,
  adoptFor,
  answerOf,
  asChainPort,
  call,
  customerCompany,
  fakeLinkChainMembers,
  legalBodyOrderDeps,
  linkFor,
  openLegalBodyStores,
  orderViewOf,
  sessionOf,
  signedLink,
} from "../helpers/legalBodyFixtures";
import {
  A,
  G,
  HEALTHY,
  P,
  REAL_STOPPED,
  V3_ADDRESS,
  fakePotChain,
  fakeRegistry,
  notePot,
  potBody,
  potDeps,
} from "../helpers/potFixtures";
import { startMcpTestClient } from "./helpers";

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. The guardian and a
 *  stranger are verified humans; #4 holds a waiver. */
const guardian = ANVIL_ACCOUNT_2;
const stranger = ANVIL_ACCOUNT_3;
const waived = ANVIL_ACCOUNT_4;
/** A tenant that never verified: a placeholder address. */
const UNVERIFIED = getAddress("0x00000000000000000000000000000000000000a1");

/** The three tools, sorted. */
const LEGAL_BODY_TOOLS = ["get_binding", "get_link_message", "submit_link"];
const S = LEGAL_BODY_SENTENCES;
/** The host of the node URL a transport failure carries. */
const NODE_HOST = "rpc.example";

const messagePath = (id: string) => `/legal-body-orders/${id}/link-message`;
const linkPath = (id: string) => `/legal-body-orders/${id}/link`;
const bindingPath = (id: string) => `/legal-body-orders/${id}/binding`;

/** One database and what runs over it: the stores, a fake chain, the API and its MCP endpoint, and
 *  the pot's deps where the world wires the pot. */
interface World {
  db: Database.Database;
  s: LegalBodyStores;
  chain: FakeLinkChainMembers;
  app: ReturnType<typeof buildApiApp>;
  pot?: LegalBodyPotDeps;
}

/** What a world needs to wire the pot: its deps over the world's own stores. */
type PotOf = (s: LegalBodyStores) => LegalBodyPotDeps;

let opened: Database.Database[];
/** Every console line written in the test: the ops lines among them. */
let lines: string[];

beforeEach(() => {
  opened = [];
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
});

/**
 * The API over `db`, with the order doors and the tools over a sandbox deployment on a fake chain,
 * with room in every throttle; without them when `feature` is false.
 */
function worldOver(
  db: Database.Database,
  docStore: MemoryDocumentStore | undefined,
  opts: { feature?: boolean; over?: Partial<LegalBodyOrderDeps>; pot?: PotOf } = {},
): World {
  opened.push(db);
  const s = openLegalBodyStores(db, docStore);
  const chain = fakeLinkChainMembers();
  const requests = new SqliteFormationRepository(db);
  const pot = opts.pot?.(s);
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
    legalBodyOrders:
      opts.feature === false
        ? undefined
        : legalBodyOrderDeps(s, { chain: asChainPort(chain), ...opts.over }),
    legalBodyPot: pot,
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
  return { db, s, chain, app: buildApiApp(deps as ApiDeps), pot };
}

/** A fresh database where the guardian and the stranger are verified humans and #4 holds a
 *  waiver. */
function world(
  opts: { feature?: boolean; over?: Partial<LegalBodyOrderDeps>; pot?: PotOf } = {},
): World {
  const db = openDatabase(":memory:");
  migrate(db);
  const w = worldOver(db, undefined, opts);
  recordHuman(w.s.store, guardian.address, "3001", Date.now());
  recordHuman(w.s.store, stranger.address, "3002", Date.now());
  recordHuman(w.s.store, waived.address, "3003", Date.now(), "waiver");
  return w;
}

/** A second world over a copy of `w`'s database as it is now: the same orders, keys and
 *  verifications, and the same stored agreements. The door acts in one, the tool in the other. */
function twinOf(w: World): World {
  const copy = new Database(w.db.serialize());
  copy.pragma("foreign_keys = ON");
  return worldOver(copy, w.s.docStore);
}

/** An API key of `tenant`: a tenant-wide provision key unless told otherwise. */
function keyOf(
  w: World,
  tenant: Address,
  opts: { capability?: Capability; entityId?: string } = {},
): string {
  return new SqliteApiKeyStore(w.db).mint(tenant, { capability: "provision", ...opts }).key;
}

function rowIn(w: World, id: string): LegalBodyRecord {
  const row = w.s.repo.findById(id);
  if (!row) throw new Error(`order ${id} is not stored`);
  return row;
}

let filings = 0;
/** A draft of `who` for a checked company of its own, placed through the order door, as the
 *  browser places one, its agreement adopted by its guardian, as every link requires. */
async function ordered(w: World, who = guardian): Promise<LegalBodyRecord> {
  const companyId = customerCompany(w.s, who.address, {
    filingNumber: `TEST-${String(++filings).padStart(4, "0")}`,
  });
  const res = await answerOf(
    await call(w.app, "POST", "/legal-body-orders", await sessionOf(who), { companyId }),
  );
  expect(res.status).toBe(201);
  adoptFor(w.s, rowIn(w, res.body.id));
  return rowIn(w, res.body.id);
}

/** A session of a tenant that holds no key here. */
async function sessionFor(tenant: Address): Promise<string> {
  const { token } = await signSession(tenant, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  return token;
}

/** A tool's answer: whether it is an error, its one text, and that text read as JSON when it is. */
interface ToolAnswer {
  isError: boolean;
  text: string;
  body: Json;
}

function jsonOrNull(text: string): Json {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callTool(
  w: World,
  key: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  const { client, close } = await startMcpTestClient(w.app, key);
  try {
    const out = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = out.content[0]?.text ?? "";
    return { isError: out.isError === true, text, body: jsonOrNull(text) };
  } finally {
    await close();
  }
}

async function toolsOf(w: World, key: string) {
  const { client, close } = await startMcpTestClient(w.app, key);
  try {
    return (await client.listTools()).tools;
  } finally {
    await close();
  }
}

/** Each tool with arguments that name `orderId`. */
function toolCalls(
  orderId: string,
  signed: { message: unknown; signature: Hex },
): [string, Record<string, unknown>][] {
  return [
    ["get_link_message", { orderId, agentId: "42" }],
    ["submit_link", { orderId, ...signed }],
    ["get_binding", { orderId }],
  ];
}

/** Every row and every event, to show that a call wrote nothing. */
function snapshot(w: World) {
  return {
    rows: w.db.prepare("SELECT * FROM legal_bodies ORDER BY rowid").all(),
    events: w.db.prepare("SELECT * FROM legal_body_events ORDER BY id").all(),
  };
}

/** The names of the fake chain's members that were called, sorted. */
function calledMembers(w: World): string[] {
  return Object.entries(w.chain)
    .filter(([, member]) => vi.isMockFunction(member) && member.mock.calls.length > 0)
    .map(([name]) => name)
    .sort();
}

function clearChainCalls(w: World): void {
  for (const member of Object.values(w.chain)) if (vi.isMockFunction(member)) member.mockClear();
}

const opsLines = () =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return "opslog" in parsed ? [parsed] : [];
    } catch {
      return [];
    }
  });

/** The create found mined at the first read of its receipt. */
function created(txHash: Hex, bodyAddress: Address): CreateOutcome {
  return {
    status: "created",
    created: {
      legalBody: bodyAddress,
      agentId: 42n,
      identityOwner: IDENTITY_OWNER.address,
      guardian: guardian.address,
      linkDigest: H("d"),
      txHash,
      blockNumber: Number(LINK_HEAD.number) + 1,
      deployedAt: Number(LINK_HEAD.timestamp) + 2,
    },
  };
}

/**
 * One order linked twice from the same state: through the door in one world and through the tool
 * in its twin, both chains steered alike, with the same signed link.
 */
async function linkedBothWays(steer: (chain: FakeLinkChainMembers) => void = () => {}) {
  const door = world();
  const row = await ordered(door);
  const tool = twinOf(door);
  steer(door.chain);
  steer(tool.chain);
  const signed = await signedLink(linkFor(row));
  const viaDoor = await answerOf(
    await call(door.app, "POST", linkPath(row.legalBodyId), await sessionOf(guardian), signed),
  );
  const viaTool = await callTool(tool, keyOf(tool, guardian.address), "submit_link", {
    orderId: row.legalBodyId,
    ...signed,
  });
  return { id: row.legalBodyId, tool, viaDoor, viaTool };
}

// ── With the feature off ────────────────────────────────────────────────────────────────────

describe("with the feature off", () => {
  test("the three tools are not registered, and the feature on adds exactly them", async () => {
    const off = world({ feature: false });
    const on = world();
    const without = (await toolsOf(off, keyOf(off, guardian.address))).map((t) => t.name);
    const withIt = (await toolsOf(on, keyOf(on, guardian.address))).map((t) => t.name);

    for (const name of LEGAL_BODY_TOOLS) expect(without).not.toContain(name);
    expect(withIt.sort()).toEqual([...without, ...LEGAL_BODY_TOOLS].sort());
  });
});

// ── The same answers as the doors ───────────────────────────────────────────────────────────

describe("each tool answers what its door answers for the same input", () => {
  test("get_link_message answers the door's typed data, owner and deadline, with or without a lifetime, and writes nothing", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const token = await sessionOf(guardian);
    const before = snapshot(w);

    // Each input, with the lifetime its deadline is counted with: the default, then one given.
    const inputs: [Record<string, unknown>, number][] = [
      [{ agentId: "42" }, 3_600],
      [{ agentId: "42", ttlSeconds: 900 }, 900],
    ];
    for (const [input, lifetime] of inputs) {
      const viaDoor = await answerOf(
        await call(w.app, "POST", messagePath(row.legalBodyId), token, input),
      );
      const viaTool = await callTool(w, key, "get_link_message", {
        orderId: row.legalBodyId,
        ...input,
      });
      expect(viaDoor.status).toBe(200);
      expect(viaTool.isError).toBe(false);
      expect(viaTool.body).toEqual(viaDoor.body);
      expect(viaTool.body.deadline).toBe(Number(LINK_HEAD.timestamp) + lifetime);
    }
    expect(snapshot(w)).toEqual(before);
  });

  test("get_link_message passes the code agent_wallet_required and its sentence through, as the door answers them, and writes nothing", async () => {
    const w = world();
    const row = await ordered(w);
    // The registry names the guardian's own wallet as the agent's.
    w.chain.agentWallet.mockResolvedValue(guardian.address);
    const before = snapshot(w);

    const viaDoor = await answerOf(
      await call(w.app, "POST", messagePath(row.legalBodyId), await sessionOf(guardian), {
        agentId: "42",
      }),
    );
    const viaTool = await callTool(w, keyOf(w, guardian.address), "get_link_message", {
      orderId: row.legalBodyId,
      agentId: "42",
    });

    const answer = { code: "agent_wallet_required", message: S.agent_wallet_required };
    expect(viaDoor).toMatchObject({ status: 409, body: { error: answer } });
    expect(viaTool).toEqual({ isError: true, text: JSON.stringify(answer), body: answer });
    expect(snapshot(w)).toEqual(before);
  });

  test("submit_link answers the door's order for the same order from the same state: reserved, or deployed once the create's receipt is read", async () => {
    const reserved = await linkedBothWays();
    expect(reserved.viaDoor.status).toBe(202);
    expect(reserved.viaTool.isError).toBe(false);
    expect(reserved.viaTool.body).toEqual({ status: "reserved", order: reserved.viaDoor.body });
    expect(reserved.viaTool.body.order).toEqual(
      orderViewOf(
        {
          repo: reserved.tool.s.repo,
          adoptions: reserved.tool.s.adoptions,
          declarations: reserved.tool.s.declarations,
          companies: reserved.tool.s.companies,
        },
        rowIn(reserved.tool, reserved.id),
      ),
    );

    const deployed = await linkedBothWays((chain) =>
      chain.createOutcome.mockImplementation(async (txHash, expected) =>
        created(txHash, expected.bodyAddress),
      ),
    );
    expect(deployed.viaDoor.status).toBe(200);
    expect(deployed.viaTool.isError).toBe(false);
    expect(deployed.viaTool.body).toEqual({ status: "deployed", order: deployed.viaDoor.body });
    expect(deployed.viaTool.body.order.state).toBe("deployed");
  });

  test("a refused link answers the door's code, sentence, detail and order: before the reservation the draft is kept; after it the order has lapsed, and the sentence says so", async () => {
    const before = await linkedBothWays((chain) =>
      chain.estimateCreate.mockRejectedValueOnce(new LegalBodyGasTooHighError(30_000_000n)),
    );
    expect(before.viaDoor.status).toBe(422);
    expect(before.viaTool.isError).toBe(true);
    expect(before.viaTool.body).toEqual({ status: "refused", ...before.viaDoor.body });
    expect(before.viaTool.body).toMatchObject({
      code: "gas_too_high",
      message: S.gas_too_high,
      detail: { gasEstimate: "30000000" },
      order: { state: "draft" },
    });
    expect(rowIn(before.tool, before.id).bindingState).toBe("draft");

    const after = await linkedBothWays((chain) =>
      chain.submitCreate.mockRejectedValueOnce(
        new ContractRevertError("createLegalBody reverted: BadSignature", "BadSignature"),
      ),
    );
    expect(after.viaDoor.status).toBe(422);
    expect(after.viaTool.isError).toBe(true);
    expect(after.viaTool.body).toEqual({ status: "refused", ...after.viaDoor.body });
    expect(after.viaTool.body).toMatchObject({
      code: "bad_signature",
      message: `${S.bad_signature} ${S.order_lapsed}`,
      order: { state: "lapsed" },
    });
  });

  test("get_binding answers the door's binding as stored, a draft's with no intent and a deployed body's with its pointer intent, and reads no chain", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const token = await sessionOf(guardian);
    w.chain.createOutcome.mockImplementation(async (txHash, expected) =>
      created(txHash, expected.bodyAddress),
    );

    const readBoth = async (): Promise<Json> => {
      clearChainCalls(w);
      const viaDoor = await answerOf(await call(w.app, "GET", bindingPath(row.legalBodyId), token));
      const viaTool = await callTool(w, key, "get_binding", { orderId: row.legalBodyId });
      expect(viaDoor.status).toBe(200);
      expect(viaTool.isError).toBe(false);
      expect(viaTool.body).toEqual(viaDoor.body);
      expect(calledMembers(w)).toEqual([]);
      return viaTool.body;
    };

    expect(await readBoth()).toMatchObject({ state: "draft", agentId: null, intent: null });

    const linked = await callTool(w, key, "submit_link", {
      orderId: row.legalBodyId,
      ...(await signedLink(linkFor(row))),
    });
    expect(linked.body.status).toBe("deployed");
    const deployed = rowIn(w, row.legalBodyId);
    expect(await readBoth()).toEqual({
      state: "deployed",
      agentId: "42",
      bodyAddress: deployed.bodyAddress,
      intent: {
        action: "setLegalBodyPointer",
        agentId: "42",
        body: deployed.bodyAddress,
        chainId: CHAIN_ID,
      },
      pointerSeenAt: null,
      nextCheckAt: deployed.nextBindingCheckAt,
      brokenReason: null,
      revoked: false,
      supersededBy: null,
      replacedBy: null,
    });
  });
});

// ── Who may use the tools ───────────────────────────────────────────────────────────────────

describe("who may use the tools", () => {
  test("submit_link needs the provision capability: a spend key is refused before anything is read; the two reads answer a read key", async () => {
    const w = world();
    const row = await ordered(w);
    const signed = await signedLink(linkFor(row));
    const before = snapshot(w);

    const spend = keyOf(w, guardian.address, { capability: "spend" });
    expect(
      await callTool(w, spend, "submit_link", { orderId: row.legalBodyId, ...signed }),
    ).toEqual({ isError: true, text: "not authorized", body: null });
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);

    const read = keyOf(w, guardian.address, { capability: "read" });
    expect(
      await callTool(w, read, "get_link_message", { orderId: row.legalBodyId, agentId: "42" }),
    ).toMatchObject({ isError: false, body: { identityOwner: IDENTITY_OWNER.address } });
    expect(await callTool(w, read, "get_binding", { orderId: row.legalBodyId })).toMatchObject({
      isError: false,
      body: { state: "draft" },
    });
  });

  test("an entity-scoped key is refused by all three, a provision key included, before anything is read", async () => {
    const w = world();
    const row = await ordered(w);
    const signed = await signedLink(linkFor(row));
    const scoped = keyOf(w, guardian.address, { entityId: "agent-0001" });
    const before = snapshot(w);

    for (const [name, args] of toolCalls(row.legalBodyId, signed))
      expect(await callTool(w, scoped, name, args), name).toEqual({
        isError: true,
        text: "not authorized",
        body: null,
      });
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);
  });

  test("a waiver tenant is refused by all three, its own order included, with the door's code and message", async () => {
    const w = world();
    const companyId = customerCompany(w.s, waived.address, { filingNumber: "TEST-0900" });
    const own = w.s.repo.create({
      tenantId: waived.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: 172_800,
    });
    const viaDoor = await answerOf(
      await call(w.app, "GET", bindingPath(own.legalBodyId), await sessionOf(waived)),
    );
    expect(viaDoor).toMatchObject({
      status: 403,
      body: { error: { code: "waiver_not_accepted" } },
    });
    const key = keyOf(w, waived.address);
    const before = snapshot(w);

    for (const [name, args] of toolCalls(own.legalBodyId, { message: {}, signature: "0x" }))
      expect(await callTool(w, key, name, args), name).toMatchObject({
        isError: true,
        body: { code: "waiver_not_accepted", message: viaDoor.body.error.message },
      });
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);
  });

  test("the real-human and identity checks' codes are a closed list, the very codes those checks throw, each with its message written as one string literal and answered with the message the door answers", async () => {
    expect([...REAL_HUMAN_CHECK_CODES].sort()).toEqual([
      "guardian_identity_not_verified",
      "guardian_not_verified",
      "identity_unavailable",
      "unavailable",
      "waiver_not_accepted",
    ]);
    // The checks whose refusals the tools pass on: the World check and the identity gate.
    const src = join(import.meta.dirname, "..", "..", "src");
    const check = (
      [
        [["api", "routes", "worldId.ts"], "export function assertRealHuman("],
        [["identity", "state.ts"], "export function assertIdentityVerified("],
      ] as const
    )
      .map(([path, head]) => {
        const source = readFileSync(join(src, ...path), "utf8");
        const start = source.indexOf(head);
        expect(start, head).toBeGreaterThan(-1);
        return source.slice(start, source.indexOf("\n}\n", start));
      })
      .join("\n");
    const thrown = new Set(
      [...check.matchAll(/new ApiError\(\s*"([a-z_]+)"/g)].map((m) => m[1] as string),
    );
    expect([...thrown].sort()).toEqual([...REAL_HUMAN_CHECK_CODES].sort());
    // Each of those refusals carries its message as one string literal, written in the check: no
    // variable, no template and no concatenation. That is what makes it safe for a tool to pass
    // the message on as it is.
    const refusals = check.match(/new ApiError\(/g) ?? [];
    const literal = [
      ...check.matchAll(/new ApiError\(\s*"([a-z_]+)",\s*\d{3},\s*"[^"\\\n]*",?\s*\)/g),
    ];
    expect(refusals.length).toBeGreaterThanOrEqual(REAL_HUMAN_CHECK_CODES.size);
    expect(literal, "a refusal whose message is not one string literal").toHaveLength(
      refusals.length,
    );
    expect(new Set(literal.map((m) => m[1]))).toEqual(thrown);

    const cases: [string, World, Address][] = [
      ["unavailable", world({ over: { world: undefined } }), guardian.address],
      ["guardian_not_verified", world(), UNVERIFIED],
      ["waiver_not_accepted", world(), waived.address],
    ];
    for (const [code, w, tenant] of cases) {
      const viaDoor = await answerOf(
        await call(w.app, "GET", bindingPath("lb_any"), await sessionFor(tenant)),
      );
      const viaTool = await callTool(w, keyOf(w, tenant), "get_binding", { orderId: "lb_any" });
      expect(viaDoor.body.error.code, code).toBe(code);
      expect(viaTool, code).toEqual({
        isError: true,
        text: JSON.stringify({ code, message: viaDoor.body.error.message }),
        body: { code, message: viaDoor.body.error.message },
      });
    }
  });

  test("the tenant is the key's: another tenant gets the uniform not_found on every tool, whatever tenant its arguments name", async () => {
    const w = world();
    const row = await ordered(w);
    const signed = await signedLink(linkFor(row));
    const theirs = keyOf(w, stranger.address);
    const before = snapshot(w);

    for (const id of [row.legalBodyId, "lb_unknown"])
      for (const [name, args] of toolCalls(id, signed)) {
        const res = await callTool(w, theirs, name, { ...args, tenantId: guardian.address });
        expect(res, name).toEqual({
          isError: true,
          text: JSON.stringify({ code: "not_found", message: S.not_found }),
          body: { code: "not_found", message: S.not_found },
        });
        expect(res.text, name).not.toContain(row.publicId);
      }
    expect(calledMembers(w)).toEqual([]);
    expect(snapshot(w)).toEqual(before);
  });
});

// ── What an answer may carry ────────────────────────────────────────────────────────────────

describe("what an answer may carry", () => {
  test("a chain failure answers chain_unavailable and its sentence, with no upstream text in the answer or the log, and nothing changes", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const signed = await signedLink(linkFor(row));
    const failures: [string, Record<string, unknown>, () => void][] = [
      [
        "get_link_message",
        { orderId: row.legalBodyId, agentId: "42" },
        () => w.chain.head.mockRejectedValueOnce(new TransportFailure()),
      ],
      [
        "submit_link",
        { orderId: row.legalBodyId, ...signed },
        () => w.chain.estimateCreate.mockRejectedValueOnce(new TransportFailure()),
      ],
    ];
    for (const [name, args, fail] of failures) {
      fail();
      lines.length = 0;
      const before = snapshot(w);
      const res = await callTool(w, key, name, args);
      expect(res, name).toEqual({
        isError: true,
        text: JSON.stringify({ code: "chain_unavailable", message: S.chain_unavailable }),
        body: { code: "chain_unavailable", message: S.chain_unavailable },
      });
      expect(lines.join("\n"), name).not.toContain(NODE_HOST);
      expect(opsLines(), name).toEqual([
        expect.objectContaining({
          opslog: "legal_body_chain_unavailable",
          orderId: row.legalBodyId,
          errorName: "HttpRequestError",
        }),
      ]);
      expect(snapshot(w), name).toEqual(before);
    }
    expect(rowIn(w, row.legalBodyId).bindingState).toBe("draft");
  });

  test("an error a tool did not choose answers internal_error and its sentence, after one line naming the tool and the error's name, never its message", async () => {
    const w = world();
    const row = await ordered(w);
    const key = keyOf(w, guardian.address);
    const signed = await signedLink(linkFor(row));
    // The real-human check, the first step of every tool after the key's own, reads this store.
    vi.spyOn(w.s.store, "findByTenant").mockImplementation(() => {
      throw new TransportFailure();
    });

    for (const [name, args] of toolCalls(row.legalBodyId, signed)) {
      lines.length = 0;
      const res = await callTool(w, key, name, args);
      expect(res, name).toEqual({
        isError: true,
        text: JSON.stringify({ code: "internal_error", message: S.internal_error }),
        body: { code: "internal_error", message: S.internal_error },
      });
      expect(lines.join("\n"), name).not.toContain(NODE_HOST);
      expect(opsLines(), name).toEqual([
        expect.objectContaining({
          opslog: "legal_body_tool_failed",
          tool: name,
          errorName: "HttpRequestError",
        }),
      ]);
    }
  });

  test("get_link_message tells a signer built on ethers to drop types.EIP712Domain before signing, and no tool takes a tenant: each takes exactly its inputs", async () => {
    const w = world();
    const tools = await toolsOf(w, keyOf(w, guardian.address));
    const byName = new Map(tools.map((t) => [t.name, t]));

    const description = byName.get("get_link_message")?.description ?? "";
    expect(description).toMatch(/ethers/);
    expect(description).toContain("types.EIP712Domain");
    expect(description).toContain(
      "answers link_outlasts_grant: ask again with a smaller ttlSeconds, or, when the shortest lifetime is still too long, have the guardian place a new order in the web app.",
    );
    expect(description).toContain(
      "the identity's owner sets it in the registry with setAgentWallet and the new wallet's signature, and until then this answers agent_wallet_required.",
    );
    // The same rule on the submit, which the door checks again there.
    expect(byName.get("submit_link")?.description ?? "").toContain(
      "The identity must name a wallet of the agent's own, not the guardian's wallet: the identity's owner sets it in the registry with setAgentWallet and the new wallet's signature, and until then this answers status refused with the code agent_wallet_required.",
    );
    const inputs = (name: string) =>
      Object.keys(byName.get(name)?.inputSchema.properties ?? {}).sort();
    expect(inputs("get_link_message")).toEqual(["agentId", "orderId", "ttlSeconds"]);
    expect(inputs("submit_link")).toEqual(["message", "orderId", "signature"]);
    expect(inputs("get_binding")).toEqual(["orderId"]);
  });
});

// ── The pot's two tools ─────────────────────────────────────────────────────────────────────

describe("the pot's two tools: get_pot and prepare_pot_take", () => {
  const POT_TOOLS = ["get_pot", "prepare_pot_take"];
  const MODULE: Address = "0xAA46724893dedD72658219405185Fb0Fc91e091C";
  let registry: ReturnType<typeof fakeRegistry>;
  let potChain: ReturnType<typeof fakePotChain>;
  let offered: boolean;
  beforeEach(() => {
    registry = fakeRegistry();
    potChain = fakePotChain();
    offered = true;
  });

  const potOf: PotOf = (s) =>
    potDeps(s, {
      registry: { getAgentWallet: registry.getAgentWallet },
      chain: potChain.port,
      now: () => Date.now(),
      offered: () => offered,
    });
  const potWorld = (over: Partial<LegalBodyOrderDeps> = {}) => world({ over, pot: potOf });
  const potIn = (w: World): LegalBodyPotDeps => {
    if (w.pot === undefined) throw new Error("this world does not wire the pot");
    return w.pot;
  };

  /** A linked body of G (the real run's guardian) whose registry names A, with V3 noted for it an
   *  hour ago, reading the proof's HEALTHY: a ceiling of 50 USDC, 10 taken. */
  function withPot(w: World): LegalBodyRecord {
    const row = potBody(w.s);
    registry.wallets.set(row.agentId as string, A);
    notePot(new SqliteLegalBodyPotRepository(w.db), row, {
      at: Math.floor(Date.now() / 1000) - 3_600,
    });
    potChain.port.readPot.mockResolvedValue(HEALTHY);
    return row;
  }
  /** A refusal as a tool answers it: the code and its fixed sentence. */
  const answerFor = (code: string) => {
    const body = { code, message: S[code] };
    return { isError: true, text: JSON.stringify(body), body };
  };
  /** Each pot tool with arguments that name `orderId`. */
  const potCalls = (orderId: string): [string, Record<string, unknown>][] => [
    ["get_pot", { orderId }],
    ["prepare_pot_take", { orderId, to: P, amountUnits: "1000000" }],
  ];
  function expectNoPotRead(): void {
    expect(registry.getAgentWallet).not.toHaveBeenCalled();
    expect(potChain.port.readPot).not.toHaveBeenCalled();
    expect(potChain.port.codeHash).not.toHaveBeenCalled();
  }
  /** Everything a pot tool could write: the rows, the events and the pot's notes. */
  const potSnapshot = (w: World) => ({
    ...snapshot(w),
    notes: w.db.prepare("SELECT * FROM pot_declarations ORDER BY legal_body_id, declared_at").all(),
  });

  test("the two tools are listed only where the pot is wired, beside the order tools", async () => {
    const names = async (w: World) =>
      (await toolsOf(w, keyOf(w, guardian.address))).map((t) => t.name);
    const without = await names(world());
    for (const name of POT_TOOLS) expect(without).not.toContain(name);
    expect((await names(potWorld())).sort()).toEqual([...without, ...POT_TOOLS].sort());
    // Without the order flow, neither: the pot's tools act on an order.
    const noOrders = await names(world({ feature: false, pot: potOf }));
    for (const name of [...POT_TOOLS, ...LEGAL_BODY_TOOLS]) expect(noOrders).not.toContain(name);
  });

  test("get_pot answers what potForAgent reads and prepare_pot_take the take prepareTake prepares, for the key's tenant, and neither writes anything", async () => {
    const w = potWorld();
    const row = withPot(w);
    const key = keyOf(w, G, { capability: "read" });
    const before = potSnapshot(w);

    const got = await callTool(w, key, "get_pot", { orderId: row.legalBodyId });
    expect(got.isError).toBe(false);
    expect(got.body).toEqual(await potForAgent(potIn(w), G, row.legalBodyId));
    expect(got.body).toMatchObject({
      pot: V3_ADDRESS,
      onRecord: true,
      agentWallet: A,
      module: MODULE,
      state: "ceiling_read",
      ceilingUnits: "50000000",
      spentUnits: "10000000",
      leftUnits: "40000000",
      balanceUnits: "190000000",
      agentKeyBalanceWei: "100000000000000000",
    });

    const input = { to: P, amountUnits: "1000000" };
    const prepared = await callTool(w, key, "prepare_pot_take", {
      orderId: row.legalBodyId,
      ...input,
    });
    expect(prepared.isError).toBe(false);
    expect(prepared.body).toEqual(await prepareTake(potIn(w), G, row.legalBodyId, input));
    expect(prepared.body).toMatchObject({
      from: A,
      to: MODULE,
      value: "0",
      gas: "200000",
      leftAfterUnits: "39000000",
      how: S.pot_take_how,
      warning: null,
    });
    expect(potSnapshot(w)).toEqual(before);

    // A stopped pot reads stopped, with its balance and no amount of the ceiling.
    potChain.port.readPot.mockResolvedValue(REAL_STOPPED);
    const stopped = await callTool(w, key, "get_pot", { orderId: row.legalBodyId });
    expect(stopped.body).toMatchObject({ state: "stopped", balanceUnits: "0" });
    expect(stopped.body).not.toHaveProperty("leftUnits");
  });

  test("a refusal carries its code and its fixed sentence: pot_not_declared, pot_take_invalid, pot_take_over_ceiling, pot_take_over_balance, pot_not_readable", async () => {
    const w = potWorld();
    const key = keyOf(w, G);
    const bare = potBody(w.s);
    registry.wallets.set(bare.agentId as string, A);
    for (const [name, args] of potCalls(bare.legalBodyId))
      expect(await callTool(w, key, name, args), name).toEqual(answerFor("pot_not_declared"));

    const row = withPot(w);
    const take = (args: Record<string, unknown>) =>
      callTool(w, key, "prepare_pot_take", { orderId: row.legalBodyId, ...args });
    for (const args of [
      { to: P, amountUnits: "1.5" },
      { to: P, amountUnits: 1_000_000 },
      { to: P },
      { to: zeroAddress, amountUnits: "1" },
    ])
      expect(await take(args), JSON.stringify(args)).toEqual(answerFor("pot_take_invalid"));
    expect(await take({ to: P, amountUnits: "40000001" })).toEqual(
      answerFor("pot_take_over_ceiling"),
    );
    potChain.port.readPot.mockResolvedValue({ ...HEALTHY, balanceUnits: 1n });
    expect(await take({ to: P, amountUnits: "2" })).toEqual(answerFor("pot_take_over_balance"));
    potChain.port.readPot.mockResolvedValue(REAL_STOPPED);
    expect(await take({ to: P, amountUnits: "1" })).toEqual(answerFor("pot_not_readable"));
  });

  test("while the pot is not offered, both answer pot_not_offered before the real-human check, the token and any read", async () => {
    const bucket = vi.fn(() => ({ take: () => true }));
    const w = potWorld({ tenantBucket: bucket });
    const row = withPot(w);
    const key = keyOf(w, G);
    offered = false;
    const human = vi.spyOn(w.s.store, "findByTenant");
    for (const [name, args] of potCalls(row.legalBodyId))
      expect(await callTool(w, key, name, args), name).toEqual(answerFor("pot_not_offered"));
    expect(human).not.toHaveBeenCalled();
    expect(bucket).not.toHaveBeenCalled();
    expectNoPotRead();

    offered = true;
    expect((await callTool(w, key, "get_pot", { orderId: row.legalBodyId })).isError).toBe(false);
    expect(human).toHaveBeenCalled();
    expect(bucket).toHaveBeenCalledTimes(1);
  });

  test("a key that is not tenant-wide is denied as get_binding denies it, before anything is read; a read key may use both", async () => {
    const w = potWorld();
    const row = withPot(w);
    const scoped = keyOf(w, G, { entityId: "agent-0001" });
    const before = potSnapshot(w);
    const calls: [string, Record<string, unknown>][] = [
      ...potCalls(row.legalBodyId),
      ["get_binding", { orderId: row.legalBodyId }],
    ];
    for (const [name, args] of calls)
      expect(await callTool(w, scoped, name, args), name).toEqual({
        isError: true,
        text: "not authorized",
        body: null,
      });
    expectNoPotRead();
    expect(potSnapshot(w)).toEqual(before);

    const read = keyOf(w, G, { capability: "read" });
    for (const [name, args] of potCalls(row.legalBodyId))
      expect((await callTool(w, read, name, args)).isError, name).toBe(false);
  });

  test("the doors' rules hold: a waiver tenant is refused as the pot's read door refuses it, another tenant gets not_found, and an empty bucket rate_limited, each before any read", async () => {
    const bucket = { take: vi.fn(() => true) };
    const w = potWorld({ tenantBucket: () => bucket });
    const row = withPot(w);

    const viaDoor = await answerOf(
      await call(
        w.app,
        "GET",
        `/legal-body-orders/${row.legalBodyId}/pot`,
        await sessionOf(waived),
      ),
    );
    expect(viaDoor).toMatchObject({
      status: 403,
      body: { error: { code: "waiver_not_accepted" } },
    });
    const waiver = { code: "waiver_not_accepted", message: viaDoor.body.error.message };
    for (const [name, args] of potCalls(row.legalBodyId))
      expect(await callTool(w, keyOf(w, waived.address), name, args), name).toEqual({
        isError: true,
        text: JSON.stringify(waiver),
        body: waiver,
      });

    for (const [name, args] of potCalls(row.legalBodyId))
      expect(
        await callTool(w, keyOf(w, stranger.address), name, { ...args, tenantId: G }),
        name,
      ).toEqual(answerFor("not_found"));
    expectNoPotRead();

    bucket.take.mockReturnValue(false);
    for (const [name, args] of potCalls(row.legalBodyId))
      expect(await callTool(w, keyOf(w, G), name, args), name).toEqual(answerFor("rate_limited"));
    expectNoPotRead();
  });

  test("a chain failure answers chain_unavailable and its sentence, with no upstream text in the answer or the log", async () => {
    const w = potWorld();
    const row = withPot(w);
    const key = keyOf(w, G);
    for (const [name, args] of potCalls(row.legalBodyId)) {
      registry.getAgentWallet.mockRejectedValueOnce(new TransportFailure());
      lines.length = 0;
      expect(await callTool(w, key, name, args), name).toEqual(answerFor("chain_unavailable"));
      expect(lines.join("\n"), name).not.toContain(NODE_HOST);
      expect(opsLines(), name).toEqual([
        expect.objectContaining({
          opslog: "legal_body_chain_unavailable",
          orderId: row.legalBodyId,
          stage: "pot_agent_wallet",
          errorName: "HttpRequestError",
        }),
      ]);
    }
  });

  test("the descriptions say the agent's own key sends the take itself, with no signature added, and pays a small fee in USDC; they count fixed thirty-day periods and claim nothing more; each tool takes exactly its inputs", async () => {
    const w = potWorld();
    const tools = await toolsOf(w, keyOf(w, G));
    const byName = new Map(tools.map((t) => [t.name, t]));
    const getPot = byName.get("get_pot")?.description ?? "";
    const prepare = byName.get("prepare_pot_take")?.description ?? "";

    for (const sentence of [
      "Read the company's pot of an order's legal body: the Safe its guardian created in the web app, whether it is on the public record, the ceiling the agent's own key may take in each thirty-day period, what was taken in the current period, what is left, when the period ends, what the pot holds, and what the agent's key holds for fees.",
      "The periods are fixed, one after the other.",
      "Amounts are in millionths of a USDC, as decimal strings: 1 USDC is 1000000.",
      "It reads the chain and writes nothing.",
      "No tool creates a pot.",
    ])
      expect(getPot).toContain(sentence);
    // The stopped state in the record's own words.
    expect(getPot.toLowerCase()).toContain(
      "the agent's key cannot take from it: its allowance is switched off.",
    );
    for (const sentence of [
      "Prepare a take from the company's pot, for the agent's own key to send.",
      "to is who is paid: the agent's own address or a payee.",
      "amountUnits is the amount in millionths of a USDC, as a decimal string.",
      "The answer is one transaction: send it from the agent's wallet exactly as given (from, to, value 0, data, gas), and add no signature: the feature takes the sender as the signer.",
      "The agent's key pays a small fee in USDC.",
      "A take above what is left in the current period, or above what the pot holds, is refused here before anything is sent.",
      "This server holds no key and no money, and sends nothing.",
    ])
      expect(prepare).toContain(sentence);
    for (const [name, description] of [
      ["get_pot", getPot],
      ["prepare_pot_take", prepare],
    ] as const) {
      expect(description, name).not.toMatch(
        /enforced|guarantee|per thirty days|no key may take|free\b|our agents|—/i,
      );
      expect(description, name).not.toMatch(/0x/);
    }

    const inputs = (name: string) =>
      Object.keys(byName.get(name)?.inputSchema.properties ?? {}).sort();
    expect(inputs("get_pot")).toEqual(["orderId"]);
    expect(inputs("prepare_pot_take")).toEqual(["amountUnits", "orderId", "to"]);
  });
});
