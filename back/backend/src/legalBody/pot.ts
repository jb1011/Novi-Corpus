import { type Address, type Hex, getAddress, isAddress } from "viem";
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
  POT_FEE_LOW_WEI,
  POT_PERIOD_MINUTES,
  POT_TAKE_GAS,
  type PotAddresses,
  type PotRaw,
  type PotReading,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  USDC_UNIT,
  potAddresses,
  potCeilingCapFromGrant,
  potInitializer,
  potReading,
  predictPotAddress,
  takeCalldata,
} from "./safePot";
import { refusal, sentenceFor } from "./sentences";
import type { Standing } from "./standing";
import {
  type LegalBodyStatementDeps,
  type StatementOutcome,
  statementForAgent,
} from "./statements";

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
 * TAKEN OFF THE PUBLIC RECORD. The guardian may withdraw the claim at any time, whatever the body's
 * state (`removePot`): a `removed` note of the address on the record, and `pot_removed` in the
 * event log, in one transaction. Nothing is read from the chain, and the pot itself, its money and
 * its allowance are untouched: Novi Corpus holds no key to them. The address stays the body's (an
 * address belongs to one legal body; one pot for life), and the note door puts it back.
 *
 * OFFERED ONLY WHILE VERIFIED (Rulings R1 and R11). The note door and the agent's two tools answer
 * `pot_not_offered` while this process has not verified the code of the pot's seven contracts
 * (`potOffer.ts`), before anything is read: the flag is `offered`. Taking the pot off the record
 * takes no flag (Ruling R15 a): a guardian may always withdraw a claim. Nor does the guardian's
 * read of the body's notes (`orderPot`, Ruling R27): it reads no chain, and the guardian's page
 * needs it to offer taking a pot on the record off it.
 *
 * IN THE PUBLIC RECORD (`potOfStatement`). Beside a signed statement, outside it and unsigned, the
 * lookups serve the pot on the record: its address, its birth details (anyone recomputes the
 * address from them) and what was read from the chain at the statement's own block, against the
 * agent's wallet that statement signs and the body's guardian. The ceiling counts fixed periods:
 * the agent's key may take up to it in each thirty-day period, each period starting where the last
 * one ended. Only an address the server recomputed from its notes' birth details is ever read:
 * never one a request named. While the flag is off, the pot is still named, with "Its limits were
 * not read." (Ruling R15 b): nothing is claimed from contracts that failed their check, and the
 * link to the company is never hidden. Every pot address a body declared leads back to the body
 * (`statementForPotAddress`): the one on the record, or a former one.
 *
 * FOR THE AGENT'S OWN KEY (`potForAgent`, `prepareTake`, the MCP tools `get_pot` and
 * `prepare_pot_take`). The agent reads what is left of the ceiling in the current period, and gets
 * the take as one transaction its own key sends to the AllowanceModule itself, with an empty
 * signature: the module takes the sender as the signer. The server builds the bytes and reads the
 * chain; it holds no key, signs nothing and sends nothing. The pot read is the address of the
 * body's latest note, on or off the record, and only once the server has recomputed it again from
 * the note's birth details and the body's guardian (Ruling R18), as the public record does. A take
 * is prepared only for a body in force, linked and not revoked (Ruling R17); the read answers for
 * a body in any state.
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

/** What anyone needs to recompute the pot's address and see how it was born (the runbook's recipe,
 *  Task 14): the guardian (the Safe's only owner), the agent's key it was set up for (its first
 *  delegate), the token, the first ceiling in units, the period in minutes, the salt number, and the
 *  five contracts the setup names. The address is CREATE2 of the factory over the initializer these
 *  give and the salt number. Public facts: the pot's address and its birth are meant to be checked. */
export type PotBirth = {
  guardian: Address;
  agentWallet: Address;
  token: Address;
  ceilingUnits: string;
  periodMinutes: 43200;
  saltNonce: string;
  proxyFactory: Address;
  singleton: Address;
  fallbackHandler: Address;
  multiSendCallOnly: Address;
  allowanceModule: Address;
};

/**
 * The pot on the record, served beside a signed statement, outside it and unsigned. Units are
 * USDC's 6 decimals, as decimal strings; times are unix seconds. `readAtBlock` and `readAt` are the
 * statement's own block and issue: what was read from the chain was read at that block. The
 * periods are fixed: each thirty-day period starts where the last one ended, and `periodEndsAt` is
 * the end of the current one.
 *
 * What each state lets a page say, and no more (the website's copy holds the sentences):
 *  - `ceiling_read`: "The guardian declared this pot for the company: <address>. The agent's key may
 *    take up to <amount> USDC from it in each thirty-day period; the current one ends on <date>. It
 *    holds <amount> USDC. Read from the chain on <date>." `spentUnits` were taken in the current
 *    period;
 *  - `stopped`: "The guardian declared this pot for the company: <address>. The agent's key cannot
 *    take from it: its allowance is switched off. It holds <amount> USDC. Read from the chain on
 *    <date>." Never more than that: no read can show that no key at all can move the pot's money;
 *  - `limits_not_read`: "The guardian declared this pot for the company: <address>. Its limits were
 *    not read." A pot of the guardian's alone with something the reading rules do not read past, or
 *    any pot while the pot is not offered (Ruling R15 b): no amount;
 *  - `former`: a pot the body declared that is no longer the one on the record, from `declaredAt`
 *    (its latest declaration) to `endedAt` (the note that followed it). Served only by a lookup by
 *    that pot's own address;
 *  - `unavailable`: the chain could not be read just now. No claim at all; never memoised.
 */
export type PotBlock =
  | {
      state: "ceiling_read";
      address: Address;
      token: Address;
      ceilingUnits: string;
      periodMinutes: 43200;
      spentUnits: string;
      periodEndsAt: number;
      balanceUnits: string;
      readAtBlock: string;
      readAt: number;
      declaredBy: "guardian";
      declaredAt: number;
      birth: PotBirth;
    }
  | {
      state: "stopped";
      address: Address;
      balanceUnits: string;
      readAtBlock: string;
      readAt: number;
      declaredBy: "guardian";
      declaredAt: number;
      birth: PotBirth;
    }
  | {
      state: "limits_not_read";
      address: Address;
      readAtBlock: string;
      readAt: number;
      declaredBy: "guardian";
      declaredAt: number;
      birth: PotBirth;
    }
  | {
      state: "former";
      address: Address;
      declaredBy: "guardian";
      declaredAt: number;
      endedAt: number;
      birth: PotBirth;
    }
  | { state: "unavailable" };

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

/** The latest declared note of the address of `latest`, with its birth details. */
function declaredNoteOf(
  notes: readonly PotNote[],
  latest: PotNote,
): PotNote & { birth: PotBirthNote } {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i];
    if (
      note?.act === "declared" &&
      note.birth !== null &&
      sameAddress(note.address, latest.address)
    )
      return { ...note, birth: note.birth };
  }
  // A removal is only ever of the address on the record: a body's notes are written so.
  throw new Error(`the pot notes of ${latest.legalBodyId} remove an address never declared`);
}

/** The view of the body's notes for the address of `latest`: the birth details and time of the
 *  latest declared note of that address. */
function viewOf(notes: readonly PotNote[], latest: PotNote): OrderPotView {
  const declared = declaredNoteOf(notes, latest);
  return {
    address: latest.address,
    onRecord: latest.act === "declared",
    declaredAt: declared.declaredAt,
    birth: declared.birth,
  };
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
 *     A pot belongs to one legal body; moving it to another is not offered. Checked again inside
 *     the transaction of step 10 (Ruling R29);
 *  7. ONE POT FOR LIFE, before anything is answered: the code of every other address the body
 *     declared is read at once, through `chainCall`. When one holds code, a NEW POT is 409
 *     `pot_exists`; a note of an address the body declared before (the one on the record, or a
 *     put-back) stands only if this address holds code itself, else 409 `pot_exists`. Ruling R22:
 *     a NEW POT while the body's latest declared note is of another address that holds no code is
 *     409 `pot_pending`: that pot is still being set up, and it is finished at the address already
 *     noted. So a noted address that never got code is never replaced by another, a former pot
 *     that landed late (from a record written before R22) still holds the body to it, and a pot
 *     that holds code can always come back. A body with no other address reads nothing here;
 *  8. the body's latest note is a declared note of this address: it is answered, nothing written;
 *  9. a NEW POT (no declared note of this address yet): the registry's wallet of the body's agent,
 *     read now through `chainCall`, is not the agent's own (`ownAgentWallet`): 409
 *     `agent_wallet_required`; not the first key in any letter case: 409 `pot_address_mismatch`.
 *     A PUT-BACK of an address the body declared before reads no registry: the same address
 *     means the same birth details, and the key may have changed since on the same pot;
 * 10. one transaction: the body read again (still `linked`, not revoked); step 6 again, so two
 *     requests for two bodies at once never both note one address (Ruling R29): 409 `pot_taken`;
 *     the body's latest note read again, and when another note was written since step 7 read them,
 *     nothing is written and the note is checked again from step 7 (at most POT_NOTE_ATTEMPTS
 *     times, then the door's 429 `rate_limited`); else the note appended (`declared`, the birth
 *     details, the declaration's version, at now) and the tenant's `pot_declared` note in the
 *     body's event log, naming the version only;
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
      // Ruling R22: a NEW address while the body's latest declared note is of another address
      // that holds no code: that pot is still being set up, and it is created at its own address.
      const lastDeclared = notes.filter((n) => n.act === "declared").at(-1);
      if (!declaredBefore && lastDeclared !== undefined) {
        const at = others.findIndex((other) => sameAddress(other, lastDeclared.address));
        if (at >= 0 && codes[at] === null) throw refusal("pot_pending", 409);
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
      // Ruling R29: the check of step 6 again, under the write lock. Between the two there were
      // awaits (the code reads, the registry read), so another body's note of this address may
      // have been written since: one address belongs to one legal body.
      if (deps.repo.legalBodyIdsByAddress(address, 2).some((holder) => holder !== id))
        throw refusal("pot_taken", 409);
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
 * The guardian takes the company's pot off the public record, in this order:
 *  1. the body is the tenant's: one 404 for unknown and not yours. Any state, revoked included: a
 *     guardian may always withdraw a claim;
 *  2. one transaction: the body's notes read; none, or a latest note that is `removed`, is 409
 *     `pot_not_on_record`, and nothing is written; else a `removed` note of the latest note's
 *     address appended (no birth details, no version, at now) and the tenant's `pot_removed` note
 *     in the body's event log, naming the act only;
 *  3. one ops line, with the body's id only.
 * Answers the view `orderPot` answers from now on: the same address and birth details, `onRecord`
 * false. No read of the chain or the registry: the pot itself, its money and its allowance are
 * untouched. The address stays the body's, so another body's note of it is still `pot_taken`, and
 * `declarePot` puts it back by its own rules. The real-human check is the door's, before this.
 * Unlike the abandon door, no deployment check and no flag: a guardian may always withdraw a
 * claim. While the pot is not offered (Ruling R15 a) it is taken off all the same: withdrawing a
 * public claim needs no chain read, least of all when something looks wrong.
 */
export function removePot(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
): OrderPotView {
  // 1.
  const row = deps.bodies.findOwned(tenantId, legalBodyId);
  if (row === undefined) throw refusal("not_found", 404);
  const id = row.legalBodyId;

  // 2. The notes are read under the write lock, so the note taken off is the latest one when the
  //    removal is written.
  const view = deps.bodies.transaction((): OrderPotView => {
    const notes = deps.repo.list(id);
    const latest = notes.at(-1);
    if (latest === undefined || latest.act === "removed") throw refusal("pot_not_on_record", 409);
    const removed = deps.repo.append({
      legalBodyId: id,
      act: "removed",
      address: latest.address,
      birth: null,
      declarationVersion: null,
      at: Math.floor(deps.now() / 1000),
    });
    deps.bodies.recordEvent(id, "note", "tenant", null, { act: "pot_removed" });
    return viewOf([...notes, removed], removed);
  });

  // 3.
  opsLog("legal_body_pot_removed", { legalBodyId: id });
  return view;
}

/**
 * The body's pot as its guardian's page reads it: one 404 for unknown and not yours (any state, a
 * read); no note: `{ pot: null }`; else the latest note's address, `onRecord` true when that note is
 * `declared`, and the birth details and time of the latest declared note of that address. No chain
 * read. Whatever the pot's flag (Ruling R27): it reads only the body's notes, and the guardian's
 * page needs it to take a pot on the record off it, as the off-record door takes no flag either.
 */
export function orderPot(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
): { pot: OrderPotView | null } {
  const owned = ownedPot(deps, tenantId, legalBodyId);
  return { pot: owned.latest === undefined ? null : viewOf(owned.notes, owned.latest) };
}

/** `orderPot`'s reads, kept for the agent's tools: one 404, the body's row and its notes. No
 *  chain read, and no flag: the agent's tools check it first themselves (`notedPot`). */
function ownedPot(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
): { row: LegalBodyRecord; notes: readonly PotNote[]; latest: PotNote | undefined } {
  const row = deps.bodies.findOwned(tenantId, legalBodyId);
  if (row === undefined) throw refusal("not_found", 404);
  const notes = deps.repo.list(row.legalBodyId);
  return { row, notes, latest: notes.at(-1) };
}

// ---------------------------------------------------------------------------------------------
// The pot in the public record
// ---------------------------------------------------------------------------------------------

/** The standings of a statement in force, as the treasury of record reads them (`active`, or
 *  `pending` on its way): beside any other, no live claim about the pot is served. */
const STANDINGS_IN_FORCE: readonly Standing[] = ["active", "pending"];
/** The most legal bodies a pot's address is checked for. One address belongs to one legal body
 *  (Ruling R13); more could only be notes written around the doors. */
const POT_CANDIDATES = 3;

type Stated = Extract<StatementOutcome, { kind: "statement" }>;

/** The code is a pot's: a Safe proxy's runtime code, the same for every proxy. */
const isPotCode = (code: Hex | null): boolean =>
  code !== null && code.toLowerCase() === SAFE_PROXY_RUNTIME_CODE_HASH.toLowerCase();

/** The one thing of an error an ops line carries: its message can quote a node's URL. */
const nameOf = (e: unknown): string => (e instanceof Error ? e.name : "not_an_error");

/** A chain read of the record that failed: one ops line, naming the body and the error's name
 *  only, and the block that claims nothing. */
function unavailableBlock(legalBodyId: string, e: unknown): PotBlock {
  opsLog("legal_body_pot_unavailable", { legalBodyId, errorName: nameOf(e) });
  return { state: "unavailable" };
}

/** The body's row, which a statement was just made from: a row that vanished is the database's
 *  failure, and throws like one. */
function rowOf(deps: Pick<LegalBodyPotDeps, "bodies">, legalBodyId: string): LegalBodyRecord {
  const row = deps.bodies.findById(legalBodyId);
  if (row === undefined) throw new Error("the legal body of a statement vanished from its table");
  return row;
}

/**
 * The birth details the record serves for a declared note of the body, once the address they
 * predict, with the body's own guardian, is the note's address: anyone can recompute it from them.
 * Else null, after one error line: such a note was not written by the doors, which note only an
 * address the server recomputed, and the server never reads as a pot an address it did not
 * recompute itself (the reading rules are sound only for the address an initializer fixes).
 */
function birthOf(table: PotAddresses, row: LegalBodyRecord, note: PotNote): PotBirth | null {
  const b = note.birth;
  const predicted =
    b === null
      ? null
      : predictPotAddress(
          table,
          potInitializer(table, {
            guardian: row.guardian,
            agentWallet: b.agentWallet,
            token: table.usdc,
            ceilingUnits: BigInt(b.ceilingUnits),
            periodMinutes: POT_PERIOD_MINUTES,
          }),
          BigInt(b.saltNonce),
        );
  if (b === null || predicted === null || !sameAddress(predicted, note.address)) {
    opsLog("legal_body_pot_note_unrecomputable", { level: "error", legalBodyId: row.legalBodyId });
    return null;
  }
  return {
    guardian: getAddress(row.guardian),
    agentWallet: getAddress(b.agentWallet),
    token: table.usdc,
    ceilingUnits: b.ceilingUnits,
    periodMinutes: POT_PERIOD_MINUTES,
    saltNonce: b.saltNonce,
    proxyFactory: table.proxyFactory,
    singleton: table.safeSingleton,
    fallbackHandler: table.fallbackHandler,
    multiSendCallOnly: table.multiSendCallOnly,
    allowanceModule: table.allowanceModule,
  };
}

/** Whether `address` holds a pot's code at the statement's own block: one code read, and nothing
 *  else of the pot. A failed read is "unavailable", after its ops line. */
async function holdsPotCode(
  deps: Pick<LegalBodyPotDeps, "chain">,
  legalBodyId: string,
  address: Address,
  stated: Stated,
): Promise<boolean | "unavailable"> {
  try {
    const blockNumber = BigInt(stated.statement.message.observedAtBlock);
    return isPotCode(await deps.chain.codeHash(address, blockNumber));
  } catch (e) {
    unavailableBlock(legalBodyId, e);
    return "unavailable";
  }
}

/**
 * The block of the pot on the record (`latest`, the body's latest note, a declared one) beside a
 * statement in force, read from the chain at the statement's block (`observedAtBlock`), against the
 * agent's wallet the statement signs and the body's guardian from its row; `readAt` is the
 * statement's `issuedAt`. While the pot is not offered (Ruling R15 b): only whether the address
 * holds a pot's code, and the pot named with its limits not read; never a ceiling, never stopped.
 */
async function onRecordBlock(
  deps: LegalBodyPotDeps,
  stated: Stated,
  latest: PotNote,
): Promise<PotBlock | null> {
  const table = potAddresses(deps.chainId);
  if (table === null) return null;
  const row = rowOf(deps, stated.legalBodyId);
  const birth = birthOf(table, row, latest);
  if (birth === null) return null;
  const message = stated.statement.message;
  const address = latest.address;
  const read = { readAtBlock: message.observedAtBlock, readAt: Number(message.issuedAt) };
  const declared = { declaredBy: "guardian" as const, declaredAt: latest.declaredAt, birth };

  if (!deps.offered()) {
    const holds = await holdsPotCode(deps, row.legalBodyId, address, stated);
    if (holds === "unavailable") return { state: "unavailable" };
    return holds ? { state: "limits_not_read", address, ...read, ...declared } : null;
  }

  let reading: PotReading;
  try {
    const raw = await deps.chain.readPot({
      pot: address,
      agentWallet: message.agentWallet,
      blockNumber: BigInt(message.observedAtBlock),
    });
    reading = potReading(raw, {
      addresses: table,
      guardian: row.guardian,
      agentWallet: message.agentWallet,
    });
  } catch (e) {
    return unavailableBlock(row.legalBodyId, e);
  }
  switch (reading.state) {
    case "absent":
    case "not_the_guardians":
      return null;
    case "stopped":
      return {
        state: "stopped",
        address,
        balanceUnits: reading.balanceUnits.toString(),
        ...read,
        ...declared,
      };
    case "limits_not_read":
      return { state: "limits_not_read", address, ...read, ...declared };
    case "ceiling_read":
      return {
        state: "ceiling_read",
        address,
        token: table.usdc,
        ceilingUnits: reading.ceilingUnits.toString(),
        periodMinutes: POT_PERIOD_MINUTES,
        spentUnits: reading.spentUnits.toString(),
        periodEndsAt: reading.periodEndsAt,
        balanceUnits: reading.balanceUnits.toString(),
        ...read,
        ...declared,
      };
  }
}

/**
 * The body's pot ON THE RECORD, beside its signed statement, as read from the chain at the
 * statement's block (`PotBlock`). Null: no deps; a statement not in force (`active` or `pending`),
 * with no read at all; no note, or a latest note that is `removed`; a note whose birth details do
 * not give its address; no code at the address (noted, never created); or a Safe that is not the
 * guardian's alone. A failed CHAIN read is `unavailable`; a failed DATABASE read throws, and the
 * lookups answer it with their 503. `declaredAt` and `birth` are those of the note on the record.
 * The expected delegate is the agent's wallet the statement signs, so a key replaced in the
 * registry after the setup reads `limits_not_read` until the guardian moves the pot to it. One
 * read of the pot per statement (its code, then its state at that same block), none for a body
 * without a pot on the record. The signed statement is untouched.
 */
export async function potOfStatement(
  deps: LegalBodyPotDeps | undefined,
  stated: Stated,
): Promise<PotBlock | null> {
  if (deps === undefined) return null;
  if (!STANDINGS_IN_FORCE.includes(stated.statement.message.standing)) return null;
  const latest = deps.repo.latest(stated.legalBodyId);
  if (latest === undefined || latest.act !== "declared") return null;
  return onRecordBlock(deps, stated, latest);
}

/**
 * The block of a body's pot for an address one of its notes declared, beside its statement, or
 * undefined when the address does not lead to this body:
 *  (a) the body's latest note is a declared note of this address: beside a statement in force, the
 *      pot on the record (`onRecordBlock`; null leads nowhere); beside one not in force, `null`,
 *      kept only when the address holds a pot's code, so a lookup by the pot of an inactive body
 *      still leads to it with no live claim beside it;
 *  (b) otherwise it is a FORMER pot of the body: kept only when the address holds a pot's code,
 *      as `former`, from its latest declared note to the first note after that one.
 * A code read that fails is `unavailable`, kept.
 */
async function potAtAddress(
  deps: LegalBodyPotDeps,
  table: PotAddresses,
  row: LegalBodyRecord,
  stated: Stated,
  address: Address,
): Promise<PotBlock | null | undefined> {
  const notes = deps.repo.list(row.legalBodyId);
  const latest = notes.at(-1);
  if (latest?.act === "declared" && sameAddress(latest.address, address)) {
    if (STANDINGS_IN_FORCE.includes(stated.statement.message.standing))
      return (await onRecordBlock(deps, stated, latest)) ?? undefined;
    if (birthOf(table, row, latest) === null) return undefined;
    const holds = await holdsPotCode(deps, row.legalBodyId, latest.address, stated);
    if (holds === "unavailable") return { state: "unavailable" };
    return holds ? null : undefined;
  }

  let at = -1;
  for (let i = notes.length - 1; i >= 0 && at === -1; i -= 1) {
    const note = notes[i];
    if (note?.act === "declared" && sameAddress(note.address, address)) at = i;
  }
  const declared = notes[at];
  // The note that ended it: one always follows, since the latest note is not this declaration.
  const ended = notes[at + 1];
  if (at === -1 || declared === undefined || ended === undefined) return undefined;
  const birth = birthOf(table, row, declared);
  if (birth === null) return undefined;
  const holds = await holdsPotCode(deps, row.legalBodyId, declared.address, stated);
  if (holds === "unavailable") return { state: "unavailable" };
  if (!holds) return undefined;
  return {
    state: "former",
    address: declared.address,
    declaredBy: "guardian",
    declaredAt: declared.declaredAt,
    endedAt: ended.declaredAt,
    birth,
  };
}

/**
 * The statement for an address no agent's wallet answered, when it is a pot a legal body declared:
 * the body's statement, read fresh, and the block of that pot. The notes only propose candidates;
 * the chain confirms them.
 *  1. The candidates: the bodies with a declared note of the address, newest note first, at most
 *     3. None: `none`, with no chain read. A value that is not an address reads nothing at all.
 *  2. For each, in order: its row's agent (none: skipped); the statement for that agent
 *     (`statementForAgent`); an `unknown` is remembered and ends the loop; a statement about
 *     another legal body than the candidate (the agent's newer body) is skipped. Then the block
 *     for THIS address (`potAtAddress`): one that does not lead to the body is skipped.
 *  3. The first kept whose standing is `active`; else the `unknown` met (with pot null); else the
 *     first kept; else `none`.
 * The block's address, when it has one, is the address asked. A database read that fails throws.
 */
export async function statementForPotAddress(
  st: LegalBodyStatementDeps,
  deps: LegalBodyPotDeps,
  address: Address,
): Promise<{ outcome: StatementOutcome; pot: PotBlock | null }> {
  const none = { outcome: { kind: "none" } as const, pot: null };
  if (typeof address !== "string" || !isAddress(address, { strict: false })) return none;
  const candidates = deps.repo.legalBodyIdsByAddress(address, POT_CANDIDATES);
  if (candidates.length === 0) return none;
  const table = potAddresses(deps.chainId);
  if (table === null) return none;

  const kept: { outcome: Stated; pot: PotBlock | null }[] = [];
  let unknown: Extract<StatementOutcome, { kind: "unknown" }> | undefined;
  for (const legalBodyId of candidates) {
    const row = deps.bodies.findById(legalBodyId);
    if (row === undefined || row.agentId === null) continue;
    const out = await statementForAgent(st, row.agentId);
    if (out.kind === "unknown") {
      unknown = out;
      break;
    }
    if (out.kind !== "statement" || out.legalBodyId !== legalBodyId) continue;
    const pot = await potAtAddress(deps, table, row, out, address);
    if (pot !== undefined) kept.push({ outcome: out, pot });
  }
  return (
    kept.find((k) => k.outcome.standing === "active") ??
    (unknown === undefined ? undefined : { outcome: unknown, pot: null }) ??
    kept[0] ??
    none
  );
}

// ---------------------------------------------------------------------------------------------
// The agent's two tools: what is left, and a take for the agent's own key to send
// ---------------------------------------------------------------------------------------------

/** The most one take may be: the module's amounts are uint96. */
const UINT96_MAX = 2n ** 96n - 1n;

/**
 * The company's pot as the agent's tools read it. Units are USDC's 6 decimals, as decimal strings;
 * times are unix seconds. The periods are fixed: each thirty-day period starts where the last one
 * ended, and `periodEndsAt` is the end of the current one.
 */
export interface PotForAgent {
  chainId: number;
  /** The address of the body's latest note, on the record or not. */
  pot: Address;
  /** Whether the guardian's note puts it on the public record. */
  onRecord: boolean;
  /** The agent's wallet as the registry names it now: the key the pot is read against, and the
   *  one a take is sent from. */
  agentWallet: Address;
  /** The AllowanceModule a take is sent to. */
  module: Address;
  token: Address;
  /** What the reading rules (`potReading`) let be said of the pot, read from the chain at one
   *  block: `stopped` is "The agent's key cannot take from it: its allowance is switched off." */
  state: "ceiling_read" | "stopped" | "limits_not_read" | "absent" | "not_the_guardians";
  /** Present for `ceiling_read` only. `leftUnits` is the ceiling less what was taken in the
   *  current period, and 0 when more was taken than a lowered ceiling allows. */
  ceilingUnits?: string;
  spentUnits?: string;
  leftUnits?: string;
  periodEndsAt?: number;
  /** Present for `ceiling_read` and `stopped`. */
  balanceUnits?: string;
  /** The native balance of the agent's key, in wei, as a decimal string: its fee money. Null when
   *  the address holds no pot's code: the read stops at the code, and nothing else was read. */
  agentKeyBalanceWei: string | null;
}

/** A take for the agent's own key to send exactly as given, with no signature added. */
export interface PreparedTake {
  chainId: number;
  /** The agent's wallet: the module takes the sender as the signer. */
  from: Address;
  /** The AllowanceModule. */
  to: Address;
  value: "0";
  data: Hex;
  /** The take's fixed gas limit, as a decimal string. */
  gas: string;
  /** What is left of the ceiling in the current period once this take is mined. */
  leftAfterUnits: string;
  /** How to send it (`pot_take_how`). */
  how: string;
  /** `pot_take_low_fee_money` when the agent's key holds under 0.01 USDC for fees, else null. */
  warning: string | null;
}

/** The pot of the tenant's body as the agent's tools find it, before any chain read: the body's
 *  row, the view of its latest note, and the declared note whose birth details give its address. */
interface NotedPot {
  row: LegalBodyRecord;
  view: OrderPotView;
  declared: PotNote;
}

/** What one read of the agent's pot gave: the answer, and the facts a take is judged on. */
interface AgentPotRead {
  view: PotForAgent;
  reading: PotReading;
  raw: PotRaw;
}

/** What is left of the ceiling in the current period: never below 0, as a guardian may lower the
 *  ceiling under what was already taken. */
const leftOf = (r: { ceilingUnits: bigint; spentUnits: bigint }): bigint =>
  r.ceilingUnits > r.spentUnits ? r.ceilingUnits - r.spentUnits : 0n;

/** The tenant's body and its pot, with no chain read: while the pot is not offered, 409
 *  `pot_not_offered` before anything is read; one 404 for unknown and not yours (one read of the
 *  row); no note: 409 `pot_not_declared`. The address is the latest note's, on the record or not. */
function notedPot(deps: LegalBodyPotDeps, tenantId: string, legalBodyId: string): NotedPot {
  assertPotOffered(deps);
  const { row, notes, latest } = ownedPot(deps, tenantId, legalBodyId);
  if (latest === undefined) throw refusal("pot_not_declared", 409);
  return { row, view: viewOf(notes, latest), declared: declaredNoteOf(notes, latest) };
}

/**
 * The pot's table, once the noted address is recomputed, with no chain read: a chain with no pot
 * table is 409 `pot_chain_unsupported`; a note whose birth details, with the body's own guardian,
 * do not give its address is never read: 500 `internal_error`, after the error line `birthOf`
 * writes. Only an address the server recomputed itself is read as a pot, as on the public record.
 */
function recomputedTable(deps: LegalBodyPotDeps, noted: NotedPot): PotAddresses {
  const table = potAddresses(deps.chainId);
  if (table === null) throw refusal("pot_chain_unsupported", 409);
  if (birthOf(table, noted.row, noted.declared) === null) throw refusal("internal_error", 500);
  return table;
}

/**
 * The reads, in this order: the registry's wallet of the body's agent, read now through
 * `chainCall`; then one read of the pot against that wallet and the body's guardian (`readPot`,
 * which reads everything at one fresh block) and the reading rules, through `chainCall`. A failed
 * read of the registry or of the chain is 503 `chain_unavailable`. Writes nothing.
 */
async function readNotedPot(
  deps: LegalBodyPotDeps,
  noted: NotedPot,
  table: PotAddresses,
): Promise<AgentPotRead> {
  const { row, view: pot } = noted;
  const id = row.legalBodyId;
  const agentId = row.agentId;
  // A body is linked, so holds its agent, before its first note (`declarePot`).
  if (agentId === null) throw new Error(`legal body ${id} has a pot and no agent`);

  const agentWallet = await chainCall(id, "pot_agent_wallet", async () =>
    getAddress(await deps.registry.getAgentWallet(BigInt(agentId))),
  );
  const { raw, reading } = await chainCall(id, "pot_read", async () => {
    const read = await deps.chain.readPot({ pot: pot.address, agentWallet });
    return {
      raw: read,
      reading: potReading(read, { addresses: table, guardian: row.guardian, agentWallet }),
    };
  });

  const facts = {
    chainId: deps.chainId,
    pot: pot.address,
    onRecord: pot.onRecord,
    agentWallet,
    module: table.allowanceModule,
    token: table.usdc,
  };
  const agentKeyBalanceWei = isPotCode(raw.codeHash) ? raw.agentBalanceWei.toString() : null;
  let view: PotForAgent;
  switch (reading.state) {
    case "ceiling_read":
      view = {
        ...facts,
        state: reading.state,
        ceilingUnits: reading.ceilingUnits.toString(),
        spentUnits: reading.spentUnits.toString(),
        leftUnits: leftOf(reading).toString(),
        periodEndsAt: reading.periodEndsAt,
        balanceUnits: reading.balanceUnits.toString(),
        agentKeyBalanceWei,
      };
      break;
    case "stopped":
      view = {
        ...facts,
        state: reading.state,
        balanceUnits: reading.balanceUnits.toString(),
        agentKeyBalanceWei,
      };
      break;
    default:
      view = { ...facts, state: reading.state, agentKeyBalanceWei };
  }
  return { view, reading, raw };
}

/**
 * The company's pot as the agent's tool `get_pot` answers it (`PotForAgent`), in this order: the
 * tenant's body and its pot (`pot_not_offered`, one 404, `pot_not_declared`); the pot's table and
 * its address recomputed (`pot_chain_unsupported`, a 500 for a note that does not recompute); the
 * registry's wallet; one read of the pot at the latest block. A failed chain read is 503
 * `chain_unavailable`. A read: it answers for a body in any state. Writes nothing.
 */
export async function potForAgent(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
): Promise<PotForAgent> {
  const noted = notedPot(deps, tenantId, legalBodyId);
  const table = recomputedTable(deps, noted);
  return (await readNotedPot(deps, noted, table)).view;
}

/**
 * A take from the company's pot, for the agent's own key to send itself, in this order:
 *  1. the tenant's body and its pot, with `potForAgent`'s first refusals: `pot_not_offered`, one
 *     404, `pot_not_declared`;
 *  2. `to` an address in EIP-55 or lower case, never zero, and `amountUnits` a canonical decimal
 *     string above 0 and at most 2^96 - 1: else 400 `pot_take_invalid`, before any chain read;
 *  3. Ruling R17: a body that is not `linked`, or that the operator revoked, is not in force: 409
 *     `pot_take_body_not_in_force`, before any chain read;
 *  4. the pot's table and its address recomputed, as `potForAgent` does;
 *  5. a payee that is the pot itself, the token's contract or the AllowanceModule (the money would
 *     go back to the pot, or to a contract that cannot spend it): 409 `pot_take_bad_payee`;
 *  6. the registry's wallet and one read of the pot, as `potForAgent` reads them;
 *  7. a reading that is not `ceiling_read`: 409 `pot_not_readable`;
 *  8. an amount above the ceiling less what was taken in the current period: 409
 *     `pot_take_over_ceiling`;
 *  9. an amount above what the pot holds: 409 `pot_take_over_balance`;
 * 10. the transaction: from the agent's wallet, to the AllowanceModule, value 0, the take's bytes
 *     (`takeCalldata`, an empty signature), the fixed gas limit, what is left after it, how to
 *     send it, and the low fee-money warning when the agent's key holds under `POT_FEE_LOW_WEI`.
 * It writes nothing and sends nothing: the agent's key sends it, or nobody does. The record does
 * not matter to a take: a pot off the record still answers.
 */
export async function prepareTake(
  deps: LegalBodyPotDeps,
  tenantId: string,
  legalBodyId: string,
  input: { to: unknown; amountUnits: unknown },
): Promise<PreparedTake> {
  // 1.
  const noted = notedPot(deps, tenantId, legalBodyId);

  // 2.
  const to = takenAddress(input?.to);
  const amount = takenDecimal(input?.amountUnits);
  if (to === undefined || amount === undefined || amount === 0n || amount > UINT96_MAX)
    throw refusal("pot_take_invalid", 400);

  // 3. A revocation is an event, and leaves the row linked.
  if (noted.row.bindingState !== "linked" || deps.bodies.isRevoked(noted.row.legalBodyId))
    throw refusal("pot_take_body_not_in_force", 409);

  // 4.
  const table = recomputedTable(deps, noted);

  // 5.
  if ([noted.view.address, table.usdc, table.allowanceModule].some((a) => sameAddress(a, to)))
    throw refusal("pot_take_bad_payee", 409);

  // 6.
  const { view, reading, raw } = await readNotedPot(deps, noted, table);

  // 7.
  if (reading.state !== "ceiling_read") throw refusal("pot_not_readable", 409);

  // 8.
  const left = leftOf(reading);
  if (amount > left) throw refusal("pot_take_over_ceiling", 409);

  // 9.
  if (amount > reading.balanceUnits) throw refusal("pot_take_over_balance", 409);

  // 10.
  return {
    chainId: view.chainId,
    from: view.agentWallet,
    to: table.allowanceModule,
    value: "0",
    data: takeCalldata({
      pot: view.pot,
      token: table.usdc,
      to,
      amountUnits: amount,
      agentWallet: view.agentWallet,
    }),
    gas: String(POT_TAKE_GAS),
    leftAfterUnits: (left - amount).toString(),
    how: sentenceFor("pot_take_how"),
    warning: raw.agentBalanceWei < POT_FEE_LOW_WEI ? sentenceFor("pot_take_low_fee_money") : null,
  };
}
