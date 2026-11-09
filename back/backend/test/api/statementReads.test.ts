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
 * The statement service over a real in-memory database and a fake chain, on a fixed clock. Every
 * key is one of anvil's published test accounts, every other address a placeholder, and every
 * client address a documentation address (RFC 5737).
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
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
  vi.restoreAllMocks();
  s.db.close();
});

interface AppOptions {
  /** The read store; `null`: none, as on a deployment without FUNNEL_SALT. */
  reads?: StatementReadRepository | null;
}

function makeApp(o: AppOptions = {}) {
  const repo = o.reads === undefined ? new SqliteStatementReadRepository(s.db) : o.reads;
  return buildApiApp({
    webOrigin: "https://www.example.test",
    jwtSecret: SECRET,
    now: () => clock,
    legalBodyStatements: statementDeps(s, chain, { now: () => clock }),
    statementReads: repo === null ? undefined : { repo, salt: SALT },
  } as never);
}
type App = ReturnType<typeof makeApp>;

/** A read of agent 42's statement from `client`, with an Authorization header when given. */
const read = (app: App, o: { client?: string; authorization?: string; agentId?: string } = {}) => {
  const headers: Record<string, string> = {};
  if (o.client !== undefined) headers["x-forwarded-for"] = o.client;
  if (o.authorization !== undefined) headers.authorization = o.authorization;
  return app.request(`/legal-bodies/by-agent/${o.agentId ?? "42"}`, { headers });
};

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
  test("byte for byte the same, with its headers, for an anonymous caller, the owner and a bad bearer", async () => {
    linkedBody();
    const owner = await bearerOf(TENANT);
    // A fresh app for each caller, so each answer is made, not replayed from another's memo.
    const answers: { text: string; headers: [string, string][] }[] = [];
    for (const authorization of [undefined, owner, "Bearer not-a-jwt"]) {
      const res = await read(makeApp(), { client: CLIENT_A, authorization });
      expect(res.status).toBe(200);
      answers.push({ text: await res.text(), headers: headersOf(res) });
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
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
    const failedLines = () =>
      printed
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .filter((line) => line.opslog === "legal_body_statement_read_failed");

    const res = await read(app, { client: CLIENT_A });
    expect(res.status).toBe(200);
    expect((await res.json()).standing).toBe("active");
    expect(failedLines().map(({ opslog: _o, at: _a, ...rest }) => rest)).toEqual([
      { errorName: "SqliteError" },
    ]);

    // Memo replays inside the minute: served, and no second line.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      expect((await read(app, { client: CLIENT_B })).status).toBe(200);
    }
    expect(failedLines()).toHaveLength(1);
    // A minute after the first line: one more.
    clock = CLOCK_MS + 60_000;
    expect((await read(app, { client: CLIENT_A })).status).toBe(200);
    expect(failedLines()).toHaveLength(2);
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
  });

  test("the hash is lower-case hex of 32 bytes, and moves with the key, the day and the salt", () => {
    const base = callerDayHash(CLIENT_A, "2026-10-07", SALT);
    expect(base).toMatch(/^0x[0-9a-f]{64}$/);
    expect(callerDayHash(CLIENT_B, "2026-10-07", SALT)).not.toBe(base);
    expect(callerDayHash(CLIENT_A, "2026-10-08", SALT)).not.toBe(base);
    expect(callerDayHash(CLIENT_A, "2026-10-07", "6b".repeat(32))).not.toBe(base);
  });
});
