import { type PiiKeyring, encryptText, nameHmac } from "../formation/pii";
import type {
  GuardianIdentityCheck,
  IdentityRepository,
  NewGuardianIdentityCheck,
} from "../persistence/identityRepository";
import { IDENTITY_AAD, nameOfRecord, nameRuleProblem } from "./names";
import type {
  DocumentType,
  IdentityProvider,
  Liveness,
  ReviewReasonCode,
  Watchlist,
} from "./types";

/**
 * THE RULES THAT MAKE AN IDENTITY ROW: how one check's result becomes the row the guardian's
 * identity record appends. The operator's `identity:record` and the automatic adapter both plan
 * their row here, so a check recorded by hand and one recorded by the adapter obey one set of
 * rules: the renewal, the review reasons in the record's order, the status, the sealed names and
 * their fingerprint, and the production pass.
 *
 * World ID proves one real person; the identity check says who.
 *
 * What stays with each caller: its parsing, its view of the latest row (the command's
 * `--expect-latest`), its rule on a verified guardian, the shape check, the append and its event.
 * A refusal is a `CheckRefused` holding the command's own sentence, which the command prints as
 * its refusal and the adapter reads as a rule that held.
 */

/** A rule that refuses the check: the message is the operator's command's sentence, unprefixed. */
export class CheckRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckRefused";
  }
}

function refused(message: string): never {
  throw new CheckRefused(message);
}

/** The names of record: each already through `nameOfRecord`; `full` null when there is none. */
interface Names {
  first: string;
  last: string;
  full: string | null;
}

/** One check's result, as its writer read it. */
export interface CheckInput {
  tenantId: string;
  /** The guardian action nullifier of the tenant's World row, copied by the caller. */
  nullifier: string | null;
  provider: IdentityProvider;
  providerRef: string;
  subject: string | null;
  result: "passed" | "failed" | "needs_review";
  /** Already through `nameOfRecord`. A failed check keeps none, whatever it is handed. */
  names: Names | null;
  /** The guardian's name differs from the document's: the check waits for a review. */
  nameMismatch: boolean;
  /** ISO 3166-1 alpha-3, upper case. */
  country: string | null;
  documentType: DocumentType | null;
  documentExpired: boolean;
  liveness: Liveness | null;
  watchlist: Watchlist | null;
  /** Unix milliseconds, as is `completedAt`. */
  startedAt: number;
  completedAt: number;
  environment: "sandbox" | "production";
  synthetic: boolean;
  /** Null when the adapter writes the row. */
  operator: string | null;
  operatorOsUser: string | null;
}

/** The row to append, the other tenants' passes it duplicates (check ids, never a name), and the
 *  tenant's pass it renews, if any. */
export interface CheckPlan {
  row: NewGuardianIdentityCheck;
  duplicateOf: number[];
  renews: GuardianIdentityCheck | undefined;
}

export interface CheckDeps {
  repo: IdentityRepository;
  pii: PiiKeyring;
  /** The name fingerprint's own secret (`IDENTITY_NAME_HMAC_KEY`). */
  nameHmacKey: Buffer;
  reverifyYears: number;
  blockedCountries: ReadonlySet<string>;
  nowMs: number;
}

/** `ms` plus whole UTC calendar years: 10 November stays 10 November. */
export function addUtcYears(ms: number, years: number): number {
  const date = new Date(ms);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.getTime();
}

/** A full name typed or flagged through `nameOfRecord`; absent, empty or blank, no full name (as
 *  at the operator's prompt). */
export function fullNameOfRecord(value: string | undefined): string | null {
  const full = value === undefined ? "" : nameOfRecord(value);
  return full === "" ? null : full;
}

/** The three names sealed under the current key, each bound to the tenant and its field. */
export function sealNames(
  pii: PiiKeyring,
  tenantId: string,
  names: Names,
): NonNullable<NewGuardianIdentityCheck["names"]> {
  const seal = (field: "first" | "last" | "full", value: string) => {
    const { ciphertext, iv } = encryptText(pii, value, IDENTITY_AAD(tenantId, field));
    return { ciphertext, iv };
  };
  return {
    first: seal("first", names.first),
    last: seal("last", names.last),
    full: names.full === null ? null : seal("full", names.full),
    keyId: pii.current.id,
  };
}

/** One name as two names are compared: the name of record, lower-cased, and composed again (the
 *  lower-casing can decompose, as `nameOfRecord`'s own recasing can). */
const folded = (name: string): string => nameOfRecord(name).toLowerCase().normalize("NFC");

/**
 * Whether two names are the same name beyond case and spacing: both sides through `nameOfRecord`,
 * case-folded, equal first and equal last. The adapter compares the guardian's typed name with the
 * document's; a difference is `name_mismatch`.
 */
export function namesAgree(
  a: { first: string; last: string },
  b: { first: string; last: string },
): boolean {
  return folded(a.first) === folded(b.first) && folded(a.last) === folded(b.last);
}

/**
 * A row that will read `passed` on production rests on the face match, the sanctions search and
 * the name rule, however it was built: `identity:record`, `identity:accept`,
 * `identity:correct-name` or the adapter. Each refusal names the way out. A sandbox row is held to
 * none of it.
 */
export function assertProductionPass(
  row: NewGuardianIdentityCheck,
  names: { first: string; last: string } | null,
): void {
  if (row.status !== "passed" || row.environment !== "production") return;
  if (row.liveness !== "passed")
    refused(
      "on production a passed check needs the face match (--liveness passed), and this check has none: refuse it with identity:refuse and record a new check",
    );
  if (row.watchlist !== "clear" && row.watchlist !== "hit")
    refused(
      "on production a passed check needs the sanctions search (--watchlist clear or hit), and this check has none: refuse it with identity:refuse and record a new check",
    );
  // A passed row always holds its names (the shape check); none reads as a name with neither part.
  const problem = nameRuleProblem(names?.first ?? "", names?.last ?? "");
  if (problem !== null)
    refused(
      `on production a passed check needs a name that passes the name rule (${problem}): correct it with identity:correct-name first`,
    );
}

/**
 * The row one check's result appends, inside the caller's `repo.transaction` (the duplicate and
 * the renewal are read there, so nothing lands between them and the append). Writes nothing.
 *
 * A passed result is planned as `needs_review`, with its reasons in the record's order, when the
 * provider asked for a review (`provider_flag`), the sanctions search hit, the document was out of
 * date, its country is blocked, the name breaks the name rule, the guardian's name differs from
 * the document's, or another tenant's current passed check holds the same name and country
 * (`duplicate_identity`, last). A pass over the tenant's pass is a renewal: it names the pass it
 * replaces and must complete after it, so an expiry, counted from the completion, never moves
 * back; and no pass is planned that would already be expired. On production a passed result needs
 * the sanctions search and the face match, and a passed row the name rule too.
 */
export function planCheck(deps: CheckDeps, input: CheckInput): CheckPlan {
  const { repo, nowMs, reverifyYears } = deps;
  const { tenantId, result, completedAt, country, liveness, watchlist } = input;
  const failed = result === "failed";
  if (result === "passed" && addUtcYears(completedAt, reverifyYears) <= nowMs)
    refused("--completed-at is so old that this pass would already be expired");
  // On production a pass rests on the face match and on the sanctions search, both of them run.
  if (input.environment === "production" && result === "passed") {
    if (watchlist === "not_run")
      refused("on production a passed check needs the sanctions search: --watchlist clear or hit");
    if (liveness !== "passed") refused("on production a passed check needs --liveness passed");
  }
  // A failed check keeps no name.
  const names = failed ? null : input.names;
  const hmac = names === null ? null : nameHmac(deps.nameHmacKey, names.first, names.last);
  // The reasons the result alone decides, in the record's order; the duplicate is read below.
  const flagged: ReviewReasonCode[] = [];
  if (names !== null) {
    if (result === "needs_review") flagged.push("provider_flag");
    if (watchlist === "hit") flagged.push("watchlist_hit");
    if (input.documentExpired) flagged.push("document_expired");
    if (country !== null && deps.blockedCountries.has(country)) flagged.push("country_blocked");
    if (nameRuleProblem(names.first, names.last) !== null) flagged.push("name_rule_failed");
    if (input.nameMismatch) flagged.push("name_mismatch");
  }
  // A pass over a pass is a renewal: it names the pass it replaces, and completes after it, so
  // the expiry, counted from the completion, never moves back.
  const latest = repo.latest(tenantId);
  const renews = result === "passed" && latest?.status === "passed" ? latest : undefined;
  // A passed row always says when it completed (the table's CHECK).
  if (renews !== undefined && completedAt <= (renews.completedAt as number))
    refused(
      `a renewal must complete after the current pass (${new Date(renews.completedAt as number).toISOString()})`,
    );
  const duplicateOf =
    hmac !== null && country !== null ? repo.passedElsewhere(hmac, country, tenantId) : [];
  const reviewReasons: ReviewReasonCode[] =
    duplicateOf.length > 0 ? [...flagged, "duplicate_identity"] : flagged;
  const row: NewGuardianIdentityCheck = {
    nullifier: input.nullifier,
    tenantId,
    provider: input.provider,
    providerRef: input.providerRef,
    subject: input.subject,
    status: failed ? "failed" : reviewReasons.length > 0 ? "needs_review" : "passed",
    supersedesCheckId: renews?.checkId ?? null,
    startedAt: input.startedAt,
    completedAt,
    expiresAt: failed ? null : addUtcYears(completedAt, reverifyYears),
    names: names === null ? null : sealNames(deps.pii, tenantId, names),
    nameHmac: hmac,
    documentCountry: country,
    documentType: input.documentType,
    documentExpired: input.documentExpired,
    liveness,
    watchlist,
    reviewReasons,
    environment: input.environment,
    synthetic: input.synthetic,
    operator: input.operator,
    operatorOsUser: input.operatorOsUser,
  };
  assertProductionPass(row, names);
  return { row, duplicateOf, renews };
}
