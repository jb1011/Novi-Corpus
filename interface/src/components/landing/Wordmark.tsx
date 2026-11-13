import Link from "next/link";

type Tone = "ink" | "paper";

type Props = {
  className?: string;
  tone?: Tone;
  /** Keep the full name visible. The header swaps to the mark on a phone. */
  full?: boolean;
};

const LOCKUP: Record<Tone, string> = {
  ink: "/logo/novi-corpus-lockup-white.png",
  paper: "/logo/novi-corpus-lockup-black.png",
};

const MARK: Record<Tone, string> = {
  ink: "/logo/novi-corpus-mark-white.png",
  paper: "/logo/novi-corpus-mark-black.png",
};

/** Courthouse mark. `ink` is the light mark for dark surfaces. */
function Mark({ tone = "ink" }: { tone?: Tone }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={MARK[tone]} alt="" className="h-7 w-7 object-contain" />
  );
}

export function Wordmark({ className = "", tone = "ink", full = false }: Props) {
  return (
    <Link
      href="/"
      className={`group inline-flex shrink-0 items-center ${className}`}
      aria-label="Novi Corpus home"
    >
      {full ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={LOCKUP[tone]} alt="" className="h-8 w-auto" />
      ) : (
        <>
          <span className="sm:hidden">
            <Mark tone={tone} />
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={LOCKUP[tone]} alt="" className="hidden h-8 w-auto sm:block" />
        </>
      )}
    </Link>
  );
}

export { Mark };
