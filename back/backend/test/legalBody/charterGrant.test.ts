import { getAddress } from "viem";
import { expect, test } from "vitest";
import {
  buildAgreement,
  readVerifiedAgreement,
  storeAgreement,
} from "../../src/legalBody/agreement";
import { buildGrant } from "../../src/legalBody/grant";
import { LEGAL_BODY_CHARTER_2026_11_DRAFT_4 } from "../../src/legalBody/texts/legalBodyCharter";
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
  buildAgreement({ ...FIELDS, scheduleA }, LEGAL_BODY_CHARTER_2026_11_DRAFT_4, {
    source: "customer",
  });

test("the manifest hash the guardian adopts commits to the grant", () => {
  const a = built(grant.scheduleA);
  expect(a.manifestHash).toBe("0x62f09c16ecf045d5c6452f4ec51df1b05cf6eb65817b75b6d6afa0e9475f6584");
  expect(a.termsDoc).toContain(`Grant 1, version 1. Digest ${grant.digest}.`);
  expect(JSON.parse(a.manifest).terms).toMatchObject({
    textId: "legal-body-operating-agreement",
    textVersion: "2026-11-draft-4",
    textStatus: "draft",
    hash: computeOaHash(a.termsDoc),
  });
});

test("one dollar more in one limit is another agreement", () => {
  const changed = structuredClone(A);
  (changed.acts.pay as { perAct: number }).perAct = 201;
  const b = built(buildGrant(changed, { number: 1, version: 1 }).scheduleA);
  expect(b.manifestHash).toBe("0x71e3796895c66a04ae25a641e352533cae9a8bb6b8dae2851f99a1fa34940404");
});

test("the stored Charter reads back as the agreement it was frozen with", () => {
  const store = new MemoryDocumentStore();
  const a = built(grant.scheduleA);
  storeAgreement(store, "lb_00000000-0000-4000-8000-000000000001", a);
  const read = readVerifiedAgreement(
    store,
    "lb_00000000-0000-4000-8000-000000000001",
    a.manifestHash,
  );
  expect(read?.termsDoc).toBe(a.termsDoc);
  expect(read?.terms.textVersion).toBe("2026-11-draft-4");
});
