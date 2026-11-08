import type Database from "better-sqlite3";

/**
 * THE LAST RUN OF EACH SCHEDULED JOB, as the API process's scheduler (src/scheduler) writes it to
 * `scheduled_job_runs` after every run and reads it back on `start()`, so the count of failures in
 * a row survives a restart. `scheduler:list` reads it beside the registered jobs.
 *
 * Its own small repository, as the other tables have theirs; the scheduler takes it as an optional
 * dependency (`SchedulerDeps.runs`), so it still runs without a database: in a test, and in the
 * operator's `scheduler:run`, whose manual run is in the ops log only.
 */
export interface ScheduledJobRun {
  name: string;
  /** When the last run that finished started, on the scheduler's clock (ms). */
  lastRunAt: number;
  lastOk: boolean;
  /** Failures in a row up to that run; 0 after a success. */
  consecutiveFailures: number;
  /** When the row was written (ms). */
  updatedAt: number;
}

/** The narrow surface the scheduler needs. Injectable, so a test can fail a single write. */
export interface ScheduledJobRunStore {
  /** Every row, by name. */
  list(): ScheduledJobRun[];
  /** The job's row, inserted or replaced. */
  record(run: ScheduledJobRun): void;
}

interface Row {
  name: string;
  last_run_at: number;
  last_ok: number;
  consecutive_failures: number;
  updated_at: number;
}

export class SqliteScheduledJobRunRepository implements ScheduledJobRunStore {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      list: db.prepare("SELECT * FROM scheduled_job_runs ORDER BY name"),
      upsert: db.prepare(
        `INSERT INTO scheduled_job_runs (name, last_run_at, last_ok, consecutive_failures, updated_at)
         VALUES (@name, @lastRunAt, @lastOk, @consecutiveFailures, @updatedAt)
         ON CONFLICT(name) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_ok = excluded.last_ok,
           consecutive_failures = excluded.consecutive_failures,
           updated_at = excluded.updated_at`,
      ),
    };
  }

  list(): ScheduledJobRun[] {
    return (this.stmts.list.all() as Row[]).map((r) => ({
      name: r.name,
      lastRunAt: r.last_run_at,
      lastOk: r.last_ok === 1,
      consecutiveFailures: r.consecutive_failures,
      updatedAt: r.updated_at,
    }));
  }

  record(run: ScheduledJobRun): void {
    this.stmts.upsert.run({
      name: run.name,
      lastRunAt: run.lastRunAt,
      lastOk: run.lastOk ? 1 : 0,
      consecutiveFailures: run.consecutiveFailures,
      updatedAt: run.updatedAt,
    });
  }
}
