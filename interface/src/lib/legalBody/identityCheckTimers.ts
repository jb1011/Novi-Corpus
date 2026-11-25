import {
  READ_POLL_MS,
  SYNC_MIN_INTERVAL_MS,
  providerReadStep,
  readingStep,
  type CheckedSync,
  type SessionRead,
  type SyncResult,
} from "@/lib/legalBody/identityCheck";

/**
 * The identity check card's two timed rules, as plain objects over a clock and timers passed in:
 * no React, no request of their own. The card's hook makes one of each per mount and only tells
 * them when to run; the tests run them on fake timers.
 *
 * - The gate in front of the reads at the provider (`POST /identity-check/sync`): one in flight at
 *   most, a second caller sharing it, and "cooling" from the send until `SYNC_MIN_INTERVAL_MS`
 *   after the read finished, when the server takes the next one.
 * - The wait while the provider is processing: every `READ_POLL_MS`, what `readingStep` says,
 *   measured from the wait's own start, which a running wait keeps.
 * - A read at the provider over a fresh read of the session (`syncOverFreshRead`): the session read
 *   again first, and the gate asked only when that read allows it (`providerReadStep`).
 */

export type Timers = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

/** The global clock and timers, looked up at each call. */
export const SYSTEM_TIMERS: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/* ── The gate ──────────────────────────────────────────────────────────────────────────────── */

export type SyncGate = {
  /** A read at the provider, or the one already in flight. Never rejects: a refusal settles as
   *  `{ ok: false, error }`. */
  run(): Promise<SyncResult>;
  /** From the send until `SYNC_MIN_INTERVAL_MS` after the read finished. */
  cooling(): boolean;
  /** When the last read finished, answered or refused; null before the first. */
  lastSyncAt(): number | null;
};

/**
 * The gate has one timer, the end of the cooling, and no way to stop it: it ends within
 * `SYNC_MIN_INTERVAL_MS` and only reports. A card that remounts (Strict Mode, a refresh in
 * development) therefore never finds the gate cooling with nothing left to end it.
 */
export function createSyncGate(p: {
  send(): Promise<unknown>;
  onCoolingChange(cooling: boolean): void;
  timers: Timers;
}): SyncGate {
  let inFlight: Promise<SyncResult> | null = null;
  let lastSyncAt: number | null = null;
  let cooling = false;
  let coolTimer: unknown = null;

  const setCooling = (next: boolean) => {
    if (cooling === next) return;
    cooling = next;
    p.onCoolingChange(next);
  };

  return {
    run() {
      if (inFlight) return inFlight;
      setCooling(true);
      const sent = p
        .send()
        .then(
          (): SyncResult => ({ ok: true }),
          (error: unknown): SyncResult => ({ ok: false, error }),
        )
        .then((result) => {
          inFlight = null;
          lastSyncAt = p.timers.now();
          if (coolTimer !== null) p.timers.clearTimeout(coolTimer);
          coolTimer = p.timers.setTimeout(() => {
            coolTimer = null;
            setCooling(false);
          }, SYNC_MIN_INTERVAL_MS);
          return result;
        });
      inFlight = sent;
      return sent;
    },
    cooling: () => cooling,
    lastSyncAt: () => lastSyncAt,
  };
}

/* ── A read at the provider over a fresh read ──────────────────────────────────────────────── */

/** The session read again, when that read was made (its data's time) and the time of the read
 *  before it, so a read that failed, or answered nothing newer, is told from a fresh one. */
export type FreshRead = { session: SessionRead; readAt: number; after: number };

/**
 * Check again, Try again and the wait's own reads at the provider (ruling R35): the session is
 * read again first (`read`), and the gate is asked only when that read is fresh and says the
 * session is open and not held. A session held since the card last read it is never read at the
 * provider by the card: the server's job, or an operator, finishes it. Never rejects: a read again
 * that throws is no fresh read.
 */
export async function syncOverFreshRead(p: {
  read(): Promise<FreshRead>;
  gate: SyncGate;
}): Promise<CheckedSync> {
  const read = await p.read().catch(() => null);
  if (read === null) return { sent: false, step: "wait" };
  const step = providerReadStep(read);
  if (step !== "sync") return { sent: false, step };
  return { sent: true, result: await p.gate.run() };
}

/* ── The wait ──────────────────────────────────────────────────────────────────────────────── */

export type ReadingWait = {
  /** Starts the wait, unless one is running: a running wait keeps its own start. */
  start(): void;
  /** Ends the wait: the next start opens a new window. */
  stop(): void;
};

/**
 * The wait while the provider is processing. Each tick does what `readingStep` says: a read at
 * the provider (`sync`), the two reads again (`poll`), or the end of the window, which stops the
 * wait and says so (`onLongWait`). With no read finished yet, the time since the last read is
 * measured from the wait's start.
 */
export function createReadingWait(p: {
  sync(): void;
  lastSyncAt(): number | null;
  poll(): void;
  onLongWait(): void;
  timers: Timers;
}): ReadingWait {
  let timer: unknown = null;

  const stop = () => {
    if (timer !== null) p.timers.clearInterval(timer);
    timer = null;
  };

  return {
    start() {
      if (timer !== null) return;
      const startedAt = p.timers.now();
      timer = p.timers.setInterval(() => {
        const now = p.timers.now();
        const step = readingStep({
          elapsedMs: now - startedAt,
          sinceSyncMs: now - (p.lastSyncAt() ?? startedAt),
        });
        if (step === "stop") {
          stop();
          p.onLongWait();
        } else if (step === "sync") p.sync();
        else p.poll();
      }, READ_POLL_MS);
    },
    stop,
  };
}
