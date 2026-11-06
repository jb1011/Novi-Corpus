import type { Readable, Writable } from "node:stream";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { type Config, PLAIN_ADDRESS } from "../config/env";
import {
  type EmailDeps,
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  type OutboxFilter,
  type OutboxRow,
  WARN_DELIVERY_STATES,
  buildEmailDeps,
  contactIdempotencyKey,
} from "../email/outbox";
import {
  IDENTITY_LINK_SUBJECT,
  identityLinkEmail,
  identityLinkIdempotencyKey,
} from "../email/templates/identityLink";
import { opsLog } from "../observability/opsLog";
import {
  OPERATOR_NAME,
  OTHER_CHARACTER,
  oneOf,
  operatorConfig,
  osUser,
  parseOperator,
  parseTenant,
  print,
  refuse,
  withDatabase,
} from "./operator";
import { readAnswers } from "./prompt";

/**
 * THE OPERATOR'S EMAIL COMMANDS, over the outbox (src/email/outbox.ts), from the box:
 *  - `email:list` prints the outbox's rows: ids, kinds, states, delivery states and the last
 *    error, at most `--limit` (100 by default, 1000 at most) of the newest. Never an address, a
 *    body or an idempotency key (a contact write's key is a digest of its address). It writes
 *    nothing and no ops line;
 *  - `email:resend <emailId>` puts a FAILED row back to pending, due now, under the address the
 *    operator re-reads from the row the email is about (the waitlist entry, the company's party).
 *    It goes under the row's own idempotency key, so the provider never sends it twice; a contact
 *    write goes only to the address it was written for, whose consent it records;
 *  - `email:send-link <tenantId>` queues the beta's identity-link email to a guardian
 *    (src/email/templates/identityLink.ts): the link the operator built, which must be https and
 *    carry neither an address (`prefilled_email` is refused: an address would sit in the body and
 *    in the provider's URL logs) nor the account id (the link carries an opaque reference), and
 *    the request for the guardian's legal name. One per guardian per UTC day: a second the same
 *    day writes nothing and names the first. With `--again`, a new one the same day under the
 *    key's next number, only when the day's latest failed or was sent and not delivered (bounced,
 *    complained, failed, suppressed).
 *
 * Every command refuses where the email system is not configured (`cfg.email`, which
 * PUBLIC_APP_URL turns on). The two writing commands take `--operator` (the operator rule of
 * `cli/operator.ts`; `system` reserved), print what they would do and write nothing without
 * `--yes`, read and write in one immediate transaction, print ONE JSON object, and throw a refusal
 * as `refusing: ...`. They are the only commands that take an address, and never print it back:
 * not in their output, not in a refusal, not in their ops line (`email_requeued`,
 * `identity_link_queued`), which carries ids, the tenant's first ten characters, the operator and
 * the OS user running the command (`operatorOsUser`: the outbox row has no column for them). The
 * address is read at a prompt with `--to-prompt` (prompt.ts: never on the command line, so never
 * in the shell history), or given with `--to`; one of the two, never both. A configuration without
 * the email system is refused before anything is read at the prompt. The delivery job sends what
 * they queue, within a minute.
 *
 * The runbook: docs/runbooks/email.md.
 */

/** The product's own emails are queued by no operator: no operator may type the name. */
const RESERVED_OPERATOR = { name: "system", purpose: "the emails the product sends by itself" };
/** An outbox email id: `em_` and a UUID, as the outbox writes it. */
const EMAIL_ID = /^em_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The longest address SMTP carries. */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LINK_LENGTH = 2048;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** An ISO-8601 time with its zone, so its reading never depends on the box's own zone. */
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const NOT_HTTPS = "--url must be the full https link of the identity check";
/** The provider keeps a key 24 hours, and the outbox cannot tell whether a failed email's send was
 *  one the provider took (an answer lost, then refusals): the runbook's wording, word for word. */
const SAME_KEY_NOTE =
  "the email goes again under its own idempotency key, which the provider keeps 24 hours. A failed email may still be one whose send the provider took: then, to another address within 24 hours of that send, the provider refuses it (409 invalid_idempotent_request) and nothing is sent twice. The fix: for an identity link, email:send-link --again, under a new key, at once; for any other email, the same email:resend after 24 hours (docs/runbooks/email.md)";
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const WHOLE_NUMBER = /^[1-9][0-9]{0,3}$/;
/** The one prompt `--to-prompt` shows at a terminal. */
const ADDRESS_QUESTION = "Email address: ";
const QUEUED_NEXT = "the delivery job sends it within a minute";
const TO_HELP = "never printed back, and in no line";
const TO_PROMPT_HELP =
  "type the address at a prompt (or pipe it in, on one line) instead of --to: never on the command line, so never in the shell history";

// ── parsing ──────────────────────────────────────────────────────────────────────────────────

const NOT_CONFIGURED = "email is not configured on this deployment (PUBLIC_APP_URL)";

/** The email system of this deployment, or a refusal where it is not configured. */
function requireEmail(db: Database.Database, cfg: Config): EmailDeps {
  const email = buildEmailDeps(db, cfg);
  if (email === undefined) refuse(NOT_CONFIGURED);
  return email;
}

/** The configuration of a command that may prompt, held to the email system before anything is
 *  read at the prompt: the operator types no address for a command that would refuse anyway. */
function emailConfig(): Config {
  const cfg = operatorConfig();
  if (cfg.email === undefined) refuse(NOT_CONFIGURED);
  return cfg;
}

/** One plain address, trimmed. A refusal never echoes it. `source` names where it came from. */
function parseAddress(value: string, source: "--to" | "--to-prompt"): string {
  const address = value.trim();
  if (
    address.length > MAX_ADDRESS_LENGTH ||
    OTHER_CHARACTER.test(address) ||
    !PLAIN_ADDRESS.test(address)
  )
    refuse(
      source === "--to"
        ? "--to must be one email address"
        : "--to-prompt must be given one email address",
    );
  return address;
}

/** The two ways a writing command takes the address. */
export interface AddressOptions {
  to?: string;
  toPrompt?: boolean;
}

/**
 * The address `--to-prompt` reads: at a terminal, one prompt on `output` (standard error); from a
 * pipe, the first line. Refused when nothing is entered.
 */
export async function readAddress(
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean },
): Promise<string> {
  const [address] = await readAnswers(
    input,
    output,
    [ADDRESS_QUESTION],
    "the address was not entered",
  );
  if (address === undefined) refuse("--to-prompt needs the address, on one line");
  return address;
}

/**
 * The options with the address resolved: read (`read`) with `--to-prompt`, which is never
 * combined with `--to`; else `--to`. One of the two is required. The flags are checked before
 * anything is read.
 */
export async function withPromptedAddress<T extends AddressOptions>(
  opts: T,
  read: () => Promise<string>,
): Promise<Omit<T, "toPrompt" | "to"> & { to: string; toSource: "--to" | "--to-prompt" }> {
  const { toPrompt, to, ...rest } = opts;
  if (toPrompt === true && to !== undefined)
    refuse("--to-prompt cannot be combined with --to: the address is read at the prompt");
  if (toPrompt === true) return { ...rest, to: await read(), toSource: "--to-prompt" };
  if (to === undefined) refuse("the address is required: --to-prompt (or --to)");
  return { ...rest, to, toSource: "--to" };
}

/** Not echoed when malformed: an address typed in its place would be printed. */
function parseEmailId(value: string): string {
  if (!EMAIL_ID.test(value))
    refuse("<emailId> must be an email id as email:list prints it (em_ and a UUID)");
  return value;
}

/** `value` with its percent-escapes decoded, or as it is where they do not decode. */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The identity check's link, as the operator built it, normalised (`URL.href`): https, no user
 * name or password, at most 2048 characters, no address (neither a `prefilled_email` parameter,
 * its name in any case or escaped, nor the guardian's own address anywhere in it) and not the
 * guardian's account id (with or without its 0x, in any case): the link carries an opaque
 * reference, since the provider must not hold the tenant. Each part is compared decoded: the whole
 * link, and each path segment, query name and query value on its own, so one stray `%` that stops
 * the whole link from decoding hides nothing. Never echoed: it may hold what it is refused for.
 */
function parseLink(value: string, address: string, tenantId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse(NOT_HTTPS);
  }
  if (url.protocol !== "https:") refuse(NOT_HTTPS);
  if (url.username !== "" || url.password !== "")
    refuse("--url must not hold a user name or a password");
  const link = url.href;
  if (link.length > MAX_LINK_LENGTH) refuse(`--url must be at most ${MAX_LINK_LENGTH} characters`);
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "prefilled_email"))
    refuse("the link must not carry the person's email address (remove prefilled_email)");
  const forms = [
    value,
    link,
    url.hash,
    ...url.pathname.split("/"),
    // URLSearchParams decodes each name and value itself, a stray `%` left as it is.
    ...[...url.searchParams].flat(),
  ].map((form) => decoded(form).toLowerCase());
  const holds = (needle: string) => forms.some((form) => form.includes(needle.toLowerCase()));
  if (holds(address)) refuse("the link must not carry the person's email address");
  // The 40 hex characters, so the id is found with its 0x or without it.
  if (holds(tenantId.slice(2)))
    refuse("the link must not carry the account id (use the opaque reference)");
  return link;
}

/** 1 to 1000, as a whole number written in digits. */
function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  const limit = WHOLE_NUMBER.test(value) ? Number(value) : Number.NaN;
  if (!(limit >= 1 && limit <= MAX_LIST_LIMIT))
    refuse(`--limit must be a whole number from 1 to ${MAX_LIST_LIMIT}`);
  return limit;
}

/** A UTC date (from its midnight) or an ISO-8601 time with its zone, on a real calendar date. */
function parseSince(value: string): number {
  const parts = DATE_ONLY.exec(value) ?? INSTANT.exec(value);
  const ms =
    parts === null ? Number.NaN : Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  const [year, month, day] = (parts ?? []).slice(1, 4).map(Number) as [number, number, number];
  // Date.parse rolls 30 February over into March; a date that does not round-trip is a typo.
  const calendar = parts !== null && new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (!Number.isFinite(ms) || !calendar)
    refuse(
      "--since must be a date (2026-11-10) or an ISO-8601 time with its zone (2026-11-10T08:00:00Z), on a real calendar date",
    );
  return ms;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** A row as `email:list` prints it: never the address, the content or the key. */
function listed(row: OutboxRow): Record<string, unknown> {
  return {
    emailId: row.emailId,
    kind: row.kind,
    subjectRef: row.subjectRef,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: iso(row.nextAttemptAt),
    providerMessageId: row.providerMessageId,
    deliveryState: row.deliveryState,
    deliveryAt: iso(row.deliveryAt),
    lastError: row.lastError,
    createdAt: iso(row.createdAt),
    sentAt: iso(row.sentAt),
  };
}

// ── email:list ───────────────────────────────────────────────────────────────────────────────

export interface ListOptions {
  status?: string;
  kind?: string;
  since?: string;
  limit?: string;
}

/**
 * The outbox's rows, filtered: the newest `--limit` of them (100 by default), printed the oldest
 * first, so a long history never hides today's failures; `more: true` when older ones were left
 * out. Writes nothing and no ops line.
 */
export function listEmails(
  db: Database.Database,
  cfg: Config,
  opts: ListOptions,
): Record<string, unknown> {
  const email = requireEmail(db, cfg);
  const filter: OutboxFilter = {
    ...(opts.status === undefined
      ? {}
      : { status: oneOf("--status", opts.status, OUTBOX_STATUSES) }),
    ...(opts.kind === undefined ? {} : { kind: oneOf("--kind", opts.kind, OUTBOX_KINDS) }),
    ...(opts.since === undefined ? {} : { sinceMs: parseSince(opts.since) }),
  };
  const limit = parseLimit(opts.limit);
  // One more than asked: whether older rows were left out.
  const rows = email.outbox.list({ ...filter, limit: limit + 1 });
  const shown = rows.length > limit ? rows.slice(1) : rows;
  return {
    count: shown.length,
    emails: shown.map(listed),
    ...(rows.length > limit
      ? {
          more: true,
          next: `older emails are left out: narrow the list with --status, --kind or --since, or raise --limit (at most ${MAX_LIST_LIMIT})`,
        }
      : {}),
  };
}

// ── email:resend ─────────────────────────────────────────────────────────────────────────────

export interface ResendOptions {
  /** Resolved: given with `--to`, or read at `--to-prompt` (`toSource` says which). */
  to: string;
  toSource?: "--to" | "--to-prompt";
  operator: string;
  yes?: boolean;
}

/**
 * A failed email back to pending, due now, its attempts counted from zero, under the address
 * given. Refused for any row that is not failed: a sent email is never sent again from here, and
 * a pending one is on its way. A contact write is refused under any address but its own: its key
 * is that address's digest, and the consent it records is that address's.
 */
export function resendEmail(
  db: Database.Database,
  cfg: Config,
  emailIdArg: string,
  opts: ResendOptions,
): Record<string, unknown> {
  const email = requireEmail(db, cfg);
  const emailId = parseEmailId(emailIdArg);
  const to = parseAddress(opts.to, opts.toSource ?? "--to");
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();

  const found = db
    .transaction(() => {
      const row = email.outbox.find(emailId);
      if (row === undefined) refuse(`no email has the id ${emailId}`);
      if (row.status === "sent")
        refuse(
          `email ${emailId} is sent: only a failed email is re-queued (a sent email that did not arrive is followed up as the email runbook says)`,
        );
      if (row.status !== "failed")
        refuse(`email ${emailId} is ${row.status}: only a failed email is re-queued`);
      if (row.kind === "contact_upsert" && contactIdempotencyKey(to) !== row.idempotencyKey)
        refuse(
          "a contact write is re-queued only under the address it was written for: the consent is that address's",
        );
      if (opts.yes !== true) return { row, requeued: false };
      // The row was read failed in this immediate transaction: nothing can have moved it since.
      if (!email.outbox.requeue(emailId, to))
        throw new Error(`email outbox: ${emailId} was read failed and could not be re-queued`);
      return { row, requeued: true };
    })
    .immediate();

  const { row } = found;
  const about = { emailId, kind: row.kind, subjectRef: row.subjectRef };
  // A contact write carries no idempotency key to the provider: the note is about emails.
  const note = row.kind === "contact_upsert" ? {} : { note: SAME_KEY_NOTE };
  if (!found.requeued)
    return {
      requeued: false,
      ...about,
      status: row.status,
      attempts: row.attempts,
      lastError: row.lastError,
      ...note,
      next: "nothing was written: run the same command with --yes to re-queue it",
    };
  opsLog("email_requeued", { emailId, operator, operatorOsUser });
  return {
    requeued: true,
    ...about,
    status: "pending",
    ...note,
    next: `${QUEUED_NEXT}: email:list --status failed shows it again if it fails`,
  };
}

// ── email:send-link ──────────────────────────────────────────────────────────────────────────

export interface SendLinkOptions {
  url: string;
  /** Resolved: given with `--to`, or read at `--to-prompt` (`toSource` says which). */
  to: string;
  toSource?: "--to" | "--to-prompt";
  operator: string;
  /** A new link the same day, when the day's latest failed or was not delivered. */
  again?: boolean;
  yes?: boolean;
}

/** The day's latest identity link, as `--again` reads it. */
function describeLatest(row: OutboxRow): string {
  if (row.status !== "sent") return row.status;
  return row.deliveryState === null
    ? "sent, with no delivery outcome yet"
    : `sent and ${row.deliveryState}`;
}

/**
 * The day's latest identity link to a tenant and its number (`identityLinkIdempotencyKey`'s
 * `n`), or undefined when none was queued that day. Read in the caller's transaction.
 */
function latestLinkToday(
  email: EmailDeps,
  tenantId: string,
  nowMs: number,
): { row: OutboxRow; n: number } | undefined {
  const first = email.outbox.findByKey(identityLinkIdempotencyKey(tenantId, nowMs));
  if (first === undefined) return undefined;
  let latest = { row: first, n: 1 };
  for (;;) {
    const next = email.outbox.findByKey(identityLinkIdempotencyKey(tenantId, nowMs, latest.n + 1));
    if (next === undefined) return latest;
    latest = { row: next, n: latest.n + 1 };
  }
}

/**
 * The beta's identity-link email to a guardian, queued: kind `identity_link`, the tenant
 * (checksummed) as its subject, the key `identityLinkIdempotencyKey` (one per guardian per UTC
 * day). A second link for the same guardian the same day writes nothing and names the first.
 *
 * With `--again`, a new link the same day, under the day's key and the next number (`:2`, `:3`,
 * ...), so the provider never answers it with an earlier send: only when the day's latest link
 * failed, or was sent and bounced, complained, failed or was suppressed. Refused on a day with
 * no link yet, and while the latest is pending, sent with no outcome, delayed or delivered.
 */
export function sendIdentityLink(
  db: Database.Database,
  cfg: Config,
  tenantArg: string,
  opts: SendLinkOptions,
): Record<string, unknown> {
  const email = requireEmail(db, cfg);
  const tenantId = parseTenant(tenantArg);
  const to = parseAddress(opts.to, opts.toSource ?? "--to");
  const link = parseLink(opts.url, to, tenantId);
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const operatorOsUser = osUser();
  const nowMs = Date.now();
  const content = identityLinkEmail({
    link,
    publicAppUrl: email.publicAppUrl,
    postalAddress: email.postalAddress,
  });

  const done = db
    .transaction(() => {
      let idempotencyKey = identityLinkIdempotencyKey(tenantId, nowMs);
      let replaces: OutboxRow | undefined;
      let existing: OutboxRow | undefined;
      if (opts.again === true) {
        const latest = latestLinkToday(email, tenantId, nowMs);
        if (latest === undefined)
          refuse(
            "no identity link to this guardian was queued today (UTC): run the command without --again",
          );
        const { row } = latest;
        const undelivered =
          row.status === "failed" ||
          (row.status === "sent" &&
            row.deliveryState !== null &&
            WARN_DELIVERY_STATES.has(row.deliveryState));
        if (!undelivered)
          refuse(
            `today's identity link to this guardian (${row.emailId}) is ${describeLatest(row)}: --again queues a new one only when it failed, or was sent and bounced, complained, failed or was suppressed`,
          );
        idempotencyKey = identityLinkIdempotencyKey(tenantId, nowMs, latest.n + 1);
        replaces = row;
      } else {
        existing = email.outbox.findByKey(idempotencyKey);
      }
      if (existing !== undefined || opts.yes !== true)
        return { idempotencyKey, replaces, existing, emailId: undefined };
      const { emailId, inserted } = email.outbox.enqueue({
        kind: "identity_link",
        subjectRef: tenantId,
        idempotencyKey,
        to,
        ...content,
      });
      // The key was read free in this immediate transaction: nothing can have taken it since.
      if (!inserted)
        throw new Error(`email outbox: ${idempotencyKey} was free and is taken by ${emailId}`);
      return { idempotencyKey, replaces, existing: undefined, emailId };
    })
    .immediate();

  const { existing, replaces, idempotencyKey } = done;
  if (opts.yes !== true)
    return {
      queued: false,
      tenantId,
      wouldQueue: {
        kind: "identity_link",
        subjectRef: tenantId,
        idempotencyKey,
        subject: content.subject,
        link,
      },
      ...(replaces === undefined
        ? {}
        : {
            replaces: {
              emailId: replaces.emailId,
              status: replaces.status,
              deliveryState: replaces.deliveryState,
            },
          }),
      ...(existing === undefined
        ? { next: "nothing was written: run the same command with --yes to queue it" }
        : {
            alreadyQueued: { emailId: existing.emailId, status: existing.status },
            next: "an identity link to this guardian was queued already today (UTC): with --yes this writes nothing",
          }),
    };
  if (existing !== undefined)
    return {
      queued: false,
      emailId: existing.emailId,
      tenantId,
      status: existing.status,
      next: "an identity link to this guardian was queued already today (UTC), and nothing was written: if it failed or was not delivered, run the same command with --again; otherwise a new link waits for tomorrow",
    };
  const emailId = done.emailId as string;
  opsLog("identity_link_queued", {
    emailId,
    tenant: tenantId.slice(0, 10),
    operator,
    operatorOsUser,
    ...(replaces === undefined ? {} : { replaces: replaces.emailId }),
  });
  return {
    queued: true,
    emailId,
    tenantId,
    kind: "identity_link",
    subject: IDENTITY_LINK_SUBJECT,
    ...(replaces === undefined ? {} : { replaces: replaces.emailId }),
    next: `${QUEUED_NEXT}: email:list --kind identity_link shows its state`,
  };
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

/** Standard input and standard error: the prompt is never on standard output, which carries the
 *  command's one JSON object. */
const promptForAddress = () => readAddress(process.stdin, process.stderr);

export function registerEmailCommands(program: Command): void {
  program
    .command("email:list")
    .description(
      "list the outbox's emails, the newest --limit of them printed oldest first: ids, kinds, states, delivery states and the last error; never an address or a body. Writes no ops line",
    )
    .option("--status <pending|sent|failed>", "only the emails in this state")
    .option("--kind <kind>", `only this kind: ${OUTBOX_KINDS.join(", ")}`)
    .option(
      "--since <date>",
      "only the emails queued from this UTC date (2026-11-10) or ISO-8601 time with its zone",
    )
    .option(
      "--limit <n>",
      `at most this many, the newest (default ${DEFAULT_LIST_LIMIT}, at most ${MAX_LIST_LIMIT})`,
    )
    .action((opts: ListOptions) =>
      withDatabase((db, _docStoreDir, cfg) => print(listEmails(db, cfg, opts))),
    );

  program
    .command("email:resend")
    .argument("<emailId>", "the failed email, as email:list prints it")
    .description(
      "re-queue a failed email, under its own idempotency key, to the address you re-read from the row it is about; the address with --to-prompt (or --to); without --yes, say what would happen",
    )
    .option("--to-prompt", TO_PROMPT_HELP)
    .option("--to <address>", `the address, re-read from the email's source; ${TO_HELP}`)
    .requiredOption("--operator <name>", `who re-queues: ${OPERATOR_NAME.source}`)
    .option("--yes", "confirm: re-queue the email")
    .action(async (emailId: string, opts: Omit<ResendOptions, "to"> & AddressOptions) => {
      // Refused before anything is read at the prompt.
      const loaded = emailConfig();
      const resolved = await withPromptedAddress(opts, promptForAddress);
      withDatabase(
        (db, _docStoreDir, cfg) => print(resendEmail(db, cfg, emailId, resolved)),
        loaded,
      );
    });

  program
    .command("email:send-link")
    .argument("<tenantId>", "the guardian's account: its wallet address")
    .description(
      "queue the identity-check email to a guardian: the link, and the request for their legal name exactly as printed on their document; the address with --to-prompt (or --to). One per guardian per UTC day (--again for a new one when the day's failed or was not delivered); without --yes, say what would be queued",
    )
    .requiredOption(
      "--url <link>",
      "the full https link of the identity check, with its opaque client_reference_id and without prefilled_email (the guardian types their address in the check) or the account id",
    )
    .option("--to-prompt", TO_PROMPT_HELP)
    .option("--to <address>", `the guardian's email address; ${TO_HELP}`)
    .requiredOption("--operator <name>", `who sends: ${OPERATOR_NAME.source}`)
    .option(
      "--again",
      "a new link the same day, under a new key, when today's failed or was not delivered (bounced, complained, failed, suppressed); refused while it is pending, on its way or delivered",
    )
    .option("--yes", "confirm: queue the email")
    .action(async (tenantId: string, opts: Omit<SendLinkOptions, "to"> & AddressOptions) => {
      // Refused before anything is read at the prompt.
      const loaded = emailConfig();
      const resolved = await withPromptedAddress(opts, promptForAddress);
      withDatabase(
        (db, _docStoreDir, cfg) => print(sendIdentityLink(db, cfg, tenantId, resolved)),
        loaded,
      );
    });
}
