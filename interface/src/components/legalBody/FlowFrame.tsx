"use client";

import Link from "next/link";
import { Wordmark } from "@/components/landing/Wordmark";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

/**
 * The frame around the legal-body flow and the start: the top bar, the background, and the blank
 * the server renders while the session and the memory live in the browser only.
 */

const F = LEGAL_BODY_COPY.frame;
const LINK =
  "rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink";

/**
 * The top bar. While a session exists it links to "My agents" beside Exit, so whatever step is on
 * screen (a new company a stored "start another" holds, the agreement of another agent, a done
 * page opened from a row) the account's legal bodies are one click away. Rendered inside the
 * flows' `AuthProvider`, after the hydration guard.
 */
export function FlowHeader() {
  const { session } = useAuth();
  return (
    <header className="sticky top-0 z-40">
      <div className="absolute inset-0 -z-10 border-b hairline bg-paper/80 backdrop-blur-md" />
      <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between px-5 lg:px-8">
        <Wordmark />
        <nav className="flex items-center gap-1">
          {session !== null && (
            <Link href="/agents" className={LINK}>
              {F.myAgents}
            </Link>
          )}
          <Link href="/" className={LINK}>
            {F.exit}
          </Link>
        </nav>
      </div>
    </header>
  );
}

/** The wizard's background, so both flows look like one product. */
export function FlowBackground() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10 hero-mesh-dark opacity-70"
      />
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-paper-grain opacity-60" />
    </>
  );
}

export function Blank() {
  return <div className="min-h-screen bg-paper" aria-hidden />;
}
