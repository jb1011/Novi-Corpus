import type { Address, Hex } from "viem";
import type { LegalBodyChainPort } from "../adapters/arc/legalBodyChain";
import { type WorldIdDeps, assertRealHuman } from "../api/routes/worldId";
import { ApiError } from "../errors";
import { companyFiled } from "../formation/status";
import { type IdentityDeps, assertIdentityVerified } from "../identity/state";
import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
import type { CompanyCheckRepository } from "../persistence/companyCheckRepository";
import type { CompanyDeclarationRepository } from "../persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../persistence/companyRepository";
import type { DocumentStore } from "../persistence/documentStore";
import type { FormationRequestRecord } from "../persistence/formationRepository";
import type {
  BindingState,
  BrokenReason,
  Deployment,
  LapseReason,
  LegalBodyReasonReads,
  LegalBodyRecord,
  LegalBodyRepository,
} from "../persistence/legalBodyRepository";
import { buildAgreement, storeAgreement } from "./agreement";
import { filedCompanyNames, publicCompanyNames } from "./attestation";
import { filedNamesPrintable } from "./companyFields";
import { CUSTOMER_PROVIDER, companySourceOf } from "./provider";
import { refusal } from "./sentences";
import { LegalTextNotApprovedError, assertTextsServable } from "./texts/index";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "./texts/operatingAgreement";

/**
 * LEGAL-BODY ORDERS: what a guardian orders, and the rules every door of the flow shares.
 *
 * An order is a `legal_bodies` row. It is born a `draft` for a company of its tenant, with its
 * operating agreement built, stored and frozen in the same transaction, so no draft ever exists
 * without the agreement the identity owner's link will sign. From there the link door reserves
 * it, the create deploys it and the binding check links it; this module holds what they all use:
 *  - the deps of every door (`LegalBodyOrderDeps`);
 *  - the one boundary between a door and the chain (`chainCall`);
 *  - the doors' throttles (`takeDoorTokens`);
 *  - the one rule of which company may stand behind a body (`companyEligible`), and of the names
 *    its agreement prints (`companyNamesForOrder`);
 *  - the order's view, which serialises as it is (no bigint), and the facts it carries beside the
 *    row (`orderViewFacts`).
 *
 * A row made under another factory or chain than this deployment's is read-only here: it is
 * served, and every action on it answers 409 `other_deployment`.
 */

export interface LegalBodyOrderDeps {
  repo: LegalBodyRepository & LegalBodyReasonReads;
  companies: CompanyRepository;
  declarations: CompanyDeclarationRepository;
  checks: CompanyCheckRepository;
  /** A company's formation steps, as the attestation reads them: whether the state has filed a
   *  formed company is `companyFiled` of these. A customer's company has none, and they are never
   *  read for one. */
  formationSteps: (companyId: string) => FormationRequestRecord[];
  world: WorldIdDeps | undefined;
  /** The guardian identity record. Production requires a verified one before an order is written
   *  (absent there, the order door answers 503 `identity_unavailable`); a sandbox never reads it. */
  identity: IdentityDeps | undefined;
  chain: LegalBodyChainPort;
  docStore: DocumentStore;
  /** The factory and chain new orders are made for, and the only ones an action may touch. */
  deployment: Deployment;
  /** The ERC-8004 identity registry the agreement names. */
  identityRegistry: Address;
  environment: "sandbox" | "production";
  /** Seconds: the amendment delay of every new order. */
  amendmentDelaySeconds: number;
  maxOpenPerTenant: number;
  maxOrdersPerTenantPerDay: number;
  maxCreatesPerTenantPerDay: number;
  maxCreatesPerDay: number;
  /** The legal-body doors' own budget, shared with nothing else. */
  doorBudget: { take(): boolean };
  tenantBucket: (tenantId: string) => { take(): boolean };
  identityBucket: (key: string) => { take(): boolean };
  /** One IMMEDIATE transaction on the database the repositories write to. */
  transaction: <T>(fn: () => T) => T;
  /** Unix milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** The key of an order's lock: the doors and the sweeper take this one, so each order has one
 *  writer at a time. */
export const orderLockKey = (legalBodyId: string) => `legal-body:${legalBodyId}`;

/**
 * The one boundary between a door and the chain.
 *
 * An `ApiError` passes as it is: it is an answer the door chose. Any other throw becomes the 503
 * `chain_unavailable`, after one log line that names the order, the stage and the error's NAME.
 * Never its message: a transport error's message can carry the node's URL, and an error with a
 * numeric `status` would otherwise be rendered with that message by the app's error handler.
 */
export async function chainCall<T>(
  orderId: string | undefined,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    opsLog("legal_body_chain_unavailable", {
      level: "warn",
      orderId: orderId ?? null,
      stage,
      errorName: err instanceof Error ? err.name : "not_an_error",
    });
    throw refusal("chain_unavailable", 503);
  }
}

/** Tenant bucket, then the doors' budget; either empty is a 429. */
export function takeDoorTokens(deps: LegalBodyOrderDeps, tenantId: string): void {
  // In this order, and the second only when the first gave a token: a tenant that has spent its
  // own bucket does not spend the budget every other tenant shares.
  if (!deps.tenantBucket(tenantId).take() || !deps.doorBudget.take())
    throw refusal("rate_limited", 429);
}

/**
 * What the event log and the company say about an order, beside its row: why it is in its state,
 * and which company it is for. Each fact is read only for the states it can describe
 * (`orderViewFacts`).
 */
export interface OrderViewFacts {
  /** Why the reservation was closed without a body, for a `lapsed` order; null otherwise. */
  lapseReason: LapseReason | null;
  /**
   * The reason of the latest break, for a body that is broken, or that was superseded after a
   * break; null otherwise, and null for a stored reason this version does not know.
   */
  brokenReason: BrokenReason | null;
  /** Whether an operator revoked the body. A revocation is never undone. */
  revoked: boolean;
  /** The id of the order that superseded this one, for a `superseded` order; null otherwise. */
  supersededBy: string | null;
  /** The id of the order whose body was linked in this one's place, when the latest break is
   *  `replaced`; null otherwise. */
  replacedBy: string | null;
  /** The company's name: for a customer's own company, the one its declaration states; for a
   *  company Novi formed, the filed name its row holds. Null when there is none (no declaration, or
   *  no filed name written yet). */
  companyName: string | null;
}

/**
 * The facts of `row`, read by state: the lapse only for `lapsed`, the latest break for `broken`
 * and `superseded` (a superseded body that never broke has no break to read), the superseding
 * order only for `superseded`; the revocation and the declaration always, and the company only
 * when there is no declaration (only a customer's own company has one). So at most three reads of
 * the event log, one of the declarations and one of the companies per row, and a declared
 * company's row reads no company at all, which keeps a tenant's list cheap.
 */
export function orderViewFacts(
  deps: {
    repo: LegalBodyRepository & LegalBodyReasonReads;
    declarations: CompanyDeclarationRepository;
    companies: CompanyRepository;
  },
  row: LegalBodyRecord,
): OrderViewFacts {
  const id = row.legalBodyId;
  const state = row.bindingState;
  // Gated on the state where the binding gates on the leg (`pointerSeenAt`): the same rows, as only
  // a row once linked holds a broken event and `pointer_seen_at` is never cleared.
  const lastBreak =
    state === "broken" || state === "superseded" ? deps.repo.brokenDetail(id) : null;
  return {
    lapseReason: state === "lapsed" ? deps.repo.lapseReason(id) : null,
    brokenReason: lastBreak?.reason ?? null,
    revoked: deps.repo.isRevoked(id),
    supersededBy: state === "superseded" ? deps.repo.supersededBy(id) : null,
    replacedBy: lastBreak?.reason === "replaced" ? lastBreak.by : null,
    companyName: companyNameOf(deps, row.companyId),
  };
}

/** The declaration's company name; failing a declaration, a formed company's filed name. */
function companyNameOf(
  deps: { declarations: CompanyDeclarationRepository; companies: CompanyRepository },
  companyId: string,
): string | null {
  const declared = deps.declarations.find(companyId);
  if (declared !== undefined) return declared.companyName;
  const company = deps.companies.find(companyId);
  return company !== undefined && company.provider !== CUSTOMER_PROVIDER
    ? company.legalNameFiled
    : null;
}

/**
 * An order as the API shows it: ids, hex, decimals and numbers, never a bigint. The facts
 * (`OrderViewFacts`) follow `createdAt`, in their own order.
 */
export interface LegalBodyOrderView extends OrderViewFacts {
  id: string;
  publicId: string;
  companyId: string;
  state: BindingState;
  chainId: number;
  factory: Address;
  guardian: Address;
  /** Seconds. */
  amendmentDelay: number;
  agreement: { hash: Hex; version: number } | null;
  /** A uint256 in decimal. */
  agentId: string | null;
  identityOwner: Address | null;
  bodyAddress: Address | null;
  /** Unix seconds, like `deployedAt` and `pointerSeenAt`. */
  linkDeadline: number | null;
  createTxHash: Hex | null;
  deployedAt: number | null;
  pointerSeenAt: number | null;
  /** ISO 8601, in UTC and marked so: `YYYY-MM-DDTHH:MM:SSZ`. */
  createdAt: string;
}

/** The view of `row` with the facts given: the builder reads nothing itself. */
export function toOrderView(row: LegalBodyRecord, facts: OrderViewFacts): LegalBodyOrderView {
  return {
    id: row.legalBodyId,
    publicId: row.publicId,
    companyId: row.companyId,
    state: row.bindingState,
    chainId: row.chainId,
    factory: row.factory,
    guardian: row.guardian,
    amendmentDelay: row.amendmentDelay,
    agreement:
      row.oaManifestHash !== null && row.oaManifestVersion !== null
        ? { hash: row.oaManifestHash, version: row.oaManifestVersion }
        : null,
    agentId: row.agentId,
    identityOwner: row.identityOwner,
    bodyAddress: row.bodyAddress,
    linkDeadline: row.linkDeadline,
    createTxHash: row.createTxHash,
    deployedAt: row.deployedAt,
    pointerSeenAt: row.pointerSeenAt,
    // The stored text is UTC with no zone marker, which a reader would take for local time.
    createdAt: `${row.createdAt.replace(" ", "T")}Z`,
    // Named one by one, not spread, so the view holds exactly these fields whatever object the
    // facts come in.
    lapseReason: facts.lapseReason,
    brokenReason: facts.brokenReason,
    revoked: facts.revoked,
    supersededBy: facts.supersededBy,
    replacedBy: facts.replacedBy,
    companyName: facts.companyName,
  };
}

/**
 * The one rule of which company may stand behind a legal body: a company for a legal body (never
 * one for agents), not abandoned, and established:
 *  - a customer's own company, by its latest check, which passed. A failed, revoked or reinstated
 *    company waits for a new passed check;
 *  - a company filed through formation, by the state's confirmed filing, and only once its row
 *    carries the filed name and the filing number its agreement prints. A filed name that matched
 *    none of the company's options was never written, and an operator writes it. Never while its
 *    latest check is a revocation (`company:revoke` takes a company of any provider): it needs no
 *    check to stand, and a reinstatement falls back to its filing, as the attestation reads it.
 * Whose company it is, each door asks before.
 */
export function companyEligible(
  deps: Pick<LegalBodyOrderDeps, "companies" | "checks" | "formationSteps">,
  companyId: string,
): boolean {
  const company = deps.companies.find(companyId);
  if (company === undefined) return false;
  if (company.status === "abandoned" || company.purposeKind !== "legal_body") return false;
  if (company.provider === CUSTOMER_PROVIDER)
    return deps.checks.latest(companyId)?.result === "passed";
  return (
    deps.checks.latest(companyId)?.result !== "revoked" &&
    companyFiled(deps.formationSteps(companyId)) &&
    filedCompanyNames(company) !== null
  );
}

/**
 * The name and the filing number an order's agreement prints for a company, or null when there is
 * none to print:
 *  - a customer's company: the declared ones, once its latest check passed and only while its
 *    declaration stands (`publicCompanyNames`);
 *  - a company filed through formation: the filed ones, as its row holds them, once it holds both
 *    (`filedCompanyNames`).
 */
export function companyNamesForOrder(
  deps: Pick<LegalBodyOrderDeps, "companies" | "declarations" | "checks">,
  companyId: string,
): { legalName: string; filingNumber: string } | null {
  const company = deps.companies.find(companyId);
  if (company === undefined) return null;
  if (company.provider === CUSTOMER_PROVIDER)
    return publicCompanyNames(deps.declarations.find(companyId), deps.checks.latest(companyId));
  return filedCompanyNames(company);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Orders a legal body for a company of the tenant, in this order:
 *  1. a real human: a verified credential, never a waiver;
 *  1b. on production, a verified guardian identity record (`assertIdentityVerified`), the record
 *     the declared door holds the guardian to: World ID proves one real person; the identity
 *     check says who. A sandbox reads nothing here;
 *  2. the agreement's wording can be served (a production deployment refuses a draft);
 *  3. the company is the tenant's (one 404 for unknown and not-yours) and eligible;
 *  4. the agreement is built, before anything is written. It names the company by the names
 *     `companyNamesForOrder` reads, and nothing else: a customer's company by the declared name
 *     and filing number its passed check stands behind; a formed company by the filed name and
 *     filing number its row holds, printed as they stand, so a filed fact the agreement cannot
 *     print (`filedNamesPrintable`) is refused, never cleaned. Its manifest states the company's
 *     source: `customer` or `novi` (`companySourceOf`);
 *  5. one transaction: the names are read again and must be the ones the agreement prints (an
 *     operator's `company:filed-name --replace` committed after step 4 is answered
 *     `company_not_eligible`, never a draft printing the superseded name), the two caps are
 *     counted, the draft is created, the agreement is stored and frozen, and the tenant's
 *     `ordered` note is written.
 * A throw anywhere in step 5 rolls the row back. The files are written inside it, so a failure
 * after they were written leaves at most two orphan files, named by an id no row holds.
 */
export function createOrder(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  input: { companyId: string },
): LegalBodyOrderView {
  const nowMs = (deps.now ?? Date.now)();

  // 1.
  assertRealHuman(deps.world, tenantId, deps.environment);

  // 1b.
  assertIdentityVerified(deps.identity, deps.world, tenantId, deps.environment);

  // 2.
  try {
    assertTextsServable(deps.environment, [LEGAL_BODY_OPERATING_AGREEMENT]);
  } catch (err) {
    if (err instanceof LegalTextNotApprovedError) throw refusal("legal_text_not_approved", 503);
    throw err;
  }

  // 3.
  const companyId = typeof input?.companyId === "string" ? input.companyId : undefined;
  const owned = companyId === undefined ? undefined : deps.companies.findOwned(tenantId, companyId);
  if (companyId === undefined || owned === undefined) throw refusal("not_found", 404);
  if (!companyEligible(deps, companyId)) throw refusal("company_not_eligible", 409);

  // 4. A declaration erased, or paired with another company's check, names nothing. A filed
  //    name or number the agreement cannot print is for an operator to set; a declared company's
  //    names were held to the same field rules when they were declared.
  const names = companyNamesForOrder(deps, companyId);
  if (names === null) throw refusal("company_not_eligible", 409);
  if (owned.provider !== CUSTOMER_PROVIDER && !filedNamesPrintable(names))
    throw refusal("company_name_unusable", 409);
  const built = buildAgreement(
    {
      companyName: names.legalName,
      filingNumber: names.filingNumber,
      jurisdiction: "WY",
      guardian: tenantId,
      amendmentDelaySeconds: deps.amendmentDelaySeconds,
      chainId: deps.deployment.chainId,
      factory: deps.deployment.factory,
      identityRegistry: deps.identityRegistry,
    },
    LEGAL_BODY_OPERATING_AGREEMENT,
    { source: companySourceOf(owned.provider) },
  );

  // 5. The names and the caps are read inside the transaction that writes, which holds the write
  //    lock from its first statement: another writer cannot change the names, or add an order,
  //    between these reads and the insert. A writer that committed before it (the operator's
  //    command, on its own connection) is seen here, and its names are not the agreement's.
  const row = deps.transaction((): LegalBodyRecord => {
    const current = companyNamesForOrder(deps, companyId);
    if (
      current === null ||
      current.legalName !== names.legalName ||
      current.filingNumber !== names.filingNumber
    )
      throw refusal("company_not_eligible", 409);
    if (deps.repo.countOpenByTenant(tenantId, nowMs) >= deps.maxOpenPerTenant)
      throw refusal("legal_body_cap", 409);
    if (
      deps.repo.countOrdersCreatedByTenant(tenantId, nowMs - DAY_MS) >=
      deps.maxOrdersPerTenantPerDay
    )
      throw refusal("legal_body_orders", 429);
    const created = deps.repo.create({
      tenantId,
      companyId,
      chainId: deps.deployment.chainId,
      factory: deps.deployment.factory,
      amendmentDelay: deps.amendmentDelaySeconds,
    });
    const id = created.legalBodyId;
    storeAgreement(deps.docStore, id, built);
    if (!deps.repo.freezeAgreement(id, { hash: built.manifestHash, version: built.version }))
      throw new Error(`legal body ${id}: the new draft did not take its agreement`);
    deps.repo.recordEvent(id, "note", "tenant", null, { act: "ordered" });
    const frozen = deps.repo.findById(id);
    if (frozen === undefined) throw new Error(`legal body ${id} vanished inside its own order`);
    return frozen;
  });
  return toOrderView(row, orderViewFacts(deps, row));
}

/** The tenant's order, or the uniform 404: unknown and not-yours get one answer, so no door is an
 *  existence oracle over other tenants' ids. */
export function requireOwnedOrder(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
): LegalBodyRecord {
  const row = deps.repo.findOwned(tenantId, id);
  if (row === undefined) throw refusal("not_found", 404);
  return row;
}

/** A row made under another factory or chain is read-only here: 409 `other_deployment`. */
export function assertThisDeployment(deps: LegalBodyOrderDeps, row: LegalBodyRecord): void {
  if (
    row.chainId !== deps.deployment.chainId ||
    row.factory.toLowerCase() !== deps.deployment.factory.toLowerCase()
  )
    throw refusal("other_deployment", 409);
}

/**
 * The tenant abandons its draft, under the order's lock. Any other state is a 409
 * `order_closed`, and so is a draft that another writer moved first.
 */
export async function abandonOrder(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
): Promise<LegalBodyOrderView> {
  // Read once before the lock: an id that is not the tenant's order never gets a lock of its own.
  const owned = requireOwnedOrder(deps, tenantId, id);
  return withKeyedLock(orderLockKey(owned.legalBodyId), async () => {
    const row = requireOwnedOrder(deps, tenantId, owned.legalBodyId);
    assertThisDeployment(deps, row);
    if (
      row.bindingState !== "draft" ||
      !deps.repo.abandon(row.legalBodyId, "tenant_request", "tenant")
    )
      throw refusal("order_closed", 409);
    const abandoned = deps.repo.findById(row.legalBodyId);
    if (abandoned === undefined) throw new Error(`legal body ${row.legalBodyId} vanished`);
    return toOrderView(abandoned, orderViewFacts(deps, abandoned));
  });
}
