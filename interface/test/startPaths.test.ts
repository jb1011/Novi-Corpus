import { describe, expect, test } from "vitest";
import {
  fullProductGate,
  fullProductHref,
  isTestDeployment,
  landingPaths,
  parsePathParam,
  pathCards,
  pathFacts,
  preselectedPath,
  startContinue,
  startDestination,
} from "@/lib/start/paths";
import type { LegalBodyMemory } from "@/lib/legalBody/storage";
import { START_COPY } from "@/lib/start/copy";
import { ONBOARDING_STEP_COUNT } from "@/components/landing/copy";
import { buildPersistedOnboarding } from "@/lib/onboarding/storage";
import { emptyConfig, emptySession, type Phase } from "@/components/onboarding/types";
import type { Address, EntityView, PublicConfig } from "@/lib/api/types";

describe("whether the full product is offered", () => {
  test("only an explicit answer decides", () => {
    expect(fullProductGate({ fullProductAvailable: true })).toBe("offered");
    expect(fullProductGate({ fullProductAvailable: false })).toBe("not_offered");
    expect(fullProductGate({})).toBe("unknown");
    expect(fullProductGate(undefined)).toBe("unknown");
  });
});

/** A legal-body config that offers both doors on testnet, with the fields a case changes. */
const lb = (over: object) =>
  ({ available: true, declarations: true, environment: "sandbox", formedDoor: "offered", ...over }) as never;

/** The two fields every `/config` carries, so a case states only what it is about. */
const base: PublicConfig = { walletProviderDefault: "circle", circleCustodyAvailable: true };

describe("pathCards", () => {
  test("testnet today: three cards in order", () => {
    expect(pathCards({ fullProductAvailable: true, legalBodies: lb({}) })).toEqual([
      { id: "form", state: "offered" }, { id: "declare", state: "offered" }, { id: "full", state: "offered" },
    ]);
  });
  test("mainnet before invitations: the declared path alone", () => {
    expect(pathCards({ fullProductAvailable: false, legalBodies: lb({ environment: "production", formedDoor: "hidden" }) }))
      .toEqual([{ id: "declare", state: "offered" }]);
  });
  test("places all taken: the form card stays, full up", () => {
    expect(pathCards({ legalBodies: lb({ formedDoor: "cap_reached" }) })[0]).toEqual({ id: "form", state: "full_up" });
  });
  test("an older backend and no config offer no full product", () => {
    expect(pathCards({ legalBodies: lb({}) }).some((c) => c.id === "full")).toBe(false);
    expect(pathCards(null)).toEqual([]);
  });
  test("an absent formed door is no form card; declarations off is no declare card", () => {
    expect(pathCards({ legalBodies: lb({ formedDoor: undefined, declarations: false }) })).toEqual([]);
  });
  test("legal bodies not available: no legal-body card, whatever else is set", () => {
    expect(pathCards({ fullProductAvailable: true, legalBodies: { available: false } })).toEqual([
      { id: "full", state: "offered" },
    ]);
    expect(pathCards(undefined)).toEqual([]);
    expect(pathCards({})).toEqual([]);
  });
});

describe("landingPaths", () => {
  test("the home page without a config shows the two legal-body paths", () => {
    expect(landingPaths(null).map((c) => c.id)).toEqual(["form", "declare"]);
  });
  test("both are offered without a config, and a config decides once it is there", () => {
    expect(landingPaths(null)).toEqual([
      { id: "form", state: "offered" }, { id: "declare", state: "offered" },
    ]);
    const config: PublicConfig = { ...base, fullProductAvailable: false, legalBodies: lb({ formedDoor: "cap_reached" }) };
    expect(landingPaths(config)).toEqual(pathCards(config));
    expect(landingPaths({ ...base })).toEqual([]);
  });
});

describe("preselectedPath", () => {
  test("a path that is full up is never preselected", () => {
    const cards = pathCards({ legalBodies: lb({ formedDoor: "cap_reached" }) });
    expect(preselectedPath(cards, "form")).toBe("declare");
    expect(preselectedPath([], "form")).toBeNull();
  });
  test("the wanted path when it is offered, else the first offered one", () => {
    const cards = pathCards({ fullProductAvailable: true, legalBodies: lb({}) });
    expect(preselectedPath(cards, "full")).toBe("full");
    expect(preselectedPath(cards, "declare")).toBe("declare");
    expect(preselectedPath(cards, null)).toBe("form");
    expect(preselectedPath([{ id: "declare", state: "offered" }], "form")).toBe("declare");
    expect(preselectedPath([{ id: "form", state: "full_up" }], null)).toBeNull();
  });
});

describe("parsePathParam", () => {
  test("only the three names parse", () => {
    expect(parsePathParam("form")).toBe("form");
    expect(parsePathParam("Form")).toBeNull();
    expect(parsePathParam("<script>")).toBeNull();
    expect(parsePathParam(null)).toBeNull();
  });
  test("each of the three, and nothing near them", () => {
    expect(parsePathParam("declare")).toBe("declare");
    expect(parsePathParam("full")).toBe("full");
    expect(parsePathParam("")).toBeNull();
    expect(parsePathParam(" form")).toBeNull();
    expect(parsePathParam("form ")).toBeNull();
    expect(parsePathParam("toString")).toBeNull();
    expect(parsePathParam("__proto__")).toBeNull();
  });
});

describe("isTestDeployment", () => {
  test("production, absent and null are not a test deployment", () => {
    expect(isTestDeployment(null)).toBe(false);
    expect(isTestDeployment({ ...base })).toBe(false);
    expect(isTestDeployment({ ...base, legalBodies: lb({ environment: "production" }) })).toBe(false);
    expect(isTestDeployment({ ...base, formationEnvironment: "production" })).toBe(false);
    expect(isTestDeployment({ ...base, formationEnvironment: null })).toBe(false);
    expect(isTestDeployment({ ...base, legalBodies: { available: false } })).toBe(false);
  });
  test("either sandbox value is a test deployment", () => {
    expect(isTestDeployment({ ...base, legalBodies: lb({ environment: "sandbox" }) })).toBe(true);
    expect(isTestDeployment({ ...base, formationEnvironment: "sandbox" })).toBe(true);
    expect(
      isTestDeployment({ ...base, legalBodies: lb({ environment: "production" }), formationEnvironment: "sandbox" }),
    ).toBe(true);
  });
  test("a sandbox environment on a legal-body config that is not available does not count", () => {
    const unavailable = { available: false, environment: "sandbox" } as never;
    expect(isTestDeployment({ ...base, legalBodies: unavailable })).toBe(false);
  });
});

describe("fullProductHref", () => {
  const stored = (phase: Phase, entity: EntityView | null = null) =>
    buildPersistedOnboarding({
      phase,
      config: emptyConfig(),
      done: {},
      session: { ...emptySession(), entity },
    });

  test("nothing stored, a finished wizard or one on its first phase start a new one", () => {
    expect(fullProductHref(null)).toBe("/onboarding?new=1");
    expect(fullProductHref(stored("dashboard"))).toBe("/onboarding?new=1");
    expect(fullProductHref(stored("fund", { status: "funded" } as EntityView))).toBe("/onboarding?new=1");
    expect(fullProductHref(stored("welcome"))).toBe("/onboarding?new=1");
  });
  test("a wizard on a later phase is resumed", () => {
    expect(fullProductHref(stored("guardian"))).toBe("/onboarding");
    expect(fullProductHref(stored("configure"))).toBe("/onboarding");
  });
});

describe("startContinue: the one write the start makes, on Continue", () => {
  const TENANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
  const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
  const wizard = (phase: Phase) =>
    buildPersistedOnboarding({ phase, config: emptyConfig(), done: {}, session: emptySession() });
  const memory = (over: Partial<LegalBodyMemory> = {}): LegalBodyMemory => ({
    tenant: TENANT,
    companyId: null,
    orderId: null,
    ownerChoice: null,
    agentId: null,
    door: null,
    startAnother: null,
    ...over,
  });
  const companies = [{ companyId: "co_1" }, { companyId: "co_2" }];

  test.each(["form", "declare"] as const)(
    "the %s path hands a new company over through the memory and opens the legal-body flow",
    (path) => {
      expect(startContinue({ path, tenant: TENANT, stored: null, companies, wizard: null })).toEqual({
        write: memory({ door: path, startAnother: { kind: "another-company", known: ["co_1", "co_2"] } }),
        href: "/legal-body",
      });
    },
  );

  test("over this account's memory: the door and the companies there are, the rest kept", () => {
    const stored = memory({ companyId: "co_1", orderId: "ord_1", ownerChoice: "elsewhere", agentId: "7" });
    expect(startContinue({ path: "form", tenant: TENANT, stored, companies: [], wizard: null })?.write).toEqual(
      memory({
        companyId: "co_1",
        orderId: "ord_1",
        ownerChoice: "elsewhere",
        agentId: "7",
        door: "form",
        startAnother: { kind: "another-company", known: [] },
      }),
    );
  });

  test("always for the session's account", () => {
    const theirs = memory({ tenant: OTHER, companyId: "co_9" });
    expect(startContinue({ path: "declare", tenant: TENANT, stored: theirs, companies, wizard: null })?.write?.tenant).toBe(
      TENANT,
    );
  });

  test("a legal-body path before the companies list is read does nothing: there is nothing to hand over yet", () => {
    for (const path of ["form", "declare"] as const)
      expect(startContinue({ path, tenant: TENANT, stored: memory(), companies: undefined, wizard: null })).toBeNull();
  });

  test("the full product writes nothing and opens the wizard where it was left, with or without the list", () => {
    for (const list of [companies, undefined]) {
      expect(startContinue({ path: "full", tenant: TENANT, stored: memory(), companies: list, wizard: null })).toEqual({
        write: null,
        href: "/onboarding?new=1",
      });
      expect(
        startContinue({ path: "full", tenant: TENANT, stored: null, companies: list, wizard: wizard("guardian") }),
      ).toEqual({ write: null, href: "/onboarding" });
    }
  });
});

describe("startDestination", () => {
  test("the start never guesses", () => {
    expect(startDestination({ status: "error", config: undefined })).toEqual({ kind: "error" });
    expect(startDestination({ status: "loading", config: undefined })).toEqual({ kind: "loading" });
    expect(startDestination({ status: "ready", config: { fullProductAvailable: true } as never })).toEqual({ kind: "full_only" });
    expect(startDestination({ status: "ready", config: {} as never })).toEqual({ kind: "none" });
  });
  test("a form or declare card is a choice among all the cards", () => {
    const all: PublicConfig = { ...base, fullProductAvailable: true, legalBodies: lb({}) };
    expect(startDestination({ status: "ready", config: all })).toEqual({ kind: "choice", cards: pathCards(all) });
    const fullUp: PublicConfig = { ...base, legalBodies: lb({ formedDoor: "cap_reached", declarations: false }) };
    expect(startDestination({ status: "ready", config: fullUp })).toEqual({
      kind: "choice",
      cards: [{ id: "form", state: "full_up" }],
    });
  });
  test("a config held while loading or after an error still decides nothing", () => {
    const all: PublicConfig = { ...base, fullProductAvailable: true, legalBodies: lb({}) };
    expect(startDestination({ status: "loading", config: all })).toEqual({ kind: "loading" });
    expect(startDestination({ status: "error", config: all })).toEqual({ kind: "error" });
    expect(startDestination({ status: "ready", config: undefined })).toEqual({ kind: "none" });
  });
});

describe("pathFacts", () => {
  test("testnet: a sandbox legal-body config, its filing estimate and the wizard's step count", () => {
    const testnet: PublicConfig = {
      ...base,
      formationFeeUsdc: 399,
      legalBodies: lb({ filingWorkingDays: 5, paymentRequired: false }),
    };
    expect(pathFacts(testnet)).toEqual({
      environment: "sandbox",
      filingWorkingDays: 5,
      paymentRequired: false,
      formationFeeUsdc: 399,
      stepCount: ONBOARDING_STEP_COUNT,
    });
  });
  test("a payment is owed only on the legal-body flag, with the fee the server serves", () => {
    const paid: PublicConfig = {
      ...base,
      formationFeeUsdc: 399,
      legalBodies: lb({ environment: "production", filingWorkingDays: 7, paymentRequired: true }),
    };
    expect(pathFacts(paid)).toMatchObject({
      environment: "production",
      filingWorkingDays: 7,
      paymentRequired: true,
      formationFeeUsdc: 399,
    });
  });
  test("the wizard's payment flag is not the legal-body flow's", () => {
    expect(pathFacts({ ...base, formationPaymentRequired: true, legalBodies: lb({}) }).paymentRequired).toBe(false);
    expect(
      pathFacts({ ...base, formationPaymentRequired: false, legalBodies: lb({ paymentRequired: true }) })
        .paymentRequired,
    ).toBe(true);
  });
  test("nothing said is the smaller truth: production, no estimate, no payment, no fee", () => {
    const smaller = {
      environment: "production",
      filingWorkingDays: null,
      paymentRequired: false,
      formationFeeUsdc: null,
      stepCount: ONBOARDING_STEP_COUNT,
    };
    expect(pathFacts(undefined)).toEqual(smaller);
    expect(pathFacts(base)).toEqual(smaller);
    expect(pathFacts({ ...base, legalBodies: { available: false } })).toEqual(smaller);
    expect(pathFacts({ ...base, legalBodies: lb({ filingWorkingDays: undefined }) }).filingWorkingDays).toBeNull();
  });
  test("only the legal-body config says sandbox: a sandbox formation alone does not", () => {
    expect(pathFacts({ ...base, formationEnvironment: "sandbox" }).environment).toBe("production");
  });
});

/** Every string reachable from a value, depth first. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

const ALL_START_COPY = stringsOf(START_COPY);

describe("the claims ceiling of the start", () => {
  test("the walk reaches a real number of sentences", () => {
    // A guard that walks nothing passes vacuously.
    expect(ALL_START_COPY.length).toBeGreaterThan(20);
    for (const s of ALL_START_COPY) expect(s.trim().length).toBeGreaterThan(0);
  });

  test("no sentence says free: the money sentence says there is no payment", () => {
    for (const s of ALL_START_COPY) expect(s).not.toMatch(/\bfree\b/i);
  });

  test("no sentence carries an em dash", () => {
    for (const s of ALL_START_COPY) expect(s).not.toContain("\u2014");
  });
});

describe("the choice screen's words", () => {
  test("no sentence says our agents", () => {
    for (const s of ALL_START_COPY) expect(s.toLowerCase()).not.toContain("our agents");
  });
  test("testnet says there is no payment on both legal-body cards", () => {
    expect(START_COPY.cards.form.noPayment).toBe("No payment on testnet");
    expect(START_COPY.cards.declare.noPayment).toBe("No payment on testnet");
  });
  test("each card names its company the way it was decided", () => {
    expect(START_COPY.cards.form.body).toContain("Wyoming company");
    expect(START_COPY.cards.declare.body).toContain("Wyoming LLC or DAO LLC");
    expect(START_COPY.cards.full.body).toContain("{count} steps.");
  });
});
