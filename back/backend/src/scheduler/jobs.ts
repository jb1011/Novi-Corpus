import type Database from "better-sqlite3";
import type { Config } from "../config/env";
import { type IdentitySessionDeps, sweepSessions } from "../identity/sessions";
import { sweepIdentityNames } from "../identity/sweep";
import type { Job } from "./scheduler";

/**
 * THE SCHEDULED JOBS of this deployment: the one list the API process registers on its scheduler
 * and `scheduler:list` / `scheduler:run` read, so the two can never disagree about what runs.
 *
 * A job is on the list only where the deployment can do its work. The identity sweep erases names
 * of record, which exist only where the PII key is set (`cfg.pii`). A box whose doola block is in
 * sandbox may hold that key only with the Stripe Identity block (the check seals the typed names
 * under it); without the block, as on the testnet box today, it has no job and its API starts no
 * scheduler.
 *
 * The session sync (`identity_sessions_sync`) is registered where the Stripe Identity block is set
 * and the API process hands in the session service (`deps.identitySessions`), which holds the
 * provider client and the screener the API builds. Another process cannot run it: it is named
 * for that process by `apiProcessOnlyJobs`, under the same condition.
 *
 * Later jobs join here: `email_deliver`, `waitlist_sweep`, `screening_recheck`.
 */

export const IDENTITY_SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
export const IDENTITY_SESSIONS_SYNC = "identity_sessions_sync";

/** What the API process hands the list: the dependencies only it builds. */
export interface ScheduledJobDeps {
  identitySessions?: IdentitySessionDeps;
}

/** A job of this deployment that runs in the API process only, as another process names it. */
export interface ApiProcessOnlyJob {
  name: string;
  everyMs: number;
  note: string;
}

export function buildScheduledJobs(
  db: Database.Database,
  cfg: Config,
  deps: ScheduledJobDeps = {},
): Job[] {
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
  const sessions = deps.identitySessions;
  if (sessions !== undefined && cfg.stripeIdentity)
    jobs.push({
      name: IDENTITY_SESSIONS_SYNC,
      everyMs: cfg.identity.syncEveryMs,
      // The open sessions nobody read lately read back, the abandoned ones closed, the redactions
      // due asked for. An error on one session is counted (`errors`) and logged by the sweep, never
      // thrown: a throw here is a broken dependency, and `job_failed` says so.
      run: async (nowMs) => ({ ...(await sweepSessions(sessions, nowMs)) }),
    });
  return jobs;
}

/**
 * The jobs the API process registers that no other process can build: `buildScheduledJobs(db,
 * cfg)` without the deps, plus these, is the API process's list. `scheduler:list` prints them
 * with their note, and `scheduler:run` refuses them.
 */
export function apiProcessOnlyJobs(cfg: Config): ApiProcessOnlyJob[] {
  if (!cfg.stripeIdentity) return [];
  return [
    {
      name: IDENTITY_SESSIONS_SYNC,
      everyMs: cfg.identity.syncEveryMs,
      note: "runs in the API process only, registered there because the Stripe Identity block is configured: it reads the open check sessions back from the provider with the API's provider client and screener, so scheduler:run cannot run it",
    },
  ];
}
