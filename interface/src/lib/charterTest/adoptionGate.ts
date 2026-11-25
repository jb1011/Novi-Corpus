/**
 * The adoption's typed data, checked before a wallet opens, and the form wagmi signs: for the
 * Charter flow's test page, in both forms the server serves.
 *
 * The adoption message door serves one of two forms under one domain, told apart by
 * `primaryType`: `OperatingAgreementAdoption`, six fields, for a text adopted by its fields alone;
 * `LegalBodyCharterAdoption`, the words of adoption then the same six, for a text adopted in
 * words. The server chooses the form from the text the order was frozen with. This gate never
 * chooses: it reads which form was served, and refuses it unless it is the form the agreement on
 * screen calls for (words shown, words signed; none shown, none signed).
 *
 * Every field is then held to what the person has on screen: the order, the hash it froze, the
 * agreement read, the wallet in session, and, in the form with words, the exact words the
 * agreement's answer served (`adoptionStatement`). A refusal names the first rule broken, and
 * nothing is converted: the wallet opens through `signThroughGate` for an open gate only.
 *
 * The served value is read as untrusted JSON: a wrong shape is a refusal, never a throw. The form
 * handed to wagmi holds only values the check found equal to the served ones, with `issuedAt` as
 * a bigint and `EIP712Domain` left out (viem derives the same four fields from the domain). A
 * wallet that signs it signs the served form's digest, which a test checks against a whole
 * example of the form with words.
 */
import type { Address, Hex, LegalBodyAgreement, LegalBodyOrderView } from "@/lib/api/types";
import { ADOPTION_FIELDS, EIP712_DOMAIN_FIELDS } from "@/lib/api/types";
import type { Refusal } from "@/lib/legalBody/chain";
import { sameAddress } from "@/lib/legalBody/flow";
import type { SignGate } from "@/lib/legalBody/signGate";

export const ADOPTION_DOMAIN_NAME = "Novi Corpus Operating Agreement Adoption";
const DOMAIN_VERSION = "1";
export const PLAIN_ADOPTION_TYPE = "OperatingAgreementAdoption";
export const CHARTER_ADOPTION_TYPE = "LegalBodyCharterAdoption";

/** The seven fields of the `LegalBodyCharterAdoption` type string, in its order: the words, then
 *  the six of `ADOPTION_FIELDS`. */
export const CHARTER_ADOPTION_FIELDS = [
  { name: "statement", type: "string" },
  ...ADOPTION_FIELDS,
] as const;

type WagmiDomain = { name: string; version: string; chainId: number; verifyingContract: Address };
type SixFields = {
  orderId: string;
  manifestHash: Hex;
  textId: string;
  textVersion: string;
  guardian: Address;
  issuedAt: bigint;
};

/** The adoption by its six fields alone, as wagmi's `signTypedDataAsync` types it. */
export type WagmiPlainAdoption = {
  domain: WagmiDomain;
  types: { OperatingAgreementAdoption: typeof ADOPTION_FIELDS };
  primaryType: typeof PLAIN_ADOPTION_TYPE;
  message: SixFields;
};
/** The adoption in words, as wagmi's `signTypedDataAsync` types it. */
export type WagmiCharterAdoption = {
  domain: WagmiDomain;
  types: { LegalBodyCharterAdoption: typeof CHARTER_ADOPTION_FIELDS };
  primaryType: typeof CHARTER_ADOPTION_TYPE;
  message: { statement: string } & SixFields;
};
export type WagmiAdoptionTypedData = WagmiPlainAdoption | WagmiCharterAdoption;

/** What the adoption is checked against: the order on screen, the agreement read for it, and the
 *  wallet in session. */
export type AdoptionGateContext = {
  order: Pick<LegalBodyOrderView, "id" | "chainId" | "factory" | "guardian" | "agreement">;
  agreement: Pick<LegalBodyAgreement, "manifestHash" | "textId" | "textVersion" | "adoptionStatement">;
  sessionAddress: Address;
};

type Loose = Record<string, unknown>;
type Field = { readonly name: string; readonly type: string };

const ANSWER_KEYS = ["typedData", "issuedAt"] as const;
const TYPED_DATA_KEYS = ["domain", "types", "primaryType", "message"] as const;
const DOMAIN_KEYS = ["name", "version", "chainId", "verifyingContract"] as const;
const FIELD_KEYS = ["name", "type"] as const;
/** A uint256 in decimal as the backend writes it: no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

const refuse = (problem: string): Refusal => ({ ok: false, problem });

function isRecord(v: unknown): v is Loose {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An object with exactly these own keys, in any order. */
function hasExactKeys(v: unknown, keys: readonly string[]): v is Loose {
  if (!isRecord(v)) return false;
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** Exactly these fields, by name and type and in this order, each `{ name, type }` and no more. */
function hasFields(v: unknown, pinned: readonly Field[]): boolean {
  return (
    Array.isArray(v) &&
    v.length === pinned.length &&
    v.every(
      (f: unknown, i) =>
        hasExactKeys(f, FIELD_KEYS) && f.name === pinned[i].name && f.type === pinned[i].type,
    )
  );
}

/** Two hex values equal in any case. */
const sameHex = (a: unknown, b: unknown): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The adoption message door's answer, checked, then converted for wagmi. In this order, the first
 * rule broken is the refusal's `problem`:
 *  - `answer_keys`: the answer is `{ typedData, issuedAt }` and nothing else;
 *  - `primary_type`: one of the two forms;
 *  - `form_mismatch`: the form with words when the agreement on screen shows words of adoption,
 *    the six fields alone when it shows none;
 *  - `typed_data_keys`, `types_keys`, `adoption_fields`, `domain_fields`, `domain_keys`: the shape
 *    of the form served, against its pinned list of fields;
 *  - `domain_name`, `domain_chain`, `domain_factory`: the adoption's own domain, on the order's
 *    chain and factory;
 *  - `message_keys`: exactly the form's fields;
 *  - `order_id`: the order on screen;
 *  - `manifest_hash`: the hash the order froze, which is the hash of the agreement read;
 *  - `text`: the id and version of the agreement read;
 *  - `guardian`: the wallet in session, which is the order's Guardian;
 *  - `issued_at`: a whole number of seconds, the one the answer names beside the typed data;
 *  - `statement`: in the form with words, exactly the words the agreement's answer served.
 */
export function adoptionSignGate(
  served: unknown,
  ctx: AdoptionGateContext,
): SignGate<WagmiAdoptionTypedData> {
  if (!hasExactKeys(served, ANSWER_KEYS)) return refuse("answer_keys");
  const td = served.typedData;
  if (!isRecord(td)) return refuse("primary_type");
  const primaryType = td.primaryType;
  if (primaryType !== PLAIN_ADOPTION_TYPE && primaryType !== CHARTER_ADOPTION_TYPE)
    return refuse("primary_type");

  // The words the agreement on screen showed. A backend that does not serve the key shows none.
  const shown = ctx.agreement.adoptionStatement;
  const words = typeof shown === "string" ? shown : null;
  const inWords = primaryType === CHARTER_ADOPTION_TYPE;
  if (inWords !== (words !== null)) return refuse("form_mismatch");

  const pinned: readonly Field[] = inWords ? CHARTER_ADOPTION_FIELDS : ADOPTION_FIELDS;
  if (!hasExactKeys(td, TYPED_DATA_KEYS)) return refuse("typed_data_keys");
  const types = td.types;
  if (!hasExactKeys(types, ["EIP712Domain", primaryType])) return refuse("types_keys");
  if (!hasFields(types[primaryType], pinned)) return refuse("adoption_fields");
  if (!hasFields(types.EIP712Domain, EIP712_DOMAIN_FIELDS)) return refuse("domain_fields");
  const d = td.domain;
  if (!hasExactKeys(d, DOMAIN_KEYS)) return refuse("domain_keys");
  if (d.name !== ADOPTION_DOMAIN_NAME || d.version !== DOMAIN_VERSION) return refuse("domain_name");
  if (d.chainId !== ctx.order.chainId) return refuse("domain_chain");
  const factory = d.verifyingContract;
  if (typeof factory !== "string" || !sameAddress(factory, ctx.order.factory))
    return refuse("domain_factory");
  const m = td.message;
  if (!hasExactKeys(m, pinned.map((f) => f.name))) return refuse("message_keys");

  if (m.orderId !== ctx.order.id) return refuse("order_id");
  const hash = m.manifestHash;
  const frozen = ctx.order.agreement;
  if (
    typeof hash !== "string" ||
    !BYTES32.test(hash) ||
    frozen === null ||
    !sameHex(hash, frozen.hash) ||
    !sameHex(hash, ctx.agreement.manifestHash)
  )
    return refuse("manifest_hash");
  const { textId, textVersion } = m;
  if (
    typeof textId !== "string" ||
    typeof textVersion !== "string" ||
    textId !== ctx.agreement.textId ||
    textVersion !== ctx.agreement.textVersion
  )
    return refuse("text");
  const guardian = m.guardian;
  if (
    typeof guardian !== "string" ||
    !sameAddress(guardian, ctx.sessionAddress) ||
    !sameAddress(guardian, ctx.order.guardian)
  )
    return refuse("guardian");
  const issuedAt = m.issuedAt;
  if (typeof issuedAt !== "string" || !CANONICAL_DECIMAL.test(issuedAt) || issuedAt !== served.issuedAt)
    return refuse("issued_at");

  const domain: WagmiDomain = {
    name: ADOPTION_DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: ctx.order.chainId,
    verifyingContract: factory as Address,
  };
  const six: SixFields = {
    orderId: ctx.order.id,
    manifestHash: hash as Hex,
    textId,
    textVersion,
    guardian: guardian as Address,
    issuedAt: BigInt(issuedAt),
  };
  if (!inWords)
    return {
      ok: true,
      typedData: {
        domain,
        types: { OperatingAgreementAdoption: ADOPTION_FIELDS },
        primaryType: PLAIN_ADOPTION_TYPE,
        message: six,
      },
    };
  const statement = m.statement;
  if (words === null || typeof statement !== "string" || statement !== words)
    return refuse("statement");
  return {
    ok: true,
    typedData: {
      domain,
      types: { LegalBodyCharterAdoption: CHARTER_ADOPTION_FIELDS },
      primaryType: CHARTER_ADOPTION_TYPE,
      message: { statement, ...six },
    },
  };
}
