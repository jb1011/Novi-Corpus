/**
 * The operator's email commands, `email:list`, `email:resend` and `email:send-link`, and the beta's
 * identity-link email they queue (`src/email/templates/identityLink.ts`).
 *
 * Each command opens the database through the configuration, so every test works in a temporary
 * data directory and writes its outbox rows through its own connection over the same file. With
 * ARC_NETWORK unset the deployment is a sandbox, with the console sender. Every address is on
 * example.com, the tenant is one of anvil's published test accounts, and no fixture holds a name.
 *
 * The rule every test here holds: no line a command writes, its output or an ops line, carries the
 * address it was given or the address a row holds. The address is taken from `--to`, or read at
 * `--to-prompt`, through the path a pipe takes (standard input that is not a terminal).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readAddress } from "../../src/cli/email";
import { buildCli } from "../../src/cli/index";
import { osUser } from "../../src/cli/operator";
import { SqliteEmailOutbox, contactIdempotencyKey } from "../../src/email/outbox";
import { EmailSendError, type EmailSender, type OutboundEmail } from "../../src/email/sender";
import {
  IDENTITY_LINK_SUBJECT,
  escapeHtml,
  identityLinkEmail,
  identityLinkIdempotencyKey,
} from "../../src/email/templates/identityLink";
import { migrate, openDatabase } from "../../src/persistence/db";
import { ANVIL_ACCOUNT_2, ANVIL_ACCOUNT_3 } from "../helpers/customerCompanyFixtures";

const OPERATOR = "ops.example";
const ADDRESS = "guardian.one@example.com";
const NEW_ADDRESS = "guardian.new@example.com";
/** Any address, in any case: no line a command writes may hold one. */
const ANY_ADDRESS = /[a-z0-9._-]+@example\.com/i;
const APP_URL = "https://www.example.com";
const POSTAL = "1 Example Street, Suite 100, Dover, DE 19901, USA";
/** A link as the operator builds it: the flow's static link and an opaque reference. */
const LINK = "https://verify.example.com/start/flow_test_0001?client_reference_id=9f2c4e1ab07d3e55";
const NOT_CONFIGURED = "refusing: email is not configured on this deployment (PUBLIC_APP_URL)";
const NO_ADDRESS_IN_LINK =
  "refusing: the link must not carry the person's email address (remove prefilled_email)";
const RESERVED_SYSTEM =
  "refusing: --operator system is reserved for the emails the product sends by itself";
const DAY = 86_400_000;

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const guardian = ANVIL_ACCOUNT_2.address;
const second = ANVIL_ACCOUNT_3.address;

let dir: string;
let db: Database.Database;
let outbox: SqliteEmailOutbox;
/** Every line written to standard output, the commands' and the ops lines alike. */
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "email-commands-"));
  // The commands find the database through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  // The email system, with the console sender (EMAIL_PROVIDER's default).
  process.env.PUBLIC_APP_URL = APP_URL;
  process.env.EMAIL_FROM = "Novi Corpus <hello@example.com>";
  process.env.EMAIL_POSTAL_ADDRESS = POSTAL;
  for (const name of [
    "ARC_NETWORK",
    "DOOLA_API_KEY",
    "DOOLA_WEBHOOK_SECRET",
    "DOOLA_ENVIRONMENT",
    "FORMATION_PII_KEY",
    "FORMATION_PII_KEY_PREVIOUS",
    "IDENTITY_NAME_HMAC_KEY",
    "EMAIL_PROVIDER",
    "RESEND_API_KEY",
    "RESEND_WEBHOOK_SECRET",
    "EMAIL_REPLY_TO",
    "RESEND_MARKETING_SEGMENT_ID",
    "EMAIL_CONSOLE_SHOW_BODY",
  ])
    Reflect.deleteProperty(process.env, name);
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  // Read through the global, so a test that pins the date (`at`) pins the rows' times too.
  outbox = new SqliteEmailOutbox(db, { now: () => Date.now() });
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

const isOpsLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed;
  } catch {
    return false;
  }
};

interface Run<T> {
  /** The one JSON object the command printed. */
  output: T;
  /** The ops lines it wrote, parsed. */
  ops: Record<string, unknown>[];
  /** Everything it wrote to standard output. */
  lines: string[];
}

async function run<T = Record<string, unknown>>(args: string[]): Promise<Run<T>> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const lines = printed.slice(from);
  const outputs = lines.filter((line) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  // The rule of every command here: no line holds an address.
  for (const line of lines) expect(line).not.toMatch(ANY_ADDRESS);
  return {
    output: JSON.parse(outputs[0] as string) as T,
    ops: lines.filter(isOpsLine).map((line) => JSON.parse(line) as Record<string, unknown>),
    lines,
  };
}

/** The refusal's message. A refusal writes no ops line, and its message holds no address. */
async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from).filter(isOpsLine)).toEqual([]);
  expect(message).not.toMatch(ANY_ADDRESS);
  return message;
}

/** The raw row, every column, as the database holds it. */
const raw = (emailId: string) =>
  db.prepare("SELECT * FROM email_outbox WHERE email_id = ?").get(emailId) as Record<
    string,
    unknown
  >;
const count = () => (db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get() as { n: number }).n;

/** A sender that takes every email (each answered with a new provider id), or refuses each one
 *  for good (a 422: the row fails at once). */
function senderThat(outcome: "accepts" | "refuses") {
  const sent: OutboundEmail[] = [];
  const contacts: string[] = [];
  const refuse = () => {
    throw new EmailSendError(422, "validation_error", false);
  };
  const sender: EmailSender = {
    kind: "console",
    async send(e) {
      if (outcome === "refuses") refuse();
      sent.push(e);
      return { providerMessageId: `re_msg_${sent.length}` };
    },
    async upsertContact(c) {
      if (outcome === "refuses") refuse();
      contacts.push(c.email);
      return { providerContactId: `ct_${contacts.length}` };
    },
  };
  return { sender, sent, contacts };
}

/** One invite email, as PR 2b will enqueue it: its body holds a code meant for one person. */
const invite = (n: number, to = ADDRESS) =>
  outbox.enqueue({
    kind: "invite_code",
    subjectRef: `inv_hash_${n}`,
    idempotencyKey: `invite_code:hash-${n}`,
    to,
    subject: "Your invitation",
    text: `Your code: INV-SECRET-${n}`,
    html: `<p>Your code: INV-SECRET-${n}</p>`,
  }).emailId;

/** Runs the delivery job once over every due row. */
const deliver = (sender: EmailSender) => outbox.deliverDue(sender, Date.now() + 1);

/** An invite email the provider refused: `failed`, its address and content kept. */
async function failedInvite(n = 1, to = ADDRESS): Promise<string> {
  const emailId = invite(n, to);
  await deliver(senderThat("refuses").sender);
  expect(raw(emailId).status).toBe("failed");
  return emailId;
}

/** The configuration without the email system: none of its settings. */
function withoutEmail(): void {
  for (const name of ["PUBLIC_APP_URL", "EMAIL_FROM", "EMAIL_POSTAL_ADDRESS"])
    Reflect.deleteProperty(process.env, name);
}

const sendLink = (
  tenantId: string,
  over: { url?: string; to?: string; operator?: string; again?: boolean } = {},
  yes = true,
): string[] => [
  "email:send-link",
  tenantId,
  "--url",
  over.url ?? LINK,
  "--to",
  over.to ?? ADDRESS,
  "--operator",
  over.operator ?? OPERATOR,
  ...(over.again ? ["--again"] : []),
  ...(yes ? ["--yes"] : []),
];

const resend = (emailId: string, over: { to?: string; operator?: string } = {}, yes = true) => [
  "email:resend",
  emailId,
  "--to",
  over.to ?? NEW_ADDRESS,
  "--operator",
  over.operator ?? OPERATOR,
  ...(yes ? ["--yes"] : []),
];

const sha16 = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Standard input, not a terminal: the lines given, then its end. */
function piped(text: string): void {
  vi.spyOn(process, "stdin", "get").mockReturnValue(
    Readable.from([text]) as unknown as typeof process.stdin,
  );
}

/** Standard input that must not be read. */
const stdinUntouched = () =>
  vi.spyOn(process, "stdin", "get").mockImplementation(() => {
    throw new Error("standard input was read");
  });

/** The command line with `--to-prompt` in place of `--to <address>`. */
const prompted = (line: string[]): string[] => {
  const at = line.indexOf("--to");
  return [...line.slice(0, at), "--to-prompt", ...line.slice(at + 2)];
};

/** Pins the clock's date, and only the date: the commands' timers stay real. */
function at(iso: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

interface ListedEmail {
  emailId: string;
  kind: string;
  subjectRef: string | null;
  subject: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  providerMessageId: string | null;
  deliveryState: string | null;
  deliveryAt: string | null;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}
interface Listed {
  count: number;
  emails: ListedEmail[];
}

// ── the email system must be configured ──────────────────────────────────────────────────────

describe("every email command needs the email system", () => {
  test("without PUBLIC_APP_URL each refuses, and writes nothing", async () => {
    withoutEmail();
    expect(await refusal(["email:list"])).toBe(NOT_CONFIGURED);
    expect(await refusal(resend(`em_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`))).toBe(
      NOT_CONFIGURED,
    );
    expect(await refusal(sendLink(guardian))).toBe(NOT_CONFIGURED);
    expect(count()).toBe(0);
  });

  test("with --to-prompt the configuration is refused before anything is read at the prompt", async () => {
    withoutEmail();
    const stdin = stdinUntouched();
    expect(await refusal(prompted(sendLink(guardian)))).toBe(NOT_CONFIGURED);
    expect(await refusal(prompted(resend("em_00000000-0000-4000-8000-000000000000")))).toBe(
      NOT_CONFIGURED,
    );
    expect(stdin).not.toHaveBeenCalled();
  });
});

// ── email:list ───────────────────────────────────────────────────────────────────────────────

describe("email:list", () => {
  test("prints each row's ids, kind, states and delivery state; never an address, a body or a key; no ops line", async () => {
    // One minute apart, so the order (by creation) is the test's.
    at("2026-11-10T08:00:00Z");
    const failed = await failedInvite(1);
    at("2026-11-10T08:01:00Z");
    const sent = invite(2);
    await deliver(senderThat("accepts").sender);
    expect(outbox.recordDelivery("re_msg_1", "bounced", Date.now())).toBe(true);
    at("2026-11-10T08:02:00Z");
    const pending = invite(3);

    const { output, ops, lines } = await run<Listed>(["email:list"]);
    expect(ops).toEqual([]);
    expect(output.count).toBe(3);
    expect(output.emails.map((e) => [e.emailId, e.status])).toEqual([
      [failed, "failed"],
      [sent, "sent"],
      [pending, "pending"],
    ]);
    expect(output.emails[0]).toMatchObject({
      kind: "invite_code",
      subjectRef: "inv_hash_1",
      subject: "Your invitation",
      attempts: 1,
      lastError: "422 validation_error",
      deliveryState: null,
      sentAt: null,
    });
    expect(output.emails[1]).toMatchObject({
      status: "sent",
      providerMessageId: "re_msg_1",
      deliveryState: "bounced",
    });
    // Times as an operator reads them.
    expect(output.emails[1]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(output.emails[1]?.sentAt).toMatch(/Z$/);
    expect(output.emails[1]?.deliveryAt).toMatch(/Z$/);
    expect(output.emails[2]?.nextAttemptAt).toMatch(/Z$/);
    // Neither the content nor the key leaves the table.
    const all = lines.join("\n");
    expect(all).not.toContain("INV-SECRET");
    expect(all).not.toContain("invite_code:hash-");
    for (const e of output.emails) {
      expect(Object.keys(e)).not.toContain("to");
      expect(Object.keys(e)).not.toContain("idempotencyKey");
      expect(Object.keys(e)).not.toContain("text");
      expect(Object.keys(e)).not.toContain("html");
    }
  });

  test("--status, --kind and --since filter the rows", async () => {
    at("2026-11-09T22:00:00Z");
    const early = await failedInvite(1);
    at("2026-11-10T08:00:00Z");
    const late = await failedInvite(2);
    const pending = invite(3);
    await run(sendLink(guardian));
    const link = (await run<Listed>(["email:list", "--kind", "identity_link"])).output.emails;
    expect(link).toHaveLength(1);
    expect(link[0]).toMatchObject({ kind: "identity_link", subjectRef: guardian });

    const ids = async (...args: string[]) =>
      (await run<Listed>(["email:list", ...args])).output.emails.map((e) => e.emailId);
    expect(await ids("--status", "failed")).toEqual([early, late]);
    expect(await ids("--status", "pending", "--kind", "invite_code")).toEqual([pending]);
    expect(await ids("--status", "failed", "--since", "2026-11-10")).toEqual([late]);
    expect(await ids("--status", "failed", "--since", "2026-11-09T21:59:59Z")).toEqual([
      early,
      late,
    ]);
    expect(await ids("--status", "failed", "--since", "2026-11-10T09:00:00+02:00")).toEqual([late]);
    expect(await ids("--status", "sent")).toEqual([]);
  });

  test("--limit keeps the newest rows, printed oldest first, and says when older ones are left out; 100 by default, at most 1000", async () => {
    for (let n = 1; n <= 5; n += 1) {
      at(`2026-11-10T08:0${n}:00Z`);
      invite(n);
    }
    const all = (await run<Listed>(["email:list"])).output;
    expect(all.count).toBe(5);
    expect(all).not.toHaveProperty("more");
    const ids = all.emails.map((e) => e.emailId);

    const { output } = await run<Listed & { more?: boolean; next?: string }>([
      "email:list",
      "--limit",
      "2",
    ]);
    expect(output.emails.map((e) => e.emailId)).toEqual(ids.slice(3));
    expect(output).toMatchObject({
      count: 2,
      more: true,
      next: "older emails are left out: narrow the list with --status, --kind or --since, or raise --limit (at most 1000)",
    });
    expect((await run<Listed>(["email:list", "--limit", "5"])).output).not.toHaveProperty("more");

    for (const bad of ["0", "1001", "-1", "2.5", "ten", "1e3"])
      expect(await refusal(["email:list", "--limit", bad]), bad).toBe(
        "refusing: --limit must be a whole number from 1 to 1000",
      );
  });

  test("without --limit at most 100 rows are printed, the newest", async () => {
    at("2026-11-10T08:00:00Z");
    const insert = db.prepare(
      `INSERT INTO email_outbox (email_id, kind, subject_ref, idempotency_key, to_address, subject,
         text, html, status, attempts, next_attempt_at, created_at)
       VALUES (?, 'invite_code', 'inv', ?, 'x@example.com', 's', 't', 'h', 'pending', 0, ?, ?)`,
    );
    for (let n = 0; n < 101; n += 1) {
      const id = `em_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      insert.run(id, `invite_code:bulk-${n}`, Date.now() + n, Date.now() + n);
    }
    const { output } = await run<Listed & { more?: boolean }>(["email:list"]);
    expect(output.count).toBe(100);
    expect(output.more).toBe(true);
    expect(output.emails[0]?.emailId).toBe("em_00000000-0000-4000-8000-000000000001");
    expect(output.emails.at(-1)?.emailId).toBe("em_00000000-0000-4000-8000-000000000100");
  });

  test("refuses a status, a kind or a date it does not know", async () => {
    expect(await refusal(["email:list", "--status", "bounced"])).toBe(
      "refusing: --status must be one of pending, sent, failed",
    );
    expect(await refusal(["email:list", "--kind", "newsletter"])).toBe(
      "refusing: --kind must be one of filing_landed, waitlist_confirm, invite_code, identity_link, contact_upsert",
    );
    const since =
      "refusing: --since must be a date (2026-11-10) or an ISO-8601 time with its zone (2026-11-10T08:00:00Z), on a real calendar date";
    for (const bad of ["yesterday", "10/11/2026", "2026-02-30", "2026-11-10T08:00:00", "7"])
      expect(await refusal(["email:list", "--since", bad]), bad).toBe(since);
  });
});

// ── email:resend ─────────────────────────────────────────────────────────────────────────────

describe("email:resend", () => {
  test("without --yes says what it would do and writes nothing", async () => {
    const emailId = await failedInvite();
    const before = raw(emailId);

    const { output, ops } = await run(resend(emailId, {}, false));
    expect(ops).toEqual([]);
    expect(output).toMatchObject({
      requeued: false,
      emailId,
      kind: "invite_code",
      subjectRef: "inv_hash_1",
      status: "failed",
      attempts: 1,
      lastError: "422 validation_error",
      next: "nothing was written: run the same command with --yes to re-queue it",
    });
    expect(output.note).toBe(
      "the email goes again under its own idempotency key, which the provider keeps 24 hours. A failed email may still be one whose send the provider took: then, to another address within 24 hours of that send, the provider refuses it (409 invalid_idempotent_request) and nothing is sent twice. The fix: for an identity link, email:send-link --again, under a new key, at once; for any other email, the same email:resend after 24 hours (docs/runbooks/email.md)",
    );
    expect(raw(emailId)).toEqual(before);
  });

  test("with --yes the failed row is pending again, due now, its attempts from zero, under the address given; one email_requeued line { emailId, operator, operatorOsUser }", async () => {
    const emailId = await failedInvite();
    const before = Date.now();

    const { output, ops } = await run(resend(emailId));
    expect(output).toMatchObject({
      requeued: true,
      emailId,
      kind: "invite_code",
      status: "pending",
    });
    const row = raw(emailId);
    expect(row).toMatchObject({
      status: "pending",
      to_address: NEW_ADDRESS,
      attempts: 0,
      // The idempotency key and the content are the row's own: the same email, sent again.
      idempotency_key: "invite_code:hash-1",
      text: "Your code: INV-SECRET-1",
    });
    expect(row.next_attempt_at as number).toBeGreaterThanOrEqual(before);
    expect(row.next_attempt_at as number).toBeLessThanOrEqual(Date.now());
    expect(ops).toHaveLength(1);
    const { at: _at, ...line } = ops[0] as Record<string, unknown>;
    expect(line).toEqual({
      opslog: "email_requeued",
      emailId,
      operator: OPERATOR,
      operatorOsUser: osUser(),
    });

    // The delivery job then sends it, to the new address, with the row's key.
    const accepting = senderThat("accepts");
    expect(await deliver(accepting.sender)).toEqual({ sent: 1, retried: 0, failed: 0 });
    expect(accepting.sent.map((e) => [e.to, e.idempotencyKey])).toEqual([
      [NEW_ADDRESS, "invite_code:hash-1"],
    ]);
    expect(raw(emailId)).toMatchObject({ status: "sent", to_address: null });
  });

  test("only a failed row: an unknown, a pending or a sent email is refused, and so is an id that is not one", async () => {
    const sent = invite(1);
    await deliver(senderThat("accepts").sender);
    const pending = invite(2);
    expect(raw(sent).status).toBe("sent");

    expect(await refusal(resend(sent))).toBe(
      `refusing: email ${sent} is sent: only a failed email is re-queued (a sent email that did not arrive is followed up as the email runbook says)`,
    );
    expect(await refusal(resend(pending))).toBe(
      `refusing: email ${pending} is pending: only a failed email is re-queued`,
    );
    const unknown = "em_00000000-0000-4000-8000-000000000000";
    expect(await refusal(resend(unknown))).toBe(`refusing: no email has the id ${unknown}`);
    for (const bad of ["em_1", "inv_hash_1", ADDRESS, "EM_00000000-0000-4000-8000-000000000000"])
      expect(await refusal(resend(bad)), "malformed id").toBe(
        "refusing: <emailId> must be an email id as email:list prints it (em_ and a UUID)",
      );
    expect(raw(sent).status).toBe("sent");
    expect(raw(pending).status).toBe("pending");
  });

  test("--to must be one address, and is never echoed", async () => {
    const emailId = await failedInvite();
    const toRule = "refusing: --to must be one email address";
    for (const bad of [
      "not-an-address",
      `${NEW_ADDRESS}, ${ADDRESS}`,
      "guardian.new@exam\nple.com",
      "guardian\u0000@example.com",
      `<${NEW_ADDRESS}>`,
      `${"a".repeat(250)}@example.com`,
    ])
      expect(await refusal(resend(emailId, { to: bad })), JSON.stringify(bad)).toBe(toRule);
    expect(raw(emailId)).toMatchObject({ status: "failed", to_address: ADDRESS });
  });

  test("--operator follows the operator rule, and system is reserved", async () => {
    const emailId = await failedInvite();
    expect(await refusal(resend(emailId, { operator: "Ops Example" }))).toBe(
      "refusing: --operator must match ^[a-z0-9._-]{2,40}$",
    );
    expect(await refusal(resend(emailId, { operator: "system" }))).toBe(RESERVED_SYSTEM);
    expect(raw(emailId).status).toBe("failed");
  });

  test("a contact write is re-queued only under the address it was written for", async () => {
    const contact = outbox.enqueue({
      kind: "contact_upsert",
      subjectRef: "waitlist",
      idempotencyKey: contactIdempotencyKey(ADDRESS),
      to: ADDRESS,
    }).emailId;
    await deliver(senderThat("refuses").sender);
    expect(raw(contact).status).toBe("failed");

    expect(await refusal(resend(contact, { to: NEW_ADDRESS }))).toBe(
      "refusing: a contact write is re-queued only under the address it was written for: the consent is that address's",
    );
    expect(raw(contact)).toMatchObject({ status: "failed", to_address: ADDRESS });
    // The same address in another case is the same address.
    const { output } = await run(resend(contact, { to: "Guardian.One@Example.COM" }));
    expect(output).toMatchObject({ requeued: true, kind: "contact_upsert" });
  });
});

// ── email:send-link ──────────────────────────────────────────────────────────────────────────

describe("email:send-link", () => {
  test("without --yes says what it would queue, and writes nothing", async () => {
    at("2026-11-10T08:00:00Z");
    const { output, ops } = await run(sendLink(guardian.toLowerCase(), {}, false));
    expect(ops).toEqual([]);
    expect(count()).toBe(0);
    expect(output).toEqual({
      queued: false,
      tenantId: guardian,
      wouldQueue: {
        kind: "identity_link",
        subjectRef: guardian,
        idempotencyKey: `identity_link:${sha16(guardian)}:2026-11-10`,
        subject: "Confirm who you are",
        link: LINK,
      },
      next: "nothing was written: run the same command with --yes to queue it",
    });
  });

  test("with --yes queues one identity_link row for the checksummed tenant, keyed identity_link:<16 hex of sha256(tenant)>:<UTC day>; its line holds the email id, the shortened tenant, the operator and the OS user", async () => {
    at("2026-11-10T23:59:30Z");
    const { output, ops } = await run(sendLink(guardian.toLowerCase()));
    const emailId = output.emailId as string;
    expect(output).toEqual({
      queued: true,
      emailId,
      tenantId: guardian,
      kind: "identity_link",
      subject: "Confirm who you are",
      next: "the delivery job sends it within a minute: email:list --kind identity_link shows its state",
    });
    const row = raw(emailId);
    expect(row).toMatchObject({
      kind: "identity_link",
      subject_ref: guardian,
      idempotency_key: `identity_link:${sha16(guardian)}:2026-11-10`,
      to_address: ADDRESS,
      subject: "Confirm who you are",
      status: "pending",
    });
    // Never the full tenant id in the key.
    expect(row.idempotency_key).not.toContain(guardian.slice(2, 12));
    const email = identityLinkEmail({ link: LINK, publicAppUrl: APP_URL, postalAddress: POSTAL });
    expect(row.text).toBe(email.text);
    expect(row.html).toBe(email.html);

    expect(ops).toHaveLength(1);
    const { at: _at, ...line } = ops[0] as Record<string, unknown>;
    expect(line).toEqual({
      opslog: "identity_link_queued",
      emailId,
      tenant: guardian.slice(0, 10),
      operator: OPERATOR,
      operatorOsUser: osUser(),
    });
  });

  test("one link per guardian per UTC day: a second the same day queues nothing and names the first; the next day, or another guardian, queues a new one", async () => {
    at("2026-11-10T08:00:00Z");
    const first = (await run(sendLink(guardian))).output.emailId as string;

    at("2026-11-10T21:00:00Z");
    const dry = await run(sendLink(guardian, {}, false));
    expect(dry.output).toMatchObject({
      queued: false,
      alreadyQueued: { emailId: first, status: "pending" },
    });
    const again = await run(sendLink(guardian, { url: `${LINK}0` }));
    expect(again.ops).toEqual([]);
    expect(again.output).toEqual({
      queued: false,
      emailId: first,
      tenantId: guardian,
      status: "pending",
      next: "an identity link to this guardian was queued already today (UTC), and nothing was written: if it failed or was not delivered, run the same command with --again; otherwise a new link waits for tomorrow",
    });
    expect(count()).toBe(1);

    const other = await run(sendLink(second));
    expect(other.output.queued).toBe(true);
    at("2026-11-11T00:00:01Z");
    const tomorrow = await run(sendLink(guardian));
    expect(tomorrow.output.queued).toBe(true);
    expect(raw(tomorrow.output.emailId as string).idempotency_key).toBe(
      `identity_link:${sha16(guardian)}:2026-11-11`,
    );
    expect(count()).toBe(3);
  });

  test("--again queues a new link the same day when today's failed, then when the new one bounced: keyed identity_link:<16 hex>:<day>:2, then :3; its line names the row it replaces", async () => {
    at("2026-11-10T08:00:00Z");
    const base = `identity_link:${sha16(guardian)}:2026-11-10`;
    const first = (await run(sendLink(guardian))).output.emailId as string;
    await deliver(senderThat("refuses").sender);
    expect(raw(first).status).toBe("failed");

    const dry = await run(sendLink(guardian, { again: true }, false));
    expect(dry.ops).toEqual([]);
    expect(dry.output).toEqual({
      queued: false,
      tenantId: guardian,
      wouldQueue: {
        kind: "identity_link",
        subjectRef: guardian,
        idempotencyKey: `${base}:2`,
        subject: "Confirm who you are",
        link: LINK,
      },
      replaces: { emailId: first, status: "failed", deliveryState: null },
      next: "nothing was written: run the same command with --yes to queue it",
    });
    expect(count()).toBe(1);

    const second = await run(sendLink(guardian, { again: true, to: NEW_ADDRESS }));
    const secondId = second.output.emailId as string;
    expect(second.output).toEqual({
      queued: true,
      emailId: secondId,
      tenantId: guardian,
      kind: "identity_link",
      subject: "Confirm who you are",
      replaces: first,
      next: "the delivery job sends it within a minute: email:list --kind identity_link shows its state",
    });
    expect(raw(secondId)).toMatchObject({
      idempotency_key: `${base}:2`,
      subject_ref: guardian,
      to_address: NEW_ADDRESS,
      status: "pending",
    });
    expect(raw(first).status).toBe("failed");
    const { at: _at, ...line } = second.ops[0] as Record<string, unknown>;
    expect(second.ops).toHaveLength(1);
    expect(line).toEqual({
      opslog: "identity_link_queued",
      emailId: secondId,
      tenant: guardian.slice(0, 10),
      operator: OPERATOR,
      operatorOsUser: osUser(),
      replaces: first,
    });

    // The new one is sent, then bounces: --again once more.
    const accepting = senderThat("accepts");
    await deliver(accepting.sender);
    expect(accepting.sent.map((e) => e.idempotencyKey)).toEqual([`${base}:2`]);
    outbox.recordDeliveryEvent("re_msg_1", "bounced", Date.now());
    const third = await run(sendLink(guardian, { again: true }));
    expect(third.output).toMatchObject({ queued: true, replaces: secondId });
    expect(raw(third.output.emailId as string).idempotency_key).toBe(`${base}:3`);

    // Without --again the dedupe is as before: it names the day's first row and writes nothing.
    const plain = await run(sendLink(guardian));
    expect(plain.output).toMatchObject({ queued: false, emailId: first, status: "failed" });
    expect(count()).toBe(3);
  });

  test("--again is allowed after each undelivered outcome: bounced, complained, failed, suppressed", async () => {
    const outcomes = ["bounced", "complained", "failed", "suppressed"] as const;
    // One sender for the whole test: each email gets its own provider id.
    const accepting = senderThat("accepts");
    for (const [i, state] of outcomes.entries()) {
      at(`2026-11-1${i}T08:00:00Z`);
      const first = (await run(sendLink(guardian))).output.emailId as string;
      await deliver(accepting.sender);
      const providerMessageId = raw(first).provider_message_id as string;
      outbox.recordDeliveryEvent(providerMessageId, state, Date.now());
      const again = await run(sendLink(guardian, { again: true }));
      expect(again.output, state).toMatchObject({ queued: true, replaces: first });
      expect(raw(again.output.emailId as string).idempotency_key, state).toBe(
        `identity_link:${sha16(guardian)}:2026-11-1${i}:2`,
      );
    }
  });

  test("--again is refused on a day with no link yet, and while today's is pending, sent with no outcome, delayed or delivered; with --yes or without, nothing is written", async () => {
    at("2026-11-10T08:00:00Z");
    for (const yes of [true, false])
      expect(await refusal(sendLink(guardian, { again: true }, yes))).toBe(
        "refusing: no identity link to this guardian was queued today (UTC): run the command without --again",
      );
    const first = (await run(sendLink(guardian))).output.emailId as string;
    const refused = (what: string) =>
      `refusing: today's identity link to this guardian (${first}) is ${what}: --again queues a new one only when it failed, or was sent and bounced, complained, failed or was suppressed`;
    const expectRefused = async (what: string) => {
      for (const yes of [true, false])
        expect(await refusal(sendLink(guardian, { again: true }, yes)), what).toBe(refused(what));
    };

    await expectRefused("pending");
    await deliver(senderThat("accepts").sender);
    await expectRefused("sent, with no delivery outcome yet");
    outbox.recordDeliveryEvent("re_msg_1", "delayed", Date.now() - 2000);
    await expectRefused("sent and delayed");
    outbox.recordDeliveryEvent("re_msg_1", "delivered", Date.now() - 1000);
    await expectRefused("sent and delivered");
    expect(count()).toBe(1);
  });

  test("the delivery job sends it to the address given, under its key", async () => {
    at("2026-11-10T08:00:00Z");
    const emailId = (await run(sendLink(guardian))).output.emailId as string;
    const accepting = senderThat("accepts");
    await deliver(accepting.sender);
    expect(accepting.sent).toHaveLength(1);
    expect(accepting.sent[0]).toMatchObject({
      to: ADDRESS,
      subject: "Confirm who you are",
      idempotencyKey: `identity_link:${sha16(guardian)}:2026-11-10`,
    });
    expect(accepting.sent[0]?.text).toContain(LINK);
    expect(raw(emailId)).toMatchObject({ status: "sent", to_address: null, text: null });
  });

  test("--url must be an https link that carries no address: prefilled_email and the address itself are refused, and the link is never echoed", async () => {
    const https = "refusing: --url must be the full https link of the identity check";
    for (const bad of ["not a link", "http://verify.example.com/start", "verify.example.com/x"])
      expect(await refusal(sendLink(guardian, { url: bad })), bad).toBe(https);
    for (const bad of [
      `${LINK}&prefilled_email=${encodeURIComponent(ADDRESS)}`,
      `${LINK}&prefilled_email=`,
      `${LINK}&Prefilled_Email=someone`,
      `${LINK}&PREFILLED_EMAIL=someone`,
      `${LINK}&prefilled%5Femail=someone`,
    ])
      expect(await refusal(sendLink(guardian, { url: bad })), bad).toBe(NO_ADDRESS_IN_LINK);
    for (const bad of [
      `${LINK}&email=${encodeURIComponent(ADDRESS)}`,
      `${LINK}&email=${ADDRESS.toUpperCase()}`,
      `https://verify.example.com/start/${ADDRESS}`,
      // A stray % stops the whole link from decoding: each query value is decoded on its own.
      `${LINK}&note=100%&email=${encodeURIComponent(ADDRESS)}`,
    ])
      expect(await refusal(sendLink(guardian, { url: bad })), "address in the link").toBe(
        "refusing: the link must not carry the person's email address",
      );
    const accountId = "refusing: the link must not carry the account id (use the opaque reference)";
    for (const bad of [
      `${LINK}&ref=${guardian}`,
      `${LINK}&ref=${guardian.toLowerCase()}`,
      `${LINK}&ref=${guardian.slice(2).toUpperCase()}`,
      `https://verify.example.com/start/${guardian.toLowerCase()}`,
    ])
      expect(await refusal(sendLink(guardian, { url: bad })), "tenant in the link").toBe(accountId);
    expect(
      await refusal(sendLink(guardian, { url: "https://someone:secret@verify.example.com/x" })),
    ).toBe("refusing: --url must not hold a user name or a password");
    expect(await refusal(sendLink(guardian, { url: `${LINK}${"a".repeat(2048)}` }))).toBe(
      "refusing: --url must be at most 2048 characters",
    );
    expect(count()).toBe(0);
  });

  test("refuses a tenant that is not a wallet address, a --to that is not one address, and the operator rule", async () => {
    expect(await refusal(sendLink("guardian-one"))).toBe(
      "refusing: <tenantId> must be a wallet address",
    );
    expect(await refusal(sendLink(guardian, { to: "guardian.one" }))).toBe(
      "refusing: --to must be one email address",
    );
    expect(await refusal(sendLink(guardian, { operator: "x" }))).toBe(
      "refusing: --operator must match ^[a-z0-9._-]{2,40}$",
    );
    expect(await refusal(sendLink(guardian, { operator: "system" }))).toBe(RESERVED_SYSTEM);
    expect(count()).toBe(0);
  });

  test("the help says what the link is and that the address is never printed; no expiry promised", () => {
    const program = buildCli(noChain);
    const command = program.commands.find((c) => c.name() === "email:send-link");
    const help = (flag: string) => command?.options.find((o) => o.long === flag)?.description;
    expect(help("--url")).toContain("without prefilled_email");
    expect(help("--to")).toContain("never printed");
    expect(help("--again")).toContain("failed or was not delivered");
    expect(JSON.stringify(command?.options.map((o) => [o.flags, o.description]))).not.toMatch(
      /one-time|expire|hours/i,
    );
  });
});

// ── the address read at a prompt, never on the command line ─────────────────────────────────

describe("--to-prompt", () => {
  test("email:send-link reads the address from standard input; no output or line holds it", async () => {
    at("2026-11-10T08:00:00Z");
    piped(`  ${ADDRESS}\n`);
    const { output, ops } = await run(prompted(sendLink(guardian)));
    expect(output.queued).toBe(true);
    expect(ops.map((o) => o.opslog)).toEqual(["identity_link_queued"]);
    expect(raw(output.emailId as string).to_address).toBe(ADDRESS);
  });

  test("email:send-link checks the link against the address read at the prompt", async () => {
    piped(`${ADDRESS}\n`);
    expect(await refusal(prompted(sendLink(guardian, { url: `${LINK}&email=${ADDRESS}` })))).toBe(
      "refusing: the link must not carry the person's email address",
    );
    expect(count()).toBe(0);
  });

  test("email:resend reads the address from standard input", async () => {
    const emailId = await failedInvite();
    piped(`${NEW_ADDRESS}\r\n`);
    const { output } = await run(prompted(resend(emailId)));
    expect(output.requeued).toBe(true);
    expect(raw(emailId)).toMatchObject({ status: "pending", to_address: NEW_ADDRESS });
  });

  test("an empty input, or a line that is not one address, is refused, and the address is not echoed", async () => {
    const emailId = await failedInvite();
    piped("");
    expect(await refusal(prompted(resend(emailId)))).toBe(
      "refusing: --to-prompt needs the address, on one line",
    );
    for (const bad of ["\n", "not-an-address\n", `${NEW_ADDRESS} ${ADDRESS}\n`]) {
      piped(bad);
      expect(await refusal(prompted(resend(emailId))), JSON.stringify(bad)).toBe(
        "refusing: --to-prompt must be given one email address",
      );
    }
    expect(raw(emailId)).toMatchObject({ status: "failed", to_address: ADDRESS });
  });

  test("it cannot be combined with --to, and one of the two is required; standard input is not read", async () => {
    const emailId = await failedInvite();
    const stdin = stdinUntouched();
    const both =
      "refusing: --to-prompt cannot be combined with --to: the address is read at the prompt";
    expect(await refusal([...sendLink(guardian), "--to-prompt"])).toBe(both);
    expect(await refusal([...resend(emailId), "--to-prompt"])).toBe(both);
    const neither = "refusing: the address is required: --to-prompt (or --to)";
    const without = (line: string[]) => {
      const at = line.indexOf("--to");
      return [...line.slice(0, at), ...line.slice(at + 2)];
    };
    expect(await refusal(without(sendLink(guardian)))).toBe(neither);
    expect(await refusal(without(resend(emailId)))).toBe(neither);
    expect(stdin).not.toHaveBeenCalled();
    expect(count()).toBe(1);
  });

  test("at a terminal: one prompt on the screen, the answer read; the end of input is refused", async () => {
    const keys = Object.assign(new PassThrough(), { isTTY: true as const });
    const screen = Object.assign(new PassThrough(), { isTTY: true });
    let shown = "";
    screen.on("data", (chunk: Buffer) => {
      shown += chunk.toString();
    });
    const answer = readAddress(keys, screen);
    await vi.waitFor(() => expect(shown).toContain("Email address: "));
    keys.write(`${ADDRESS}\n`);
    expect(await answer).toBe(ADDRESS);

    const closed = Object.assign(new PassThrough(), { isTTY: true as const });
    const pending = readAddress(closed, Object.assign(new PassThrough(), { isTTY: true }));
    closed.end();
    await expect(pending).rejects.toThrow("refusing: the address was not entered");
  });

  test("at a terminal with standard error redirected, the typed address is not echoed into it", async () => {
    const keys = Object.assign(new PassThrough(), { isTTY: true as const });
    const file = new PassThrough();
    let written = "";
    file.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    const answer = readAddress(keys, file);
    await vi.waitFor(() => expect(written).toContain("Email address: "));
    keys.write(`${ADDRESS}\n`);
    expect(await answer).toBe(ADDRESS);
    expect(written).not.toContain(ADDRESS);
  });

  test("the help offers the prompt for the address", () => {
    const program = buildCli(noChain);
    for (const name of ["email:send-link", "email:resend"]) {
      const options = program.commands.find((c) => c.name() === name)?.options ?? [];
      const toPrompt = options.find((o) => o.long === "--to-prompt");
      expect(toPrompt?.description, name).toContain("never on the command line");
      // Neither is a required option: one of the two is, which the command checks itself.
      expect(options.find((o) => o.long === "--to")?.mandatory, name).toBe(false);
    }
  });
});

// ── every command, then the job: no line holds an address ───────────────────────────────────

test("no line any email command writes, nor the console sender's delivery of it, holds an address", async () => {
  at("2026-11-10T08:00:00Z");
  await run(sendLink(guardian));
  const failed = await failedInvite(1);
  await run(resend(failed));
  await run(["email:list"]);
  await run(["scheduler:run", "email_deliver", "--yes"]);
  expect(outbox.list({ status: "pending" })).toEqual([]);
  expect(printed.filter((line) => ANY_ADDRESS.test(line))).toEqual([]);
});

// ── the identity-link email ──────────────────────────────────────────────────────────────────

describe("the identity-link email", () => {
  const email = identityLinkEmail({ link: LINK, publicAppUrl: APP_URL, postalAddress: POSTAL });

  test("its subject names no one: Confirm who you are", () => {
    expect(IDENTITY_LINK_SUBJECT).toBe("Confirm who you are");
    expect(email.subject).toBe("Confirm who you are");
  });

  test("the text: one opening line, the three plain-words lines, the link and how to copy it, the request for the legal name and not the document, the privacy link and the postal address", () => {
    expect(email.text).toBe(
      [
        "We verify the identity of the person in control once, through the identity check below.",
        "",
        "What is checked: a government document and a live photo, matched.",
        "What we keep: the result, the date, the country and type of the document, and your name, encrypted.",
        "What we never keep: the document itself, the photo, your date of birth or document number.",
        "",
        "Start your identity check:",
        LINK,
        "If the link does not open, copy this link into your browser.",
        "",
        "Please also reply with your legal name exactly as printed on the document you will use.",
        "Please do not attach your document or a photo of it: we only need your name as it is printed.",
        "",
        `How we handle your data: ${APP_URL}/privacy`,
        "",
        POSTAL,
        "",
      ].join("\n"),
    );
  });

  test("the HTML says the same, its link and the privacy link as links", () => {
    for (const phrase of [
      "We verify the identity of the person in control once, through the identity check below.",
      "a government document and a live photo, matched.",
      "the result, the date, the country and type of the document, and your name, encrypted.",
      "the document itself, the photo, your date of birth or document number.",
      "reply with your legal name exactly as printed on the document you will use.",
      "Please do not attach your document or a photo of it: we only need your name as it is printed.",
      "If the link does not open, copy this link into your browser.",
    ])
      expect(email.html).toContain(phrase);
    expect(email.html).toContain(`<a href="${escapeHtml(LINK)}">${escapeHtml(LINK)}</a>`);
    expect(email.html).toContain(`<a href="${APP_URL}/privacy">`);
    expect(email.html).toContain(POSTAL);
    expect(email.html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  test("names no provider and promises no expiry, in the subject, the text or the HTML", () => {
    for (const part of [email.subject, email.text, email.html])
      expect(part).not.toMatch(/stripe|persona|sumsub|resend|kyc|expir|hours|one-time/i);
  });

  test("the HTML escapes everything it interpolates", () => {
    const hostile = identityLinkEmail({
      link: 'https://verify.example.com/x?a=1&b="><script>alert(1)</script>',
      publicAppUrl: "https://www.example.com",
      postalAddress: "1 <b>Example</b> Street & Sons, 'Dover'",
    });
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).not.toContain("<b>Example</b>");
    expect(hostile.html).toContain("a=1&amp;b=&quot;&gt;&lt;script&gt;");
    expect(hostile.html).toContain(
      "1 &lt;b&gt;Example&lt;/b&gt; Street &amp; Sons, &#39;Dover&#39;",
    );
    // The text version is plain text: as given.
    expect(hostile.text).toContain("1 <b>Example</b> Street & Sons, 'Dover'");
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("the key: identity_link, the first 16 hex characters of sha256(tenant), the UTC day", () => {
    const tenant = getAddress(guardian);
    expect(identityLinkIdempotencyKey(tenant, Date.UTC(2026, 10, 10, 23, 59, 59))).toBe(
      `identity_link:${sha16(tenant)}:2026-11-10`,
    );
    expect(identityLinkIdempotencyKey(tenant, Date.UTC(2026, 10, 10) + DAY)).toBe(
      `identity_link:${sha16(tenant)}:2026-11-11`,
    );
  });
});
