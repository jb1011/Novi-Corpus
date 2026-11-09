import { TokenBucket } from "../api/routes/agentBook";
import type { Database } from "./repository";

/** How many applications a single caller may submit before the bucket has to refill. */
export const FOUNDING_BURST = 5;
/** Five submissions per hour, spread across the hour. */
export const FOUNDING_REFILL_PER_SECOND = FOUNDING_BURST / 3600;
const FOUNDING_MAX_KEYS = 2000;

export const FOUNDING_SPOTS = 5;

export type FoundingDeps = {
  db: Database;
  /** False stops new applications. Unset in the environment means they stay open. */
  enabled: boolean;
  /** False when this caller is over the public submission allowance. */
  take: (callerKey: string) => boolean;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
};

/**
 * One bucket per caller, bounded and least-recently-used.
 *
 * Keyed the same way as the public legal-body limiter: the last `X-Forwarded-For` entry, which is
 * the one the receiving proxy appended. The capacity is the founding form's own (5 per hour), so
 * it does not share that limiter's burst. The address is not stored.
 */
export function foundingLimiter(): (callerKey: string) => boolean {
  const clients = new Map<string, TokenBucket>();
  return (callerKey) => {
    const found = clients.get(callerKey);
    if (found) {
      clients.delete(callerKey);
      clients.set(callerKey, found);
      return found.take();
    }
    const fresh = new TokenBucket(FOUNDING_BURST, FOUNDING_REFILL_PER_SECOND);
    clients.set(callerKey, fresh);
    while (clients.size > FOUNDING_MAX_KEYS) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
    return fresh.take();
  };
}

/** True while new applications are accepted. There is no deadline. */
export function foundingOpen(deps: FoundingDeps): boolean {
  return deps.enabled;
}

/** `FOUNDING_OPEN` as the route needs it. Unset means the form stays open. */
export function foundingFromEnv(env: NodeJS.ProcessEnv): Omit<FoundingDeps, "db" | "take" | "now"> {
  return {
    enabled: env.FOUNDING_OPEN !== "false" && env.FOUNDING_OPEN !== "0",
  };
}
