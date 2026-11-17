/**
 * "My agents": the account's legal bodies as rows, and what the page shows around them.
 *
 * A row is one legal body the person can still move or open, and it links into the legal-body
 * flow by its order (`?order=`) or its company (`?company=`), which the flow opens once the person
 * is past its gates. The flow decides what the linked screen is; a row only says where it stands
 * in one word and whether it is continued or opened.
 *
 * Pure: the time comes in as `nowMs`, and the two lists as the server served them.
 */
import {
  ApiError,
  type CompanyView,
  type EntityView,
  type LegalBodyConfig,
  type LegalBodyOrderView,
} from "@/lib/api/types";
import { isContinuable, isFinished, isLiveOrder } from "@/lib/legalBody/flow";
import { legalBodyTitle } from "@/lib/legalBody/resume";
import type { FullProductGate } from "@/lib/start/paths";

export type AccountRow = {
  key: string;
  href: string;
  title: string;
  agentId: string | null;
  state: "in_progress" | "linked" | "attention";
  action: "continue" | "open";
  /** The public standing may be read for this row. */
  standing: boolean;
};

/** The public standing is read for this many linked rows at most: the public read is rate
 *  limited, and a long list must not spend it. */
export const STANDING_READS = 5;

/** For ordering only: a time that cannot be read sorts oldest. */
function sortTime(ms: number): number {
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * The account's legal-body rows:
 *  - an order whose company is not among the account's is ignored;
 *  - a live order is in progress, or needs attention when its pointer was cleared, and is
 *    continued; a linked order is linked and opened; another finished one needs attention and is
 *    opened; every other order (an expired or revoked draft, a lapse, a supersession, a
 *    replacement, an abandonment) has no row;
 *  - a company the flow can continue from, with no live and no linked order, is in progress and
 *    continued by its company.
 * Rows that are not linked come first, then the newest; the first `STANDING_READS` linked rows
 * with an identity may read their public standing.
 */
export function accountLegalBodyRows(p: {
  companies: CompanyView[];
  orders: LegalBodyOrderView[];
  nowMs: number;
}): AccountRow[] {
  const byId = new Map(p.companies.map((c) => [c.companyId, c]));
  const orders = p.orders.filter((o) => byId.has(o.companyId));
  const live = (o: LegalBodyOrderView) => isLiveOrder(o, p.nowMs);
  const found: { row: AccountRow; time: number }[] = [];

  for (const order of orders) {
    let state: AccountRow["state"];
    let action: AccountRow["action"];
    if (live(order)) {
      state = order.state === "broken" ? "attention" : "in_progress";
      action = "continue";
    } else if (order.state === "linked") {
      state = "linked";
      action = "open";
    } else if (isFinished(order)) {
      state = "attention";
      action = "open";
    } else {
      continue;
    }
    found.push({
      row: {
        key: `order:${order.id}`,
        href: `/legal-body?order=${encodeURIComponent(order.id)}`,
        title: legalBodyTitle({ order, company: byId.get(order.companyId) ?? null }),
        agentId: order.agentId,
        state,
        action,
        standing: false,
      },
      time: sortTime(Date.parse(order.createdAt)),
    });
  }

  for (const company of p.companies) {
    if (!isContinuable(company)) continue;
    const taken = orders.some(
      (o) => o.companyId === company.companyId && (live(o) || o.state === "linked"),
    );
    if (taken) continue;
    found.push({
      row: {
        key: `company:${company.companyId}`,
        href: `/legal-body?company=${encodeURIComponent(company.companyId)}`,
        title: legalBodyTitle({ order: null, company }),
        agentId: null,
        state: "in_progress",
        action: "continue",
        standing: false,
      },
      time: sortTime(company.createdAt),
    });
  }

  const rank = (row: AccountRow) => (row.state === "linked" ? 1 : 0);
  const sorted = found
    .sort((a, b) => rank(a.row) - rank(b.row) || b.time - a.time)
    .map((f) => f.row);
  let reads = 0;
  return sorted.map((row) => {
    if (row.state !== "linked" || row.agentId === null || reads >= STANDING_READS) return row;
    reads += 1;
    return { ...row, standing: true };
  });
}

/** What the legal-body section shows: nothing, a loading line, one unreadable line with its
 *  retry, or the rows (none at all is no section either). */
export type LegalBodiesView =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "unreadable" }
  | { kind: "rows"; rows: AccountRow[] };

/** A list query as the section reads it. */
type ListRead<T> = { data: T | undefined; error: unknown };

/**
 * The section, from the two lists:
 *  - a deployment that says it has no legal bodies (`available: false`), and an orders list that
 *    answers 403 (an account the real-human check does not accept): no section;
 *  - both lists read: the rows, kept through a failed refresh;
 *  - any other error on either list: one line with a retry;
 *  - otherwise loading.
 */
export function legalBodiesView(p: {
  orders: ListRead<{ orders: LegalBodyOrderView[] }>;
  companies: ListRead<{ companies: CompanyView[] }>;
  /** The deployment's `/config.legalBodies`, or null while it is not read. */
  config: LegalBodyConfig | null;
  nowMs: number;
}): LegalBodiesView {
  if (p.config?.available === false) return { kind: "hidden" };
  if (p.orders.error instanceof ApiError && p.orders.error.status === 403) return { kind: "hidden" };
  if (p.orders.data && p.companies.data) {
    return {
      kind: "rows",
      rows: accountLegalBodyRows({
        companies: p.companies.data.companies,
        orders: p.orders.data.orders,
        nowMs: p.nowMs,
      }),
    };
  }
  if (p.orders.error || p.companies.error) return { kind: "unreadable" };
  return { kind: "loading" };
}

/** The treasury section: no section, a loading line, the list's error, the cards, or the line
 *  that there is none yet. */
export type TreasuryView = "hidden" | "loading" | "unreadable" | "cards" | "none";

/**
 * The page around the legal bodies:
 *  - the treasury section shows the cards whenever the person has an agent with a treasury; with
 *    none known, it shows (loading, its error, or none yet) only where the deployment says it
 *    offers the full product, and never beside the empty card;
 *  - the empty card shows when both lists are known to be empty: no legal-body row (or no
 *    section) and an entity list read as empty. A list not read, or that could not be read, never
 *    makes the page say there is nothing.
 */
export function agentsPageView(p: {
  legalBodies: LegalBodiesView;
  entities: ListRead<EntityView[]>;
  gate: FullProductGate;
}): { treasury: TreasuryView; empty: boolean } {
  const count = p.entities.data?.length;
  const noLegalBody =
    p.legalBodies.kind === "hidden" ||
    (p.legalBodies.kind === "rows" && p.legalBodies.rows.length === 0);
  const empty = noLegalBody && count === 0;
  if (count !== undefined && count > 0) return { treasury: "cards", empty };
  if (p.gate !== "offered" || empty) return { treasury: "hidden", empty };
  if (count === 0) return { treasury: "none", empty };
  return { treasury: p.entities.error ? "unreadable" : "loading", empty };
}
