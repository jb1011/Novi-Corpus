import { userInfo } from "node:os";
import type Database from "better-sqlite3";
import { config as loadDotenv } from "dotenv";
import { type Config, loadConfig } from "../config/env";
import { openDatabase } from "../persistence/db";

/**
 * WHAT THE OPERATOR'S COMMANDS SHARE (`company:*`, `legal-body:revoke`, `identity:*`): the rule an
 * operator's name is held to, the OS user recorded beside it, the one JSON object a command
 * prints, the refusal it throws (the entry point prints the message and exits non-zero), and the
 * database the configuration names.
 */

export const OPERATOR_NAME = /^[a-z0-9._-]{2,40}$/;

export function refuse(message: string): never {
  throw new Error(`refusing: ${message}`);
}

/** The OS user running the command, recorded on every check beside the operator's name. */
export function osUser(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    // No passwd entry for this uid: fall back to the login environment below.
  }
  const fromEnv = process.env.USER ?? process.env.LOGNAME;
  if (fromEnv) return fromEnv;
  refuse("the OS user running this command cannot be read, and every check records it");
}

export function print(output: Record<string, unknown>): void {
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Opens the database the configuration names (never a path of its own: an operator who moved the
 * data directory must not open a different, empty database), runs `fn`, and closes it. `fn` is
 * handed the configuration too, for what the deployment decides.
 */
export function withDatabase<T>(
  fn: (db: Database.Database, docStoreDir: string, cfg: Config) => T,
): T {
  loadDotenv();
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  try {
    return fn(db, cfg.docStoreDir, cfg);
  } finally {
    db.close();
  }
}
