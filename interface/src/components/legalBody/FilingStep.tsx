"use client";

import Link from "next/link";
import { useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, Spinner, StepHeader } from "@/components/onboarding/primitives";
import { useCompanyQuery } from "@/lib/api/hooks";
import { useAbandonCompanyMutation } from "@/lib/api/legalBodyHooks";
import { ApiError, type CompanyDetailView } from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const F = LEGAL_BODY_COPY.filing;

/**
 * The filing screen. It reads the company again while the filing is open, and on focus.
 * A filed company leaves this phase on its own. Failed offers the company page and abandon.
 */
export function FilingStep({ kit }: { kit: LegalBodyStepKit }) {
  const query = useCompanyQuery(kit.companyId, { pollWhileFiling: true });
  const company = query.data ?? null;
  const days = kit.config.filingWorkingDays ?? 5;
  const abandon = useAbandonCompanyMutation();
  const [said, setSaid] = useState<string | null>(null);

  async function giveUp() {
    if (!kit.companyId || abandon.isPending) return;
    setSaid(null);
    try {
      await abandon.mutateAsync(kit.companyId);
    } catch (e) {
      setSaid(e instanceof ApiError ? e.message : "The company could not be given up.");
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.filing}
        title={F.title}
        intro={fillCopy(F.waiting, { days: String(days) })}
      />
      {kit.config.environment === "sandbox" && (
        <Callout tone="warn" className="mb-6">
          {F.sandbox}
        </Callout>
      )}
      {query.isPending && !company && (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {LEGAL_BODY_COPY.frame.loading}
        </div>
      )}
      {company && <FilingBody company={company} />}
      {company?.state === "failed" && kit.companyId && (
        <div className="mt-6 flex flex-col gap-3">
          <Link href={`/agents/companies/${kit.companyId}`} className="text-[13px] text-accent">
            {F.fix}
          </Link>
          <p className="text-[12.5px] leading-[1.6] text-muted">{F.refund}</p>
        </div>
      )}
      {said && (
        <Callout tone="warn" className="mt-6">
          {said}
        </Callout>
      )}
      {company?.state === "failed" && (
        <StepNav>
          <Button variant="ghost" onClick={() => void giveUp()} loading={abandon.isPending}>
            {F.abandon}
          </Button>
        </StepNav>
      )}
      {(company?.state === "filed" || company?.state === "complete") && (
        <StepNav>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            {F.filed}
          </Button>
        </StepNav>
      )}
    </div>
  );
}

function FilingBody({ company }: { company: CompanyDetailView }) {
  const actions = company.requiredActions.filter((action) => action.trim().length > 0);
  if (actions.length === 0) return null;
  return (
    <Card className="p-6">
      <p className="text-[13px] text-ink">{F.actions}</p>
      <ul className="mt-3 flex flex-col gap-2 text-[13px] leading-[1.6] text-muted">
        {actions.map((action) => (
          <li key={action}>{action}</li>
        ))}
      </ul>
    </Card>
  );
}
