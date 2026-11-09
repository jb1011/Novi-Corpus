import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { Command } from "commander";
import { getAddress, isAddress } from "viem";
import { ACCEPTED_CREDENTIALS } from "../adapters/worldid/guardianGate";
import { type Config, legalBodyEnvironment } from "../config/env";
import { CUSTOMER_PROVIDER } from "../legalBody/provider";
import { STATEMENT_READS_SINCE_KEY } from "../persistence/statementReadRepository";
import type { FormationPin } from "../types";
import { operatorConfig, print, refuse } from "./operator";

/**
 * `funnel:export`: THE FORMED DOOR'S FUNNEL (design §6.14), per ISO week, each stage labelled by
 * the source it counts. A READ-ONLY operator command: no --yes, no --operator, no ops line, and the
 * database the configuration names is opened read-only and must exist, so the command can neither
 * write nor make an empty database for a wrong DATA_DIR. It prints counts only: never an address,
 * a name, a hash or a caller.
 *
 * The nine stages and what each counts, in the window `--since` to `--until` (whole UTC days):
 *  - signed_in: accounts whose first sign-in (`tenant_first_seen`) falls in the week. The table
 *    has no environment of its own: a sign-in is of the deployment it happened on, so it counts on
 *    a production deployment, or with --include-sandbox;
 *  - world_verified: accounts whose first World ID verification with an accepted credential
 *    (`ACCEPTED_CREDENTIALS`, the set the guardian gate takes) falls in the week, a production row
 *    unless --include-sandbox;
 *  - identity_verified: accounts whose CURRENT identity row (the latest, as `identityState` reads
 *    it) passed, at its `completed_at`;
 *  - invite_redeemed: not on this build (no `invite_codes` table): null, `not_available`;
 *  - company_requested: companies for a legal body by `created_at`, abandoned ones included, and
 *    by provider (doola: formed by Novi; customer: declared);
 *  - paid: formation payments of those companies settled or refunded, in the week of their quote
 *    (a payment settles within the quote's window, and `updated_at` moves on a refund). The split
 *    by settlement kind is not on this build (no `settlement_kind`): null, `not_available`;
 *  - filed: those companies by `filed_at`, the day the State filed;
 *  - body_linked: legal bodies, at their first `linked` event;
 *  - statement_reads: the sum over the days of the week of the distinct anonymous callers of each
 *    legal body's statement (`statement_reads`); null, `not_available`, without FUNNEL_SALT, which
 *    is when no read is recorded.
 *
 * NO ZERO FOR A WEEK NOTHING WAS RECORDED IN. Two stages began to be recorded on a date of their
 * own, kept in `meta`: the sign-ins when `migrate` created their table (`funnel_first_seen_since`),
 * the statement reads with the first one recorded (`funnel_statement_reads_since`). A week wholly
 * before that date prints null for the stage, and its label ends "recorded since <YYYY-MM-DD>".
 * With no date kept (a database older than the key), the stage is counted in every week.
 *
 * Excluded everywhere: the accounts of FUNNEL_EXCLUDE_TENANTS and --exclude-tenants (the founders),
 * by the account a row belongs to (a company's, payment's, body's or read's by its company's or
 * body's tenant); and, unless --include-sandbox, every sandbox or synthetic row (a payment, a
 * filing, a link or a read by its company's). The founders are excluded with the flag too.
 */

/** The nine stages of §6.14, in the funnel's order. */
export const FUNNEL_STAGES = [
  "signed_in",
  "world_verified",
  "identity_verified",
  "invite_redeemed",
  "company_requested",
  "paid",
  "filed",
  "body_linked",
  "statement_reads",
] as const;

/** Every column of a week, the stages and their breakdowns, in the order the CSV prints them. */
export const FUNNEL_COLUMNS = [
  "signed_in",
  "world_verified",
  "identity_verified",
  "invite_redeemed",
  "company_requested",
  "company_requested_doola",
  "company_requested_customer",
  "paid",
  "paid_transfer",
  "paid_complimentary",
  "filed",
  "body_linked",
  "statement_reads",
] as const;

export type FunnelColumn = (typeof FUNNEL_COLUMNS)[number];

/** The source label of a stage this build has no source for. Its count is null, never 0. */
export const NOT_AVAILABLE = "not_available";

export type FunnelWeek = { week: string; from: string; to: string } & Record<
  FunnelColumn,
  number | null
>;

export interface FunnelExport {
  since: string;
  until: string;
  includeSandbox: boolean;
  /** How many accounts were excluded: the count only, never which. */
  excludedTenants: number;
  stages: readonly string[];
  sources: Record<FunnelColumn, string>;
  weeks: FunnelWeek[];
}

/** The command's options, as commander hands them over. */
export interface FunnelOptions {
  since: string;
  until?: string;
  excludeTenants?: string;
  includeSandbox?: boolean;
}

const DOOLA: FormationPin["provider"] = "doola";
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC day of a time in milliseconds, `YYYY-MM-DD`. */
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A whole UTC day, `YYYY-MM-DD`, that exists, or a refusal naming the flag. */
function parseDay(flag: string, value: string): number {
  const ms = DATE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (Number.isNaN(ms) || dayOf(ms) !== value) refuse(`${flag} must be a date, YYYY-MM-DD`);
  return ms;
}

/** The accounts --exclude-tenants names, each in its EIP-55 checksummed spelling. The refusal
 *  names an entry by its place, never its value. */
function parseTenants(value: string): string[] {
  return value.split(",").map((entry, i) => {
    const s = entry.trim();
    if (!isAddress(s, { strict: false }) || getAddress(s) !== s)
      refuse(
        `--exclude-tenants must be EIP-55 checksummed wallet addresses, comma-separated (entry ${i + 1} is not one)`,
      );
    return s;
  });
}

/** The `meta` key of the time the sign-ins began to be recorded, written by `migrate`. */
const FIRST_SEEN_SINCE_KEY = "funnel_first_seen_since";

/** The UTC day a stage began to be recorded, from `meta`; undefined when no date was kept. A value
 *  that is not a time refuses: a wrong date would print false nulls or false zeros. */
function recordedSince(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) return undefined;
  const at = Number(row.value);
  if (!Number.isSafeInteger(at) || at <= 0) refuse(`meta ${key} is not a time in milliseconds`);
  return dayOf(at);
}

/** The ISO 8601 week of a time in milliseconds, `YYYY-Www`: weeks start on Monday, and week 1 is
 *  the one holding the year's first Thursday. */
function isoWeekOf(ms: number): string {
  const d = new Date(ms);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The source labels. Each says what it counts and which rows; none holds a comma (the CSV header
 *  carries them). */
function sourcesOf(o: {
  includeSandbox: boolean;
  salted: boolean;
  since: { signed_in: string | undefined; statement_reads: string | undefined };
}): Record<FunnelColumn, string> {
  const since = (day: string | undefined) => (day === undefined ? "" : `; recorded since ${day}`);
  const rows = o.includeSandbox
    ? "sandbox and synthetic rows included"
    : "production rows only; not synthetic";
  const requested = (provider: string) =>
    `companies.created_at; purpose_kind legal_body; provider ${provider}; ${rows}`;
  return {
    signed_in: `tenant_first_seen.first_seen_at; first sign-in per account; ${
      o.includeSandbox ? "any deployment" : "a production deployment only"
    }${since(o.since.signed_in)}`,
    world_verified: `guardian_verifications.verified_at; first accepted credential per account; ${
      o.includeSandbox ? "any environment" : "production rows only"
    }`,
    identity_verified: `guardian_identity_checks.completed_at; the account's latest check passed; ${rows}`,
    invite_redeemed: NOT_AVAILABLE,
    company_requested: `companies.created_at; purpose_kind legal_body; ${rows}`,
    company_requested_doola: requested(DOOLA),
    company_requested_customer: requested(CUSTOMER_PROVIDER),
    paid: `formation_payments.created_at; the quote of a formation payment settled or refunded; purpose_kind legal_body; ${rows}`,
    paid_transfer: NOT_AVAILABLE,
    paid_complimentary: NOT_AVAILABLE,
    filed: `companies.filed_at; purpose_kind legal_body; ${rows}`,
    body_linked: `legal_body_events.created_at; first kind linked per legal body; ${rows}`,
    statement_reads: o.salted
      ? `statement_reads.day; distinct anonymous callers per legal body per day summed; ${rows}${since(
          o.since.statement_reads,
        )}`
      : NOT_AVAILABLE,
  };
}

/** A TEXT time as SQLite's CURRENT_TIMESTAMP writes it (UTC), in milliseconds. */
const ms = (column: string) => `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000)`;
/** The row's account is not excluded. `@excluded` is a JSON array of lower-case addresses. */
const notExcluded = (column: string) =>
  `lower(${column}) NOT IN (SELECT value FROM json_each(@excluded))`;
/** A company's row is counted: production and not synthetic, unless sandbox rows are included. */
const companyCounted = (alias: string) =>
  `(@sandbox = 1 OR (${alias}.environment = 'production' AND ${alias}.synthetic = 0))`;
/** In the window, for a time in milliseconds. */
const inWindow = (expression: string) => `${expression} >= @from_ms AND ${expression} < @to_ms`;

/**
 * The counts, read in one transaction so the stages are of one moment. Exported for the tests of
 * the production rule; the command is the operator's way in.
 */
export function funnelExport(
  db: Database.Database,
  cfg: Config,
  opts: FunnelOptions,
): FunnelExport {
  const fromMs = parseDay("--since", opts.since);
  const until = opts.until ?? dayOf(Date.now());
  const untilMs = parseDay("--until", until);
  if (untilMs < fromMs) refuse("--until must not be before --since");
  const flagged = opts.excludeTenants === undefined ? [] : parseTenants(opts.excludeTenants);
  const configured = cfg.funnel?.excludeTenants ?? [];
  const excluded = [...new Set([...configured, ...flagged].map((a) => a.toLowerCase()))];
  const includeSandbox = opts.includeSandbox === true;
  const salted = cfg.funnel?.salt !== undefined;
  const signInsCounted = includeSandbox || legalBodyEnvironment(cfg) === "production";

  const params = {
    excluded: JSON.stringify(excluded),
    sandbox: includeSandbox ? 1 : 0,
    from_ms: fromMs,
    to_ms: untilMs + DAY_MS,
    since_day: opts.since,
    until_day: until,
    accepted: JSON.stringify([...ACCEPTED_CREDENTIALS]),
  };
  const times = (sql: string): number[] =>
    (db.prepare(sql).all(params) as { t: number }[]).map((r) => r.t);

  const read = () => ({
    since: {
      signed_in: recordedSince(db, FIRST_SEEN_SINCE_KEY),
      statement_reads: salted ? recordedSince(db, STATEMENT_READS_SINCE_KEY) : undefined,
    },
    signed_in: signInsCounted
      ? times(
          `SELECT first_seen_at AS t FROM tenant_first_seen
            WHERE ${inWindow("first_seen_at")} AND ${notExcluded("address")}`,
        )
      : [],
    world_verified: times(
      `SELECT MIN(verified_at) AS t FROM guardian_verifications
        WHERE credential IN (SELECT value FROM json_each(@accepted))
          AND (@sandbox = 1 OR environment = 'production')
          AND ${notExcluded("tenant_id")}
        GROUP BY lower(tenant_id)
       HAVING ${inWindow("t")}`,
    ),
    // The account's latest row decides, as `identityState` reads it (identityRepository.ts's
    // IS_LATEST): a pass revoked, failed or re-run since is not current.
    identity_verified: times(
      `SELECT g.completed_at AS t FROM guardian_identity_checks g
        WHERE g.check_id = (SELECT MAX(l.check_id) FROM guardian_identity_checks l
                             WHERE l.tenant_id = g.tenant_id)
          AND g.status = 'passed'
          AND (@sandbox = 1 OR (g.environment = 'production' AND g.synthetic = 0))
          AND ${notExcluded("g.tenant_id")} AND ${inWindow("g.completed_at")}`,
    ),
    company_requested: db
      .prepare(
        `SELECT c.provider AS provider, ${ms("c.created_at")} AS t FROM companies c
          WHERE c.purpose_kind = 'legal_body' AND ${companyCounted("c")}
            AND ${notExcluded("c.tenant_id")} AND ${inWindow(ms("c.created_at"))}`,
      )
      .all(params) as { provider: string; t: number }[],
    paid: times(
      `SELECT ${ms("p.created_at")} AS t FROM formation_payments p
         JOIN companies c ON c.company_id = p.company_id
        WHERE p.product = 'formation' AND p.status IN ('settled', 'refunded')
          AND c.purpose_kind = 'legal_body' AND ${companyCounted("c")}
          AND ${notExcluded("c.tenant_id")} AND ${inWindow(ms("p.created_at"))}`,
    ),
    // `filed_at` is unix SECONDS, the State's day at its UTC midnight.
    filed: times(
      `SELECT c.filed_at * 1000 AS t FROM companies c
        WHERE c.purpose_kind = 'legal_body' AND c.filed_at IS NOT NULL AND ${companyCounted("c")}
          AND ${notExcluded("c.tenant_id")} AND ${inWindow("c.filed_at * 1000")}`,
    ),
    body_linked: times(
      `SELECT ${ms("MIN(e.created_at)")} AS t FROM legal_body_events e
         JOIN legal_bodies b ON b.legal_body_id = e.legal_body_id
         JOIN companies c ON c.company_id = b.company_id
        WHERE e.kind = 'linked' AND ${companyCounted("c")} AND ${notExcluded("b.tenant_id")}
        GROUP BY e.legal_body_id
       HAVING ${inWindow("t")}`,
    ),
    // One row per legal body, day and caller: counting the anonymous rows of a week sums the
    // distinct anonymous callers of each body over its days.
    statement_reads: salted
      ? (
          db
            .prepare(
              `SELECT r.day AS day FROM statement_reads r
                 JOIN legal_bodies b ON b.legal_body_id = r.legal_body_id
                 JOIN companies c ON c.company_id = b.company_id
                WHERE r.caller_kind = 'anonymous' AND r.day BETWEEN @since_day AND @until_day
                  AND ${companyCounted("c")} AND ${notExcluded("b.tenant_id")}`,
            )
            .all(params) as { day: string }[]
        ).map((r) => Date.parse(`${r.day}T00:00:00.000Z`))
      : null,
  });
  const rows = db.transaction(read)();

  // Every week of the window, a week cut by the window's ends shown as the days it counts.
  const weeks: FunnelWeek[] = [];
  const byWeek = new Map<string, FunnelWeek>();
  const firstMonday = fromMs - ((new Date(fromMs).getUTCDay() + 6) % 7) * DAY_MS;
  for (let monday = firstMonday; monday <= untilMs; monday += 7 * DAY_MS) {
    const week: FunnelWeek = {
      week: isoWeekOf(monday),
      from: dayOf(Math.max(monday, fromMs)),
      to: dayOf(Math.min(monday + 6 * DAY_MS, untilMs)),
      signed_in: 0,
      world_verified: 0,
      identity_verified: 0,
      invite_redeemed: null,
      company_requested: 0,
      company_requested_doola: 0,
      company_requested_customer: 0,
      paid: 0,
      paid_transfer: null,
      paid_complimentary: null,
      filed: 0,
      body_linked: 0,
      statement_reads: rows.statement_reads === null ? null : 0,
    };
    weeks.push(week);
    byWeek.set(week.week, week);
  }
  const add = (column: FunnelColumn, t: number) => {
    const week = byWeek.get(isoWeekOf(t));
    // Unreachable: every query reads the window only.
    if (week === undefined) throw new Error("funnel:export: a row outside the window was read");
    week[column] = (week[column] ?? 0) + 1;
  };
  for (const column of [
    "signed_in",
    "world_verified",
    "identity_verified",
    "paid",
    "filed",
    "body_linked",
  ] as const)
    for (const t of rows[column]) add(column, t);
  for (const { provider, t } of rows.company_requested) {
    add("company_requested", t);
    if (provider === DOOLA) add("company_requested_doola", t);
    if (provider === CUSTOMER_PROVIDER) add("company_requested_customer", t);
  }
  for (const t of rows.statement_reads ?? []) add("statement_reads", t);
  // A week wholly before a stage began to be recorded has no count for it, not a zero.
  for (const column of ["signed_in", "statement_reads"] as const) {
    const since = rows.since[column];
    if (since === undefined) continue;
    for (const week of weeks) if (week.to < since) week[column] = null;
  }

  return {
    since: opts.since,
    until,
    includeSandbox,
    excludedTenants: excluded.length,
    stages: FUNNEL_STAGES,
    sources: sourcesOf({ includeSandbox, salted, since: rows.since }),
    weeks,
  };
}

/** A CSV cell: quoted when it holds a comma, a quote or a line break. */
function cell(value: string | number | null): string {
  const text = value === null ? "null" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The export as CSV: one header line naming every column with its source label
 *  (`column [source]`), then one line per week; a null count prints `null`. */
export function funnelCsv(out: FunnelExport): string {
  const header = [
    "week",
    "from",
    "to",
    ...FUNNEL_COLUMNS.map((column) => `${column} [${out.sources[column]}]`),
  ];
  const lines = out.weeks.map((w) =>
    [w.week, w.from, w.to, ...FUNNEL_COLUMNS.map((column) => w[column])].map(cell).join(","),
  );
  return [header.map(cell).join(","), ...lines].join("\n");
}

export function registerFunnelCommands(program: Command): void {
  program
    .command("funnel:export")
    .description(
      "print the formed door's funnel per ISO week, counts only, each stage labelled by its source; reads and writes nothing else",
    )
    .requiredOption("--since <date>", "the first day counted, YYYY-MM-DD (UTC)")
    .option("--until <date>", "the last day counted, YYYY-MM-DD (UTC); today unless given")
    .option(
      "--exclude-tenants <addresses>",
      "accounts left out, comma-separated, beside FUNNEL_EXCLUDE_TENANTS",
    )
    .option(
      "--include-sandbox",
      "count sandbox and synthetic rows too (the testnet box's history); the excluded accounts stay out",
    )
    .option("--format <format>", "json or csv", "json")
    .action((opts: FunnelOptions & { format: string }) => {
      if (opts.format !== "json" && opts.format !== "csv") refuse("--format must be json or csv");
      const cfg = operatorConfig();
      // The database the configuration names, read-only, and only if it is there: an open that
      // could write would make an empty database for a wrong DATA_DIR, and print zeros from it.
      if (!existsSync(cfg.dbPath)) refuse(`there is no database at ${cfg.dbPath}: check DATA_DIR`);
      const db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
      try {
        const out = funnelExport(db, cfg, opts);
        if (opts.format === "csv") console.log(funnelCsv(out));
        else print(out as unknown as Record<string, unknown>);
      } finally {
        db.close();
      }
    });
}
