"use client";

import { useState } from "react";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card, StepHeader } from "@/components/onboarding/primitives";
import type { PublicRead } from "@/lib/api/legalBodyClient";
import {
  useLegalBodyByAgentQuery,
  useOrderGrantQuery,
  useOrderPotQuery,
  usePotRawQuery,
} from "@/lib/api/legalBodyHooks";
import { formatDate } from "@/lib/format";
import { doneWalletCard, type DoneWalletCard } from "@/lib/legalBody/agentWalletStep";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { isFormedCompany } from "@/lib/legalBody/flow";
import { noticeSentence } from "@/lib/legalBody/notice";
import { potAddresses } from "@/lib/legalBody/safePot";
import { potCeilingCapFromGrant, potReading } from "@/lib/legalBody/safePotRules";
import {
  potExitAt,
  potExitOffers,
  potReadsAllowed,
  potRecordWallet,
  type PotCardShown,
} from "@/lib/legalBody/safePotRun";
import { notedPotChecked, potCard } from "@/lib/legalBody/safePotStep";
import { publicReadAllowed, publicRecordOf } from "@/lib/legalBody/standing";
import { AgentWalletStep } from "./AgentWalletStep";
import { LegalBodyRecord } from "./LegalBodyRecord";
import { PotManage, PotTakeOffCard, usePotCardLock } from "./PotManage";
import { PotCardView } from "./PotPanels";
import { PotStep } from "./PotStep";
import type {
  CompanyView,
  LegalBodyByAgent,
  LegalBodyOrderView,
  OrderPotView,
} from "@/lib/api/types";
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
 *
 * Under it, the company's pot (`DonePot`): its card where `/config.legalBodies.pot` is true, and
 * wherever the server says a pot is on the record, at least the way to take it off (Ruling R24).
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
      {order !== null && (
        <DonePot
          kit={kit}
          order={order}
          read={byAgent.data}
          refetchRecord={() => void byAgent.refetch()}
        />
      )}
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

/**
 * "Give your agent an allowance", and once it exists, the company's pot as read. The card reads
 * only where `/config.legalBodies.pot` is true, for a linked order of this chain with no notice
 * beside it (`potReadsAllowed`): the grant from the server, and, for a noted pot, its raw facts
 * from the chain for the record's agent wallet. The noted pot itself (`GET /pot`) is read for
 * every order (Ruling R24): a pot the server says is on the record can always be taken off it, so
 * wherever nothing else is shown the page shows `PotTakeOffCard`, the pot's address and the take
 * off. Each is read once as the page shows it, and again after a transaction (`reread`). One lock
 * for the card (`usePotCardLock`): one action at a time (Ruling R25).
 *
 * Ruling R32: the noted pot is read on the chain, and acted on, ONLY at the address the browser
 * recomputes from its own birth details and the order's guardian (`notedPotChecked`), and only
 * when that is the address noted, in any letter case. Otherwise the page says the address is not
 * a pot only the guardian's wallet owns and offers no wallet action (no setup, no money, no Safe
 * action, no exit): only the take off, while it is on the record.
 *
 * Ruling R33: wherever the full card is not shown (`potExitAt`: the flag off, a revoked or
 * unlinked order, a notice, another deployment on this chain, a record naming no wallet of the
 * agent's own), the EXIT CARD reads the recomputed pot on the chain whatever the flag, and offers
 * what `potExitOffers` gives: Stop the allowance, Take the money back, and the take off. Until it
 * is read, or when it offers nothing, the take off stands alone as before; a read that failed says
 * so with Try again beside it.
 *
 * `potCard` decides: nothing; the card while a read is out; the offer, whose click opens the setup
 * step here, in place, where it stays from then on; or the pot's own card (`PotManage`): what the
 * chain shows, and the guardian's actions on the same pot, each read again in its click. A read
 * that failed says so with Try again, never a spinner for ever. A record read that names no agent
 * wallet of its own shows nothing of the card (the wallet card speaks then), only the take off of a
 * pot on the record.
 */
function DonePot({
  kit,
  order,
  read,
  refetchRecord,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  read: PublicRead<LegalBodyByAgent> | undefined;
  refetchRecord: () => void;
}) {
  const { config } = kit;
  const notice = kit.derivation.notice;
  const potOffered = config.pot === true;
  const allowed = potReadsAllowed({ potOffered, chainId: config.chainId, order, notice });
  const record = publicRecordOf(read);
  const wallet = potRecordWallet(record, order.guardian);
  // Ruling R24: for every order, so a pot on the record can always be taken off it.
  const potQuery = useOrderPotQuery(order.id, true);
  const grantQuery = useOrderGrantQuery(order.id, allowed);
  // undefined while it is read, null for no note.
  const served = potQuery.data === undefined ? undefined : potQuery.data.pot;
  const a = potAddresses(config.chainId);
  // Ruling R32: the address the browser recomputes from the note's own birth details; the note is
  // read, and acted on, only at it.
  const verified = a !== null && served ? notedPotChecked(a, order.guardian, served) : null;
  const notYours = a !== null && served !== null && served !== undefined && verified === null;
  const noted: OrderPotView | null | undefined =
    served && verified !== null ? { ...served, address: verified } : served;
  // Ruling R33: where the full card is not, the exit card reads the pot whatever the flag.
  const exitAt = notYours
    ? null
    : potExitAt({
        potOffered,
        chainId: config.chainId,
        order,
        notice,
        record,
        recordRead: read !== undefined,
        noted,
      });
  const rawPot = exitAt !== null ? exitAt.pot : allowed && verified !== null ? verified : null;
  const rawKey = exitAt !== null ? exitAt.agentWallet : allowed ? wallet : null;
  const rawQuery = usePotRawQuery(config.chainId, rawPot, rawKey);
  const [open, setOpen] = useState(false);
  const lock = usePotCardLock();

  const raw = rawPot !== null ? rawQuery.data : undefined;
  const reading =
    raw !== undefined && a !== null && rawKey !== null
      ? potReading(raw, { addresses: a, guardian: order.guardian, agentWallet: rawKey })
      : null;
  const cap =
    grantQuery.data !== undefined
      ? potCeilingCapFromGrant(grantQuery.data.grant)
      : grantQuery.isError
        ? "unreadable"
        : null;
  const card = potCard({
    potOffered,
    chainId: config.chainId,
    order,
    notice,
    record,
    noted,
    reading,
    cap,
  });
  const reread = () => {
    void potQuery.refetch();
    if (rawPot !== null) void rawQuery.refetch();
    refetchRecord();
  };
  // Ruling R24: a pot the server says is on the record, never one the chain shows was never
  // created (the offer then sets it up at that address), keeps its take off wherever the full
  // card is not shown.
  const takeOff =
    noted && noted.onRecord === true && reading?.state !== "absent" ? (
      <PotTakeOffCard kit={kit} order={order} noted={noted} lock={lock} onChanged={reread} />
    ) : null;
  // Ruling R32: a noted address its birth details do not predict: no wallet action of any kind.
  if (notYours && served)
    return (
      <PotTakeOffCard kit={kit} order={order} noted={served} lock={lock} onChanged={reread} notYours />
    );
  // Ruling R33: the exit card, once the pot reads as the guardian's alone with something to offer.
  if (exitAt !== null) {
    const offers =
      raw !== undefined && reading !== null && noted
        ? potExitOffers(raw, reading, {
            chainId: config.chainId,
            guardian: order.guardian,
            onRecord: noted.onRecord === true,
          })
        : null;
    if (offers !== null && raw !== undefined && reading !== null && noted)
      return (
        <PotManage
          kit={kit}
          order={order}
          noted={noted}
          agentWallet={exitAt.agentWallet}
          raw={raw}
          reading={reading}
          nowSeconds={Math.floor(rawQuery.dataUpdatedAt / 1000)}
          lock={lock}
          onChanged={reread}
          exit={offers}
        />
      );
    // Its read failed: the card says so with Try again, as the full card does; the take off stays.
    if (rawQuery.isError)
      return (
        <>
          <PotCardView
            shown={{ kind: "unreadable" }}
            onOpen={() => {}}
            onRetry={reread}
            retrying={potQuery.isFetching || rawQuery.isFetching}
          />
          {takeOff}
        </>
      );
    return takeOff;
  }
  if (!allowed) return takeOff;
  // The record has been read and names no wallet of the agent's own, or the order is not one for
  // the pot: nothing of it here but the take off.
  if (card === "hidden" || (read !== undefined && wallet === null)) return takeOff;

  const failed = (noted === undefined && potQuery.isError) || (rawPot !== null && rawQuery.isError);

  const step = open && wallet !== null && (
    <Card className="mb-6 p-6">
      <PotStep kit={kit} order={order} agentWallet={wallet} onCreated={reread} />
    </Card>
  );
  if (!failed && card === "manage" && reading !== null && raw !== undefined && noted && wallet !== null)
    return (
      <>
        {step}
        <PotManage
          kit={kit}
          order={order}
          noted={noted}
          agentWallet={wallet}
          raw={raw}
          reading={reading}
          // The time the pot was read: what is left is said of the period it was read in.
          nowSeconds={Math.floor(rawQuery.dataUpdatedAt / 1000)}
          lock={lock}
          onChanged={reread}
        />
      </>
    );

  let shown: Exclude<PotCardShown, { kind: "hidden" }> | null;
  if (failed) shown = { kind: "unreadable" };
  // While the step is open it is the offer, and its own reads speak for it.
  else if (open) shown = null;
  else shown = card === "offer" ? { kind: "offer" } : { kind: "checking" };

  return (
    <>
      {step}
      {shown && (
        <PotCardView
          shown={shown}
          onOpen={() => setOpen(true)}
          onRetry={reread}
          retrying={potQuery.isFetching || rawQuery.isFetching}
        />
      )}
      {/* The chain could not be read: the pot on the record can still be taken off it. */}
      {failed && takeOff}
    </>
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
