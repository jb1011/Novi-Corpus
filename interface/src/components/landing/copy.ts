/**
 * Every sentence the home page shows, in one place.
 *
 * The home page leads with the legal body. The treasury and the spending rules are the full
 * product's, named only on its own card (`START_COPY.cards.full`), so no string here says them;
 * no em dash and never "our agents" (`test/landingCopy.test.ts` walks every export).
 */

/** The wizard's steps: the full product's card states them, and the wizard's own test checks it. */
export const ONBOARDING_STEP_COUNT = 8;

export const GET_STARTED_CTA = "Get started";
export const SEE_PATHS_CTA = "See the ways in";
export const TESTNET_TAG = "Testnet";

export const HERO_TITLE = ["A legal body", "for your agent."] as const;
export const HERO_SUB =
  "Today agents are helpers that act through your accounts. With a real Wyoming DAO LLC linked to its on-chain identity, your agent becomes an actor: a verified human is accountable for it, and anyone can check its public record.";

/** The hero's preview card: what a legal body's public record says, no live data. */
export const HERO_RECORD = {
  header: "Legal body · Public record",
  standing: "Standing: active",
  company: "Wyoming DAO LLC",
  identity: "Agent identity on Arc",
  human: "A verified human is accountable",
} as const;

export const PATHS_HEADING = "Choose your way in.";

export const CLOSING_LABEL = "Accountable by design";
export const CLOSING_TITLE = "You stay the accountable human.";
export const CLOSING_BODY =
  "Sign in with your wallet and prove you are one real person with World ID. The legal body is linked to your agent's on-chain identity, and its record is public: anyone can check its standing without an account.";
export const CLOSING_CHIPS = ["World ID verified human", "Linked to an ERC-8004 identity", "A public record anyone can check"] as const;

export const STATS = [
  { value: "World ID", label: "Proof of personhood", detail: "One human per account" },
  { value: "ERC-8004", label: "Agent identity", detail: "The legal body is linked to it on Arc" },
  { value: "Wyoming", label: "A real company", detail: "Formed for the agent, or your own" },
  { value: "Public", label: "Record", detail: "Standing anyone can check" },
] as const;
