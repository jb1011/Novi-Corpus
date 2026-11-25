/**
 * The identity check card's two timed rules, run on fake timers with no browser: the gate in
 * front of the reads at the provider (one in flight at most, and none for a click until the
 * server's interval has passed since the last one finished), and the wait while the provider is
 * processing (the two reads every 5 seconds, a read at the provider every 20 seconds, three
 * minutes in all, measured from the wait's own start).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError, type IdentitySessionView } from "@/lib/api/types";
import {
  READ_POLL_MS,
  READ_SYNC_EVERY_MS,
  READ_WINDOW_MS,
  SYNC_MIN_INTERVAL_MS,
} from "@/lib/legalBody/identityCheck";
import {
  SYSTEM_TIMERS,
  createReadingWait,
  createSyncGate,
  syncOverFreshRead,
  type FreshRead,
} from "@/lib/legalBody/identityCheckTimers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 24));
});
afterEach(() => {
  vi.useRealTimers();
});

/** A read the test finishes by hand. */
function pending() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("the gate in front of the reads at the provider", () => {
  test("one read in flight at most: a second caller shares it", async () => {
    const read = pending();
    const send = vi.fn(() => read.promise);
    const gate = createSyncGate({ send, onCoolingChange() {}, timers: SYSTEM_TIMERS });
    const first = gate.run();
    const second = gate.run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    read.resolve({});
    await expect(first).resolves.toEqual({ ok: true });
  });

  test("cooling from the send until the server's interval after the read finished, then a new read goes out", async () => {
    const read = pending();
    const send = vi.fn(() => read.promise);
    const changes: boolean[] = [];
    const gate = createSyncGate({ send, onCoolingChange: (c) => changes.push(c), timers: SYSTEM_TIMERS });
    expect(gate.cooling()).toBe(false);
    expect(gate.lastSyncAt()).toBeNull();

    void gate.run();
    expect(gate.cooling()).toBe(true);
    // The read takes 3 seconds: the interval counts from when it finished, not from the send.
    await vi.advanceTimersByTimeAsync(3_000);
    read.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    const finishedAt = Date.now();
    expect(gate.lastSyncAt()).toBe(finishedAt);
    await vi.advanceTimersByTimeAsync(SYNC_MIN_INTERVAL_MS - 1);
    expect(gate.cooling()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.cooling()).toBe(false);
    expect(changes).toEqual([true, false]);

    send.mockImplementation(async () => ({}));
    await gate.run();
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("a refused read settles as its error, and cools the same", async () => {
    const error = new ApiError(503, { code: "identity_provider_unavailable", message: "m" });
    const gate = createSyncGate({
      send: () => Promise.reject(error),
      onCoolingChange() {},
      timers: SYSTEM_TIMERS,
    });
    await expect(gate.run()).resolves.toEqual({ ok: false, error });
    expect(gate.cooling()).toBe(true);
    await vi.advanceTimersByTimeAsync(SYNC_MIN_INTERVAL_MS);
    expect(gate.cooling()).toBe(false);
  });

  test("once a read finished, the next run is a new read: cooling holds back a click, not the gate", async () => {
    const send = vi.fn(async () => ({}));
    const gate = createSyncGate({ send, onCoolingChange() {}, timers: SYSTEM_TIMERS });
    await gate.run();
    await gate.run();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// Ruling R35: Check again, Try again and the wait's own reads at the provider read the session
// again first, and send only over that read.
describe("a read at the provider over a fresh read of the session", () => {
  const OPEN: IdentitySessionView = {
    status: "open",
    sessionId: "s1",
    startedAt: 0,
    attemptsLeft: 3,
    lastErrorCode: null,
    reading: true,
    held: null,
  };
  const BEFORE = Date.UTC(2026, 10, 24) - 10_000;

  function over(read: () => Promise<FreshRead>) {
    const send = vi.fn(async () => ({}));
    const gate = createSyncGate({ send, onCoolingChange() {}, timers: SYSTEM_TIMERS });
    return { send, run: () => syncOverFreshRead({ read, gate }) };
  }
  const freshly = (session: FreshRead["session"]) => async (): Promise<FreshRead> => ({
    session,
    readAt: BEFORE + 1,
    after: BEFORE,
  });

  test("still processing on the fresh read: the read at the provider goes out, once", async () => {
    const { send, run } = over(freshly(OPEN));
    await expect(run()).resolves.toEqual({ sent: true, result: { ok: true } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("held, closed or gone on the fresh read: nothing goes out, and the card shows the read", async () => {
    for (const session of [
      { ...OPEN, reading: false, held: "system" },
      { ...OPEN, reading: false, held: "operator" },
      { status: "none" },
    ] as const) {
      const { send, run } = over(freshly(session));
      await expect(run()).resolves.toEqual({ sent: false, step: "show" });
      expect(send).not.toHaveBeenCalled();
    }
  });

  test("no fresh read (the read again failed, or answered nothing newer): nothing goes out", async () => {
    const stale = over(async () => ({ session: OPEN, readAt: BEFORE, after: BEFORE }));
    await expect(stale.run()).resolves.toEqual({ sent: false, step: "wait" });
    expect(stale.send).not.toHaveBeenCalled();
    const thrown = over(() => Promise.reject(new Error("network")));
    await expect(thrown.run()).resolves.toEqual({ sent: false, step: "wait" });
    expect(thrown.send).not.toHaveBeenCalled();
  });
});

describe("the wait while the provider is processing", () => {
  /** A gate whose read finishes at once. */
  function gate(lastSyncAt: number | null = null) {
    let last = lastSyncAt;
    return {
      sync: vi.fn(() => {
        last = Date.now();
      }),
      lastSyncAt: () => last,
    };
  }

  function wait(g: ReturnType<typeof gate>) {
    const poll = vi.fn();
    const onLongWait = vi.fn();
    const loop = createReadingWait({ ...g, poll, onLongWait, timers: SYSTEM_TIMERS });
    return { loop, poll, onLongWait };
  }

  test("no read finished yet: measured from the wait's start, the reads every 5 s, a read at the provider every 20 s, the stop at 3 minutes", async () => {
    const g = gate();
    const { loop, poll, onLongWait } = wait(g);
    loop.start();
    await vi.advanceTimersByTimeAsync(READ_SYNC_EVERY_MS - 1);
    expect(g.sync).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(READ_WINDOW_MS - READ_SYNC_EVERY_MS - 1);
    expect(onLongWait).not.toHaveBeenCalled();
    // At 20, 40, ..., 160 s; the other 27 ticks before 180 s are the two reads.
    expect(g.sync).toHaveBeenCalledTimes(8);
    expect(poll).toHaveBeenCalledTimes(27);
    await vi.advanceTimersByTimeAsync(1);
    expect(onLongWait).toHaveBeenCalledTimes(1);

    // Stopped: nothing more.
    await vi.advanceTimersByTimeAsync(READ_WINDOW_MS);
    expect(onLongWait).toHaveBeenCalledTimes(1);
    expect(g.sync).toHaveBeenCalledTimes(8);
    expect(poll).toHaveBeenCalledTimes(27);
  });

  test("a read finished before the wait: the next one 20 s after it, not after the wait's start", async () => {
    const g = gate(Date.now() - (READ_SYNC_EVERY_MS - READ_POLL_MS));
    const { loop, poll } = wait(g);
    loop.start();
    await vi.advanceTimersByTimeAsync(READ_POLL_MS);
    expect(g.sync).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
  });

  test("leaving the wait stops it; a new wait has a window of its own", async () => {
    const g = gate();
    const { loop, poll, onLongWait } = wait(g);
    loop.start();
    await vi.advanceTimersByTimeAsync(100_000);
    loop.stop();
    const polls = poll.mock.calls.length;
    const syncs = g.sync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(READ_WINDOW_MS);
    expect(poll).toHaveBeenCalledTimes(polls);
    expect(g.sync).toHaveBeenCalledTimes(syncs);
    expect(onLongWait).not.toHaveBeenCalled();

    loop.start();
    await vi.advanceTimersByTimeAsync(READ_WINDOW_MS - 1);
    expect(onLongWait).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onLongWait).toHaveBeenCalledTimes(1);
  });

  test("a second start while the wait runs keeps the first window", async () => {
    const g = gate();
    const { loop, onLongWait } = wait(g);
    loop.start();
    await vi.advanceTimersByTimeAsync(100_000);
    loop.start();
    await vi.advanceTimersByTimeAsync(READ_WINDOW_MS - 100_000);
    expect(onLongWait).toHaveBeenCalledTimes(1);
  });
});
