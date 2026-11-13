import { type Address, type Hex, getAddress, hashTypedData, recoverAddress } from "viem";
import { assertRealHuman } from "../api/routes/worldId";
import { withKeyedLock } from "../payments/keyedMutex";
import type { NewAgreementAdoption } from "../persistence/legalBodyAdoptionRepository";
import { ECDSA_SIGNATURE } from "../persistence/legalBodyInput";
import type { LegalBodyRecord } from "../persistence/legalBodyRepository";
import { assertOpenDraft } from "./linkDoor";
import {
  type LegalBodyOrderDeps,
  assertThisDeployment,
  orderLockKey,
  requireOwnedOrder,
  takeDoorTokens,
} from "./orders";
import { refusal } from "./sentences";
import { EIP712_DOMAIN_FIELDS } from "./statement";

/**
 * THE ADOPTION OF AN ORDER'S OPERATING AGREEMENT: what a guardian signs to adopt, for its company,
 * the agreement frozen for its order, how that signature is checked, and the two doors that serve
 * the message and store the signed adoption. The link doors refuse an order until its adoption is
 * stored (`agreement_not_adopted`): the agreement is bound into the link too, but the link is
 * signed by the identity's owner, who need not be the member who adopts the agreement.
 *
 * The typed data is built on the statement of authority's (`statement.ts`), under a domain of its
 * own: the domain names the chain and the deployment's legal-body factory, so an adoption signed
 * for one deployment is worth nothing on another. No contract reads this signature. The message
 * is built by the server from the order and from the agreement it was frozen with, never taken
 * from the client: the order, its frozen manifest hash, the text id and version that manifest
 * states (what the guardian read, whatever text the deployment serves now), the guardian, and the
 * time the message was issued. The signature is checked by local ECDSA recovery, with no node, so a
 * stored adoption can be checked again from its row alone.
 *
 * There is no tool for it: the adoption is the guardian's own signature, by the wallet signed in
 * to the web app, and an agent's key signs as the identity's owner, never as the guardian.
 */

export const ADOPTION_DOMAIN_NAME = "Novi Corpus Operating Agreement Adoption";
export const ADOPTION_DOMAIN_VERSION = "1";
export const ADOPTION_PRIMARY_TYPE = "OperatingAgreementAdoption";
/** An adoption issued further ahead of the server's clock than this is stale: room for a client's
 *  clock that runs a little fast, and no more. Its greatest age is the deployment's setting
 *  (`adoptionMaxAgeSeconds`). */
export const ADOPTION_MAX_AHEAD_SECONDS = 60;

/** The fields of the `OperatingAgreementAdoption` type string, in its order. */
export const ADOPTION_FIELDS = [
  { name: "orderId", type: "string" },
  { name: "manifestHash", type: "bytes32" },
  { name: "textId", type: "string" },
  { name: "textVersion", type: "string" },
  { name: "guardian", type: "address" },
  { name: "issuedAt", type: "uint256" },
] as const;

/** The wording an order's agreement was frozen with, by id and version, as its stored manifest
 *  states it (`readVerifiedAgreement`). */
export interface FrozenAgreementText {
  textId: string;
  textVersion: string;
}

export interface AdoptionMessage {
  /** The order's id, as its view names it. */
  orderId: string;
  /** The order's frozen manifest hash: the agreement adopted. */
  manifestHash: Hex;
  textId: string;
  textVersion: string;
  /** Checksummed: the order's guardian, always its tenant. */
  guardian: Address;
  /** Unix seconds, by the server's clock. */
  issuedAt: bigint;
}

/**
 * The JSON-safe form served to a wallet. `issuedAt` is a canonical decimal string and `chainId` a
 * number, so `JSON.stringify` works on it. `EIP712Domain` is declared, as the statement's wire
 * form declares it: a wallet that signs this object as it arrives signs `adoptionDigest`.
 */
export interface AdoptionTypedDataWire {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: {
    EIP712Domain: readonly { name: string; type: string }[];
    OperatingAgreementAdoption: readonly { name: string; type: string }[];
  };
  primaryType: "OperatingAgreementAdoption";
  message: Omit<AdoptionMessage, "issuedAt"> & { issuedAt: string };
}

/** The adoption message door's answer: the typed data, and the time it was issued, as the decimal
 *  string the adoption door takes back. */
export interface AdoptionMessageResult {
  typedData: AdoptionTypedDataWire;
  issuedAt: string;
}

/** The adoption door's answer: when the order's adoption was stored, in unix seconds. */
export interface AdoptionResult {
  adoptedAt: number;
}

export function adoptionDomain(
  chainId: number,
  factory: Address,
): { name: string; version: string; chainId: number; verifyingContract: Address } {
  return {
    name: ADOPTION_DOMAIN_NAME,
    version: ADOPTION_DOMAIN_VERSION,
    chainId,
    verifyingContract: factory,
  };
}

/**
 * The adoption of `order`'s agreement, issued at `issuedAt`: the order's id, its frozen manifest
 * hash and its guardian from the row, the text id and version from the agreement it was frozen
 * with. An order with no frozen agreement has nothing to adopt, and throws: a caller checks first.
 */
export function buildAdoptionMessage(
  order: LegalBodyRecord,
  frozen: FrozenAgreementText,
  issuedAt: bigint,
): AdoptionMessage {
  if (order.oaManifestHash === null)
    throw new Error(`legal body ${order.legalBodyId} has no frozen agreement to adopt`);
  return {
    orderId: order.legalBodyId,
    manifestHash: order.oaManifestHash,
    textId: frozen.textId,
    textVersion: frozen.textVersion,
    guardian: getAddress(order.guardian),
    issuedAt,
  };
}

export function adoptionTypedDataWire(
  chainId: number,
  factory: Address,
  m: AdoptionMessage,
): AdoptionTypedDataWire {
  return {
    domain: adoptionDomain(chainId, factory),
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, OperatingAgreementAdoption: ADOPTION_FIELDS },
    primaryType: ADOPTION_PRIMARY_TYPE,
    message: {
      orderId: m.orderId,
      manifestHash: m.manifestHash,
      textId: m.textId,
      textVersion: m.textVersion,
      guardian: m.guardian,
      issuedAt: m.issuedAt.toString(),
    },
  };
}

/** The digest a signature over the adoption covers. viem derives the domain type from the domain
 *  itself, so the types here leave `EIP712Domain` out; the wire form hashes to the same value. */
export function adoptionDigest(chainId: number, factory: Address, m: AdoptionMessage): Hex {
  return hashTypedData({
    domain: adoptionDomain(chainId, factory),
    types: { OperatingAgreementAdoption: ADOPTION_FIELDS },
    primaryType: ADOPTION_PRIMARY_TYPE,
    message: m,
  });
}

/** A uint256 in canonical decimal: digits only, no leading zero but "0" itself, 78 at most. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

/**
 * Checks a signed adoption. It never takes a message from the client: it builds the message from
 * the order and the text its agreement was frozen with, and checks the signature over THAT, so a
 * signature over any other order, agreement, text, guardian, time, chain or factory fails. In this
 * order:
 *  - `adoption_not_valid` (400): the order has no frozen agreement, or names another guardian
 *    than the tenant; or `issuedAt` is not a whole number of seconds in canonical decimal;
 *  - `adoption_stale` (400): `issuedAt` is more than `maxAgeSec` seconds before `nowSec`, or more
 *    than 60 after it;
 *  - `adoption_not_valid` (400): the signature is not 65 bytes of hex (`ECDSA_SIGNATURE`: sign-in
 *    is ECDSA only, so the tenant is always an address a key controls, and a stored adoption is
 *    checked again from its row), does not recover, or recovers, over the digest, to another
 *    address than the tenant (compared in lower case).
 * Answers the digest the signature covers.
 */
export async function verifyAdoption(input: {
  chainId: number;
  factory: Address;
  tenantId: Address;
  order: LegalBodyRecord;
  terms: FrozenAgreementText;
  issuedAt: string;
  signature: Hex;
  nowSec: number;
  maxAgeSec: number;
}): Promise<{ digest: Hex }> {
  const { order, tenantId } = input;
  if (order.oaManifestHash === null || order.guardian.toLowerCase() !== tenantId.toLowerCase())
    throw refusal("adoption_not_valid", 400);
  if (typeof input.issuedAt !== "string" || !CANONICAL_DECIMAL.test(input.issuedAt))
    throw refusal("adoption_not_valid", 400);
  const issuedAt = BigInt(input.issuedAt);
  const now = BigInt(input.nowSec);
  if (
    issuedAt < now - BigInt(input.maxAgeSec) ||
    issuedAt > now + BigInt(ADOPTION_MAX_AHEAD_SECONDS)
  )
    throw refusal("adoption_stale", 400);
  const signature = input.signature;
  if (typeof signature !== "string" || !ECDSA_SIGNATURE.test(signature))
    throw refusal("adoption_not_valid", 400);

  const digest = adoptionDigest(
    input.chainId,
    input.factory,
    buildAdoptionMessage(order, input.terms, issuedAt),
  );
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: digest, signature });
  } catch {
    // An r or s out of range, or a v that is no recovery bit.
    throw refusal("adoption_not_valid", 400);
  }
  if (signer.toLowerCase() !== tenantId.toLowerCase()) throw refusal("adoption_not_valid", 400);
  return { digest };
}

/**
 * Stores the adoption and its `agreement_adopted` event in one transaction, and answers its time
 * in unix seconds. An order already adopted keeps its first adoption: nothing is written, and the
 * stored time is answered. The event's detail is the digest alone.
 */
export function recordAdoption(
  deps: Pick<LegalBodyOrderDeps, "adoptions" | "repo" | "transaction">,
  adoption: NewAgreementAdoption,
): number {
  return deps.transaction(() => {
    const stored = deps.adoptions.find(adoption.legalBodyId);
    if (stored !== undefined) return stored.adoptedAt;
    deps.adoptions.insert(adoption);
    deps.repo.recordEvent(adoption.legalBodyId, "agreement_adopted", "tenant", null, {
      digest: adoption.digest,
    });
    return adoption.adoptedAt;
  });
}

/**
 * The rule both adoption doors share, on the tenant's order, once the tenant passed the
 * real-human check: the tenant's order (the uniform 404), then the draft rule the link applies
 * (`assertOpenDraft`), so a draft the link would refuse is never adopted, with the same code.
 * Answers the order and the text its agreement was frozen with. The adoption door applies the two
 * itself (`adoptAgreement`): an order adopted before its link is answered between them.
 */
function adoptableDraft(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
  nowMs: number,
): { row: LegalBodyRecord; frozen: FrozenAgreementText } {
  const row = requireOwnedOrder(deps, tenantId, id);
  return { row, frozen: assertOpenDraft(deps, row, nowMs).frozen };
}

/**
 * The typed data the guardian signs to adopt its order's agreement, issued now by the server's
 * clock: a real human (never a waiver), then the shared rule (`adoptableDraft`). It writes
 * nothing and takes no token, as the agreement's read takes none.
 */
export function adoptionMessage(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
): AdoptionMessageResult {
  const nowMs = (deps.now ?? Date.now)();
  assertRealHuman(deps.world, tenantId, deps.environment);
  const { row, frozen } = adoptableDraft(deps, tenantId, id, nowMs);
  const message = buildAdoptionMessage(row, frozen, BigInt(Math.floor(nowMs / 1000)));
  return {
    typedData: adoptionTypedDataWire(deps.deployment.chainId, deps.deployment.factory, message),
    issuedAt: message.issuedAt.toString(),
  };
}

/** The states the link door answers with the order's view rather than refuses (`submitLink`): an
 *  order in one of them was adopted before its link, so the adoption door answers that adoption. */
const LINK_ACCEPTED: ReadonlySet<LegalBodyRecord["bindingState"]> = new Set([
  "reserved",
  "deployed",
  "linked",
]);

/** The order's stored adoption, if it adopts the order's own frozen agreement (the hash the link
 *  door compares too). */
function storedAdoption(deps: LegalBodyOrderDeps, row: LegalBodyRecord): number | undefined {
  const stored = deps.adoptions.find(row.legalBodyId);
  if (
    stored === undefined ||
    row.oaManifestHash === null ||
    stored.manifestHash.toLowerCase() !== row.oaManifestHash.toLowerCase()
  )
    return undefined;
  return stored.adoptedAt;
}

/**
 * Stores the guardian's signed adoption of its order's agreement. In this order: a real human
 * (never a waiver), then the tenant's bucket and the doors' budget, as the link doors take them
 * (`takeDoorTokens`, 429 `rate_limited`); the tenant's order (the uniform 404). Then:
 *  - an order the link door answers by its state (reserved, deployed or linked) of this
 *    deployment (else 409 `other_deployment`) answers its stored adoption, as the link door
 *    answers its state; with none stored (an order reserved before adoptions existed), 409
 *    `order_closed`, as before;
 *  - any other order passes the draft rule (`assertOpenDraft`, each refusal as before), and an
 *    open draft already adopted answers its stored adoption;
 * neither checks the signature or writes anything, so a re-post after the window, or with another
 * signature, answers the stored time. Else `verifyAdoption`, on this deployment's chain and
 * factory and within its `adoptionMaxAgeSeconds`; then, under the order's lock and in one
 * transaction, the order read again (one abandoned since is 409 `order_closed`) and
 * `recordAdoption`, which keeps a first adoption stored in between.
 */
export async function adoptAgreement(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
  input: { issuedAt: unknown; signature: unknown },
): Promise<AdoptionResult> {
  const nowMs = (deps.now ?? Date.now)();
  const nowSec = Math.floor(nowMs / 1000);
  assertRealHuman(deps.world, tenantId, deps.environment);
  takeDoorTokens(deps, tenantId);
  const row = requireOwnedOrder(deps, tenantId, id);
  if (LINK_ACCEPTED.has(row.bindingState)) {
    assertThisDeployment(deps, row);
    const adoptedAt = storedAdoption(deps, row);
    if (adoptedAt === undefined) throw refusal("order_closed", 409);
    return { adoptedAt };
  }
  const { frozen } = assertOpenDraft(deps, row, nowMs);
  const adoptedBefore = storedAdoption(deps, row);
  if (adoptedBefore !== undefined) return { adoptedAt: adoptedBefore };
  const issuedAt = input?.issuedAt as string;
  const { digest } = await verifyAdoption({
    chainId: deps.deployment.chainId,
    factory: deps.deployment.factory,
    tenantId,
    order: row,
    terms: frozen,
    issuedAt,
    signature: input?.signature as Hex,
    nowSec,
    maxAgeSec: deps.adoptionMaxAgeSeconds,
  });
  const message = buildAdoptionMessage(row, frozen, BigInt(issuedAt));
  const adoption: NewAgreementAdoption = {
    legalBodyId: row.legalBodyId,
    manifestHash: message.manifestHash,
    textId: message.textId,
    textVersion: message.textVersion,
    guardian: message.guardian,
    // Inside the window checked above, so a safe integer of unix seconds.
    issuedAt: Number(message.issuedAt),
    signature: input.signature as Hex,
    digest,
    adoptedAt: nowSec,
  };
  return withKeyedLock(orderLockKey(row.legalBodyId), async () =>
    deps.transaction((): AdoptionResult => {
      const current = requireOwnedOrder(deps, tenantId, row.legalBodyId);
      if (current.bindingState !== "draft" || current.oaManifestHash !== row.oaManifestHash)
        throw refusal("order_closed", 409);
      return { adoptedAt: recordAdoption(deps, adoption) };
    }),
  );
}
