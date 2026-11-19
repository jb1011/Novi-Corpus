"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Card, StepHeader, cx } from "@/components/onboarding/primitives";
import { fillCopy } from "@/lib/legalBody/copy";
import { START_COPY } from "@/lib/start/copy";
import type { PathCard, PathFacts, PathId } from "@/lib/start/paths";

const C = START_COPY.cards;

/**
 * The choice of paths: one card per path this deployment offers, one Continue.
 *
 * Presentational. The cards are `pathCards`' answer and the facts `pathFacts`', so each line on a
 * card stands on one explicit value from `/config`: a price only where the deployment charges and
 * names its fee, "no payment" only on a testnet that charges nothing, a time from the filing
 * estimate. A form card whose places are all taken stays on screen, cannot be picked, and links to
 * the early-access list. What every path needs is said once, under the cards.
 *
 * The cards are native radios in one group, so the arrow keys move between them. A pick that is
 * not an offered card counts as none: Continue waits for a real one, and while `busy`.
 */
export function PathChoice({
  cards,
  initial,
  facts,
  busy = false,
  onContinue,
  back,
}: {
  cards: readonly PathCard[];
  initial: PathId | null;
  facts: PathFacts;
  busy?: boolean;
  onContinue: (path: PathId) => void;
  /** A quiet way back, under the cards; the start page passes none. */
  back?: { href: string; label: string };
}) {
  const [picked, setPicked] = useState<PathId | null>(initial);
  const selected =
    picked !== null && cards.some((card) => card.id === picked && card.state === "offered")
      ? picked
      : null;
  const group = useId();

  return (
    <div>
      <StepHeader eyebrow={START_COPY.eyebrow} title={START_COPY.title} />
      <fieldset>
        <legend className="sr-only">{START_COPY.title}</legend>
        <ul className="flex flex-col gap-4">
          {cards.map((card) => (
            <li key={card.id}>
              <PathOption
                group={group}
                name={`${group}-path`}
                card={card}
                facts={facts}
                checked={selected === card.id}
                onPick={() => setPicked(card.id)}
              />
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="mt-6 text-[12.5px] leading-[1.6] text-muted">{START_COPY.needs}</p>
      <StepNav>
        {back && (
          <Link
            href={back.href}
            className="rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
          >
            {back.label}
          </Link>
        )}
        <Button
          disabled={selected === null}
          loading={busy}
          onClick={() => {
            if (selected !== null) onContinue(selected);
          }}
        >
          {START_COPY.continue}
        </Button>
      </StepNav>
    </div>
  );
}

function PathOption({
  group,
  name,
  card,
  facts,
  checked,
  onPick,
}: {
  group: string;
  /** The radio group's name, one per choice on the page. */
  name: string;
  card: PathCard;
  facts: PathFacts;
  checked: boolean;
  onPick: () => void;
}) {
  const offered = card.state === "offered";
  const titleId = `${group}-${card.id}-title`;
  const tagId = `${group}-${card.id}-tag`;
  const detailId = `${group}-${card.id}-detail`;
  const { title, tag, body, lines } = cardWords(card.id, facts);

  const content = (
    <Card
      className={cx(
        "flex items-start gap-4 p-5 transition-colors",
        offered && "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/60",
        checked && "ring-1 ring-accent/60",
      )}
    >
      <input
        type="radio"
        name={name}
        value={card.id}
        checked={checked}
        disabled={!offered}
        onChange={onPick}
        aria-labelledby={tag ? `${titleId} ${tagId}` : titleId}
        aria-describedby={detailId}
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)] focus-visible:outline-none"
      />
      <div className="min-w-0">
        <div className={cx("flex flex-wrap items-center gap-2", !offered && "opacity-60")}>
          <span id={titleId} className="text-[14px] font-medium text-ink">
            {title}
          </span>
          {tag && (
            <span
              id={tagId}
              className="rounded-full border hairline-strong px-2 py-0.5 text-[10.5px] uppercase tracking-[0.14em] text-muted"
            >
              {tag}
            </span>
          )}
        </div>
        <div id={detailId}>
          <p className={cx("mt-1 text-[12.5px] leading-[1.6] text-muted", !offered && "opacity-60")}>
            {body}
          </p>
          {offered ? (
            lines.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {lines.map((line) => (
                  <li key={line} className="text-[12px] text-muted-2">
                    {line}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="mt-2 text-[12.5px] leading-[1.6] text-muted">
              {C.form.fullUp}{" "}
              <Link href="/founding-5" className="text-ink underline underline-offset-2">
                {C.form.fullUpLink}
              </Link>
            </p>
          )}
        </div>
      </div>
    </Card>
  );

  // Only an offered card is a click target: a full one keeps its link usable and its radio still.
  return offered ? <label className="block cursor-pointer">{content}</label> : content;
}

/** A card's words for this deployment: nothing is said that its facts do not say. */
function cardWords(
  id: PathId,
  facts: PathFacts,
): { title: string; tag: string | null; body: string; lines: string[] } {
  const sandbox = facts.environment === "sandbox";
  switch (id) {
    case "form": {
      const lines: string[] = [];
      if (sandbox) lines.push(C.form.timeSandbox);
      else if (facts.filingWorkingDays !== null)
        lines.push(fillCopy(C.form.time, { days: String(facts.filingWorkingDays) }));
      if (facts.paymentRequired && facts.formationFeeUsdc !== null)
        lines.push(fillCopy(C.form.price, { fee: String(facts.formationFeeUsdc) }));
      else if (sandbox && !facts.paymentRequired) lines.push(C.form.noPayment);
      return { title: C.form.title, tag: null, body: C.form.body, lines };
    }
    case "declare": {
      const lines: string[] = [sandbox ? C.declare.needsSandbox : C.declare.needsProduction];
      if (sandbox && !facts.paymentRequired) lines.push(C.declare.noPayment);
      return { title: C.declare.title, tag: null, body: C.declare.body, lines };
    }
    case "full":
      return {
        title: C.full.title,
        tag: C.full.tag,
        body: fillCopy(C.full.body, { count: String(facts.stepCount) }),
        lines: [],
      };
  }
}
