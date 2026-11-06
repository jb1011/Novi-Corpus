import type Database from "better-sqlite3";
import type { Config } from "../config/env";
import {
  EMAIL_DELIVER_EVERY_MS,
  EMAIL_DELIVER_LIMIT,
  type EmailDeps,
  buildEmailDeps,
} from "../email/outbox";
import { sweepIdentityNames } from "../identity/sweep";
import type { Job } from "./scheduler";

/**
 * THE SCHEDULED JOBS of this deployment: the one list the API process registers on its scheduler
 * and `scheduler:list` / `scheduler:run` read, so the two can never disagree about what runs.
 *
 * A job is on the list only where the deployment can do its work. The identity sweep erases names
 * of record, which exist only where the PII key is set (`cfg.pii`): the testnet box cannot hold the
 * key (its doola block is in sandbox), so it has no job, and its API starts no scheduler.
 *
 * The email delivery, `email_deliver`, sends the outbox's due rows (src/email/outbox.ts): it exists
 * only where the email system does (`cfg.email`, which PUBLIC_APP_URL turns on; the testnet box
 * sets none of it), every 30 seconds, `quiet`: a run with nothing to send writes no `job_ran` line.
 * The API process hands in the email system it built, so its routes and the job share one; an
 * operator's command builds its own from the same configuration.
 *
 * Later jobs join here: `waitlist_sweep`, `screening_recheck`.
 *
 * The API process hands its scheduler `scheduled_job_runs`, where each job's last run is kept
 * across restarts; `scheduler:run` runs a job from this list without it.
 */

export const IDENTITY_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

export function buildScheduledJobs(
  db: Database.Database,
  cfg: Config,
  email: EmailDeps | undefined = buildEmailDeps(db, cfg),
): Job[] {
  const jobs: Job[] = [];
  if (cfg.pii)
    jobs.push({
      name: "identity_sweep",
      everyMs: IDENTITY_SWEEP_EVERY_MS,
      // The retention rules' erasure, as `identity:sweep --yes` runs it; it writes its own
      // `identity_names_erased` line, and its counts per rule ride on `job_ran`. Loud, not
      // `quiet`: its daily line, zero counts included, is the trace that the sweep ran.
      run: async (nowMs) => {
        const swept = sweepIdentityNames(db, cfg, { yes: true, nowMs });
        return { count: swept.count, ...swept.rules };
      },
    });
  if (email)
    jobs.push({
      name: "email_deliver",
      everyMs: EMAIL_DELIVER_EVERY_MS,
      quiet: true,
      // At most 20 rows, one at a time, none taken after 45 seconds or once the scheduler stops.
      run: (nowMs, signal) =>
        email.outbox.deliverDue(email.sender, nowMs, EMAIL_DELIVER_LIMIT, { signal }),
    });
  return jobs;
}
