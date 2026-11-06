import type Database from "better-sqlite3";
import type { Command } from "commander";
import type { Config } from "../config/env";
import { SqliteScheduledJobRunRepository } from "../persistence/scheduledJobRunRepository";
import { buildScheduledJobs } from "../scheduler/jobs";
import { FIRST_RUN_DELAY_MS, Scheduler } from "../scheduler/scheduler";
import { hasTables, print, refuse, withDatabase, withDatabaseAsync } from "./operator";

/**
 * THE SCHEDULER'S OPERATOR COMMANDS: `scheduler:list` prints the jobs this deployment registers
 * (the same list the API process runs, `buildScheduledJobs`) and `scheduler:run <name> --yes` runs
 * one of them now, in this process: the manual path the runbooks name.
 *
 * `scheduler:list` prints, beside each job, its last run as the API process's scheduler wrote it
 * to `scheduled_job_runs` (`lastRunAt`, `lastOk`, `consecutiveFailures`; null where the job never
 * ran, and on a database the API of this build has not migrated yet, which has no such table). The run history is in the ops log: a `job_ran` or `job_failed` line per run (a quiet job
 * writes no `job_ran` for a run with nothing to do) and a `job_skipped` line per skipped tick. A
 * run from here writes those lines too, and only those: the table is the API process's, so a
 * manual run never resets the failure count the API's CRITICAL rule reads.
 */

const HISTORY = "the run history is in the ops log: job_ran, job_failed, job_skipped";

/** An interval as an operator reads it: 24 h, 30 s. */
function describeEvery(ms: number): string {
  for (const [unit, size] of [
    ["h", 3_600_000],
    ["min", 60_000],
    ["s", 1_000],
  ] as const)
    if (ms % size === 0) return `${ms / size} ${unit}`;
  return `${ms} ms`;
}

export function listScheduledJobs(db: Database.Database, cfg: Config): Record<string, unknown> {
  // No table yet: the API of this build has not started on this database, so no job ran under it.
  const recorded = hasTables(db, ["scheduled_job_runs"])
    ? new SqliteScheduledJobRunRepository(db).list()
    : [];
  const lastRuns = new Map(recorded.map((run) => [run.name, run]));
  const jobs = buildScheduledJobs(db, cfg).map((job) => {
    const last = lastRuns.get(job.name);
    return {
      name: job.name,
      everyMs: job.everyMs,
      schedule: `first run ${describeEvery(FIRST_RUN_DELAY_MS)} after boot, then every ${describeEvery(job.everyMs)}`,
      lastRunAt: last?.lastRunAt ?? null,
      lastOk: last?.lastOk ?? null,
      consecutiveFailures: last?.consecutiveFailures ?? null,
    };
  });
  return {
    jobs,
    history: HISTORY,
    ...(jobs.length === 0
      ? { next: "no job is registered on this deployment: the API starts no scheduler" }
      : {}),
  };
}

/** Without `yes`, what would run; with it, one run now, its counts printed. */
export async function runScheduledJob(
  db: Database.Database,
  cfg: Config,
  name: string,
  opts: { yes?: boolean },
): Promise<Record<string, unknown>> {
  const jobs = buildScheduledJobs(db, cfg);
  const job = jobs.find((j) => j.name === name);
  if (job === undefined) refuse(`no scheduled job named ${name}`);
  if (opts.yes !== true)
    return {
      name,
      everyMs: job.everyMs,
      ran: false,
      next: `nothing was run: run scheduler:run ${name} --yes to run it now`,
    };
  // No `runs`: the table is the API process's (the header says why).
  const scheduler = new Scheduler();
  for (const j of jobs) scheduler.register(j);
  const counts = await scheduler.runNow(name);
  return { name, ran: true, counts };
}

export function registerSchedulerCommands(program: Command): void {
  program
    .command("scheduler:list")
    .description(
      "list the jobs the API runs on its in-process scheduler, with their interval and the API's last run of each; the run history is in the ops log (job_ran, job_failed, job_skipped)",
    )
    .action(() => withDatabase((db, _docStoreDir, cfg) => print(listScheduledJobs(db, cfg))));

  program
    .command("scheduler:run")
    .argument("<name>", "the job, as scheduler:list prints it")
    .description(
      "run one scheduled job now, in this process, and print its counts; without --yes, say what would run",
    )
    .option("--yes", "confirm: run the job now")
    .action((name: string, opts: { yes?: boolean }) =>
      withDatabaseAsync(async (db, _docStoreDir, cfg) =>
        print(await runScheduledJob(db, cfg, name, opts)),
      ),
    );
}
