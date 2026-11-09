import { type Address, type Hex, getAddress, isAddress } from "viem";
import { opsLog } from "../observability/opsLog";
import { ZERO_ADDRESS, lowerHash } from "../persistence/legalBodyInput";
import type { LegalBodyRepository } from "../persistence/legalBodyRepository";
import {
  type LegalBodyTreasuryRepository,
  MAX_LIMITS_URL_LENGTH,
  MAX_PROVIDER_NAME_LENGTH,
  type TreasuryDeclaration,
  type TreasuryProvider,
  isTreasuryProvider,
} from "../persistence/legalBodyTreasuryRepository";
import { chainCall } from "./orders";
import { refusal } from "./sentences";
import type { Standing } from "./standing";
import { type FieldProblem, type TextRule, applyTextRule } from "./textRules";

export type {
  TreasuryDeclaration,
  TreasuryProvider,
} from "../persistence/legalBodyTreasuryRepository";

/**
 * THE TREASURY OF RECORD (design §9, F29): the guardian of a linked legal body declares which
 * wallet its agent pays from, who provides it, and where its limits can be read. Novi stores the
 * declaration only once the registry shows that address as the agent's wallet, and serves it
 * unsigned, beside the signed statement, as the `treasury` block of the two public lookup answers.
 *
 * WHAT NOVI CHECKED, AND WHAT IT DID NOT. One thing is checked, once, at the declaration: the
 * ERC-8004 registry's `getAgentWallet` showed the address. The provider, the provider's name, the
 * limits and the link to them are the guardian's word, and the block says so (`checkedByNovi:
 * false`). The registry transaction hash, when given, is kept as the guardian gave it (lower-case)
 * and never fetched (Ruling 5).
 *
 * SERVED ONLY WHILE IT IS TRUE OF THE REGISTRY (Ruling 3), AND BESIDE A STATEMENT IN FORCE. A
 * lookup answer serves the block only while the body's latest declaration names the agent's wallet
 * as that same answer read it, the wallet its signed statement carries, and only while that
 * statement's standing is `active` or `pending`; otherwise `treasury: null`. A wallet changed on
 * chain after the declaration is never served as the wallet the agent pays from, and a body Novi no
 * longer states as in force carries no guardian claim beside it. The rows are left as they are.
 *
 * A revoked body takes no declaration: the operator's revocation is an event, and leaves the row
 * `linked`, so the door asks for it besides the state.
 *
 * The signed statement does not change: its 33 fields and domain version "2" are untouched, and a
 * later statement version may sign this block.
 *
 * Ops lines and events carry the body's id and the provider only: never an address, a provider's
 * name or a link.
 */

/** The block the lookup answers serve, unsigned: what the guardian declared, and that Novi did not
 *  check it. The registry transaction hash is the record's, not the block's. */
export interface TreasuryBlock {
  address: Address;
  provider: TreasuryProvider;
  providerName: string | null;
  limitsReadableAt: string | null;
  declaredBy: "guardian";
  /** Unix seconds. */
  declaredAt: number;
  checkedByNovi: false;
}

/** A declaration as the door takes it. A field given as null is a field not given. */
export interface TreasuryInput {
  address: Address;
  provider: TreasuryProvider;
  providerName?: string;
  limitsReadableAt?: string;
  registryTxHash?: Hex;
}

/** What a declaration needs: the record, the registry it is checked against, the legal bodies,
 *  and the clock. */
export interface DeclareTreasuryDeps {
  repo: LegalBodyTreasuryRepository;
  registry: { getAgentWallet(agentId: bigint): Promise<Address> };
  bodies: LegalBodyRepository;
  /** Unix milliseconds. */
  now: () => number;
}

/** The deployment's treasury of record: the record, and the registry a declaration is checked
 *  against (the deployment's ERC-8004 identity registry, the one the statements read). */
export interface LegalBodyTreasuryDeps {
  repo: LegalBodyTreasuryRepository;
  registry: DeclareTreasuryDeps["registry"];
}

/** The fields a declaration takes, and no other. */
const INPUT_FIELDS: readonly string[] = [
  "address",
  "provider",
  "providerName",
  "limitsReadableAt",
  "registryTxHash",
];

/** Another provider's name, as the guardian writes it: the declaration fields' rules, with digits
 *  and the punctuation of a company's name. No colon and no slash, so it is never a link. */
const PROVIDER_NAME: TextRule = {
  min: 2,
  max: MAX_PROVIDER_NAME_LENGTH,
  chars: /^[\p{L}\p{M}\p{N} '.,&()-]+$/u,
  charsProblem: "may hold only letters, digits, spaces and the punctuation . , & ' ( ) -",
};

/** Printable ASCII and nothing else: no space, no control character, no lookalike. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** The printable characters RFC 3986 never allows raw in a URL: a link served to a page that
 *  renders it holds none of them. */
const NOT_IN_A_URL = /["<>\\^`{|}]/;

/** What may follow a link's authority: its path, its query or its fragment. */
const AFTER_AUTHORITY = ["/", "?", "#"];

/**
 * A link to the wallet's limits (Ruling 4): `https://` as written, at most 300 characters of
 * printable ASCII that a URL may hold raw, with a host and no credentials. Kept exactly as the
 * guardian wrote it, so it must lead where it reads: the authority as written is exactly the
 * host the URL resolves to (letter case aside), followed by its path, its query, its fragment or
 * nothing, with no `@` in it. A link the parser repairs (an empty authority, empty credentials, an
 * encoded host, the default port written out) is refused, never stored in a form that differs
 * from where it leads.
 */
function limitsLink(value: string): boolean {
  if (value.length > MAX_LIMITS_URL_LENGTH || !PRINTABLE_ASCII.test(value)) return false;
  if (NOT_IN_A_URL.test(value)) return false;
  if (!value.startsWith("https://") || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  )
    return false;
  const afterScheme = value.slice("https://".length);
  const authorityEnd = [...afterScheme].findIndex((ch) => AFTER_AUTHORITY.includes(ch));
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  return !authority.includes("@") && authority.toLowerCase() === url.host;
}

/** A field given as null is a field not given. */
const given = (value: unknown): boolean => value !== undefined && value !== null;

/** The declaration in the form the record stores it, or undefined when the door cannot take it. */
function parseInput(input: unknown):
  | {
      address: Address;
      provider: TreasuryProvider;
      providerName: string | null;
      limitsReadableAt: string | null;
      registryTxHash: Hex | null;
    }
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !INPUT_FIELDS.includes(key))) return undefined;
  const { address, provider, providerName, limitsReadableAt, registryTxHash } = fields;

  // EIP-55 or lower case, as the lookup by address takes one; never the zero address.
  if (typeof address !== "string" || !isAddress(address, { strict: true })) return undefined;
  if (address.toLowerCase() === ZERO_ADDRESS) return undefined;
  if (!isTreasuryProvider(provider)) return undefined;

  // A name for another provider, and for no other.
  let name: string | null = null;
  if (provider === "other") {
    const problems: FieldProblem[] = [];
    name = applyTextRule("providerName", providerName, PROVIDER_NAME, problems) ?? null;
    if (name === null) return undefined;
  } else if (given(providerName)) return undefined;

  let link: string | null = null;
  if (given(limitsReadableAt)) {
    if (typeof limitsReadableAt !== "string" || !limitsLink(limitsReadableAt)) return undefined;
    link = limitsReadableAt;
  }

  let hash: Hex | null = null;
  if (given(registryTxHash)) {
    hash = lowerHash(registryTxHash);
    if (hash === null) return undefined;
  }

  return {
    address: getAddress(address),
    provider,
    providerName: name,
    limitsReadableAt: link,
    registryTxHash: hash,
  };
}

/**
 * The guardian declares the treasury of record of its legal body, in this order:
 *  1. the body is the tenant's (one 404 for unknown and not-yours) and `linked`: any other state is
 *     409 `order_closed`. A body the operator revoked is 409 `legal_body_revoked`: a revocation
 *     is an event and leaves the row `linked`;
 *  2. the declaration is one the record takes (400 `treasury_invalid`): only the five fields; an
 *     address in EIP-55 or lower case, never the zero address; one of the four providers; a name
 *     for another provider and for no other; a link to the limits, when given, `https://` and at
 *     most 300 characters, with no credentials; a registry transaction hash, when given, of 32
 *     bytes;
 *  3. the registry shows the address as the agent's wallet, read now, in any letter case: else 409
 *     `treasury_wallet_mismatch`. A registry that cannot be read is 503 `chain_unavailable`;
 *  4. one transaction: the body is read again and must still be `linked` (else `order_closed`) and
 *     not revoked (else `legal_body_revoked`), the declaration is appended, and the tenant's
 *     `treasury_declared` note is written, naming the provider only;
 *  5. one ops line, naming the body and the provider.
 * Nothing is written before step 4. The real-human check, the door's throttle and the deployment
 * check are the door's, before this.
 */
export async function declareTreasury(
  deps: DeclareTreasuryDeps,
  tenantId: string,
  legalBodyId: string,
  input: TreasuryInput,
): Promise<TreasuryDeclaration> {
  // 1.
  const row = deps.bodies.findOwned(tenantId, legalBodyId);
  if (row === undefined) throw refusal("not_found", 404);
  if (row.bindingState !== "linked") throw refusal("order_closed", 409);
  // A revocation is an event, and leaves the row linked: a revoked body takes no declaration.
  if (deps.bodies.isRevoked(row.legalBodyId)) throw refusal("legal_body_revoked", 409);
  const agentId = row.agentId;
  // A linked row holds its agent (the table's CHECKs).
  if (agentId === null)
    throw new Error(`legal body ${row.legalBodyId} is linked without its agent`);

  // 2.
  const declared = parseInput(input);
  if (declared === undefined) throw refusal("treasury_invalid", 400);

  // 3.
  const wallet = await chainCall(row.legalBodyId, "treasury_wallet", () =>
    deps.registry.getAgentWallet(BigInt(agentId)),
  );
  if (wallet.toLowerCase() !== declared.address.toLowerCase())
    throw refusal("treasury_wallet_mismatch", 409);

  // 4.
  const stored = deps.bodies.transaction((): TreasuryDeclaration => {
    if (deps.bodies.findById(row.legalBodyId)?.bindingState !== "linked")
      throw refusal("order_closed", 409);
    if (deps.bodies.isRevoked(row.legalBodyId)) throw refusal("legal_body_revoked", 409);
    const appended = deps.repo.append({
      legalBodyId: row.legalBodyId,
      ...declared,
      at: Math.floor(deps.now() / 1000),
    });
    deps.bodies.recordEvent(row.legalBodyId, "note", "tenant", null, {
      act: "treasury_declared",
      provider: appended.provider,
    });
    return appended;
  });

  // 5.
  opsLog("legal_body_treasury_declared", {
    legalBodyId: stored.legalBodyId,
    provider: stored.provider,
  });
  return stored;
}

/** The block of a declaration, or null for none. */
export function treasuryView(d: TreasuryDeclaration | undefined): TreasuryBlock | null {
  if (d === undefined) return null;
  return {
    address: d.address,
    provider: d.provider,
    providerName: d.providerName,
    limitsReadableAt: d.limitsReadableAt,
    declaredBy: d.declaredBy,
    declaredAt: d.declaredAt,
    checkedByNovi: false,
  };
}

/**
 * The standings of a statement in force: the body stands (`active`), or is on its way to standing
 * (`pending`, its company not established yet). Beside any other standing (`inactive`: revoked,
 * broken, wound down; `unknown`: Novi cannot tell) no block is served. The block is the guardian's
 * word, which Novi did not check; a relying party must never meet fresh guardian claims about the
 * wallet beside a body Novi no longer states as in force, where they would read as if Novi still
 * stood behind the body they describe.
 */
const STANDINGS_IN_FORCE: readonly Standing[] = ["active", "pending"];

/**
 * The block a lookup answer serves for a body, from its latest declaration and what that same
 * answer's signed statement states: the agent's wallet and the body's standing. Null unless both
 * hold:
 *  - the statement is in force (`STANDINGS_IN_FORCE`);
 *  - Ruling 3: the declaration's address is the agent's wallet the statement signs, in any letter
 *    case. An older declaration is never served in place of the latest.
 */
export function servedTreasury(
  latest: TreasuryDeclaration | undefined,
  stated: { agentWallet: Address; standing: Standing },
): TreasuryBlock | null {
  if (latest === undefined || !STANDINGS_IN_FORCE.includes(stated.standing)) return null;
  if (latest.address.toLowerCase() !== stated.agentWallet.toLowerCase()) return null;
  return treasuryView(latest);
}

/**
 * The block an answer carrying a signed statement serves: the stated body's latest declaration,
 * against the wallet and the standing the statement signs (`servedTreasury`). No chain read: the
 * statement's own reading is the one compared. Null where the deployment wires no record. A failed
 * database read throws, and the lookups answer it as they answer any: their 503.
 */
export function treasuryOfStatement(
  repo: Pick<LegalBodyTreasuryRepository, "latest"> | undefined,
  stated: {
    legalBodyId: string;
    statement: { message: { agentWallet: Address; standing: Standing } };
  },
): TreasuryBlock | null {
  if (repo === undefined) return null;
  return servedTreasury(repo.latest(stated.legalBodyId), stated.statement.message);
}
