import { opsLog } from "../observability/opsLog";
import type { CharterGrantRepository } from "../persistence/charterGrantRepository";
import {
  GRANT_HEAVY_ACTS,
  type Grant,
  type GrantChoices,
  type GrantHeavyAct,
  type GrantHeavyMode,
  SCHEDULE_A_WORDING,
  buildGrant,
  grantAllowsNothing,
  grantFromCanonical,
  grantLastDayStartsAt,
  parseGrantChoices,
  utcDay,
} from "./grant";
import { refusal } from "./sentences";
import type { FieldProblem } from "./textRules";
import { agreementTextOfVersion } from "./texts/sets";

/**
 * THE GRANT OF AN ORDER: what the product offers in a grant, beside the rules of its shape
 * (`grant.ts`), and the grant a new order on the Charter is placed with.
 *
 * Choices whose shape is valid can still ask for something the product does not offer: choices
 * that allow nothing (a grant allows something), and an act of the Charter's section 5.6 left to
 * the agent alone where the product offers it only with the Guardian Wallet's signature, or not at
 * all. Both are refused, never changed: the values are the guardian's, and nothing is filled in for
 * them.
 *
 * Once the order is placed, every door that acts on its draft reads the grant back from its row
 * and checks it against the frozen Charter (`readOrderGrant`), and the doors where a legal body
 * could be created under it check its end again: the adoption doors at now
 * (`assertGrantOutlasts`), the link doors at the link's deadline (`assertLinkWithinGrant`). A
 * legal body is created before the last day of its grant begins.
 *
 * This module takes from `orders.ts` nothing but types, so the two never import each other at run
 * time: `orders.ts` calls `grantOfNewOrder`.
 */

/** The settings the product offers for each act of the Charter's section 5.6. */
export const GRANT_HEAVY_MODES_OFFERED: Readonly<Record<GrantHeavyAct, readonly GrantHeavyMode[]>> =
  Object.freeze({
    employ: ["not_allowed", "guardian_signature"],
    borrow: ["not_allowed", "guardian_signature", "alone"],
    guarantee: ["not_allowed", "guardian_signature", "alone"],
    transferProperty: ["not_allowed", "guardian_signature"],
  } as const);

const ALLOWS_SOMETHING = "must allow at least one act";

/** What the product refuses in choices whose shape is valid, in this order: choices that allow
 *  nothing; then each act of section 5.6, in the order of `GRANT_HEAVY_ACTS`, set to a mode the
 *  product does not offer for it. */
export function grantOfferProblems(choices: GrantChoices): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (grantAllowsNothing(choices)) problems.push({ field: "grant", problem: ALLOWS_SOMETHING });
  for (const act of GRANT_HEAVY_ACTS) {
    const offered = GRANT_HEAVY_MODES_OFFERED[act];
    if (!offered.includes(choices.heavyActs[act].mode))
      problems.push({ field: `heavyActs.${act}.mode`, problem: `must be ${offered.join(" or ")}` });
  }
  return problems;
}

/**
 * The grant of a new order, number 1, version 1, or the refusal `grant_not_valid` (400) with its
 * problems. The choices are read with the day of `nowMs` (UTC) as today; a shape problem is
 * answered alone, before what the product offers is read.
 */
export function grantOfNewOrder(raw: unknown, nowMs: number): Grant {
  const parsed = parseGrantChoices(raw, utcDay(nowMs));
  if ("problems" in parsed) throw refusal("grant_not_valid", 400, parsed.problems);
  const problems = grantOfferProblems(parsed.choices);
  if (problems.length > 0) throw refusal("grant_not_valid", 400, problems);
  return buildGrant(parsed.choices, { number: 1, version: 1 });
}

/** Why a stored grant does not check: the one fixed word its error line holds. */
type GrantUnverifiable =
  | "no_row"
  | "wording_unknown"
  | "not_canonical"
  | "digest_mismatch"
  | "not_in_terms";

/**
 * The grant an order's frozen agreement states: null for an agreement that takes none; else the
 * stored grant, rebuilt and checked against the frozen text. A grant that does not check is the
 * refusal `grant_unreadable` (500), after one error line that names the order and a fixed reason.
 *
 * In this order: the order's last row (by number, then version); written in SCHEDULE_A_WORDING;
 * its canonical form reads back as a grant (`grantFromCanonical`); the grant's fingerprint is the
 * row's; the frozen text holds the grant's Schedule A, whole, under its heading. The line holds
 * nothing the row or the text holds. It reads two stores and takes no lock.
 */
export function readOrderGrant(
  deps: { grants: CharterGrantRepository },
  legalBodyId: string,
  verified: { termsDoc: string; terms: { textVersion: string } },
): Grant | null {
  const text = agreementTextOfVersion(verified.terms.textVersion);
  if (text === undefined || text.kind === "plain") return null;
  const fail = (reason: GrantUnverifiable): never => {
    opsLog("legal_body_grant_unverifiable", { level: "error", legalBodyId, reason });
    throw refusal("grant_unreadable", 500);
  };
  const row = deps.grants.list(legalBodyId).at(-1);
  if (row === undefined) return fail("no_row");
  if (row.wording !== SCHEDULE_A_WORDING) return fail("wording_unknown");
  const grant = grantFromCanonical(row.canonical);
  if (grant === undefined) return fail("not_canonical");
  if (grant.digest !== row.digest) return fail("digest_mismatch");
  if (
    !verified.termsDoc.includes(
      `\n## Schedule A. Grants in force\n\n${grant.scheduleA}\n\n## Schedule B.`,
    )
  )
    return fail("not_in_terms");
  return grant;
}

/** Whether `atSec` (unix seconds) is from the first second of the last day of `grant` on: never
 *  for no grant, or a grant with no end. Compared as a bigint, so a deadline of any size a link
 *  can carry is compared, never converted to a date. The one spelling of the rule for both checks
 *  below. */
function reachesLastDay(grant: Grant | null, atSec: bigint): boolean {
  const starts = grant === null ? null : grantLastDayStartsAt(grant.value.choices);
  return starts !== null && atSec >= BigInt(starts);
}

/** Passes when `grant` is null, has no end, or `atSec` (unix seconds) is before its last day begins;
 *  else the refusal `grant_ends_too_soon` (409). The two adoption doors' check, at now. */
export function assertGrantOutlasts(grant: Grant | null, atSec: bigint): void {
  if (reachesLastDay(grant, atSec)) throw refusal("grant_ends_too_soon", 409);
}

/** Passes when `grant` is null, has no end, or `deadlineSec` is before its last day begins; else the
 *  refusal `link_outlasts_grant` (409). The link doors' twin of `assertGrantOutlasts`. */
export function assertLinkWithinGrant(grant: Grant | null, deadlineSec: bigint): void {
  if (reachesLastDay(grant, deadlineSec)) throw refusal("link_outlasts_grant", 409);
}
