import type { Address, CompanyView, LegalBodyOrderView } from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  isFormedCompany,
  isLiveOrder,
  sameAddress,
  type CompanyStep,
  type LegalBodyThread,
  type LegalBodyThreadRef,
} from "@/lib/legalBody/flow";
import type { LegalBodyGate } from "@/lib/legalBody/gates";
import type { LegalBodyRailPhase } from "@/lib/legalBody/phases";
import {
  isHandle,
  type DoorChoice,
  type LegalBodyMemory,
  type OwnerChoice,
  type StoredIntent,
} from "@/lib/legalBody/storage";
import type { PathCard } from "@/lib/start/paths";

/**
 * Resuming the flow from the server's state, the local memory as a hint.
 *
 * The server decides where a person is (`selectLegalBodyThread`, `deriveLegalBodyPhase`); this
 * module says what the memory holds once a thread is on screen, which of its draft choices count,
 * what an address that names an order or a company hands it on arrival, what a "start another"
 * click overrides until the new order or company exists, and what a jump back on the rail changes
 * before the derivation decides again.
 */

type Memo = Omit<LegalBodyMemory, "tenant">;

const EMPTY: Memo = {
  companyId: null,
  orderId: null,
  ownerChoice: null,
  agentId: null,
  door: null,
  startAnother: null,
};

/** The company and order a screen reads for a thread; null for a chooser, which has none yet. */
export function threadRefsOf(
  thread: LegalBodyThread,
): { companyId: string | null; orderId: string | null } | null {
  switch (thread.kind) {
    case "order":
    case "done":
    case "closed-order":
      return { companyId: thread.companyId, orderId: thread.orderId };
    case "company":
      return { companyId: thread.companyId, orderId: null };
    case "new-company":
      return { companyId: null, orderId: null };
    case "chooser":
      return null;
  }
}

/** A patch over a base, always for this tenant. */
export function mergeLegalBodyMemory(
  tenant: Address,
  base: LegalBodyMemory | null,
  patch: Partial<Memo>,
): LegalBodyMemory {
  const b = base ?? { tenant, ...EMPTY };
  const kept: Memo = {
    companyId: b.companyId,
    orderId: b.orderId,
    ownerChoice: b.ownerChoice,
    agentId: b.agentId,
    door: b.door,
    startAnother: b.startAnother,
  };
  return { ...kept, ...patch, tenant };
}

/**
 * The memory that hands a new company over to the flow: the door it goes through, and an
 * `another-company` intent that knows the companies there are, so the flow shows a new company
 * until one appears that was not among them.
 */
export function newCompanyHandover(
  tenant: Address,
  stored: LegalBodyMemory | null,
  door: DoorChoice,
  companies: readonly { companyId: string }[],
): LegalBodyMemory {
  return mergeLegalBodyMemory(tenant, stored, {
    door,
    startAnother: { kind: "another-company", known: companies.map((c) => c.companyId) },
  });
}

/**
 * The memory an address hands the flow on arrival (`/legal-body?order=<id>` or `?company=<id>`, the
 * links of the agents page), or null when it names nothing the flow can use.
 *
 * A value counts only when it has the shape of a handle; anything else is ignored. An order wins
 * over a company. The named order (or company) becomes the remembered one, with no other, and the
 * memory starts the thread afresh: no "start another" intent. The draft choices (the owner choice
 * and the identity) are kept when the address names the order the memory already holds, so
 * "Continue" on "My agents" comes back where a reload would; another order or a company starts
 * with none. Whether the id is the account's own is not decided here: `selectLegalBodyThread`
 * ignores an order or a company that is not in the account's lists, so an address opens only what
 * the account already has.
 */
export function arrivalMemory(
  tenant: Address,
  stored: LegalBodyMemory | null,
  params: { order: string | null; company: string | null },
): LegalBodyMemory | null {
  const fresh = { ownerChoice: null, agentId: null, startAnother: null };
  if (params.order !== null && isHandle(params.order)) {
    const sameOrder = stored !== null && stored.orderId === params.order;
    const choices = sameOrder ? { startAnother: null } : fresh;
    return mergeLegalBodyMemory(tenant, stored, { ...choices, orderId: params.order, companyId: null });
  }
  if (params.company !== null && isHandle(params.company))
    return mergeLegalBodyMemory(tenant, stored, { ...fresh, companyId: params.company, orderId: null });
  return null;
}

/**
 * What the flow does with an address that names an order or a company: write the memory it hands
 * the flow (`arrivalMemory`, when it has one), then clean the address; or nothing yet.
 *
 * Nothing before the gates are passed: a session that is not the one really used (a stale wallet's,
 * cleared a moment later when the wallet reconnects as another) never takes the link, and the
 * address keeps it for the session that is. Nothing when the address names neither, and nothing
 * once taken on this mount.
 */
export function arrivalAction(p: {
  gate: LegalBodyGate;
  /** The address carries `order` or `company`, whatever their values. */
  named: boolean;
  arrival: LegalBodyMemory | null;
  /** Already taken on this mount. */
  done: boolean;
}): { write: LegalBodyMemory | null; replace: boolean } {
  if (p.gate !== "flow" || !p.named || p.done) return { write: null, replace: false };
  return { write: p.arrival, replace: true };
}

/**
 * Which company door a thread is on. A company decides: a formed one is on the form door, any
 * other on the declare door, whatever was chosen for another thread. With no company yet, the
 * door the memory holds, and the declare door when it holds none.
 */
export function threadDoor(company: CompanyView | null, memoryDoor: DoorChoice | null): DoorChoice {
  if (company !== null) return isFormedCompany(company) ? "form" : "declare";
  return memoryDoor ?? "declare";
}

/**
 * What the company phase shows for a thread: the choice of paths, in place; the sentence that
 * this deployment does not take the company; or the company step.
 *
 * A company that exists, or a company step past its form, is never asked again: it is the step,
 * except a declared company back on its form (abandoned) where the deployment takes no
 * declarations, which is closed. The door is the thread's (`threadDoor`), so a formed company is
 * never closed by declarations being off: it never needed the declared door.
 *
 * In front of a new company the door the memory holds decides while the deployment still offers
 * it: a chosen form door whose card is no longer offered goes back to the choice; a chosen declare
 * door with no declare card is closed. With no door chosen, the choice whenever there is a form or
 * full-product card; the declare card alone needs no choice. No card at all is closed, never an
 * empty choice.
 */
export type CompanyScreen = "choice" | "closed" | "step";

export function companyScreen(p: {
  companyId: string | null;
  /** The thread's company as read, null while it is new (or not read yet). */
  company: CompanyView | null;
  companyStep: CompanyStep | undefined;
  /** The door the memory holds. */
  door: DoorChoice | null;
  cards: readonly PathCard[];
  /** The legal-body config's `declarations === true`. */
  declarations: boolean;
}): CompanyScreen {
  if (p.companyId !== null || p.companyStep !== "form") {
    const declaredForm =
      p.companyStep === "form" && threadDoor(p.company, p.door) === "declare";
    return declaredForm && !p.declarations ? "closed" : "step";
  }
  const card = (id: PathCard["id"]) => p.cards.find((c) => c.id === id);
  if (p.door === "form") {
    if (card("form")?.state === "offered") return "step";
    return p.cards.length > 0 ? "choice" : "closed";
  }
  if (p.door === "declare") return card("declare") ? "step" : "closed";
  if (!card("form") && !card("full")) return card("declare") ? "step" : "closed";
  return "choice";
}

/**
 * What the memory holds once `thread` is on screen, or null when it already holds that (and for a
 * chooser, which changes nothing until a pick).
 *
 * The draft choices belong to one order: another order starts with none. A closed order is shown
 * once: its id is dropped after it renders, so the next visit does not show it again. The intent
 * is the caller's: the stored one while it is live, null once it is spent (`intentSpent`), so a
 * spent intent leaves the store once the thread it led to is on screen.
 */
export function memoryAfterThread(p: {
  tenant: Address;
  stored: LegalBodyMemory | null;
  thread: LegalBodyThread;
  intent: LegalBodyIntent | null;
}): LegalBodyMemory | null {
  const refs = threadRefsOf(p.thread);
  if (refs === null) return null;
  const orderId = p.thread.kind === "closed-order" ? null : refs.orderId;
  const base = p.stored ?? { tenant: p.tenant, ...EMPTY };
  const sameOrder = orderId !== null && base.orderId === orderId;
  const next: LegalBodyMemory = {
    tenant: p.tenant,
    companyId: refs.companyId,
    orderId,
    ownerChoice: sameOrder ? base.ownerChoice : null,
    agentId: sameOrder ? base.agentId : null,
    door: base.door,
    startAnother: p.intent,
  };
  const unchanged =
    sameAddress(base.tenant, next.tenant) &&
    base.companyId === next.companyId &&
    base.orderId === next.orderId &&
    base.ownerChoice === next.ownerChoice &&
    base.agentId === next.agentId &&
    base.door === next.door &&
    sameIntent(base.startAnother, next.startAnother);
  return unchanged ? null : next;
}

/** Two intents with the same values: a stored one read back is another object. */
function sameIntent(a: LegalBodyIntent | null, b: LegalBodyIntent | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "another-agent" && b.kind === "another-agent" && a.companyId !== b.companyId)
    return false;
  return a.known.length === b.known.length && a.known.every((id, i) => id === b.known[i]);
}

/**
 * The owner choice and the identity the derivation may read: only those made for this thread's
 * order. A choice made for an earlier order would otherwise skip the new one's agreement.
 */
export function draftChoices(
  memory: LegalBodyMemory | null,
  thread: LegalBodyThread,
): { ownerChoice: OwnerChoice | null; agentId: string | null } {
  if (memory && thread.kind === "order" && memory.orderId === thread.orderId)
    return { ownerChoice: memory.ownerChoice, agentId: memory.agentId };
  return { ownerChoice: null, agentId: null };
}

/**
 * A click that starts something new, held in the memory (`startAnother`, so a reload keeps it)
 * until what it starts exists:
 *  - `another-agent`: a new order on this company (the done page's first button, a closed order's
 *    way out); `known` is the orders there were at the click;
 *  - `another-company`: a new declaration; `known` is the companies there were at the click.
 */
export type LegalBodyIntent = StoredIntent;

/**
 * Whether what the intent started exists, so it no longer holds the thread:
 *  - `another-company`: a company exists that was not there at the click;
 *  - `another-agent`: its company is gone, or an order of it exists that was not there at the
 *    click.
 */
export function intentSpent(
  intent: LegalBodyIntent,
  p: { companies: CompanyView[]; orders: LegalBodyOrderView[] },
): boolean {
  if (intent.kind === "another-company")
    return p.companies.some((c) => !intent.known.includes(c.companyId));
  if (!p.companies.some((c) => c.companyId === intent.companyId)) return true;
  return p.orders.some((o) => o.companyId === intent.companyId && !intent.known.includes(o.id));
}

/**
 * The thread with the intent over it. The intent ends by itself once what it started exists, so
 * it can never hold a finished thread back:
 *  - `another-agent`: the company, until an order of it appears that was not there at the click;
 *    then that order while it is live on this deployment, and the selection once it is not (by
 *    then the memory names it, so its done page is the selection's);
 *  - `another-company`: a new declaration, until a company appears that was not there at the
 *    click; then the selection.
 */
export function threadWithIntent(
  thread: LegalBodyThread,
  intent: LegalBodyIntent | null,
  p: {
    companies: CompanyView[];
    orders: LegalBodyOrderView[];
    nowMs: number;
    where: { chainId: number; factory: Address };
  },
): LegalBodyThread {
  if (intent === null) return thread;
  if (!intentSpent(intent, p))
    return intent.kind === "another-company"
      ? { kind: "new-company" }
      : { kind: "company", companyId: intent.companyId };
  if (intent.kind === "another-company") return thread;
  if (!p.companies.some((c) => c.companyId === intent.companyId)) return thread;
  // Spent with its company there: an order of it appeared after the click.
  const newest = p.orders
    .filter((o) => o.companyId === intent.companyId && !intent.known.includes(o.id))
    .sort((a, b) => timeOf(b) - timeOf(a))[0];
  if (newest === undefined) return thread;
  const liveHere =
    newest.chainId === p.where.chainId &&
    sameAddress(newest.factory, p.where.factory) &&
    isLiveOrder(newest, p.nowMs);
  return liveHere ? { kind: "order", companyId: intent.companyId, orderId: newest.id } : thread;
}

/** A click that names the thread itself (a pick, a new company, a new order) ends any intent: the
 *  memory now says what the page is about. */
export function patchEndsIntent(patch: Partial<Memo>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(patch, "companyId") ||
    Object.prototype.hasOwnProperty.call(patch, "orderId")
  );
}

/** The intent the store keeps once a thread is on screen: the stored one while it is live, none
 *  once what it started exists (`intentSpent`). */
export function liveIntent(
  intent: LegalBodyIntent | null,
  p: { companies: CompanyView[]; orders: LegalBodyOrderView[] },
): LegalBodyIntent | null {
  return intent !== null && !intentSpent(intent, p) ? intent : null;
}

/**
 * The memory after a click's change: the patch over the base, for this tenant. A click that names
 * the thread (`patchEndsIntent`) ends any intent, and that end has the last word over the patch.
 */
export function memoryAfterClick(
  tenant: Address,
  base: LegalBodyMemory | null,
  patch: Partial<Memo>,
): LegalBodyMemory {
  const ended: Partial<Memo> = patchEndsIntent(patch) ? { startAnother: null } : {};
  return mergeLegalBodyMemory(tenant, base, { ...patch, ...ended });
}

/**
 * What a "start another" click remembers (`startAnother`), from the lists at the click:
 *  - `new_company`: no door chosen yet, so the choice of paths shows in place, and the companies
 *    there are;
 *  - `new_order`: the orders there are, for the company on screen; nothing with none on screen.
 * Neither names the thread, so neither ends the intent it starts.
 */
export function startAnotherPatch(
  kind: "new_order" | "new_company",
  p: { companyId: string | null; companies: CompanyView[]; orders: LegalBodyOrderView[] },
): Partial<Memo> {
  if (kind === "new_company")
    return {
      door: null,
      startAnother: { kind: "another-company", known: p.companies.map((c) => c.companyId) },
    };
  if (!p.companyId) return {};
  return {
    startAnother: {
      kind: "another-agent",
      companyId: p.companyId,
      known: p.orders.map((o) => o.id),
    },
  };
}

function timeOf(order: LegalBodyOrderView): number {
  const ms = Date.parse(order.createdAt);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * What a jump back on the rail changes in the memory before the derivation decides again: the
 * owner choice and the identity are the only local inputs, read while the order is a draft. Every
 * other phase is the server's: the jump re-renders and the derivation lands where the facts are.
 */
export function jumpMemoryPatch(target: LegalBodyRailPhase): Partial<Memo> | null {
  if (target === "agreement") return { ownerChoice: null, agentId: null };
  if (target === "identity") return { agentId: null };
  return null;
}

/**
 * What changes the identity the identity step offers again (`identitySuggestionAfter`):
 *  - `jump`: a jump on the rail, with the identity the memory held for this draft just before it;
 *  - `registered`: a registration on the identity step minted this identity;
 *  - `picked`: the person picked this identity on the identity step;
 *  - `dropped`: the identity step found this identity taken;
 *  - `start_another`: a new order or a new company starts;
 *  - `new_order_for`: the link door refused the draft and a new order starts for the same agent,
 *    with the identity the memory held for the refused draft.
 */
export type IdentitySuggestionEvent =
  | { kind: "jump"; target: LegalBodyRailPhase; agentId: string | null }
  | { kind: "registered"; agentId: string }
  | { kind: "picked"; agentId: string }
  | { kind: "dropped"; agentId: string }
  | { kind: "start_another" }
  | { kind: "new_order_for"; agentId: string | null };

/**
 * The identity the identity step offers first, held in this visit's memory only, never in the
 * store. A jump that clears the identity (`jumpMemoryPatch`) keeps it as the suggestion, so going
 * back never shows the register card as the only way on; a jump with nothing to clear keeps the
 * suggestion already there. A registration offers its new identity. Picking another identity, an
 * identity found taken, and a new order or company end it; a new order that replaces a draft the
 * link door refused offers that draft's identity again, since the door refused the draft, never
 * the identity. The suggestion is only an offer: the step reads the identity's owner and the
 * orders again before it is used.
 */
export function identitySuggestionAfter(
  event: IdentitySuggestionEvent,
  current: string | null,
): string | null {
  switch (event.kind) {
    case "jump": {
      const patch = jumpMemoryPatch(event.target);
      const clears = patch !== null && Object.prototype.hasOwnProperty.call(patch, "agentId");
      return clears ? (event.agentId ?? current) : current;
    }
    case "registered":
      return event.agentId;
    case "picked":
      return event.agentId === current ? current : null;
    case "dropped":
      return event.agentId === current ? null : current;
    case "start_another":
      return null;
    case "new_order_for":
      return event.agentId ?? current;
  }
}

/**
 * The flow's clock: the latest of the moment the screen mounted and each read of the server. A
 * draft's 24 hours are measured against it, so the time moves with every read (polling, focus, a
 * click's refetch) and no timer runs for it.
 */
export function flowNowMs(mountedAtMs: number, readAtMs: readonly number[]): number {
  return Math.max(mountedAtMs, ...readAtMs);
}

/* ── The chooser ───────────────────────────────────────────────────────────────────────────── */

export type ChooserRow = {
  key: string;
  ref: LegalBodyThreadRef;
  title: string;
  detail: string;
  identity: string | null;
};

/**
 * The name a legal body goes by in a list (the chooser, "My agents"): the company name its order
 * states, else the company's declared name, its filed name, its first name option; with none, the
 * unnamed words of its kind. An empty name counts as none, so a row is never titled with nothing.
 */
export function legalBodyTitle(p: {
  order: LegalBodyOrderView | null;
  company: CompanyView | null;
}): string {
  const C = LEGAL_BODY_COPY.chooser;
  const named =
    p.order?.companyName ||
    p.company?.declared?.companyName ||
    p.company?.legalNameFiled ||
    p.company?.nameOptions[0]?.name;
  if (named) return named;
  return isFormedCompany(p.company) ? C.formedUnnamed : C.unnamed;
}

/** One row per open thread: the declared name, and the state in words. */
export function chooserRows(
  threads: LegalBodyThreadRef[],
  companies: CompanyView[],
  orders: LegalBodyOrderView[],
): ChooserRow[] {
  const C = LEGAL_BODY_COPY.chooser;
  return threads.map((ref) => {
    const company = companies.find((c) => c.companyId === ref.companyId) ?? null;
    if (ref.kind === "company") {
      if (isFormedCompany(company)) {
        const state = company.state;
        const detail =
          state === "failed"
            ? C.formedFailed
            : state === "filed" || state === "complete"
              ? C.formedFiled
              : C.formedFiling;
        return {
          key: `company:${ref.companyId}`,
          ref,
          title: legalBodyTitle({ order: null, company }),
          detail,
          identity: null,
        };
      }
      return {
        key: `company:${ref.companyId}`,
        ref,
        title: legalBodyTitle({ order: null, company }),
        detail: C.companyRow,
        identity: null,
      };
    }
    const order = orders.find((o) => o.id === ref.orderId) ?? null;
    const state = order?.state;
    const detail =
      state === "draft" || state === "reserved" || state === "deployed" || state === "broken"
        ? C.orderStates[state]
        : C.orderStates.other;
    return {
      key: `order:${ref.orderId}`,
      ref,
      title: legalBodyTitle({ order, company }),
      detail,
      identity: order?.agentId ? fillCopy(C.identity, { agentId: order.agentId }) : null,
    };
  });
}
