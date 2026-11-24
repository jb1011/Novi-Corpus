"use client";

import Link from "next/link";
import { type ReactNode } from "react";
import { fillCopy } from "@/lib/legalBody/copy";
import { START_COPY } from "@/lib/start/copy";
import type { PathCard, PathId } from "@/lib/start/paths";
import { GET_STARTED_CTA, ONBOARDING_STEP_COUNT, PATHS_HEADING } from "./copy";
import { Reveal } from "./Reveal";
import { SectionLabel } from "./SectionLabel";
import { landingCards, useLandingConfig } from "./useLandingConfig";

const C = START_COPY.cards;

/**
 * One height for the cards' area, empty or filled, so the page does not move when the config
 * arrives: one row of cards from `md`, the two legal-body cards stacked below it.
 */
const CARDS_AREA = "min-h-[440px] md:min-h-[260px]";

const CARD_TEXT: Record<PathId, { title: string; body: string }> = {
  form: { title: C.form.title, body: C.form.body },
  declare: { title: C.declare.title, body: C.declare.body },
  full: { title: C.full.title, body: fillCopy(C.full.body, { count: String(ONBOARDING_STEP_COUNT) }) },
};

/**
 * The ways in, as this deployment's `/config` names them (`landingCards`). While the config is
 * loading the section keeps its heading and an empty area of the cards' height, and claims no
 * card: the deployment may not offer one.
 */
export function PathsSection() {
  const cards = landingCards(useLandingConfig());
  if (cards === null) {
    return (
      <PathsFrame>
        <div aria-hidden className={CARDS_AREA} />
      </PathsFrame>
    );
  }
  return <PathsView cards={cards} />;
}

/**
 * The section with one card per path, in the order given. An offered card leads to the start
 * with its path; a form card whose places are all taken says so and leads to the early-access
 * list; the full product's card carries its testnet tag.
 */
export function PathsView({ cards }: { cards: readonly PathCard[] }) {
  return (
    <PathsFrame>
      {cards.length === 0 ? (
        <p className={`text-[15px] leading-[1.6] text-muted-dark ${CARDS_AREA}`}>{START_COPY.none}</p>
      ) : (
        <ul className={`flex flex-col gap-4 md:flex-row ${CARDS_AREA}`}>
          {cards.map((card, i) => (
            <li key={card.id} className="md:flex-1">
              <Reveal delay={i * 90} variant="pop" duration={640} className="h-full">
                {card.state === "offered" ? (
                  <OfferedCard id={card.id} index={i} />
                ) : (
                  <FullUpCard id={card.id} index={i} />
                )}
              </Reveal>
            </li>
          ))}
        </ul>
      )}
    </PathsFrame>
  );
}

function PathsFrame({ children }: { children: ReactNode }) {
  return (
    <section id="paths" className="relative bg-ink-grain text-ink">
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 ink-grid" />
        <div className="absolute -left-40 top-1/2 h-[480px] w-[480px] -translate-y-1/2 rounded-full bg-accent/15 blur-[120px]" />
        <div className="absolute -right-40 top-0 h-[420px] w-[420px] rounded-full bg-highlight/10 blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
        <Reveal variant="left" className="max-w-2xl">
          <SectionLabel index="01" label={GET_STARTED_CTA} tone="paper" />
          <h2 className="mt-4 text-balance text-[36px] font-medium leading-[1.05] tracking-[-0.02em] text-ink sm:text-[46px] lg:text-[56px]">
            {PATHS_HEADING}
          </h2>
        </Reveal>
        <div className="mt-12 lg:mt-14">{children}</div>
      </div>
    </section>
  );
}

function CardTop({ index, id }: { index: number; id: PathId }) {
  return (
    <div className="flex h-6 items-center justify-between gap-3">
      <span aria-hidden className="font-mono text-[12px] text-muted-dark-2">
        {String(index + 1).padStart(2, "0")}
      </span>
      {id === "full" && (
        <span className="rounded-full border border-accent/35 bg-accent/[0.08] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-accent-soft">
          {C.full.tag}
        </span>
      )}
    </div>
  );
}

function OfferedCard({ id, index }: { id: PathId; index: number }) {
  const text = CARD_TEXT[id];
  return (
    <Link
      href={`/start?path=${id}`}
      className="group flex h-full flex-col rounded-2xl border hairline-dark-strong bg-ink-2 p-7 transition-all duration-300 hover:border-accent/40 hover:bg-ink-3 lg:p-8"
    >
      <CardTop index={index} id={id} />
      <h3 className="mt-8 text-[22px] font-medium leading-[1.15] tracking-[-0.01em] text-ink lg:text-[24px]">
        {text.title}
      </h3>
      <p className="mt-3 text-[14.5px] leading-[1.6] text-muted-dark">{text.body}</p>
      <span
        aria-hidden
        className="mt-auto self-end pt-8 text-[18px] text-ink/70 transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
      >
        →
      </span>
    </Link>
  );
}

function FullUpCard({ id, index }: { id: PathId; index: number }) {
  const text = CARD_TEXT[id];
  return (
    <div className="flex h-full flex-col rounded-2xl border hairline-dark bg-ink-2/60 p-7 lg:p-8">
      <CardTop index={index} id={id} />
      <h3 className="mt-8 text-[22px] font-medium leading-[1.15] tracking-[-0.01em] text-ink/70 lg:text-[24px]">
        {text.title}
      </h3>
      <p className="mt-3 text-[14.5px] leading-[1.6] text-muted-dark-2">{text.body}</p>
      <p className="mt-auto pt-8 text-[13.5px] text-muted-dark">
        {C.form.fullUp}{" "}
        <Link href="/founding-5" className="text-accent-soft underline-offset-4 hover:text-ink hover:underline">
          {C.form.fullUpLink}
        </Link>
      </p>
    </div>
  );
}
