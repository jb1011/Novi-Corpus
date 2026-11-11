import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * Another connection to the database file at `path`, in a worker thread, that takes the write
 * lock (BEGIN IMMEDIATE), inserts one row into `lock_probe`, holds the lock for `holdMs` and
 * commits. The caller creates `lock_probe (n INTEGER NOT NULL)` first, a table nothing under test
 * reads, so the other connection's write takes the lock and touches nothing else.
 *
 * Returns once the lock is held (or five seconds pass): `flag[0]` is 1 while it is held and 2 once
 * the worker has committed. `released()` resolves when the worker has exited. A worker thread,
 * because a connection on the test's own thread could not let go of its lock while the test's
 * connection waits for it.
 */
export function holdWriteLock(
  path: string,
  holdMs: number,
): { flag: Int32Array; released: () => Promise<void> } {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const driver = createRequire(import.meta.url).resolve("better-sqlite3");
  const worker = new Worker(
    `
    const { workerData } = require("node:worker_threads");
    const Database = require(workerData.driver);
    const flag = new Int32Array(workerData.flag);
    const db = new Database(workerData.path);
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO lock_probe (n) VALUES (1)").run();
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    Atomics.wait(flag, 1, 0, workerData.holdMs);
    db.exec("COMMIT");
    Atomics.store(flag, 0, 2);
    db.close();
    `,
    { eval: true, workerData: { driver, path, flag: flag.buffer, holdMs } },
  );
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", () => resolve());
  });
  // Block this thread until the worker holds the lock (or five seconds pass).
  Atomics.wait(flag, 0, 0, 5000);
  return { flag, released: () => exited };
}
