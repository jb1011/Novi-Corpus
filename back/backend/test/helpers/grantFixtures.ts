/**
 * Example grant choices the grant tests share. Every amount here is a made-up fixture.
 */
import type { GrantChoices } from "../../src/legalBody/grant";

/** A full set of choices: every kind of act allowed, three heavy acts not allowed and the fourth
 *  only with the guardian's signature, any counterparty, until revoked. */
export const A: GrantChoices = {
  acts: {
    provideServices: { allowed: true, perAct: 2000, above: "guardian_signature" },
    acceptEngagement: { allowed: true, perAct: 2000, above: "guardian_signature" },
    issueInvoice: { allowed: true, perAct: 2000, above: "not_allowed" },
    receivePayment: { allowed: true },
    buy: { allowed: true, perAct: 200, per30Days: 1000, above: "guardian_signature" },
    pay: { allowed: true, perAct: 200, per30Days: 1000, above: "not_allowed" },
    engageContractor: { allowed: true, perAct: 500, per30Days: 1000, above: "guardian_signature" },
  },
  heavyActs: {
    employ: { mode: "not_allowed" },
    borrow: { mode: "not_allowed" },
    guarantee: { mode: "not_allowed" },
    transferProperty: { mode: "guardian_signature" },
  },
  counterparties: "anyone",
  endsOn: null,
};
