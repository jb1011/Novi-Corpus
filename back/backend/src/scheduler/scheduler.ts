import { opsLog } from "../observability/opsLog";
import type { ScheduledJobRunStore } from "../persistence/scheduledJobRunRepository";

/**
 * THE IN-PROCESS SCHEDULER: named periodic jobs run inside the API process, so the box needs no
 * cron line, and a job runs where its configuration and its database already are.
 *
 * The rules, each held by test/scheduler/scheduler.test.ts:
 *  - each job's first run starts 30 seconds after `start()` (after boot, never on the boot path),
 *    then one every `everyMs`, on its own cadence;
 *  - one run at a time per job: a tick that comes while the job's last run is still going is
 *    skipped, and so is a `runNow` (refused);
 *  - a skipped tick writes `job_skipped { name, consecutiveSkips }`, a warning; from the third
 *    skip in a row, and on every skip after it, the line is on the CRITICAL channel, since a run
 *    that never settles would otherwise stop its job without a trace; a run that finishes, either
 *    way, resets the count;
 *  - a success writes `job_ran { ...counts, name, ms }`, the counts the job returned, which
 *    cannot overwrite the job's name or the run's duration; a `quiet` job writes no `job_ran` for
 *    a success whose counts are all zero (a job that runs every 30 seconds and mostly finds nothing
 *    to do would bury the log), which is still a run in every other respect;
 *  - a throw writes `job_failed { name, consecutive, error }`, with the error's MESSAGE only, never
 *    its stack or its other fields; from the third failure in a row, and on every failure after
 *    it, the line is on the CRITICAL channel (`severity: "CRITICAL"`, as `formation_stale`); a
 *    success resets the count;
 *  - with `runs` (the API process hands it `scheduled_job_runs`), every run is written to the
 *    table, a success or a failure, before its line, and `start()` reads it back, so the count of
 *    failures in a row survives a restart and a process that crash-loops still reaches CRITICAL;
 *    a write that fails writes `job_record_failed { name, error }` and leaves the run as it was;
 *  - `stop()` cancels every timer at once and returns a promise that settles when any run already
 *    going has finished (it never rejects: a failure has its own line); nothing runs after it. The
 *    API's shutdown awaits it within its bounded drain.
 *
 * `status()` is this process's memory. An operator's CLI is another process: `scheduler:list`
 * reads each job's last run from `scheduled_job_runs`, and the run history from the ops log.
 */

export interface Job {
  name: string;
  /** At most `MAX_EVERY_MS`: Node fires a longer timer at once. */
  everyMs: number;
  /**
   * No `job_ran` line for a success whose counts are all zero (or that returned none). The run is
   * still recorded, and a failure or a skip is still written. For a frequent job whose usual run
   * has nothing to do.
   */
  quiet?: boolean;
  /**
   * Returns the counts for the `job_ran` line. Handed the scheduler's clock. A count named `name`
   * or `ms` is overwritten by the line's own; the names `opslog` and `at` are reserved too, since
   * the ops line writes its own fields under them.
   */
  run(nowMs: number): Promise<Record<string, number>>;
}

export interface SchedulerDeps {
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Where each job's last run is kept across restarts. Without it, in memory only. */
  runs?: ScheduledJobRunStore;
}

export interface JobStatus {
  name: string;
  /** When the last run that finished started; null before the first. */
  lastRunAt: number | null;
  lastOk: boolean | null;
  consecutiveFailures: number;
}

/** Each job's first run, after `start()`. */
export const FIRST_RUN_DELAY_MS = 30_000;
/** From this many failures in a row, `job_failed` is CRITICAL. */
export const CRITICAL_AFTER_FAILURES = 3;
/** From this many skipped ticks in a row, `job_skipped` is CRITICAL. */
export const CRITICAL_AFTER_SKIPS = 3;
/** The longest interval: 2^31 - 1 ms, about 24.8 days. Node clamps a longer timeout to 1 ms, so a
 *  monthly job would run without pause. */
export const MAX_EVERY_MS = 2_147_483_647;

interface Entry extends JobStatus {
  job: Job;
  running: boolean;
  /** The run going, settled either way; what `stop()` waits for. */
  inFlight: Promise<void> | undefined;
  consecutiveSkips: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The message only: a stack or an error's other fields are where a third party's data rides. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The level fields of a line that turns CRITICAL from a count on. */
const levelFor = (count: number, criticalFrom: number) =>
  count >= criticalFrom ? { level: "error", severity: "CRITICAL" } : { level: "warn" };

export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private started = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps = {}) {}

  register(job: Job): void {
    if (this.started) throw new Error("scheduler: register every job before start()");
    if (this.entries.has(job.name))
      throw new Error(`scheduler: a job named ${job.name} is registered already`);
    if (!Number.isSafeInteger(job.everyMs) || job.everyMs <= 0 || job.everyMs > MAX_EVERY_MS)
      throw new Error(
        `scheduler: ${job.name}: everyMs must be a positive whole number of milliseconds, at most ${MAX_EVERY_MS}`,
      );
    this.entries.set(job.name, {
      job,
      name: job.name,
      lastRunAt: null,
      lastOk: null,
      consecutiveFailures: 0,
      running: false,
      inFlight: undefined,
      consecutiveSkips: 0,
      timer: undefined,
    });
  }

  /** Reads each job's last run back from `runs` (a read that throws leaves it unstarted), then
   *  sets each job's first run. */
  start(): void {
    if (this.started) throw new Error("scheduler: started already");
    for (const run of this.deps.runs?.list() ?? []) {
      const entry = this.entries.get(run.name);
      if (entry === undefined) continue;
      entry.lastRunAt = run.lastRunAt;
      entry.lastOk = run.lastOk;
      entry.consecutiveFailures = run.consecutiveFailures;
    }
    this.started = true;
    for (const entry of this.entries.values()) this.schedule(entry, FIRST_RUN_DELAY_MS);
  }

  /** Cancels every timer now; settles when every run already going has finished. */
  stop(): Promise<void> {
    this.stopped = true;
    const clear = this.deps.clearTimer ?? clearTimeout;
    const going: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) clear(entry.timer);
      entry.timer = undefined;
      if (entry.inFlight !== undefined) going.push(entry.inFlight);
    }
    return Promise.all(going).then(() => undefined);
  }

  /** One run of the named job, now: its line written, its counts returned, its throw rethrown. */
  async runNow(name: string): Promise<Record<string, number>> {
    const entry = this.entries.get(name);
    if (entry === undefined) throw new Error(`refusing: no scheduled job named ${name}`);
    if (entry.running) throw new Error(`refusing: job ${name} is already running`);
    return this.execute(entry);
  }

  status(): JobStatus[] {
    return [...this.entries.values()].map(({ name, lastRunAt, lastOk, consecutiveFailures }) => ({
      name,
      lastRunAt,
      lastOk,
      consecutiveFailures,
    }));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private schedule(entry: Entry, delayMs: number): void {
    const set = this.deps.setTimer ?? setTimeout;
    entry.timer = set(() => this.tick(entry), delayMs);
    // A pending job must never be the reason a process (or a test worker) stays alive.
    (entry.timer as { unref?: () => void }).unref?.();
  }

  /** The next tick is set first, so the cadence holds however long a run takes. */
  private tick(entry: Entry): void {
    if (this.stopped) return;
    this.schedule(entry, entry.job.everyMs);
    if (entry.running) {
      entry.consecutiveSkips += 1;
      opsLog("job_skipped", {
        ...levelFor(entry.consecutiveSkips, CRITICAL_AFTER_SKIPS),
        name: entry.name,
        consecutiveSkips: entry.consecutiveSkips,
      });
      return;
    }
    // `execute` has written the failure's line already; the loop has nothing more to do with it.
    this.execute(entry).catch(() => undefined);
  }

  /** The run, tracked in `inFlight` until it has settled, so `stop()` can wait for it. */
  private execute(entry: Entry): Promise<Record<string, number>> {
    const run = this.runOnce(entry);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    entry.inFlight = settled;
    void settled.then(() => {
      if (entry.inFlight === settled) entry.inFlight = undefined;
    });
    return run;
  }

  private async runOnce(entry: Entry): Promise<Record<string, number>> {
    entry.running = true;
    const startedAt = this.now();
    let counts: Record<string, number>;
    try {
      counts = await entry.job.run(startedAt);
    } catch (err) {
      entry.lastRunAt = startedAt;
      entry.lastOk = false;
      entry.consecutiveFailures += 1;
      const consecutive = entry.consecutiveFailures;
      this.record(entry, startedAt, false);
      opsLog("job_failed", {
        ...levelFor(consecutive, CRITICAL_AFTER_FAILURES),
        name: entry.name,
        consecutive,
        error: messageOf(err),
      });
      throw err;
    } finally {
      entry.running = false;
      entry.consecutiveSkips = 0;
    }
    entry.lastRunAt = startedAt;
    entry.lastOk = true;
    entry.consecutiveFailures = 0;
    this.record(entry, startedAt, true);
    if (!(entry.job.quiet === true && Object.values(counts).every((n) => n === 0)))
      opsLog("job_ran", { ...counts, name: entry.name, ms: this.now() - startedAt });
    return counts;
  }

  /** The run, in `runs`. A write that fails is said, and the run stays what it was. */
  private record(entry: Entry, startedAt: number, ok: boolean): void {
    if (this.deps.runs === undefined) return;
    try {
      this.deps.runs.record({
        name: entry.name,
        lastRunAt: startedAt,
        lastOk: ok,
        consecutiveFailures: entry.consecutiveFailures,
        updatedAt: this.now(),
      });
    } catch (err) {
      opsLog("job_record_failed", { level: "error", name: entry.name, error: messageOf(err) });
    }
  }
}
