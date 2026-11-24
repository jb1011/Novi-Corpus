"use client";

import Link from "next/link";
import { useEntitiesQuery, usePublicConfigQuery } from "@/lib/api/hooks";
import { AgentShell } from "@/components/agents/AgentShell";
import { AgentCards } from "@/components/agents/AgentCards";
import { LegalBodiesSection, useAccountLegalBodies } from "@/components/agents/LegalBodiesSection";
import { LoadingState, RequireAuth } from "@/components/agents/RequireAuth";
import { Button, Card } from "@/components/onboarding/primitives";
import { agentsPageView } from "@/lib/legalBody/accountRows";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { fullProductGate } from "@/lib/start/paths";

const A = LEGAL_BODY_COPY.account;

export default function AgentsPage() {
  return (
    <RequireAuth>
      <AgentsList />
    </RequireAuth>
  );
}

/**
 * "My agents": the account's legal bodies, then its agents with a treasury where it has some, where
 * the deployment offers the full product, or where their list could not be read (`agentsPageView`).
 * One "Add" opens the start, where every path begins. Each list keeps its own loading and its own
 * error with a retry, so one that cannot be read never hides the other.
 */
function AgentsList() {
  const legalBodies = useAccountLegalBodies();
  const entitiesQuery = useEntitiesQuery();
  const { data: config } = usePublicConfigQuery();
  const page = agentsPageView({
    legalBodies: legalBodies.view,
    entities: { data: entitiesQuery.data, error: entitiesQuery.error },
    gate: fullProductGate(config),
  });
  const entities = entitiesQuery.data ?? [];

  return (
    <AgentShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[22px] font-medium text-ink">Your agents</h1>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/agents/connect"
            className="inline-flex h-10 items-center rounded-full border hairline-strong bg-paper/40 px-5 text-[13px] font-medium leading-none text-ink hover:bg-paper-2"
          >
            Connect an agent
          </Link>
          <Link
            href="/start"
            className="inline-flex h-10 items-center rounded-full border border-transparent bg-ink px-5 text-[13px] font-medium leading-none text-paper hover:bg-ink-hover"
          >
            {A.add}
          </Link>
        </div>
      </div>

      <LegalBodiesSection
        view={legalBodies.view}
        onRetry={legalBodies.retry}
        retrying={legalBodies.retrying}
      />

      {page.treasury !== "hidden" && (
        <section>
          <h2 className="mb-3 text-[15px] font-medium text-ink">{A.treasuryAgents}</h2>
          {page.treasury === "cards" ? (
            <AgentCards entities={entities} />
          ) : page.treasury === "loading" ? (
            <LoadingState label="Loading agents…" />
          ) : page.treasury === "unreadable" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border hairline bg-paper/40 px-5 py-4">
              <p className="text-[13px] text-[#ff8a84]">{A.treasuryUnreadable}</p>
              <Button
                variant="ghost"
                onClick={() => void entitiesQuery.refetch()}
                loading={entitiesQuery.isFetching}
              >
                {LEGAL_BODY_COPY.done.retry}
              </Button>
            </div>
          ) : (
            <p className="text-[13px] text-muted">{A.treasuryNone}</p>
          )}
        </section>
      )}

      {page.empty && (
        <Card className="p-10 text-center">
          <h2 className="text-[20px] font-medium text-ink">{A.emptyTitle}</h2>
          <p className="mt-2 text-[13px] text-muted">{A.emptyBody}</p>
          <div className="mt-6 flex justify-center">
            <Link
              href="/start"
              className="inline-flex rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink-hover"
            >
              {A.getStarted}
            </Link>
          </div>
        </Card>
      )}
    </AgentShell>
  );
}
