import { userInfo } from "node:os";
import type Database from "better-sqlite3";
import { config as loadDotenv } from "dotenv";
import { getAddress } from "viem";
import { type Config, loadConfig } from "../config/env";
import { openDatabase } from "../persistence/db";

/**
 * WHAT THE OPERATOR'S COMMANDS SHARE (`company:*`, `legal-body:revoke`, `identity:*`, `email:*`):
 * the rules an operator's name, an expected check id, a reason and a tenant are held to, the OS
 * user recorded beside the name, the one JSON object a command prints, the refusal it throws (the
 * entry point prints the message and exits non-zero), and the database the configuration names.
 */

export const OPERATOR_NAME = /^[a-z0-9._-]{2,40}$/;
export const CHECK_ID = /^[1-9][0-9]{0,15}$/;
export const MAX_REASON_CODE_POINTS = 300;
/** Control, format and other invisible characters, as the check rows refuse them. */
export const OTHER_CHARACTER = /\p{C}/u;

export function refuse(message: string): never {
  throw new Error(`refusing: ${message}`);
}

/**
 * An operator's name. A name the commands write under themselves is `reserved`, and no operator
 * may type it: a row under it would read as one nobody decided.
 */
export function parseOperator(value: string, reserved?: { name: string; purpose: string }): string {
  if (!OPERATOR_NAME.test(value)) refuse(`--operator must match ${OPERATOR_NAME.source}`);
  if (reserved !== undefined && value === reserved.name)
    refuse(`--operator ${reserved.name} is reserved for ${reserved.purpose}`);
  return value;
}

/** A check id, or null for `none` when `none` is allowed. */
export function parseExpectLatest(value: string, allowNone: boolean): number | null {
  if (allowNone && value === "none") return null;
  if (!CHECK_ID.test(value))
    refuse(`--expect-latest must be a check id${allowNone ? " or none" : ""}`);
  return Number(value);
}

/** Text of 1 to 300 code points with no control or invisible character. */
export function parseReason(value: string): string {
  if (value.length === 0) refuse("--reason must not be empty");
  if ([...value].length > MAX_REASON_CODE_POINTS)
    refuse(`--reason must be at most ${MAX_REASON_CODE_POINTS} characters`);
  if (OTHER_CHARACTER.test(value))
    refuse("--reason must not hold a control, format or other invisible character");
  return value;
}

/** A flag's value from its closed list; a missing value is refused like a wrong one. */
export function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value))
    refuse(`${flag} must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** A tenant (a guardian's account, its wallet address) in the one spelling its rows are kept
 *  under: EIP-55 checksummed. Anything that is not an address is refused. */
export function parseTenant(value: string): string {
  try {
    return getAddress(value);
  } catch {
    return refuse("<tenantId> must be a wallet address");
  }
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

/** The configuration the operator's commands run under: the `.env` file, then the environment. */
export function operatorConfig(): Config {
  loadDotenv();
  return loadConfig();
}

/**
 * Whether the database holds every table named: false on a database the API of this build has not
 * migrated yet (the operator's commands never migrate; the API does at its start), so a command
 * can say so instead of failing on a SQLite error.
 */
export function hasTables(db: Database.Database, names: readonly string[]): boolean {
  const present = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name),
  );
  return names.every((name) => present.has(name));
}

/**
 * Opens the database the configuration names (never a path of its own: an operator who moved the
 * data directory must not open a different, empty database), runs `fn`, and closes it. `fn` is
 * handed the configuration too, for what the deployment decides. A command that checks the
 * configuration before it reads anything hands in the one it loaded.
 */
export function withDatabase<T>(
  fn: (db: Database.Database, docStoreDir: string, cfg: Config) => T,
  cfg: Config = operatorConfig(),
): T {
  const db = openDatabase(cfg.dbPath);
  try {
    return fn(db, cfg.docStoreDir, cfg);
  } finally {
    db.close();
  }
}

/**
 * `withDatabase` for a command whose work is asynchronous: the database is closed once `fn`'s
 * promise settles, never while it is still running (`withDatabase` would close it as soon as `fn`
 * returned its promise).
 */
export async function withDatabaseAsync<T>(
  fn: (db: Database.Database, docStoreDir: string, cfg: Config) => Promise<T>,
): Promise<T> {
  loadDotenv();
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  try {
    return await fn(db, cfg.docStoreDir, cfg);
  } finally {
    db.close();
  }
}
