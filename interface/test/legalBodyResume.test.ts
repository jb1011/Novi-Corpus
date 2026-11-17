/**
 * Resuming the legal-body flow from the server's state: what the local memory holds after a thread
 * is shown, which local choices count for which order, what a "start another" click overrides,
 * where a rail jump sends the derivation, the flow's clock, the chooser's rows, and whether a new
 * company opens on the choice of paths.
 */
import { describe, expect, test } from "vitest";
import type { Address, CompanyView, LegalBodyOrderView } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { selectLegalBodyThread, type LegalBodyThread } from "@/lib/legalBody/flow";
import { LEGAL_BODY_PHASES } from "@/lib/legalBody/phases";
import type { LegalBodyMemory } from "@/lib/legalBody/storage";
import {
  arrivalAction,
  arrivalMemory,
  chooserRows,
  companyScreen,
  draftChoices,
  flowNowMs,
  identitySuggestionAfter,
  intentSpent,
  jumpMemoryPatch,
  memoryAfterThread,
  mergeLegalBodyMemory,
  newCompanyHandover,
  patchEndsIntent,
  threadDoor,
  threadRefsOf,
  threadWithIntent,
} from "@/lib/legalBody/resume";
import { pathCards } from "@/lib/start/paths";

/** Anvil's first published test account, and the public testnet factory. */
const TENANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as Address;
const OTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as Address;
const CHAIN = 5042002;
const WHERE = { chainId: CHAIN, factory: FACTORY };

const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

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

const company = (companyId: string, over: Partial<CompanyView> = {}): CompanyView => ({
  companyId,
  environment: "sandbox",
  nameOptions: [],
  legalNameFiled: null,
  businessPurpose: "",
  industryLabel: "",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: NOW - 2 * HOUR,
  provider: "customer",
  declared: { companyName: "Example Test Holdings LLC", filingNumber: "TEST-0001", wordingVersion: "v1" },
  verification: { state: "verified", checkedAt: null, reasonCode: null },
  ...over,
});

const order = (id: string, companyId: string, over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id,
  publicId: `pub_${id}`,
  companyId,
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: TENANT,
  amendmentDelay: 172_800,
  agreement: null,
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

describe("threadRefsOf", () => {
  test("the ids a screen reads for each thread", () => {
    expect(threadRefsOf({ kind: "order", companyId: "c1", orderId: "o1" })).toEqual({ companyId: "c1", orderId: "o1" });
    expect(threadRefsOf({ kind: "done", companyId: "c1", orderId: "o1" })).toEqual({ companyId: "c1", orderId: "o1" });
    expect(threadRefsOf({ kind: "closed-order", companyId: "c1", orderId: "o1" })).toEqual({ companyId: "c1", orderId: "o1" });
    expect(threadRefsOf({ kind: "company", companyId: "c1" })).toEqual({ companyId: "c1", orderId: null });
    expect(threadRefsOf({ kind: "new-company" })).toEqual({ companyId: null, orderId: null });
    expect(threadRefsOf({ kind: "chooser", threads: [] })).toBeNull();
  });
});

describe("memoryAfterThread", () => {
  const after = (stored: LegalBodyMemory | null, thread: LegalBodyThread) =>
    memoryAfterThread({ tenant: TENANT, stored, thread, intent: null });

  test("an order thread is remembered with its company", () => {
    expect(after(null, { kind: "order", companyId: "c1", orderId: "o1" })).toEqual(
      memory({ companyId: "c1", orderId: "o1" }),
    );
  });

  test("the same order keeps its draft choices", () => {
    const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "this-wallet", agentId: "42" });
    expect(after(stored, { kind: "order", companyId: "c1", orderId: "o1" })).toBeNull();
  });

  test("another order drops the choices made for the previous one", () => {
    const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "elsewhere", agentId: "42" });
    expect(after(stored, { kind: "order", companyId: "c1", orderId: "o2" })).toEqual(
      memory({ companyId: "c1", orderId: "o2" }),
    );
  });

  test("a closed order is shown once: its id is forgotten after it is rendered", () => {
    const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "this-wallet", agentId: "42" });
    expect(after(stored, { kind: "closed-order", companyId: "c1", orderId: "o1" })).toEqual(
      memory({ companyId: "c1" }),
    );
  });

  test("a company thread holds no order and no choice", () => {
    const stored = memory({ companyId: "c0", orderId: "o0", agentId: "7" });
    expect(after(stored, { kind: "company", companyId: "c1" })).toEqual(memory({ companyId: "c1" }));
  });

  test("a done page is remembered, so a reload shows it again", () => {
    expect(after(null, { kind: "done", companyId: "c1", orderId: "o1" })).toEqual(
      memory({ companyId: "c1", orderId: "o1" }),
    );
  });

  test("a new company forgets what is no longer a thread", () => {
    expect(after(memory({ companyId: "gone" }), { kind: "new-company" })).toEqual(memory());
  });

  test("nothing to write when nothing changes, or for a chooser", () => {
    expect(after(null, { kind: "new-company" })).toBeNull();
    expect(after(memory(), { kind: "new-company" })).toBeNull();
    expect(after(memory({ companyId: "c1" }), { kind: "chooser", threads: [] })).toBeNull();
  });
});

describe("memoryAfterThread: the start-another intent", () => {
  test("the stored thread keeps a live intent and drops a spent one", () => {
    const stored = memory({ companyId: null, orderId: null, startAnother: { kind: "another-company", known: [] } });
    expect(memoryAfterThread({ tenant: TENANT, stored, thread: { kind: "new-company" }, intent: stored.startAnother })).toBeNull();
    expect(memoryAfterThread({ tenant: TENANT, stored, thread: { kind: "new-company" }, intent: null })?.startAnother).toBeNull();
  });

  test("an intent that differs from the stored one is a change, and is written", () => {
    const intent = { kind: "another-agent" as const, companyId: "c1", known: ["o1"] };
    const stored = memory({ companyId: "c1" });
    expect(memoryAfterThread({ tenant: TENANT, stored, thread: { kind: "company", companyId: "c1" }, intent })).toEqual(
      memory({ companyId: "c1", startAnother: intent }),
    );
    // The same intent read back from the store is another object with the same values: no change.
    const reread = memory({ companyId: "c1", startAnother: { ...intent, known: [...intent.known] } });
    expect(memoryAfterThread({ tenant: TENANT, stored: reread, thread: { kind: "company", companyId: "c1" }, intent })).toBeNull();
    // An intent known with other ids is another intent.
    const older = memory({ companyId: "c1", startAnother: { ...intent, known: [] } });
    expect(
      memoryAfterThread({ tenant: TENANT, stored: older, thread: { kind: "company", companyId: "c1" }, intent })?.startAnother,
    ).toEqual(intent);
  });
});

describe("draftChoices", () => {
  const stored = memory({ companyId: "c1", orderId: "o1", ownerChoice: "this-wallet", agentId: "42" });

  test("the choices count for the order they were made for", () => {
    expect(draftChoices(stored, { kind: "order", companyId: "c1", orderId: "o1" })).toEqual({
      ownerChoice: "this-wallet",
      agentId: "42",
    });
  });

  test("never for another order: a new order starts at the agreement, not at the link", () => {
    expect(draftChoices(stored, { kind: "order", companyId: "c1", orderId: "o2" })).toEqual({
      ownerChoice: null,
      agentId: null,
    });
  });

  test("never outside an order thread, and never without a memory", () => {
    expect(draftChoices(stored, { kind: "company", companyId: "c1" })).toEqual({ ownerChoice: null, agentId: null });
    expect(draftChoices(stored, { kind: "done", companyId: "c1", orderId: "o1" })).toEqual({ ownerChoice: null, agentId: null });
    expect(draftChoices(null, { kind: "order", companyId: "c1", orderId: "o1" })).toEqual({ ownerChoice: null, agentId: null });
  });
});

describe("mergeLegalBodyMemory", () => {
  test("a patch over a base, for this tenant", () => {
    expect(mergeLegalBodyMemory(TENANT, memory({ companyId: "c1", orderId: "o1" }), { agentId: "42", ownerChoice: "elsewhere" })).toEqual(
      memory({ companyId: "c1", orderId: "o1", agentId: "42", ownerChoice: "elsewhere" }),
    );
  });

  test("no base: an empty memory for this tenant", () => {
    expect(mergeLegalBodyMemory(TENANT, null, { companyId: "c1" })).toEqual(memory({ companyId: "c1" }));
  });

  test("the base's tenant never wins over the session's", () => {
    const other = memory({ tenant: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address, companyId: "c1" });
    expect(mergeLegalBodyMemory(TENANT, other, {}).tenant).toBe(TENANT);
  });

  test("the start-another intent is carried, and a patch replaces it", () => {
    const intent = { kind: "another-company" as const, known: ["c1"] };
    expect(mergeLegalBodyMemory(TENANT, memory({ startAnother: intent }), { agentId: "42" }).startAnother).toEqual(intent);
    expect(mergeLegalBodyMemory(TENANT, memory({ startAnother: intent }), { startAnother: null }).startAnother).toBeNull();
  });
});

describe("newCompanyHandover", () => {
  test("a handover for another account starts from nothing of the first", () => {
    const m = newCompanyHandover(OTHER, null, "form", [{ companyId: "co_9" }]);
    expect(m).toMatchObject({ tenant: OTHER, door: "form", companyId: null, orderId: null,
      startAnother: { kind: "another-company", known: ["co_9"] } });
  });

  test("over this account's memory: the door and the companies there are, the rest kept", () => {
    const stored = memory({ companyId: "co_1", ownerChoice: "elsewhere", startAnother: { kind: "another-agent", companyId: "co_1", known: [] } });
    expect(newCompanyHandover(TENANT, stored, "declare", [{ companyId: "co_1" }, { companyId: "co_2" }])).toEqual(
      memory({
        companyId: "co_1",
        ownerChoice: "elsewhere",
        door: "declare",
        startAnother: { kind: "another-company", known: ["co_1", "co_2"] },
      }),
    );
  });
});

describe("arrivalMemory: an order or a company named in the address", () => {
  test("an order named in the address becomes the remembered order, and ends any intent", () => {
    const stored = memory({ companyId: "co_1", orderId: "ord_1", agentId: "7",
      startAnother: { kind: "another-company", known: [] } });
    expect(arrivalMemory(TENANT, stored, { order: "ord_2", company: null }))
      .toMatchObject({ tenant: TENANT, orderId: "ord_2", companyId: null, agentId: null, ownerChoice: null, startAnother: null });
  });

  test("a company named in the address becomes the remembered company, with no order and no draft choice", () => {
    const stored = memory({ companyId: "co_1", orderId: "ord_1", ownerChoice: "this-wallet", agentId: "7",
      startAnother: { kind: "another-agent", companyId: "co_1", known: ["ord_1"] } });
    expect(arrivalMemory(TENANT, stored, { order: null, company: "co_2" }))
      .toMatchObject({ tenant: TENANT, companyId: "co_2", orderId: null, agentId: null, ownerChoice: null, startAnother: null });
  });

  test("an order wins over a company", () => {
    expect(arrivalMemory(TENANT, null, { order: "ord_2", company: "co_2" }))
      .toMatchObject({ orderId: "ord_2", companyId: null });
  });

  test("an order that is not a handle does not count: the company named with it does", () => {
    expect(arrivalMemory(TENANT, null, { order: "<script>", company: "co_2" }))
      .toMatchObject({ orderId: null, companyId: "co_2" });
  });

  test("the draft choices are cleared even for the order already remembered", () => {
    const stored = memory({ companyId: "co_1", orderId: "ord_1", ownerChoice: "elsewhere", agentId: "7" });
    expect(arrivalMemory(TENANT, stored, { order: "ord_1", company: null }))
      .toMatchObject({ orderId: "ord_1", companyId: null, ownerChoice: null, agentId: null });
  });

  test("the rest of the memory is kept; with no memory, one for this tenant", () => {
    const stored = memory({ door: "form" });
    expect(arrivalMemory(TENANT, stored, { order: "ord_2", company: null })).toEqual(
      memory({ orderId: "ord_2", door: "form" }),
    );
    expect(arrivalMemory(OTHER, null, { order: null, company: "co_2" })).toEqual(
      memory({ tenant: OTHER, companyId: "co_2" }),
    );
  });

  test("anything that is not a handle is ignored", () => {
    for (const bad of ["<script>", "a b", "", "x".repeat(81), "../etc"])
      expect(arrivalMemory(TENANT, null, { order: bad, company: bad })).toBeNull();
    expect(arrivalMemory(TENANT, null, { order: null, company: null })).toBeNull();
  });

  test("another account's order is not opened", () => {
    const m = arrivalMemory(TENANT, null, { order: "ord_theirs", company: null })!;
    expect(selectLegalBodyThread({ companies: [], orders: [], stored: m, nowMs: 0 })).toEqual({ kind: "new-company" });
  });

  test("another account's order or company is not opened over the account's own thread", () => {
    const companies = [company("co_1")];
    const orders = [order("ord_1", "co_1")];
    for (const params of [{ order: "ord_theirs", company: null }, { order: null, company: "co_theirs" }]) {
      const m = arrivalMemory(TENANT, memory({ companyId: "co_1" }), params)!;
      expect(selectLegalBodyThread({ companies, orders, stored: m, nowMs: NOW }))
        .toEqual({ kind: "order", companyId: "co_1", orderId: "ord_1" });
    }
  });

  test("the account's own order or company named in the address is the thread", () => {
    const companies = [company("co_1"), company("co_2")];
    const orders = [order("ord_1", "co_1")];
    const byOrder = arrivalMemory(TENANT, null, { order: "ord_1", company: null })!;
    expect(selectLegalBodyThread({ companies, orders, stored: byOrder, nowMs: NOW }))
      .toEqual({ kind: "order", companyId: "co_1", orderId: "ord_1" });
    const byCompany = arrivalMemory(TENANT, null, { order: null, company: "co_2" })!;
    expect(selectLegalBodyThread({ companies, orders, stored: byCompany, nowMs: NOW }))
      .toEqual({ kind: "company", companyId: "co_2" });
  });
});

describe("arrivalAction: when the address's arrival is taken", () => {
  const arrival = memory({ orderId: "ord_2" });
  const NOTHING = { write: null, replace: false };

  test("nothing before the gates are passed: the address waits for the session really used", () => {
    for (const gate of ["signin", "human"] as const)
      expect(arrivalAction({ gate, named: true, arrival, done: false })).toEqual(NOTHING);
  });

  test("past the gates, an address that names a handle is written, then cleaned", () => {
    expect(arrivalAction({ gate: "flow", named: true, arrival, done: false })).toEqual({ write: arrival, replace: true });
  });

  test("past the gates, an address that names nothing usable is cleaned, and nothing is written", () => {
    expect(arrivalAction({ gate: "flow", named: true, arrival: null, done: false })).toEqual({ write: null, replace: true });
  });

  test("once taken, never again on this mount", () => {
    expect(arrivalAction({ gate: "flow", named: true, arrival, done: true })).toEqual(NOTHING);
  });

  test("an address that names no order and no company: nothing", () => {
    expect(arrivalAction({ gate: "flow", named: false, arrival: null, done: false })).toEqual(NOTHING);
  });
});

describe("threadDoor", () => {
  test("a company decides its own door, whatever was chosen elsewhere", () => {
    expect(threadDoor(company("co_d", { provider: "customer" }), "form")).toBe("declare");
    expect(threadDoor(company("co_f", { provider: "doola", purpose: "legal_body" }), "declare")).toBe("form");
    expect(threadDoor(null, "form")).toBe("form");
    expect(threadDoor(null, null)).toBe("declare");
  });

  test("a company of the agent wizard is not a formed legal body: the declare door", () => {
    expect(threadDoor(company("co_a", { provider: "doola", purpose: "agent" }), "form")).toBe("declare");
  });
});

describe("companyScreen: the choice of paths in front of a new company, and a door that is closed", () => {
  const three = pathCards({
    fullProductAvailable: true,
    legalBodies: { available: true, declarations: true, formedDoor: "offered" } as never,
  });
  /** A new company on a deployment that takes declarations, with the fields a case changes. */
  const screen = (over: Partial<Parameters<typeof companyScreen>[0]>) =>
    companyScreen({
      companyId: null,
      company: null,
      companyStep: "form",
      door: null,
      cards: three,
      declarations: true,
      ...over,
    });

  test("nothing chosen and more than one way in: the choice, in place", () => {
    expect(screen({})).toBe("choice");
  });

  test("a chosen door goes to its step; a door that closed since goes back to the choice", () => {
    expect(screen({ door: "form" })).toBe("step");
    const fullUp = pathCards({
      legalBodies: { available: true, declarations: true, formedDoor: "cap_reached" } as never,
    });
    expect(screen({ door: "form", cards: fullUp })).toBe("choice");
  });

  test("the declared door alone needs no choice, and a deployment that takes no declaration says so", () => {
    const only = pathCards({
      legalBodies: { available: true, declarations: true, formedDoor: "hidden" } as never,
    });
    expect(screen({ cards: only })).toBe("step");
    expect(screen({ door: "declare", cards: [], declarations: false })).toBe("closed");
  });

  test("an existing company is never asked again", () => {
    expect(screen({ companyId: "co_1" })).toBe("step");
  });

  test("a company step past the form is the step, whatever the cards", () => {
    expect(screen({ companyStep: "loading" })).toBe("step");
    expect(screen({ companyStep: undefined, cards: [] })).toBe("step");
  });

  test("the declare door goes to its step while declarations are taken", () => {
    expect(screen({ door: "declare" })).toBe("step");
  });

  test("the full product alone is still a choice: it is never opened from here unasked", () => {
    const fullOnly = pathCards({ fullProductAvailable: true, legalBodies: { available: false } });
    expect(screen({ cards: fullOnly, declarations: false })).toBe("choice");
  });

  test("no way in at all is the closed sentence, never an empty choice", () => {
    expect(screen({ cards: [], declarations: false })).toBe("closed");
    expect(screen({ door: "form", cards: [], declarations: false })).toBe("closed");
  });

  describe("where the deployment takes no declarations", () => {
    const formOnly = pathCards({
      legalBodies: { available: true, declarations: false, formedDoor: "offered" } as never,
    });

    test("a declared company of the account back on its form is closed", () => {
      const declared = company("co_d", { provider: "customer", state: "abandoned" });
      expect(
        screen({ companyId: "co_d", company: declared, door: "form", cards: formOnly, declarations: false }),
      ).toBe("closed");
    });

    test("a formed company of the account back on its form is its step: it never needed the declared door", () => {
      const formed = company("co_f", { provider: "doola", purpose: "legal_body", state: "abandoned" });
      expect(
        screen({ companyId: "co_f", company: formed, door: null, cards: formOnly, declarations: false }),
      ).toBe("step");
    });

    test("a new company on the form door is its step", () => {
      expect(screen({ door: "form", cards: formOnly, declarations: false })).toBe("step");
    });

    test("an existing company on a step other than its form is that step", () => {
      const declared = company("co_d", { provider: "customer" });
      for (const companyStep of ["loading", "evidence", "waiting", "failed", "revoked"] as const)
        expect(
          screen({ companyId: "co_d", company: declared, companyStep, cards: formOnly, declarations: false }),
        ).toBe("step");
    });

    test("a declared company back on its form where declarations are taken is its step", () => {
      const declared = company("co_d", { provider: "customer", state: "abandoned" });
      expect(screen({ companyId: "co_d", company: declared })).toBe("step");
    });
  });
});

describe("intentSpent", () => {
  test("an intent is spent once what it started exists", () => {
    const intent = { kind: "another-company", known: ["co_1"] } as const;
    expect(intentSpent(intent, { companies: [company("co_1")], orders: [] })).toBe(false);
    expect(intentSpent(intent, { companies: [company("co_1"), company("co_2")], orders: [] })).toBe(true);
  });

  test("another agent: spent once its company is gone", () => {
    const intent = { kind: "another-agent", companyId: "co_1", known: ["o1"] } as const;
    expect(intentSpent(intent, { companies: [company("co_1")], orders: [order("o1", "co_1")] })).toBe(false);
    expect(intentSpent(intent, { companies: [company("co_2")], orders: [order("o1", "co_1")] })).toBe(true);
  });

  test("another agent: spent once an order of its company exists that was not there at the click", () => {
    const intent = { kind: "another-agent", companyId: "co_1", known: ["o1"] } as const;
    const companies = [company("co_1"), company("co_2")];
    // An order of another company is not the one the click started.
    expect(intentSpent(intent, { companies, orders: [order("o1", "co_1"), order("o2", "co_2")] })).toBe(false);
    expect(intentSpent(intent, { companies, orders: [order("o1", "co_1"), order("o3", "co_1")] })).toBe(true);
  });
});

describe("threadWithIntent", () => {
  const p = (companies: CompanyView[], orders: LegalBodyOrderView[]) => ({ companies, orders, nowMs: NOW, where: WHERE });
  const done: LegalBodyThread = { kind: "done", companyId: "c1", orderId: "linked" };
  const linked = order("linked", "c1", { state: "linked", agentId: "1" });

  test("no intent: the selection stands", () => {
    expect(threadWithIntent(done, null, p([company("c1")], [linked]))).toBe(done);
  });

  const anotherAgent = (known: string[]) => ({ kind: "another-agent" as const, companyId: "c1", known });

  test("another agent on the same company: that company, until its new order exists", () => {
    expect(threadWithIntent(done, anotherAgent(["linked"]), p([company("c1")], [linked]))).toEqual({
      kind: "company",
      companyId: "c1",
    });
  });

  test("an order already there at the click is not the new one, live or not", () => {
    const open = order("open", "c1");
    expect(threadWithIntent(done, anotherAgent(["linked", "open"]), p([company("c1")], [linked, open]))).toEqual({
      kind: "company",
      companyId: "c1",
    });
  });

  test("once the new order exists, it is the thread while it is live", () => {
    const fresh = order("fresh", "c1");
    expect(threadWithIntent(done, anotherAgent(["linked"]), p([company("c1")], [linked, fresh]))).toEqual({
      kind: "order",
      companyId: "c1",
      orderId: "fresh",
    });
  });

  test("once the new order is linked, the selection stands: the intent never holds a finished thread back", () => {
    const fresh = order("fresh", "c1", { state: "linked", agentId: "2" });
    const doneFresh: LegalBodyThread = { kind: "done", companyId: "c1", orderId: "fresh" };
    expect(threadWithIntent(doneFresh, anotherAgent(["linked"]), p([company("c1")], [linked, fresh]))).toBe(doneFresh);
  });

  test("the newest new order when there are several", () => {
    const older = order("older", "c1", { createdAt: iso(NOW - 3 * HOUR) });
    const newer = order("newer", "c1", { createdAt: iso(NOW - HOUR) });
    expect(threadWithIntent(done, anotherAgent([]), p([company("c1")], [older, newer]))).toEqual({
      kind: "order",
      companyId: "c1",
      orderId: "newer",
    });
  });

  test("a new order under another factory is not continued here", () => {
    const foreign = order("foreign", "c1", { factory: OTHER_FACTORY });
    expect(threadWithIntent(done, anotherAgent([]), p([company("c1")], [foreign]))).toBe(done);
  });

  test("a company that is not the tenant's: the selection stands", () => {
    expect(
      threadWithIntent(done, { kind: "another-agent", companyId: "nope", known: [] }, p([company("c1")], [linked])),
    ).toBe(done);
  });

  test("another company: a new declaration, until a company appears that was not there at the click", () => {
    const intent = { kind: "another-company" as const, known: ["c1"] };
    expect(threadWithIntent(done, intent, p([company("c1")], [linked]))).toEqual({ kind: "new-company" });
    expect(threadWithIntent(done, intent, p([company("c1"), company("c2")], [linked]))).toBe(done);
  });
});

describe("patchEndsIntent", () => {
  test("a click that names the thread ends a pending intent", () => {
    expect(patchEndsIntent({ companyId: "c2", orderId: null })).toBe(true);
    expect(patchEndsIntent({ orderId: "o2" })).toBe(true);
    expect(patchEndsIntent({ companyId: null })).toBe(true);
  });

  test("a choice inside the thread does not", () => {
    expect(patchEndsIntent({})).toBe(false);
    expect(patchEndsIntent({ ownerChoice: "this-wallet", agentId: "42" })).toBe(false);
    expect(patchEndsIntent({ agentId: null })).toBe(false);
  });
});

describe("jumpMemoryPatch", () => {
  test("back to the agreement forgets the owner choice and the identity", () => {
    expect(jumpMemoryPatch("agreement")).toEqual({ ownerChoice: null, agentId: null });
  });

  test("back to the identity forgets the identity only", () => {
    expect(jumpMemoryPatch("identity")).toEqual({ agentId: null });
  });

  test("every other phase is the server's to decide: nothing local changes", () => {
    for (const phase of ["signin", "human", "company", "link", "pointer", "payment", "done"] as const) {
      expect(jumpMemoryPatch(phase)).toBeNull();
    }
  });
});

describe("identitySuggestionAfter: the identity the identity step offers again, held in memory only", () => {
  const FIRST = "900001";
  const SECOND = "900002";

  test("a jump back to the identity takes the identity the jump clears", () => {
    expect(identitySuggestionAfter({ kind: "jump", target: "identity", agentId: FIRST }, null)).toBe(FIRST);
  });

  test("a jump back to the agreement takes it too", () => {
    expect(identitySuggestionAfter({ kind: "jump", target: "agreement", agentId: FIRST }, null)).toBe(FIRST);
  });

  test("a jump with no identity left to clear keeps the one already offered", () => {
    // From the identity step back to the agreement: the memory's identity was cleared by the
    // first jump, and the suggestion must survive the second.
    expect(identitySuggestionAfter({ kind: "jump", target: "agreement", agentId: null }, FIRST)).toBe(FIRST);
    expect(identitySuggestionAfter({ kind: "jump", target: "identity", agentId: null }, null)).toBeNull();
  });

  test("a jump that clears no identity changes nothing", () => {
    for (const target of ["signin", "human", "company", "link", "pointer", "payment", "done"] as const) {
      expect(identitySuggestionAfter({ kind: "jump", target, agentId: SECOND }, FIRST)).toBe(FIRST);
      expect(identitySuggestionAfter({ kind: "jump", target, agentId: SECOND }, null)).toBeNull();
    }
  });

  test("the suggestion is taken exactly where the jump clears the identity", () => {
    for (const { id } of LEGAL_BODY_PHASES) {
      const clears = Object.prototype.hasOwnProperty.call(jumpMemoryPatch(id) ?? {}, "agentId");
      const taken = identitySuggestionAfter({ kind: "jump", target: id, agentId: FIRST }, null);
      expect(taken).toBe(clears ? FIRST : null);
    }
  });

  test("a registration offers the new identity, over any earlier one", () => {
    expect(identitySuggestionAfter({ kind: "registered", agentId: SECOND }, null)).toBe(SECOND);
    expect(identitySuggestionAfter({ kind: "registered", agentId: SECOND }, FIRST)).toBe(SECOND);
  });

  test("picking the identity offered keeps it; picking another clears it", () => {
    expect(identitySuggestionAfter({ kind: "picked", agentId: FIRST }, FIRST)).toBe(FIRST);
    expect(identitySuggestionAfter({ kind: "picked", agentId: SECOND }, FIRST)).toBeNull();
    expect(identitySuggestionAfter({ kind: "picked", agentId: SECOND }, null)).toBeNull();
  });

  test("an identity found taken is dropped when it is the one offered", () => {
    expect(identitySuggestionAfter({ kind: "dropped", agentId: FIRST }, FIRST)).toBeNull();
    expect(identitySuggestionAfter({ kind: "dropped", agentId: SECOND }, FIRST)).toBe(FIRST);
  });

  test("a new order or a new company starts with none", () => {
    expect(identitySuggestionAfter({ kind: "start_another" }, FIRST)).toBeNull();
    expect(identitySuggestionAfter({ kind: "start_another" }, null)).toBeNull();
  });

  test("a draft the link door refused: the new order for the same agent offers the draft's identity", () => {
    expect(identitySuggestionAfter({ kind: "new_order_for", agentId: FIRST }, null)).toBe(FIRST);
    expect(identitySuggestionAfter({ kind: "new_order_for", agentId: null }, null)).toBeNull();
  });

  test("the clear of the new order, then the re-offer, applied in order, leave the draft's identity", () => {
    const cleared = identitySuggestionAfter({ kind: "start_another" }, SECOND);
    expect(identitySuggestionAfter({ kind: "new_order_for", agentId: FIRST }, cleared)).toBe(FIRST);
  });
});

describe("flowNowMs", () => {
  test("the latest of the mount and every read", () => {
    expect(flowNowMs(NOW, [NOW - HOUR, NOW + 5_000, 0])).toBe(NOW + 5_000);
  });

  test("no read yet: the mount", () => {
    expect(flowNowMs(NOW, [0, 0])).toBe(NOW);
    expect(flowNowMs(NOW, [])).toBe(NOW);
  });
});

describe("chooserRows", () => {
  const C = LEGAL_BODY_COPY.chooser;
  /** A declared company's name option, as the backend stores the typed name. */
  const typed = (name: string) => ({ name, entityTypeEnding: "", position: 1 });

  test("one row per thread, named by the declaration, with its state in words", () => {
    const companies = [company("c1"), company("c2", { declared: { companyName: "Second Test LLC", filingNumber: "TEST-0002", wordingVersion: "v1" } })];
    const orders = [order("o1", "c1", { state: "deployed", agentId: "897126" })];
    const rows = chooserRows(
      [
        { kind: "order", companyId: "c1", orderId: "o1" },
        { kind: "company", companyId: "c2" },
      ],
      companies,
      orders,
    );
    expect(rows).toEqual([
      {
        key: "order:o1",
        ref: { kind: "order", companyId: "c1", orderId: "o1" },
        title: "Example Test Holdings LLC",
        detail: C.orderStates.deployed,
        identity: "Identity 897126",
      },
      {
        key: "company:c2",
        ref: { kind: "company", companyId: "c2" },
        title: "Second Test LLC",
        detail: C.companyRow,
        identity: null,
      },
    ]);
  });

  test("a draft with no identity yet, and a company whose declaration could not be read", () => {
    // As the backend serves them: a declared company keeps the typed name as its first name option,
    // and its declaration is null when the declaration row is missing.
    const rows = chooserRows(
      [
        { kind: "order", companyId: "c1", orderId: "o1" },
        { kind: "company", companyId: "c3" },
      ],
      [
        company("c1", { nameOptions: [typed("Example Test Holdings LLC")] }),
        company("c3", { declared: null, nameOptions: [typed("Third Test LLC")] }),
      ],
      [order("o1", "c1", { companyName: null })],
    );
    expect(rows[0]).toMatchObject({ title: "Example Test Holdings LLC", detail: C.orderStates.draft, identity: null });
    expect(rows[1]).toMatchObject({ title: "Third Test LLC" });
  });

  describe("the title, on companies and orders as the backend serves them", () => {
    /** A company formed through doola: no declaration and no check, its name options as asked. */
    const formed = (companyId: string, over: Partial<CompanyView> = {}) =>
      company(companyId, {
        provider: "doola",
        purpose: "legal_body",
        state: "in_progress",
        declared: undefined,
        verification: undefined,
        nameOptions: [{ name: "First Choice Agent", entityTypeEnding: "LLC", position: 1 }],
        ...over,
      });

    test("a declared company whose declaration is missing goes by the name it was declared with", () => {
      const c = company("c1", { declared: null, nameOptions: [typed("Typed Name LLC")] });
      // The order of such a company carries no name: the backend has no declaration to read it from.
      const rows = chooserRows(
        [
          { kind: "company", companyId: "c1" },
          { kind: "order", companyId: "c1", orderId: "o1" },
        ],
        [c],
        [order("o1", "c1", { companyName: null })],
      );
      expect(rows.map((r) => r.title)).toEqual(["Typed Name LLC", "Typed Name LLC"]);
    });

    test("an order on a formed company while it files goes by the first name option, once filed by the filed name", () => {
      const filing = chooserRows(
        [{ kind: "order", companyId: "cf", orderId: "o1" }],
        [formed("cf")],
        [order("o1", "cf", { companyName: null })],
      );
      expect(filing[0].title).toBe("First Choice Agent");
      // Filed: the backend serves the filed name as the order's company name.
      const filed = chooserRows(
        [{ kind: "order", companyId: "cf", orderId: "o1" }],
        [formed("cf", { state: "filed", legalNameFiled: "First Choice Agent LLC" })],
        [order("o1", "cf", { companyName: "First Choice Agent LLC" })],
      );
      expect(filed[0].title).toBe("First Choice Agent LLC");
      // No name at all: the words for a company being formed, never those for a declared one.
      const bare = chooserRows(
        [{ kind: "order", companyId: "cf", orderId: "o1" }],
        [formed("cf", { nameOptions: [] })],
        [order("o1", "cf", { companyName: null })],
      );
      expect(bare[0].title).toBe(C.formedUnnamed);
    });

    test("an empty name counts as none: the next name is taken, never a blank title", () => {
      const rows = chooserRows(
        [
          { kind: "order", companyId: "c1", orderId: "o1" },
          { kind: "company", companyId: "cf" },
        ],
        [company("c1", { nameOptions: [typed("Example Test Holdings LLC")] }), formed("cf", { legalNameFiled: "" })],
        [order("o1", "c1", { companyName: "" })],
      );
      expect(rows.map((r) => r.title)).toEqual(["Example Test Holdings LLC", "First Choice Agent"]);
    });
  });
});
