/**
 * The formed door's rules shared by its two readers: `createCompany`, which creates a company for
 * a legal body, and `/config.legalBodies.formedDoor`, which tells the web app whether to show the
 * door. One function per rule, so the door and what the deployment advertises cannot disagree.
 */
import { opsLog } from "../observability/opsLog";
import type { CompanyRepository } from "../persistence/companyRepository";

/**
 * The environment the formed door runs under: production when the doola pin OR the network is
 * production.
 *
 * Either one is enough. A doola production pin files real Wyoming companies, whatever network the
 * box runs on; a production network (`legalBodyEnvironment(cfg)`) creates real legal bodies,
 * whatever doola is pinned to. Only a box where both are sandbox runs the door's sandbox rules,
 * and any value but `sandbox` is held to the production rule.
 */
export function formedDoorEnvironment(
  pin: "sandbox" | "production",
  network: "sandbox" | "production",
): "sandbox" | "production" {
  return pin === "sandbox" && network === "sandbox" ? "sandbox" : "production";
}

/**
 * `formedDoorEnvironment` of a door's deps (`CreateCompanyDeps`, or the create door's deps a
 * re-quote reads): doola's pin, and the network's environment, which reads as the pin's when
 * absent. The one place the formed door's environment is computed.
 */
export function formedDoorEnvironmentOf(deps: {
  pin: { environment: "sandbox" | "production" };
  legalBodyEnvironment?: "sandbox" | "production";
}): "sandbox" | "production" {
  return formedDoorEnvironment(
    deps.pin.environment,
    deps.legalBodyEnvironment ?? deps.pin.environment,
  );
}

/**
 * Whether the formed door has taken every company it takes: production only; a sandbox forms demo
 * companies without number. `maxTotal` undefined = no cap.
 *
 * The count is `countChargeableFormedLegalBodies`: formed legal-body companies that are `ready` or
 * carry a live quote, over every tenant, so a draft nobody pays for and an abandoned company take
 * no place, and a company for agents is never counted. Neither a sandbox nor an absent cap reads
 * the count. `createCompany` asks it twice (after the per-tenant quota, and again inside the mint
 * transaction); `/config.legalBodies.formedDoor` asks it once, last, under production.
 */
export function formedCapReached(
  companies: Pick<CompanyRepository, "countChargeableFormedLegalBodies">,
  maxTotal: number | undefined,
  door: "sandbox" | "production",
): boolean {
  if (door === "sandbox" || maxTotal === undefined) return false;
  return companies.countChargeableFormedLegalBodies() >= maxTotal;
}

/**
 * The ops line of a write the total cap refused, one per refusal. `check` says which check
 * refused it: `count`, the create's check after the per-tenant quota; `mint`, the create's
 * re-check inside its transaction; `requote`, a re-quote that would bring a draft back into the
 * count. The cap and the count only: no tenant, no name. Named `check` rather than `at`, which is
 * the line's own timestamp (`opsLog`).
 */
export function logFormedCapReached(
  companies: Pick<CompanyRepository, "countChargeableFormedLegalBodies">,
  maxTotal: number | undefined,
  check: "count" | "mint" | "requote",
): void {
  opsLog("formation_cap_reached", {
    level: "warn",
    check,
    maxTotal,
    counted: companies.countChargeableFormedLegalBodies(),
  });
}
