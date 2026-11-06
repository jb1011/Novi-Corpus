import { getAddress } from "viem";
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
  /** Checksummed reviewer wallets. Empty means nobody can open the admin routes. */
  admins: readonly `0x${string}`[];
  /** Unix milliseconds. Null means applications have no deadline. */
  closesAt: number | null;
  /** Unix milliseconds. Display only. Null means the page does not name a pick date. */
  picksAt: number | null;
  /** False closes applications even when `closesAt` is still in the future. */
  enabled: boolean;
  /** Salt for the IP hash. Empty means the row stores no IP hash at all. */
  ipSalt: string;
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
 * it does not share that limiter's burst.
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

/** True while the programme is enabled and the deadline, if there is one, has not passed. */
export function foundingOpen(deps: FoundingDeps, now: number): boolean {
  if (!deps.enabled) return false;
  if (deps.closesAt !== null && now >= deps.closesAt) return false;
  return true;
}

/**
 * `FOUNDING_*` as the routes need them. A bad address or a bad date throws, so a typo fails boot
 * instead of silently locking the reviewers out or closing the form on an unreadable clock.
 */
export function foundingFromEnv(env: NodeJS.ProcessEnv): Omit<FoundingDeps, "db" | "take" | "now"> {
  return {
    admins: parseAdmins(env.FOUNDING_ADMINS),
    closesAt: parseWhen(env.FOUNDING_CLOSES_AT, "FOUNDING_CLOSES_AT"),
    picksAt: parseWhen(env.FOUNDING_PICKS_AT, "FOUNDING_PICKS_AT"),
    enabled: env.FOUNDING_OPEN !== "false" && env.FOUNDING_OPEN !== "0",
    ipSalt: env.FOUNDING_IP_SALT?.trim() ?? "",
  };
}

function parseAdmins(raw: string | undefined): `0x${string}`[] {
  const parts = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.map((part) => {
    try {
      return getAddress(part);
    } catch {
      throw new Error(`Invalid FOUNDING_ADMINS address: ${part}`);
    }
  });
}

/** ISO-8601, or a whole number of unix seconds (or milliseconds when the number is already ms). */
function parseWhen(raw: string | undefined, name: string): number | null {
  const text = raw?.trim() ?? "";
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid ${name}: ${raw}`);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`Invalid ${name}: ${raw}`);
  return ms;
}
