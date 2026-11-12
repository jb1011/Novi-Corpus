import { getAddress } from "viem";
import { expect, test } from "vitest";
import {
  buildAgreement,
  readVerifiedAgreement,
  storeAgreement,
} from "../../src/legalBody/agreement";
import { buildGrant, grantDigest, renderScheduleA } from "../../src/legalBody/grant";
import { LEGAL_BODY_CHARTER } from "../../src/legalBody/texts/legalBodyCharter";
import type { AgreementFields } from "../../src/legalBody/texts/operatingAgreement";
import { computeOaHash } from "../../src/oa/generator";
import { MemoryDocumentStore } from "../helpers/formationFakes";
import { A } from "../helpers/grantFixtures";

/** Invented company values, and addresses derived from anvil's published test keys only. */
const GUARDIAN = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const FACTORY = getAddress("0x5fbdb2315678afecb367f032d93f642f64180aa3");
const REGISTRY = getAddress("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");

const FIELDS: AgreementFields = {
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  jurisdiction: "WY",
  guardian: GUARDIAN,
  amendmentDelaySeconds: 172_800,
  chainId: 31_337,
  factory: FACTORY,
  identityRegistry: REGISTRY,
};

const grant = buildGrant(A, { number: 1, version: 1 });
const built = (scheduleA: string) =>
  buildAgreement({ ...FIELDS, scheduleA }, LEGAL_BODY_CHARTER, { source: "customer" });

test("the manifest hash the guardian adopts commits to the grant", () => {
  const a = built(renderScheduleA(grant));
  expect(a.manifestHash).toBe("0xa93d1303350208d003ae61ae76d0d2ddbc002a8ec8ae6605a86ce32fddb0b481");
  expect(a.termsDoc).toContain(`Grant 1, version 1. Digest ${grantDigest(grant)}.`);
  expect(JSON.parse(a.manifest).terms).toMatchObject({
    textId: "legal-body-operating-agreement",
    textVersion: "2026-11-draft-2",
    textStatus: "draft",
    hash: computeOaHash(a.termsDoc),
  });
});

test("one USDC more in one limit is another agreement", () => {
  const changed = structuredClone(A);
  (changed.acts.pay as { perAct: number }).perAct = 201;
  const b = built(renderScheduleA(buildGrant(changed, { number: 1, version: 1 })));
  expect(b.manifestHash).toBe("0xb40af922e24d57c93e2a66f176ac05704cef1075d30a0aa2574f5880afc7c3ed");
});

test("the stored Charter reads back as the agreement it was frozen with", () => {
  const store = new MemoryDocumentStore();
  const a = built(renderScheduleA(grant));
  storeAgreement(store, "lb_00000000-0000-4000-8000-000000000001", a);
  const read = readVerifiedAgreement(
    store,
    "lb_00000000-0000-4000-8000-000000000001",
    a.manifestHash,
  );
  expect(read?.termsDoc).toBe(a.termsDoc);
  expect(read?.terms.textVersion).toBe("2026-11-draft-2");
});
