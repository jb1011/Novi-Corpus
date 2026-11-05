import { createHash } from "node:crypto";
import { Hono } from "hono";
import { getAddress } from "viem";
import { afterEach, expect, test, vi } from "vitest";
import { apiOnError } from "../../src/api/errors";
import { mountFoundingRoutes } from "../../src/api/routes/founding";
import type { AuthVars } from "../../src/auth/middleware";
import { signSession } from "../../src/auth/session";
import { type FoundingDeps, foundingFromEnv } from "../../src/founding/config";
import { migrate, openDatabase } from "../../src/persistence/db";

const SECRET = "founding-test-secret";
const ADMINS = [
  getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"),
  getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
  getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
] as const;
const OUTSIDER = getAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906");

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
    admins: ADMINS,
    closesAt: null,
    picksAt: 1_800_000_000_000,
    enabled: true,
    ipSalt: "salt",
    take: () => true,
    ...over,
  };
  const app = new Hono<{ Variables: AuthVars }>();
  app.onError(apiOnError);
  mountFoundingRoutes(app, { jwtSecret: SECRET, founding });
  return { app, db };
}

async function token(address: string) {
  const signed = await signSession(address, SECRET, 3600, Math.floor(Date.now() / 1000));
  return signed.token;
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
    ip_hash: string;
    status: string;
  };
  expect(row.email).toBe("ada@example.com");
  expect(row.x_handle).toBe("ada");
  expect(row.via).toBe("web");
  expect(row.status).toBe("new");
  expect(JSON.parse(row.utm)).toEqual({ utm_source: "launch" });
  expect(row.ip_hash).toBe(createHash("sha256").update("salt:203.0.113.9").digest("hex"));
  expect(JSON.stringify(db.prepare("SELECT * FROM founding_applications").all())).not.toContain(
    "203.0.113.9",
  );

  const logged = lines.join("\n");
  expect(logged).toContain(id);
  expect(logged).not.toContain("ada@example.com");
  expect(logged).not.toContain("Pays approved invoices");
});

test("an empty salt stores no IP hash", async () => {
  const { app, db } = setup({ ipSalt: "" });
  const res = await post(app, body(), { "x-forwarded-for": "203.0.113.9" });
  expect(res.status).toBe(200);
  const row = db.prepare("SELECT ip_hash FROM founding_applications").get() as {
    ip_hash: string | null;
  };
  expect(row.ip_hash).toBeNull();
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
  const past = setup({ closesAt: 1_000 });
  expect((await post(past.app, body())).status).toBe(403);
});

test("the limiter answers 429 and stores nothing", async () => {
  const { app, db } = setup({ take: () => false });
  const res = await post(app, body());
  expect(res.status).toBe(429);
  expect(
    (db.prepare("SELECT COUNT(*) AS n FROM founding_applications").get() as { n: number }).n,
  ).toBe(0);
});

test("config reports the window and does not count applications", async () => {
  const { app } = setup();
  const res = await app.request("/founding/config");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("max-age=60");
  expect(await res.json()).toEqual({
    open: true,
    closesAt: null,
    picksAt: 1_800_000_000_000,
    spots: 5,
  });
});

test("reviewer routes require an allowlisted session", async () => {
  const { app } = setup();
  expect((await app.request("/founding/applications")).status).toBe(401);
  const outsider = await token(OUTSIDER);
  const refused = await app.request("/founding/applications", {
    headers: { authorization: `Bearer ${outsider}` },
  });
  expect(refused.status).toBe(403);
});

test("a reviewer lists, scores, and relabels an application", async () => {
  const { app } = setup();
  const created = await post(app, body());
  const { id } = (await created.json()) as { id: string };
  const auth = { authorization: `Bearer ${await token(ADMINS[0])}` };

  const list = await app.request("/founding/applications?sort=score", { headers: auth });
  expect(list.status).toBe(200);
  const listed = (await list.json()) as {
    applications: { id: string; averageScore: number | null; reviewCount: number; email: string }[];
  };
  expect(listed.applications).toHaveLength(1);
  expect(listed.applications[0]?.email).toBe("ada@example.com");
  expect(listed.applications[0]?.averageScore).toBeNull();
  expect(JSON.stringify(listed)).not.toContain("Pays approved invoices");

  const scores = [
    { wallet: ADMINS[0], useCase: 5, moneyFlow: 5, builder: 5 },
    { wallet: ADMINS[1], useCase: 3, moneyFlow: 3, builder: 3 },
    { wallet: ADMINS[2], useCase: 1, moneyFlow: 1, builder: 1 },
  ];
  for (const score of scores) {
    const res = await app.request(`/founding/applications/${id}/review`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await token(score.wallet)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        useCase: score.useCase,
        moneyFlow: score.moneyFlow,
        builder: score.builder,
        note: "clear money flow",
      }),
    });
    expect(res.status).toBe(200);
  }

  const again = await app.request(`/founding/applications/${id}/review`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ useCase: 4, moneyFlow: 4, builder: 4 }),
  });
  expect(again.status).toBe(200);

  const detail = await app.request(`/founding/applications/${id}`, { headers: auth });
  const application = (
    (await detail.json()) as {
      application: {
        reviewCount: number;
        averageScore: number;
        description: string;
        reviews: unknown[];
      };
    }
  ).application;
  expect(application.description).toContain("Pays approved invoices");
  expect(application.reviews).toHaveLength(3);
  expect(application.reviewCount).toBe(3);
  // (4 + 3 + 1) / 3. The first reviewer's second write replaced the 5s.
  expect(application.averageScore).toBeCloseTo((4 + 3 + 1) / 3, 5);

  const labeled = await app.request(`/founding/applications/${id}`, {
    method: "PATCH",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ status: "waitlist" }),
  });
  expect(labeled.status).toBe(200);

  const csv = await app.request("/founding/applications.csv", { headers: auth });
  expect(csv.headers.get("content-type")).toContain("text/csv");
  const text = await csv.text();
  expect(text).toContain("ada@example.com");
  expect(text).toContain("waitlist");
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

test("foundingFromEnv reads the window and refuses a bad address", () => {
  expect(
    foundingFromEnv({
      FOUNDING_ADMINS: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      FOUNDING_CLOSES_AT: "1700000000",
      FOUNDING_PICKS_AT: "2026-12-01T00:00:00Z",
      FOUNDING_OPEN: "false",
      FOUNDING_IP_SALT: " s ",
    }),
  ).toMatchObject({
    closesAt: 1_700_000_000_000,
    picksAt: Date.parse("2026-12-01T00:00:00Z"),
    enabled: false,
    ipSalt: "s",
  });
  expect(() => foundingFromEnv({ FOUNDING_ADMINS: "not-an-address" })).toThrow(/FOUNDING_ADMINS/);
  expect(() => foundingFromEnv({ FOUNDING_CLOSES_AT: "tomorrow" })).toThrow(/FOUNDING_CLOSES_AT/);
});
