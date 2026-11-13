import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hex } from "viem";

/**
 * THE READS OF A LEGAL BODY'S PUBLIC STATEMENT: the funnel's "statement reads" stage
 * (`funnel:export`, design §6.14). One row per legal body, UTC day, caller kind and caller,
 * written by `GET /legal-bodies/by-agent/:agentId` with INSERT OR IGNORE for every answer that is
 * the body's signed statement: a second read by the same caller the same day writes nothing.
 *
 * The caller is the per-client limiter's key (the last X-Forwarded-For entry, or `direct`), and it
 * is stored only as `callerDayHash`: sha256 of the key, the day and FUNNEL_SALT. The key itself, a
 * client's network address, is never stored, and a new day gives the same caller a new hash, so
 * the rows of two days cannot be joined by caller. A deployment without FUNNEL_SALT records no read
 * at all: an unsalted hash of an address is the address, to anyone who can enumerate addresses.
 *
 * Not `statement_log`, which skips a statement whose claims did not change and would count a
 * second read as nothing. The table is `statement_reads` in db.ts; nothing but the funnel reads it.
 *
 * WHEN READS BEGAN TO BE RECORDED: `funnel_statement_reads_since` in `meta` (unix milliseconds as
 * text; INSERT OR IGNORE, so the first one stands), so the export prints no zero for a week before
 * reads were recorded, and a measured zero after. The API builds this store only on a salted
 * deployment and hands it its boot time (`bootedAt`), written at once: the weeks from the first
 * salted boot print 0 until a read comes. The first row recorded writes its own time too, the
 * fallback for a database salted before the boot wrote it.
 */

/** `owner`: the request carried a valid session of the body's own tenant. */
export type StatementReadCaller = "owner" | "anonymous";

export interface StatementRead {
  legalBodyId: string;
  /** UTC, `YYYY-MM-DD`. */
  day: string;
  callerKind: StatementReadCaller;
  /** `callerDayHash(key, day, salt)`. */
  callerDayHash: Hex;
  /** Unix milliseconds. */
  firstReadAt: number;
}

export interface StatementReadRepository {
  /**
   * Records the read unless the same body, day, kind and caller has one. True when this call wrote
   * the row. Throws, before writing, for a value no row may hold.
   */
  record(read: StatementRead): boolean;
}

/** The UTC day of a time in milliseconds, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** sha256(key | day | salt), `0x` and 64 lower-case hex digits: the only form a caller is kept in. */
export function callerDayHash(clientKey: string, day: string, salt: string): Hex {
  return `0x${createHash("sha256").update(`${clientKey}|${day}|${salt}`).digest("hex")}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HASH = /^0x[0-9a-f]{64}$/;
/** The smallest time in milliseconds the table takes: past the largest the seconds columns do. */
const MIN_MILLIS = 100_000_000_000;

function refuse(field: string, rule: string): never {
  throw new Error(`statement_reads: ${field} ${rule}`);
}

/** The `meta` key of the time the first read was recorded. */
export const STATEMENT_READS_SINCE_KEY = "funnel_statement_reads_since";

export class SqliteStatementReadRepository implements StatementReadRepository {
  private readonly stmts;
  private readonly insertRead: (read: StatementRead) => boolean;
  /** This store has seen the since-key written (or found): no second write of it per process. */
  private sinceWritten = false;

  /**
   * `bootedAt`: the API's boot time, unix milliseconds, given only where the API records reads (a
   * salted deployment): written as the time reads are recorded since, unless one is kept already.
   */
  constructor(db: Database.Database, o: { bootedAt?: number } = {}) {
    this.stmts = {
      insert: db.prepare(
        `INSERT OR IGNORE INTO statement_reads
           (legal_body_id, day, caller_kind, caller_day_hash, first_read_at)
         VALUES (@legal_body_id, @day, @caller_kind, @caller_day_hash, @first_read_at)`,
      ),
      since: db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)"),
    };
    // The row and, with the first one, the date reads are recorded since: one transaction.
    this.insertRead = db.transaction((read: StatementRead): boolean => {
      const inserted =
        this.stmts.insert.run({
          legal_body_id: read.legalBodyId,
          day: read.day,
          caller_kind: read.callerKind,
          caller_day_hash: read.callerDayHash,
          first_read_at: read.firstReadAt,
        }).changes === 1;
      if (inserted && !this.sinceWritten)
        this.stmts.since.run(STATEMENT_READS_SINCE_KEY, String(read.firstReadAt));
      return inserted;
    });
    if (o.bootedAt !== undefined) {
      if (!Number.isSafeInteger(o.bootedAt) || o.bootedAt < MIN_MILLIS)
        refuse("bootedAt", "must be whole unix milliseconds");
      this.stmts.since.run(STATEMENT_READS_SINCE_KEY, String(o.bootedAt));
      this.sinceWritten = true;
    }
  }

  record(read: StatementRead): boolean {
    if (typeof read.legalBodyId !== "string" || read.legalBodyId.length === 0)
      refuse("legalBodyId", "must be a legal body id");
    if (
      typeof read.day !== "string" ||
      !DAY.test(read.day) ||
      Number.isNaN(Date.parse(`${read.day}T00:00:00Z`)) ||
      utcDay(Date.parse(`${read.day}T00:00:00Z`)) !== read.day
    )
      refuse("day", "must be a UTC day, YYYY-MM-DD");
    if (read.callerKind !== "owner" && read.callerKind !== "anonymous")
      refuse("callerKind", "must be owner or anonymous");
    if (typeof read.callerDayHash !== "string" || !HASH.test(read.callerDayHash))
      refuse("callerDayHash", "must be a sha256 hash, 0x and 64 lower-case hex digits");
    if (!Number.isSafeInteger(read.firstReadAt) || read.firstReadAt < MIN_MILLIS)
      refuse("firstReadAt", "must be whole unix milliseconds");
    const inserted = this.insertRead(read);
    if (inserted) this.sinceWritten = true;
    return inserted;
  }
}
