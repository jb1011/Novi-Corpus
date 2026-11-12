/**
 * The entrance in front of a new company: which door, and the two answers that preselect the
 * identity step. Pure. Nothing here reads a clock or a store.
 */
import type { DoorChoice, IdentityChoice, LegalBodyMemory, OwnerChoice } from "@/lib/legalBody/storage";

export type FormedDoorFlag = "offered" | "cap_reached" | "hidden";

export type EntranceOffer =
  | { kind: "skip" }
  | { kind: "ask"; canForm: boolean; capReached: boolean };

/** `hidden` and a backend that does not say skip the entrance. The declared door shows. */
export function entranceOffer(flag: FormedDoorFlag | undefined): EntranceOffer {
  if (flag === "offered") return { kind: "ask", canForm: true, capReached: false };
  if (flag === "cap_reached") return { kind: "ask", canForm: false, capReached: true };
  return { kind: "skip" };
}

const AGENT_ID = /^(?:0|[1-9][0-9]{0,77})$/;

export type EntranceAnswers = {
  door: DoorChoice;
  identityChoice: IdentityChoice;
  signer: OwnerChoice;
  /** What they typed. Kept only when it is an identity number and they said the agent has one. */
  agentId: string;
};

/** The memory patch for one set of answers. A formed door at the cap cannot be chosen. */
export function entranceMemory(
  answers: EntranceAnswers,
  offer: EntranceOffer,
): Pick<LegalBodyMemory, "door" | "identityChoice" | "signer" | "suggestedAgentId"> {
  const door = offer.kind === "ask" && !offer.canForm ? "declare" : answers.door;
  const agentId = answers.agentId.trim();
  return {
    door,
    identityChoice: answers.identityChoice,
    signer: answers.signer,
    suggestedAgentId:
      answers.identityChoice === "has-one" && AGENT_ID.test(agentId) ? agentId : null,
  };
}
