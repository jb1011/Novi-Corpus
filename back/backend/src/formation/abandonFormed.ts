import { ApiError } from "../errors";
import { opsLog } from "../observability/opsLog";
import type { FormationRequestRecord } from "../persistence/formationRepository";
import type { CreateCompanyDeps } from "./company";
import { isIntakeFrozen } from "./freeze";
import { FORMATION_PRODUCT } from "./payment";

/**
 * THE TENANT'S ABANDON OF A FORMED COMPANY: a company formed through doola for a legal body,
 * given up by its own tenant before anything reached doola.
 *
 * Its own module, beside the formed door rather than in it, because its refusals are the abandon
 * door's own `conflict` sentences, as `abandonCustomerCompany`'s are: the formed door
 * (`company.ts`) answers only codes of the legal-body table. `POST /companies/:companyId/abandon`
 * dispatches here for a doola company whose purpose is `legal_body`, and to
 * `abandonCustomerCompany` for a customer's own company.
 */

const conflict = (message: string): ApiError => new ApiError("conflict", 409, message);

/** The refusal of a company whose filing has started, or may have: kept for good. */
const FILING_STARTED = "the filing has started: no refund and no abandon; write to us";

/**
 * Has this company's filing started, or may it have? A step `confirmed` (doola, or the state,
 * said so), any step holding a provider ref (a create returned: a company exists at doola), or a
 * `create_provider` row frozen by the intake rule (`isIntakeFrozen`): a company body sent under
 * the key that is still live, its answer lost, may be committed at doola, and an unreadable row
 * proves nothing. A create doola REFUSED burned its key and is not frozen, so it may be abandoned.
 * The `submitted` create is the caller's to refuse first, with its own sentence.
 */
function filingStarted(steps: FormationRequestRecord[]): boolean {
  if (steps.some((row) => row.state === "confirmed" || row.providerRef !== null)) return true;
  return isIntakeFrozen(steps.find((row) => row.step === "create_provider"));
}

/**
 * The tenant abandons its own formed legal-body company before anything reached doola. Throws
 * ApiError 404 (unknown or not yours) or 409 conflict.
 *
 * In ONE transaction, which the abandon door opens IMMEDIATE (the formed create's, so the write
 * lock is held from the first read): the company is read, the tenant's own (an unknown company
 * and another tenant's are one 404, or the door would be an existence oracle), formed for a legal
 * body (provider doola, purpose `legal_body`) and `draft` or `ready`; its formation rows are read,
 * and a `create_provider` being sent (`submitted`) is refused until it settles, a filing that has
 * started (`filingStarted`) is refused for good; a payment being settled (a transfer in flight) is
 * refused until it settles. Then every formation row moves to `abandoned` from its own state with
 * the error `tenant_abandoned`; a live `quoted` quote is expired, so the company leaves the
 * per-tenant quota and the total cap; the company moves to `abandoned`, which stamps its
 * `updated_at` (the refund-overdue alert counts from it); and the party is erased now, the SSN and
 * the marketing consent with it. Any write that fails throws, and nothing is kept.
 *
 * A settled payment stays `settled`: the refund is made from the revenue wallet by hand, and
 * `formation:refund` records it, reading the payment's status and not the company's. The one ops
 * line, `formation_abandoned_by_tenant`, carries the company id and whether a settled payment is
 * there to be refunded: no tenant, no name, no address.
 */
export function abandonFormedCompany(
  deps: Pick<CreateCompanyDeps, "companies" | "parties" | "requests" | "payment" | "transaction">,
  tenantId: string,
  companyId: string,
): void {
  const outcome = deps.transaction(() => {
    const company = deps.companies.findOwned(tenantId, companyId);
    if (company === undefined) throw new ApiError("not_found", 404, "company not found");
    // 'doola' is the formation provider, as `countChargeableFormedLegalBodies` counts it.
    if (company.provider !== "doola" || company.purposeKind !== "legal_body")
      throw conflict("only a company formed for a legal body can be abandoned this way");
    if (company.status !== "draft" && company.status !== "ready")
      throw conflict("this company is already abandoned");

    const steps = deps.requests.stepsOf(companyId);
    if (steps.some((row) => row.step === "create_provider" && row.state === "submitted"))
      throw conflict("the filing is being sent: try again in a minute");
    if (filingStarted(steps)) throw conflict(FILING_STARTED);

    // The payment rows: a deployment that took one always reads them (the composition root wires
    // the payment block everywhere). Without the block, a company that holds one is kept.
    const payments = deps.payment?.payments;
    if (payments === undefined && deps.companies.hasLiveOrSettledPayment(companyId))
      throw conflict("this company has a payment this deployment cannot read: write to us");
    const live = payments?.findLive(companyId, FORMATION_PRODUCT);
    // A transfer in flight: expiring its row would write off money that may be moving.
    if (live?.status === "settling")
      throw conflict("a payment is being settled: try again in a minute");
    const hadSettledPayment =
      payments?.listByCompany(companyId).some((row) => row.status === "settled") ?? false;

    for (const row of steps) {
      if (row.state === "abandoned") continue;
      if (
        !deps.requests.transition(companyId, row.step, row.state, "abandoned", {
          error: "tenant_abandoned",
        })
      )
        throw conflict("this company changed while it was being abandoned");
    }
    // Only a `quoted` quote: nothing has been signed and sent for it, so nothing can be moving.
    if (live?.status === "quoted" && !payments?.markExpired(live.paymentId, "quoted"))
      throw conflict("this company changed while it was being abandoned");
    if (!deps.companies.setStatus(companyId, company.status, "abandoned"))
      throw conflict("this company changed while it was being abandoned");
    // Thrown, so every write above rolls back with it: an abandoned company must not keep its
    // responsible person's data because the erasure failed.
    const party = deps.parties.findByCompanyId(companyId);
    if (party !== undefined && !deps.parties.erase(party.partyId))
      throw new Error(`company ${companyId}: its party could not be erased`);
    return {
      hadSettledPayment,
      expiredPaymentId: live?.status === "quoted" ? live.paymentId : undefined,
    };
  });

  if (outcome.expiredPaymentId !== undefined)
    opsLog("formation_payment_expired", {
      companyId,
      paymentId: outcome.expiredPaymentId,
      reason: "tenant_abandoned",
    });
  opsLog("formation_abandoned_by_tenant", {
    companyId,
    hadSettledPayment: outcome.hadSettledPayment,
  });
}
