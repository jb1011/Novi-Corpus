/**
 * The adoption's typed data on the Charter flow's test page: both forms the server serves, checked
 * against what is on screen before a wallet opens, and the form wagmi signs.
 *
 * `GOLDEN` is a whole example of the form with words, as the adoption message door serves it, with
 * its digest and the signature of the Guardian's key. Every value is made up: the chain id and the
 * factory are test values, and the Guardian is anvil's published test account #2. The backend pins
 * the same example in its own suite, so a wallet that signs what this gate hands to wagmi signs
 * the digest the server checks.
 */
import { hashTypedData, recoverAddress } from "viem";
import { describe, expect, test, vi } from "vitest";
import type { UseSignTypedDataReturnType } from "wagmi";
import type { Address, Hex, LegalBodyAgreement, LegalBodyOrderView } from "@/lib/api/types";
import { ADOPTION_FIELDS, EIP712_DOMAIN_FIELDS } from "@/lib/api/types";
import {
  ADOPTION_DOMAIN_NAME,
  CHARTER_ADOPTION_FIELDS,
  CHARTER_ADOPTION_TYPE,
  PLAIN_ADOPTION_TYPE,
  adoptionSignGate,
  type AdoptionGateContext,
  type WagmiAdoptionTypedData,
} from "@/lib/charterTest/adoptionGate";
import { signThroughGate } from "@/lib/legalBody/signGate";

const STATEMENT =
  "I control the wallet this message names as guardian, and I am the only member of the Company named in the Legal Body Charter that the manifest hash in this message commits to. For the Company, I adopt that Charter, with the grants set out in its Schedule A, as a supplement to the Company's operating agreement. I intend this signature as a signature, made by electronic means, and as the Company's written and signed adoption of that Charter. I confirm each point of its section 13.";

const CHAIN = 31337;
const FACTORY: Address = "0x00000000000000000000000000000000000fAc70";
const GUARDIAN: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ORDER_ID = "lb_00000000-0000-4000-8000-000000000001";
const MANIFEST_HASH: Hex = "0xb744fe1df70acc897080d737cf655b329c52cf33e105bd9c96b3066a951b6f11";
const SIX_FIELD_DIGEST = "0x8a1f80ac176074b2a236be87822965db5815399f91e9d536109e03cd07eadff1";

const GOLDEN = {
  typedData: {
    domain: {
      name: "Novi Corpus Operating Agreement Adoption",
      version: "1",
      chainId: CHAIN,
      verifyingContract: FACTORY,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      LegalBodyCharterAdoption: [
        { name: "statement", type: "string" },
        { name: "orderId", type: "string" },
        { name: "manifestHash", type: "bytes32" },
        { name: "textId", type: "string" },
        { name: "textVersion", type: "string" },
        { name: "guardian", type: "address" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "LegalBodyCharterAdoption",
    message: {
      statement: STATEMENT,
      orderId: ORDER_ID,
      manifestHash: MANIFEST_HASH,
      textId: "legal-body-operating-agreement",
      textVersion: "2026-11-draft-5",
      guardian: GUARDIAN,
      issuedAt: "1800000000",
    },
  },
  digest: "0x47b917f5f622fc8bdebb9314275eba21d7f3c87d149cc9e43ea30662c74a75d4",
  signature:
    "0xfa469fa20726128ce30e05da78cc359a76521c67d5ecd9a21ae1a58c578f48bb1a18bf67fc002d295fcf7708e4b780465fd8c91175eb2dd1761490b7074979111b",
} as const;

/** A deep copy with no `readonly`, so a test can break one thing in it. */
type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const copy = (v: unknown): Loose => JSON.parse(JSON.stringify(v)) as Loose;

/** The adoption message door's answer in the form with words. */
const servedInWords = (): Loose => ({ typedData: copy(GOLDEN.typedData), issuedAt: "1800000000" });

/** The same order's answer in the six fields alone. */
function servedPlain(): Loose {
  const { statement: _statement, ...six } = copy(GOLDEN.typedData.message);
  void _statement;
  return {
    typedData: {
      domain: copy(GOLDEN.typedData.domain),
      types: {
        EIP712Domain: copy(GOLDEN.typedData.types.EIP712Domain),
        OperatingAgreementAdoption: copy(GOLDEN.typedData.types.LegalBodyCharterAdoption).slice(1),
      },
      primaryType: "OperatingAgreementAdoption",
      message: six,
    },
    issuedAt: "1800000000",
  };
}

const order: AdoptionGateContext["order"] = {
  id: ORDER_ID,
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  agreement: { hash: MANIFEST_HASH, version: 1 },
} satisfies Pick<LegalBodyOrderView, "id" | "chainId" | "factory" | "guardian" | "agreement">;

const agreementInWords: AdoptionGateContext["agreement"] = {
  manifestHash: MANIFEST_HASH,
  textId: "legal-body-operating-agreement",
  textVersion: "2026-11-draft-5",
  adoptionStatement: STATEMENT,
} satisfies Pick<LegalBodyAgreement, "manifestHash" | "textId" | "textVersion" | "adoptionStatement">;

const agreementPlain: AdoptionGateContext["agreement"] = { ...agreementInWords, adoptionStatement: null };

const ctxInWords: AdoptionGateContext = { order, agreement: agreementInWords, sessionAddress: GUARDIAN };
const ctxPlain: AdoptionGateContext = { order, agreement: agreementPlain, sessionAddress: GUARDIAN };

/** The gate's typed data, or a failed test. */
function opened(served: unknown, ctx: AdoptionGateContext): WagmiAdoptionTypedData {
  const gate = adoptionSignGate(served, ctx);
  if (!gate.ok) throw new Error(`the gate refused: ${gate.problem}`);
  return gate.typedData;
}

const problemOf = (served: unknown, ctx: AdoptionGateContext): string | null => {
  const gate = adoptionSignGate(served, ctx);
  return gate.ok ? null : gate.problem;
};

describe("the pinned values", () => {
  test("the domain's name and the two primary types", () => {
    expect(ADOPTION_DOMAIN_NAME).toBe("Novi Corpus Operating Agreement Adoption");
    expect(PLAIN_ADOPTION_TYPE).toBe("OperatingAgreementAdoption");
    expect(CHARTER_ADOPTION_TYPE).toBe("LegalBodyCharterAdoption");
  });

  test("the form with words has the words, then the six fields", () => {
    expect(CHARTER_ADOPTION_FIELDS).toEqual(GOLDEN.typedData.types.LegalBodyCharterAdoption);
    expect(CHARTER_ADOPTION_FIELDS.slice(1)).toEqual(ADOPTION_FIELDS);
    expect(GOLDEN.typedData.types.EIP712Domain).toEqual(EIP712_DOMAIN_FIELDS);
  });
});

describe("the form with words", () => {
  test("the served example passes, and wagmi's form is its fields with issuedAt as a bigint", () => {
    expect(opened(servedInWords(), ctxInWords)).toEqual({
      domain: GOLDEN.typedData.domain,
      types: { LegalBodyCharterAdoption: CHARTER_ADOPTION_FIELDS },
      primaryType: "LegalBodyCharterAdoption",
      message: { ...GOLDEN.typedData.message, issuedAt: BigInt(1_800_000_000) },
    });
  });

  test("a wallet that signs wagmi's form signs the served digest", async () => {
    const typedData = opened(servedInWords(), ctxInWords);
    if (typedData.primaryType !== CHARTER_ADOPTION_TYPE) throw new Error("not the form with words");
    const digest = hashTypedData(typedData);
    expect(digest).toBe(GOLDEN.digest);
    expect(digest).not.toBe(SIX_FIELD_DIGEST);
    expect(await recoverAddress({ hash: digest, signature: GOLDEN.signature })).toBe(GUARDIAN);
  });

  test("the served form, hashed as it arrives, is the same digest", () => {
    // Untyped on purpose: this is the JSON a wallet receives, with `EIP712Domain` declared and
    // every uint256 a decimal string.
    const asReceived = copy(GOLDEN.typedData) as Parameters<typeof hashTypedData>[0];
    expect(hashTypedData(asReceived)).toBe(GOLDEN.digest);
  });

  test("the words are the ones the agreement's answer served, to the character", () => {
    expect(problemOf(servedInWords(), { ...ctxInWords, agreement: { ...agreementInWords, adoptionStatement: `${STATEMENT} ` } })).toBe("statement");
    const other = servedInWords();
    other.typedData.message.statement = STATEMENT.replace("only member", "a member");
    expect(problemOf(other, ctxInWords)).toBe("statement");
    const notText = servedInWords();
    notText.typedData.message.statement = 7;
    expect(problemOf(notText, ctxInWords)).toBe("statement");
  });
});

describe("the six fields alone", () => {
  test("the served form passes for an agreement that shows no words of adoption", () => {
    const typedData = opened(servedPlain(), ctxPlain);
    expect(typedData).toEqual({
      domain: GOLDEN.typedData.domain,
      types: { OperatingAgreementAdoption: ADOPTION_FIELDS },
      primaryType: "OperatingAgreementAdoption",
      message: {
        orderId: ORDER_ID,
        manifestHash: MANIFEST_HASH,
        textId: "legal-body-operating-agreement",
        textVersion: "2026-11-draft-5",
        guardian: GUARDIAN,
        issuedAt: BigInt(1_800_000_000),
      },
    });
    if (typedData.primaryType !== PLAIN_ADOPTION_TYPE) throw new Error("not the six fields alone");
    expect(hashTypedData(typedData)).toBe(SIX_FIELD_DIGEST);
  });

  test("an agreement's answer with no `adoptionStatement` key shows no words", () => {
    const { adoptionStatement: _none, ...withoutKey } = agreementPlain;
    void _none;
    expect(problemOf(servedPlain(), { ...ctxPlain, agreement: withoutKey })).toBe(null);
  });
});

describe("the form is the one the agreement on screen calls for", () => {
  test("six fields served where words were shown", () => {
    expect(problemOf(servedPlain(), ctxInWords)).toBe("form_mismatch");
  });

  test("words served where none were shown", () => {
    expect(problemOf(servedInWords(), ctxPlain)).toBe("form_mismatch");
  });

  test.each([["LegalBodyLink"], ["StatementOfAuthority"], [""], [undefined], [7]])(
    "a primary type that is neither form (%j)",
    (primaryType) => {
      const served = servedInWords();
      served.typedData.primaryType = primaryType;
      expect(problemOf(served, ctxInWords)).toBe("primary_type");
    },
  );
});

describe("each rule, broken once, in the form with words", () => {
  const breaks: [string, (s: Loose) => void][] = [
    ["answer_keys", (s) => { s.extra = 1; }],
    ["answer_keys", (s) => { delete s.issuedAt; }],
    ["primary_type", (s) => { s.typedData = null; }],
    ["typed_data_keys", (s) => { s.typedData.extra = 1; }],
    ["types_keys", (s) => { s.typedData.types.Other = []; }],
    ["types_keys", (s) => { delete s.typedData.types.EIP712Domain; }],
    ["adoption_fields", (s) => { s.typedData.types.LegalBodyCharterAdoption.shift(); }],
    ["adoption_fields", (s) => { s.typedData.types.LegalBodyCharterAdoption.reverse(); }],
    ["adoption_fields", (s) => { s.typedData.types.LegalBodyCharterAdoption[0].type = "bytes"; }],
    ["adoption_fields", (s) => { s.typedData.types.LegalBodyCharterAdoption[1].extra = 1; }],
    ["domain_fields", (s) => { s.typedData.types.EIP712Domain.pop(); }],
    ["domain_keys", (s) => { s.typedData.domain.salt = "0x00"; }],
    ["domain_name", (s) => { s.typedData.domain.name = "Novi LegalBodyFactory"; }],
    ["domain_name", (s) => { s.typedData.domain.version = "2"; }],
    ["domain_chain", (s) => { s.typedData.domain.chainId = 5042002; }],
    ["domain_chain", (s) => { s.typedData.domain.chainId = "31337"; }],
    ["domain_factory", (s) => { s.typedData.domain.verifyingContract = GUARDIAN; }],
    ["message_keys", (s) => { s.typedData.message.extra = 1; }],
    ["message_keys", (s) => { delete s.typedData.message.statement; }],
    ["order_id", (s) => { s.typedData.message.orderId = "lb_00000000-0000-4000-8000-000000000002"; }],
    ["manifest_hash", (s) => { s.typedData.message.manifestHash = `0x${"00".repeat(32)}`; }],
    ["manifest_hash", (s) => { s.typedData.message.manifestHash = "0xb744"; }],
    ["text", (s) => { s.typedData.message.textId = "another-text"; }],
    ["text", (s) => { s.typedData.message.textVersion = "2026-10-draft-1"; }],
    ["guardian", (s) => { s.typedData.message.guardian = FACTORY; }],
    ["issued_at", (s) => { s.typedData.message.issuedAt = "1800000001"; }],
    ["issued_at", (s) => { s.typedData.message.issuedAt = 1800000000; }],
    ["issued_at", (s) => { s.typedData.message.issuedAt = "01800000000"; s.issuedAt = "01800000000"; }],
    ["issued_at", (s) => { s.issuedAt = "1800000001"; }],
  ];

  test.each(breaks)("%s", (problem, breakIt) => {
    const served = servedInWords();
    breakIt(served);
    expect(problemOf(served, ctxInWords)).toBe(problem);
  });

  test("the unbroken example passes", () => {
    expect(problemOf(servedInWords(), ctxInWords)).toBe(null);
  });
});

describe("what is on screen, changed once", () => {
  test("another order", () => {
    expect(problemOf(servedInWords(), { ...ctxInWords, order: { ...order, id: "lb_other" } })).toBe("order_id");
  });

  test("an order on another chain or factory", () => {
    expect(problemOf(servedInWords(), { ...ctxInWords, order: { ...order, chainId: 5042002 } })).toBe("domain_chain");
    expect(problemOf(servedInWords(), { ...ctxInWords, order: { ...order, factory: GUARDIAN } })).toBe("domain_factory");
  });

  test("an order that froze another hash, or none", () => {
    const otherHash: Hex = `0x${"11".repeat(32)}`;
    expect(problemOf(servedInWords(), { ...ctxInWords, order: { ...order, agreement: { hash: otherHash, version: 1 } } })).toBe("manifest_hash");
    expect(problemOf(servedInWords(), { ...ctxInWords, order: { ...order, agreement: null } })).toBe("manifest_hash");
  });

  test("an agreement read with another hash, id or version", () => {
    const otherHash: Hex = `0x${"11".repeat(32)}`;
    expect(problemOf(servedInWords(), { ...ctxInWords, agreement: { ...agreementInWords, manifestHash: otherHash } })).toBe("manifest_hash");
    expect(problemOf(servedInWords(), { ...ctxInWords, agreement: { ...agreementInWords, textVersion: "2026-11-draft-4" } })).toBe("text");
  });

  test("a hash in another letter case is the same hash", () => {
    const upper = `0x${MANIFEST_HASH.slice(2).toUpperCase()}` as Hex;
    expect(problemOf(servedInWords(), { ...ctxInWords, agreement: { ...agreementInWords, manifestHash: upper } })).toBe(null);
  });

  test("another wallet in session, or an order of another Guardian", () => {
    expect(problemOf(servedInWords(), { ...ctxInWords, sessionAddress: FACTORY })).toBe("guardian");
    expect(problemOf(servedInWords(), { ...ctxInWords, order: { ...order, guardian: FACTORY } })).toBe("guardian");
  });

  test("the session's address in lower case is the same wallet", () => {
    expect(problemOf(servedInWords(), { ...ctxInWords, sessionAddress: GUARDIAN.toLowerCase() as Address })).toBe(null);
  });
});

describe("an answer that is not typed data never throws", () => {
  test.each([[undefined], [null], ["text"], [7], [[]], [{}], [{ typedData: "x", issuedAt: "1" }], [{ typedData: [], issuedAt: "1" }]])(
    "%j is a refusal",
    (served) => {
      expect(adoptionSignGate(served, ctxInWords).ok).toBe(false);
    },
  );
});

describe("the wallet opens for an open gate only", () => {
  test("a refused adoption never reaches the wallet", async () => {
    const wallet = vi.fn(async () => GOLDEN.signature as Hex);
    const outcome = await signThroughGate(adoptionSignGate(servedPlain(), ctxInWords), wallet);
    expect(outcome).toEqual({ kind: "refused", problem: "form_mismatch" });
    expect(wallet).not.toHaveBeenCalled();
  });

  test("an accepted adoption reaches it once, with the gate's own typed data", async () => {
    const wallet = vi.fn(async () => GOLDEN.signature as Hex);
    const gate = adoptionSignGate(servedInWords(), ctxInWords);
    const outcome = await signThroughGate(gate, wallet);
    expect(wallet).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      kind: "signed",
      typedData: gate.ok ? gate.typedData : null,
      signature: GOLDEN.signature,
    });
  });
});

/**
 * Type level, run by `tsc --noEmit`: wagmi's `signTypedDataAsync` accepts each form once the
 * primary type is known, as the page calls it. Never called.
 */
declare const sign: UseSignTypedDataReturnType["signTypedDataAsync"];
export async function typeLevel(typedData: WagmiAdoptionTypedData): Promise<Hex> {
  return typedData.primaryType === CHARTER_ADOPTION_TYPE ? sign(typedData) : sign(typedData);
}
