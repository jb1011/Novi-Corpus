import type { Address, Hex } from "viem";
import { assertRealHuman } from "../api/routes/worldId";
import { readVerifiedAgreement } from "./agreement";
import {
  GRANT_AMOUNT_MAX,
  GRANT_SCHEMA,
  type Grant,
  type GrantChoices,
  type GrantHeavyAct,
  type GrantHeavyMode,
  SCHEDULE_A_WORDING,
} from "./grant";
import { GRANT_HEAVY_MODES_OFFERED, grantOfNewOrder, readOrderGrant } from "./orderGrant";
import { type LegalBodyOrderDeps, requireOwnedOrder } from "./orders";
import { refusal } from "./sentences";
import type { LegalTextStatus } from "./texts/index";

/**
 * THE GRANT DOORS: three doors that only read. What the form of a grant must hold on this
 * deployment (`grantForm`), a grant as the Charter would state it (`previewGrant`), and an order's
 * grant (`orderGrant`).
 *
 * Each starts with the real-human check (a verified credential, never a waiver). None writes
 * anything, and none takes a token, as the agreement's read and the adoption message take none.
 * None proposes a value: the form serves the rules a grant is held to, and the values are the
 * guardian's.
 */

/** A grant as a door shows it. */
export interface GrantView {
  number: number;
  version: number;
  digest: Hex;
  /** The id of the Schedule A wording. */
  wording: string;
  choices: GrantChoices;
  /** Schedule A as the Charter states it, word for word. */
  scheduleA: string;
}

export function toGrantView(grant: Grant): GrantView {
  return {
    number: grant.value.number,
    version: grant.value.version,
    digest: grant.digest,
    wording: SCHEDULE_A_WORDING,
    choices: grant.value.choices,
    scheduleA: grant.scheduleA,
  };
}

/** What the form of a grant must hold on this deployment. It proposes no value. */
export type GrantFormView =
  | { takesGrant: false }
  | {
      takesGrant: true;
      text: { id: string; version: string; status: LegalTextStatus };
      schema: typeof GRANT_SCHEMA;
      /** The greatest amount a line takes, in whole US dollars. */
      amountMax: number;
      /** The settings offered for each act of section 5.6. */
      heavyActModes: Readonly<Record<GrantHeavyAct, readonly GrantHeavyMode[]>>;
    };

/** The rules of the form on the agreement this deployment serves (`deps.texts`): none where that
 *  agreement takes no grant. */
export function grantForm(deps: LegalBodyOrderDeps, tenantId: Address): GrantFormView {
  assertRealHuman(deps.world, tenantId, deps.environment);
  const agreement = deps.texts.agreement;
  if (agreement.kind === "plain") return { takesGrant: false };
  const { id, version, status } = agreement.text;
  return {
    takesGrant: true,
    text: { id, version, status },
    schema: GRANT_SCHEMA,
    amountMax: GRANT_AMOUNT_MAX,
    heavyActModes: GRANT_HEAVY_MODES_OFFERED,
  };
}

/**
 * The grant an order placed now with `input.grant` would be placed with: the same checks as the
 * order's (`grantOfNewOrder`), the same refusal, and the grant numbered as the order would number
 * it. Where the agreement this deployment serves takes no grant, the refusal `grant_not_taken`
 * (400), whatever the input.
 */
export function previewGrant(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  input: { grant?: unknown },
): { grant: GrantView } {
  assertRealHuman(deps.world, tenantId, deps.environment);
  if (deps.texts.agreement.kind === "plain") throw refusal("grant_not_taken", 400);
  const nowMs = (deps.now ?? Date.now)();
  return { grant: toGrantView(grantOfNewOrder(input?.grant, nowMs)) };
}

/**
 * The grant the tenant's order states, read back from its row and checked against its frozen
 * agreement (`readOrderGrant`), or null: an agreement that takes no grant, or a row with no frozen
 * agreement. One 404 for unknown and not-yours. It reads an order in any state, and one of another
 * deployment: a read.
 */
export function orderGrant(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
): { grant: GrantView | null } {
  assertRealHuman(deps.world, tenantId, deps.environment);
  const row = requireOwnedOrder(deps, tenantId, id);
  const hash = row.oaManifestHash;
  if (hash === null) return { grant: null };
  // A failure has already written its error line, naming the order and a fixed reason.
  const verified = readVerifiedAgreement(deps.docStore, row.legalBodyId, hash);
  if (verified === undefined) throw refusal("agreement_unreadable", 500);
  // As above: a grant that does not check has written its error line.
  const grant = readOrderGrant(deps, row.legalBodyId, verified);
  return { grant: grant === null ? null : toGrantView(grant) };
}
