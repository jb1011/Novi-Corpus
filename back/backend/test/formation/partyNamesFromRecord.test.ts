/**
 * The two party doors on production: the responsible person's names are written from the
 * guardian's verified identity record, never typed.
 *
 * On a production door (doola's pin or the network production, `formedDoorEnvironment`) both
 * doors run the strict World gate, then the identity gate: `createFormationParty` first of all,
 * `updateCompanyParty` right after its ownership check. A body that carries `legalFirstName` or
 * `legalLastName`, with any value, is refused 400 `party_name_is_written_by_novi`; the names
 * written are the record's (`namesOfRecordAtDoor`), and the edit door never rewrites them. A
 * `marketingConsent: true` stores `marketing_consent_at`; nothing else is written for it (the
 * email outbox that will add the address to the campaign contacts is not on this branch).
 *
 * A sandbox door is as before: the synthetic shortcut, real bodies refused, no World gate, the
 * record never read, no consent stored.
 *
 * The database is real (in memory). Every name, address and nullifier is an invention, the PII
 * keys constant test keys.
 */
import type DatabaseType from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../src/api/errors";
import type { WorldIdDeps } from "../../src/api/routes/worldId";
import {
  companyUnavailableMessage,
  partyNamesRequiredMessage,
  syntheticPiiRefusedMessage,
  syntheticPiiRequiredMessage,
} from "../../src/formation";
import {
  type CreateCompanyDeps,
  createFormationParty,
  updateCompanyParty,
} from "../../src/formation/company";
import { DEFAULT_INDUSTRY, companyNameOptions } from "../../src/formation/intake";
import { type PiiKeyring, parsePiiKey } from "../../src/formation/pii";
import type { IdentityDeps } from "../../src/identity/state";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type EditablePartyFields,
  SqliteFormationPartyRepository,
} from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteIdentityRepository } from "../../src/persistence/identityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { FormationPartySchema } from "../../src/policy/agentSpec";
import {
  NAMES_OF_RECORD,
  identityOver,
  recordHuman,
  recordIdentity,
  worldFor,
} from "../helpers/customerCompanyFixtures";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const TENANT = getAddress("0x00000000000000000000000000000000000000d1");
const OTHER = getAddress("0x00000000000000000000000000000000000000d2");
const NULLIFIER = "4001";

/** A party body as a production caller sends it: everything but the names. */
const BODY = {
  email: "person@example.com",
  phone: "+12125550100",
  address: {
    line1: "1 Example Way",
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
  },
};

/** The fields the edit door rewrites: every one of them different from `BODY`'s. */
const EDIT: EditablePartyFields = {
  email: "other@example.com",
  phone: "+12125550199",
  line1: "2 Example Way",
  line2: null,
  city: "Sheridan",
  region: "WY",
  postalCode: "82801",
  country: "USA",
};

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let store: SqliteWorldStore;
let identityRepo: SqliteIdentityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  store = new SqliteWorldStore(db);
  identityRepo = new SqliteIdentityRepository(db);
  // The edit door writes an ops line: kept off stdout here.
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

type PartyDoorDeps = Pick<
  CreateCompanyDeps,
  | "companies"
  | "parties"
  | "requests"
  | "transaction"
  | "sandboxSyntheticPii"
  | "world"
  | "identity"
  | "pin"
  | "legalBodyEnvironment"
  | "now"
>;

/** A production deployment: doola's production pin, the mainnet network, World wired, the
 *  identity record read with the test key. */
function prodDeps(over: Partial<PartyDoorDeps> = {}): PartyDoorDeps {
  return {
    companies,
    parties,
    requests,
    transaction: (fn) => db.transaction(fn)(),
    sandboxSyntheticPii: false,
    world: worldFor(store),
    identity: identityOver(identityRepo, () => NOW),
    pin: { provider: "doola", environment: "production" },
    legalBodyEnvironment: "production",
    now: () => NOW,
    ...over,
  };
}

/** The testnet box: doola's sandbox, the testnet network, synthetic parties, no World, no
 *  identity record. */
function sandboxDeps(over: Partial<PartyDoorDeps> = {}): PartyDoorDeps {
  return prodDeps({
    sandboxSyntheticPii: true,
    world: undefined,
    identity: undefined,
    pin: { provider: "doola", environment: "sandbox" },
    legalBodyEnvironment: "sandbox",
    ...over,
  });
}

/** Identity deps whose every read throws: a door that reads them fails the test. */
function unreadIdentity(): IdentityDeps {
  const read = (): never => {
    throw new Error("the identity record was read");
  };
  return {
    repo: new Proxy({}, { get: () => read }) as IdentityDeps["repo"],
    pii: { current: parsePiiKey(Buffer.alloc(32, 9).toString("base64"), "TEST_KEY") },
    reverifyYears: 3,
    blockedCountries: new Set(),
    now: () => NOW,
  };
}

/** The guardian has a World row for the guardian action. */
const human = (tenantId = TENANT, nullifier = NULLIFIER) =>
  recordHuman(store, tenantId, nullifier, NOW - DAY_MS);

/** The guardian's passed identity record, holding NAMES_OF_RECORD, tied to the World row. */
const recordOf = (tenantId = TENANT, nullifier = NULLIFIER) =>
  recordIdentity(identityRepo, tenantId, {
    at: NOW - 30 * DAY_MS,
    expiresAt: NOW + 3 * 365 * DAY_MS,
    nullifier,
  });

/** A real and verified guardian: the World row and the identity record. */
function verified(tenantId = TENANT, nullifier = NULLIFIER): void {
  human(tenantId, nullifier);
  recordOf(tenantId, nullifier);
}

const parsed = (body: object) => FormationPartySchema.parse(body);

/** The ApiError a call throws, or null when it returns. */
function thrown(fn: () => unknown): ApiError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
}

const partyRows = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM formation_parties").get() as { n: number }).n;

/** The number of rows in every table of the database. */
function tableCounts(): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map((t) => [
      t.name,
      (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n,
    ]),
  );
}

const consentOf = (partyId: string): number | null =>
  (
    db
      .prepare("SELECT marketing_consent_at AS at FROM formation_parties WHERE party_id = ?")
      .get(partyId) as { at: number | null }
  ).at;

const idOf = (result: { partyId: string } | { error: string }): string => {
  if ("error" in result) throw new Error(result.error);
  return result.partyId;
};

/** A ready formed legal-body company of `tenantId`, its party bound, holding the names of record:
 *  what the production intake writes. */
function formedCompanyWithParty(tenantId = TENANT): { companyId: string; partyId: string } {
  const partyId = parties.create({
    tenantId,
    legalFirstName: NAMES_OF_RECORD.first,
    legalLastName: NAMES_OF_RECORD.last,
    email: BODY.email,
    phone: BODY.phone,
    line1: BODY.address.line1,
    line2: null,
    city: BODY.address.city,
    region: BODY.address.region,
    postalCode: BODY.address.postalCode,
    country: BODY.address.country,
    synthetic: false,
  });
  const companyId = companies.create({
    tenantId,
    status: "ready",
    provider: "doola",
    environment: "production",
    synthetic: false,
    nameOptions: companyNameOptions("Example Works", "Example Labs", "Example Studio"),
    businessPurpose: "Operating software agents.",
    industryLabel: DEFAULT_INDUSTRY,
    intakeSynthesized: false,
    purposeKind: "legal_body",
  });
  expect(parties.bindToCompany(partyId, companyId, tenantId)).toBe(true);
  return { companyId, partyId };
}

/** The refusal of a body carrying a name, in its one sentence. */
const NAME_REFUSAL = {
  code: "party_name_is_written_by_novi",
  status: 400,
  message: LEGAL_BODY_SENTENCES.party_name_is_written_by_novi,
};

// ── POST /formation-party's domain function, on production ────────────────────────────────────

describe("createFormationParty on production", () => {
  test("without a World row: guardian_not_verified 403, and nothing is written", () => {
    expect(
      thrown(() => createFormationParty(prodDeps(), TENANT, { parsed: parsed(BODY) })),
    ).toMatchObject({ code: "guardian_not_verified", status: 403 });
    expect(partyRows()).toBe(0);
  });

  test("a World row and no identity record: guardian_identity_not_verified 403, nothing written", () => {
    human();
    expect(
      thrown(() => createFormationParty(prodDeps(), TENANT, { parsed: parsed(BODY) })),
    ).toMatchObject({ code: "guardian_identity_not_verified", status: 403 });
    expect(partyRows()).toBe(0);
  });

  test("the gates run before the body is read: a body with a name and no World row is refused by the World gate", () => {
    expect(
      thrown(() =>
        createFormationParty(prodDeps(), TENANT, {
          parsed: parsed({ ...BODY, legalFirstName: "Someone" }),
        }),
      ),
    ).toMatchObject({ code: "guardian_not_verified" });
    expect(partyRows()).toBe(0);
  });

  test("with the record, a body carrying either name, whatever its value, is refused 400 party_name_is_written_by_novi", () => {
    verified();
    for (const names of [
      { legalFirstName: "Someone" },
      { legalLastName: "Else" },
      { legalFirstName: NAMES_OF_RECORD.first, legalLastName: NAMES_OF_RECORD.last },
    ])
      expect(
        thrown(() =>
          createFormationParty(prodDeps(), TENANT, { parsed: parsed({ ...BODY, ...names }) }),
        ),
        Object.keys(names).join(","),
      ).toMatchObject(NAME_REFUSAL);
    expect(partyRows()).toBe(0);
  });

  test("without names, the row holds the record's first and last names and the body's other fields", () => {
    verified();
    const partyId = idOf(createFormationParty(prodDeps(), TENANT, { parsed: parsed(BODY) }));
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      legalFirstName: NAMES_OF_RECORD.first,
      legalLastName: NAMES_OF_RECORD.last,
      email: BODY.email,
      phone: BODY.phone,
      line1: BODY.address.line1,
      line2: null,
      city: BODY.address.city,
      region: BODY.address.region,
      postalCode: BODY.address.postalCode,
      country: BODY.address.country,
      synthetic: false,
      companyId: null,
    });
  });

  test("marketingConsent true stores marketing_consent_at, false or absent stores null, and no other table changes", () => {
    verified();
    const before = tableCounts();
    const consented = idOf(
      createFormationParty(prodDeps(), TENANT, {
        parsed: parsed({ ...BODY, marketingConsent: true }),
      }),
    );
    const declined = idOf(
      createFormationParty(prodDeps(), TENANT, {
        parsed: parsed({ ...BODY, marketingConsent: false }),
      }),
    );
    const silent = idOf(createFormationParty(prodDeps(), TENANT, { parsed: parsed(BODY) }));

    expect(consentOf(consented)).toBe(NOW);
    expect(parties.findOwned(TENANT, consented)!.marketingConsentAt).toBe(NOW);
    expect(consentOf(declined)).toBeNull();
    expect(consentOf(silent)).toBeNull();
    // Three party rows, and nothing anywhere else: no outbox row, no event, no contact.
    expect(tableCounts()).toEqual({ ...before, formation_parties: before.formation_parties! + 3 });
  });

  test("a record whose names cannot be read answers 503 identity_unavailable, and nothing is written", () => {
    verified();
    const otherRing: PiiKeyring = {
      current: parsePiiKey(Buffer.alloc(32, 8).toString("base64"), "TEST_KEY"),
    };
    const identity = { ...identityOver(identityRepo, () => NOW), pii: otherRing };
    expect(
      thrown(() => createFormationParty(prodDeps({ identity }), TENANT, { parsed: parsed(BODY) })),
    ).toMatchObject({ code: "identity_unavailable", status: 503 });
    expect(partyRows()).toBe(0);
  });

  test("doola's sandbox pin on the mainnet network is a production door: the gates apply", () => {
    const deps = prodDeps({ pin: { provider: "doola", environment: "sandbox" } });
    expect(
      thrown(() => createFormationParty(deps, TENANT, { parsed: parsed(BODY) })),
    ).toMatchObject({ code: "guardian_not_verified" });
    expect(partyRows()).toBe(0);
  });

  test("the synthetic shortcut is still refused, after the gates", () => {
    verified();
    expect(createFormationParty(prodDeps(), TENANT, { synthetic: true })).toEqual({
      error: syntheticPiiRefusedMessage(),
    });
    expect(partyRows()).toBe(0);
  });
});

// ── PATCH /companies/:id/party's domain function, on production ────────────────────────────────

describe("updateCompanyParty on production", () => {
  test("an unknown or another tenant's company is answered by the ownership check, before the gates", () => {
    const theirs = formedCompanyWithParty(OTHER);
    for (const companyId of ["00000000-0000-4000-8000-000000000000", theirs.companyId])
      expect(updateCompanyParty(prodDeps(), TENANT, companyId, EDIT)).toEqual({
        error: companyUnavailableMessage(),
      });
  });

  test("without a World row: guardian_not_verified 403, and nothing moves", () => {
    const { companyId, partyId } = formedCompanyWithParty();
    expect(thrown(() => updateCompanyParty(prodDeps(), TENANT, companyId, EDIT))).toMatchObject({
      code: "guardian_not_verified",
      status: 403,
    });
    expect(parties.findOwned(TENANT, partyId)!.email).toBe(BODY.email);
  });

  test("a World row and no identity record: guardian_identity_not_verified 403, and nothing moves", () => {
    human();
    const { companyId, partyId } = formedCompanyWithParty();
    expect(thrown(() => updateCompanyParty(prodDeps(), TENANT, companyId, EDIT))).toMatchObject({
      code: "guardian_identity_not_verified",
      status: 403,
    });
    expect(parties.findOwned(TENANT, partyId)!.email).toBe(BODY.email);
  });

  test("with both gates met, the other fields move and the names stay", () => {
    verified();
    const { companyId, partyId } = formedCompanyWithParty();
    expect(updateCompanyParty(prodDeps(), TENANT, companyId, EDIT)).toEqual({ partyId });
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      ...EDIT,
      legalFirstName: NAMES_OF_RECORD.first,
      legalLastName: NAMES_OF_RECORD.last,
    });
  });

  test("the repository's UPDATE never writes the names, even when a caller slips them in", () => {
    const { companyId, partyId } = formedCompanyWithParty();
    const smuggled = { ...EDIT, legalFirstName: "Someone", legalLastName: "Else" };
    expect(parties.update(partyId, TENANT, companyId, smuggled as EditablePartyFields)).toBe(true);
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      email: EDIT.email,
      legalFirstName: NAMES_OF_RECORD.first,
      legalLastName: NAMES_OF_RECORD.last,
    });
  });
});

// ── the sandbox door, unchanged ────────────────────────────────────────────────────────────────

describe("the sandbox door is as before", () => {
  test("the synthetic shortcut stores the labeled fixture with no World deps, and no consent", () => {
    const partyId = idOf(createFormationParty(sandboxDeps(), TENANT, { synthetic: true }));
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      synthetic: true,
      legalFirstName: "Novi Sandbox",
      legalLastName: "Guardian",
      email: `sandbox+${partyId}@novicorpus.com`,
      marketingConsentAt: null,
    });
  });

  test("a real body is still refused, before anything is written", () => {
    expect(
      createFormationParty(sandboxDeps(), TENANT, {
        parsed: parsed({ ...BODY, legalFirstName: "Someone", legalLastName: "Else" }),
      }),
    ).toEqual({ error: syntheticPiiRequiredMessage() });
    expect(updateCompanyParty(sandboxDeps(), TENANT, "any-company", EDIT)).toEqual({
      error: syntheticPiiRequiredMessage(),
    });
    expect(partyRows()).toBe(0);
  });

  test("a sandbox that takes test bodies writes the typed names, never reads the record, needs no World, and stores no consent", () => {
    const deps = sandboxDeps({ sandboxSyntheticPii: false, identity: unreadIdentity() });
    const partyId = idOf(
      createFormationParty(deps, TENANT, {
        parsed: parsed({
          ...BODY,
          legalFirstName: "Someone",
          legalLastName: "Else",
          marketingConsent: true,
        }),
      }),
    );
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      legalFirstName: "Someone",
      legalLastName: "Else",
      email: BODY.email,
      marketingConsentAt: null,
    });
  });

  test("a sandbox that takes test bodies still needs both names", () => {
    const deps = sandboxDeps({ sandboxSyntheticPii: false });
    for (const body of [
      BODY,
      { ...BODY, legalFirstName: "Someone" },
      { ...BODY, legalLastName: "Else" },
    ])
      expect(createFormationParty(deps, TENANT, { parsed: parsed(body) })).toEqual({
        error: partyNamesRequiredMessage(),
      });
    expect(partyRows()).toBe(0);
  });

  test("the edit door on a sandbox that takes test bodies needs no World and keeps the names", () => {
    const deps = sandboxDeps({ sandboxSyntheticPii: false, identity: unreadIdentity() });
    const { companyId, partyId } = formedCompanyWithParty();
    expect(updateCompanyParty(deps, TENANT, companyId, EDIT)).toEqual({ partyId });
    expect(parties.findOwned(TENANT, partyId)).toMatchObject({
      email: EDIT.email,
      legalFirstName: NAMES_OF_RECORD.first,
    });
  });
});

/** Whatever World the deps carry, the sandbox door never asks it. */
test("the sandbox intake never asks World, even when it is wired", () => {
  const world = {
    cfg: { environment: "staging", action: "guardian-verification" },
    store: {
      findByTenant: () => {
        throw new Error("World was asked");
      },
    },
  } as unknown as WorldIdDeps;
  const partyId = idOf(createFormationParty(sandboxDeps({ world }), TENANT, { synthetic: true }));
  expect(parties.findOwned(TENANT, partyId)!.synthetic).toBe(true);
});
