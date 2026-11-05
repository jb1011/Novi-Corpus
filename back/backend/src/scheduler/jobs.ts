import type Database from "better-sqlite3";
import { sweepIdentityNames } from "../cli/identity";
import type { Config } from "../config/env";
import type { Job } from "./scheduler";

/**
 * THE SCHEDULED JOBS of this deployment: the one list the API process registers on its scheduler
 * and `scheduler:list` / `scheduler:run` read, so the two can never disagree about what runs.
 *
 * A job is on the list only where the deployment can do its work. The identity sweep erases names
 * of record, which exist only where the PII key is set (`cfg.pii`): the testnet box cannot hold the
 * key (its doola block is in sandbox), so it has no job, and its API starts no scheduler.
 *
 * Later jobs join here: `email_deliver`, `waitlist_sweep`, `screening_recheck`.
 */

export const IDENTITY_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

export function buildScheduledJobs(db: Database.Database, cfg: Config): Job[] {
  const jobs: Job[] = [];
  if (cfg.pii)
    jobs.push({
      name: "identity_sweep",
      everyMs: IDENTITY_SWEEP_EVERY_MS,
      // The retention rules' erasure, as `identity:sweep --yes` runs it; it writes its own
      // `identity_names_erased` line, and its counts per rule ride on `job_ran`.
      run: async (nowMs) => {
        const swept = sweepIdentityNames(db, cfg, { yes: true, nowMs });
        return { count: swept.count, ...swept.rules };
      },
    });
  return jobs;
}
