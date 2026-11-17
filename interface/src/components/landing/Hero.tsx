import Link from "next/link";
import { GET_STARTED_CTA, HERO_RECORD, HERO_SUB, HERO_TITLE, SEE_PATHS_CTA } from "./copy";
import { Reveal } from "./Reveal";
import { Mark } from "./Wordmark";

export function Hero() {
  return (
    <section id="top" className="relative isolate overflow-hidden bg-paper">
      <div aria-hidden className="absolute inset-0 -z-10 hero-mesh anim-mesh" />
      <div
        aria-hidden
        className="absolute inset-0 -z-10 paper-grid opacity-60"
      />

      <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-16 px-6 pb-28 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:px-10 lg:pb-36 lg:pt-24">
        <div className="flex flex-col justify-center">
          <Reveal immediate delay={180} variant="up" duration={760}>
            <h1 className="text-balance text-[44px] font-medium leading-[1.02] tracking-[-0.025em] text-ink sm:text-[60px] lg:text-[78px]">
              <span className="relative inline-block">{HERO_TITLE[0]}</span>
              <br />
              {HERO_TITLE[1]}
            </h1>
          </Reveal>

          <Reveal immediate delay={300} variant="up">
            <p className="mt-7 max-w-xl text-pretty text-[17px] leading-[1.5] text-muted lg:text-[18px]">
              {HERO_SUB}
            </p>
          </Reveal>

          <Reveal immediate delay={420} variant="pop">
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/start"
                className="group inline-flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-[14px] font-medium text-paper transition-all duration-300 hover:bg-ink-hover hover:scale-[1.03] active:scale-[0.98]"
              >
                <span>{GET_STARTED_CTA}</span>
                <span
                  aria-hidden
                  className="transition-transform group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
              <a
                href="#paths"
                className="inline-flex items-center gap-2 rounded-full border hairline-strong bg-paper/60 px-5 py-3 text-[14px] text-ink transition-all duration-300 hover:bg-paper-2 hover:scale-[1.03] active:scale-[0.98]"
              >
                {SEE_PATHS_CTA}
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal
          immediate
          delay={520}
          variant="right"
          duration={820}
          className="flex items-center justify-center py-6 lg:justify-end lg:py-8"
        >
          <div className="w-full max-w-[400px] rotate-[2.5deg] transition-transform duration-500 hover:rotate-[1.5deg] hover:scale-[1.02] lg:max-w-[420px]">
            <LegalBodyRecordPreview />
          </div>
        </Reveal>
      </div>

      <Reveal immediate delay={700} variant="up" duration={600}>
        <div className="pointer-events-none absolute bottom-5 left-1/2 hidden -translate-x-1/2 flex-col items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted lg:flex">
          <span>Scroll to explore</span>
          <span className="anim-scroll-hint inline-block h-6 w-px bg-muted/60" />
        </div>
      </Reveal>
    </section>
  );
}

/**
 * A legal body's public record, as a picture: no live data, the same lines on every deployment.
 * The treasury is the full product's and is named only on its own card.
 */
function LegalBodyRecordPreview() {
  return (
    <div className="overflow-hidden rounded-2xl border hairline-strong bg-paper shadow-[0_12px_40px_-12px_rgba(0,0,0,0.3)]">
      <div className="flex items-center justify-between border-b hairline bg-paper-2/80 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </div>
        <span className="text-[11px] tracking-wide text-muted-2">
          {HERO_RECORD.header}
        </span>
        <span className="w-12" aria-hidden />
      </div>

      <div className="space-y-3 p-5">
        <Reveal immediate delay={640} variant="scale" duration={620}>
          <div className="overflow-hidden rounded-xl border-2 border-accent/40 bg-accent/[0.06]">
            <div className="flex items-start gap-3 p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent/30 to-highlight/25">
                <Mark />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-[15px] font-medium text-ink">
                    {HERO_RECORD.company}
                  </div>
                  <span
                    aria-hidden
                    className="shrink-0 rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium text-paper"
                  >
                    ✓
                  </span>
                </div>
                <ul className="mt-2.5 space-y-1 text-[12px] text-muted">
                  <li>· {HERO_RECORD.identity}</li>
                </ul>
              </div>
            </div>
            <div className="border-t border-accent/25 bg-accent/10 px-4 py-2 text-[11.5px] font-medium text-accent-soft">
              {HERO_RECORD.standing}
            </div>
          </div>
        </Reveal>

        <div aria-hidden className="flex flex-col items-center py-1">
          <div className="h-6 w-px bg-line-strong" />
          <span className="my-1 h-1.5 w-1.5 rounded-full bg-accent" />
          <div className="h-6 w-px bg-line-strong" />
        </div>

        <Reveal immediate delay={780} variant="up" duration={560}>
          <div className="flex items-center gap-3 rounded-xl border hairline bg-paper-2/40 px-3 py-2.5">
            <div
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-paper-3 text-muted"
            >
              <PersonGlyph />
            </div>
            <div className="text-[13px] font-medium text-ink">
              {HERO_RECORD.human}
            </div>
          </div>
        </Reveal>
      </div>
    </div>
  );
}

function PersonGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="5.5" r="2.75" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M2.75 14c.6-2.6 2.7-4.25 5.25-4.25S12.65 11.4 13.25 14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
