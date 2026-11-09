import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { apiOnError } from "../../src/api/errors";
import { mountFoundingRoutes } from "../../src/api/routes/founding";
import type { AuthVars } from "../../src/auth/middleware";
import { type FoundingDeps, foundingFromEnv } from "../../src/founding/config";
import { migrate, openDatabase } from "../../src/persistence/db";

const DESCRIPTION =
  "Pays approved invoices for a small team, and it already moves USDC when a human says yes.";

function body(over: Record<string, unknown> = {}) {
  return {
    email: "ada@example.com",
    xHandle: "@Ada",
    agentName: "Invoice",
    description: DESCRIPTION,
    utm: { utm_source: "launch", ignore: "no" },
    via: "mcp",
    ...over,
  };
}

function setup(over: Partial<FoundingDeps> = {}) {
  const db = openDatabase(":memory:");
  migrate(db);
  const founding: FoundingDeps = {
    db,
    enabled: true,
    take: () => true,
    ...over,
  };
  const app = new Hono<{ Variables: AuthVars }>();
  app.onError(apiOnError);
  mountFoundingRoutes(app, { founding });
  return { app, db };
}

function post(
  app: Hono<{ Variables: AuthVars }>,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.request("/founding/applications", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a valid application is stored, and the log carries the id only", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => {
    lines.push(String(line));
  });
  const { app, db } = setup();
  const res = await post(app, body(), { "x-forwarded-for": "1.1.1.1, 203.0.113.9" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const { id } = (await res.json()) as { id: string };
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const row = db.prepare("SELECT * FROM founding_applications WHERE id = ?").get(id) as {
    email: string;
    x_handle: string;
    via: string;
    utm: string;
    status: string;
  };
  expect(row.email).toBe("ada@example.com");
  expect(row.x_handle).toBe("ada");
  expect(row.via).toBe("web");
  expect(row.status).toBe("new");
  expect(JSON.parse(row.utm)).toEqual({ utm_source: "launch" });
  expect(JSON.stringify(db.prepare("SELECT * FROM founding_applications").all())).not.toContain(
    "203.0.113.9",
  );

  const logged = lines.join("\n");
  expect(logged).toContain(id);
  expect(logged).not.toContain("ada@example.com");
  expect(logged).not.toContain("Pays approved invoices");
});

test("a filled honeypot looks like success and stores nothing", async () => {
  const { app, db } = setup();
  const res = await post(app, { company_website: "https://spam.example", name: "nope" });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect(db.prepare("SELECT id FROM founding_applications WHERE id = ?").get(id)).toBeUndefined();
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM founding_applications").get() as { n: number }).n,
  ).toBe(0);
});

test("a duplicate email or X handle is a 409 and stores nothing new", async () => {
  const { app, db } = setup();
  expect((await post(app, body())).status).toBe(200);
  const sameEmail = await post(app, body({ xHandle: "other" }));
  expect(sameEmail.status).toBe(409);
  expect(sameEmail.headers.get("cache-control")).toBe("no-store");
  const sameHandle = await post(app, body({ email: "other@example.com", xHandle: "ada" }));
  expect(sameHandle.status).toBe(409);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM founding_applications").get() as { n: number }).n,
  ).toBe(1);
});

test("an X handle can be left blank, and two blank handles do not collide", async () => {
  const { app, db } = setup();
  expect((await post(app, body({ xHandle: "  ", email: "one@example.com" }))).status).toBe(200);
  expect((await post(app, body({ xHandle: "", email: "two@example.com" }))).status).toBe(200);
  const handles = db.prepare("SELECT x_handle FROM founding_applications ORDER BY email").all() as {
    x_handle: string | null;
  }[];
  expect(handles).toEqual([{ x_handle: null }, { x_handle: null }]);
});

test("a bad X handle is a 400", async () => {
  const { app, db } = setup();
  expect((await post(app, body({ xHandle: "has a space" }))).status).toBe(400);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM founding_applications").get() as { n: number }).n,
  ).toBe(0);
});

test("a short description is a 400", async () => {
  const { app, db } = setup();
  const res = await post(app, body({ description: "too short" }));
  expect(res.status).toBe(400);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM founding_applications").get() as { n: number }).n,
  ).toBe(0);
});

test("a closed programme refuses the form", async () => {
  const closed = setup({ enabled: false });
  expect((await post(closed.app, body())).status).toBe(403);
});

test("the limiter answers 429 and stores nothing", async () => {
  const { app, db } = setup({ take: () => false });
  const res = await post(app, body());
  expect(res.status).toBe(429);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM founding_applications").get() as { n: number }).n,
  ).toBe(0);
});

test("config reports the form is open and does not count applications", async () => {
  const { app } = setup();
  const res = await app.request("/founding/config");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("max-age=60");
  expect(await res.json()).toEqual({
    open: true,
    spots: 5,
  });
});

test("an older founding table drops the fields the form no longer asks for", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE founding_applications (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      x_handle TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      description TEXT NOT NULL,
      money_use TEXT NOT NULL,
      link TEXT,
      stack TEXT,
      utm TEXT,
      via TEXT NOT NULL DEFAULT 'web',
      status TEXT NOT NULL DEFAULT 'new',
      ip_hash TEXT,
      consent_at INTEGER NOT NULL,
      UNIQUE (email),
      UNIQUE (x_handle)
    );
    CREATE TABLE founding_reviews (
      application_id TEXT PRIMARY KEY,
      reviewer TEXT NOT NULL
    );
    INSERT INTO founding_applications
      (id, created_at, name, email, x_handle, agent_name, description, money_use, via, status, consent_at)
    VALUES
      ('kept', 1, 'Ada', 'ada@example.com', 'ada', 'Invoice', 'A long enough description of the agent.', 'spends', 'web', 'new', 1);
  `);
  migrate(db);
  const cols = (
    db.prepare("PRAGMA table_info(founding_applications)").all() as { name: string }[]
  ).map((col) => col.name);
  expect(cols).not.toContain("name");
  expect(cols).not.toContain("money_use");
  expect(cols).not.toContain("consent_at");
  expect(cols).not.toContain("ip_hash");
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'founding_reviews'")
      .get(),
  ).toBeUndefined();
  expect(
    db
      .prepare("SELECT email, x_handle, agent_name FROM founding_applications WHERE id = 'kept'")
      .get(),
  ).toEqual({
    email: "ada@example.com",
    x_handle: "ada",
    agent_name: "Invoice",
  });
});

test("foundingFromEnv reads the switch", () => {
  expect(foundingFromEnv({ FOUNDING_OPEN: "false" })).toEqual({ enabled: false });
  expect(foundingFromEnv({})).toEqual({ enabled: true });
});
