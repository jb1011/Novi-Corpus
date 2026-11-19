import { STATS } from "./copy";
import { Reveal } from "./Reveal";

export function Stats() {
  return (
    <section className="relative bg-paper-2">
      <div className="mx-auto max-w-[1240px] px-6 lg:px-10">
        <div className="grid grid-cols-2 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 90} variant="pop" duration={640}>
              <div className="group relative px-5 py-8 sm:px-6 md:px-8 md:py-10">
                <div className="text-[11px] uppercase tracking-[0.2em] text-muted-2">
                  {String(i + 1).padStart(2, "0")} · {s.label}
                </div>
                <div className="mt-3 whitespace-nowrap font-medium tabular-nums text-ink text-[24px] leading-none tracking-[-0.02em] transition-transform duration-300 group-hover:scale-105 sm:text-[40px] lg:text-[36px] xl:text-[48px]">
                  {s.value}
                </div>
                <div className="mt-2 text-[12.5px] text-muted">{s.detail}</div>
                <div
                  aria-hidden
                  className="pointer-events-none absolute right-4 top-4 h-1.5 w-1.5 rounded-full bg-accent/70 opacity-0 transition-opacity group-hover:opacity-100"
                />
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
