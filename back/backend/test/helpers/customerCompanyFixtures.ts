import type Database from "better-sqlite3";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type WorldIdDeps, buildWorldIdDeps } from "../../src/api/routes/worldId";
import { type PiiKeyring, encryptText, parsePiiKey } from "../../src/formation/pii";
import { IDENTITY_AAD } from "../../src/identity/names";
import type { IdentityDeps } from "../../src/identity/state";
import type {
  CustomerCompanyDeps,
  CustomerStatementInput,
} from "../../src/legalBody/customerCompany";
import type { LegalText } from "../../src/legalBody/texts/index";
import {
  STATEMENT_OF_AUTHORITY,
  type StatementFields,
} from "../../src/legalBody/texts/statementOfAuthority";
import type { CompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import type { CompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../../src/persistence/companyRepository";
import type {
  GuardianIdentityCheck,
  IdentityRepository,
  NewGuardianIdentityCheck,
} from "../../src/persistence/identityRepository";
import type { SqliteWorldStore } from "../../src/persistence/worldStore";

/**
 * The fixtures every test of a customer's own company shares: the guardians' keys, the
 * deployment's constants, the approved wording, a verified human, World ID, a guardian identity
 * record, and the dependencies of the customer company doors on a production or a sandbox
 * deployment.
 *
 * Every key is one of anvil's published test accounts, never a real wallet, and every name,
 * company and filing number is an invention.
 */

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. */
export const ANVIL_ACCOUNT_2 = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
export const ANVIL_ACCOUNT_3 = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
export const ANVIL_ACCOUNT_4 = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);
export type Signer = typeof ANVIL_ACCOUNT_2;

/** The legal-body factory the statement's domain names, and the chain it lives on. */
export const FACTORY = "0x00000000000000000000000000000000000fAc70" as Address;
export const CHAIN_ID = 31_337;
/** The World ID action a guardian's verification is recorded under. */
export const ACTION = "guardian-verification";
/** Any provider but `customer` is a company filed through formation. */
export const FORMATION_PROVIDER = "example-formation-provider";

/** The draft wording, approved: what a production deployment serves once the wording is final. */
export const APPROVED: LegalText<StatementFields> = {
  ...STATEMENT_OF_AUTHORITY,
  status: "approved",
};

/** A declaration as a sandbox caller sends it: the synthetic flag, and no declarant. */
export const SANDBOX_TYPED: CustomerStatementInput = {
  // A sandbox name must say it is a test.
  companyName: "Example Test Holdings LLC",
  filingNumber: "TEST-0001",
  synthetic: true,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The PII key the identity fixtures encrypt the names of record under: a constant test key. */
export const TEST_PII_RING: PiiKeyring = {
  current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY"),
};

/** The names of record every guardian holds under `everyGuardianVerified`, made up. */
export const NAMES_OF_RECORD = { first: "Ada", last: "Example" } as const;
/** The declarant's name a production door writes from them: the first name, a space, the last. */
export const DECLARANT_OF_RECORD = "Ada Example";

/** A passed identity row of the tenant, as the operator's command writes one: completed `at`, due
 *  for renewal at `expiresAt`, its names encrypted under TEST_PII_RING with the tenant's AAD. */
export function passedIdentityRow(
  tenantId: string,
  opts: {
    at: number;
    expiresAt: number;
    names?: { first: string; last: string };
    full?: string | null;
    nullifier?: string | null;
  },
): NewGuardianIdentityCheck {
  const names = opts.names ?? NAMES_OF_RECORD;
  const seal = (field: "first" | "last" | "full", value: string) => {
    const { ciphertext, iv } = encryptText(TEST_PII_RING, value, IDENTITY_AAD(tenantId, field));
    return { ciphertext, iv };
  };
  return {
    nullifier: opts.nullifier ?? null,
    tenantId,
    provider: "stripe",
    providerRef: "vs_example",
    subject: null,
    status: "passed",
    supersedesCheckId: null,
    startedAt: opts.at,
    completedAt: opts.at,
    expiresAt: opts.expiresAt,
    names: {
      first: seal("first", names.first),
      last: seal("last", names.last),
      full: opts.full == null ? null : seal("full", opts.full),
      keyId: TEST_PII_RING.current.id,
    },
    nameHmac: "e".repeat(64),
    documentCountry: "USA",
    documentType: "passport",
    documentExpired: false,
    liveness: "passed",
    watchlist: "clear",
    reviewReasons: [],
    environment: "production",
    synthetic: false,
    operator: "ops.example",
    operatorOsUser: "ops",
  };
}

/** That row written through the repository with its `recorded` event: the guardian is verified
 *  while `expiresAt` is ahead of the identity clock. */
export function recordIdentity(
  repo: IdentityRepository,
  tenantId: string,
  opts: Parameters<typeof passedIdentityRow>[1],
): GuardianIdentityCheck {
  return repo.append(passedIdentityRow(tenantId, opts), {
    kind: "recorded",
    at: opts.at,
    actor: "ops.example",
    actorOsUser: "ops",
    reasonCode: null,
    reason: null,
  });
}

/** The identity dependencies over a repository, read with TEST_PII_RING on the clock `now`. */
export function identityOver(repo: IdentityRepository, now: () => number): IdentityDeps {
  return { repo, pii: TEST_PII_RING, reverifyYears: 3, blockedCountries: new Set(), now };
}

/**
 * The guardian identity record as the tests of the declared door need it when the record is not
 * their subject: every tenant's latest row is a passed record, completed a day before `now` and due
 * for renewal three years after, holding `names` (`passedIdentityRow`). Only `latest` is answered
 * (the one read the gate and the names make); any other call throws. The gate itself is tested
 * over the real repository in test/legalBody/customerCompanyIdentity.test.ts.
 */
export function everyGuardianVerified(
  now: () => number,
  names: { first: string; last: string } = NAMES_OF_RECORD,
): IdentityDeps {
  const latest = (tenantId: string): GuardianIdentityCheck => {
    const at = now() - DAY_MS;
    return {
      ...passedIdentityRow(tenantId, { at, expiresAt: at + 3 * 365 * DAY_MS, names }),
      checkId: 1,
      namesErasedAt: null,
    };
  };
  const unused = (): never => {
    throw new Error("the identity fixture answers latest only");
  };
  return identityOver(
    {
      latest,
      append: unused,
      list: unused,
      events: unused,
      findById: unused,
      passedElsewhere: unused,
      eraseNames: unused,
      erasureCandidates: unused,
      transaction: unused,
    },
    now,
  );
}

/** The stores the customer company doors read and write, over one test database. */
export interface CustomerStores {
  db: Database.Database;
  companies: CompanyRepository;
  declarations: CompanyDeclarationRepository;
  checks: CompanyCheckRepository;
  store: SqliteWorldStore;
}

/** A verification row, recorded as the verify route records one. `verifiedAt` is milliseconds. */
export function recordHuman(
  store: SqliteWorldStore,
  tenantId: Address,
  nullifier: string,
  verifiedAt: number,
  credential = "proof_of_human",
): void {
  const recorded = store.recordVerification({
    nullifier,
    action: ACTION,
    tenantId,
    issuerSchemaId: 1,
    credential,
    environment: "production",
    verifiedAt,
    expiresAtMin: null,
  });
  if (!recorded) throw new Error("the verification row was not recorded");
}

/** World ID wired through its one builder. Enforcement is off on purpose: a declaration needs a
 *  real human whatever that switch says. */
export function worldFor(
  store: SqliteWorldStore,
  opts: { environment?: "production" | "staging"; maxCompaniesPerHuman?: number } = {},
): WorldIdDeps {
  return buildWorldIdDeps(
    {
      appId: "app_test",
      rpId: "rp_test",
      rpSigningKey: `0x${"1".repeat(64)}`,
      action: ACTION,
      environment: opts.environment ?? "production",
      attestMinAge: 18,
      maxCompaniesPerHuman: opts.maxCompaniesPerHuman,
      requireGuardian: false,
    },
    store,
  );
}

/** The doors of a production deployment that charges, serving the approved wording, on the
 *  test's clock (milliseconds), where every guardian's identity is verified with the names of
 *  record (`everyGuardianVerified`). */
export function customerCompanyDeps(
  s: CustomerStores,
  now: () => number,
  over: Partial<CustomerCompanyDeps> = {},
): CustomerCompanyDeps {
  return {
    companies: s.companies,
    declarations: s.declarations,
    checks: s.checks,
    world: worldFor(s.store),
    chainId: CHAIN_ID,
    factory: FACTORY,
    environment: "production",
    identity: everyGuardianVerified(now),
    text: APPROVED,
    maxOpenPerTenant: 3,
    paymentRequired: true,
    hasOpenLegalBody: () => false,
    transaction: (fn) => s.db.transaction(fn)(),
    now,
    ...over,
  };
}

/** The doors of a sandbox deployment: the draft wording, a World configuration that is not
 *  production, and no identity record, as on the testnet box, which holds no PII key. */
export function sandboxCustomerCompanyDeps(
  s: CustomerStores,
  now: () => number,
  over: Partial<CustomerCompanyDeps> = {},
): CustomerCompanyDeps {
  return customerCompanyDeps(s, now, {
    environment: "sandbox",
    identity: undefined,
    text: STATEMENT_OF_AUTHORITY,
    world: worldFor(s.store, { environment: "staging" }),
    ...over,
  });
}
