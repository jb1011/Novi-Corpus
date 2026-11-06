/**
 * The email outbox (`src/email/outbox.ts` over `email_outbox`): every email the product sends is
 * a row here first, enqueued once per idempotency key, and the delivery job sends it
 * (test/email/deliverJob.test.ts). This file holds the table's rules and the outbox's other
 * methods: enqueue, list, requeue, recordDelivery, findSent, and the contact upsert's row.
 *
 * Every address here is on example.com, and no fixture holds a readable name.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type EmailDeps,
  type EmailOutbox,
  SqliteEmailOutbox,
  contactIdempotencyKey,
  enqueueContactUpsert,
} from "../../src/email/outbox";
import { ConsoleEmailSender } from "../../src/email/sender";
import { migrate, openDatabase } from "../../src/persistence/db";

const T0 = Date.UTC(2026, 10, 10, 12);
const MINUTE = 60_000;
const ADDRESS = "guardian.one@example.com";
const OTHER = "guardian.two@example.com";
/** A body carrying the kind of thing an email holds for one person only. */
const BODY = { text: "Your code: INV-SECRET-1234", html: "<p>Your code: INV-SECRET-1234</p>" };

let db: Database.Database;
let outbox: SqliteEmailOutbox;
let clock: number;
/** Every ops line written to standard output, raw. */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  clock = T0;
  outbox = new SqliteEmailOutbox(db, { now: () => clock });
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** The raw row, every column, as the database holds it. */
const raw = (emailId: string) =>
  db.prepare("SELECT * FROM email_outbox WHERE email_id = ?").get(emailId) as Record<
    string,
    unknown
  >;
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get() as { n: number }).n;

/** One invite email, as Task 15 will enqueue it. */
const invite = (key = "invite:hash-0001", to = ADDRESS) =>
  outbox.enqueue({
    kind: "invite_code",
    subjectRef: "hash-0001",
    idempotencyKey: key,
    to,
    subject: "Your Novi Corpus invite",
    ...BODY,
  });

/** A row in the given state, written as the delivery job writes it. */
function failRow(emailId: string): void {
  db.prepare(
    `UPDATE email_outbox SET status = 'failed', attempts = 1, next_attempt_at = NULL,
       last_error = '422 validation_error' WHERE email_id = ?`,
  ).run(emailId);
}
function sendRow(emailId: string, providerMessageId: string): void {
  db.prepare(
    `UPDATE email_outbox SET status = 'sent', provider_message_id = ?, sent_at = ?,
       next_attempt_at = NULL, to_address = NULL, text = NULL, html = NULL WHERE email_id = ?`,
  ).run(providerMessageId, T0 + MINUTE, emailId);
}

describe("enqueue", () => {
  test("a second enqueue with the same key writes nothing and answers the first row's id, inserted: false", () => {
    const first = invite();
    expect(first).toEqual({ emailId: expect.stringMatching(/^em_[0-9a-f-]{36}$/), inserted: true });
    // The second payload differs: the first one stands, as the provider's own key would keep it.
    const second = invite("invite:hash-0001", OTHER);
    expect(second).toEqual({ emailId: first.emailId, inserted: false });
    expect(count()).toBe(1);
    expect(raw(first.emailId)).toMatchObject({
      kind: "invite_code",
      subject_ref: "hash-0001",
      idempotency_key: "invite:hash-0001",
      to_address: ADDRESS,
      subject: "Your Novi Corpus invite",
      text: BODY.text,
      html: BODY.html,
      status: "pending",
      attempts: 0,
      // Due at once.
      next_attempt_at: T0,
      provider_message_id: null,
      delivery_state: null,
      last_error: null,
      created_at: T0,
      sent_at: null,
    });
  });

  test("an enqueue the table refuses throws, rather than being taken for a duplicate", () => {
    // No body for an email that is not a contact write.
    expect(() =>
      outbox.enqueue({
        kind: "filing_landed",
        subjectRef: "co_1",
        idempotencyKey: "filing_landed:co_1",
        to: ADDRESS,
        subject: "Your filing has landed",
      }),
    ).toThrow(/CHECK constraint failed/);
    // A kind the outbox does not know.
    expect(() =>
      outbox.enqueue({
        kind: "newsletter" as never,
        subjectRef: null,
        idempotencyKey: "newsletter:1",
        to: ADDRESS,
        subject: "News",
        ...BODY,
      }),
    ).toThrow(/CHECK constraint failed/);
    // A key the provider would refuse: 1 to 256 characters.
    expect(() => invite("k".repeat(257))).toThrow(/CHECK constraint failed/);
    expect(() => invite("")).toThrow(/CHECK constraint failed/);
    // No address.
    expect(() => invite("invite:hash-0002", "")).toThrow(/CHECK constraint failed/);
    expect(count()).toBe(0);
    expect(invite("k".repeat(256)).inserted).toBe(true);
  });
});

describe("the table's rules", () => {
  const insert = (cols: Record<string, unknown>) => {
    const row = {
      email_id: "em_x",
      kind: "invite_code",
      subject_ref: null,
      idempotency_key: "k",
      to_address: ADDRESS,
      subject: "s",
      text: "t",
      html: "h",
      status: "pending",
      attempts: 0,
      next_attempt_at: T0,
      provider_message_id: null,
      delivery_state: null,
      delivery_at: null,
      last_error: null,
      created_at: T0,
      sent_at: null,
      ...cols,
    };
    const names = Object.keys(row);
    db.prepare(
      `INSERT INTO email_outbox (${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`,
    ).run(row);
  };
  const sent = {
    status: "sent",
    next_attempt_at: null,
    provider_message_id: "msg_1",
    sent_at: T0,
    to_address: null,
    text: null,
    html: null,
  };

  test("a sent row holds no address, no text and no HTML; its subject, kind and ids stay", () => {
    expect(() => insert({ ...sent, to_address: ADDRESS })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ ...sent, text: "t" })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ ...sent, html: "h" })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ ...sent, subject: null })).toThrow(/CHECK constraint failed/);
    insert(sent);
    expect(raw("em_x")).toMatchObject({ subject: "s", kind: "invite_code", status: "sent" });
  });

  test("a pending or failed row holds its address and, but for a contact write, its subject, text and HTML", () => {
    for (const status of ["pending", "failed"]) {
      const at = status === "pending" ? { next_attempt_at: T0 } : { next_attempt_at: null };
      expect(() => insert({ status, ...at, to_address: null })).toThrow(/CHECK constraint failed/);
      expect(() => insert({ status, ...at, text: null })).toThrow(/CHECK constraint failed/);
      expect(() => insert({ status, ...at, html: null })).toThrow(/CHECK constraint failed/);
      expect(() => insert({ status, ...at, subject: null })).toThrow(/CHECK constraint failed/);
    }
    // A contact write has an address and nothing else to send.
    expect(() => insert({ kind: "contact_upsert" })).toThrow(/CHECK constraint failed/);
    insert({ kind: "contact_upsert", subject: null, text: null, html: null });
  });

  test("the states hang together: pending has its next attempt, sent its message id and time, a delivery state only on a sent row", () => {
    expect(() => insert({ status: "queued" })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ next_attempt_at: null })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ status: "failed" })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ ...sent, provider_message_id: null })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ ...sent, sent_at: null })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ provider_message_id: "msg_1" })).toThrow(/CHECK constraint failed/);
    expect(() => insert({ delivery_state: "delivered", delivery_at: T0 })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert({ ...sent, delivery_state: "opened", delivery_at: T0 })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert({ ...sent, delivery_state: "delivered" })).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => insert({ attempts: -1 })).toThrow(/CHECK constraint failed/);
    insert({ ...sent, delivery_state: "bounced", delivery_at: T0 });
  });

  test("the due index is (status, next_attempt_at)", () => {
    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_email_outbox_due") as { sql: string } | undefined;
    expect(index?.sql).toMatch(/email_outbox\s*\(\s*status\s*,\s*next_attempt_at\s*\)/);
  });
});

describe("list", () => {
  test("never answers an address, a text or an HTML body, and filters by status, kind and time", () => {
    const a = invite("invite:hash-0001");
    clock = T0 + 10 * MINUTE;
    const b = outbox.enqueue({
      kind: "identity_link",
      subjectRef: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      idempotencyKey: "identity_link:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:2026-11-10",
      to: OTHER,
      subject: "Confirm who you are",
      ...BODY,
    });
    clock = T0 + 20 * MINUTE;
    const c = outbox.enqueue({
      kind: "contact_upsert",
      subjectRef: "waitlist",
      idempotencyKey: contactIdempotencyKey(ADDRESS),
      to: ADDRESS,
    });
    failRow(b.emailId);
    sendRow(a.emailId, "msg_a");

    const all = outbox.list({});
    expect(all.map((r) => r.emailId)).toEqual([a.emailId, b.emailId, c.emailId]);
    const listed = JSON.stringify(all);
    for (const secret of [ADDRESS, OTHER, "INV-SECRET-1234"]) expect(listed).not.toContain(secret);
    for (const row of all) {
      expect(row).not.toHaveProperty("to");
      expect(row).not.toHaveProperty("toAddress");
      expect(row).not.toHaveProperty("text");
      expect(row).not.toHaveProperty("html");
    }
    expect(all[1]).toEqual({
      emailId: b.emailId,
      kind: "identity_link",
      subjectRef: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      idempotencyKey: "identity_link:0x70997970C51812dc3A010C7d01b50e0d17dc79C8:2026-11-10",
      subject: "Confirm who you are",
      status: "failed",
      attempts: 1,
      nextAttemptAt: null,
      providerMessageId: null,
      deliveryState: null,
      deliveryAt: null,
      lastError: "422 validation_error",
      createdAt: T0 + 10 * MINUTE,
      sentAt: null,
    });

    expect(outbox.list({ status: "failed" }).map((r) => r.emailId)).toEqual([b.emailId]);
    expect(outbox.list({ status: "sent" }).map((r) => r.emailId)).toEqual([a.emailId]);
    expect(outbox.list({ kind: "contact_upsert" }).map((r) => r.emailId)).toEqual([c.emailId]);
    expect(outbox.list({ sinceMs: T0 + 10 * MINUTE }).map((r) => r.emailId)).toEqual([
      b.emailId,
      c.emailId,
    ]);
    expect(outbox.list({ status: "pending", kind: "invite_code" })).toEqual([]);
  });
});

describe("requeue", () => {
  test("puts a failed row back to pending, due now, with the address the caller supplies; any other row is refused", () => {
    const failed = invite("invite:hash-0001");
    failRow(failed.emailId);
    clock = T0 + 3 * MINUTE;
    expect(outbox.requeue(failed.emailId, OTHER)).toBe(true);
    expect(raw(failed.emailId)).toMatchObject({
      status: "pending",
      to_address: OTHER,
      attempts: 0,
      next_attempt_at: T0 + 3 * MINUTE,
      // The content stayed with the failed row (only a sent row loses it).
      text: BODY.text,
      html: BODY.html,
    });
    // Pending now: a second requeue has nothing to do.
    expect(outbox.requeue(failed.emailId, OTHER)).toBe(false);

    const sent = invite("invite:hash-0002");
    sendRow(sent.emailId, "msg_2");
    expect(outbox.requeue(sent.emailId, ADDRESS)).toBe(false);
    expect(raw(sent.emailId)).toMatchObject({ status: "sent", to_address: null });
    expect(outbox.requeue("em_unknown", ADDRESS)).toBe(false);

    const again = invite("invite:hash-0003");
    failRow(again.emailId);
    expect(() => outbox.requeue(again.emailId, "")).toThrow(/CHECK constraint failed/);
    expect(raw(again.emailId)).toMatchObject({ status: "failed", to_address: ADDRESS });
  });
});

describe("recordDelivery", () => {
  test("writes the provider's delivery state on the sent row it names; an unknown id, or a contact write's id, is not recorded", () => {
    const a = invite("invite:hash-0001");
    sendRow(a.emailId, "msg_a");
    expect(outbox.recordDelivery("msg_a", "delivered", T0 + 2 * MINUTE)).toBe(true);
    expect(raw(a.emailId)).toMatchObject({
      status: "sent",
      delivery_state: "delivered",
      delivery_at: T0 + 2 * MINUTE,
    });
    expect(outbox.recordDelivery("msg_a", "complained", T0 + 9 * MINUTE)).toBe(true);
    expect(raw(a.emailId)).toMatchObject({
      delivery_state: "complained",
      delivery_at: T0 + 9 * MINUTE,
    });
    // An event older than the one recorded does not overwrite it.
    expect(outbox.recordDelivery("msg_a", "delayed", T0 + 5 * MINUTE)).toBe(false);
    expect(raw(a.emailId)).toMatchObject({ delivery_state: "complained" });

    expect(outbox.recordDelivery("msg_unknown", "bounced", T0)).toBe(false);
    const contact = outbox.enqueue({
      kind: "contact_upsert",
      subjectRef: "waitlist",
      idempotencyKey: contactIdempotencyKey(ADDRESS),
      to: ADDRESS,
    });
    db.prepare(
      `UPDATE email_outbox SET status = 'sent', provider_message_id = 'ct_1', sent_at = ?,
         next_attempt_at = NULL, to_address = NULL WHERE email_id = ?`,
    ).run(T0, contact.emailId);
    expect(outbox.recordDelivery("ct_1", "bounced", T0)).toBe(false);
    expect(raw(contact.emailId)).toMatchObject({ delivery_state: null });
  });
});

describe("recordDelivery orders events by their own time", () => {
  /** One sent invite per case, with its own provider id. */
  const sentInvite = (id: string) => {
    const a = invite(`invite:${id}`);
    sendRow(a.emailId, id);
    return a.emailId;
  };

  test("an event at the same time as the recorded one is ignored: a redelivered event changes nothing", () => {
    const emailId = sentInvite("msg_a");
    expect(outbox.recordDelivery("msg_a", "bounced", T0 + 2 * MINUTE)).toBe(true);
    expect(outbox.recordDelivery("msg_a", "bounced", T0 + 2 * MINUTE)).toBe(false);
    expect(outbox.recordDelivery("msg_a", "delivered", T0 + 2 * MINUTE)).toBe(false);
    expect(raw(emailId)).toMatchObject({
      delivery_state: "bounced",
      delivery_at: T0 + 2 * MINUTE,
    });
  });

  test("a newer final state overwrites an older one; an older one is ignored", () => {
    const emailId = sentInvite("msg_a");
    expect(outbox.recordDelivery("msg_a", "delivered", T0 + 2 * MINUTE)).toBe(true);
    expect(outbox.recordDelivery("msg_a", "bounced", T0 + MINUTE)).toBe(false);
    expect(raw(emailId)).toMatchObject({ delivery_state: "delivered" });
    expect(outbox.recordDelivery("msg_a", "bounced", T0 + 3 * MINUTE)).toBe(true);
    expect(raw(emailId)).toMatchObject({
      delivery_state: "bounced",
      delivery_at: T0 + 3 * MINUTE,
    });
  });

  test("delayed never overwrites a final state, even when it is newer; it does overwrite an older delayed", () => {
    for (const final of ["delivered", "bounced", "complained", "failed", "suppressed"] as const) {
      const id = `msg_${final}`;
      const emailId = sentInvite(id);
      expect(outbox.recordDelivery(id, "delayed", T0 + MINUTE), final).toBe(true);
      expect(outbox.recordDelivery(id, "delayed", T0 + 2 * MINUTE), final).toBe(true);
      expect(raw(emailId), final).toMatchObject({
        delivery_state: "delayed",
        delivery_at: T0 + 2 * MINUTE,
      });
      expect(outbox.recordDelivery(id, final, T0 + 3 * MINUTE), final).toBe(true);
      expect(outbox.recordDelivery(id, "delayed", T0 + 4 * MINUTE), final).toBe(false);
      expect(raw(emailId), final).toMatchObject({
        delivery_state: final,
        delivery_at: T0 + 3 * MINUTE,
      });
    }
  });
});

describe("findSent", () => {
  test("answers the public row of the sent email a provider id names; never a pending row, a contact write or an unknown id", () => {
    const a = invite("invite:hash-0001");
    expect(outbox.findSent("msg_a")).toBeUndefined();
    sendRow(a.emailId, "msg_a");
    const found = outbox.findSent("msg_a");
    expect(found).toMatchObject({
      emailId: a.emailId,
      kind: "invite_code",
      subjectRef: "hash-0001",
      status: "sent",
      providerMessageId: "msg_a",
    });
    // The public shape: never the address or the content.
    expect(Object.keys(found ?? {}).sort()).toEqual(Object.keys(outbox.list({})[0] ?? {}).sort());
    expect(outbox.findSent("msg_unknown")).toBeUndefined();

    const contact = outbox.enqueue({
      kind: "contact_upsert",
      subjectRef: "waitlist",
      idempotencyKey: contactIdempotencyKey(ADDRESS),
      to: ADDRESS,
    });
    db.prepare(
      `UPDATE email_outbox SET status = 'sent', provider_message_id = 'ct_1', sent_at = ?,
         next_attempt_at = NULL, to_address = NULL WHERE email_id = ?`,
    ).run(T0, contact.emailId);
    expect(outbox.findSent("ct_1")).toBeUndefined();
  });
});

describe("find and findByKey", () => {
  test("answer the public row an email id or an idempotency key names, in any state; never the address or the content", () => {
    const a = invite("invite:hash-0001");
    const b = invite("invite:hash-0002");
    failRow(b.emailId);
    expect(outbox.find(a.emailId)).toMatchObject({ emailId: a.emailId, status: "pending" });
    expect(outbox.find(b.emailId)).toMatchObject({ emailId: b.emailId, status: "failed" });
    expect(outbox.findByKey("invite:hash-0002")).toEqual(outbox.find(b.emailId));
    for (const found of [outbox.find(a.emailId), outbox.findByKey("invite:hash-0001")]) {
      expect(Object.keys(found ?? {}).sort()).toEqual(Object.keys(outbox.list({})[0] ?? {}).sort());
      expect(JSON.stringify(found)).not.toContain(ADDRESS);
      expect(JSON.stringify(found)).not.toContain("INV-SECRET");
    }
    expect(outbox.find("em_unknown")).toBeUndefined();
    expect(outbox.findByKey("invite:hash-unknown")).toBeUndefined();
  });
});

describe("enqueueContactUpsert", () => {
  const deps = (o: EmailOutbox): EmailDeps => ({
    sender: new ConsoleEmailSender(),
    outbox: o,
    publicAppUrl: "https://www.example.com",
    postalAddress: "1 Example Street, Dover, DE 19901, USA",
  });

  test("one contact_upsert row per address, keyed contact:<sha256 of the trimmed, lower-cased address>, its source as the subject ref", () => {
    const expected = `contact:${createHash("sha256").update(ADDRESS).digest("hex")}`;
    expect(contactIdempotencyKey("  Guardian.One@Example.COM ")).toBe(expected);

    enqueueContactUpsert(deps(outbox), { email: " Guardian.One@Example.com ", source: "waitlist" });
    enqueueContactUpsert(deps(outbox), { email: ADDRESS, source: "formation_party" });
    const rows = db.prepare("SELECT * FROM email_outbox").all() as Record<string, unknown>[];
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "contact_upsert",
        subject_ref: "waitlist",
        idempotency_key: expected,
        // Trimmed, as typed otherwise: the provider receives the address the person gave.
        to_address: "Guardian.One@Example.com",
        subject: null,
        text: null,
        html: null,
        status: "pending",
      }),
    ]);
    // The key holds a digest, never the address.
    expect(String(rows[0]?.idempotency_key)).not.toContain("example");
    expect(printed.join("\n")).not.toContain("example.com");
  });
});
