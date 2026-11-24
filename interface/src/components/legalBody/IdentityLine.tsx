import type { AgentWalletRead } from "@/lib/legalBody/agentWallet";
import { agentWalletLineText } from "@/lib/legalBody/agentWalletStep";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

/**
 * "Your agent's identity" and its agent id, near the top of the link and pointer steps, where a
 * person looks for the id once it is chosen. Nothing is shown until the step knows the id
 * (`identityOnStep`).
 */
export function IdentityLine({ agentId }: { agentId: string | null }) {
  if (agentId === null) return null;
  return (
    <p className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-muted-2">
        {LEGAL_BODY_COPY.identity.yourIdentity}
      </span>
      <span className="break-all font-mono text-[13.5px] text-ink">{agentId}</span>
    </p>
  );
}

/**
 * "This agent's wallet: {address}", under the identity's line on the link screens, once the
 * registry names a wallet for the agent. Nothing for none, a read that failed, or no read yet.
 */
export function AgentWalletLine({ wallet }: { wallet: AgentWalletRead | null }) {
  const line = agentWalletLineText(wallet);
  if (line === null) return null;
  return <p className="-mt-4 mb-6 break-all font-mono text-[12.5px] text-muted">{line}</p>;
}
