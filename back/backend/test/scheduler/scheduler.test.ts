/**
 * The in-process scheduler: named periodic jobs run inside the API process, so no cron line on
 * the box. Every test drives it with fake timers; nothing here waits on the real clock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FIRST_RUN_DELAY_MS, type Job, Scheduler } from "../../src/scheduler/scheduler";

const SECOND = 1_000;
const DAY = 86_400_000;

/** Every ops line written to standard output, parsed. */
let ops: Record<string, unknown>[];

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 12) });
  ops = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null && "opslog" in parsed) ops.push(parsed);
    } catch {
      // Not an ops line.
    }
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A job whose run is the given function, counted. */
function job(
  name: string,
  everyMs: number,
  run: (nowMs: number) => Promise<Record<string, number>>,
): Job & { calls: number[] } {
  const calls: number[] = [];
  return {
    name,
    everyMs,
    calls,
    run: (nowMs) => {
      calls.push(nowMs);
      return run(nowMs);
    },
  };
}

const lines = (event: string) => ops.filter((o) => o.opslog === event);

describe("Scheduler", () => {
  test("a job runs 30 s after boot, then on its interval, and its counts reach the job_ran line", async () => {
    const boot = Date.now();
    const sweep = job("identity_sweep", DAY, async () => ({ superseded: 2, abandoned: 0 }));
    const scheduler = new Scheduler({});
    scheduler.register(sweep);
    expect(scheduler.status()).toEqual([
      { name: "identity_sweep", lastRunAt: null, lastOk: null, consecutiveFailures: 0 },
    ]);

    scheduler.start();
    expect(FIRST_RUN_DELAY_MS).toBe(30 * SECOND);
    await vi.advanceTimersByTimeAsync(30 * SECOND - 1);
    expect(sweep.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // The run is handed the scheduler's clock.
    expect(sweep.calls).toEqual([boot + 30 * SECOND]);
    expect(lines("job_ran")).toEqual([
      expect.objectContaining({ name: "identity_sweep", ms: 0, superseded: 2, abandoned: 0 }),
    ]);
    expect(lines("job_failed")).toEqual([]);
    expect(scheduler.status()).toEqual([
      {
        name: "identity_sweep",
        lastRunAt: boot + 30 * SECOND,
        lastOk: true,
        consecutiveFailures: 0,
      },
    ]);

    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(sweep.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep.calls).toEqual([boot + 30 * SECOND, boot + 30 * SECOND + DAY]);
    expect(lines("job_ran")).toHaveLength(2);
    scheduler.stop();
  });

  test("each job keeps its own interval, and job_ran carries how long the run took", async () => {
    const fast = job("email_deliver", 30 * SECOND, async () => {
      // The run takes 2 seconds of the scheduler's clock.
      vi.setSystemTime(Date.now() + 2 * SECOND);
      return { sent: 1 };
    });
    const daily = job("identity_sweep", DAY, async () => ({ count: 0 }));
    const scheduler = new Scheduler({});
    scheduler.register(fast);
    scheduler.register(daily);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(30 * SECOND + 5 * 30 * SECOND);
    expect(fast.calls).toHaveLength(6);
    expect(daily.calls).toHaveLength(1);
    expect(lines("job_ran").filter((o) => o.name === "email_deliver")[0]).toMatchObject({
      ms: 2 * SECOND,
      sent: 1,
    });
    scheduler.stop();
  });

  test("a run still going skips the next tick: one run at a time per job", async () => {
    let finish: (() => void) | undefined;
    const slow = job(
      "email_deliver",
      30 * SECOND,
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ sent: 3 });
        }),
    );
    const scheduler = new Scheduler({});
    scheduler.register(slow);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(slow.calls).toHaveLength(1);
    // Two ticks come while the first run is still going: both are skipped.
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(slow.calls).toHaveLength(1);
    // A manual run is refused too while the job runs.
    await expect(scheduler.runNow("email_deliver")).rejects.toThrow(
      "refusing: job email_deliver is already running",
    );
    expect(slow.calls).toHaveLength(1);
    expect(lines("job_ran")).toEqual([]);

    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines("job_ran")).toEqual([expect.objectContaining({ name: "email_deliver", sent: 3 })]);
    // The next tick, on the job's own cadence, runs again.
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(slow.calls).toHaveLength(2);
    scheduler.stop();
  });

  test("a throw writes job_failed with the message only; three in a row and every one after are CRITICAL; a success resets the count", async () => {
    let failing = true;
    const flaky = job("identity_sweep", 60 * SECOND, async () => {
      if (failing) throw new Error("database is locked");
      return { count: 1 };
    });
    const scheduler = new Scheduler({});
    scheduler.register(flaky);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(30 * SECOND + 3 * 60 * SECOND);
    expect(flaky.calls).toHaveLength(4);
    const failed = lines("job_failed");
    expect(failed.map((o) => o.consecutive)).toEqual([1, 2, 3, 4]);
    // The error's message only: no stack, no other field of the error.
    for (const o of failed) {
      expect(o.error).toBe("database is locked");
      expect(JSON.stringify(o)).not.toMatch(/stack|\bat /);
    }
    // Under three, a warning; at three and every failure after, the CRITICAL channel.
    expect(failed[0]).toEqual({
      opslog: "job_failed",
      at: expect.any(String),
      level: "warn",
      name: "identity_sweep",
      consecutive: 1,
      error: "database is locked",
    });
    expect(failed[1]).not.toHaveProperty("severity");
    expect(failed[2]).toEqual({
      opslog: "job_failed",
      at: expect.any(String),
      level: "error",
      severity: "CRITICAL",
      name: "identity_sweep",
      consecutive: 3,
      error: "database is locked",
    });
    expect(failed[3]).toMatchObject({ severity: "CRITICAL", consecutive: 4 });
    expect(scheduler.status()[0]).toMatchObject({ lastOk: false, consecutiveFailures: 4 });
    expect(lines("job_ran")).toEqual([]);

    // A success resets the count, so the next failure is a warning again.
    failing = false;
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(lines("job_ran")).toEqual([
      expect.objectContaining({ name: "identity_sweep", count: 1 }),
    ]);
    expect(scheduler.status()[0]).toMatchObject({ lastOk: true, consecutiveFailures: 0 });
    failing = true;
    await vi.advanceTimersByTimeAsync(60 * SECOND);
    expect(lines("job_failed").at(-1)).toMatchObject({ level: "warn", consecutive: 1 });
    expect(lines("job_failed").at(-1)).not.toHaveProperty("severity");
    scheduler.stop();
  });

  test("a value thrown that is not an Error is logged as text", async () => {
    const odd = job("identity_sweep", DAY, () => Promise.reject("not an error"));
    const scheduler = new Scheduler({});
    scheduler.register(odd);
    await expect(scheduler.runNow("identity_sweep")).rejects.toBe("not an error");
    expect(lines("job_failed")).toEqual([
      expect.objectContaining({ name: "identity_sweep", consecutive: 1, error: "not an error" }),
    ]);
  });

  test("stop() cancels the timers: before the first run, and after it", async () => {
    const before = job("identity_sweep", DAY, async () => ({ count: 0 }));
    const s1 = new Scheduler({});
    s1.register(before);
    s1.start();
    expect(vi.getTimerCount()).toBe(1);
    s1.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(before.calls).toEqual([]);

    const after = job("email_deliver", 30 * SECOND, async () => ({ sent: 0 }));
    const s2 = new Scheduler({});
    s2.register(after);
    s2.start();
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(after.calls).toHaveLength(1);
    s2.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(after.calls).toHaveLength(1);
  });

  test("the timers it is handed are the ones it sets and clears", () => {
    const setTimer = vi.fn((_fn: () => void, _ms?: number) => 42 as unknown as NodeJS.Timeout);
    const clearTimer = vi.fn();
    const scheduler = new Scheduler({
      setTimer: setTimer as unknown as typeof setTimeout,
      clearTimer: clearTimer as unknown as typeof clearTimeout,
    });
    scheduler.register(job("identity_sweep", DAY, async () => ({})));
    scheduler.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0]?.[1]).toBe(FIRST_RUN_DELAY_MS);
    scheduler.stop();
    expect(clearTimer).toHaveBeenCalledWith(42);
  });

  test("runNow runs one job at once, writes its line, returns its counts, and rethrows a failure", async () => {
    const now = vi.fn(() => 1_000_000);
    const ok = job("identity_sweep", DAY, async () => ({ count: 4 }));
    const bad = job("email_deliver", 30 * SECOND, async () => {
      throw new Error("provider unreachable");
    });
    const scheduler = new Scheduler({ now });
    scheduler.register(ok);
    scheduler.register(bad);

    await expect(scheduler.runNow("identity_sweep")).resolves.toEqual({ count: 4 });
    expect(ok.calls).toEqual([1_000_000]);
    expect(bad.calls).toEqual([]);
    expect(lines("job_ran")).toEqual([
      expect.objectContaining({ name: "identity_sweep", ms: 0, count: 4 }),
    ]);
    await expect(scheduler.runNow("email_deliver")).rejects.toThrow("provider unreachable");
    expect(lines("job_failed")).toEqual([
      expect.objectContaining({ name: "email_deliver", consecutive: 1 }),
    ]);
    expect(scheduler.status()).toEqual([
      { name: "identity_sweep", lastRunAt: 1_000_000, lastOk: true, consecutiveFailures: 0 },
      { name: "email_deliver", lastRunAt: 1_000_000, lastOk: false, consecutiveFailures: 1 },
    ]);
    await expect(scheduler.runNow("waitlist_sweep")).rejects.toThrow(
      "refusing: no scheduled job named waitlist_sweep",
    );
  });

  test("a job's counts cannot overwrite the name and the duration on its job_ran line", async () => {
    const scheduler = new Scheduler({});
    scheduler.register(job("identity_sweep", DAY, async () => ({ name: 7, ms: 9, count: 1 })));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(FIRST_RUN_DELAY_MS);
    expect(lines("job_ran")).toEqual([
      expect.objectContaining({ name: "identity_sweep", ms: 0, count: 1 }),
    ]);
    scheduler.stop();
  });

  test("register refuses a second job of the same name, an interval that is not a positive whole number of ms, and a job after start", () => {
    const scheduler = new Scheduler({});
    scheduler.register(job("identity_sweep", DAY, async () => ({})));
    expect(() => scheduler.register(job("identity_sweep", DAY, async () => ({})))).toThrow(
      "scheduler: a job named identity_sweep is registered already",
    );
    // Past 2^31 - 1 ms Node fires a timer at once, so a monthly job would spin.
    for (const everyMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
      expect(() => scheduler.register(job("email_deliver", everyMs, async () => ({})))).toThrow(
        "scheduler: email_deliver: everyMs must be a positive whole number of milliseconds, at most 2147483647",
      );
    scheduler.register(job("longest", 2_147_483_647, async () => ({})));
    scheduler.start();
    expect(() => scheduler.register(job("email_deliver", DAY, async () => ({})))).toThrow(
      "scheduler: register every job before start()",
    );
    expect(() => scheduler.start()).toThrow("scheduler: started already");
    scheduler.stop();
  });
});

/**
 * The composition root, read off the file (the C4 precedent in test/api/shutdown.test.ts:
 * `api/main.ts` has no injectable seam for its startup sequence).
 */
test("main.ts builds the job list, starts the scheduler after serve() and the sweepers only when a job is registered, and stops it on shutdown", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");
  const serveAt = main.indexOf("serve({ fetch: app.fetch");
  const sweeperAt = main.indexOf("legalBodySweeper.start()");
  const startAt = main.indexOf("scheduler.start()");
  expect(serveAt, "serve() call not found: this guard has stopped guarding").toBeGreaterThan(0);
  expect(main).toContain("buildScheduledJobs(db, cfg)");
  expect(main).toMatch(/scheduledJobs\.length > 0\s*\?\s*new Scheduler\(/);
  expect(startAt).toBeGreaterThan(serveAt);
  expect(startAt).toBeGreaterThan(sweeperAt);
  const shutdownAt = main.indexOf("installShutdownHandlers({");
  expect(shutdownAt).toBeGreaterThan(startAt);
  expect(main.slice(shutdownAt, main.indexOf("});", shutdownAt))).toContain("scheduler");
});
