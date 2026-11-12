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

/** A narrow set of choices: two kinds of act allowed, one heavy act with the guardian's signature,
 *  two alone up to an amount, the last not allowed, only counterparties with an active legal body,
 *  until a fixed day. */
export const B: GrantChoices = {
  acts: {
    provideServices: { allowed: true, perAct: 1_250_000, above: "not_allowed" },
    acceptEngagement: { allowed: false },
    issueInvoice: { allowed: false },
    receivePayment: { allowed: false },
    buy: { allowed: false },
    pay: { allowed: true, perAct: 1, per30Days: 1, above: "guardian_signature" },
    engageContractor: { allowed: false },
  },
  heavyActs: {
    employ: { mode: "alone", perAct: 3000 },
    borrow: { mode: "guardian_signature" },
    guarantee: { mode: "alone", perAct: 1 },
    transferProperty: { mode: "not_allowed" },
  },
  counterparties: "active_legal_body",
  endsOn: "2027-12-31",
};
