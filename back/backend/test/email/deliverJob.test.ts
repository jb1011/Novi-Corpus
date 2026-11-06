/**
 * The delivery job `email_deliver` (`EmailOutbox.deliverDue`): every 30 seconds it sends the due
 * rows of the outbox through the deployment's sender, one at a time, at most 20 a run, with each
 * row's own idempotency key; a retryable error waits 2^attempts minutes (60 at most) and the ninth
 * failure, or any refusal, fails the row with a CRITICAL `email_failed` line. A sent row keeps no
 * address and no body.
 *
 * Every address here is on example.com; no ops line written in this file may hold one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import {
  EMAIL_DELIVER_BUDGET_MS,
  EMAIL_DELIVER_EVERY_MS,
  EMAIL_DELIVER_LIMIT,
  EMAIL_MAX_RETRIES,
  SqliteEmailOutbox,
  buildEmailDeps,
  contactIdempotencyKey,
} from "../../src/email/outbox";
import {
  ConsoleEmailSender,
  EmailSendError,
  type EmailSender,
  type OutboundEmail,
} from "../../src/email/sender";
import { migrate, openDatabase } from "../../src/persistence/db";
import { buildScheduledJobs } from "../../src/scheduler/jobs";

const T0 = Date.UTC(2026, 10, 10, 12);
const SECOND = 1_000;
const MINUTE = 60_000;
const ADDRESS = "guardian.one@example.com";
const BODY = { text: "Your code: INV-SECRET-1234", html: "<p>Your code: INV-SECRET-1234</p>" };
const TENANT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

let db: Database.Database;
let outbox: SqliteEmailOutbox;
let clock: number;
/** Every line written to standard output, raw. */
let printed: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  clock = T0;
  outbox = new SqliteEmailOutbox(db, { now: () => clock, marketingSegmentId: "seg_1" });
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  // Every test: no line printed holds an address or a body's secret.
  for (const line of printed) {
    expect(line).not.toContain("example.com");
    expect(line).not.toContain("INV-SECRET-1234");
  }
});

/** The ops lines of one event, parsed. */
const lines = (event: string) =>
  printed
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((o): o is Record<string, unknown> => o?.opslog === event);

const raw = (emailId: string) =>
  db.prepare("SELECT * FROM email_outbox WHERE email_id = ?").get(emailId) as Record<
    string,
    unknown
  >;

/** A sender that records every call and answers what `answer` says, as a provider would. */
class StubSender implements EmailSender {
  readonly kind = "resend" as const;
  readonly sends: OutboundEmail[] = [];
  readonly contacts: { email: string; unsubscribed?: boolean; segmentId?: string }[] = [];
  inFlight = 0;
  maxInFlight = 0;
  answer: (e: OutboundEmail, call: number) => Promise<{ providerMessageId: string }> = async (
    _e,
    call,
  ) => ({ providerMessageId: `msg_${call}` });

  async send(e: OutboundEmail): Promise<{ providerMessageId: string }> {
    this.sends.push(e);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // A turn of the event loop, so two sends started together would overlap here.
      await new Promise((resolve) => setImmediate(resolve));
      return await this.answer(e, this.sends.length);
    } finally {
      this.inFlight -= 1;
    }
  }

  async upsertContact(c: { email: string; unsubscribed?: boolean; segmentId?: string }) {
    this.contacts.push(c);
    return { providerContactId: `ct_${this.contacts.length}` };
  }
}

const enqueue = (n: number, kind: "invite_code" | "filing_landed" = "invite_code") =>
  outbox.enqueue({
    kind,
    subjectRef: `ref-${n}`,
    idempotencyKey: `${kind}:ref-${n}`,
    to: ADDRESS,
    subject: `Subject ${n}`,
    ...BODY,
  });

describe("deliverDue", () => {
  test("sends a due row through the sender with the row's key; the sent row keeps its subject, kind and ids, and loses its address, text and HTML", async () => {
    const sender = new StubSender();
    const { emailId } = enqueue(1, "filing_landed");
    clock = T0 + 5 * SECOND;
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
    });
    expect(sender.sends).toEqual([
      {
        to: ADDRESS,
        subject: "Subject 1",
        text: BODY.text,
        html: BODY.html,
        idempotencyKey: "filing_landed:ref-1",
      },
    ]);
    expect(raw(emailId)).toEqual({
      email_id: emailId,
      kind: "filing_landed",
      subject_ref: "ref-1",
      idempotency_key: "filing_landed:ref-1",
      to_address: null,
      subject: "Subject 1",
      text: null,
      html: null,
      status: "sent",
      attempts: 0,
      next_attempt_at: null,
      provider_message_id: "msg_1",
      delivery_state: null,
      delivery_at: null,
      last_error: null,
      created_at: T0,
      sent_at: T0 + 5 * SECOND,
    });
    // Nothing is due any more.
    await expect(outbox.deliverDue(sender, T0 + MINUTE)).resolves.toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
    expect(sender.sends).toHaveLength(1);
  });

  test("the formed-door review case: a send that throws after the provider saw it is retried with the same key and the same payload, and the row ends sent once", async () => {
    const sender = new StubSender();
    sender.answer = async (_e, call) => {
      // The call is recorded (the provider has it), then the answer is lost.
      if (call === 1) throw new EmailSendError(null, "timeout", true);
      return { providerMessageId: "msg_first" };
    };
    const { emailId } = enqueue(1, "filing_landed");
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 0,
      retried: 1,
      failed: 0,
    });
    expect(raw(emailId)).toMatchObject({ status: "pending", attempts: 1, last_error: "timeout" });

    clock = T0 + 2 * MINUTE;
    await expect(outbox.deliverDue(sender, clock)).resolves.toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
    });
    expect(sender.sends.map((s) => s.idempotencyKey)).toEqual([
      "filing_landed:ref-1",
      "filing_landed:ref-1",
    ]);
    // The provider answers the first send's id only to the same key with the same payload.
    expect(sender.sends[1]).toEqual(sender.sends[0]);
    expect(db.prepare("SELECT status, provider_message_id FROM email_outbox").all()).toEqual([
      { status: "sent", provider_message_id: "msg_first" },
    ]);
  });

  test("a retryable error waits min(2^attempts, 60) minutes, attempts counted on the row; the ninth failure fails the row with a CRITICAL email_failed line carrying the provider's code", async () => {
    const sender = new StubSender();
    sender.answer = async () => {
      throw new EmailSendError(429, "daily_quota_exceeded", true);
    };
    const { emailId } = enqueue(1);
    expect(EMAIL_MAX_RETRIES).toBe(8);

    const waits: number[] = [];
    for (let attempt = 1; attempt <= EMAIL_MAX_RETRIES; attempt++) {
      const due = raw(emailId).next_attempt_at as number;
      // A millisecond early, nothing is due.
      await expect(outbox.deliverDue(sender, due - 1)).resolves.toEqual({
        sent: 0,
        retried: 0,
        failed: 0,
      });
      clock = due + 7 * SECOND;
      await expect(outbox.deliverDue(sender, due)).resolves.toEqual({
        sent: 0,
        retried: 1,
        failed: 0,
      });
      const row = raw(emailId);
      expect(row).toMatchObject({
        status: "pending",
        attempts: attempt,
        last_error: "429 daily_quota_exceeded",
      });
      // Counted from the failure, on the outbox's clock.
      waits.push(((row.next_attempt_at as number) - clock) / MINUTE);
    }
    expect(waits).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
    expect(lines("email_retry")).toHaveLength(8);
    expect(lines("email_retry")[0]).toEqual({
      opslog: "email_retry",
      at: expect.any(String),
      level: "warn",
      emailId,
      kind: "invite_code",
      attempts: 1,
      status: 429,
      code: "daily_quota_exceeded",
      nextAttemptAt: T0 + 7 * SECOND + 2 * MINUTE,
    });
    expect(lines("email_failed")).toEqual([]);

    // The ninth failure.
    clock = raw(emailId).next_attempt_at as number;
    await expect(outbox.deliverDue(sender, clock)).resolves.toEqual({
      sent: 0,
      retried: 0,
      failed: 1,
    });
    expect(sender.sends).toHaveLength(9);
    expect(raw(emailId)).toMatchObject({
      status: "failed",
      attempts: 9,
      next_attempt_at: null,
      last_error: "429 daily_quota_exceeded",
      // A failed row keeps what `email:resend` needs to send it again.
      to_address: ADDRESS,
      text: BODY.text,
      html: BODY.html,
    });
    expect(lines("email_failed")).toEqual([
      {
        opslog: "email_failed",
        at: expect.any(String),
        level: "error",
        severity: "CRITICAL",
        emailId,
        kind: "invite_code",
        subjectRef: "ref-1",
        status: 429,
        code: "daily_quota_exceeded",
        attempts: 9,
      },
    ]);
    // Failed is final: nothing more is sent.
    await outbox.deliverDue(sender, clock + 24 * 60 * MINUTE);
    expect(sender.sends).toHaveLength(9);
  });

  test("a refusal fails the row at once with the same line (a tenant id cut to ten characters); requeued, the row is delivered", async () => {
    const sender = new StubSender();
    sender.answer = async (_e, call) => {
      if (call === 1) throw new EmailSendError(422, "validation_error", false);
      return { providerMessageId: "msg_again" };
    };
    const { emailId } = outbox.enqueue({
      kind: "identity_link",
      subjectRef: TENANT,
      idempotencyKey: `identity_link:${TENANT}:2026-11-10`,
      to: ADDRESS,
      subject: "Confirm who you are",
      ...BODY,
    });
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 0,
      retried: 0,
      failed: 1,
    });
    expect(raw(emailId)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "422 validation_error",
      to_address: ADDRESS,
    });
    expect(lines("email_failed")).toEqual([
      expect.objectContaining({
        severity: "CRITICAL",
        emailId,
        kind: "identity_link",
        subjectRef: "0x70997970…",
        status: 422,
        code: "validation_error",
        attempts: 1,
      }),
    ]);
    expect(printed.join("\n")).not.toContain(TENANT);

    clock = T0 + 60 * MINUTE;
    expect(outbox.requeue(emailId, ADDRESS)).toBe(true);
    await expect(outbox.deliverDue(sender, clock)).resolves.toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
    });
    expect(raw(emailId)).toMatchObject({
      status: "sent",
      provider_message_id: "msg_again",
      to_address: null,
    });
  });

  test("a row another process settled while its send was going is left as it is, and no retry or failure line is written for it", async () => {
    const sender = new StubSender();
    const settleElsewhere = (emailId: string, providerMessageId: string) =>
      db
        .prepare(
          `UPDATE email_outbox SET status = 'sent', provider_message_id = ?, sent_at = ?,
             next_attempt_at = NULL, to_address = NULL, text = NULL, html = NULL
           WHERE email_id = ?`,
        )
        .run(providerMessageId, T0, emailId);
    const first = enqueue(1);
    const second = enqueue(2);
    sender.answer = async (e) => {
      // Another process (a manual scheduler:run) sent the row first; this send fails late.
      if (e.subject === "Subject 1") {
        settleElsewhere(first.emailId, "msg_elsewhere_1");
        throw new EmailSendError(503, "http_503", true);
      }
      settleElsewhere(second.emailId, "msg_elsewhere_2");
      throw new EmailSendError(422, "validation_error", false);
    };
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
    expect(raw(first.emailId)).toMatchObject({ status: "sent", attempts: 0, last_error: null });
    expect(raw(second.emailId)).toMatchObject({ status: "sent", attempts: 0, last_error: null });
    expect(lines("email_retry")).toEqual([]);
    expect(lines("email_failed")).toEqual([]);
  });

  test("an error that is not the sender's own is retried, coded unexpected_error, its message never kept", async () => {
    const sender = new StubSender();
    sender.answer = async () => {
      throw new TypeError(`cannot read the answer for ${ADDRESS}`);
    };
    const { emailId } = enqueue(1);
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 0,
      retried: 1,
      failed: 0,
    });
    expect(raw(emailId)).toMatchObject({ attempts: 1, last_error: "unexpected_error" });
  });

  test("a contact_upsert row calls upsertContact with its address and the marketing segment, never send", async () => {
    const sender = new StubSender();
    const { emailId } = outbox.enqueue({
      kind: "contact_upsert",
      subjectRef: "waitlist",
      idempotencyKey: contactIdempotencyKey(ADDRESS),
      to: ADDRESS,
    });
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
    });
    expect(sender.sends).toEqual([]);
    expect(sender.contacts).toEqual([{ email: ADDRESS, segmentId: "seg_1" }]);
    expect(raw(emailId)).toMatchObject({
      status: "sent",
      provider_message_id: "ct_1",
      to_address: null,
    });
  });

  test("with the console sender the delivery is the ops line, without the address, and the row still ends sent", async () => {
    const { emailId } = enqueue(1);
    await outbox.deliverDue(new ConsoleEmailSender(), T0);
    expect(raw(emailId)).toMatchObject({
      status: "sent",
      provider_message_id: "console:invite_code:ref-1",
      to_address: null,
    });
    expect(lines("email_console")).toEqual([
      expect.objectContaining({ subject: "Subject 1", idempotencyKey: "invite_code:ref-1" }),
    ]);
  });

  test("at most 20 rows a run, the longest-due first, sent one at a time", async () => {
    expect(EMAIL_DELIVER_LIMIT).toBe(20);
    const sender = new StubSender();
    for (let n = 1; n <= 25; n++) {
      clock = T0 + n * SECOND;
      enqueue(n);
    }
    await expect(outbox.deliverDue(sender, clock)).resolves.toEqual({
      sent: 20,
      retried: 0,
      failed: 0,
    });
    expect(sender.sends.map((s) => s.subject)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Subject ${i + 1}`),
    );
    expect(sender.maxInFlight).toBe(1);
    await expect(outbox.deliverDue(sender, clock)).resolves.toMatchObject({ sent: 5 });
    expect(sender.sends).toHaveLength(25);
    // A smaller limit is a smaller run; a limit that is not a positive whole number is refused.
    await expect(outbox.deliverDue(sender, clock, 0)).rejects.toThrow(/limit/);
    await expect(outbox.deliverDue(sender, clock, 1.5)).rejects.toThrow(/limit/);
  });

  test("a run takes no new row once 45 seconds have passed in it", async () => {
    expect(EMAIL_DELIVER_BUDGET_MS).toBe(45 * SECOND);
    const sender = new StubSender();
    sender.answer = async (_e, call) => {
      // Each send takes 16 seconds on the outbox's clock.
      clock += 16 * SECOND;
      return { providerMessageId: `msg_${call}` };
    };
    for (let n = 1; n <= 5; n++) enqueue(n);
    // 0 s, 16 s, 32 s: three rows started; at 48 s the run stops.
    await expect(outbox.deliverDue(sender, T0)).resolves.toEqual({
      sent: 3,
      retried: 0,
      failed: 0,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'pending'").get(),
    ).toEqual({ n: 2 });
  });

  test("a run stops taking rows once the stop signal is set: the row going finishes, no other starts", async () => {
    const stop = new AbortController();
    const sender = new StubSender();
    sender.answer = async (_e, call) => {
      if (call === 1) stop.abort();
      return { providerMessageId: `msg_${call}` };
    };
    for (let n = 1; n <= 3; n++) enqueue(n);
    await expect(outbox.deliverDue(sender, T0, 20, { signal: stop.signal })).resolves.toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
    });
    expect(sender.sends).toHaveLength(1);
    // Already set: nothing at all.
    await expect(outbox.deliverDue(sender, T0, 20, { signal: stop.signal })).resolves.toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
  });
});

describe("the email_deliver job", () => {
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

  test("is registered every 30 seconds, quiet, only where the email system is configured (never on the testnet box)", () => {
    expect(EMAIL_DELIVER_EVERY_MS).toBe(30 * SECOND);
    const jobs = buildScheduledJobs(db, loadConfig(CONSOLE));
    expect(jobs.map((j) => [j.name, j.everyMs, j.quiet])).toEqual([
      ["email_deliver", 30 * SECOND, true],
    ]);
    expect(buildScheduledJobs(db, loadConfig(BASE))).toEqual([]);
    expect(buildEmailDeps(db, loadConfig(BASE))).toBeUndefined();
  });

  test("delivers the due rows with the deployment's sender, and hands the stop signal on", async () => {
    const cfg = loadConfig(CONSOLE);
    const email = buildEmailDeps(db, cfg);
    expect(email?.sender.kind).toBe("console");
    const [job] = buildScheduledJobs(db, cfg, email);
    const live = new SqliteEmailOutbox(db);
    live.enqueue({
      kind: "invite_code",
      subjectRef: "ref-1",
      idempotencyKey: "invite_code:ref-1",
      to: ADDRESS,
      subject: "Subject 1",
      ...BODY,
    });
    live.enqueue({
      kind: "invite_code",
      subjectRef: "ref-2",
      idempotencyKey: "invite_code:ref-2",
      to: ADDRESS,
      subject: "Subject 2",
      ...BODY,
    });
    const stopped = new AbortController();
    stopped.abort();
    await expect(job?.run(Date.now() + SECOND, stopped.signal)).resolves.toEqual({
      sent: 0,
      retried: 0,
      failed: 0,
    });
    await expect(job?.run(Date.now() + SECOND)).resolves.toEqual({
      sent: 2,
      retried: 0,
      failed: 0,
    });
    expect(live.list({ status: "sent" })).toHaveLength(2);
  });

  test("main.ts builds the email system once, outbox included, and hands that one to the job list and to the API", () => {
    const src = (...p: string[]) =>
      readFileSync(join(import.meta.dirname, "..", "..", "src", ...p), "utf8");
    const main = src("api", "main.ts");
    expect(main).toMatch(/const email = buildEmailDeps\(db, cfg\);/);
    expect(main).toContain("buildScheduledJobs(db, cfg, email)");
    expect(main).not.toContain("new ConsoleEmailSender(");
    expect(main).not.toContain("new ResendEmailSender(");
    expect(src("api", "app.ts")).toContain('import type { EmailDeps } from "../email/outbox";');
  });
});
