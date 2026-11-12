"use client";

import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, StepHeader } from "@/components/onboarding/primitives";
import { useLegalBodyByAgentQuery } from "@/lib/api/legalBodyHooks";
import { formatDate } from "@/lib/format";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { isFormedCompany } from "@/lib/legalBody/flow";
import { noticeSentence } from "@/lib/legalBody/notice";
import { publicReadAllowed } from "@/lib/legalBody/standing";
import { LegalBodyRecord } from "./LegalBodyRecord";
import type { CompanyView } from "@/lib/api/types";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const D = LEGAL_BODY_COPY.done;

/**
 * Done: the body's public record, the thread's notice when it has one, and what to do next.
 *
 * The public by-agent answer is read only for a linked order (`publicReadAllowed`): there is no
 * public link before it. It is never polled and never retried on its own; Try again reads it once
 * more, on a click. The two ways on set the shell's intents: a new order on the same company, or a
 * new declaration. Nothing here writes.
 */
export function DoneStep({ kit }: { kit: LegalBodyStepKit }) {
  const order = kit.order;
  const formed = isFormedCompany(kit.company);
  const byAgent = useLegalBodyByAgentQuery(order?.agentId, publicReadAllowed(order));
  const notice = kit.derivation.notice
    ? noticeSentence(kit.derivation.notice, kit.config.environment)
    : null;

  return (
    <div>
      <StepHeader eyebrow={LEGAL_BODY_COPY.rail.labels.done} title={D.title} intro={D.intro} />
      {notice && (
        <Callout tone="warn" title={notice.title} className="mb-6">
          {notice.body}
        </Callout>
      )}
      {formed && kit.company && <FormedCompanyBlock company={kit.company} />}
      {order && (
        <LegalBodyRecord
          read={byAgent.data ?? null}
          orderState={order.state}
          environment={kit.config.environment}
          paymentRequired={kit.config.paymentRequired}
          onRetry={() => void byAgent.refetch()}
          retrying={byAgent.isFetching}
        />
      )}
      <StepNav>
        <Button onClick={() => kit.startAnother("new_order")}>{D.anotherAgent}</Button>
        <Button variant="ghost" onClick={() => kit.startAnother("new_company")}>
          {formed ? D.anotherFormed : D.anotherCompany}
        </Button>
      </StepNav>
    </div>
  );
}

function FormedCompanyBlock({ company }: { company: CompanyView }) {
  const date = company.filedAt != null ? formatDate(company.filedAt * 1000) : null;
  const line =
    date === null
      ? null
      : company.filingNumber
        ? fillCopy(D.formedBy, { date, number: company.filingNumber })
        : fillCopy(D.formedByNoNumber, { date });
  const supplement = company.daoSupplement;
  return (
    <Card className="mb-6 p-6">
      {line && <p className="text-[13.5px] leading-[1.6] text-ink">{line}</p>}
      {supplement && (
        <p className="mt-2 text-[13px] leading-[1.6] text-muted">
          {fillCopy(D.daoSupplement, { date: formatDate(supplement.recordedAt * 1000) })}
        </p>
      )}
    </Card>
  );
}
