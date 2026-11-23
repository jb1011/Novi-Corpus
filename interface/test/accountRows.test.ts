/**
 * "My agents": the legal bodies of the account, beside the agents with a treasury.
 *
 * One row per legal body the account can still do something with or open: a live order (in
 * progress, or needing attention when its pointer was cleared), a linked body, another finished
 * body (needing attention), and a company the flow can continue from that has no live and no
 * linked order (needing attention when its filing or its check failed). Each row links into the legal-body flow by its order or its company. Rows that
 * are not linked come first, then the newest; the public standing is read for the first five
 * linked rows only, because the public read is rate limited. A live order of another deployment
 * (another chain or factory) needs attention and is opened, never continued: the flow opens it as
 * closed.
 *
 * The section reads the orders and the companies: a 403 (an account the real-human check does
 * not accept) and a deployment that says it has no legal bodies show no section; any other error
 * shows one line with a retry. The page shows the treasury section where the person has such
 * agents, where the deployment says it offers the full product, or wherever their list could not
 * be read (one line with a retry), and the empty card only when both lists are known to be empty.
 * On a sandbox deployment a row's standing carries the record's sandbox pill. A linked row whose
 * record was read and still names its order's guardian's own wallet, or none, says "Agent's wallet
 * not set" beside its standing (a revoked body never does). Every view is built from one fixed
 * `NOW`: nothing here reads a clock.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApiError,
  type CompanyView,
  type EntityView,
  type LegalBodyByAgent,
  type LegalBodyConfig,
  type LegalBodyOrderView,
  type LegalBodyStatementJson,
} from "@/lib/api/types";
import type { PublicRead } from "@/lib/api/legalBodyClient";

const byAgent = vi.hoisted(() => ({
  calls: [] as { agentId: string | null | undefined; enabled: boolean }[],
  data: undefined as PublicRead<LegalBodyByAgent> | undefined,
  config: null as LegalBodyConfig | null,
}));

vi.mock("@/lib/api/legalBodyHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/legalBodyHooks")>()),
  useLegalBodyByAgentQuery: (agentId: string | null | undefined, enabled: boolean) => {
    byAgent.calls.push({ agentId, enabled });
    return { data: byAgent.data, isPending: byAgent.data === undefined };
  },
  useLegalBodyConfig: () =>
    byAgent.config === null
      ? { status: "loading", config: null }
      : { status: "ready", config: byAgent.config },
}));

afterEach(() => {
  byAgent.calls = [];
  byAgent.data = undefined;
  byAgent.config = null;
});

import { LegalBodiesSection } from "@/components/agents/LegalBodiesSection";
import {
  STANDING_READS,
  accountLegalBodyRows,
  agentsPageView,
  legalBodiesView,
  rowGuardians,
  type AccountRow,
  type LegalBodiesView,
} from "@/lib/legalBody/accountRows";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

const A = LEGAL_BODY_COPY.account;
const C = LEGAL_BODY_COPY.chooser;

/** The public testnet factory, and anvil's first published test account. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const BODY = "0x00000000000000000000000000000000000b0d1e" as const;
const CHAIN = 5042002;

/** The one clock of this file. */
const NOW = Date.parse("2026-10-12T12:00:00Z");
const NOW_S = NOW / 1000;
const HOUR = 3_600_000;
/** As the API serves `createdAt`: ISO 8601 in UTC, whole seconds, marked with a `Z`. */
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A customer's own company on sandbox, its check passed. */
const company = (companyId: string, over: Partial<CompanyView> = {}): CompanyView => ({
  companyId,
  environment: "sandbox",
  nameOptions: [{ name: "Example Test Holdings LLC", entityTypeEnding: "", position: 1 }],
  legalNameFiled: null,
  businessPurpose: "An existing company",
  industryLabel: "An existing company",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: NOW - 2 * HOUR,
  provider: "customer",
  declared: {
    companyName: "Example Test Holdings LLC",
    filingNumber: "TEST-0001",
    wordingVersion: "1",
  },
  verification: { state: "verified", checkedAt: NOW_S - 60, reasonCode: null },
  ...over,
});

/** A company Novi Corpus forms through doola, still filing, with no name filed yet. */
const formed = (companyId: string, over: Partial<CompanyView> = {}): CompanyView =>
  company(companyId, {
    provider: "doola",
    purpose: "legal_body",
    state: "in_progress",
    nameOptions: [{ name: "First Choice Agent LLC", entityTypeEnding: "LLC", position: 1 }],
    declared: undefined,
    verification: undefined,
    ...over,
  });

/** An order view: a live draft an hour old, unless the overrides say otherwise. */
const order = (
  id: string,
  companyId: string,
  over: Partial<LegalBodyOrderView> = {},
): LegalBodyOrderView => ({
  id,
  publicId: `pub_${id}`,
  companyId,
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"ab".repeat(32)}`, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: iso(NOW - HOUR),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

/** A linked body on identity `agentId`, created `hoursAgo` hours before `NOW`. */
const linked = (id: string, companyId: string, agentId: string | null, hoursAgo = 1) =>
  order(id, companyId, {
    state: "linked",
    agentId,
    identityOwner: GUARDIAN,
    bodyAddress: BODY,
    deployedAt: NOW_S - 120,
    pointerSeenAt: NOW_S - 60,
    createdAt: iso(NOW - hoursAgo * HOUR),
  });

/** This deployment: the chain and factory every order above is made under. */
const WHERE = { chainId: CHAIN, factory: FACTORY };
/** Another guardian's wallet: anvil's third published account. */
const OTHER_GUARDIAN = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const OTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;

const rows = (companies: CompanyView[], orders: LegalBodyOrderView[]) =>
  accountLegalBodyRows({ companies, orders, nowMs: NOW, where: WHERE });

describe("the exact values", () => {
  test("the standing is read for five linked rows at most", () => {
    expect(STANDING_READS).toBe(5);
  });

  test("the account copy, word for word", () => {
    expect(A).toEqual({
      legalBodies: "Legal bodies",
      treasuryAgents: "Agents with a treasury",
      add: "Add",
      states: { in_progress: "In progress", linked: "Linked", attention: "Needs attention" },
      actions: { continue: "Continue", open: "Open" },
      agent: "agent #{agentId}",
      unreadable: "Your legal bodies could not be read.",
      emptyTitle: "Nothing here yet",
      emptyBody: "Give your agent a legal body.",
      getStarted: "Get started",
      treasuryNone: "No agent with a treasury yet.",
      treasuryUnreadable: "Your agents with a treasury could not be read.",
      walletOwed: "Agent's wallet not set",
    });
  });
});

describe("accountLegalBodyRows: which orders and companies make a row", () => {
  test("a draft within its 24 hours is in progress, to continue, by its order", () => {
    expect(rows([company("co_a")], [order("ord_1", "co_a")])).toEqual<AccountRow[]>([
      {
        key: "order:ord_1",
        href: "/legal-body?order=ord_1",
        title: "Example Test Holdings LLC",
        agentId: null,
        state: "in_progress",
        action: "continue",
        standing: false,
      },
    ]);
  });

  test("a linked order is linked, to open, with its identity", () => {
    expect(rows([company("co_a")], [linked("ord_1", "co_a", "897126")])).toEqual<AccountRow[]>([
      {
        key: "order:ord_1",
        href: "/legal-body?order=ord_1",
        title: "Example Test Holdings LLC",
        agentId: "897126",
        state: "linked",
        action: "open",
        standing: true,
      },
    ]);
  });

  test("an abandoned order and an expired draft have no row", () => {
    const expired = order("ord_old", "co_a", { createdAt: iso(NOW - 25 * HOUR) });
    const abandoned = order("ord_gone", "co_a", { state: "abandoned" });
    // The company has neither a live nor a linked order, so it is its own row.
    expect(rows([company("co_a")], [expired, abandoned]).map((r) => r.key)).toEqual([
      "company:co_a",
    ]);
  });

  test("lapsed, superseded, revoked drafts and replaced bodies have no row", () => {
    const orders = [
      order("ord_l", "co_a", { state: "lapsed", lapseReason: "deadline_passed" }),
      order("ord_s", "co_a", { state: "superseded", supersededBy: "ord_x" }),
      order("ord_r", "co_a", { revoked: true }),
      order("ord_p", "co_a", { ...linked("ord_p", "co_a", "7"), state: "broken", brokenReason: "replaced" }),
    ];
    expect(rows([company("co_a")], orders).map((r) => r.key)).toEqual(["company:co_a"]);
  });

  test("a reserved and a deployed body are in progress", () => {
    const r = rows(
      [company("co_a")],
      [
        order("ord_r", "co_a", { state: "reserved", agentId: "1", createdAt: iso(NOW - HOUR) }),
        order("ord_d", "co_a", { state: "deployed", agentId: "2", createdAt: iso(NOW - 2 * HOUR) }),
      ],
    );
    expect(r.map((x) => [x.key, x.state, x.action])).toEqual([
      ["order:ord_r", "in_progress", "continue"],
      ["order:ord_d", "in_progress", "continue"],
    ]);
  });

  test("a body whose pointer was cleared needs attention and continues", () => {
    const cleared = { ...linked("ord_1", "co_a", "42"), state: "broken" as const, brokenReason: "not_linked" as const };
    expect(rows([company("co_a")], [cleared])[0]).toMatchObject({
      state: "attention",
      action: "continue",
      standing: false,
    });
  });

  test("another finished body needs attention and opens", () => {
    for (const brokenReason of ["winding_down", "dissolved", null] as const) {
      const finished = { ...linked("ord_1", "co_a", "42"), state: "broken" as const, brokenReason };
      // The company has no live and no linked order, so, as in the flow, it can take a new one.
      expect(rows([company("co_a")], [finished])).toEqual([
        expect.objectContaining({ key: "order:ord_1", state: "attention", action: "open", standing: false }),
        expect.objectContaining({ key: "company:co_a", state: "in_progress", action: "continue" }),
      ]);
    }
    const revokedCleared = {
      ...linked("ord_1", "co_a", "42"),
      state: "broken" as const,
      brokenReason: "not_linked" as const,
      revoked: true,
    };
    expect(rows([company("co_a")], [revokedCleared])[0]).toMatchObject({ state: "attention", action: "open" });
  });

  test("a formed company still filing, with no order, is in progress by its company", () => {
    expect(rows([formed("co_f")], [])).toEqual<AccountRow[]>([
      {
        key: "company:co_f",
        href: "/legal-body?company=co_f",
        title: "First Choice Agent LLC",
        agentId: null,
        state: "in_progress",
        action: "continue",
        standing: false,
      },
    ]);
  });

  test("a formed company whose filing failed needs attention, and is continued by its company", () => {
    expect(rows([formed("co_f", { state: "failed" })], [])).toEqual([
      expect.objectContaining({
        key: "company:co_f",
        href: "/legal-body?company=co_f",
        state: "attention",
        action: "continue",
      }),
    ]);
  });

  test("a declared company whose check failed needs attention, and is continued by its company", () => {
    const failed = company("co_a", {
      verification: { state: "failed", checkedAt: NOW_S - 60, reasonCode: null },
    });
    expect(rows([failed], [])).toEqual([
      expect.objectContaining({
        key: "company:co_a",
        href: "/legal-body?company=co_a",
        state: "attention",
        action: "continue",
      }),
    ]);
  });

  test("a company waiting on its check, or formed and filed, is in progress", () => {
    const waiting = company("co_w", {
      verification: { state: "awaiting_check", checkedAt: null, reasonCode: null },
    });
    const filed = formed("co_f", { state: "filed", legalNameFiled: "Filed Name LLC" });
    expect(rows([waiting, filed], []).map((r) => [r.key, r.state])).toEqual([
      ["company:co_w", "in_progress"],
      ["company:co_f", "in_progress"],
    ]);
  });

  test("a declared company with a linked order has no company row", () => {
    expect(rows([company("co_a")], [linked("ord_1", "co_a", "42")]).map((r) => r.key)).toEqual([
      "order:ord_1",
    ]);
  });

  test("a company with a live order is that order's row only", () => {
    expect(rows([company("co_a")], [order("ord_1", "co_a")]).map((r) => r.key)).toEqual(["order:ord_1"]);
  });

  test("a company the flow cannot continue from has no row", () => {
    const companies = [
      company("co_ab", { state: "abandoned" }),
      company("co_rv", { verification: { state: "revoked", checkedAt: NOW_S, reasonCode: null } }),
      company("co_nr", { verification: null }),
      formed("co_fa", { state: "abandoned" }),
      company("co_agent", { provider: "doola", purpose: "agent", declared: undefined, verification: undefined }),
    ];
    expect(rows(companies, [])).toEqual([]);
  });

  test("an order of a company that is not the account's has no row", () => {
    expect(rows([company("co_a")], [linked("ord_x", "co_other", "42")]).map((r) => r.key)).toEqual([
      "company:co_a",
    ]);
    expect(rows([], [order("ord_x", "co_other")])).toEqual([]);
  });

  test("ids go into the address encoded", () => {
    const r = rows([formed("co f/1")], []);
    expect(r.map((x) => x.href)).toEqual(["/legal-body?company=co%20f%2F1"]);
    const o = rows([company("co_a")], [order("ord?&=", "co_a")]);
    expect(o[0].href).toBe("/legal-body?order=ord%3F%26%3D");
  });
});

describe("accountLegalBodyRows: an order of another deployment", () => {
  // Made under another chain or another factory, it opens in the flow as closed ("it can be read
  // here and nothing else"), with a new order on its company as the way out: it is never
  // "In progress" and never continued here.
  const elsewhere = [
    { factory: OTHER_FACTORY },
    { chainId: CHAIN + 1 },
  ] as const;

  test.each(elsewhere)("a live order under %o needs attention and opens", (where) => {
    const live = [
      order("ord_d", "co_a", where),
      order("ord_r", "co_a", { ...where, state: "reserved", agentId: "1" }),
      order("ord_p", "co_a", { ...where, state: "deployed", agentId: "2" }),
      { ...linked("ord_c", "co_a", "3"), ...where, state: "broken" as const, brokenReason: "not_linked" as const },
    ];
    for (const o of live) {
      const r = rows([company("co_a")], [o]);
      // Its company is reached through it, as the flow reaches it: no company row beside it.
      expect(r).toEqual([
        expect.objectContaining({ key: `order:${o.id}`, href: `/legal-body?order=${o.id}`, state: "attention", action: "open", standing: false }),
      ]);
    }
  });

  test("a linked body elsewhere is still linked and opened; an expired draft elsewhere has no row", () => {
    const body = { ...linked("ord_l", "co_a", "42"), factory: OTHER_FACTORY };
    expect(rows([company("co_a")], [body])[0]).toMatchObject({ state: "linked", action: "open" });
    const expired = order("ord_x", "co_a", { factory: OTHER_FACTORY, createdAt: iso(NOW - 25 * HOUR) });
    expect(rows([company("co_a")], [expired]).map((r) => r.key)).toEqual(["company:co_a"]);
  });

  test("the factory is compared as an address, whatever its case", () => {
    const lower = order("ord_1", "co_a", { factory: FACTORY.toLowerCase() as typeof FACTORY });
    expect(rows([company("co_a")], [lower])[0]).toMatchObject({ state: "in_progress", action: "continue" });
  });

  test("with the deployment not known, every order reads as this deployment's, as before", () => {
    const foreign = order("ord_1", "co_a", { factory: OTHER_FACTORY });
    expect(
      accountLegalBodyRows({ companies: [company("co_a")], orders: [foreign], nowMs: NOW, where: null })[0],
    ).toMatchObject({ state: "in_progress", action: "continue" });
  });

  test("the section reads the deployment from its legal-body config", () => {
    // The two fields the rows read; the rest of the config plays no part here.
    const config = { available: true, chainId: CHAIN, factory: FACTORY } as unknown as LegalBodyConfig;
    const lists = (factory: string) => ({
      orders: { data: { orders: [order("ord_1", "co_a", { factory: factory as typeof FACTORY })] }, error: null },
      companies: { data: { companies: [company("co_a")] }, error: null },
    });
    const first = (v: LegalBodiesView) => (v.kind === "rows" ? v.rows[0] : null);
    expect(first(legalBodiesView({ ...lists(OTHER_FACTORY), config, nowMs: NOW }))).toMatchObject({
      state: "attention",
      action: "open",
    });
    expect(first(legalBodiesView({ ...lists(FACTORY), config, nowMs: NOW }))).toMatchObject({
      state: "in_progress",
      action: "continue",
    });
    // A config not read yet: as before.
    expect(first(legalBodiesView({ ...lists(OTHER_FACTORY), config: null, nowMs: NOW }))).toMatchObject({
      state: "in_progress",
      action: "continue",
    });
  });
});

describe("accountLegalBodyRows: the title", () => {
  test("the order's company name first", () => {
    const r = rows([company("co_a")], [order("ord_1", "co_a", { companyName: "Order Name LLC" })]);
    expect(r[0].title).toBe("Order Name LLC");
  });

  test("then the declared name, the filed name, the first name option", () => {
    const declared = company("co_a", { declared: { companyName: "Declared LLC", filingNumber: "1", wordingVersion: "1" } });
    expect(rows([declared], [order("ord_1", "co_a", { companyName: null })])[0].title).toBe("Declared LLC");
    const filed = formed("co_f", { legalNameFiled: "Filed Name LLC", state: "filed" });
    expect(rows([filed], [order("ord_1", "co_f", { companyName: null })])[0].title).toBe("Filed Name LLC");
    expect(rows([formed("co_f")], [order("ord_1", "co_f", { companyName: null })])[0].title).toBe(
      "First Choice Agent LLC",
    );
  });

  test("with no name at all, the chooser's unnamed words", () => {
    const bare = company("co_a", { declared: null, nameOptions: [] });
    expect(rows([bare], [])[0].title).toBe(C.unnamed);
    expect(rows([formed("co_f", { nameOptions: [] })], [])[0].title).toBe(C.formedUnnamed);
  });
});

describe("accountLegalBodyRows: the order of the rows and the standing reads", () => {
  test("in-progress rows come before linked ones", () => {
    const r = rows(
      [company("co_a"), company("co_b"), formed("co_f", { createdAt: NOW - 30 * HOUR })],
      [linked("ord_new_link", "co_a", "1", 0.5), order("ord_draft", "co_b", { createdAt: iso(NOW - 3 * HOUR) })],
    );
    expect(r.map((x) => x.key)).toEqual(["order:ord_draft", "company:co_f", "order:ord_new_link"]);
  });

  test("within each group, newest first", () => {
    const r = rows(
      [company("co_a")],
      [
        linked("ord_old", "co_a", "1", 10),
        linked("ord_new", "co_a", "2", 2),
        { ...linked("ord_mid", "co_a", "3", 5), state: "broken", brokenReason: "dissolved" },
        order("ord_draft", "co_a", { createdAt: iso(NOW - 20 * HOUR) }),
      ],
    );
    expect(r.map((x) => x.key)).toEqual(["order:ord_mid", "order:ord_draft", "order:ord_new", "order:ord_old"]);
  });

  test("seven linked orders give the standing read to exactly five, the newest", () => {
    const orders = Array.from({ length: 7 }, (_, i) => linked(`ord_${i}`, "co_a", String(100 + i), i + 1));
    const r = rows([company("co_a")], orders);
    expect(r).toHaveLength(7);
    expect(r.filter((x) => x.standing)).toHaveLength(5);
    expect(r.filter((x) => x.standing).map((x) => x.key)).toEqual(
      ["ord_0", "ord_1", "ord_2", "ord_3", "ord_4"].map((id) => `order:${id}`),
    );
  });

  test("a linked row with no identity is never read, and takes no read from another", () => {
    const orders = [
      linked("ord_none", "co_a", null, 1),
      ...Array.from({ length: 5 }, (_, i) => linked(`ord_${i}`, "co_a", String(i), i + 2)),
    ];
    const r = rows([company("co_a")], orders);
    expect(r.find((x) => x.key === "order:ord_none")?.standing).toBe(false);
    expect(r.filter((x) => x.standing)).toHaveLength(5);
  });
});

describe("legalBodiesView: what the section shows", () => {
  const ok = {
    orders: { data: { orders: [order("ord_1", "co_a")] }, error: null },
    companies: { data: { companies: [company("co_a")] }, error: null },
  };
  const refused = new ApiError(403, { code: "guardian_not_verified", message: "not verified" });
  const broken = new ApiError(500, { code: "internal", message: "boom" });

  test("both lists read: the rows", () => {
    const v = legalBodiesView({ ...ok, config: null, nowMs: NOW });
    expect(v.kind).toBe("rows");
    expect(v.kind === "rows" && v.rows.map((r) => r.key)).toEqual(["order:ord_1"]);
  });

  test("a 403 on the orders shows no section, whatever the companies say", () => {
    expect(legalBodiesView({ ...ok, orders: { data: undefined, error: refused }, config: null, nowMs: NOW })).toEqual({
      kind: "hidden",
    });
    expect(
      legalBodiesView({ ...ok, orders: { data: ok.orders.data, error: refused }, config: null, nowMs: NOW }),
    ).toEqual({ kind: "hidden" });
  });

  test("a deployment that says it has no legal bodies shows no section", () => {
    expect(legalBodiesView({ ...ok, config: { available: false }, nowMs: NOW })).toEqual({ kind: "hidden" });
  });

  test("any other error, on either list, is one line with a retry", () => {
    expect(legalBodiesView({ ...ok, orders: { data: undefined, error: broken }, config: null, nowMs: NOW })).toEqual({
      kind: "unreadable",
    });
    expect(
      legalBodiesView({ ...ok, companies: { data: undefined, error: new Error("offline") }, config: null, nowMs: NOW }),
    ).toEqual({ kind: "unreadable" });
    expect(
      legalBodiesView({
        ...ok,
        companies: { data: undefined, error: new ApiError(403, { code: "forbidden", message: "no" }) },
        config: null,
        nowMs: NOW,
      }),
    ).toEqual({ kind: "unreadable" });
  });

  test("a list already read stays on screen through a failed refresh", () => {
    expect(legalBodiesView({ ...ok, orders: { ...ok.orders, error: broken }, config: null, nowMs: NOW }).kind).toBe(
      "rows",
    );
  });

  test("either list not read yet: loading", () => {
    expect(legalBodiesView({ ...ok, orders: { data: undefined, error: null }, config: null, nowMs: NOW })).toEqual({
      kind: "loading",
    });
    expect(legalBodiesView({ ...ok, companies: { data: undefined, error: null }, config: null, nowMs: NOW })).toEqual({
      kind: "loading",
    });
  });
});

describe("agentsPageView: the treasury section and the empty card", () => {
  const entity = { id: "ent_1" } as EntityView;
  const none: LegalBodiesView = { kind: "rows", rows: [] };
  const some: LegalBodiesView = {
    kind: "rows",
    rows: rows([company("co_a")], [order("ord_1", "co_a")]),
  };
  const entities = (data: EntityView[] | undefined, error: unknown = null) => ({ data, error });

  test("an agent with a treasury shows the cards, wherever the full product is offered or not", () => {
    for (const gate of ["offered", "not_offered", "unknown"] as const) {
      expect(agentsPageView({ legalBodies: some, entities: entities([entity]), gate })).toEqual({
        treasury: "cards",
        empty: false,
      });
    }
  });

  test("with no such agent, the section shows only where the full product is offered", () => {
    expect(agentsPageView({ legalBodies: some, entities: entities([]), gate: "offered" }).treasury).toBe("none");
    expect(agentsPageView({ legalBodies: some, entities: entities([]), gate: "not_offered" }).treasury).toBe("hidden");
    expect(agentsPageView({ legalBodies: some, entities: entities([]), gate: "unknown" }).treasury).toBe("hidden");
  });

  test("its loading shows only where the full product is offered", () => {
    expect(agentsPageView({ legalBodies: some, entities: entities(undefined), gate: "offered" }).treasury).toBe(
      "loading",
    );
    expect(agentsPageView({ legalBodies: some, entities: entities(undefined), gate: "not_offered" }).treasury).toBe(
      "hidden",
    );
    expect(agentsPageView({ legalBodies: some, entities: entities(undefined), gate: "unknown" }).treasury).toBe(
      "hidden",
    );
  });

  test("a list that could not be read is said wherever, and never hides the legal bodies", () => {
    // The person may have agents with a treasury on a deployment that no longer offers them.
    const failed = entities(undefined, new Error("offline"));
    for (const gate of ["offered", "not_offered", "unknown"] as const) {
      for (const legalBodies of [some, none, { kind: "hidden" } as const, { kind: "unreadable" } as const]) {
        expect(agentsPageView({ legalBodies, entities: failed, gate })).toEqual({
          treasury: "unreadable",
          empty: false,
        });
      }
    }
  });

  test("a list already read stays on screen through a failed refresh", () => {
    const stale = entities([entity], new Error("offline"));
    expect(agentsPageView({ legalBodies: some, entities: stale, gate: "not_offered" }).treasury).toBe("cards");
  });

  test("no row and no entity: the empty card alone", () => {
    for (const gate of ["offered", "not_offered", "unknown"] as const) {
      expect(agentsPageView({ legalBodies: none, entities: entities([]), gate })).toEqual({
        treasury: "hidden",
        empty: true,
      });
      expect(agentsPageView({ legalBodies: { kind: "hidden" }, entities: entities([]), gate })).toEqual({
        treasury: "hidden",
        empty: true,
      });
    }
  });

  test("the empty card waits for both lists, and never stands on a list that could not be read", () => {
    expect(agentsPageView({ legalBodies: { kind: "loading" }, entities: entities([]), gate: "unknown" }).empty).toBe(
      false,
    );
    expect(agentsPageView({ legalBodies: { kind: "unreadable" }, entities: entities([]), gate: "unknown" }).empty).toBe(
      false,
    );
    expect(agentsPageView({ legalBodies: none, entities: entities(undefined), gate: "unknown" }).empty).toBe(false);
    expect(
      agentsPageView({ legalBodies: none, entities: entities(undefined, new Error("x")), gate: "not_offered" }).empty,
    ).toBe(false);
    expect(agentsPageView({ legalBodies: some, entities: entities([]), gate: "unknown" }).empty).toBe(false);
  });
});

describe("LegalBodiesSection, as the server renders it", () => {
  /** The amber pill's markup ending in the record's sandbox word. */
  const SANDBOX_PILL = new RegExp(`#febc2e[^>]*>(?:<span[^>]*></span>)?${LEGAL_BODY_COPY.done.sandboxPill}</span>`);
  const legalBodyConfig = (environment: "sandbox" | "production"): LegalBodyConfig => ({
    available: true,
    declarations: true,
    statements: true,
    environment,
    chainId: CHAIN,
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    factory: FACTORY,
    gasSeedOffered: false,
    paymentRequired: false,
    linkTtl: { min: 600, max: 85_800, default: 3_600 },
  });

  const render = (view: LegalBodiesView) =>
    renderToString(createElement(LegalBodiesSection, { view, onRetry: () => {}, retrying: false }));

  test("no section: nothing at all", () => {
    expect(render({ kind: "hidden" })).toBe("");
    expect(render({ kind: "rows", rows: [] })).toBe("");
  });

  test("an unreadable list: its one line and a retry", () => {
    const html = render({ kind: "unreadable" });
    expect(html).toContain(A.unreadable);
    expect(html).toContain(LEGAL_BODY_COPY.done.retry);
    expect(html).not.toContain("<a ");
  });

  test("each row links into the flow with its title, identity, state and action", () => {
    const html = render({
      kind: "rows",
      rows: rows(
        [company("co_a"), formed("co_f")],
        [order("ord_1", "co_a", { state: "deployed", agentId: "42" })],
      ),
    });
    expect(html).toContain(A.legalBodies);
    expect(html).toContain('href="/legal-body?order=ord_1"');
    expect(html).toContain('href="/legal-body?company=co_f"');
    expect(html).toContain("Example Test Holdings LLC");
    expect(html).toContain("First Choice Agent LLC");
    expect(html).toContain("agent #42");
    expect(html).toContain(A.states.in_progress);
    expect(html).toContain(A.actions.continue);
    // No linked row: no public read.
    expect(byAgent.calls).toEqual([]);
  });

  test("a standing row reads the public standing for its identity, and shows it once read", () => {
    byAgent.data = { kind: "could_not_check", reason: "rate_limited" } as PublicRead<LegalBodyByAgent>;
    const html = render({ kind: "rows", rows: rows([company("co_a")], [linked("ord_1", "co_a", "897126")]) });
    expect(byAgent.calls).toEqual([{ agentId: "897126", enabled: true }]);
    expect(html).toContain(A.states.linked);
    expect(html).toContain(A.actions.open);
    expect(html).toContain(LEGAL_BODY_COPY.done.labels.couldNotCheck);
  });

  test("on a sandbox deployment the standing carries the record's sandbox pill; on production it does not", () => {
    byAgent.data = { kind: "could_not_check", reason: "rate_limited" } as PublicRead<LegalBodyByAgent>;
    const linkedRows = rows([company("co_a")], [linked("ord_1", "co_a", "897126")]);
    byAgent.config = legalBodyConfig("sandbox");
    const sandbox = render({ kind: "rows", rows: linkedRows });
    expect(sandbox).toMatch(SANDBOX_PILL);
    byAgent.config = legalBodyConfig("production");
    expect(render({ kind: "rows", rows: linkedRows })).not.toMatch(SANDBOX_PILL);
    // Nothing read yet: no standing and no sandbox pill either.
    byAgent.data = undefined;
    byAgent.config = legalBodyConfig("sandbox");
    expect(render({ kind: "rows", rows: linkedRows })).not.toMatch(SANDBOX_PILL);
  });

  test("no standing row, no sandbox pill: the pill belongs to the standing", () => {
    byAgent.config = legalBodyConfig("sandbox");
    const html = render({ kind: "rows", rows: rows([company("co_a")], [order("ord_1", "co_a")]) });
    expect(html).not.toMatch(SANDBOX_PILL);
  });

  test("a linked row past the five reads asks for nothing", () => {
    const orders = Array.from({ length: 7 }, (_, i) => linked(`ord_${i}`, "co_a", String(100 + i), i + 1));
    const html = render({ kind: "rows", rows: rows([company("co_a")], orders) });
    expect(byAgent.calls.map((c) => c.agentId)).toEqual(["100", "101", "102", "103", "104"]);
    expect(html.split('href="/legal-body?order=').length - 1).toBe(7);
  });
});

describe("rowGuardians: what a linked row's record is measured against", () => {
  test("each linked order's own guardian, by the key of its row", () => {
    const orders = [
      linked("ord_1", "co_a", "897126"),
      { ...linked("ord_2", "co_a", "897127"), guardian: OTHER_GUARDIAN },
    ];
    const g = rowGuardians(orders);
    expect([...g.entries()]).toEqual([
      ["order:ord_1", GUARDIAN],
      ["order:ord_2", OTHER_GUARDIAN],
    ]);
    // The keys are the rows' own.
    for (const row of rows([company("co_a")], orders)) expect(g.get(row.key)).toBeDefined();
  });

  test("a revoked body, and an order that is not linked, have none", () => {
    const g = rowGuardians([
      { ...linked("ord_revoked", "co_a", "897126"), revoked: true },
      order("ord_draft", "co_a"),
      order("ord_deployed", "co_a", { state: "deployed", agentId: "42" }),
      { ...linked("ord_broken", "co_a", "897128"), state: "broken", brokenReason: "dissolved" },
    ]);
    expect(g.size).toBe(0);
  });

  test("the section's view carries them beside its rows, the rows unchanged", () => {
    const orders = [linked("ord_1", "co_a", "897126"), order("ord_draft", "co_a")];
    const v = legalBodiesView({
      orders: { data: { orders }, error: null },
      companies: { data: { companies: [company("co_a")] }, error: null },
      config: null,
      nowMs: NOW,
    });
    expect(v.kind === "rows" && v.rows).toEqual(rows([company("co_a")], orders));
    expect(v.kind === "rows" && v.guardians && [...v.guardians.entries()]).toEqual([["order:ord_1", GUARDIAN]]);
  });
});

describe("LegalBodiesSection: the agent's wallet on a linked row", () => {
  /** The words as a person reads them in the markup. */
  const OWED = A.walletOwed.replace("'", "&#x27;");
  const ZERO = "0x0000000000000000000000000000000000000000";

  /** A linked body's public record, all its fields, as the public docs show them. */
  const RECORD: LegalBodyStatementJson = {
    chainId: String(CHAIN),
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    factory: FACTORY,
    legalBody: BODY,
    agentId: "897126",
    agentWallet: GUARDIAN,
    identityOwnerAtCreation: GUARDIAN,
    bindingState: "linked",
    identityOwnerIsContract: false,
    agentWalletIsContract: false,
    standing: "active",
    attestationState: "active",
    jurisdiction: "WY",
    entityType: "LLC",
    legalName: "Example Test Holdings LLC",
    filingNumber: "TEST-0001",
    source: "customer",
    environment: "production",
    controlVerified: true,
    existenceCheckedAt: String(NOW_S - 600),
    filedAt: "2026-03-10",
    einIssued: false,
    filingStatus: "not_yet_due",
    lastFiledPeriod: "0",
    lastFiledAt: "",
    lastFiledConfirmedBy: "",
    nextDue: "2027-03-01",
    oaManifestHash: `0x${"ab".repeat(32)}`,
    oaManifestVersion: "1",
    guardianHumanVerified: true,
    observedAtBlock: "31415926",
    issuedAt: String(NOW_S - 60),
    expiresAt: String(NOW_S + 240),
  };

  const LINKS = {
    transparency: "https://example.test/transparency",
    statement: "https://example.test/legal-bodies/by-agent/897126",
  };

  /** The public answer of a linked body whose record names `agentWallet` as the agent's wallet. */
  const naming = (agentWallet: string): PublicRead<LegalBodyByAgent> => ({
    kind: "answer",
    body: {
      agentId: "897126",
      legalBody: true,
      standing: "active",
      publicId: "lb_test",
      network: "testnet",
      links: LINKS,
      checkedAt: "2026-10-12T12:00:00.000Z",
      statement: {
        domain: { name: "Novi Corpus Attestation", version: "2", chainId: CHAIN },
        primaryType: "LegalBodyStatement",
        message: { ...RECORD, agentWallet: agentWallet as LegalBodyStatementJson["agentWallet"] },
        attestor: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
        signature: `0x${"cd".repeat(65)}`,
      },
    },
  });

  /** The section for these orders, as the page builds it: through `legalBodiesView`. */
  const renderOrders = (orders: LegalBodyOrderView[]) => {
    const view = legalBodiesView({
      orders: { data: { orders }, error: null },
      companies: { data: { companies: [company("co_a")] }, error: null },
      config: null,
      nowMs: NOW,
    });
    return renderToString(createElement(LegalBodiesSection, { view, onRetry: () => {}, retrying: false }));
  };
  const count = (html: string) => html.split(OWED).length - 1;

  test("a record that still names the guardian's own wallet, in any letter case: the words, beside the standing", () => {
    for (const wallet of [GUARDIAN, GUARDIAN.toLowerCase()]) {
      byAgent.data = naming(wallet);
      const html = renderOrders([linked("ord_1", "co_a", "897126")]);
      expect(count(html)).toBe(1);
      // After the state word and the standing pill, inside the row's own link.
      const words = html.indexOf(OWED);
      expect(html.indexOf(A.states.linked)).toBeLessThan(words);
      expect(html.indexOf(">active<")).toBeLessThan(words);
      expect(html.lastIndexOf('href="/legal-body?order=ord_1"', words)).toBeGreaterThan(-1);
    }
  });

  test("a record that names no wallet (the zero address): the words", () => {
    byAgent.data = naming(ZERO);
    expect(count(renderOrders([linked("ord_1", "co_a", "897126")]))).toBe(1);
  });

  test("a record that names the agent's own wallet: nothing", () => {
    byAgent.data = naming("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    const html = renderOrders([linked("ord_1", "co_a", "897126")]);
    expect(count(html)).toBe(0);
    expect(html).toContain(">active<");
  });

  test("measured against the order's own guardian, not anyone else's wallet", () => {
    const theirs = { ...linked("ord_1", "co_a", "897126"), guardian: OTHER_GUARDIAN };
    byAgent.data = naming(GUARDIAN);
    expect(count(renderOrders([theirs]))).toBe(0);
    byAgent.data = naming(OTHER_GUARDIAN);
    expect(count(renderOrders([theirs]))).toBe(1);
  });

  test("a record not read, not read yet, or with no statement: nothing", () => {
    // A body whose statement could not be made just now: no record, so nothing is said of it.
    const unsigned: PublicRead<LegalBodyByAgent> = {
      kind: "answer",
      body: {
        agentId: "897126",
        legalBody: true,
        standing: "unknown",
        publicId: null,
        network: "testnet",
        links: { transparency: LINKS.transparency },
        checkedAt: "2026-10-12T12:00:00.000Z",
        statement: null,
      },
    };
    const noBody: PublicRead<LegalBodyByAgent> = {
      kind: "answer",
      body: { agentId: "897126", legalBody: false, standing: null, checkedAt: "2026-10-12T12:00:00.000Z" },
    };
    for (const data of [
      undefined,
      { kind: "could_not_check", reason: "rate_limited" } as PublicRead<LegalBodyByAgent>,
      unsigned,
      noBody,
    ]) {
      byAgent.data = data;
      expect(count(renderOrders([linked("ord_1", "co_a", "897126")]))).toBe(0);
    }
  });

  test("a row in progress reads nothing and says nothing", () => {
    byAgent.data = naming(GUARDIAN);
    const html = renderOrders([order("ord_1", "co_a", { state: "deployed", agentId: "42" })]);
    expect(count(html)).toBe(0);
    expect(byAgent.calls).toEqual([]);
  });

  test("a revoked body says nothing of its wallet: its done page offers no way to set one", () => {
    byAgent.data = naming(GUARDIAN);
    const html = renderOrders([{ ...linked("ord_1", "co_a", "897126"), revoked: true }]);
    expect(count(html)).toBe(0);
    // The standing is still read and shown as before.
    expect(byAgent.calls).toEqual([{ agentId: "897126", enabled: true }]);
  });

  test("only the five linked rows that read their record say it, as for the standing", () => {
    byAgent.data = naming(GUARDIAN);
    const orders = Array.from({ length: 7 }, (_, i) => linked(`ord_${i}`, "co_a", String(100 + i), i + 1));
    expect(count(renderOrders(orders))).toBe(STANDING_READS);
  });

  test("a view built without the guardians says nothing of the wallet", () => {
    byAgent.data = naming(GUARDIAN);
    const html = renderToString(
      createElement(LegalBodiesSection, {
        view: { kind: "rows", rows: rows([company("co_a")], [linked("ord_1", "co_a", "897126")]) },
        onRetry: () => {},
        retrying: false,
      }),
    );
    expect(count(html)).toBe(0);
  });
});
