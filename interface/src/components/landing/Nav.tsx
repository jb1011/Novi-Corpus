"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  getAuthSessionSnapshot,
  subscribeAuthSession,
} from "@/lib/api/config";
import { CREATE_COMPANY_CTA } from "./copy";
import { Wordmark } from "./Wordmark";

export function Nav() {
  const session = useSyncExternalStore(
    subscribeAuthSession,
    getAuthSessionSnapshot,
    () => null,
  );
  const signedIn = Boolean(session?.token);

  return (
    <header className="sticky top-0 z-50 anim-nav-drop">
      <div className="absolute inset-0 -z-10 backdrop-blur-md bg-paper/75 border-b hairline" />
      <nav className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-2 px-3.5 sm:px-6 lg:px-10">
        <Wordmark />

        <div className="flex items-center gap-1.5 sm:gap-2">
          {signedIn ? (
            <Link
              href="/agents"
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/35 bg-accent/[0.08] px-2.5 py-1.5 text-[12px] text-accent-soft transition-colors hover:bg-accent/[0.15] hover:text-ink sm:gap-2 sm:px-3.5 sm:py-2 sm:text-[13px]"
            >
              <span
                aria-hidden
                className="relative inline-block h-1.5 w-1.5 rounded-full bg-accent anim-pulse-dot"
              />
              <span>My agents</span>
            </Link>
          ) : (
            <Link
              href="/agents"
              className="inline-flex items-center whitespace-nowrap rounded-full border hairline-strong px-2.5 py-1.5 text-[12px] text-ink transition-colors hover:bg-paper-2 sm:px-3.5 sm:py-2 sm:text-[13px]"
            >
              Log in
            </Link>
          )}
          <Link
            href="/onboarding"
            className="group inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-paper transition-colors hover:bg-ink-hover sm:gap-1.5 sm:px-4 sm:py-2 sm:text-[13px]"
          >
            {CREATE_COMPANY_CTA}
            <span
              aria-hidden
              className="transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </Link>
        </div>
      </nav>
    </header>
  );
}
