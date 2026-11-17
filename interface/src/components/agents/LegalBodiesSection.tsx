"use client";

import Link from "next/link";
import { useState } from "react";
import { LoadingState } from "@/components/agents/RequireAuth";
import { StandingPill } from "@/components/legalBody/LegalBodyRecord";
import { Button } from "@/components/onboarding/primitives";
import { useCompaniesQuery } from "@/lib/api/hooks";
import {
  useLegalBodyByAgentQuery,
  useLegalBodyConfig,
  useLegalBodyOrdersQuery,
} from "@/lib/api/legalBodyHooks";
import { legalBodiesView, type AccountRow, type LegalBodiesView } from "@/lib/legalBody/accountRows";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { flowNowMs } from "@/lib/legalBody/resume";
import { standingPresentation } from "@/lib/legalBody/standing";

const A = LEGAL_BODY_COPY.account;

/** The state word's tone: amber only where something needs the person. */
const STATE_CLASS: Record<AccountRow["state"], string> = {
  in_progress: "text-muted",
  linked: "text-ink",
  attention: "text-[#f3cd72]",
};

/**
 * The account's legal bodies: the orders and the companies, read once for the page. The clock is
 * the flow's (the mount, moved by each read), so a draft's 24 hours are measured the way the flow
 * measures them. Try again reads both lists again.
 */
export function useAccountLegalBodies(): {
  view: LegalBodiesView;
  retry: () => void;
  retrying: boolean;
} {
  const ordersQuery = useLegalBodyOrdersQuery();
  const companiesQuery = useCompaniesQuery();
  const { config } = useLegalBodyConfig();
  const [mountedAt] = useState(() => Date.now());
  const nowMs = flowNowMs(mountedAt, [ordersQuery.dataUpdatedAt, companiesQuery.dataUpdatedAt]);
  const view = legalBodiesView({
    orders: { data: ordersQuery.data, error: ordersQuery.error },
    companies: { data: companiesQuery.data, error: companiesQuery.error },
    config,
    nowMs,
  });
  return {
    view,
    retry: () => {
      void ordersQuery.refetch();
      void companiesQuery.refetch();
    },
    retrying: ordersQuery.isFetching || companiesQuery.isFetching,
  };
}

/**
 * "Legal bodies" on "My agents". No section for an account the real-human check does not accept,
 * for a deployment with no legal bodies, and for an account with none; one line with a retry when
 * the lists could not be read; otherwise one link per legal body into the flow.
 */
export function LegalBodiesSection({
  view,
  onRetry,
  retrying,
}: {
  view: LegalBodiesView;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (view.kind === "hidden") return null;
  if (view.kind === "loading") return <LoadingState />;
  if (view.kind === "rows" && view.rows.length === 0) return null;

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-[15px] font-medium text-ink">{A.legalBodies}</h2>
      {view.kind === "unreadable" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border hairline bg-paper/40 px-5 py-4">
          <p className="text-[13px] text-[#ff8a84]">{A.unreadable}</p>
          <Button variant="ghost" onClick={onRetry} loading={retrying}>
            {LEGAL_BODY_COPY.done.retry}
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.rows.map((row) => (
            <li key={row.key}>
              <LegalBodyRow row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LegalBodyRow({ row }: { row: AccountRow }) {
  return (
    <Link
      href={row.href}
      className="block rounded-xl border hairline bg-paper/40 px-5 py-4 transition-colors hover:bg-paper-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[14px] text-ink">{row.title}</span>
        <span className="text-[12px] text-muted">{A.actions[row.action]}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-2">
        {row.agentId !== null && (
          <>
            <span>{fillCopy(A.agent, { agentId: row.agentId })}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span className={STATE_CLASS[row.state]}>{A.states[row.state]}</span>
        {row.standing && row.agentId !== null && <RowStanding agentId={row.agentId} />}
      </div>
    </Link>
  );
}

/**
 * The public standing of a linked row, read the way the done page reads it: the by-agent answer
 * as served (`data`, or nothing yet), never polled and never retried on its own. Nothing shows
 * until the read is back. Only the pill is shown, whose words and tone the deployment's
 * environment and payment flag do not change.
 */
function RowStanding({ agentId }: { agentId: string }) {
  const byAgent = useLegalBodyByAgentQuery(agentId, true);
  const { config } = useLegalBodyConfig();
  if (byAgent.isPending) return null;
  const standing = standingPresentation({
    read: byAgent.data ?? null,
    orderState: "linked",
    environment: config?.available === true ? config.environment : "production",
    paymentRequired: config?.available === true && config.paymentRequired === true,
  });
  return <StandingPill standing={standing} size="sm" />;
}
