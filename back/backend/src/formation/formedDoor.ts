/**
 * The formed door's rules shared by its two readers: `createCompany`, which creates a company for
 * a legal body, and `/config.legalBodies.formedDoor`, which tells the web app whether to show the
 * door. One function per rule, so the door and what the deployment advertises cannot disagree.
 */
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
