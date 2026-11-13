import "dotenv/config";
import { pathToFileURL } from "node:url";
import { publicClientFor } from "../adapters/arc/clients";
import { prefillWildcardLedger } from "../adapters/arc/wildcardLedger";
import { loadConfig } from "../config/env";
import { ensureControllerRoleLedger, openDatabase } from "../persistence/db";

/**
 * `pnpm ledger:prefill` — build the controller's WILDCARD_ROLE ledger ahead of a release.
 *
 * The first API boot against an old controller replays its whole role history and can take many
 * minutes, during which the API is not serving. This runs the same boot check on its own, against
 * the same configuration and database, so the replay can happen while the previous release is
 * still up. The API's own check then resumes from the stored cursor and reads only the blocks
 * since. It prints the line the API prints and exits non-zero on any refusal.
 */
async function main() {
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
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
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
