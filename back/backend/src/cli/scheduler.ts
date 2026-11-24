import type Database from "better-sqlite3";
import type { Command } from "commander";
import type { Config } from "../config/env";
import { apiProcessOnlyJobs, buildScheduledJobs } from "../scheduler/jobs";
import { FIRST_RUN_DELAY_MS, Scheduler } from "../scheduler/scheduler";
import { print, refuse, withDatabase, withDatabaseAsync } from "./operator";

/**
 * THE SCHEDULER'S OPERATOR COMMANDS: `scheduler:list` prints the jobs this deployment registers
 * (the same list the API process runs, `buildScheduledJobs`) and `scheduler:run <name> --yes` runs
 * one of them now, in this process: the manual path the runbooks name.
 *
 * A job whose dependencies only the API process builds (`apiProcessOnlyJobs`: the identity
 * session sync, with its provider client and screener) is listed with a note saying so, and
 * `scheduler:run` refuses it, with --yes and without: this process cannot build what it needs.
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

const scheduleOf = (everyMs: number): string =>
  `first run ${describeEvery(FIRST_RUN_DELAY_MS)} after boot, then every ${describeEvery(everyMs)}`;

export function listScheduledJobs(db: Database.Database, cfg: Config): Record<string, unknown> {
  const jobs = [
    ...buildScheduledJobs(db, cfg).map((job) => ({
      name: job.name,
      everyMs: job.everyMs,
      schedule: scheduleOf(job.everyMs),
    })),
    ...apiProcessOnlyJobs(cfg).map((job) => ({
      name: job.name,
      everyMs: job.everyMs,
      schedule: scheduleOf(job.everyMs),
      note: job.note,
    })),
  ];
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
  const apiOnly = apiProcessOnlyJobs(cfg).find((j) => j.name === name);
  if (apiOnly !== undefined)
    refuse(`${name} ${apiOnly.note}; its runs are in the ops log (job_ran, job_failed)`);
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
      "list the jobs the API runs on its in-process scheduler, with their interval, and a note on a job only the API process can run; the run history is in the ops log (job_ran, job_failed)",
    )
    .action(() => withDatabase((db, _docStoreDir, cfg) => print(listScheduledJobs(db, cfg))));

  program
    .command("scheduler:run")
    .argument("<name>", "the job, as scheduler:list prints it")
    .description(
      "run one scheduled job now, in this process, and print its counts; without --yes, say what would run. A job only the API process can run is refused",
    )
    .option("--yes", "confirm: run the job now")
    .action((name: string, opts: { yes?: boolean }) =>
      withDatabaseAsync(async (db, _docStoreDir, cfg) =>
        print(await runScheduledJob(db, cfg, name, opts)),
      ),
    );
}
