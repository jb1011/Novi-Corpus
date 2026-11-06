/**
 * The provider's delivery webhook (`POST /email/webhook/resend`, src/api/routes/emailWebhook.ts):
 * a Svix-signed event recorded on the outbox row of the email it names. A refused signature is a
 * 401 that writes nothing; an event we do not record, or an id we do not know, is a 200 that
 * writes nothing (the provider retries eight times over about a day, and a retry cannot teach us
 * an id we never sent); a bounce or a complaint also writes the WARN line an operator acts on the
 * same day. Every answer is `no-store`.
 *
 * Every address here is on example.com, and no fixture holds a readable name.
 */
import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApiApp } from "../../src/api/app";
import {
  EMAIL_WEBHOOK_MAX_BODY_BYTES,
  RESEND_WEBHOOK_PATH,
} from "../../src/api/routes/emailWebhook";
import { loadConfig } from "../../src/config/env";
import { type EmailDeps, SqliteEmailOutbox, buildEmailDeps } from "../../src/email/outbox";
import { ConsoleEmailSender } from "../../src/email/sender";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";

const NOW = Date.UTC(2026, 10, 10, 12);
/** When the provider says an event happened: the time a delivery state is recorded at. */
const EVENT_AT = NOW - 5000;
const MINUTE = 60_000;
const SECRET = `whsec_${Buffer.from("a-test-signing-secret-of-32-bytes").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.from("not-the-configured-secret").toString("base64")}`;
const ADDRESS = "guardian.one@example.com";
/** A tenant id is a wallet address: a line prints at most its first ten characters. */
const TENANT = "0x1234567890abcdef1234567890abcdef12345678";
const BODY = { text: "Your link: https://app.example.com/x", html: "<p>Your link</p>" };

let db: Database.Database;
let outbox: SqliteEmailOutbox;
/** Every ops line written to standard output, raw. */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  outbox = new SqliteEmailOutbox(db, { now: () => NOW });
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

function emailDeps(over: Partial<EmailDeps> = {}): EmailDeps {
  return {
    sender: new ConsoleEmailSender(),
    outbox,
    publicAppUrl: "https://app.example.com",
    postalAddress: "1 Example Street, Dover, DE 19901, USA",
    webhookSecret: SECRET,
    ...over,
  };
}

function app(email: EmailDeps | undefined) {
  return buildApiApp({
    webOrigin: "https://app.example.com",
    repo: new SqliteEntityRepository(db),
    jwtSecret: "test-jwt-secret-at-least-32-characters",
    now: () => NOW,
    email,
  } as never);
}

/** A sent email, as the delivery job leaves it, with the provider's id. */
function sentEmail(
  providerMessageId: string,
  kind: "filing_landed" | "identity_link" = "filing_landed",
  subjectRef = kind === "identity_link" ? TENANT : "cmp_0001",
): string {
  const { emailId } = outbox.enqueue({
    kind,
    subjectRef,
    idempotencyKey: `${kind}:${providerMessageId}`,
    to: ADDRESS,
    subject: "A subject",
    ...BODY,
  });
  db.prepare(
    `UPDATE email_outbox SET status = 'sent', provider_message_id = ?, sent_at = ?,
       next_attempt_at = NULL, to_address = NULL, text = NULL, html = NULL WHERE email_id = ?`,
  ).run(providerMessageId, NOW - MINUTE, emailId);
  return emailId;
}

const row = (emailId: string) =>
  db
    .prepare("SELECT delivery_state, delivery_at FROM email_outbox WHERE email_id = ?")
    .get(emailId) as { delivery_state: string | null; delivery_at: number | null };

/** A Resend event, as the provider sends it: the address and the subject are in it. Its
 *  `created_at` is the event's own time (null leaves it out); `data.created_at` is the email's. */
const event = (
  type: string,
  emailId: string | null = "re_msg_1",
  createdAt: string | null = new Date(EVENT_AT).toISOString(),
) =>
  JSON.stringify({
    type,
    ...(createdAt === null ? {} : { created_at: createdAt }),
    data: {
      created_at: new Date(NOW - 60 * MINUTE).toISOString(),
      ...(emailId === null ? {} : { email_id: emailId }),
      from: "Novi Corpus <filings@example.org>",
      to: [ADDRESS],
      subject: "A subject",
      ...(type === "email.bounced"
        ? { bounce: { message: `550 ${ADDRESS} does not exist`, type: "Permanent" } }
        : {}),
    },
  });

function signature(id: string, ts: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

async function post(
  body: string,
  opts: {
    id?: string;
    timestampMs?: number;
    signature?: string;
    headers?: Record<string, string | undefined>;
    email?: EmailDeps;
  } = {},
) {
  const id = opts.id ?? "msg_svix_1";
  const ts = String(Math.floor((opts.timestampMs ?? NOW) / 1000));
  const headers: Record<string, string> = { "content-type": "application/json" };
  const all = {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": opts.signature ?? signature(id, ts, body),
    ...opts.headers,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) headers[k] = v;
  return await app(opts.email ?? emailDeps()).request(RESEND_WEBHOOK_PATH, {
    method: "POST",
    headers,
    body,
  });
}

/** The ops lines of one event, parsed. */
const lines = (name: string) =>
  printed
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((o): o is Record<string, unknown> => o?.opslog === name);

/** No line carries the address, the body, the secret, a signature or the whole tenant id. */
function expectNothingPrivatePrinted(...also: string[]) {
  for (const l of printed)
    for (const s of [ADDRESS, "example.com", "does not exist", SECRET, TENANT, ...also])
      expect(l).not.toContain(s);
}

describe("a correctly signed event", () => {
  test("email.bounced: the row's delivery state is bounced, and the WARN line names the email", async () => {
    const emailId = sentEmail("re_msg_1");
    const body = event("email.bounced");
    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(emailId)).toEqual({ delivery_state: "bounced", delivery_at: EVENT_AT });
    const [warn, ...more] = lines("email_bounced");
    expect(more).toEqual([]);
    expect(warn).toMatchObject({
      level: "warn",
      severity: "WARN",
      emailId,
      kind: "filing_landed",
      subjectRef: "cmp_0001",
      state: "bounced",
    });
    expectNothingPrivatePrinted(signature("msg_svix_1", String(NOW / 1000), body));
  });

  test("email.complained writes the same WARN line; an identity link's tenant id is cut to ten characters", async () => {
    const emailId = sentEmail("re_msg_1", "identity_link");
    const res = await post(event("email.complained"));

    expect(res.status).toBe(200);
    expect(row(emailId).delivery_state).toBe("complained");
    expect(lines("email_bounced")).toEqual([
      expect.objectContaining({
        severity: "WARN",
        emailId,
        kind: "identity_link",
        subjectRef: `${TENANT.slice(0, 10)}…`,
        state: "complained",
      }),
    ]);
    expectNothingPrivatePrinted();
  });

  test("each of the six delivery events records its state; every state but delivered and delayed writes the WARN line", async () => {
    const cases = [
      ["email.delivered", "delivered"],
      ["email.delivery_delayed", "delayed"],
      ["email.bounced", "bounced"],
      ["email.complained", "complained"],
      ["email.failed", "failed"],
      ["email.suppressed", "suppressed"],
    ] as const;
    for (const [type, state] of cases) {
      printed = [];
      const emailId = sentEmail(`re_${state}`);
      const res = await post(event(type, `re_${state}`));
      expect(res.status, type).toBe(200);
      expect(row(emailId), type).toEqual({ delivery_state: state, delivery_at: EVENT_AT });
      expect(lines("email_bounced").length, type).toBe(
        state === "delivered" || state === "delayed" ? 0 : 1,
      );
    }
  });

  test("every other event answers 200 and writes nothing", async () => {
    const emailId = sentEmail("re_msg_1");
    for (const type of [
      "email.sent",
      "email.opened",
      "email.clicked",
      "email.received",
      "email.scheduled",
      "contact.created",
      "constructor",
      "__proto__",
    ]) {
      const res = await post(event(type));
      expect(res.status, type).toBe(200);
      expect(res.headers.get("cache-control"), type).toBe("no-store");
      expect(row(emailId), type).toEqual({ delivery_state: null, delivery_at: null });
    }
    expect(printed).toEqual([]);
  });

  test("an unknown message id answers 200 and writes nothing", async () => {
    const emailId = sentEmail("re_msg_1");
    const res = await post(event("email.bounced", "re_never_sent_by_us"));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_bounced")).toEqual([]);
    expect(lines("email_delivery_unmatched")).toEqual([
      expect.objectContaining({ providerMessageId: "re_never_sent_by_us", type: "email.bounced" }),
    ]);
    expectNothingPrivatePrinted();
  });

  test("a contact write's provider id is not an email: 200, nothing recorded, no WARN line", async () => {
    const { emailId } = outbox.enqueue({
      kind: "contact_upsert",
      subjectRef: "waitlist",
      idempotencyKey: "contact:abc",
      to: ADDRESS,
    });
    db.prepare(
      `UPDATE email_outbox SET status = 'sent', provider_message_id = 'ct_1', sent_at = ?,
         next_attempt_at = NULL, to_address = NULL WHERE email_id = ?`,
    ).run(NOW - MINUTE, emailId);
    const res = await post(event("email.bounced", "ct_1"));
    expect(res.status).toBe(200);
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_bounced")).toEqual([]);
  });

  test("a signed body we cannot read answers 200, writes nothing, and says so without the body", async () => {
    const emailId = sentEmail("re_msg_1");
    for (const body of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ type: "email.bounced" }),
      event("email.bounced", null),
      JSON.stringify({ type: "email.bounced", data: { email_id: 7, to: [ADDRESS] } }),
      JSON.stringify({ type: 7, data: { email_id: "re_msg_1" } }),
    ]) {
      const res = await post(body);
      expect(res.status, body).toBe(200);
      expect(res.headers.get("cache-control"), body).toBe("no-store");
    }
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_webhook_unparsable")).toHaveLength(7);
    expectNothingPrivatePrinted("not json");
  });
});

describe("events are ordered by the provider's own time, the body's created_at", () => {
  const at = (ms: number) => new Date(ms).toISOString();

  test("a late delivery_delayed after delivered leaves delivered, older or newer", async () => {
    const emailId = sentEmail("re_msg_1");
    expect((await post(event("email.delivered", "re_msg_1", at(NOW - MINUTE)))).status).toBe(200);
    for (const t of [NOW - 2 * MINUTE, NOW - 30_000]) {
      expect((await post(event("email.delivery_delayed", "re_msg_1", at(t)))).status).toBe(200);
      expect(row(emailId)).toEqual({ delivery_state: "delivered", delivery_at: NOW - MINUTE });
    }
  });

  test("an older bounced after a newer delivered is ignored, and writes no WARN line", async () => {
    const emailId = sentEmail("re_msg_1");
    await post(event("email.delivered", "re_msg_1", at(NOW - MINUTE)));
    const res = await post(event("email.bounced", "re_msg_1", at(NOW - 2 * MINUTE)));
    expect(res.status).toBe(200);
    expect(row(emailId)).toEqual({ delivery_state: "delivered", delivery_at: NOW - MINUTE });
    expect(lines("email_bounced")).toEqual([]);
  });

  test("a newer bounced after delivered is recorded, with its WARN line", async () => {
    const emailId = sentEmail("re_msg_1");
    await post(event("email.delivered", "re_msg_1", at(NOW - 2 * MINUTE)));
    await post(event("email.bounced", "re_msg_1", at(NOW - MINUTE)));
    expect(row(emailId)).toEqual({ delivery_state: "bounced", delivery_at: NOW - MINUTE });
    expect(lines("email_bounced")).toEqual([
      expect.objectContaining({ emailId, state: "bounced" }),
    ]);
  });

  test("a redelivered bounce (the same event time) is recorded once, with one WARN line", async () => {
    const emailId = sentEmail("re_msg_1");
    const body = event("email.bounced", "re_msg_1", at(NOW - MINUTE));
    expect((await post(body)).status).toBe(200);
    // The provider's retry: a new svix-id and timestamp, the same body.
    expect((await post(body, { id: "msg_svix_2", timestampMs: NOW - 2000 })).status).toBe(200);
    expect(row(emailId)).toEqual({ delivery_state: "bounced", delivery_at: NOW - MINUTE });
    expect(lines("email_bounced")).toHaveLength(1);
  });

  test("a missing or unreadable created_at is recorded at now, a future one is clamped to now, and the svix timestamp is never used", async () => {
    const cases: [string, string | null][] = [
      ["missing", null],
      ["not a date", "not a date"],
      ["a bare number", "7"],
      ["an hour ahead", at(NOW + 60 * MINUTE)],
    ];
    for (const [name, createdAt] of cases) {
      const id = `re_${name.replace(/ /g, "_")}`;
      const emailId = sentEmail(id);
      // A retry re-signed four minutes after the event: its svix timestamp is not the event time.
      const res = await post(event("email.delivered", id, createdAt), {
        timestampMs: NOW - 4 * MINUTE,
      });
      expect(res.status, name).toBe(200);
      expect(row(emailId), name).toEqual({ delivery_state: "delivered", delivery_at: NOW });
    }
  });
});

describe("a refused signature answers 401 and writes nothing", () => {
  test("a bad signature", async () => {
    const emailId = sentEmail("re_msg_1");
    const body = event("email.bounced");
    const ts = String(NOW / 1000);
    for (const sig of [
      signature("msg_svix_1", ts, body, OTHER_SECRET),
      signature("msg_svix_1", ts, `${body} `),
      signature("msg_svix_2", ts, body),
      "v1,AAAA",
      "garbage",
    ]) {
      const res = await post(body, { signature: sig });
      expect(res.status, sig).toBe(401);
      expect(res.headers.get("cache-control"), sig).toBe("no-store");
      expect(await res.json(), sig).toEqual({
        error: { code: "unauthorized", message: "invalid signature" },
      });
    }
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_bounced")).toEqual([]);
    expect(lines("email_webhook_unauthorized").map((l) => l.reason)).toEqual(
      Array(5).fill("bad_signature"),
    );
    expectNothingPrivatePrinted(signature("msg_svix_1", ts, body));
  });

  test("a stale timestamp, or one too far ahead, even correctly signed", async () => {
    const emailId = sentEmail("re_msg_1");
    const body = event("email.bounced");
    for (const offset of [-6 * MINUTE, 6 * MINUTE]) {
      const res = await post(body, { timestampMs: NOW + offset });
      expect(res.status, String(offset)).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_webhook_unauthorized").map((l) => l.reason)).toEqual([
      "bad_timestamp",
      "bad_timestamp",
    ]);
  });

  test("a missing header, each of the three", async () => {
    const emailId = sentEmail("re_msg_1");
    for (const name of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const res = await post(event("email.bounced"), { headers: { [name]: undefined } });
      expect(res.status, name).toBe(401);
    }
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_webhook_unauthorized").map((l) => l.reason)).toEqual(
      Array(3).fill("missing_header"),
    );
  });
});

test("a second, valid candidate in the signature header is accepted", async () => {
  const emailId = sentEmail("re_msg_1");
  const body = event("email.delivered");
  const ts = String(NOW / 1000);
  const both = `${signature("msg_svix_1", ts, body, OTHER_SECRET)} ${signature("msg_svix_1", ts, body)}`;
  const res = await post(body, { signature: both });
  expect(res.status).toBe(200);
  expect(row(emailId).delivery_state).toBe("delivered");
});

test("an answer that fails inside the route is a 500, and still no-store", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const failing = emailDeps({
    outbox: {
      findSent: () => {
        throw new Error("database unavailable");
      },
    } as never,
  });
  const res = await post(event("email.bounced"), { email: failing });
  expect(res.status).toBe(500);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

describe("the body is capped at 16 KiB", () => {
  test("16 KiB + 1 answers 413, before the signature is looked at, and writes nothing", async () => {
    expect(EMAIL_WEBHOOK_MAX_BODY_BYTES).toBe(16 * 1024);
    const emailId = sentEmail("re_msg_1");
    const base = event("email.bounced");
    const body = `${base}${" ".repeat(EMAIL_WEBHOOK_MAX_BODY_BYTES + 1 - base.length)}`;
    expect(Buffer.byteLength(body)).toBe(16 * 1024 + 1);

    const res = await post(body);
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(row(emailId)).toEqual({ delivery_state: null, delivery_at: null });
    expect(lines("email_webhook_oversize")).toHaveLength(1);
    expect(lines("email_webhook_unauthorized")).toEqual([]);
  });

  test("exactly 16 KiB, correctly signed, is read and recorded", async () => {
    const emailId = sentEmail("re_msg_1");
    const base = event("email.bounced");
    const body = `${base}${" ".repeat(EMAIL_WEBHOOK_MAX_BODY_BYTES - base.length)}`;
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(row(emailId).delivery_state).toBe("bounced");
  });
});

describe("the route exists only where the provider's webhook can be verified", () => {
  test("no email system (the testnet box): the path is not mounted", async () => {
    sentEmail("re_msg_1");
    const res = await app(undefined).request(RESEND_WEBHOOK_PATH, {
      method: "POST",
      body: event("email.bounced"),
    });
    expect(res.status).toBe(404);
  });

  test("the console sender has no webhook secret: the path is not mounted", async () => {
    const res = await post(event("email.bounced"), {
      email: emailDeps({ webhookSecret: undefined }),
    });
    expect(res.status).toBe(404);
  });

  test("wired from the configuration: the provider's sender carries RESEND_WEBHOOK_SECRET and mounts the route; the console sender mounts none", async () => {
    const BASE = {
      PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
      CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
      AUTH_JWT_SECRET: "s".repeat(16),
      ARC_TESTNET_RPC_URL: "http://localhost:8545",
    };
    const CONSOLE = {
      ...BASE,
      PUBLIC_APP_URL: "https://www.example.com",
      EMAIL_FROM: "Novi Corpus <filings@example.org>",
      EMAIL_POSTAL_ADDRESS: "1 Example Street, Suite 100, Dover, DE 19901, USA",
    };
    const RESEND = {
      ...CONSOLE,
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "re_placeholder_key",
      RESEND_WEBHOOK_SECRET: SECRET,
    };
    const resend = buildEmailDeps(db, loadConfig(RESEND));
    expect(resend?.webhookSecret).toBe(SECRET);
    const emailId = sentEmail("re_msg_1");
    expect((await post(event("email.delivered"), { email: resend })).status).toBe(200);
    expect(row(emailId).delivery_state).toBe("delivered");

    const consoleDeps = buildEmailDeps(db, loadConfig(CONSOLE));
    expect(consoleDeps).toBeDefined();
    expect(consoleDeps).not.toHaveProperty("webhookSecret");
    expect((await post(event("email.bounced"), { email: consoleDeps })).status).toBe(404);
  });

  test("it is public: no session is asked for, the signature is the authentication", async () => {
    const emailId = sentEmail("re_msg_1");
    const res = await post(event("email.delivered"), { headers: { authorization: undefined } });
    expect(res.status).toBe(200);
    expect(row(emailId).delivery_state).toBe("delivered");
  });
});
