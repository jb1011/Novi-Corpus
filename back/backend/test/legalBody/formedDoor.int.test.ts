/**
 * THE FORMED DOOR END TO END, ON A LOCAL CHAIN AND THE FAKE DOOLA: a guardian signs in, is a
 * verified human, creates a company for a legal body, and the sweeper files it with doola's
 * sandbox, completes the filing and then the EIN through the playground; the guardian orders a
 * legal body for it, an identity's owner links it, the owner's pointer binds it, and the public
 * statement says the company is Novi's, filed, with its EIN. A second guardian's company is filed
 * by hand instead: the operator records the filing and the EIN with `formation:record-filed` and
 * `formation:record-ein`, the saga never touches it afterwards, and its legal body is stated the
 * same way. No ops line of the case names a company, a person or an EIN.
 *
 * The real API app with its auth, company, party, order, link, binding and statement doors; the
 * real repositories over a database file and a file document store; the real formation sweeper
 * over `fakeSandboxDoola` (the in-code doola of Task 13: no key, no network, no doola); the real
 * legal-body sweeper; the real operator commands over the same database file; and the real chain
 * adapter over anvil, where the real NoviController relays each create to the real
 * LegalBodyFactory. The identity registry is the mock registry the factory reads. The deployment
 * is a sandbox that does not charge, with doola pinned to its sandbox and synthetic parties.
 *
 * One chain for the file. One database, document store, app and two sweepers per case, on one
 * clock: the wall clock, moved forward only together with the chain's, since the chain adapter
 * does not believe a head more than 120 seconds old. SQLite stamps the formation rows from the
 * wall clock, so a move of the shared clock by five minutes is five minutes past every row.
 *
 * WHAT IT DOES NOT PROVE: doola's real sandbox (the request bodies it accepts, its playground, its
 * webhooks, the second-option name it reports); the payment path (a sandbox never charges); the
 * production gates (the formed door's unit tests under production deps); the adoption of the
 * agreement (PR #206 adds it to `order` below); the browser; the filing email.
 *
 * Every key is derived from anvil's published test mnemonic, never a real wallet, and every name,
 * company, filing number and EIN is an invention.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  http,
  type Address,
  type Hex,
  type Log,
  type PrivateKeyAccount,
  type PublicClient,
  type TestClient,
  createPublicClient,
  createTestClient,
  isAddressEqual,
  parseEventLogs,
} from "viem";
import { createSiweMessage } from "viem/siwe";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { iIdentityRegistryAbi, mockIdentityRegistryAbi } from "../../src/abis/generated";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { LegalBodyChain } from "../../src/adapters/arc/legalBodyChain";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { anvilChain } from "../../src/chains";
import { buildCli } from "../../src/cli/index";
import {
  DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
  LEGAL_BODY_FLOW_DEFAULTS,
} from "../../src/config/env";
import { DEFAULT_INDUSTRY } from "../../src/formation/intake";
import { redactPii } from "../../src/formation/pii";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { expireStaleCustomerCompanies } from "../../src/legalBody/customerCompany";
import { expireEvidenceBytes } from "../../src/legalBody/evidence";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { verifyPublicStatement } from "../../src/legalBody/publicStatement";
import type { LegalBodyStatementDeps } from "../../src/legalBody/statements";
import {
  HOUSEKEEPING_BATCH,
  LEGAL_BODY_SWEEP_MAX_PER_TICK,
  LegalBodySweeper,
} from "../../src/legalBody/sweeper";
import { createLegalBodyResolver } from "../../src/payments/legalBody";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteDoolaEventRepository } from "../../src/persistence/doolaEventRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { SqliteLegalBodyStatementRepository } from "../../src/persistence/legalBodyStatementRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { filingDateToUnix } from "../../src/workflow/formationProcessor";
import { FormationSweeper } from "../../src/workflow/formationSweeper";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { recordHuman, worldFor } from "../helpers/customerCompanyFixtures";
import { type FakeDoola, fakeSandboxDoola } from "../helpers/formationFakes";
import { paymentCfg } from "../helpers/formationPayment";
import { type Json, answerOf, call } from "../helpers/legalBodyFixtures";
import { JWT_SECRET, keyAt, mined, pointerFrom, walletOf } from "../helpers/legalBodyLinkedHarness";
import { type LegalBodyStack, deployLegalBodyStack } from "../helpers/legalBodyStack";

/** This file's own port: 8545 to 8555 belong to the other anvil-based files. */
const PORT = 8556;

/** Signs and pays for every create: the backend's platform key. */
const executor = keyAt(0);
/** The controller's role administrator. */
const admin = keyAt(1);
/** The identities' owner. The test registry binds it as each identity's wallet. */
const owner = keyAt(2);
/** Deploys the contracts. */
const deployer = keyAt(4);
/** Signs every statement: an anvil test key, and no other role here. */
const attestor = keyAt(6);
/** The two guardians: keys anvil does not fund, which sign their sessions and nothing else. */
const firstGuardian = keyAt(10);
const secondGuardian = keyAt(11);

/** The SIWE domain the app accepts sessions for: a placeholder. */
const SIWE_DOMAIN = "app.example.test";
/** The links the deployment serves: placeholders. */
const TRANSPARENCY = "https://www.example.test/transparency";
const METADATA_BASE = "https://api.example.test";
const STATEMENT_BASE = "https://api.example.test/legal-bodies/by-agent/";

/** The identity-metadata key the factory reads the pointer under. */
const POINTER_KEY = "legalBody";
const ORDERS = "/legal-body-orders";
const orderPath = (id: string) => `${ORDERS}/${id}`;
const companyPath = (id: string) => `/companies/${id}`;

/** What the sandbox leg waits after each step it completes: five minutes, in seconds. */
const FIVE_MINUTES = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The company's own purpose, as the guardian writes it. */
const PURPOSE = "Software services for the company's own customers.";

/** The company the saga files, and what the fake doola's playground reports for it. */
const LANTERN = ["Lantern Works", "Lantern Labs", "Lantern Foundry"] as const;
const LANTERN_FILED = "Lantern Works LLC";
const PLAYGROUND_FILING = "PLAYGROUND-FILING";
/** The EIN the fake doola's playground issues. */
const PLAYGROUND_EIN = "12-3456789";
/** The company the operator records by hand, and what the State's record says of it. */
const BEACON = ["Beacon Works", "Beacon Labs", "Beacon Foundry"] as const;
const BEACON_FILED = "Beacon Works LLC";
const BEACON_FILING = "2026-000451207";
const OPERATOR = "ops.example";

let anvil: AnvilHandle | undefined;
let rpcUrl = "";
let pub: PublicClient;
/** anvil's own controls: mine a block, move the chain's clock. */
let node: TestClient;
let stack: LegalBodyStack;
let chain: LegalBodyChain;

/**
 * The one clock of the app, both sweepers and the chain adapter: the wall clock, moved forward
 * only together with the chain's (`moveTime`).
 */
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

beforeAll(async () => {
  anvil = await startAnvil(PORT);
  rpcUrl = anvil.rpcUrl;
  pub = createPublicClient({ chain: anvilChain, transport: http(rpcUrl, { retryCount: 0 }) });
  node = createTestClient({ chain: anvilChain, mode: "anvil", transport: http(rpcUrl) });
  stack = await deployLegalBodyStack({
    deployer: walletOf(rpcUrl, deployer),
    admin: walletOf(rpcUrl, admin),
    pub,
    executor: executor.address,
  });
  const arc = new ArcAdapter({
    publicClient: pub,
    managerWallet: walletOf(rpcUrl, executor),
    sendClient: pub,
    chainId: anvilChain.id,
    // The entity factory, a placeholder: the legal-body path never calls it.
    factory: "0x00000000000000000000000000000000000000f1",
    identityRegistry: stack.registry,
    controller: stack.controller,
  });
  chain = new LegalBodyChain({
    publicClient: pub,
    arc,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
    maxHeadAgeSeconds: 120,
    now,
  });
}, 60_000);

afterAll(() => anvil?.stop());

// ── One deployment per case ───────────────────────────────────────────────────────────────────

/** What one case runs on: its stores, its app, the fake doola, and one tick of each sweeper. */
interface Deployment {
  db: Database.Database;
  companies: SqliteCompanyRepository;
  requests: SqliteFormationRepository;
  documents: SqliteDocumentIndexRepository;
  store: SqliteWorldStore;
  app: ReturnType<typeof buildApiApp>;
  doola: FakeDoola;
  formationTick: () => Promise<void>;
  legalBodyTick: () => Promise<void>;
}

let dir: string;
let d: Deployment;
/** Every console line written in the case: the ops lines and the commands' output among them. */
let printed: string[];
/** The positions in `printed` of the operator's commands' own output. */
let commandOutputAt: Set<number>;
const savedEnv = { ...process.env };

/** A throttle that always has a token: the order doors' caps are not under test here. */
const open = () => ({ take: () => true });

/**
 * The deployment as the composition root wires it on a sandbox box where the legal-body feature
 * is on, the attestation key is set, and doola is configured for its sandbox, over this case's
 * database and document store, on the shared clock: sessions, the formed door (World wired, no
 * identity record, payment off, synthetic parties, the total cap at its default), the order doors
 * and their sweeper, the statement by agent, and the formation sweeper over the fake doola, with
 * the refund delay at its default. The two public routes share one read budget, as the
 * composition root's.
 */
function deploy(): Deployment {
  const db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  const companies = new SqliteCompanyRepository(db);
  const declarations = new SqliteCompanyDeclarationRepository(db);
  const checks = new SqliteCompanyCheckRepository(db);
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new FileDocumentStore(join(dir, "documents"));
  const store = new SqliteWorldStore(db);
  const legalBodies = new SqliteLegalBodyRepository(db);
  const statementLog = new SqliteLegalBodyStatementRepository(db);
  const requests = new SqliteFormationRepository(db);
  const parties = new SqliteFormationPartyRepository(db);
  const payments = new SqliteFormationPaymentRepository(db);
  const entities = new SqliteEntityRepository(db);
  const world = worldFor(store);
  const deployment = { chainId: anvilChain.id, factory: stack.factory };

  const orderDeps: LegalBodyOrderDeps = {
    repo: legalBodies,
    companies,
    declarations,
    checks,
    formationSteps: (companyId) => requests.stepsOf(companyId),
    world,
    // A sandbox: the guardian identity record is never read, and the testnet box holds none.
    identity: undefined,
    chain,
    docStore,
    deployment,
    identityRegistry: stack.registry,
    // The agreement's wording is a draft, which only a sandbox serves.
    environment: "sandbox",
    ...LEGAL_BODY_FLOW_DEFAULTS,
    doorBudget: open(),
    tenantBucket: open,
    identityBucket: open,
    transaction: (fn) => legalBodies.transaction(fn),
    now,
    sleep: async () => {},
  };
  const legalBodySweeper = new LegalBodySweeper({
    ...orderDeps,
    intervalMs: DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
    maxPerTick: LEGAL_BODY_SWEEP_MAX_PER_TICK,
    housekeeping: {
      expireEvidence: () => expireEvidenceBytes({ documents, docStore, now }, HOUSEKEEPING_BATCH),
      expireStaleCompanies: () =>
        expireStaleCustomerCompanies(
          {
            companies,
            declarations,
            checks,
            hasOpenLegalBody: (companyId: string) =>
              legalBodies.hasOpenForCompany(companyId, now()),
            transaction: (fn) => legalBodies.transaction(fn),
            now,
          },
          HOUSEKEEPING_BATCH,
        ),
    },
  });

  const publicReadBudget = new TokenBucket(30, 1);
  const legalBodyStatements: LegalBodyStatementDeps = {
    repo: legalBodies,
    statements: statementLog,
    companies,
    checks,
    declarations,
    formationSteps: (companyId) => requests.stepsOf(companyId),
    world,
    identity: undefined,
    chain,
    deployment,
    identityRegistry: stack.registry,
    environment: "sandbox",
    signer: attestor,
    readBudget: publicReadBudget,
    network: "testnet",
    links: { transparency: TRANSPARENCY, statementBase: STATEMENT_BASE },
    now,
  };
  /** The full product's two chain reads: never made, since no entity of the full product exists. */
  const noFullProductRead = async (): Promise<never> => {
    throw new Error("the full product's chain was read");
  };

  // The formed door's block, as the composition root builds it for a sandbox doola that does not
  // charge: one dependency set for the create, the party and the config, with the World gate and
  // no identity record, the network's environment, and FORMATION_MAX_TOTAL at its default.
  const payment = paymentCfg(payments, { required: false });
  const pin = { provider: "doola", environment: "sandbox" } as const;
  const formationLimits = { sandboxSyntheticPii: true, maxPerTenant: 3, dailyCeiling: 10 };
  const doola = fakeSandboxDoola({}, { now });
  const formationSweeper = new FormationSweeper({
    repo: entities,
    companies,
    requests,
    documents,
    docStore,
    parties,
    events: new SqliteDoolaEventRepository(db),
    doola: doola.api,
    environment: "sandbox",
    fetchImpl: doola.fetchImpl,
    lookupImpl: doola.lookupImpl,
    // FORMATION_REFUND_DAYS at its default, and the payment rows its leg reads.
    refundDays: 14,
    payments,
    intervalMs: 60_000,
    now,
  });

  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: SIWE_DOMAIN,
    jwtSecret: JWT_SECRET,
    jwtTtlSec: 3_600,
    chainId: anvilChain.id,
    identityRegistry: stack.registry,
    now,
    repo: entities,
    jobs: new SqliteJobRepository(db),
    companies,
    documents,
    docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations,
      checks,
      hasLinkedLegalBody: (companyId: string) => legalBodies.hasLinkedForCompany(companyId),
    },
    formation: {
      environment: pin.environment,
      required: true,
      ...formationLimits,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin,
      companyDeps: {
        companies,
        parties,
        requests,
        pin,
        ...formationLimits,
        maxTotal: 10,
        world,
        identity: undefined,
        legalBodyEnvironment: "sandbox",
        payment,
        now,
      },
      payment,
      feeUsdc: payment.feeUsdc,
      paymentExecutor: undefined,
    },
    legalBodyOrders: orderDeps,
    legalBodyStatements,
    legalBody: {
      resolver: createLegalBodyResolver({
        findByPocketAddress: (a) => entities.findByPocketAddress(a),
        findByTreasury: (a) => entities.findByTreasury(a),
        legalStatus: noFullProductRead,
        treasuryPaused: noFullProductRead,
      }),
      readBudget: publicReadBudget,
      links: { transparency: TRANSPARENCY, metadataBase: METADATA_BASE },
      network: "testnet",
    },
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return {
    db,
    companies,
    requests,
    documents,
    store,
    app: buildApiApp(deps as ApiDeps),
    doola,
    formationTick: () => formationSweeper.tick(),
    legalBodyTick: () => legalBodySweeper.tick(),
  };
}

beforeEach(async () => {
  // A head more than 120 seconds old is not believed: every case starts on a fresh block.
  await node.mine({ blocks: 1 });
  dir = mkdtempSync(join(tmpdir(), "legal-body-formed-door-"));
  // The operator's commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  d = deploy();
  printed = [];
  commandOutputAt = new Set();
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  d.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── The clocks, the chain and the requests ────────────────────────────────────────────────────

/** Move the chain's clock and the shared clock forward together, by whole seconds. */
async function moveTime(seconds: number): Promise<void> {
  await node.increaseTime({ seconds });
  await node.mine({ blocks: 1 });
  clockOffsetMs += seconds * 1_000;
}

/** One request of a signed-in guardian, or of nobody when `token` is undefined. */
async function api(method: "GET" | "POST", path: string, token?: string, body?: object) {
  return answerOf(await call(d.app, method, path, token, body));
}

/** How many public requests the file has made: each comes from a client of its own. */
let clients = 0;

/** One public, unauthenticated request. The proxy appends the client's address last. */
async function ask(path: string): Promise<{ status: number; body: Json }> {
  clients += 1;
  const res = await d.app.request(path, {
    headers: { "x-forwarded-for": `198.51.100.9, 2001:db8::${clients.toString(16)}` },
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

/** The identity id the registry minted in this receipt. */
function mintedId(logs: Log[]): bigint {
  const minted = parseEventLogs({ abi: mockIdentityRegistryAbi, eventName: "Transfer", logs }).find(
    (l) => isAddressEqual(l.address, stack.registry),
  );
  if (!minted) throw new Error("the registry minted no identity");
  return minted.args.tokenId;
}

/** A new identity owned by the owner's key. The test registry binds the owner as its wallet. */
async function identityOfKey(): Promise<bigint> {
  const hash = await walletOf(rpcUrl, owner).writeContract({
    address: stack.registry,
    abi: iIdentityRegistryAbi,
    functionName: "register",
    args: ["ipfs://legal-body-formed-door"],
    account: owner,
    chain: anvilChain,
  });
  return mintedId((await mined(pub, hash)).logs);
}

/** The owner writes `pointer` in its identity's metadata. */
async function setPointer(agentId: bigint, pointer: Hex): Promise<void> {
  await mined(
    pub,
    await walletOf(rpcUrl, owner).writeContract({
      address: stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "setMetadata",
      args: [agentId, POINTER_KEY, pointer],
      account: owner,
      chain: anvilChain,
    }),
  );
}

/** The calls the fake doola received under `method`. */
const callsOf = (method: string) => d.doola.calls.filter((c) => c.startsWith(`${method}:`));

// ── The guardian, as the web app signs it in and files its company ────────────────────────────

interface Guardian {
  account: PrivateKeyAccount;
  address: Address;
  token: string;
}

/** Step 1: a session, through the nonce and the guardian's signed SIWE message. */
async function signIn(account: PrivateKeyAccount): Promise<Guardian> {
  const issued = await api("GET", "/auth/nonce");
  expect(issued.status).toBe(200);
  const message = createSiweMessage({
    address: account.address,
    chainId: anvilChain.id,
    domain: SIWE_DOMAIN,
    nonce: issued.body.nonce,
    uri: `https://${SIWE_DOMAIN}`,
    version: "1",
    issuedAt: new Date(now()),
  });
  const verified = await api("POST", "/auth/verify", undefined, {
    message,
    signature: await account.signMessage({ message }),
  });
  expect(verified.status).toBe(200);
  expect(verified.body).toMatchObject({ token: expect.any(String), address: account.address });
  return { account, address: account.address, token: verified.body.token };
}

/** Step 2: the guardian's World verification, as the verify route records a passed one. */
function verifiedHuman(g: Guardian, nullifier: string): void {
  recordHuman(d.store, g.address, nullifier, now());
}

/** Step 4: the sandbox's synthetic party, its handle and nothing else. */
async function syntheticParty(g: Guardian): Promise<string> {
  const res = await api("POST", "/formation-party", g.token, { synthetic: true });
  expect(res.status).toBe(201);
  expect(res.body).toEqual({ partyId: expect.any(String) });
  return res.body.partyId;
}

/** Step 5: a company for a legal body, at the formed door, `ready` at once (no payment). */
async function formedCompany(
  g: Guardian,
  partyId: string,
  names: readonly [string, string, string],
): Promise<string> {
  const res = await api("POST", "/companies", g.token, {
    partyId,
    names,
    businessPurpose: PURPOSE,
    industryLabel: DEFAULT_INDUSTRY,
    synthetic: true,
    for: "legal_body",
  });
  expect(res.status).toBe(201);
  // The id only: a deployment that does not charge quotes nothing.
  expect(res.body).toEqual({ companyId: expect.any(String) });
  const companyId: string = res.body.companyId;
  expect(await companyView(g, companyId)).toMatchObject({
    companyId,
    purpose: "legal_body",
    provider: "doola",
    environment: "sandbox",
    state: "ready",
    legalNameFiled: null,
    filingNumber: null,
  });
  return companyId;
}

/** The company as the guardian's company page reads it. */
async function companyView(g: Guardian, companyId: string): Promise<Json> {
  const res = await api("GET", companyPath(companyId), g.token);
  expect(res.status).toBe(200);
  return res.body;
}

// ── The legal body, as the guardian and the identity's owner make it ──────────────────────────

/**
 * Step 9: the guardian orders a legal body for its company, a draft, and reads the agreement the
 * link will anchor: it prints the filed name and the filing number. The adoption of the agreement
 * (PR #206) goes here, after the read, so both doors of a company use it.
 */
async function order(
  g: Guardian,
  companyId: string,
  filed: { legalName: string; filingNumber: string },
): Promise<{ id: string; agreement: Json }> {
  const ordered = await api("POST", ORDERS, g.token, { companyId });
  expect(ordered.status).toBe(201);
  expect(ordered.body).toMatchObject({
    state: "draft",
    companyId,
    guardian: g.address,
    companyName: filed.legalName,
  });
  const id: string = ordered.body.id;
  const agreement = await api("GET", `${orderPath(id)}/agreement`, g.token);
  expect(agreement.status).toBe(200);
  expect(agreement.body.manifestHash).toBe(ordered.body.agreement.hash);
  expect(agreement.body.termsDoc).toContain(filed.legalName);
  expect(agreement.body.termsDoc).toContain(filed.filingNumber);
  return { id, agreement: agreement.body };
}

/** Step 10: an identity of the owner's key, the served link message signed by the owner, and the
 *  link door's answer: the body deployed. */
async function link(g: Guardian, id: string): Promise<{ agentId: bigint; body: Address }> {
  const agentId = await identityOfKey();
  const served = await api("POST", `${orderPath(id)}/link-message`, g.token, {
    agentId: agentId.toString(),
    ttlSeconds: 3_600,
  });
  expect(served.status).toBe(200);
  expect(served.body.identityOwner).toBe(owner.address);
  const { typedData } = served.body;
  const linked = await api("POST", `${orderPath(id)}/link`, g.token, {
    message: typedData.message,
    signature: await owner.signTypedData(typedData),
  });
  expect(linked.status).toBe(200);
  expect(linked.body).toMatchObject({ id, state: "deployed", agentId: agentId.toString() });
  return { agentId, body: linked.body.bodyAddress };
}

/** Step 11: the owner writes the pointer the binding door's intent describes; the legal-body
 *  sweeper's next tick sees it linked. */
async function bind(g: Guardian, id: string, agentId: bigint, body: Address): Promise<void> {
  const before = await api("GET", `${orderPath(id)}/binding`, g.token);
  expect(before.status).toBe(200);
  await setPointer(agentId, pointerFrom(before.body.intent));
  await d.legalBodyTick();
  const after = await api("GET", `${orderPath(id)}/binding`, g.token);
  expect(after.status).toBe(200);
  expect(after.body).toMatchObject({ state: "linked", bodyAddress: body, intent: null });
}

/**
 * Steps 9 to 12 for a filed company: ordered, linked and bound; then stated by agent as active,
 * Novi's, with its filed name, number and date, its EIN issued, nothing due yet, and no control
 * check; signed by the attestor; and the agreement's manifest says the company is Novi's.
 */
async function standBehindLegalBody(
  g: Guardian,
  companyId: string,
  filed: { legalName: string; filingNumber: string; filedOn: string },
): Promise<void> {
  const { id, agreement } = await order(g, companyId, filed);
  const { agentId, body } = await link(g, id);
  await bind(g, id, agentId, body);

  const stated = await ask(`/legal-bodies/by-agent/${agentId}`);
  expect(stated.status).toBe(200);
  expect(stated.body).toMatchObject({
    agentId: agentId.toString(),
    legalBody: true,
    standing: "active",
  });
  expect(stated.body.statement.message).toMatchObject({
    legalBody: body,
    agentId: agentId.toString(),
    bindingState: "linked",
    standing: "active",
    source: "novi",
    environment: "sandbox",
    legalName: filed.legalName,
    filingNumber: filed.filingNumber,
    filedAt: filed.filedOn,
    einIssued: true,
    filingStatus: "not_yet_due",
    controlVerified: false,
    guardianHumanVerified: true,
  });
  await expect(
    verifyPublicStatement(stated.body.statement, {
      attestor: attestor.address,
      expectedChainId: anvilChain.id,
      nowSeconds: Math.floor(now() / 1_000),
    }),
  ).resolves.toBe(true);
  expect(JSON.parse(agreement.manifest).company.source).toBe("novi");
}

// ── The operator's commands ───────────────────────────────────────────────────────────────────

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

/** Whether a console line is an ops line: one JSON object with an `opslog` event. */
function opsLineOf(line: string): Json | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a command as the operator types it, on the case's database, and answers the one JSON
 *  object it printed. */
async function operator(args: string[]): Promise<Json> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const outputs = printed
    .map((line, at) => ({ line, at }))
    .slice(from)
    .filter(({ line }) => opsLineOf(line) === undefined);
  expect(outputs).toHaveLength(1);
  const [output] = outputs as [{ line: string; at: number }];
  commandOutputAt.add(output.at);
  return JSON.parse(output.line);
}

// ── The case ──────────────────────────────────────────────────────────────────────────────────

test("the formed door end to end: a company filed by the saga on the fake doola and one recorded by the operator each stand behind a linked legal body stated as Novi's, and no ops line names either", async () => {
  // 1. A session.
  const g = await signIn(firstGuardian);

  // 2. The World row: a passed verification, which the formed door's real-human gate accepts.
  verifiedHuman(g, "7010");

  // 3. The deployment offers the formed door, and says how long a filing usually takes.
  const config = await api("GET", "/config");
  expect(config.status).toBe(200);
  expect(config.body.legalBodies).toMatchObject({
    available: true,
    environment: "sandbox",
    formedDoor: "offered",
    filingWorkingDays: 5,
    paymentRequired: false,
  });

  // 4. The synthetic party.
  const lanternParty = await syntheticParty(g);

  // 5. The company, `ready`.
  const lantern = await formedCompany(g, lanternParty, LANTERN);

  // 6. The sweeper opens the filing: one customer and one company created at doola.
  await d.formationTick();
  expect(callsOf("createCustomer")).toHaveLength(1);
  expect(callsOf("createCompany")).toHaveLength(1);
  const [lanternRef] = callsOf("createCompany").map((c) => c.split(":")[1]);
  expect(await companyView(g, lantern)).toMatchObject({
    state: "in_progress",
    providerRef: lanternRef,
  });
  // Nothing is completed before its five minutes.
  expect(callsOf("playgroundCompleteFormation")).toEqual([]);

  // 7. Five minutes on: the playground files it, and the same tick reads the filing, the
  //    documents and the filed name back through the processor.
  await moveTime(FIVE_MINUTES);
  await d.formationTick();
  const lanternFiledOn = new Date(now()).toISOString().slice(0, 10);
  expect(callsOf("playgroundCompleteFormation")).toEqual([
    `playgroundCompleteFormation:${lanternRef}`,
  ]);
  expect(callsOf("playgroundCompleteEin")).toEqual([]);
  expect(await companyView(g, lantern)).toMatchObject({
    state: "filed",
    legalNameFiled: LANTERN_FILED,
    filingNumber: PLAYGROUND_FILING,
    filedAt: filingDateToUnix(lanternFiledOn),
  });
  const indexed = d.documents.listByCompany(lantern);
  expect(indexed.map((doc) => [doc.docType, doc.source]).sort()).toEqual([
    ["ArticlesOfOrganization", "provider"],
    ["OperatingAgreement", "provider"],
  ]);

  // 8. Five minutes more: the playground issues the EIN, and the company is complete.
  await moveTime(FIVE_MINUTES);
  await d.formationTick();
  expect(callsOf("playgroundCompleteEin")).toEqual([`playgroundCompleteEin:${lanternRef}`]);
  expect(callsOf("playgroundCompleteFormation")).toHaveLength(1);
  expect(await companyView(g, lantern)).toMatchObject({ state: "complete" });

  // 9 to 12. The order, the link, the binding and the statement.
  await standBehindLegalBody(g, lantern, {
    legalName: LANTERN_FILED,
    filingNumber: PLAYGROUND_FILING,
    filedOn: lanternFiledOn,
  });

  // 13. The assisted path: a second guardian's company, never opened by the sweeper, recorded by
  //     the operator from the State's record.
  const g2 = await signIn(secondGuardian);
  verifiedHuman(g2, "7011");
  const beaconParty = await syntheticParty(g2);
  const beacon = await formedCompany(g2, beaconParty, BEACON);

  const articles = join(dir, "beacon-articles.pdf");
  writeFileSync(articles, Buffer.from("%PDF-1.7\n% Beacon Works articles, a test file\n%%EOF\n"));
  // The command reads the wall clock: the State filed it yesterday by that clock.
  const beaconFiledOn = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const filed = await operator([
    "formation:record-filed",
    beacon,
    "--filing-number",
    BEACON_FILING,
    "--filed-at",
    beaconFiledOn,
    "--legal-name",
    BEACON_FILED,
    "--articles",
    articles,
    "--operator",
    OPERATOR,
    "--yes",
  ]);
  expect(filed).toMatchObject({
    recorded: true,
    companyId: beacon,
    legalNameFiled: BEACON_FILED,
    filingNumber: BEACON_FILING,
    filedAt: filingDateToUnix(beaconFiledOn),
    matched: true,
    operator: OPERATOR,
  });
  expect(await companyView(g2, beacon)).toMatchObject({
    state: "filed",
    legalNameFiled: BEACON_FILED,
    filingNumber: BEACON_FILING,
    filedAt: filingDateToUnix(beaconFiledOn),
    // The operator's handle is internal: the guardian is never shown a `manual:` ref.
    providerRef: null,
  });
  expect(d.documents.listByCompany(beacon).map((doc) => [doc.docType, doc.source])).toEqual([
    ["ArticlesOfOrganization", "operator"],
  ]);

  // The saga never touches a filing recorded by hand: two ticks, five and ten minutes on, reach
  // doola for nothing, and move none of the company's rows.
  const callsBefore = [...d.doola.calls];
  const rowsBefore = JSON.stringify(d.requests.stepsOf(beacon));
  const companyBefore = JSON.stringify(d.companies.find(beacon));
  await moveTime(FIVE_MINUTES);
  await d.formationTick();
  await moveTime(FIVE_MINUTES);
  await d.formationTick();
  expect(d.doola.calls).toEqual(callsBefore);
  expect(JSON.stringify(d.requests.stepsOf(beacon))).toBe(rowsBefore);
  expect(JSON.stringify(d.companies.find(beacon))).toBe(companyBefore);

  // The IRS letter arrives: the operator records the EIN.
  const ein = await operator([
    "formation:record-ein",
    beacon,
    "--ein",
    PLAYGROUND_EIN,
    "--operator",
    OPERATOR,
    "--yes",
  ]);
  expect(ein).toMatchObject({ recorded: true, companyId: beacon, withValue: true });
  expect(await companyView(g2, beacon)).toMatchObject({ state: "complete" });

  await standBehindLegalBody(g2, beacon, {
    legalName: BEACON_FILED,
    filingNumber: BEACON_FILING,
    filedOn: beaconFiledOn,
  });

  // 14. The case's ops lines name no company, no person, no email and no EIN: the redaction at
  //     the write leaves each unchanged, and none carries a name the case typed or the party's.
  //     Every other line but the operator's own command output is held to the same names.
  const opsLines = printed.flatMap((line) => (opsLineOf(line) === undefined ? [] : [line]));
  const events = new Set(opsLines.map((line) => opsLineOf(line).opslog));
  for (const event of [
    "formation_party_created",
    "company_created",
    "formation_stranded_opened",
    "sandbox_filing_autocompleted",
    "sandbox_ein_autocompleted",
    "formation_recorded_filed",
    "formation_recorded_ein",
  ])
    expect(events, event).toContain(event);
  for (const line of opsLines) expect(redactPii(line)).toBe(line);
  const NAMED = ["Lantern", "Beacon", PLAYGROUND_EIN, "Novi Sandbox", "sandbox+", "@novicorpus"];
  for (const [at, line] of printed.entries()) {
    if (commandOutputAt.has(at)) continue;
    for (const named of NAMED) expect(line, `console line ${at}`).not.toContain(named);
  }
}, 120_000);
