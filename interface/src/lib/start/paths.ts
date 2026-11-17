import type { PublicConfig } from "@/lib/api/types";
import { isOnboardingComplete, type PersistedOnboarding } from "@/lib/onboarding/storage";

/**
 * Whether this deployment offers the full product, read from `GET /config`.
 *
 * Only an explicit answer decides. `true` is "offered" and `false` is "not_offered"; an absent
 * field (a backend that predates it), a config still loading and a config that could not be read
 * are all "unknown", and a screen treats "unknown" as it did before the field existed.
 */
export type FullProductGate = "offered" | "not_offered" | "unknown";

export function fullProductGate(
  config: Pick<PublicConfig, "fullProductAvailable"> | undefined,
): FullProductGate {
  if (config?.fullProductAvailable === true) return "offered";
  if (config?.fullProductAvailable === false) return "not_offered";
  return "unknown";
}

/** The three ways in: form a company, bring your own company, the full product. */
export type PathId = "form" | "declare" | "full";

/**
 * One card on the choice screen. `full_up` is the form card when every place is taken: it stays
 * on the screen, so the person learns the path exists, and it is never preselected.
 */
export type PathCard = { id: PathId; state: "offered" | "full_up" };

/**
 * The cards this deployment offers, always in the order form, declare, full.
 *
 * Each card stands on one explicit value from `/config` and on nothing else: a field a backend
 * does not send, or a legal-body config that is not available, produces no card. The smaller
 * truth is the honest one while the config says nothing.
 */
export function pathCards(
  config: Pick<PublicConfig, "fullProductAvailable" | "legalBodies"> | null | undefined,
): PathCard[] {
  const cards: PathCard[] = [];
  const legalBodies = config?.legalBodies;
  if (legalBodies?.available === true) {
    if (legalBodies.formedDoor === "offered") cards.push({ id: "form", state: "offered" });
    else if (legalBodies.formedDoor === "cap_reached") cards.push({ id: "form", state: "full_up" });
    if (legalBodies.declarations === true) cards.push({ id: "declare", state: "offered" });
  }
  if (config?.fullProductAvailable === true) cards.push({ id: "full", state: "offered" });
  return cards;
}

/**
 * The paths the home page names. Before its config arrives (or when it cannot be read) the home
 * page describes the two legal-body paths, which is what the product is; once a config is there
 * it says exactly what `pathCards` says.
 */
export function landingPaths(config: PublicConfig | null): PathCard[] {
  if (config === null) {
    return [
      { id: "form", state: "offered" },
      { id: "declare", state: "offered" },
    ];
  }
  return pathCards(config);
}

/** The card to open with: the one asked for when it is offered, else the first offered one. */
export function preselectedPath(cards: readonly PathCard[], wanted: PathId | null): PathId | null {
  const offered = cards.filter((card) => card.state === "offered");
  if (wanted !== null && offered.some((card) => card.id === wanted)) return wanted;
  return offered[0]?.id ?? null;
}

/**
 * An address parameter, checked against the closed set of three names. Case, spaces and any
 * other text are refused rather than guessed at.
 */
export function parsePathParam(value: string | null): PathId | null {
  return value === "form" || value === "declare" || value === "full" ? value : null;
}

/**
 * Whether this deployment says it is a test one. Only an explicit `"sandbox"` counts: on the
 * legal-body config when it is available, or on formation. Absent, null and production are not.
 */
export function isTestDeployment(config: PublicConfig | null): boolean {
  const legalBodies = config?.legalBodies;
  if (legalBodies?.available === true && legalBodies.environment === "sandbox") return true;
  return config?.formationEnvironment === "sandbox";
}

/**
 * Where the full-product card leads. A wizard stored past its first phase and not finished is
 * resumed; nothing stored, a wizard still on its first phase and a finished one start a new one,
 * so a finished agent is never reopened as if it were in progress.
 */
export function fullProductHref(
  stored: PersistedOnboarding | null,
): "/onboarding" | "/onboarding?new=1" {
  if (stored && stored.phase !== "welcome" && !isOnboardingComplete(stored)) return "/onboarding";
  return "/onboarding?new=1";
}

/** What the start page shows once the person is through the gate. */
export type StartDestination =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "none" }
  | { kind: "full_only" }
  | { kind: "choice"; cards: PathCard[] };

/**
 * The start page's decision. A config still loading or one that could not be read decides
 * nothing; a ready one with a legal-body card is the choice among all the cards, with the full
 * product alone is that product, and with no card is a deployment that offers no way in.
 */
export function startDestination(answer: {
  status: "loading" | "error" | "ready";
  config: PublicConfig | undefined;
}): StartDestination {
  if (answer.status === "loading") return { kind: "loading" };
  if (answer.status === "error") return { kind: "error" };
  const cards = pathCards(answer.config);
  if (cards.some((card) => card.id === "form" || card.id === "declare")) {
    return { kind: "choice", cards };
  }
  if (cards.some((card) => card.id === "full")) return { kind: "full_only" };
  return { kind: "none" };
}
