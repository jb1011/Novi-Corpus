import { useEffect, useState } from "react";
import { getPublicConfig } from "@/lib/api/client";
import type { PublicConfig } from "@/lib/api/types";
import { isTestDeployment, landingPaths, type PathCard } from "@/lib/start/paths";

/**
 * The deployment's `/config`, as the home page and its nav read it. The server and the first
 * client render are `loading`, so the markup hydrates against the smaller truth.
 */
export type LandingConfig =
  | { status: "loading"; config: null }
  | { status: "error"; config: null }
  | { status: "ready"; config: PublicConfig };

const LOADING: LandingConfig = { status: "loading", config: null };
const ERROR: LandingConfig = { status: "error", config: null };

let pending: Promise<PublicConfig> | null = null;

/**
 * One request per page load: every caller on the page shares one promise, its answer and its
 * failure alike. A failure is forgotten once it is settled, so the next page asks again instead
 * of showing a failure from an earlier one.
 */
export function loadLandingConfig(): Promise<PublicConfig> {
  if (pending === null) {
    const request = getPublicConfig();
    pending = request;
    request.catch(() => {
      if (pending === request) pending = null;
    });
  }
  return pending;
}

/** For client components: `loading` until the shared request settles, then `ready` or `error`. */
export function useLandingConfig(): LandingConfig {
  const [answer, setAnswer] = useState<LandingConfig>(LOADING);
  useEffect(() => {
    let live = true;
    loadLandingConfig().then(
      (config) => {
        if (live) setAnswer({ status: "ready", config });
      },
      () => {
        if (live) setAnswer(ERROR);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return answer;
}

/**
 * The cards the home page shows. None while the config is loading (the section keeps its place);
 * the two legal-body paths when it cannot be read; exactly what it offers once it is there, so a
 * deployment that does not offer the form card is never shown one.
 */
export function landingCards(answer: LandingConfig): PathCard[] | null {
  if (answer.status === "loading") return null;
  return landingPaths(answer.status === "ready" ? answer.config : null);
}

/** The nav's Testnet tag: only a config that is there and says sandbox. */
export function showsTestnetTag(answer: LandingConfig): boolean {
  return answer.status === "ready" && isTestDeployment(answer.config);
}
