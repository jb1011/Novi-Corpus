import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { holdWriteLock } from "../helpers/writeLock";

/**
 * The World ID counters (`world_usage`) over a real WAL database file shared with another
 * connection, as the x402 seller's AgentKit allowance meets them on a request.
 *
 * Both counters read the row before they write it, so they take the write lock at BEGIN
 * (IMMEDIATE): another connection's write is waited for, up to the busy timeout. A deferred
 * transaction that has read cannot wait for the lock, and its write fails at once with
 * SQLITE_BUSY. The peek (a limit of zero) never writes, so it reads without taking the lock.
 */

const HOLD_MS = 200;
const HUMAN = "0xhuman";
const RESOURCE = "https://example.com/x402-demo/quote";
const WINDOW = 60_000;
const T = 1_000_000;

let dir: string;
let path: string;
let db: Database.Database;
let store: SqliteWorldStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "world-usage-locking-"));
  path = join(dir, "novi.db");
  db = openDatabase(path);
  migrate(db);
  // Written only by the other connection, so its write takes the lock and touches nothing the
  // counters read.
  db.exec("CREATE TABLE lock_probe (n INTEGER NOT NULL)");
  store = new SqliteWorldStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Run `fn` while another connection holds the write lock; how long it took, and its answer. */
async function underAnotherWrite<T>(
  fn: () => T,
): Promise<{ result: T; waited: number; heldOnReturn: boolean }> {
  const lock = holdWriteLock(path, HOLD_MS);
  try {
    expect(Atomics.load(lock.flag, 0)).toBe(1);
    const started = Date.now();
    const result = fn();
    const waited = Date.now() - started;
    return { result, waited, heldOnReturn: Atomics.load(lock.flag, 0) === 1 };
  } finally {
    await lock.released();
  }
}

describe("the World ID counters take the write lock at BEGIN", () => {
  test("while another connection holds a write, tryIncrementUsage waits for it and charges, rather than failing with SQLITE_BUSY", async () => {
    expect(store.tryIncrementUsage(HUMAN, RESOURCE, 3, T, WINDOW).used).toBe(1);

    const { result, waited, heldOnReturn } = await underAnotherWrite(() =>
      store.tryIncrementUsage(HUMAN, RESOURCE, 3, T + 1, WINDOW),
    );

    expect(result).toEqual({ allowed: true, used: 2, resetAt: T + WINDOW });
    // It waited for the other connection's commit, which landed too.
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(heldOnReturn).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lock_probe").get()).toEqual({ n: 1 });
  });

  test("while another connection holds a write, tryConsumePaidAttempt waits for it and claims, rather than failing with SQLITE_BUSY", async () => {
    store.tryIncrementUsage(HUMAN, RESOURCE, 3, T, WINDOW); // one unit charged: one invoice

    const { result, waited, heldOnReturn } = await underAnotherWrite(() =>
      store.tryConsumePaidAttempt(HUMAN, RESOURCE, T + 1, WINDOW),
    );

    expect(result).toEqual({ allowed: true, paidAttempts: 1, unitsCharged: 1 });
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(heldOnReturn).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lock_probe").get()).toEqual({ n: 1 });
  });

  test("the peek (a limit of zero) never writes, so it answers at once without taking the lock", async () => {
    store.tryIncrementUsage(HUMAN, RESOURCE, 3, T, WINDOW);

    const { result, heldOnReturn } = await underAnotherWrite(() =>
      store.tryIncrementUsage(HUMAN, RESOURCE, 0, T + 1, WINDOW),
    );

    expect(result).toEqual({ allowed: false, used: 1, resetAt: T + WINDOW });
    // Answered while the other connection still held the lock: it did not wait for it.
    expect(heldOnReturn).toBe(true);
    expect(
      db.prepare("SELECT used, paid_attempts, updated_at FROM world_usage").get() as unknown,
    ).toEqual({ used: 1, paid_attempts: 0, updated_at: T });
  });
});
