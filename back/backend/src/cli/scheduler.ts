import type Database from "better-sqlite3";
import type { Command } from "commander";
import type { Config } from "../config/env";
import { buildScheduledJobs } from "../scheduler/jobs";
import { FIRST_RUN_DELAY_MS, Scheduler } from "../scheduler/scheduler";
import { print, refuse, withDatabase, withDatabaseAsync } from "./operator";

/**
 * THE SCHEDULER'S OPERATOR COMMANDS: `scheduler:list` prints the jobs this deployment registers
 * (the same list the API process runs, `buildScheduledJobs`) and `scheduler:run <name> --yes` runs
 * one of them now, in this process: the manual path the runbooks name.
 *
 * Neither reads the API process's run history: that lives in its memory, which another process
 * cannot read. The history is in the ops log, one `job_ran` or `job_failed` line per run. A run
 * from here writes those lines too.
 */

const HISTORY = "the run history is in the ops log: job_ran, job_failed";

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
  const jobs = buildScheduledJobs(db, cfg).map((job) => ({
    name: job.name,
    everyMs: job.everyMs,
    schedule: `first run ${describeEvery(FIRST_RUN_DELAY_MS)} after boot, then every ${describeEvery(job.everyMs)}`,
  }));
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
  const scheduler = new Scheduler();
  for (const j of jobs) scheduler.register(j);
  const counts = await scheduler.runNow(name);
  return { name, ran: true, counts };
}

export function registerSchedulerCommands(program: Command): void {
  program
    .command("scheduler:list")
    .description(
      "list the jobs the API runs on its in-process scheduler, with their interval; the run history is in the ops log (job_ran, job_failed)",
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
