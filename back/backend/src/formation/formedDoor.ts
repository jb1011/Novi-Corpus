/**
 * The formed door's rules shared by its two readers: `createCompany`, which creates a company for
 * a legal body, and `/config.legalBodies.formedDoor`, which tells the web app whether to show the
 * door. One function per rule, so the door and what the deployment advertises cannot disagree.
 */

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
