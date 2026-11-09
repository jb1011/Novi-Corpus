"use client";

import { useEffect, useState } from "react";
import { ApplyForm } from "@/components/founding/ApplyForm";
import { getFoundingConfig, type FoundingConfig } from "@/lib/founding/api";

const OFFER = [
  "A Wyoming company bound to the agent's identity on Arc.",
  "An operating agreement anchored on chain.",
  "A public record of the company, its filing status, and that a verified human stands behind it. The guardian's name is never public.",
];

const FAQ = [
  {
    q: "Who can apply?",
    a: "People in the US and the UK who are building an agent. This is an invite only beta of about ten companies. You do not need World ID to send this form. You will need it, with an Orb or a passport credential, before a company is formed. France and Spain are not covered yet.",
  },
  {
    q: "What if there is no place left?",
    a: "You stay on the list. We contact you if a place opens.",
  },
  {
    q: "What do we keep?",
    a: "The answers on this form, so we can review them and contact you. We do not hold your money or your keys, and we cannot change or close the legal body.",
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
            <ApplyForm open={open} />
          </div>
        </div>
      </section>

      <section className="border-t hairline bg-paper-2">
        <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
          <h2 className="text-[24px] font-medium tracking-[-0.01em]">
            What you get
          </h2>
          <ul className="mt-6 flex flex-col gap-3 text-[15px] leading-[1.6] text-muted">
            {OFFER.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t hairline bg-paper">
        <div className="mx-auto max-w-[840px] px-6 py-16 lg:px-10 lg:py-20">
          <h2 className="text-[24px] font-medium tracking-[-0.01em]">
            Questions
          </h2>
          <dl className="mt-6 flex flex-col gap-6">
            {FAQ.map((item) => (
              <div key={item.q}>
                <dt className="text-[15px] font-medium text-ink">{item.q}</dt>
                <dd className="mt-1.5 text-[14px] leading-[1.6] text-muted">
                  {item.a}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </main>
  );
}
