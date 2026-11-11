/**
 * A refused filing says WHICH FIELD doola refused (2026-11-11).
 *
 * On 2026-11-11 a sandbox filing was refused with `E_VALIDATION_FAILED: one or more fields are
 * invalid`, and the company parked correctly, but no log line, step error or view said which
 * field: doola's envelope carries `error.fields`, `DoolaApiError` kept it, and nothing read it.
 * The field was `description`, whose documented maximum is 50 characters, and the purpose was
 * 109.
 *
 * Pinned here, through the real filer, the real park and the real company view:
 *  - a purpose stored before the 50-character limit is SENT AS STORED, never cut, and doola's
 *    refusal parks it (the fake refuses the way doola does: `refuseLikeDoola`);
 *  - the ops lines of the refusal carry doola's per-field reasons (`fieldErrors`);
 *  - the step's stored error, and so the company's event trail, names the field and its code;
 *  - the company view names the field by PATH only, never doola's sentence;
 *  - the owner's edit, held to 50, clears the park and the paths together, and the retry files.
 *
 * Every person, number and name here is an invention.
 */
import type DatabaseType from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type DoolaApi, DoolaApiError } from "../../src/adapters/doola/doolaClient";
import type { CreateCompanyInput } from "../../src/adapters/doola/types";
import { toCompanyDetailView } from "../../src/api/views";
import { businessPurposeTooLongMessage } from "../../src/formation";
import {
  type CreateCompanyDeps,
  createCompany,
  updateCompanyIntake,
  updateCompanyParty,
} from "../../src/formation/company";
import { DEFAULT_INDUSTRY, PURPOSE_MAX_LENGTH } from "../../src/formation/intake";
import { parsePiiKey } from "../../src/formation/pii";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository, parseDetail } from "../../src/persistence/formationRepository";
import { runFormationCreateProvider } from "../../src/workflow/formationProvider";
import {
  ENTITY_KEY,
  FAKE_DESCRIPTION_TOO_LONG_CODE,
  formedEntity,
  refuseLikeDoola,
} from "../helpers/formationFakes";

const TENANT = "0x000000000000000000000000000000000000000A";
const RING = { current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY") };
/** A purpose of the length that parked the real filing (109 characters), stored before the limit. */
const LONG_PURPOSE =
  "Operates autonomous software agents that research, draft and send proposals for the owner's design workshops.";
const SHORT_PURPOSE = "Operates autonomous software agents.";
const NINE_DIGITS = "123456789";
const PARTY_PHONE = "+12125550100";

let db: DatabaseType.Database;
let companies: SqliteCompanyRepository;
let parties: SqliteFormationPartyRepository;
let requests: SqliteFormationRepository;
let repo: SqliteEntityRepository;
let stdout: string[];

const printed = () => stdout.filter((l) => l.includes('"opslog"')).map((l) => JSON.parse(l));
const line = (event: string) => printed().find((l) => l.opslog === event);

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  requests = new SqliteFormationRepository(db);
  repo = new SqliteEntityRepository(db);
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function deps(): CreateCompanyDeps {
  return {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 10,
    dailyCeiling: 100,
    pii: RING,
    transaction: (fn) => db.transaction(fn)(),
  };
}

/** A company the door minted, with an agent attached so the event trail has somewhere to go. */
function mint(): string {
  const r = createCompany(deps(), TENANT, {
    partyId: parties.create({
      tenantId: TENANT,
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      email: "ada@example.com",
      phone: PARTY_PHONE,
      line1: "1 Analytical Way",
      line2: null,
      city: "Cheyenne",
      region: "WY",
      postalCode: "82001",
      country: "USA",
      synthetic: false,
    }),
    names: ["Acme One", "Acme Two", "Acme Three"],
    businessPurpose: SHORT_PURPOSE,
    industryLabel: DEFAULT_INDUSTRY,
  });
  if ("error" in r) throw new Error(r.error);
  repo.upsert(formedEntity({ ownerTenantId: TENANT, companyId: r.companyId }));
  return r.companyId;
}

/** A company stored BEFORE the limit: the door of the day took 500, so the row holds 109. */
function storedBeforeTheLimit(companyId: string): void {
  db.prepare("UPDATE companies SET business_purpose = ? WHERE company_id = ?").run(
    LONG_PURPOSE,
    companyId,
  );
}

/** A doola that holds the create body to its documented limit, and files anything else. */
function doolaAsDocumented(
  over: Partial<DoolaApi> = {},
): DoolaApi & { bodies: CreateCompanyInput[] } {
  const bodies: CreateCompanyInput[] = [];
  return {
    createCustomer: async () => ({ doolaCustomerId: "cus_1" }),
    createCompany: async (input: CreateCompanyInput) => {
      bodies.push(input);
      refuseLikeDoola(input);
      return { doolaCompanyId: "cmp_1", formationSubmissionStatus: "SUBMITTED" };
    },
    getCompany: async () => ({ doolaCompanyId: "cmp_1" }),
    listCompanies: async () => [],
    listDocuments: async () => [],
    getDocumentDownloadUrl: async () => ({ id: "d", downloadUrl: "https://x" }),
    listRequiredActions: async () => [],
    getComplianceCalendar: async () => [],
    listNaicsCodes: async () => [],
    playgroundCompleteFormation: async () => undefined,
    playgroundCompleteEin: async () => undefined,
    ...over,
    bodies,
  } as unknown as DoolaApi & { bodies: CreateCompanyInput[] };
}

function file(companyId: string, doola: DoolaApi): Promise<void> {
  return runFormationCreateProvider({
    company: companies.find(companyId)!,
    companies,
    repo,
    requests,
    parties,
    doola,
    environment: "sandbox",
    pii: RING,
  });
}

function view(companyId: string) {
  return toCompanyDetailView(
    { companies, formationSteps: (id) => requests.stepsOf(id), repo, formation: { parties } },
    companies.find(companyId)!,
  );
}

const rowOf = (companyId: string) => requests.find(companyId, "create_provider")!;
const detailOf = (companyId: string) =>
  parseDetail<{
    awaitingIntakeEdit?: boolean;
    awaitingPartyEdit?: boolean;
    refusedFields?: string[];
  }>(rowOf(companyId).detail);

const DESCRIPTION_REFUSAL = {
  field: "description",
  code: FAKE_DESCRIPTION_TOO_LONG_CODE,
  message: "size must be between 1 and 50",
};

test("a purpose stored before the limit is SENT AS STORED, and doola's refusal names the field everywhere", async () => {
  const companyId = mint();
  storedBeforeTheLimit(companyId);
  const doola = doolaAsDocumented();
  await file(companyId, doola);

  // Never cut at send time: a legal description nobody wrote is not one we file.
  expect(doola.bodies).toHaveLength(1);
  expect(doola.bodies[0]!.description).toBe(LONG_PURPOSE);
  expect(LONG_PURPOSE).toHaveLength(109);
  expect(LONG_PURPOSE.length).toBeGreaterThan(PURPOSE_MAX_LENGTH);

  // Parked for the owner, exactly as any rejection is.
  const row = rowOf(companyId);
  expect(row.state).toBe("failed");
  expect(detailOf(companyId).awaitingIntakeEdit).toBe(true);

  // THE STEP'S ERROR names the field and doola's code for it: the company's history says which.
  const named = `E_VALIDATION_FAILED: one or more fields are invalid (description: ${FAKE_DESCRIPTION_TOO_LONG_CODE})`;
  expect(row.error).toBe(named);
  expect(
    repo.listEvents(ENTITY_KEY).some((e) => e.detail === `formation create failed: ${named}`),
  ).toBe(true);

  // THE OPS LINES carry doola's own per-field reason, and the request id doola's support asks for.
  expect(line("formation_create_failed")).toMatchObject({
    companyId,
    code: "E_VALIDATION_FAILED",
    requestId: "req-fake-validation",
    fieldErrors: [DESCRIPTION_REFUSAL],
  });
  expect(line("formation_stale")).toMatchObject({
    companyId,
    severity: "CRITICAL",
    reason: "create_rejected_awaiting_intake_edit",
    message: named,
    fieldErrors: [DESCRIPTION_REFUSAL],
  });

  // THE VIEW names it by PATH, and carries none of doola's sentence.
  const v = view(companyId);
  expect(v.park).toEqual({
    awaitingIntakeEdit: true,
    awaitingPartyEdit: false,
    awaitingSsnDecision: false,
    refusedFields: ["description"],
  });
  expect(JSON.stringify(v)).not.toContain("size must be between");
});

test("the owner's edit is held to 50, clears the park and its fields together, and the retry files", async () => {
  const companyId = mint();
  storedBeforeTheLimit(companyId);
  const doola = doolaAsDocumented();
  await file(companyId, doola);
  expect(detailOf(companyId).refusedFields).toEqual(["description"]);

  const edit = (businessPurpose: string) =>
    updateCompanyIntake(deps(), TENANT, companyId, {
      names: ["Acme One", "Acme Two", "Acme Three"],
      businessPurpose,
      industryLabel: DEFAULT_INDUSTRY,
    });

  // The edit door refuses what doola would refuse, in its own sentence, and moves nothing.
  expect(edit("x".repeat(PURPOSE_MAX_LENGTH + 1))).toEqual({
    error: businessPurposeTooLongMessage(PURPOSE_MAX_LENGTH),
  });
  expect(detailOf(companyId).awaitingIntakeEdit).toBe(true);
  expect(view(companyId).park.refusedFields).toEqual(["description"]);

  // A purpose that fits re-arms ONE retry; the paths leave with the flag they describe.
  expect(edit(SHORT_PURPOSE)).toEqual({ companyId });
  expect(detailOf(companyId).awaitingIntakeEdit).toBeUndefined();
  expect(detailOf(companyId).refusedFields).toBeUndefined();
  expect(view(companyId).park.refusedFields).toEqual([]);
  // The operator trail keeps naming what doola refused.
  expect(rowOf(companyId).error).toContain("(description: ");

  await file(companyId, doola);
  expect(doola.bodies).toHaveLength(2);
  expect(doola.bodies[1]!.description).toBe(SHORT_PURPOSE);
  expect(rowOf(companyId).state).toBe("confirmed");
  expect(rowOf(companyId).providerRef).toBe("cmp_1");
});

test("a refused PARTY names its field by path and code only: no doola message, no value, anywhere", async () => {
  const companyId = mint();
  const doola = doolaAsDocumented({
    createCustomer: async () => {
      throw new DoolaApiError(
        "E_VALIDATION_FAILED",
        400,
        "one or more fields are invalid",
        "req_p",
        {
          phoneNumber: {
            code: "E_INVALID_PHONE",
            // doola's sentence quoting the person's own data: never kept for the person's body.
            message: `${PARTY_PHONE} (ref ${NINE_DIGITS}) is not a phone number`,
            // doola echoing the submitted value back: never read, never repeated.
            value: PARTY_PHONE,
          },
        },
      );
    },
  });
  await file(companyId, doola);

  expect(detailOf(companyId).awaitingPartyEdit).toBe(true);
  expect(rowOf(companyId).error).toBe(
    "E_VALIDATION_FAILED: one or more fields are invalid (phoneNumber: E_INVALID_PHONE)",
  );
  expect(line("formation_party_rejected")).toMatchObject({
    companyId,
    reason: "customer_rejected_awaiting_party_edit",
  });
  // Path and code, and NO message: the customer body is the person.
  expect(line("formation_party_rejected")!.fieldErrors).toEqual([
    { field: "phoneNumber", code: "E_INVALID_PHONE" },
  ]);
  expect(line("formation_create_failed")!.fieldErrors).toEqual([
    { field: "phoneNumber", code: "E_INVALID_PHONE" },
  ]);
  // Nothing printed carries doola's sentence, the nine-digit run or the value doola echoed.
  for (const l of stdout) {
    expect(l).not.toContain("is not a phone number");
    expect(l).not.toContain(NINE_DIGITS);
    expect(l).not.toContain(PARTY_PHONE);
  }
  expect(rowOf(companyId).error).not.toContain(PARTY_PHONE);

  expect(view(companyId).park).toMatchObject({
    awaitingPartyEdit: true,
    awaitingIntakeEdit: false,
    refusedFields: ["phoneNumber"],
  });

  // The party door's edit clears this park and its fields, exactly as the intake door does its own.
  expect(
    updateCompanyParty(
      {
        companies,
        parties,
        requests,
        sandboxSyntheticPii: false,
        pin: { provider: "doola", environment: "sandbox" },
        transaction: (fn) => db.transaction(fn)(),
      },
      TENANT,
      companyId,
      {
        email: "grace@example.com",
        phone: "+13075550142",
        line1: "30 N Gould St",
        line2: null,
        city: "Sheridan",
        region: "WY",
        postalCode: "82801",
        country: "USA",
      },
    ),
  ).toHaveProperty("partyId");
  expect(view(companyId).park).toMatchObject({ awaitingPartyEdit: false, refusedFields: [] });
});

test("a refused COMPANY body keeps doola's message for its own fields and drops it for the person's", async () => {
  const companyId = mint();
  await file(
    companyId,
    doolaAsDocumented({
      createCompany: async () => {
        throw new DoolaApiError(
          "E_VALIDATION_FAILED",
          400,
          "one or more fields are invalid",
          "req_c",
          {
            description: { code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
            "responsibleParty.email": {
              code: "E_EMAIL",
              message: "ada@example.com is not a valid email",
            },
            "members[0].legalLastName": {
              code: "E_NAME",
              message: "Lovelace contains invalid characters",
            },
          },
        );
      },
    }),
  );
  const kept = [
    { field: "description", code: "E_FIELD_TOO_LONG", message: "size must be between 1 and 50" },
    { field: "responsibleParty.email", code: "E_EMAIL" },
    { field: "members[0].legalLastName", code: "E_NAME" },
  ];
  expect(line("formation_stale")!.fieldErrors).toEqual(kept);
  expect(line("formation_create_failed")!.fieldErrors).toEqual(kept);
  for (const l of stdout) {
    expect(l).not.toContain("ada@example.com");
    expect(l).not.toContain("Lovelace contains");
  }
  // The view, as ever, names the three by path and nothing else.
  expect(view(companyId).park.refusedFields).toEqual([
    "description",
    "responsibleParty.email",
    "members[0].legalLastName",
  ]);
});

test("a refusal that names NO field still parks, and adds no field keys anywhere", async () => {
  const companyId = mint();
  await file(
    companyId,
    doolaAsDocumented({
      createCompany: async () => {
        throw new DoolaApiError("E_VALIDATION_FAILED", 400, "name is not filable", "req_n");
      },
    }),
  );
  expect(detailOf(companyId).awaitingIntakeEdit).toBe(true);
  expect("refusedFields" in detailOf(companyId)).toBe(false);
  expect(rowOf(companyId).error).toBe("E_VALIDATION_FAILED: name is not filable");
  expect(line("formation_stale")).not.toHaveProperty("fieldErrors");
  expect(line("formation_create_failed")).not.toHaveProperty("fieldErrors");
  expect(view(companyId).park.refusedFields).toEqual([]);
});
