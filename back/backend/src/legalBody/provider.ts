/**
 * The provider value of a customer's own company: an existing company its guardian declared,
 * rather than one filed through formation. It is what `companies.provider` holds for such a row.
 *
 * It lives in a module that imports nothing, so any layer can read it. The workflow layer must
 * never reach the API layer, not even through the imports of a module it imports, and the module
 * that creates a customer's company does import the API layer.
 */
export const CUSTOMER_PROVIDER = "customer";

/** Where a company standing behind a legal body came from, as its statement and its agreement's
 *  manifest say it: `customer` for a customer's own company, `novi` for one Novi formed. */
export type CompanySource = "customer" | "novi";

/** The source of a company of this provider: `customer` for a customer's own, `novi` for any
 *  other, a company filed through formation. */
export function companySourceOf(provider: string): CompanySource {
  return provider === CUSTOMER_PROVIDER ? "customer" : "novi";
}
