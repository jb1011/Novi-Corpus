/** Tier-0 custody availability — the one place the "not available on this deployment" wording
 *  lives, so the REST /onboard gate and the MCP onboard_agent gate can never drift apart
 *  (both surfaces must stay behaviorally identical; tests regex-match these messages). */
export type WalletProvider = "turnkey" | "circle";

export function custodyUnavailableMessage(provider: WalletProvider): string {
  return provider === "circle"
    ? "circle custody is not available on this deployment (Circle credentials/wallet set not configured)"
    : "turnkey custody is not available on this deployment (Turnkey credentials not configured)";
}

/** The onboard doors' refusal on a Minimal-only deployment (no FACTORY_ADDRESS). Kept beside the
 *  custody messages for the same reason: REST, MCP and the CLI must say the same thing. */
export function fullProductUnavailableMessage(): string {
  return "full-product onboarding is not available on this deployment: it has no full-product factory; use the legal-body routes";
}
