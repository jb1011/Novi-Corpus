import { opsLog } from "../observability/opsLog";

/**
 * THE IN-PROCESS SCHEDULER: named periodic jobs run inside the API process, so the box needs no
 * cron line, and a job runs where its configuration and its database already are.
 *
 * The rules, each held by test/scheduler/scheduler.test.ts:
 *  - each job's first run starts 30 seconds after `start()` (after boot, never on the boot path),
 *    then one every `everyMs`, on its own cadence;
 *  - one run at a time per job: a tick that comes while the job's last run is still going is
 *    skipped, and so is a `runNow` (refused);
 *  - a success writes `job_ran { name, ms, ...counts }`, the counts the job returned;
 *  - a throw writes `job_failed { name, consecutive, error }`, with the error's MESSAGE only, never
 *    its stack or its other fields; from the third failure in a row, and on every failure after
 *    it, the line is on the CRITICAL channel (`severity: "CRITICAL"`, as `formation_stale`); a
 *    success resets the count;
 *  - `stop()` cancels every timer; a run already going finishes, and nothing runs after it.
 *
 * `status()` is this process's memory, so only the process that runs the jobs can read it: an
 * operator's CLI is another process, and reads the run history from the ops log instead.
 */

export interface Job {
  name: string;
  everyMs: number;
  /** Returns the counts for the `job_ran` line. Handed the scheduler's clock. */
  run(nowMs: number): Promise<Record<string, number>>;
}

export interface SchedulerDeps {
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
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

interface Entry extends JobStatus {
  job: Job;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The message only: a stack or an error's other fields are where a third party's data rides. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private started = false;
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps = {}) {}

  register(job: Job): void {
    if (this.started) throw new Error("scheduler: register every job before start()");
    if (this.entries.has(job.name))
      throw new Error(`scheduler: a job named ${job.name} is registered already`);
    if (!Number.isSafeInteger(job.everyMs) || job.everyMs <= 0)
      throw new Error(
        `scheduler: ${job.name}: everyMs must be a positive whole number of milliseconds`,
      );
    this.entries.set(job.name, {
      job,
      name: job.name,
      lastRunAt: null,
      lastOk: null,
      consecutiveFailures: 0,
      running: false,
      timer: undefined,
    });
  }

  start(): void {
    if (this.started) throw new Error("scheduler: started already");
    this.started = true;
    for (const entry of this.entries.values()) this.schedule(entry, FIRST_RUN_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    const clear = this.deps.clearTimer ?? clearTimeout;
    for (const entry of this.entries.values()) {
      if (entry.timer !== undefined) clear(entry.timer);
      entry.timer = undefined;
    }
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
    if (entry.running) return;
    // `execute` has written the failure's line already; the loop has nothing more to do with it.
    this.execute(entry).catch(() => undefined);
  }

  private async execute(entry: Entry): Promise<Record<string, number>> {
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
      opsLog("job_failed", {
        ...(consecutive >= CRITICAL_AFTER_FAILURES
          ? { level: "error", severity: "CRITICAL" }
          : { level: "warn" }),
        name: entry.name,
        consecutive,
        error: messageOf(err),
      });
      throw err;
    } finally {
      entry.running = false;
    }
    entry.lastRunAt = startedAt;
    entry.lastOk = true;
    entry.consecutiveFailures = 0;
    opsLog("job_ran", { name: entry.name, ms: this.now() - startedAt, ...counts });
    return counts;
  }
}
