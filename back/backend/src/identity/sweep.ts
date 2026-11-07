import { userInfo } from "node:os";
import type Database from "better-sqlite3";
import type { Config } from "../config/env";
import { opsLog } from "../observability/opsLog";
import { type ErasureRule, SqliteIdentityRepository } from "../persistence/identityRepository";

/**
 * THE RETENTION SWEEP over the guardian's identity record: the names the retention rules say are
 * due, erased. The API process's scheduler runs it daily (`scheduler/jobs.ts`) and
 * `identity:sweep` is the manual path (`cli/identity.ts`); it lives here so the API process loads
 * no module of the operator's command line.
 */

/** The sweep writes its erasures under this name, so no operator may type it. */
export const SYSTEM_ACTOR = "system";

const DAY_MS = 86_400_000;

export interface SweepOptions {
  yes?: boolean;
  /** Unix milliseconds; `Date.now()` when absent. The scheduler hands its own clock. */
  nowMs?: number;
}

/** What a sweep found (and, with `yes`, erased): the count per rule is what the scheduler logs. */
export type SweepResult = {
  erased: boolean;
  count: number;
  rules: Record<ErasureRule, number>;
  checkIds: number[];
  next?: string;
};

/**
 * The OS user, when it can be read: the daily run must not fail for want of it. The operator's
 * `osUser` (`cli/operator.ts`) without its refusal, read here so the API process loads nothing of
 * the command line.
 */
function osUserIfReadable(): string | null {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    // No passwd entry for this uid: the login environment, then none.
  }
  return (process.env.USER ?? process.env.LOGNAME) || null;
}

/**
 * The names due for erasure under the retention rules (`erasureCandidates`: superseded or
 * abandoned after `IDENTITY_FAILED_RETENTION_DAYS`, a passed check unused after
 * `IDENTITY_UNUSED_RETENTION_DAYS`, never a tenant with a live company, never a review), and with
 * `yes` their erasure, each with a `names_erased` event by `system`, in ONE immediate transaction.
 * The scheduler runs it daily; `identity:sweep` is the manual path.
 */
export function sweepIdentityNames(
  db: Database.Database,
  cfg: Config,
  opts: SweepOptions,
): SweepResult {
  const nowMs = opts.nowMs ?? Date.now();
  const yes = opts.yes === true;
  const repo = new SqliteIdentityRepository(db);
  const actorOsUser = osUserIfReadable();
  const swept = repo.transaction(() => {
    const due = repo.erasureCandidates(
      nowMs,
      cfg.identity.failedRetentionDays * DAY_MS,
      cfg.identity.unusedRetentionDays * DAY_MS,
    );
    if (!yes) return due;
    const erased: typeof due = [];
    for (const c of due) {
      const done = repo.eraseNames(c.checkId, nowMs, {
        kind: "names_erased",
        at: nowMs,
        actor: SYSTEM_ACTOR,
        actorOsUser,
        reasonCode: c.rule,
        reason: null,
      });
      // False only for a row erased since the candidates were read: none, inside this transaction.
      if (done) erased.push(c);
    }
    return erased;
  });
  const rules: Record<ErasureRule, number> = { superseded: 0, abandoned: 0, unused: 0 };
  for (const c of swept) rules[c.rule] += 1;
  const result: SweepResult = {
    erased: yes,
    count: swept.length,
    rules,
    checkIds: swept.map((c) => c.checkId),
  };
  if (!yes)
    return { ...result, next: "nothing was erased: run identity:sweep --yes to erase these names" };
  // Every run with --yes, none erased included: the line says the sweep ran.
  opsLog("identity_names_erased", { count: result.count, rules });
  return result;
}
