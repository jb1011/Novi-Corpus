/**
 * A legal body whose company Novi formed through doola is stated as Novi's: `source: "novi"`, its
 * names from the company row, its formation date from `companies.filed_at` (the State's date, as
 * doola reported it), its EIN fact from the formation steps, and no control check. Its agreement's
 * manifest says `novi`, and its order view names the company by its filed name.
 *
 * A declared company's statement, transparency row and manifest are byte-for-byte what they were
 * before formed companies were stated: the literals below were captured from the code as it stood
 * before this change (7b5b124).
 *
 * A fake chain over a real in-memory database, on a fixed clock. Every key is one of anvil's
 * published test accounts, every other address a placeholder, and every name, company and filing
 * number an invention.
 */
import { type Address, type LocalAccount, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { companyNameOptions } from "../../src/formation/intake";
import { agreementDocNames } from "../../src/legalBody/agreement";
import { createOrder, orderViewFacts } from "../../src/legalBody/orders";
import {
  claimsHash,
  statementFromJson,
  verifyPublicStatement,
} from "../../src/legalBody/publicStatement";
import {
  type LegalBodyStatementDeps,
  type StatementOutcome,
  activeLegalBodies,
  statementForAgent,
} from "../../src/legalBody/statements";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { SqliteLegalBodyTreasuryRepository } from "../../src/persistence/legalBodyTreasuryRepository";
import { filingDateToUnix } from "../../src/workflow/formationProcessor";
import { ACTION, CHAIN_ID, FACTORY, recordHuman } from "../helpers/customerCompanyFixtures";
import { seedCompany } from "../helpers/formationFakes";
import { REGISTRY, appendCheck, legalBodyOrderDeps } from "../helpers/legalBodyFixtures";
import {
  CLOCK_MS,
  CLOCK_S,
  FakeStatementChain,
  OA_HASH,
  OWNER,
  SNAPSHOT_HEAD,
  type StatementStores,
  TENANT,
  TEST_ATTESTOR,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

/** The full legal name the processor stores for a legal-body company, and its filing number. */
const FILED_NAME = "Lantern Works LLC";
const FILING_NUMBER = "2026-000451207";
/**
 * The day doola reported the State filed it, and `filed_at` as the processor writes it: unix
 * seconds at UTC midnight. The first of a month on purpose: Wyoming's clock reads that instant as
 * the evening of the 30th of September, which would put the annual report a month early.
 */
const FILED_ON = "2026-10-01";
const FILED_AT = filingDateToUnix(FILED_ON) as number;
/** Placeholders: the bodies of the two rows a snapshot is pinned to. */
const CUSTOMER_BODY = getAddress("0x00000000000000000000000000000000000dec1a");
const FORMED_BODY = getAddress("0x00000000000000000000000000000000000f0e1d");
/** The sighting that opened each row's linked stretch, fixed so the listing's `linkedSince` is. */
const SEEN_AT = 1_791_000_000;

let s: StatementStores;
let chain: FakeStatementChain;
let requests: SqliteFormationRepository;
let printed: string[];

beforeEach(() => {
  s = openStatementStores();
  chain = new FakeStatementChain();
  requests = new SqliteFormationRepository(s.db);
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

/** The event of the line a filed formed company's unusable `filed_at` writes. */
const FILING_DATE_LINE = "legal_body_statement_filing_date_unusable";

type Signed = Extract<StatementOutcome, { kind: "statement" }>;

function expectStatement(out: StatementOutcome): Signed {
  if (out.kind !== "statement") throw new Error(`expected a statement, got ${JSON.stringify(out)}`);
  return out;
}

const logRows = () =>
  s.db.prepare("SELECT standing, claims_hash, evidence FROM statement_log ORDER BY id").all();

/** The tenant's World ID verification, recorded once. */
function human(): void {
  if (s.store.findByTenant(TENANT, ACTION) === undefined)
    recordHuman(s.store, TENANT, `nullifier-${TENANT.toLowerCase()}`, CLOCK_MS - 60_000);
}

let formed = 0;

/**
 * A company Novi formed through doola for the tenant, `ready` (paid, or a deployment that does
 * not charge), its formation steps opened and `create_provider` confirmed, as the saga leaves
 * them. `filing`: `confirmed` writes the filing facts the processor writes when the State confirms
 * the filing; `submitted` leaves the step waiting on the State with the facts already written, so
 * only the step tells the two apart. `filedAt` is the `filed_at` written with the facts (FILED_AT
 * unless told otherwise; null when doola has reported no date yet). `ein` confirms the documents
 * and the EIN after the filing.
 */
function formedCompany(
  o: {
    purposeKind?: "agent" | "legal_body";
    filing?: "confirmed" | "submitted";
    filedAt?: number | null;
    ein?: boolean;
  } = {},
): string {
  human();
  const companyId = seedCompany(s.companies, {
    companyId: `formed-${++formed}`,
    tenantId: TENANT,
    purposeKind: o.purposeKind ?? "legal_body",
    nameOptions: companyNameOptions(FILED_NAME),
    businessPurpose: "Software services.",
  });
  expect(requests.claimAllSteps(companyId)).toBe(true);
  expect(
    requests.transition(companyId, "create_provider", "pending", "confirmed", {
      providerRef: `doola-${companyId}`,
    }),
  ).toBe(true);
  expect(requests.transition(companyId, "await_filing", "pending", o.filing ?? "confirmed")).toBe(
    true,
  );
  s.companies.recordFilingFacts(companyId, {
    filedAt: o.filedAt === undefined ? FILED_AT : o.filedAt,
    filingNumber: FILING_NUMBER,
    legalNameFiled: FILED_NAME,
  });
  if (o.ein === true) {
    expect(requests.transition(companyId, "fetch_documents", "pending", "confirmed")).toBe(true);
    expect(requests.transition(companyId, "await_ein", "pending", "confirmed")).toBe(true);
  }
  return companyId;
}

/** A declared company of the tenant, `ready`, with a verified human and a check that passed. */
function declaredCompany(): string {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  return companyId;
}

/** A row of the company linked for agent 42 at SEEN_AT, its body `body`, linked on chain too. */
function linkedBody(companyId: string, body: Address): LegalBodyRecord {
  const row = bodyIn("linked", s, companyId, { body, seenAt: SEEN_AT });
  chain.link(row);
  return row;
}

const agent42 = (over: Partial<LegalBodyStatementDeps> = {}) =>
  statementForAgent(statementDeps(s, chain, over), "42");
const listing = (over: Partial<LegalBodyStatementDeps> = {}) =>
  activeLegalBodies(statementDeps(s, chain, over), 100);

/** A formed body's statement on the clock, field by field, filed and not yet with its EIN. */
const FORMED_MESSAGE = {
  chainId: String(CHAIN_ID),
  identityRegistry: REGISTRY,
  factory: getAddress(FACTORY),
  legalBody: FORMED_BODY,
  agentId: "42",
  agentWallet: OWNER,
  identityOwnerAtCreation: OWNER,
  bindingState: "linked",
  identityOwnerIsContract: false,
  agentWalletIsContract: false,
  standing: "active",
  attestationState: "active",
  jurisdiction: "WY",
  entityType: "LLC",
  legalName: FILED_NAME,
  filingNumber: FILING_NUMBER,
  source: "novi",
  environment: "sandbox",
  // No operator checked control of a company Novi formed: the derivation says so for any formed
  // company, and no check established it.
  controlVerified: false,
  existenceCheckedAt: "0",
  filedAt: FILED_ON,
  einIssued: false,
  filingStatus: "not_yet_due",
  lastFiledPeriod: "0",
  lastFiledAt: "",
  lastFiledConfirmedBy: "",
  // The first annual report is due on the first day of the formation month, a year on.
  nextDue: "2027-10-01",
  oaManifestHash: OA_HASH,
  oaManifestVersion: "1",
  guardianHumanVerified: true,
  observedAtBlock: String(SNAPSHOT_HEAD.number),
  issuedAt: String(CLOCK_S),
  expiresAt: String(CLOCK_S + 300),
};

describe("a declared company is stated exactly as before", () => {
  /** Captured at 7b5b124, before formed companies were stated. */
  const SIGNED_BEFORE = {
    domain: { name: "Novi Corpus Attestation", version: "2", chainId: 31337 },
    primaryType: "LegalBodyStatement",
    message: {
      chainId: "31337",
      identityRegistry: "0x0000000000000000000000000000000000008004",
      factory: "0x00000000000000000000000000000000000fAc70",
      legalBody: "0x00000000000000000000000000000000000dec1a",
      agentId: "42",
      agentWallet: "0x00000000000000000000000000000000000a0001",
      identityOwnerAtCreation: "0x00000000000000000000000000000000000a0001",
      bindingState: "linked",
      identityOwnerIsContract: false,
      agentWalletIsContract: false,
      standing: "active",
      attestationState: "active",
      jurisdiction: "WY",
      entityType: "LLC",
      legalName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      source: "customer",
      environment: "sandbox",
      controlVerified: true,
      existenceCheckedAt: "1791392400",
      filedAt: "2026-01-15",
      einIssued: false,
      filingStatus: "not_yet_due",
      lastFiledPeriod: "0",
      lastFiledAt: "",
      lastFiledConfirmedBy: "",
      nextDue: "2027-01-01",
      oaManifestHash: "0xabababababababababababababababababababababababababababababababab",
      oaManifestVersion: "1",
      guardianHumanVerified: true,
      observedAtBlock: "4242",
      issuedAt: "1791396000",
      expiresAt: "1791396300",
    },
    attestor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    signature:
      "0xafe4ea51e4230b430e867ab96c72e418159185c89badcaedd4e3087814d65c0f4cc03a3902129965032d0c7fcdd49bce5aff82546d2e27d9e85023e04634f2c21b",
  };
  const CLAIMS_BEFORE = "0x25513078d4cbb1f068ca7a33f0e70b6b68c4f366d46518ee31bfee8ac2248ecb";
  const EVIDENCE_BEFORE =
    '{"checkId":1,"revocationEventId":null,"companyStatus":"ready","humanVerified":true,"identityVerified":false}';
  const MANIFEST_HASH_BEFORE = "0x29f92ddd41cdc9ee1222a405fcfe04e59043359b37b88fc533c10cf8c4fa15e0";
  const MANIFEST_BEFORE =
    '{"amendmentDelay":172800,"chain":{"chainId":31337,"factory":"0x00000000000000000000000000000000000fAc70","identityRegistry":"0x0000000000000000000000000000000000008004"},"company":{"entityType":"LLC","jurisdiction":"WY","source":"customer"},"guardian":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","schema":"novi.legal-body-manifest/1","terms":{"hash":"0x35ceb02b75ae7814f48de8e07567bdf51e3c2f1be705f0714a4b37eaeefc18de","textId":"legal-body-operating-agreement","textStatus":"draft","textVersion":"2026-10-draft-1"},"version":1}\n';

  test("its signed statement, claims and logged evidence are the bytes they were, and no formation step is read", async () => {
    const row = linkedBody(declaredCompany(), CUSTOMER_BODY);
    const formationSteps = vi.fn(() => []);

    const out = expectStatement(await agent42({ formationSteps }));
    // The whole envelope, the signature included: every byte of the domain and the message.
    expect(JSON.stringify(out.statement)).toBe(JSON.stringify(SIGNED_BEFORE));
    expect(claimsHash(statementFromJson(out.statement.message))).toBe(CLAIMS_BEFORE);
    expect(logRows()).toEqual([
      { standing: "active", claims_hash: CLAIMS_BEFORE, evidence: EVIDENCE_BEFORE },
    ]);
    expect(out).toMatchObject({ legalBodyId: row.legalBodyId, standing: "active" });
    expect(formationSteps).not.toHaveBeenCalled();
  });

  test("a treasury of record declared for the body leaves the signed statement the bytes it was: its 33 fields, domain version 2", async () => {
    const row = linkedBody(declaredCompany(), CUSTOMER_BODY);
    // The guardian declared the agent's wallet as the chain shows it (the row's identity owner),
    // with a provider and a link to its limits: the unsigned record beside the statement.
    new SqliteLegalBodyTreasuryRepository(s.db).append({
      legalBodyId: row.legalBodyId,
      address: OWNER,
      provider: "other",
      providerName: "Example Wallets",
      limitsReadableAt: "https://limits.example.test/wallets/0001",
      registryTxHash: null,
      at: CLOCK_S - 60,
    });

    const out = expectStatement(await agent42());
    expect(JSON.stringify(out.statement)).toBe(JSON.stringify(SIGNED_BEFORE));
    expect(claimsHash(statementFromJson(out.statement.message))).toBe(CLAIMS_BEFORE);
    // The key set, in its order: the 33 signed fields and no other.
    expect(Object.keys(out.statement.message)).toEqual(Object.keys(SIGNED_BEFORE.message));
    expect(Object.keys(out.statement.message)).toHaveLength(33);
    expect(out.statement.domain.version).toBe("2");
    expect(JSON.stringify(out)).not.toContain("limits.example");
    expect(JSON.stringify(out)).not.toContain("Example Wallets");
  });

  test("its transparency row is the one it was", async () => {
    const row = linkedBody(declaredCompany(), CUSTOMER_BODY);
    const formationSteps = vi.fn(() => []);
    const listed = await listing({ formationSteps });
    expect(JSON.stringify(listed)).toBe(
      JSON.stringify([
        {
          agentId: "42",
          publicId: row.publicId,
          legalBody: "0x00000000000000000000000000000000000dec1a",
          chainId: 31337,
          legalName: "Example Holdings LLC",
          filingNumber: "TEST-0001",
          jurisdiction: "WY",
          entityType: "LLC",
          source: "customer",
          environment: "sandbox",
          standing: "active",
          linkedSince: "2026-10-03T04:00:00.000Z",
          links: { statement: "https://api.example.test/legal-bodies/by-agent/42" },
        },
      ]),
    );
    expect(formationSteps).not.toHaveBeenCalled();
  });

  test("its order's manifest is the bytes it was, and its view names the declared company", () => {
    const companyId = declaredCompany();
    const view = createOrder(legalBodyOrderDeps(s), TENANT, { companyId });
    expect(view.agreement).toEqual({ hash: MANIFEST_HASH_BEFORE, version: 1 });
    expect(s.docStore.get(agreementDocNames(view.id).manifest)).toBe(MANIFEST_BEFORE);
    expect(view.companyName).toBe("Example Holdings LLC");
  });
});

describe("a company Novi formed, filed, paid and linked", () => {
  test("is stated active, as Novi's: the row's names, the State's filing date, no control check, no EIN yet", async () => {
    const row = linkedBody(formedCompany(), FORMED_BODY);

    const out = expectStatement(await agent42());
    expect(out).toMatchObject({
      kind: "statement",
      agentId: "42",
      legalBodyId: row.legalBodyId,
      publicId: row.publicId,
      standing: "active",
      guardianIdentityVerified: false,
    });
    expect(out.statement.message).toEqual(FORMED_MESSAGE);
    await expect(
      verifyPublicStatement(out.statement, {
        attestor: TEST_ATTESTOR.address,
        expectedChainId: CHAIN_ID,
        nowSeconds: CLOCK_S,
      }),
    ).resolves.toBe(true);
    // The claims rest on the company row and its steps: no check was read as evidence.
    expect(logRows()).toEqual([
      {
        standing: "active",
        claims_hash: claimsHash(statementFromJson(out.statement.message)),
        evidence:
          '{"checkId":null,"revocationEventId":null,"companyStatus":"ready","humanVerified":true,"identityVerified":false}',
      },
    ]);
    // A usable filing date writes no line.
    expect(opsLines(FILING_DATE_LINE)).toEqual([]);
  });

  test("the formation date is the day doola reported, never the evening before on Wyoming's clock", async () => {
    linkedBody(formedCompany(), FORMED_BODY);
    const { message } = expectStatement(await agent42()).statement;
    expect(FILED_AT).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
    expect(message.filedAt).toBe("2026-10-01");
    expect(message.nextDue).toBe("2027-10-01");
  });

  test("a filed_at that is not a stored date (a UTC midnight) is no formation date: unverified, never a guessed day, and one line naming the body and the reason", async () => {
    const companyId = formedCompany();
    const row = linkedBody(companyId, FORMED_BODY);
    const find = s.companies.find.bind(s.companies);
    vi.spyOn(s.companies, "find").mockImplementation((id: string) => {
      const company = find(id);
      return company && id === companyId ? { ...company, filedAt: FILED_AT + 3_600 } : company;
    });
    const { message } = expectStatement(await agent42()).statement;
    expect(message).toMatchObject({
      standing: "unknown",
      filedAt: "",
      filingStatus: "unverified",
      nextDue: "",
      legalName: FILED_NAME,
    });
    expect(opsLines(FILING_DATE_LINE)).toEqual([
      {
        level: "warn",
        legalBodyId: row.legalBodyId,
        companyId,
        problem: "filed_at_not_a_stored_date",
      },
    ]);
    // Ids and the reason's code only: never the stored value, nor any date read from it (the
    // line's own `at` stamp, which `opsLines` leaves out, is the only time it carries).
    const fields = JSON.stringify(opsLines(FILING_DATE_LINE));
    expect(fields).not.toContain(String(FILED_AT + 3_600));
    expect(fields).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  });

  test("a confirmed filing whose filed_at doola has not reported yet: unverified, so unknown, and one line per read naming the body and the reason", async () => {
    // The processor confirms `await_filing` and writes the facts doola reported; with no filing
    // date, `filingDateToUnix` gives null and `filed_at` stays NULL.
    const companyId = formedCompany({ filedAt: null });
    expect(s.companies.find(companyId)?.filedAt).toBeNull();
    const row = linkedBody(companyId, FORMED_BODY);

    const { message } = expectStatement(await agent42()).statement;
    expect(message).toMatchObject({
      standing: "unknown",
      attestationState: "active",
      source: "novi",
      legalName: FILED_NAME,
      filingNumber: FILING_NUMBER,
      filedAt: "",
      filingStatus: "unverified",
      nextDue: "",
      lastFiledPeriod: "0",
    });
    // Not active, so not listed; the listing read it too, and wrote its own line.
    await expect(listing()).resolves.toEqual([]);
    const expected = {
      level: "warn",
      legalBodyId: row.legalBodyId,
      companyId,
      problem: "filed_at_missing",
    };
    expect(opsLines(FILING_DATE_LINE)).toEqual([expected, expected]);
  });

  test("einIssued turns true once await_ein is confirmed, and nothing else moves", async () => {
    linkedBody(formedCompany({ ein: true }), FORMED_BODY);
    const out = expectStatement(await agent42());
    expect(out.statement.message).toEqual({ ...FORMED_MESSAGE, einIssued: true });
  });

  test("the transparency listing carries it with source novi and the row's names", async () => {
    const row = linkedBody(formedCompany(), FORMED_BODY);
    await expect(listing()).resolves.toEqual([
      {
        agentId: "42",
        publicId: row.publicId,
        legalBody: FORMED_BODY,
        chainId: CHAIN_ID,
        legalName: FILED_NAME,
        filingNumber: FILING_NUMBER,
        jurisdiction: "WY",
        entityType: "LLC",
        source: "novi",
        environment: "sandbox",
        standing: "active",
        linkedSince: new Date(SEEN_AT * 1000).toISOString(),
        links: { statement: "https://api.example.test/legal-bodies/by-agent/42" },
      },
    ]);
  });

  test("its order's manifest says novi, and its view names the company by its filed name", () => {
    const companyId = formedCompany();
    const view = createOrder(legalBodyOrderDeps(s), TENANT, { companyId });
    const manifest = JSON.parse(s.docStore.get(agreementDocNames(view.id).manifest));
    expect(manifest.company).toEqual({ source: "novi", jurisdiction: "WY", entityType: "LLC" });
    expect(view.companyName).toBe(FILED_NAME);
  });
});

describe("a formed company the gates do not let stand", () => {
  test("not yet filed by the State: pending, with no names and no formation date, whatever the row already carries", async () => {
    linkedBody(formedCompany({ filing: "submitted" }), FORMED_BODY);
    const { message } = expectStatement(await agent42()).statement;
    expect(message).toMatchObject({
      standing: "pending",
      attestationState: "pending",
      source: "novi",
      legalName: "",
      filingNumber: "",
      filedAt: "",
      filingStatus: "unverified",
      einIssued: false,
      controlVerified: false,
    });
    await expect(listing()).resolves.toEqual([]);
    // Not filed: no filing date is expected yet, so none is missing.
    expect(opsLines(FILING_DATE_LINE)).toEqual([]);
  });

  test("abandoned: no longer active, and it names nothing", async () => {
    const companyId = formedCompany();
    linkedBody(companyId, FORMED_BODY);
    const find = s.companies.find.bind(s.companies);
    vi.spyOn(s.companies, "find").mockImplementation((id: string) => {
      const company = find(id);
      return company && id === companyId ? { ...company, status: "abandoned" } : company;
    });
    const { message } = expectStatement(await agent42()).statement;
    expect(message).toMatchObject({
      standing: "pending",
      attestationState: "pending",
      source: "novi",
      legalName: "",
      filingNumber: "",
    });
    await expect(listing()).resolves.toEqual([]);
  });

  test("revoked by the operator (company:revoke takes a company of any provider): inactive, and it names nothing", async () => {
    const companyId = formedCompany();
    linkedBody(companyId, FORMED_BODY);
    appendCheck(s.checks, companyId, "revoked");
    const { message } = expectStatement(await agent42()).statement;
    expect(message).toMatchObject({
      standing: "inactive",
      attestationState: "revoked",
      source: "novi",
      legalName: "",
      filingNumber: "",
    });
    await expect(listing()).resolves.toEqual([]);
  });

  test("a company formed for agents never stands behind a legal body: no statement, unsupported_purpose", async () => {
    const row = linkedBody(formedCompany({ purposeKind: "agent" }), FORMED_BODY);
    let signed = 0;
    const signer: LocalAccount = {
      ...TEST_ATTESTOR,
      signTypedData: ((p: never) => {
        signed += 1;
        return TEST_ATTESTOR.signTypedData(p);
      }) as unknown as LocalAccount["signTypedData"],
    };
    await expect(agent42({ signer })).resolves.toEqual({ kind: "none" });
    await expect(listing()).resolves.toEqual([]);
    expect(opsLines("legal_body_statement_integrity")).toEqual([
      { legalBodyId: row.legalBodyId, problem: "unsupported_purpose" },
      { legalBodyId: row.legalBodyId, problem: "unsupported_purpose" },
    ]);
    expect(signed).toBe(0);
    expect(logRows()).toEqual([]);
  });
});

describe("the order view's company name", () => {
  test("a formed company: its filed name once the row holds one, null before", () => {
    const filed = formedCompany();
    const unnamed = seedCompany(s.companies, {
      companyId: "formed-unnamed",
      tenantId: TENANT,
      purposeKind: "legal_body",
    });
    const facts = (companyId: string) =>
      orderViewFacts(
        s,
        s.repo.create({
          tenantId: TENANT,
          companyId,
          chainId: CHAIN_ID,
          factory: FACTORY,
          amendmentDelay: 172_800,
        }),
      ).companyName;
    expect(facts(filed)).toBe(FILED_NAME);
    expect(facts(unnamed)).toBeNull();
    expect(facts(declaredCompany())).toBe("Example Holdings LLC");
  });
});
