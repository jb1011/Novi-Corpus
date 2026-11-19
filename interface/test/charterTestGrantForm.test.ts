/**
 * The grant form of the Charter flow's test page: the served form read, the state a form opens in,
 * and the grant the state sends.
 *
 * The amounts in these tests are made up: they are not proposals.
 */
import { describe, expect, test } from "vitest";
import {
  ABOVE_VALUES,
  ACT_LINES,
  COUNTERPARTY_VALUES,
  FIXED_RULES,
  GRANT_SCHEMA,
  HEAVY_ACTS,
  HEAVY_MODES,
  emptyGrantFormState,
  grantFromState,
  grantKey,
  readGrantForm,
  readServedGrant,
  type GrantFormState,
} from "@/lib/charterTest/grantForm";

const NOTICE =
  "Notice: this document is a fixed form. It is not a substitute for the advice of an attorney. Novi Corpus is not a law firm and does not give legal advice (section 12).";

/** The grant form door's answer on a deployment whose agreement takes a grant. */
const servedForm = () => ({
  takesGrant: true,
  text: { id: "legal-body-operating-agreement", version: "2026-11-draft-5", status: "draft" },
  schema: "novi.legal-body-grant/1",
  amountMax: 1_000_000_000,
  heavyActModes: {
    employ: ["not_allowed", "guardian_signature"],
    borrow: ["not_allowed", "guardian_signature", "alone"],
    guarantee: ["not_allowed", "guardian_signature", "alone"],
    transferProperty: ["not_allowed", "guardian_signature"],
  },
  notice: NOTICE,
});

describe("the schema this page draws", () => {
  test("its name, its lines in their order, and its values", () => {
    expect(GRANT_SCHEMA).toBe("novi.legal-body-grant/1");
    expect(ACT_LINES).toEqual([
      { key: "provideServices", kind: "act" },
      { key: "acceptEngagement", kind: "act" },
      { key: "issueInvoice", kind: "act" },
      { key: "receivePayment", kind: "flag" },
      { key: "buy", kind: "spend" },
      { key: "pay", kind: "spend" },
      { key: "engageContractor", kind: "spend" },
    ]);
    expect(HEAVY_ACTS).toEqual(["employ", "borrow", "guarantee", "transferProperty"]);
    expect(ABOVE_VALUES).toEqual(["guardian_signature", "not_allowed"]);
    expect(HEAVY_MODES).toEqual(["not_allowed", "guardian_signature", "alone"]);
    expect(COUNTERPARTY_VALUES).toEqual(["anyone", "active_legal_body"]);
  });

  test("the three fixed rules, in the words the server answers", () => {
    expect(FIXED_RULES).toEqual({
      receivePayment: "must be true when invoices are allowed",
      per30Days: "must be at least the amount per act",
      endsOn: "must be after today (UTC)",
    });
  });
});

describe("the served form, read", () => {
  test("a deployment whose agreement takes no grant", () => {
    expect(readGrantForm({ takesGrant: false })).toEqual({ kind: "none" });
  });

  test("the form, as served: the amount, the settings offered in their order, the notice", () => {
    expect(readGrantForm(servedForm())).toEqual({
      kind: "form",
      form: {
        text: { id: "legal-body-operating-agreement", version: "2026-11-draft-5", status: "draft" },
        schema: "novi.legal-body-grant/1",
        amountMax: 1_000_000_000,
        heavyActModes: servedForm().heavyActModes,
        notice: NOTICE,
      },
    });
  });

  test("a form with no notice", () => {
    const read = readGrantForm({ ...servedForm(), notice: null });
    expect(read.kind === "form" && read.form.notice).toBe(null);
  });

  test("the settings offered are the served ones, not the schema's three", () => {
    const read = readGrantForm({
      ...servedForm(),
      heavyActModes: { ...servedForm().heavyActModes, borrow: ["guardian_signature", "not_allowed"] },
    });
    expect(read.kind === "form" && read.form.heavyActModes.borrow).toEqual([
      "guardian_signature",
      "not_allowed",
    ]);
  });

  test.each([
    ["not_an_object", null],
    ["not_an_object", "text"],
    ["not_an_object", [servedForm()]],
    ["takes_grant", {}],
    ["takes_grant", { ...servedForm(), takesGrant: "true" }],
    ["schema", { ...servedForm(), schema: "novi.legal-body-grant/2" }],
    ["schema", { ...servedForm(), schema: undefined }],
    ["text", { ...servedForm(), text: null }],
    ["text", { ...servedForm(), text: { id: "a", version: 5, status: "draft" } }],
    ["amount_max", { ...servedForm(), amountMax: "1000" }],
    ["amount_max", { ...servedForm(), amountMax: 0 }],
    ["amount_max", { ...servedForm(), amountMax: 1.5 }],
    ["heavy_act_modes", { ...servedForm(), heavyActModes: null }],
    ["heavy_act_modes", { ...servedForm(), heavyActModes: { ...servedForm().heavyActModes, employ: [] } }],
    ["heavy_act_modes", { ...servedForm(), heavyActModes: { ...servedForm().heavyActModes, employ: ["sometimes"] } }],
    ["heavy_act_modes", { ...servedForm(), heavyActModes: { employ: ["not_allowed"] } }],
    ["heavy_act_modes", { ...servedForm(), heavyActModes: { ...servedForm().heavyActModes, employ: ["guardian_signature", "alone"] } }],
    ["notice", { ...servedForm(), notice: undefined }],
    ["notice", { ...servedForm(), notice: 3 }],
  ])("an answer this page cannot draw: %s", (problem, answer) => {
    expect(readGrantForm(answer)).toEqual({ kind: "unreadable", problem });
  });
});

describe("the state a form opens in", () => {
  const state = emptyGrantFormState();

  test("every act not allowed, every amount empty, nothing chosen", () => {
    for (const { key } of ACT_LINES)
      expect(state.acts[key]).toEqual({ allowed: false, perAct: "", per30Days: "", above: "" });
    for (const act of HEAVY_ACTS) expect(state.heavyActs[act]).toEqual({ mode: "not_allowed", perAct: "" });
    expect(state.counterparties).toBe("");
    expect(state.ends).toBe("");
    expect(state.endsOn).toBe("");
  });

  test("it holds no value of the page's: each leaf is false, empty, or not_allowed", () => {
    const leaves: unknown[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
      else leaves.push(v);
    };
    walk(state);
    expect(leaves).toHaveLength(7 * 4 + 4 * 2 + 3);
    expect(leaves.filter((v) => v !== false && v !== "" && v !== "not_allowed")).toEqual([]);
  });

  test("each call makes a state of its own", () => {
    const other = emptyGrantFormState();
    other.acts.buy.allowed = true;
    expect(emptyGrantFormState().acts.buy.allowed).toBe(false);
  });

  test("what it sends: every line, not allowed, and no counterparty and no end", () => {
    expect(grantFromState(state)).toEqual({
      acts: {
        provideServices: { allowed: false },
        acceptEngagement: { allowed: false },
        issueInvoice: { allowed: false },
        receivePayment: { allowed: false },
        buy: { allowed: false },
        pay: { allowed: false },
        engageContractor: { allowed: false },
      },
      heavyActs: {
        employ: { mode: "not_allowed" },
        borrow: { mode: "not_allowed" },
        guarantee: { mode: "not_allowed" },
        transferProperty: { mode: "not_allowed" },
      },
    });
    const sent = grantFromState(state);
    expect(Object.hasOwn(sent, "counterparties")).toBe(false);
    expect(Object.hasOwn(sent, "endsOn")).toBe(false);
  });
});

/** A state with every line set, with made-up amounts. */
function filled(): GrantFormState {
  const s = emptyGrantFormState();
  s.acts.provideServices = { allowed: true, perAct: "731", per30Days: "", above: "guardian_signature" };
  s.acts.acceptEngagement = { allowed: true, perAct: "1250000", per30Days: "", above: "not_allowed" };
  s.acts.issueInvoice = { allowed: true, perAct: "17", per30Days: "", above: "not_allowed" };
  s.acts.receivePayment = { allowed: true, perAct: "", per30Days: "", above: "" };
  s.acts.buy = { allowed: true, perAct: "43", per30Days: "977", above: "guardian_signature" };
  s.acts.pay = { allowed: true, perAct: "59", per30Days: "59", above: "not_allowed" };
  s.acts.engageContractor = { allowed: false, perAct: "", per30Days: "", above: "" };
  s.heavyActs.employ = { mode: "guardian_signature", perAct: "" };
  s.heavyActs.borrow = { mode: "alone", perAct: "389" };
  s.counterparties = "active_legal_body";
  s.ends = "date";
  s.endsOn = "2031-03-09";
  return s;
}

describe("the grant a state sends", () => {
  test("every line set", () => {
    expect(grantFromState(filled())).toEqual({
      acts: {
        provideServices: { allowed: true, perAct: 731, above: "guardian_signature" },
        acceptEngagement: { allowed: true, perAct: 1_250_000, above: "not_allowed" },
        issueInvoice: { allowed: true, perAct: 17, above: "not_allowed" },
        receivePayment: { allowed: true },
        buy: { allowed: true, perAct: 43, per30Days: 977, above: "guardian_signature" },
        pay: { allowed: true, perAct: 59, per30Days: 59, above: "not_allowed" },
        engageContractor: { allowed: false },
      },
      heavyActs: {
        employ: { mode: "guardian_signature" },
        borrow: { mode: "alone", perAct: 389 },
        guarantee: { mode: "not_allowed" },
        transferProperty: { mode: "not_allowed" },
      },
      counterparties: "active_legal_body",
      endsOn: "2031-03-09",
    });
  });

  test("no end chosen is no key; no end is null; a date is the text typed", () => {
    const s = filled();
    s.ends = "";
    expect(Object.hasOwn(grantFromState(s), "endsOn")).toBe(false);
    s.ends = "none";
    expect(grantFromState(s).endsOn).toBe(null);
    s.ends = "date";
    s.endsOn = "  9 March 2031 ";
    expect(grantFromState(s).endsOn).toBe("9 March 2031");
    s.endsOn = "";
    expect(grantFromState(s).endsOn).toBe("");
  });

  test("a date typed while another end is chosen is not sent", () => {
    const s = filled();
    s.ends = "none";
    s.endsOn = "2031-03-09";
    expect(grantFromState(s).endsOn).toBe(null);
  });

  test("an act allowed with nothing typed and nothing chosen sends `allowed` alone", () => {
    const s = emptyGrantFormState();
    s.acts.buy.allowed = true;
    s.acts.provideServices.allowed = true;
    const acts = grantFromState(s).acts as Record<string, unknown>;
    expect(acts.buy).toEqual({ allowed: true });
    expect(acts.provideServices).toEqual({ allowed: true });
  });

  test("what was typed on a line that is then not allowed is not sent", () => {
    const s = filled();
    s.acts.buy.allowed = false;
    s.heavyActs.borrow.mode = "guardian_signature";
    const sent = grantFromState(s);
    expect((sent.acts as Record<string, unknown>).buy).toEqual({ allowed: false });
    expect((sent.heavyActs as Record<string, unknown>).borrow).toEqual({ mode: "guardian_signature" });
  });

  test("a line with one amount never sends an amount per thirty days", () => {
    const s = emptyGrantFormState();
    s.acts.provideServices = { allowed: true, perAct: "731", per30Days: "977", above: "not_allowed" };
    expect((grantFromState(s).acts as Record<string, unknown>).provideServices).toEqual({
      allowed: true,
      perAct: 731,
      above: "not_allowed",
    });
  });

  test.each([
    ["731", 731],
    [" 731 ", 731],
    ["0", 0],
    ["1000000001", 1_000_000_001],
    ["0731", "0731"],
    ["7.5", "7.5"],
    ["7e2", "7e2"],
    ["-7", "-7"],
    ["+7", "+7"],
    ["7 31", "7 31"],
    ["seven", "seven"],
    ["9007199254740993", "9007199254740993"],
  ])("an amount typed %j is sent as %j: never cleaned, the server refuses what it refuses", (typed, sent) => {
    const s = emptyGrantFormState();
    s.acts.buy = { allowed: true, perAct: typed, per30Days: "", above: "" };
    expect((grantFromState(s).acts as Record<string, { perAct?: unknown }>).buy.perAct).toBe(sent);
  });

  test("the state is not changed by reading it", () => {
    const s = filled();
    const before = JSON.stringify(s);
    grantFromState(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  test("one spelling per grant: equal choices have equal keys, other choices another", () => {
    expect(grantKey(grantFromState(filled()))).toBe(grantKey(grantFromState(filled())));
    const other = filled();
    other.acts.buy.perAct = "44";
    expect(grantKey(grantFromState(other))).not.toBe(grantKey(grantFromState(filled())));
  });
});

describe("a grant as a door shows it", () => {
  const grant = {
    number: 1,
    version: 1,
    digest: `0x${"ab".repeat(32)}`,
    wording: "2026-11-draft-4",
    choices: { counterparties: "anyone" },
    scheduleA: "Grant number 1, version 1.\nLine two.",
  };

  test("the preview's grant and an order's grant, as served", () => {
    expect(readServedGrant({ grant })).toEqual(grant);
  });

  test("an order with no grant", () => {
    expect(readServedGrant({ grant: null })).toBe(null);
  });

  test.each([[null], [{}], ["text"], [{ grant: "x" }], [{ grant: { ...grant, scheduleA: 3 } }], [{ grant: { ...grant, number: "1" } }]])(
    "an answer that is not one (%j)",
    (answer) => {
      expect(readServedGrant(answer)).toBe("unreadable");
    },
  );
});
