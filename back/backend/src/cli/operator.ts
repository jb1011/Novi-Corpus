import { userInfo } from "node:os";
import type Database from "better-sqlite3";
import { config as loadDotenv } from "dotenv";
import { type Config, loadConfig } from "../config/env";
import { openDatabase } from "../persistence/db";

/**
 * WHAT THE OPERATOR'S COMMANDS SHARE (`company:*`, `legal-body:revoke`, `identity:*`): the rules
 * an operator's name, an expected check id and a reason are held to, the OS user recorded beside
 * the name, the one JSON object a command prints, the refusal it throws (the entry point prints
 * the message and exits non-zero), and the database the configuration names.
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
