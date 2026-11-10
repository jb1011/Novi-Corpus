/**
 * `statement_reads`: the funnel's "statement reads" stage. The public by-agent route records one
 * row per legal body, UTC day, caller kind and caller, for every answer that is a body's signed
 * statement, the memo's replays included. The caller is the limiter's key (the last
 * X-Forwarded-For entry, or `direct`), stored only as sha256(key | day | FUNNEL_SALT). It reads
 * `owner` when the request carries a valid session of the body's own tenant, `anonymous`
 * otherwise. The route stays public: a bearer is read when present, never required, and a bad one
 * changes nothing but the caller kind. Without FUNNEL_SALT no read is recorded at all. What the
 * route answers is the same, byte for byte, for every caller.
 *
 * The row is written AFTER the answer is handed back (the caller kind decided before), so a busy
 * database never delays the read; a repeat of a recent (body, day, kind, caller) never reaches the
 * database; and the writes draw on a budget of their own (600 at once, then 1 a second), so a
 * caller who changes its key on every request cannot write without bound: a write the budget
 * refuses is dropped and counted, the answer unchanged. A count the once-a-minute lines hold back
 * is printed when its minute ends, or at the API's shutdown, never left for a next event.
 *
 * The statement service over a real in-memory database and a fake chain, on a fixed clock. Every
 * key is one of anvil's published test accounts, every other address a placeholder, and every
 * client address a documentation address (RFC 5737).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { StatementReadLines } from "../../src/api/routes/legalBodyStatements";
import { signSession } from "../../src/auth/session";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import {
  SqliteStatementReadRepository,
  type StatementReadRepository,
  callerDayHash,
} from "../../src/persistence/statementReadRepository";
import { ANVIL_ACCOUNT_3 } from "../helpers/customerCompanyFixtures";
import {
  CLOCK_MS,
  FakeStatementChain,
  type StatementStores,
  TENANT,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

const SECRET = "s";
const SALT = "5a".repeat(32);
/** The read rows the route writes at once, for all callers together, before the refill. */
const BURST = 600;
const DAY = 86_400_000;
const CLIENT_A = "192.0.2.10";
const CLIENT_B = "198.51.100.7";

let s: StatementStores;
let chain: FakeStatementChain;
let clock: number;
let printed: string[];

beforeEach(() => {
  s = openStatementStores();
  chain = new FakeStatementChain();
  clock = CLOCK_MS;
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  s.db.close();
});

interface AppOptions {
  /** The read store; `null`: none, as on a deployment without FUNNEL_SALT. */
  reads?: StatementReadRepository | null;
  /** The route's once-a-minute lines, as the composition root hands them in; else its own. */
  lines?: StatementReadLines;
}

function makeApp(o: AppOptions = {}) {
  const repo = o.reads === undefined ? new SqliteStatementReadRepository(s.db) : o.reads;
  return buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: SECRET,
    now: () => clock,
    legalBodyStatements: statementDeps(s, chain, { now: () => clock }),
    statementReads: repo === null ? undefined : { repo, salt: SALT, lines: o.lines },
  } as never);
}
type App = ReturnType<typeof makeApp>;

type ReadOptions = { client?: string; authorization?: string; agentId?: string };

/** A read of agent 42's statement from `client`, with an Authorization header when given: the
 *  answer as it is handed back, before the deferred write has run. */
const request = (app: App, o: ReadOptions = {}) => {
  const headers: Record<string, string> = {};
  if (o.client !== undefined) headers["x-forwarded-for"] = o.client;
  if (o.authorization !== undefined) headers.authorization = o.authorization;
  return app.request(`/legal-bodies/by-agent/${o.agentId ?? "42"}`, { headers });
};

/** Every write deferred so far has run: they are queued with setImmediate before the answer. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `request`, then the deferred write. */
async function read(app: App, o: ReadOptions = {}): Promise<Response> {
  const res = await request(app, o);
  await settle();
  return res;
}

/** A store over the test database that counts the rows handed to it. */
function countingStore() {
  const real = new SqliteStatementReadRepository(s.db);
  const store = {
    calls: 0,
    record: (r: Parameters<StatementReadRepository["record"]>[0]) => {
      store.calls += 1;
      return real.record(r);
    },
  };
  return store;
}

/** The parsed ops lines for `event`, each without its `opslog` and `at` fields. */
const opsLines = (event: string) =>
  printed
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => line.opslog === event)
    .map(({ opslog: _o, at: _a, ...rest }) => rest);

/** A linked body of agent 42 on chain, of the shared tenant. */
function linkedBody(): LegalBodyRecord {
  const companyId = readyCompany(s);
  s.checks.append(passedCheck(companyId));
  const row = bodyIn("linked", s, companyId, { agentId: "42" });
  chain.link(row);
  return row;
}

/** A session bearer of `tenant`, valid against the real clock (the JWT check reads it). */
async function bearerOf(tenant: string): Promise<string> {
  const { token } = await signSession(tenant, SECRET, 3600, Math.floor(Date.now() / 1000));
  return `Bearer ${token}`;
}

interface ReadRow {
  legal_body_id: string;
  day: string;
  caller_kind: string;
  caller_day_hash: string;
  first_read_at: number;
}
const rows = () =>
  s.db
    .prepare("SELECT * FROM statement_reads ORDER BY first_read_at, caller_day_hash")
    .all() as ReadRow[];

const sha256 = (text: string) => `0x${createHash("sha256").update(text).digest("hex")}`;

/** A response's headers, as name/value pairs. */
function headersOf(res: Response): [string, string][] {
  const out: [string, string][] = [];
  res.headers.forEach((value, name) => {
    out.push([name, value]);
  });
  return out;
}

describe("what is recorded", () => {
  test("anonymous reads: one row per caller and day, the same caller the same day writing nothing more", async () => {
    const row = linkedBody();
    const app = makeApp();

    expect((await read(app, { client: CLIENT_A })).status).toBe(200);
    expect(rows()).toEqual([
      {
        legal_body_id: row.legalBodyId,
        day: "2026-10-07",
        caller_kind: "anonymous",
        caller_day_hash: callerDayHash(CLIENT_A, "2026-10-07", SALT),
        first_read_at: CLOCK_MS,
      },
    ]);

    // The same caller later the same day: the row stands, at its first read.
    clock += 60_000;
    await read(app, { client: CLIENT_A });
    expect(rows()).toHaveLength(1);

    // Another caller the same day: a second row.
    await read(app, { client: CLIENT_B });
    expect(rows().map((r) => [r.day, r.caller_kind])).toEqual([
      ["2026-10-07", "anonymous"],
      ["2026-10-07", "anonymous"],
    ]);

    // The first caller the next day: a third row, under that day's hash.
    clock = CLOCK_MS + DAY;
    expect((await read(app, { client: CLIENT_A })).status).toBe(200);
    const all = rows();
    expect(all).toHaveLength(3);
    expect(all[2]).toEqual({
      legal_body_id: row.legalBodyId,
      day: "2026-10-08",
      caller_kind: "anonymous",
      caller_day_hash: callerDayHash(CLIENT_A, "2026-10-08", SALT),
      first_read_at: CLOCK_MS + DAY,
    });
  });

  test("a memo replay is a read too: a second caller inside the memo window is recorded", async () => {
    linkedBody();
    const app = makeApp();
    await read(app, { client: CLIENT_A });
    const snapshots = chain.snapshots.length;
    clock += 1_000;
    await read(app, { client: CLIENT_B });
    // Served from the memo: no chain read, and still recorded.
    expect(chain.snapshots).toHaveLength(snapshots);
    expect(rows()).toHaveLength(2);
  });

  test("the caller is the limiter's key: the last X-Forwarded-For entry, or direct", async () => {
    linkedBody();
    const app = makeApp();
    await read(app, { client: `203.0.113.99, ${CLIENT_A}` });
    await read(app, {});
    expect(rows().map((r) => r.caller_day_hash)).toEqual(
      [
        callerDayHash(CLIENT_A, "2026-10-07", SALT),
        callerDayHash("direct", "2026-10-07", SALT),
      ].sort(),
    );
  });

  test("the stored hash is sha256(key | day | salt), and no column holds the key", async () => {
    linkedBody();
    await read(makeApp(), { client: CLIENT_A });
    const [stored] = rows();
    expect(stored?.caller_day_hash).toBe(sha256(`${CLIENT_A}|2026-10-07|${SALT}`));
    expect(stored?.caller_day_hash).not.toBe(sha256(CLIENT_A));
    expect(JSON.stringify(stored)).not.toContain(CLIENT_A);
    // Nothing else in the database holds it either.
    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const dump = tables.flatMap(({ name }) => s.db.prepare(`SELECT * FROM "${name}"`).all());
    expect(JSON.stringify(dump)).not.toContain(CLIENT_A);
  });

  test("the owner's session: owner; another account's session: anonymous", async () => {
    const row = linkedBody();
    const app = makeApp();
    await read(app, { client: CLIENT_A, authorization: await bearerOf(TENANT) });
    await read(app, { client: CLIENT_B, authorization: await bearerOf(ANVIL_ACCOUNT_3.address) });
    // The owner's session in lower case is the same account.
    await read(app, { client: CLIENT_B, authorization: await bearerOf(TENANT.toLowerCase()) });

    const byKind = rows().map((r) => [r.caller_day_hash, r.caller_kind, r.legal_body_id]);
    expect(byKind).toEqual(
      expect.arrayContaining([
        [callerDayHash(CLIENT_A, "2026-10-07", SALT), "owner", row.legalBodyId],
        [callerDayHash(CLIENT_B, "2026-10-07", SALT), "anonymous", row.legalBodyId],
        [callerDayHash(CLIENT_B, "2026-10-07", SALT), "owner", row.legalBodyId],
      ]),
    );
    expect(byKind).toHaveLength(3);
  });

  test("a malformed, expired, foreign or non-Bearer authorization still gets the statement, as anonymous", async () => {
    linkedBody();
    const app = makeApp();
    const plain = await (await read(app, { client: CLIENT_A })).text();
    const expired = (await signSession(TENANT, SECRET, 1, Math.floor(Date.now() / 1000) - 3600))
      .token;
    const foreign = (
      await signSession(TENANT, "another-secret", 3600, Math.floor(Date.now() / 1000))
    ).token;
    for (const authorization of [
      "Bearer not-a-jwt",
      "Bearer",
      "Bearer ",
      `Bearer ${expired}`,
      `Bearer ${foreign}`,
      `Basic ${Buffer.from("a:b").toString("base64")}`,
      "garbage",
    ]) {
      const res = await read(app, { client: CLIENT_B, authorization });
      expect(res.status, authorization).toBe(200);
      expect(await res.text(), authorization).toBe(plain);
    }
    expect(new Set(rows().map((r) => r.caller_kind))).toEqual(new Set(["anonymous"]));
    expect(rows()).toHaveLength(2);
  });

  test("no row for an answer that is not a body's statement: none, unknown, a 400", async () => {
    linkedBody();
    const app = makeApp();
    // No legal body for agent 7.
    expect((await (await read(app, { client: CLIENT_A, agentId: "7" })).json()).legalBody).toBe(
      false,
    );
    // A chain read that fails: unknown, unsigned.
    chain.beforeSnapshot = () => {
      throw new Error("execution reverted");
    };
    expect((await (await read(app, { client: CLIENT_A })).json()).standing).toBe("unknown");
    expect((await read(app, { client: CLIENT_A, agentId: "042" })).status).toBe(400);
    expect(rows()).toEqual([]);
  });
});

describe("what the route answers", () => {
  test("byte for byte the same, with its headers, for an anonymous caller, the owner, another account and a bad bearer", async () => {
    linkedBody();
    const owner = await bearerOf(TENANT);
    const another = await bearerOf(ANVIL_ACCOUNT_3.address);
    // A fresh app for each caller, so each answer is made, not replayed from another's memo.
    const answers: { text: string; headers: [string, string][] }[] = [];
    for (const authorization of [undefined, owner, another, "Bearer not-a-jwt"]) {
      const res = await read(makeApp(), { client: CLIENT_A, authorization });
      expect(res.status).toBe(200);
      answers.push({ text: await res.text(), headers: headersOf(res) });
    }
    expect(answers).toHaveLength(4);
    for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0]);
    // Each caller was recorded: the owner as owner, the rest as anonymous.
    expect(
      rows()
        .map((r) => r.caller_kind)
        .sort(),
    ).toEqual(["anonymous", "owner"]);
    // And the same as a deployment that records nothing.
    const unrecorded = await read(makeApp({ reads: null }), { client: CLIENT_A });
    expect({ text: await unrecorded.text(), headers: headersOf(unrecorded) }).toEqual(answers[0]);
  });

  test("without FUNNEL_SALT no read is recorded, and the statement is served as before", async () => {
    linkedBody();
    const app = makeApp({ reads: null });
    const res = await read(app, { client: CLIENT_A, authorization: await bearerOf(TENANT) });
    expect(res.status).toBe(200);
    expect((await res.json()).standing).toBe("active");
    expect(rows()).toEqual([]);
  });

  test("a read that cannot be recorded is served all the same, and its ops line names no caller, once a minute", async () => {
    linkedBody();
    const broken: StatementReadRepository = {
      record: () => {
        throw Object.assign(new Error(`SQLITE_BUSY recording ${CLIENT_A}`), {
          name: "SqliteError",
        });
      },
    };
    const app = makeApp({ reads: broken });
    const failedLines = () => opsLines("legal_body_statement_read_failed");

    const res = await read(app, { client: CLIENT_A });
    expect(res.status).toBe(200);
    expect((await res.json()).standing).toBe("active");
    expect(failedLines()).toEqual([{ errorName: "SqliteError", count: 1 }]);

    // Memo replays inside the minute: served, and no second line.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      expect((await read(app, { client: CLIENT_B })).status).toBe(200);
    }
    expect(failedLines()).toHaveLength(1);
    // A minute after the first line: one more, counting the five it held back and its own.
    clock = CLOCK_MS + 60_000;
    expect((await read(app, { client: CLIENT_A })).status).toBe(200);
    expect(failedLines()).toEqual([
      { errorName: "SqliteError", count: 1 },
      { errorName: "SqliteError", count: 6 },
    ]);
    expect(printed.join("\n")).not.toContain(CLIENT_A);
  });

  test("no ops line carries a caller's address or the salt", async () => {
    linkedBody();
    const app = makeApp();
    await read(app, { client: CLIENT_A });
    await read(app, { client: CLIENT_B, authorization: await bearerOf(TENANT) });
    await read(app, { client: CLIENT_B, authorization: "Bearer not-a-jwt" });
    const all = printed.join("\n");
    for (const secret of [CLIENT_A, CLIENT_B, SALT]) expect(all).not.toContain(secret);
  });
});

describe("the write: after the answer, once per caller, within a budget", () => {
  test("the row is written after the answer is handed back, the owner decided before", async () => {
    linkedBody();
    const store = countingStore();
    const app = makeApp({ reads: store });
    const res = await request(app, { client: CLIENT_A, authorization: await bearerOf(TENANT) });
    expect(res.status).toBe(200);
    // Handed back: nothing has reached the store yet.
    expect(store.calls).toBe(0);
    expect(rows()).toEqual([]);
    await settle();
    expect(store.calls).toBe(1);
    expect(rows().map((r) => r.caller_kind)).toEqual(["owner"]);
  });

  test("a repeated (body, day, caller) does not reach the database a second time, nor the budget", async () => {
    linkedBody();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CLOCK_MS);
    const store = countingStore();
    const app = makeApp({ reads: store });
    await read(app, { client: CLIENT_A });
    await read(app, { client: CLIENT_A });
    clock += 60_000;
    await read(app, { client: CLIENT_A });
    expect(store.calls).toBe(1);
    expect(rows()).toHaveLength(1);

    // With the clock that refills the budget held still: 299 more callers, each twice, take 299
    // of the 599 writes left; 300 new callers then take the other 300. A repeat that spent a
    // write would leave some of them dropped.
    const callers = (from: number, n: number) =>
      Array.from(
        { length: n },
        (_, i) => `192.0.${Math.floor((from + i) / 250)}.${(from + i) % 250}`,
      );
    for (const client of callers(1_000, 299)) {
      await read(app, { client });
      await read(app, { client });
    }
    for (const client of callers(2_000, 300)) await read(app, { client });
    expect(store.calls).toBe(BURST);
    expect(rows()).toHaveLength(BURST);
    expect(opsLines("legal_body_statement_read_dropped")).toEqual([]);
  });

  test("more callers at once than the budget: at most the budget's rows, every answer 200 and the same; the drops counted once a minute", async () => {
    linkedBody();
    // The held-back count's timer is faked too, so none is left running after the test.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(CLOCK_MS);
    const app = makeApp();
    const answers = new Set<string>();
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
    const client = (i: number) => `10.0.${Math.floor(i / 250)}.${i % 250}`;

    // 1000 callers, each with a new key, inside one second: 600 rows, 400 dropped.
    for (const i of many(0, 1_000)) {
      const res = await read(app, { client: client(i) });
      expect(res.status).toBe(200);
      answers.add(await res.text());
    }
    expect(answers.size).toBe(1);
    expect(rows()).toHaveLength(BURST);
    // The first drop writes a line at once; the next 399 wait for the window.
    expect(opsLines("legal_body_statement_read_dropped")).toEqual([{ count: 1 }]);

    // A minute later, still no refill: 5 more dropped. The first of them writes one line counting
    // the 399 held back and itself; the other 4 wait for the next window.
    clock += 60_000;
    for (const i of many(1_000, 5)) await read(app, { client: client(i) });
    expect(rows()).toHaveLength(BURST);
    expect(opsLines("legal_body_statement_read_dropped")).toEqual([{ count: 1 }, { count: 400 }]);

    // Ten seconds of refill: ten more rows, whatever the number of callers.
    vi.setSystemTime(CLOCK_MS + 10_000);
    for (const i of many(1_100, 15)) await read(app, { client: client(i) });
    expect(rows()).toHaveLength(BURST + 10);
    const all = printed.join("\n");
    expect(all).not.toContain("10.0.");
  });
});

describe("a count held back is always printed", () => {
  /** An app whose read store always fails: every read is a failed write, one line a minute. */
  function failingApp(lines?: StatementReadLines) {
    const broken: StatementReadRepository = {
      record: () => {
        throw Object.assign(new Error("SQLITE_BUSY"), { name: "SqliteError" });
      },
    };
    return makeApp({ reads: broken, lines });
  }
  const failedLines = () => opsLines("legal_body_statement_read_failed");

  test("when its window closes, with no further event", async () => {
    linkedBody();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const app = failingApp();
    await read(app, { client: CLIENT_A });
    clock += 1_000;
    await read(app, { client: CLIENT_B });
    // The second failure is held: the line of the first is less than a minute old.
    expect(failedLines()).toEqual([{ errorName: "SqliteError", count: 1 }]);

    vi.advanceTimersByTime(58_999);
    expect(failedLines()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(failedLines()).toEqual([
      { errorName: "SqliteError", count: 1 },
      { errorName: "SqliteError", count: 1 },
    ]);
    // Nothing held any more: no timer, no line.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(failedLines()).toHaveLength(2);
  });

  test("its timer does not keep the process alive", async () => {
    linkedBody();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const app = failingApp();
    await read(app, { client: CLIENT_A });
    clock += 1_000;
    await read(app, { client: CLIENT_B });
    const held = timers.mock.calls.findIndex(([, ms]) => ms === 59_000);
    expect(held).toBeGreaterThanOrEqual(0);
    const timer = timers.mock.results[held]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    clearTimeout(timer);
  });

  test("at once by flush(), which the API's shutdown calls, and not a second time when the window closes", async () => {
    linkedBody();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lines = new StatementReadLines(() => clock);
    const app = failingApp(lines);
    await read(app, { client: CLIENT_A });
    clock += 1_000;
    await read(app, { client: CLIENT_B });
    clock += 1_000;
    await read(app, { client: CLIENT_A });
    expect(failedLines()).toHaveLength(1);

    lines.flush();
    expect(failedLines()).toEqual([
      { errorName: "SqliteError", count: 1 },
      { errorName: "SqliteError", count: 2 },
    ]);
    vi.advanceTimersByTime(120_000);
    expect(failedLines()).toHaveLength(2);
    // A flush with nothing held prints nothing.
    lines.flush();
    expect(failedLines()).toHaveLength(2);
  });
});

describe("the store", () => {
  test("refuses a malformed row before any write", () => {
    const row = linkedBody();
    const repo = new SqliteStatementReadRepository(s.db);
    const good = {
      legalBodyId: row.legalBodyId,
      day: "2026-10-07",
      callerKind: "anonymous" as const,
      callerDayHash: callerDayHash(CLIENT_A, "2026-10-07", SALT),
      firstReadAt: CLOCK_MS,
    };
    expect(repo.record(good)).toBe(true);
    expect(repo.record({ ...good, firstReadAt: CLOCK_MS + 1 })).toBe(false);
    expect(() => repo.record({ ...good, day: "2026-10-7" })).toThrow(/day/);
    expect(() => repo.record({ ...good, day: "2026-02-30" })).toThrow(/day/);
    expect(() => repo.record({ ...good, callerKind: "operator" as never })).toThrow(/callerKind/);
    expect(() => repo.record({ ...good, callerDayHash: CLIENT_A as never })).toThrow(/hash/);
    expect(() => repo.record({ ...good, firstReadAt: 0 })).toThrow(/milliseconds/);
    expect(rows()).toHaveLength(1);
    // A boot time in seconds is refused too, and keeps no date.
    s.db.prepare("DELETE FROM meta WHERE key = 'funnel_statement_reads_since'").run();
    expect(
      () => new SqliteStatementReadRepository(s.db, { bootedAt: Math.floor(CLOCK_MS / 1000) }),
    ).toThrow(/bootedAt must be whole unix milliseconds/);
    expect(
      s.db.prepare("SELECT value FROM meta WHERE key = 'funnel_statement_reads_since'").get(),
    ).toBeUndefined();
  });

  test("the first row it records writes when reads are recorded since; a later row changes nothing", () => {
    const row = linkedBody();
    const repo = new SqliteStatementReadRepository(s.db);
    const since = () =>
      s.db.prepare("SELECT value FROM meta WHERE key = 'funnel_statement_reads_since'").get() as
        | { value: string }
        | undefined;
    expect(since()).toBeUndefined();
    const read = (client: string, at: number) =>
      repo.record({
        legalBodyId: row.legalBodyId,
        day: "2026-10-07",
        callerKind: "anonymous",
        callerDayHash: callerDayHash(client, "2026-10-07", SALT),
        firstReadAt: at,
      });
    expect(read(CLIENT_A, CLOCK_MS)).toBe(true);
    expect(since()).toEqual({ value: String(CLOCK_MS) });
    expect(read(CLIENT_B, CLOCK_MS + 1_000)).toBe(true);
    // A new store over the same database: the date stands.
    expect(
      new SqliteStatementReadRepository(s.db).record({
        legalBodyId: row.legalBodyId,
        day: "2026-10-08",
        callerKind: "anonymous",
        callerDayHash: callerDayHash(CLIENT_A, "2026-10-08", SALT),
        firstReadAt: CLOCK_MS + DAY,
      }),
    ).toBe(true);
    expect(since()).toEqual({ value: String(CLOCK_MS) });
  });

  test("the hash is lower-case hex of 32 bytes, and moves with the key, the day and the salt", () => {
    const base = callerDayHash(CLIENT_A, "2026-10-07", SALT);
    expect(base).toMatch(/^0x[0-9a-f]{64}$/);
    expect(callerDayHash(CLIENT_B, "2026-10-07", SALT)).not.toBe(base);
    expect(callerDayHash(CLIENT_A, "2026-10-08", SALT)).not.toBe(base);
    expect(callerDayHash(CLIENT_A, "2026-10-07", "6b".repeat(32))).not.toBe(base);
  });
});
