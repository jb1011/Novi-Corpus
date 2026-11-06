import type Database from "better-sqlite3";
import type { Command } from "commander";
import { type Config, PLAIN_ADDRESS } from "../config/env";
import {
  type EmailDeps,
  OUTBOX_KINDS,
  OUTBOX_STATUSES,
  type OutboxFilter,
  type OutboxRow,
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
  parseOperator,
  parseTenant,
  print,
  refuse,
  withDatabase,
} from "./operator";

/**
 * THE OPERATOR'S EMAIL COMMANDS, over the outbox (src/email/outbox.ts), from the box:
 *  - `email:list` prints the outbox's rows: ids, kinds, states, delivery states and the last
 *    error. Never an address, a body or an idempotency key (a contact write's key is a digest of
 *    its address). It writes nothing and no ops line;
 *  - `email:resend <emailId>` puts a FAILED row back to pending, due now, under the address the
 *    operator re-reads from the row the email is about (the waitlist entry, the company's party).
 *    It goes under the row's own idempotency key, so the provider never sends it twice; a contact
 *    write goes only to the address it was written for, whose consent it records;
 *  - `email:send-link <tenantId>` queues the beta's identity-link email to a guardian
 *    (src/email/templates/identityLink.ts): the link the operator built, which must be https and
 *    carry no address (`prefilled_email` is refused: an address would sit in the body and in the
 *    provider's URL logs), and the request for the guardian's legal name. One per guardian per
 *    UTC day: a second the same day writes nothing and names the first.
 *
 * Every command refuses where the email system is not configured (`cfg.email`, which
 * PUBLIC_APP_URL turns on). The two writing commands take `--operator` (the operator rule of
 * `cli/operator.ts`; `system` reserved), print what they would do and write nothing without
 * `--yes`, read and write in one immediate transaction, print ONE JSON object, and throw a refusal
 * as `refusing: ...`. They are the only commands that take an address, and never print it back:
 * not in their output, not in a refusal, not in their ops line (`email_requeued`,
 * `identity_link_queued`), which carries ids, the tenant's first ten characters and the operator.
 * The delivery job sends what they queue, within a minute.
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
const SAME_KEY_NOTE =
  "the email goes again under its own idempotency key, which the provider keeps 24 hours: within 24 hours of a send the provider took, another address is refused (409 invalid_idempotent_request) and nothing is sent twice; then send a new email after 24 hours (docs/runbooks/email.md)";
const QUEUED_NEXT = "the delivery job sends it within a minute";
const TO_HELP = "never printed back, and in no line";

// ── parsing ──────────────────────────────────────────────────────────────────────────────────

/** The email system of this deployment, or a refusal where it is not configured. */
function requireEmail(db: Database.Database, cfg: Config): EmailDeps {
  const email = buildEmailDeps(db, cfg);
  if (email === undefined) refuse("email is not configured on this deployment (PUBLIC_APP_URL)");
  return email;
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value))
    refuse(`${flag} must be one of ${allowed.join(", ")}`);
  return value as T;
}

/** One plain address, trimmed. A refusal never echoes it. */
function parseAddress(value: string): string {
  const address = value.trim();
  if (
    address.length > MAX_ADDRESS_LENGTH ||
    OTHER_CHARACTER.test(address) ||
    !PLAIN_ADDRESS.test(address)
  )
    refuse("--to must be one email address");
  return address;
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
 * name or password, at most 2048 characters, and no address: neither a `prefilled_email`
 * parameter (in any case) nor the guardian's own address anywhere in it, escaped or not. Never
 * echoed: it may hold the address it is refused for.
 */
function parseLink(value: string, address: string): string {
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
  const needle = address.toLowerCase();
  if ([value, link].some((form) => decoded(form).toLowerCase().includes(needle)))
    refuse("the link must not carry the person's email address");
  return link;
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
}

/** The outbox's rows, the oldest first, filtered. Writes nothing and no ops line. */
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
  const rows = email.outbox.list(filter);
  return { count: rows.length, emails: rows.map(listed) };
}

// ── email:resend ─────────────────────────────────────────────────────────────────────────────

export interface ResendOptions {
  to: string;
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
  const to = parseAddress(opts.to);
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);

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
  opsLog("email_requeued", { emailId, operator });
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
  to: string;
  operator: string;
  yes?: boolean;
}

/**
 * The beta's identity-link email to a guardian, queued: kind `identity_link`, the tenant
 * (checksummed) as its subject, the key `identityLinkIdempotencyKey` (one per guardian per UTC
 * day). A second link for the same guardian the same day writes nothing and names the first.
 */
export function sendIdentityLink(
  db: Database.Database,
  cfg: Config,
  tenantArg: string,
  opts: SendLinkOptions,
): Record<string, unknown> {
  const email = requireEmail(db, cfg);
  const tenantId = parseTenant(tenantArg);
  const to = parseAddress(opts.to);
  const link = parseLink(opts.url, to);
  const operator = parseOperator(opts.operator, RESERVED_OPERATOR);
  const idempotencyKey = identityLinkIdempotencyKey(tenantId, Date.now());
  const content = identityLinkEmail({
    link,
    publicAppUrl: email.publicAppUrl,
    postalAddress: email.postalAddress,
  });

  const done = db
    .transaction(() => {
      const existing = email.outbox.findByKey(idempotencyKey);
      if (existing !== undefined || opts.yes !== true) return { existing, emailId: undefined };
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
      return { existing: undefined, emailId };
    })
    .immediate();

  const { existing } = done;
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
      next: "an identity link to this guardian was queued already today (UTC), and nothing was written: email:resend re-queues it if it failed; a new link waits for tomorrow",
    };
  const emailId = done.emailId as string;
  opsLog("identity_link_queued", { emailId, tenant: tenantId.slice(0, 10), operator });
  return {
    queued: true,
    emailId,
    tenantId,
    kind: "identity_link",
    subject: IDENTITY_LINK_SUBJECT,
    next: `${QUEUED_NEXT}: email:list --kind identity_link shows its state`,
  };
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

export function registerEmailCommands(program: Command): void {
  program
    .command("email:list")
    .description(
      "list the outbox's emails, the oldest first: ids, kinds, states, delivery states and the last error; never an address or a body. Writes no ops line",
    )
    .option("--status <pending|sent|failed>", "only the emails in this state")
    .option("--kind <kind>", `only this kind: ${OUTBOX_KINDS.join(", ")}`)
    .option(
      "--since <date>",
      "only the emails queued from this UTC date (2026-11-10) or ISO-8601 time with its zone",
    )
    .action((opts: ListOptions) =>
      withDatabase((db, _docStoreDir, cfg) => print(listEmails(db, cfg, opts))),
    );

  program
    .command("email:resend")
    .argument("<emailId>", "the failed email, as email:list prints it")
    .description(
      "re-queue a failed email, under its own idempotency key, to the address you re-read from the row it is about; without --yes, say what would happen",
    )
    .requiredOption("--to <address>", `the address, re-read from the email's source; ${TO_HELP}`)
    .requiredOption("--operator <name>", `who re-queues: ${OPERATOR_NAME.source}`)
    .option("--yes", "confirm: re-queue the email")
    .action((emailId: string, opts: ResendOptions) =>
      withDatabase((db, _docStoreDir, cfg) => print(resendEmail(db, cfg, emailId, opts))),
    );

  program
    .command("email:send-link")
    .argument("<tenantId>", "the guardian's account: its wallet address")
    .description(
      "queue the identity-check email to a guardian: the link, and the request for their legal name exactly as printed on their document. One per guardian per UTC day; without --yes, say what would be queued",
    )
    .requiredOption(
      "--url <link>",
      "the full https link of the identity check, with its opaque client_reference_id and without prefilled_email (the guardian types their address in the check)",
    )
    .requiredOption("--to <address>", `the guardian's email address; ${TO_HELP}`)
    .requiredOption("--operator <name>", `who sends: ${OPERATOR_NAME.source}`)
    .option("--yes", "confirm: queue the email")
    .action((tenantId: string, opts: SendLinkOptions) =>
      withDatabase((db, _docStoreDir, cfg) => print(sendIdentityLink(db, cfg, tenantId, opts))),
    );
}
