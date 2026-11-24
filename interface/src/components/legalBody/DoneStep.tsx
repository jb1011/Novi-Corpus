"use client";

import { useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, StepHeader } from "@/components/onboarding/primitives";
import { useLegalBodyByAgentQuery } from "@/lib/api/legalBodyHooks";
import { formatDate } from "@/lib/format";
import { doneWalletCard, type DoneWalletCard } from "@/lib/legalBody/agentWalletStep";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { isFormedCompany } from "@/lib/legalBody/flow";
import { noticeSentence } from "@/lib/legalBody/notice";
import { publicReadAllowed, publicRecordOf } from "@/lib/legalBody/standing";
import { AgentWalletStep } from "./AgentWalletStep";
import { LegalBodyRecord } from "./LegalBodyRecord";
import type { CompanyView } from "@/lib/api/types";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const D = LEGAL_BODY_COPY.done;
const AW = LEGAL_BODY_COPY.agentWallet;

const CARD_LINES: Record<DoneWalletCard, string> = {
  guardian: AW.doneLine,
  none: AW.doneLineNone,
};

/**
 * Done: the body's public record, the thread's notice when it has one, and what to do next.
 *
 * The public by-agent answer is read only for a linked order (`publicReadAllowed`): there is no
 * public link before it. It is never polled and never retried on its own; Try again reads it once
 * more, on a click. The two ways on set the shell's intents: a new order on the same company, or a
 * new declaration. Nothing on this page writes; the wallet step below, once opened, sends its one
 * transaction through the allowlist on its own click.
 *
 * A body linked before the agent's wallet rule may have an identity that still names the guardian's
 * own wallet, or none. For a linked, not revoked order with no notice beside it, whose record was
 * read and says so (`doneWalletCard`, against the order's own guardian), a card above the record
 * says it; a click on the card opens the agent's wallet step here, in place, in its "linked" mode,
 * and the step stays open from then on. The record and its standing are left as they are.
 */
export function DoneStep({ kit }: { kit: LegalBodyStepKit }) {
  const order = kit.order;
  const formed = isFormedCompany(kit.company);
  const byAgent = useLegalBodyByAgentQuery(order?.agentId, publicReadAllowed(order));
  const notice = kit.derivation.notice
    ? noticeSentence(kit.derivation.notice, kit.config.environment)
    : null;
  // The agent's wallet step, opened by a click on the card; never by itself.
  const [walletOpen, setWalletOpen] = useState(false);
  const walletAgentId =
    order !== null && order.state === "linked" && !order.revoked ? order.agentId : null;
  const walletCard =
    order !== null && walletAgentId !== null
      ? doneWalletCard(publicRecordOf(byAgent.data), order.guardian, kit.derivation.notice)
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
      {walletAgentId !== null &&
        (walletOpen ? (
          <Card className="mb-6 p-6">
            <AgentWalletStep kit={kit} agentId={walletAgentId} mode="linked" />
          </Card>
        ) : (
          walletCard && <WalletCard card={walletCard} onOpen={() => setWalletOpen(true)} />
        ))}
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

/** "Set your agent's wallet", and what the record names today: the whole card is the button that
 *  opens the step. */
function WalletCard({ card, onOpen }: { card: DoneWalletCard; onOpen: () => void }) {
  return (
    <Card className="mb-6 overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="block w-full cursor-pointer px-6 py-5 text-left transition-colors hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <span className="block text-[14px] font-medium text-ink">{AW.doneTitle}</span>
        <span className="mt-1 block text-[13px] leading-[1.6] text-[#f3cd72]">{CARD_LINES[card]}</span>
      </button>
    </Card>
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
