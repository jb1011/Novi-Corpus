"use client";

import Link from "next/link";
import { AmberPill, Callout, Card, CheckIcon } from "@/components/onboarding/primitives";
import type { GuardianIdentityState } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";

const G = LEGAL_BODY_COPY.human.guardianIdentity;

const WAITING: readonly GuardianIdentityState[] = ["pending", "needs_review", "expired"];

/**
 * The identity record on the human step. Amber while it is not verified. No provider name, no
 * document, and never the person's name.
 */
export function GuardianIdentityCard({
  state,
  verifiedAt,
}: {
  state: GuardianIdentityState;
  verifiedAt?: number;
}) {
  const verified = state === "verified";
  const line = verified
    ? typeof verifiedAt === "number"
      ? fillCopy(G.verifiedOn, { date: formatDate(verifiedAt) })
      : G.verified
    : G[state];

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[15px] text-ink">{G.title}</p>
        {verified ? (
          <CheckIcon className="h-4 w-4 text-accent" />
        ) : WAITING.includes(state) ? (
          <AmberPill size="sm">{line}</AmberPill>
        ) : null}
      </div>
      {verified || state === "none" ? (
        <p className="mt-3 text-[13px] leading-[1.6] text-muted">{line}</p>
      ) : WAITING.includes(state) ? null : (
        <Callout tone="warn" className="mt-3">
          {line}
        </Callout>
      )}
      <ul className="mt-4 flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
        <li>{G.checked}</li>
        <li>{G.kept}</li>
        <li>{G.never}</li>
      </ul>
      <Link href="/personhood" className="mt-4 inline-block text-[12.5px] text-accent">
        {G.policy}
      </Link>
    </Card>
  );
}
