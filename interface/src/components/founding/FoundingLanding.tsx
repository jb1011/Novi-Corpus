"use client";

import { useEffect, useState } from "react";
import { ApplyForm } from "@/components/founding/ApplyForm";
import { getFoundingConfig, type FoundingConfig } from "@/lib/founding/api";

const PRIZES = [
  "A Wyoming DAO LLC as the legal body.",
  "A USDC treasury on Arc, with spending rules.",
  "Guardian controls.",
  "Free for the first year, once real filings are open.",
];

const FAQ = [
  {
    q: "Who can apply?",
    a: "Anyone building an agent. You do not need World ID to apply.",
  },
  {
    q: "What does it cost after the first year?",
    a: "The normal Novi Corpus price. Winners hear it before anything is charged.",
  },
  {
    q: "What if you are not picked?",
    a: "You stay on the list. We contact you if a place opens.",
  },
  {
    q: "What do we keep?",
    a: "The answers on this form, so we can review them and contact you.",
  },
];

export function FoundingLanding() {
  const [config, setConfig] = useState<FoundingConfig | null>(null);

  useEffect(() => {
    let live = true;
    getFoundingConfig()
      .then((next) => {
        if (live) setConfig(next);
      })
      .catch(() => {
        if (live) setConfig(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const open = config?.open !== false;

  return (
    <main className="flex flex-1 flex-col">
      <section id="apply" className="bg-paper">
        <div className="mx-auto max-w-[640px] px-6 py-16 lg:px-10 lg:py-20">
          <h1 className="text-[24px] font-medium tracking-[-0.01em]">Apply</h1>
          <div className="mt-8">
            <ApplyForm open={open} picksAt={config?.picksAt ?? null} />
          </div>
        </div>
      </section>

      <section className="border-t hairline bg-paper-2">
        <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
          <h2 className="text-[24px] font-medium tracking-[-0.01em]">What winners get</h2>
          <ul className="mt-6 flex flex-col gap-3 text-[15px] leading-[1.6] text-muted">
            {PRIZES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t hairline bg-paper">
        <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
          <h2 className="text-[24px] font-medium tracking-[-0.01em]">Questions</h2>
          <dl className="mt-6 flex flex-col gap-6">
            {FAQ.map((item) => (
              <div key={item.q}>
                <dt className="text-[15px] font-medium text-ink">{item.q}</dt>
                <dd className="mt-1.5 text-[14px] leading-[1.6] text-muted">{item.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </main>
  );
}
