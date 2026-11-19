/**
 * A company as the test page lists it: the facts a tenant's company view serves, shown raw.
 *
 * `declared.wordingAccepted` says whether the deployment places an order on a declaration of that
 * wording. A backend that does not serve the key yet is told apart from one that serves `null`:
 * the page shows which, and works either way. The key is read here as untrusted JSON, so the
 * shared `CompanyView` type stays as it is.
 */
import type { CompanyView } from "@/lib/api/types";

/** A customer's own company: one its Guardian declared. */
export function isDeclaredCompany(company: CompanyView): boolean {
  return company.provider === "customer" || (company.declared !== undefined && company.declared !== null);
}

/**
 * `declared.wordingAccepted` as the page shows it: `true`, `false` or `null` as served,
 * `not served` when the answer has no such key, and `no declaration` when `declared` is absent or
 * null. A value that is none of the three served ones is shown as `unreadable`.
 */
export function wordingAcceptedShown(
  company: CompanyView,
): "true" | "false" | "null" | "not served" | "no declaration" | "unreadable" {
  const declared: unknown = company.declared;
  if (typeof declared !== "object" || declared === null) return "no declaration";
  if (!Object.hasOwn(declared, "wordingAccepted")) return "not served";
  const value = (declared as { wordingAccepted?: unknown }).wordingAccepted;
  if (value === true) return "true";
  if (value === false) return "false";
  if (value === null) return "null";
  return "unreadable";
}
