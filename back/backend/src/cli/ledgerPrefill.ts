import "dotenv/config";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicClientFor } from "../adapters/arc/clients";
import { prefillWildcardLedger } from "../adapters/arc/wildcardLedger";
import { loadConfig } from "../config/env";
import { ensureControllerRoleLedger, openDatabase } from "../persistence/db";

/**
 * `npm run ledger:prefill` — build the controller's WILDCARD_ROLE ledger ahead of a release.
 *
 * The first API boot against an old controller replays its whole role history and can take many
 * minutes, during which the API is not serving. This runs the same boot check on its own, against
 * the same configuration and database, so the replay can happen while the previous release is
 * still up. The API's own check then resumes from the stored cursor and reads only the blocks
 * since. It prints the line the API prints and exits non-zero on any refusal.
 *
 * It refuses when the database file does not exist. The API creates a missing database on boot,
 * but this tool exists to fill the database the running API already serves: run from a second
 * checkout with a relative `DATA_DIR`, it would otherwise build the ledger in a fresh file next to
 * that checkout and report success. The absolute path is printed so the operator can compare it
 * with the running API's.
 */
export function requireExistingDatabase(dbPath: string): string {
  const absolute = resolve(dbPath);
  if (!existsSync(absolute)) {
    const hint = "set DATA_DIR to that API's data directory (an absolute path) and run again.";
    throw new Error(
      `No database at ${absolute}. ledger:prefill fills the database the running API serves; ${hint}`,
    );
  }
  return absolute;
}

/** The message and, when the error carries one, its cause, one per line. */
export function describeFailure(e: unknown): string {
  const lines = [e instanceof Error ? e.message : String(e)];
  let cause = e instanceof Error ? e.cause : undefined;
  while (cause !== undefined) {
    lines.push(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}

async function main() {
  const cfg = loadConfig();
  const dbPath = requireExistingDatabase(cfg.dbPath);
  console.log(`Database: ${dbPath}`);
  const db = openDatabase(dbPath);
  try {
    // Only the one table this needs, never the full migrate(): the previous release may still be
    // serving this database, and migrate() carries schema changes and one-shot data moves it does
    // not expect. The release that follows runs the full migration itself at boot.
    ensureControllerRoleLedger(db);
    console.log(await prefillWildcardLedger(cfg, publicClientFor(cfg), db));
  } finally {
    db.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(describeFailure(e));
    process.exit(1);
  });
}
