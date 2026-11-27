import type Database from "better-sqlite3";
import type { Address } from "viem";
import {
  LegalBodyInputError,
  ZERO_ADDRESS,
  checksummed,
  requireAddress,
  requirePublicLimit,
  requireSeconds,
} from "./legalBodyInput";

/**
 * THE COMPANY'S POT: what the guardian of a legal body noted about the company's pot, append-only.
 * A `declared` note puts the pot of an address on the public record, with the birth details its
 * address was recomputed from and the version of the declaration the guardian ticked; a `removed`
 * note takes it off. The latest note of a body says what is on the record; earlier declared notes
 * are former pots. No note is ever changed or removed. The table, and the guards the database
 * itself holds (no update, no delete, a new note only after the body's latest), are
 * `pot_declarations` in db.ts.
 *
 * A note says what the guardian DECLARED and what Novi recomputed: the address is the one a Safe
 * created with these birth details would have, the guardian its only owner. Whether it was created,
 * and what it holds, is read from the chain, never from a note.
 *
 * Like the legal-body repository, and by the same rules (`legalBodyInput.ts`), it throws a
 * `LegalBodyInputError`, before anything is written, for a value no note may hold: that is a bug
 * in the caller, never the outcome of a race. The domain (`legalBody/pot.ts`) refuses a request
 * with such a value before it gets here.
 */

export type PotAct = "declared" | "removed";

/** What anyone needs, beside the fixed addresses and the guardian, to recompute the pot's address. */
export interface PotBirthNote {
  /** Canonical decimal, at most 2^256 - 1. */
  saltNonce: string;
  /** The agent's key the pot was set up for: its first delegate. Checksummed. */
  agentWallet: Address;
  /** The first ceiling, in USDC units (6 decimals), canonical decimal. */
  ceilingUnits: string;
}

/** One note, as stored. */
export interface PotNote {
  legalBodyId: string;
  act: PotAct;
  /** Checksummed. Never the zero address. */
  address: Address;
  /** Present iff declared. */
  birth: PotBirthNote | null;
  /** The declaration's version the guardian ticked. Present iff declared. */
  declarationVersion: string | null;
  declaredBy: "guardian";
  /** Unix seconds. Strictly greater than the body's previous note's. */
  declaredAt: number;
}

/** A note to append: everything but its time, which `append` decides from `at`. */
export interface NewPotNote {
  legalBodyId: string;
  act: PotAct;
  address: Address;
  birth: PotBirthNote | null;
  declarationVersion: string | null;
  /** Unix seconds: the clock when the note was made. */
  at: number;
}

export interface LegalBodyPotRepository {
  /**
   * Appends the note, in one immediate transaction (a savepoint of the caller's, inside one), and
   * returns it as stored. Its `declaredAt` is `at`, or one second past the body's latest note when
   * `at` is not past it: so two notes in one second, or a clock that went back, are both kept, in
   * the order they were made, and the latest note is always the last one written. A value no note
   * may hold throws a `LegalBodyInputError` before anything is written; a body that does not exist
   * is refused by the database's foreign key.
   */
  append(n: NewPotNote): PotNote;
  /** The body's latest note: what is on the record. */
  latest(legalBodyId: string): PotNote | undefined;
  /** Every note of a body, oldest first. */
  list(legalBodyId: string): PotNote[];
  /** The bodies with a `declared` note of this address, in any letter case, distinct, the newest
   *  note first; at most `limit` (1 to 100). A value that is not an address finds none. */
  legalBodyIdsByAddress(address: Address, limit: number): string[];
}

/** The longest declaration version a note holds, in characters: the table's CHECK holds the same. */
export const MAX_POT_DECLARATION_VERSION_LENGTH = 40;

const UINT256_MAX = 2n ** 256n - 1n;
/** A whole number in canonical decimal: no sign, no leading zero, digits only. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/** The value as a canonical decimal string of at most 2^256 - 1, or a `LegalBodyInputError`. */
function requireDecimal(field: string, value: unknown, min: bigint): string {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !CANONICAL_DECIMAL.test(value) ||
    BigInt(value) < min ||
    BigInt(value) > UINT256_MAX
  )
    throw new LegalBodyInputError(
      `${field} must be a whole number from ${min} to 2^256 - 1 in canonical decimal`,
    );
  return value;
}

interface Row {
  legal_body_id: string;
  act: PotAct;
  address: string;
  salt_nonce: string | null;
  birth_agent_wallet: string | null;
  birth_ceiling_units: string | null;
  declaration_version: string | null;
  declared_by: "guardian";
  declared_at: number;
}

function toNote(r: Row): PotNote {
  const birth =
    r.salt_nonce === null || r.birth_agent_wallet === null || r.birth_ceiling_units === null
      ? null
      : {
          saltNonce: r.salt_nonce,
          agentWallet: r.birth_agent_wallet as Address,
          ceilingUnits: r.birth_ceiling_units,
        };
  return {
    legalBodyId: r.legal_body_id,
    act: r.act,
    address: r.address as Address,
    birth,
    declarationVersion: r.declaration_version,
    declaredBy: r.declared_by,
    declaredAt: r.declared_at,
  };
}

/** The note as a row, every field checked and in the form rows store it; its time is decided
 *  inside the transaction. */
function toNewRow(n: NewPotNote): Omit<Row, "declared_at" | "declared_by"> {
  if (typeof n.legalBodyId !== "string" || n.legalBodyId === "")
    throw new LegalBodyInputError("legalBodyId must be a legal body's id");
  if (n.act !== "declared" && n.act !== "removed")
    throw new LegalBodyInputError("act must be declared or removed");
  const address = requireAddress("address", n.address);
  if (address.toLowerCase() === ZERO_ADDRESS)
    throw new LegalBodyInputError("address must not be the zero address");
  requireSeconds("at", n.at);
  if (n.act === "removed") {
    if (n.birth !== null || n.declarationVersion !== null)
      throw new LegalBodyInputError("a removed note holds no birth details and no version");
    return {
      legal_body_id: n.legalBodyId,
      act: "removed",
      address,
      salt_nonce: null,
      birth_agent_wallet: null,
      birth_ceiling_units: null,
      declaration_version: null,
    };
  }
  const birth = n.birth;
  if (typeof birth !== "object" || birth === null)
    throw new LegalBodyInputError("a declared note holds its birth details");
  const agentWallet = requireAddress("birth.agentWallet", birth.agentWallet);
  if (agentWallet.toLowerCase() === ZERO_ADDRESS)
    throw new LegalBodyInputError("birth.agentWallet must not be the zero address");
  const version = n.declarationVersion;
  if (
    typeof version !== "string" ||
    version === "" ||
    [...version].length > MAX_POT_DECLARATION_VERSION_LENGTH
  )
    throw new LegalBodyInputError(
      `declarationVersion must be 1 to ${MAX_POT_DECLARATION_VERSION_LENGTH} characters for a declared note`,
    );
  return {
    legal_body_id: n.legalBodyId,
    act: "declared",
    address,
    salt_nonce: requireDecimal("birth.saltNonce", birth.saltNonce, 0n),
    birth_agent_wallet: agentWallet,
    birth_ceiling_units: requireDecimal("birth.ceilingUnits", birth.ceilingUnits, 1n),
    declaration_version: version,
  };
}

export class SqliteLegalBodyPotRepository implements LegalBodyPotRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      // The primary key (legal_body_id, declared_at) answers these from its index.
      latest: db.prepare(
        "SELECT * FROM pot_declarations WHERE legal_body_id = ? ORDER BY declared_at DESC LIMIT 1",
      ),
      list: db.prepare(
        "SELECT * FROM pot_declarations WHERE legal_body_id = ? ORDER BY declared_at ASC",
      ),
      // The partial index on declared addresses answers this one.
      byAddress: db.prepare(
        `SELECT legal_body_id, MAX(declared_at) AS newest FROM pot_declarations
          WHERE act = 'declared' AND address = ?
          GROUP BY legal_body_id
          ORDER BY newest DESC, legal_body_id ASC
          LIMIT ?`,
      ),
      insert: db.prepare(
        `INSERT INTO pot_declarations
           (legal_body_id, act, address, salt_nonce, birth_agent_wallet, birth_ceiling_units,
            declaration_version, declared_at)
         VALUES (@legal_body_id, @act, @address, @salt_nonce, @birth_agent_wallet,
                 @birth_ceiling_units, @declaration_version, @declared_at)`,
      ),
    };
  }

  append(n: NewPotNote): PotNote {
    const row = toNewRow(n);
    // IMMEDIATE: the write lock is held from the read of the latest row, so no other writer can
    // add a row between the time chosen and the insert.
    return this.db
      .transaction((): PotNote => {
        const latest = this.stmts.latest.get(row.legal_body_id) as Row | undefined;
        const declaredAt = latest === undefined ? n.at : Math.max(n.at, latest.declared_at + 1);
        this.stmts.insert.run({ ...row, declared_at: declaredAt });
        return toNote({ ...row, declared_by: "guardian", declared_at: declaredAt });
      })
      .immediate();
  }

  latest(legalBodyId: string): PotNote | undefined {
    const r = this.stmts.latest.get(legalBodyId) as Row | undefined;
    return r ? toNote(r) : undefined;
  }

  list(legalBodyId: string): PotNote[] {
    return (this.stmts.list.all(legalBodyId) as Row[]).map(toNote);
  }

  legalBodyIdsByAddress(address: Address, limit: number): string[] {
    const max = requirePublicLimit(limit);
    const stored = typeof address === "string" ? checksummed(address) : null;
    if (stored === null) return [];
    return (this.stmts.byAddress.all(stored, max) as { legal_body_id: string }[]).map(
      (r) => r.legal_body_id,
    );
  }
}
