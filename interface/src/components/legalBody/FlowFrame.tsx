import Link from "next/link";
import { Wordmark } from "@/components/landing/Wordmark";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

/**
 * The frame around the legal-body flow and the start: the top bar, the background, and the blank
 * the server renders while the session and the memory live in the browser only.
 */

const F = LEGAL_BODY_COPY.frame;

export function FlowHeader() {
  return (
    <header className="sticky top-0 z-40">
      <div className="absolute inset-0 -z-10 border-b hairline bg-paper/80 backdrop-blur-md" />
      <div className="mx-auto flex h-16 max-w-[1180px] items-center justify-between px-5 lg:px-8">
        <Wordmark />
        <Link
          href="/"
          className="rounded-full px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
        >
          {F.exit}
        </Link>
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
