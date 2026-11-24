import { type Address, getAddress, isAddress } from "viem";
import type { SafePotChainPort } from "../adapters/arc/safePotChain";
import { opsLog } from "../observability/opsLog";
import type { CharterGrantRepository } from "../persistence/charterGrantRepository";
import type { DocumentStore } from "../persistence/documentStore";
import { ZERO_ADDRESS } from "../persistence/legalBodyInput";
import type {
  LegalBodyPotRepository,
  PotBirthNote,
  PotNote,
} from "../persistence/legalBodyPotRepository";
import type { LegalBodyRecord, LegalBodyRepository } from "../persistence/legalBodyRepository";
import { ownAgentWallet } from "./agentWalletRule";
import { readVerifiedAgreement } from "./agreement";
import type { Grant } from "./grant";
import { readOrderGrant } from "./orderGrant";
import { chainCall } from "./orders";
import {
  POT_CEILING_MAX_USDC,
  POT_PERIOD_MINUTES,
  USDC_UNIT,
  potAddresses,
  potCeilingCapFromGrant,
  potInitializer,
  predictPotAddress,
} from "./safePot";
import { refusal } from "./sentences";

export type {
  PotAct,
  PotBirthNote,
  PotNote,
} from "../persistence/legalBodyPotRepository";

/**
 * THE COMPANY'S POT, NOTED BEFORE THE TRANSACTION: a Safe the guardian owns alone, from which the
 * agent's own key takes USDC up to a ceiling in each fixed thirty-day period. The guardian's wallet
 * creates it from the website; before it sends the setup transaction, the server notes the pot's
 * address, so a transaction mined in a tab that was lost is found again.
 *
 * WHAT THE SERVER CHECKED BEFORE IT NOTED AN ADDRESS. It recomputed the address itself, from the
 * birth details and nothing else: the salt number, the first ceiling, the agent's key (the
 * registry's, read at that moment, for a new pot) and the guardian (the body's own). The reading
 * rules (`potReading`) are sound only for an address noted this way, whose initializer fixes how
 * the Safe was set up: the server never notes, and never reads as a pot, an address a client sent
 * that it did not recompute. Nothing else is taken on trust, and nothing is read from the chain
 * but the code at the body's noted addresses (one pot for life) and the registry's wallet.
 *
 * ONE POT FOR LIFE. Once any address a body noted holds code, the body takes no other pot: a
 * restart or a new key is done on the same Safe. A noted address that never got code may be
 * replaced; one that holds code may always be put back on the record, and is the only kind that
 * may stand once another noted address holds code.
 *
 * ONE LEGAL BODY PER POT (Ruling R13). An address another legal body has noted, of any guardian,
 * is never noted for this one.
 *
 * THE DECLARATION. The guardian ticks one sentence (`POT_DECLARATION`) on the review screen; its
 * version is stored in the note and, with the note, in the body's event log (`pot_declared`), in one
 * transaction. The log names the act and the version only: no address.
 *
 * OFFERED ONLY WHILE VERIFIED (Rulings R1 and R11). The doors answer `pot_not_offered` while this
 * process has not verified the code of the pot's seven contracts (`potOffer.ts`), before anything
 * is read: the flag is `offered`.
 *
 * Ops lines carry the body's id only.
 */

/** The declaration the guardian ticks on the review screen. The website's copy holds the same words. */
export const POT_DECLARATION = {
  version: "pot-declaration-1",
  text: "I declare this pot for the company: it holds the company's money, and its address, its ceiling, what was taken from it and what it holds will show in the public record.",
} as const;

/** What the pot's doors need: the notes, the registry the agent's key is read from, the legal
 *  bodies and their event log, the chain the code of a noted address is read from, the chain id
 *  whose pot table the address is recomputed with, the clock, the orders' grants and the store of
 *  their agreements (the grant caps the ceiling), and whether the pot is offered now. */
export interface LegalBodyPotDeps {
  repo: LegalBodyPotRepository;
  registry: { getAgentWallet(agentId: bigint): Promise<Address> };
  bodies: LegalBodyRepository;
  chain: SafePotChainPort;
  chainId: number;
  /** Unix milliseconds. */
  now: () => number;
  /** The grants of orders placed on the Charter: the order's grant caps the ceiling (Ruling R12). */
  grants: CharterGrantRepository;
  /** The agreements, in the store every other document is in: the grant is read back against its
   *  frozen agreement, as every door that acts on it reads it. */
  docStore: DocumentStore;
  /** True only while this process has verified the code of the pot's seven contracts. */
  offered: () => boolean;
}

/** The body's pot as its guardian's page reads it: the address of its latest note, whether that note
 *  puts it on the record, and the birth details and time of its latest declaration. */
export interface OrderPotView {
  address: Address;
  onRecord: boolean;
  /** Unix seconds: the latest declaration of this address. */
  declaredAt: number;
  birth: PotBirthNote;
}

/** The fields the note door takes, and no other. */
const INPUT_FIELDS: readonly string[] = [
  "address",
  "saltNonce",
  "ceilingUnits",
  "agentWallet",
  "declarationVersion",
];

const UINT256_MAX = 2n ** 256n - 1n;
/** A whole number in canonical decimal: no sign, no leading zero, digits only. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** The largest ceiling, in units. */
const CEILING_MAX_UNITS = BigInt(POT_CEILING_MAX_USDC) * USDC_UNIT;
/** How many times a note is checked again when another note of the same body was written while it
 *  was being checked; past that, the door's 429. */
const POT_NOTE_ATTEMPTS = 3;

/** Addresses compared without regard to letter case. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** An address as the door takes one: EIP-55 or lower case, never the zero address. */
function takenAddress(value: unknown): Address | undefined {
  if (typeof value !== "string" || !isAddress(value, { strict: true })) return undefined;
  if (value.toLowerCase() === ZERO_ADDRESS) return undefined;
  return getAddress(value);
}

/** A canonical decimal string of at most 78 digits, as a bigint; undefined otherwise. */
function takenDecimal(value: unknown): bigint | undefined {
  if (typeof value !== "string" || value.length > 78 || !CANONICAL_DECIMAL.test(value))
    return undefined;
  return BigInt(value);
}

/** The details in the form the record stores them, or undefined when the door cannot take them.
 *  The declaration's version is read apart: its absence has its own refusal. */
function parseInput(input: unknown):
  | {
      address: Address;
      saltNonce: bigint;
      ceilingUnits: bigint;
      agentWallet: Address;
      declarationVersion: unknown;
    }
  | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !INPUT_FIELDS.includes(key))) return undefined;
  const address = takenAddress(fields.address);
  const agentWallet = takenAddress(fields.agentWallet);
  const saltNonce = takenDecimal(fields.saltNonce);
  const ceilingUnits = takenDecimal(fields.ceilingUnits);
  if (address === undefined || agentWallet === undefined) return undefined;
  if (saltNonce === undefined || saltNonce > UINT256_MAX) return undefined;
  // A whole number of USDC, from 1 to POT_CEILING_MAX_USDC.
  if (
    ceilingUnits === undefined ||
    ceilingUnits % USDC_UNIT !== 0n ||
    ceilingUnits < USDC_UNIT ||
    ceilingUnits > CEILING_MAX_UNITS
  )
    return undefined;
  return {
    address,
    saltNonce,
    ceilingUnits,
    agentWallet,
    declarationVersion: fields.declarationVersion,
  };
}

/** Passes while the pot is offered; else 409 `pot_not_offered`. The doors' first step: before it
 *  nothing is read and no token is taken. */
export function assertPotOffered(deps: Pick<LegalBodyPotDeps, "offered">): void {
  if (!deps.offered()) throw refusal("pot_not_offered", 409);
}

/**
 * The grant the body's frozen agreement states, read back and checked as every door that acts on a
 * grant reads it (`readOrderGrant`): null for an agreement that takes none. An agreement or a grant
 * that does not read back is refused (500 `agreement_unreadable`, or `grant_unreadable`), after one
 * error line: never read as "no grant", which would lift the cap.
 */
function grantOfBody(
  deps: Pick<LegalBodyPotDeps, "docStore" | "grants">,
  row: LegalBodyRecord,
): Grant | null {
  const hash = row.oaManifestHash;
  if (hash === null) {
    // A linked body is created from its frozen agreement: a row without one was not made here.
    opsLog("legal_body_agreement_unverifiable", {
      level: "error",
      legalBodyId: row.legalBodyId,
      reason: "not_frozen",
    });
    throw refusal("agreement_unreadable", 500);
  }
  // A failure has already written its error line, naming the body and a fixed reason.
  const verified = readVerifiedAgreement(deps.docStore, row.legalBodyId, hash);
  if (verified === undefined) throw refusal("agreement_unreadable", 500);
  return readOrderGrant(deps, row.legalBodyId, verified);
}

/** The view of the body's notes for the address of `latest`: the birth details and time of the
 *  latest declared note of that address. */
function viewOf(notes: readonly PotNote[], latest: PotNote): OrderPotView {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i];
    if (
      note?.act === "declared" &&
      note.birth !== null &&
      sameAddress(note.address, latest.address)
    )
      return {
        address: latest.address,
        onRecord: latest.act === "declared",
        declaredAt: note.declaredAt,
        birth: note.birth,
      };
  }
  // A removal is only ever of the address on the record: a body's notes are written so.
  throw new Error(`the pot notes of ${latest.legalBodyId} remove an address never declared`);
}

/** The body's own row, linked and not revoked, with its agent; else the refusal. One 404 for
 *  unknown and not yours. */
function linkedBodyOf(
  deps: Pick<LegalBodyPotDeps, "bodies">,
  tenantId: string,
  legalBodyId: string,
): LegalBodyRecord & { agentId: string } {
  const row = deps.bodies.findOwned(tenantId, legalBodyId);
  if (row === undefined) throw refusal("not_found", 404);
  if (row.bindingState !== "linked") throw refusal("order_closed", 409);
  // A revocation is an event, and leaves the row linked: a revoked body takes no pot.
  if (deps.bodies.isRevoked(row.legalBodyId)) throw refusal("legal_body_revoked", 409);
  const agentId = row.agentId;
  // A linked row holds its agent (the table's CHECKs).
  if (agentId === null)
    throw new Error(`legal body ${row.legalBodyId} is linked without its agent`);
  return { ...row, agentId };
}

/**
 * The guardian notes the company's pot, before its setup transaction, in this order:
 *  0. the pot is offered (`assertPotOffered`): else 409 `pot_not_offered`, before anything is read;
 *  1. the body is the tenant's (one 404 for unknown and not yours) and `linked`, else 409
 *     `order_closed`; revoked is 409 `legal_body_revoked`;
 *  2. the details are an object of the five keys and no other; the address and the first key in
 *     EIP-55 or lower case, never zero; the salt number a canonical decimal of at most 2^256 - 1;
 *     the ceiling a canonical decimal, a whole number of USDC from 1 to POT_CEILING_MAX_USDC, in
 *     units: else 400 `pot_invalid`. A declaration of another version, or none: 400
 *     `pot_declaration_required`;
 *  3. the deployment's chain has a pot table: else 409 `pot_chain_unsupported`;
 *  4. Ruling R12: where the body's agreement states a grant, a grant that allows none of buying,
 *     paying and engaging contractors takes no pot (409 `grant_allows_no_spending`), and the ceiling
 *     is at most the sum of their thirty-day amounts (409 `ceiling_above_grant`);
 *  5. the address is the one the server recomputes from the guardian (the body's), the first key,
 *     USDC, the ceiling, the thirty-day period and the salt number, in any letter case: else 409
 *     `pot_address_mismatch`. No chain read before this;
 *  6. Ruling R13: another legal body, of any guardian, has noted this address: 409 `pot_taken`.
 *     A pot belongs to one legal body; moving it to another is not offered;
 *  7. ONE POT FOR LIFE, before anything is answered: the code of every other address the body
 *     declared is read at once, through `chainCall`. When one holds code, a NEW POT is 409
 *     `pot_exists`; a note of an address the body declared before (the one on the record, or a
 *     put-back) stands only if this address holds code itself, else 409 `pot_exists`. So a noted
 *     address that never got code may be replaced, a former pot that landed late still holds the
 *     body to it, and a pot that holds code can always come back. A body with no other address
 *     reads nothing here;
 *  8. the body's latest note is a declared note of this address: it is answered, nothing written;
 *  9. a NEW POT (no declared note of this address yet): the registry's wallet of the body's agent,
 *     read now through `chainCall`, is not the agent's own (`ownAgentWallet`): 409
 *     `agent_wallet_required`; not the first key in any letter case: 409 `pot_address_mismatch`.
 *     A PUT-BACK of an address the body declared before reads no registry: the same address
 *     means the same birth details, and the key may have changed since on the same pot;
 * 10. one transaction: the body read again (still `linked`, not revoked); the body's latest note
 *     read again, and when another note was written since step 7 read them, nothing is written and
 *     the note is checked again from step 7 (at most POT_NOTE_ATTEMPTS times, then the door's 429
 *     `rate_limited`); else the note appended (`declared`, the birth details, the declaration's
 *     version, at now) and the tenant's `pot_declared` note in the body's event log, naming the
 *     version only;
 * 11. one ops line, with the body's id only.
 * A read of the chain or the registry that fails is 503 `chain_unavailable`, and nothing is noted.
 * The real-human check, the door's throttle and the deployment check are the door's, before this.
 */
export async function declarePot(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
  input: unknown,
): Promise<OrderPotView> {
  // 0.
  assertPotOffered(deps);

  // 1.
  const row = linkedBodyOf(deps, tenantId, legalBodyId);
  const id = row.legalBodyId;

  // 2.
  const taken = parseInput(input);
  if (taken === undefined) throw refusal("pot_invalid", 400);
  if (taken.declarationVersion !== POT_DECLARATION.version)
    throw refusal("pot_declaration_required", 400);
  const birth: PotBirthNote = {
    saltNonce: taken.saltNonce.toString(),
    agentWallet: taken.agentWallet,
    ceilingUnits: taken.ceilingUnits.toString(),
  };

  // 3.
  const table = potAddresses(deps.chainId);
  if (table === null) throw refusal("pot_chain_unsupported", 409);

  // 4.
  const cap = potCeilingCapFromGrant(grantOfBody(deps, row)?.value ?? null);
  if (cap.kind === "no_spending") throw refusal("grant_allows_no_spending", 409);
  if (cap.kind === "capped" && taken.ceilingUnits > BigInt(cap.maxUsdc) * USDC_UNIT)
    throw refusal("ceiling_above_grant", 409);

  // 5.
  const recomputed = predictPotAddress(
    table,
    potInitializer(table, {
      guardian: row.guardian,
      agentWallet: taken.agentWallet,
      token: table.usdc,
      ceilingUnits: taken.ceilingUnits,
      periodMinutes: POT_PERIOD_MINUTES,
    }),
    taken.saltNonce,
  );
  if (!sameAddress(recomputed, taken.address)) throw refusal("pot_address_mismatch", 409);
  const address = recomputed;

  // 6. Ruling R13. A removal is only ever of an address the same body declared, so the declared
  //    notes name every body that ever noted the address.
  if (deps.repo.legalBodyIdsByAddress(address, 2).some((holder) => holder !== id))
    throw refusal("pot_taken", 409);

  for (let attempt = 1; ; attempt += 1) {
    const notes = deps.repo.list(id);
    const latest = notes.at(-1);
    const same = latest?.act === "declared" && sameAddress(latest.address, address);
    const declaredBefore = notes.some(
      (n) => n.act === "declared" && sameAddress(n.address, address),
    );

    // 7.
    const others = [
      ...new Set(
        notes
          .filter((n) => n.act === "declared" && !sameAddress(n.address, address))
          .map((n) => n.address),
      ),
    ];
    if (others.length > 0) {
      const codes = await Promise.all(
        others.map((other) => chainCall(id, "pot_code", () => deps.chain.codeHash(other))),
      );
      if (codes.some((code) => code !== null)) {
        if (!declaredBefore) throw refusal("pot_exists", 409);
        const own = await chainCall(id, "pot_code", () => deps.chain.codeHash(address));
        if (own === null) throw refusal("pot_exists", 409);
      }
    }

    // 8.
    if (same && latest !== undefined) return viewOf(notes, latest);

    // 9.
    if (!declaredBefore) {
      const wallet = await chainCall(id, "pot_agent_wallet", () =>
        deps.registry.getAgentWallet(BigInt(row.agentId)),
      );
      if (!ownAgentWallet(wallet, row.guardian)) throw refusal("agent_wallet_required", 409);
      if (!sameAddress(wallet, taken.agentWallet)) throw refusal("pot_address_mismatch", 409);
    }

    // 10.
    const view = deps.bodies.transaction((): OrderPotView | undefined => {
      if (deps.bodies.findById(id)?.bindingState !== "linked") throw refusal("order_closed", 409);
      if (deps.bodies.isRevoked(id)) throw refusal("legal_body_revoked", 409);
      // Another note of this body was written since the notes were read: the checks were made
      // against notes that are no longer the body's, so they are made again.
      if (deps.repo.latest(id)?.declaredAt !== latest?.declaredAt) return undefined;
      const appended = deps.repo.append({
        legalBodyId: id,
        act: "declared",
        address,
        birth,
        declarationVersion: POT_DECLARATION.version,
        at: Math.floor(deps.now() / 1000),
      });
      deps.bodies.recordEvent(id, "note", "tenant", null, {
        act: "pot_declared",
        declarationVersion: POT_DECLARATION.version,
      });
      return { address: appended.address, onRecord: true, declaredAt: appended.declaredAt, birth };
    });

    // 11.
    if (view !== undefined) {
      opsLog("legal_body_pot_declared", { legalBodyId: id });
      return view;
    }
    if (attempt >= POT_NOTE_ATTEMPTS) throw refusal("rate_limited", 429);
  }
}

/**
 * The body's pot as its guardian's page reads it: one 404 for unknown and not yours (any state, a
 * read); no note: `{ pot: null }`; else the latest note's address, `onRecord` true when that note is
 * `declared`, and the birth details and time of the latest declared note of that address. No chain
 * read. While the pot is not offered: 409 `pot_not_offered`, before anything is read.
 */
export function orderPot(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
): { pot: OrderPotView | null } {
  assertPotOffered(deps);
  const row = deps.bodies.findOwned(tenantId, legalBodyId);
  if (row === undefined) throw refusal("not_found", 404);
  const notes = deps.repo.list(row.legalBodyId);
  const latest = notes.at(-1);
  return { pot: latest === undefined ? null : viewOf(notes, latest) };
}
