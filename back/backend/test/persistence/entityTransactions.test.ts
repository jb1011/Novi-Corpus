import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { Address, EntityRecord } from "../../src/types";
import { holdWriteLock } from "../helpers/writeLock";

/**
 * The entity store's transaction, over a real WAL database file shared with another connection
 * (the payments authority, an operator's command, the MCP process).
 *
 * It takes the write lock at BEGIN (IMMEDIATE). A deferred transaction takes it at its first
 * write, and one that has read before that write cannot wait for the lock: when another
 * connection holds it, the write fails at once with SQLITE_BUSY, whatever the busy timeout, and
 * the request answers 500. Taken at BEGIN, the lock is waited for, up to the busy timeout.
 */

const HOLD_MS = 200;

let dir: string;
let path: string;
let db: Database.Database;
let repo: SqliteEntityRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "entity-transactions-"));
  path = join(dir, "novi.db");
  db = openDatabase(path);
  migrate(db);
  // Written only by the other connection, so its write takes the lock and touches nothing the
  // transaction under test reads.
  db.exec("CREATE TABLE lock_probe (n INTEGER NOT NULL)");
  repo = new SqliteEntityRepository(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<EntityRecord> = {}): EntityRecord => ({
  idempotencyKey: "key-1",
  name: "Demo Agent",
  status: "funded",
  manager: "0x000000000000000000000000000000000000aAaa" as Address,
  guardian: "0x000000000000000000000000000000000000bBbb" as Address,
  operator: null,
  amendmentDelay: "86400",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: "843704",
  proxy: "0x00000000000000000000000000000000000000cD" as Address,
  treasury: "0x00000000000000000000000000000000000000Ab" as Address,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  ...over,
});

const probes = () =>
  (db.prepare("SELECT n FROM lock_probe ORDER BY n").all() as { n: number }[]).map((r) => r.n);

describe("SqliteEntityRepository.transaction takes the write lock at BEGIN", () => {
  test("while another connection holds a write, a read-then-write waits for it and commits, rather than failing with SQLITE_BUSY", async () => {
    repo.upsert(record());

    const lock = holdWriteLock(path, HOLD_MS);
    try {
      expect(Atomics.load(lock.flag, 0)).toBe(1);
      const started = Date.now();
      repo.transaction(() => {
        const current = repo.findByIdempotencyKey("key-1"); // reads first
        repo.upsert({ ...current!, name: "Renamed Agent" }); // then writes
      });
      const waited = Date.now() - started;

      expect(repo.findByIdempotencyKey("key-1")?.name).toBe("Renamed Agent");
      // It waited for the other connection's commit, which landed too.
      expect(waited).toBeGreaterThanOrEqual(100);
      expect(Atomics.load(lock.flag, 0)).toBe(2);
    } finally {
      await lock.released();
    }
    expect(probes()).toEqual([1]);
  });

  test("nested, it is a savepoint of the outer transaction, whoever opened it: an inner failure undoes only its own writes", () => {
    const insert = (n: number) => db.prepare("INSERT INTO lock_probe (n) VALUES (?)").run(n);
    repo.transaction(() => {
      repo.transaction(() => insert(1));
      expect(() =>
        repo.transaction(() => {
          insert(2);
          throw new Error("the inner write fails");
        }),
      ).toThrow("the inner write fails");
      insert(3);
    });
    expect(probes()).toEqual([1, 3]);

    // An outer transaction another store opened on the same handle (a deferred one here, as the
    // anchor store's is): the inner one is its savepoint too, not a second BEGIN.
    db.transaction(() => {
      repo.transaction(() => insert(4));
      expect(db.inTransaction).toBe(true);
      insert(5);
    })();
    expect(probes()).toEqual([1, 3, 4, 5]);
  });
});

describe("openDatabase's busy timeout", () => {
  test("is set explicitly to 5000 ms, the wait the IMMEDIATE transactions rely on", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
  });
});
