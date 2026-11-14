import {
  GRANT_HEAVY_ACTS,
  type Grant,
  type GrantChoices,
  type GrantHeavyAct,
  type GrantHeavyMode,
  buildGrant,
  grantAllowsNothing,
  parseGrantChoices,
  utcDay,
} from "./grant";
import { refusal } from "./sentences";
import type { FieldProblem } from "./textRules";

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
