import type Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import {
  LegalBodyInputError,
  ZERO_ADDRESS,
  lowerHash,
  requireAddress,
  requireSeconds,
} from "./legalBodyInput";

/**
 * THE TREASURY OF RECORD: what the guardian of a linked legal body declared about the wallet its
 * agent pays from, append-only. The latest row of a body is its record; a new attach appends a new
 * row, and no row is ever changed or removed. The table, and the guards the database itself holds
 * (no update, no delete, a new row only after the body's latest), are `treasury_declarations` in
 * db.ts.
 *
 * A row says what the guardian DECLARED: the provider, and where the wallet's limits can be read.
 * Novi checked one thing before it was written, that the registry showed the address as the
 * agent's wallet at that moment. Nothing else in a row was checked by anyone.
 *
 * Like the legal-body repository, and by the same rules (`legalBodyInput.ts`), it throws a
 * `LegalBodyInputError`, before anything is written, for a value no row may hold: that is a bug in
 * the caller, never the outcome of a race. The domain (`legalBody/treasury.ts`) refuses a request
 * with such a value before it gets here.
 */

/** Who provides the wallet, as the guardian declares it: `own_key` is a wallet its owner's key
 *  controls, with no provider. The table's CHECK writes the same four. */
export const TREASURY_PROVIDERS = ["crossmint", "circle", "other", "own_key"] as const;
export type TreasuryProvider = (typeof TREASURY_PROVIDERS)[number];

export const isTreasuryProvider = (value: unknown): value is TreasuryProvider =>
  (TREASURY_PROVIDERS as readonly unknown[]).includes(value);

/** The longest provider name a row holds, in characters: the table's CHECK holds the same. */
export const MAX_PROVIDER_NAME_LENGTH = 80;
/** The longest link to the wallet's limits a row holds, in characters (Ruling 4). */
export const MAX_LIMITS_URL_LENGTH = 300;

/** One declaration, as stored. */
export interface TreasuryDeclaration {
  legalBodyId: string;
  /** Checksummed. Never the zero address. */
  address: Address;
  provider: TreasuryProvider;
  /** The provider's name as the guardian wrote it, for `other` only; null for every other
   *  provider. */
  providerName: string | null;
  /** An `https://` link of at most 300 characters, as the guardian wrote it, or null. */
  limitsReadableAt: string | null;
  declaredBy: "guardian";
  /** Unix seconds. Strictly greater than the body's previous declaration's. */
  declaredAt: number;
  /** The registry transaction the guardian says made the attach, lower-case; null when none was
   *  given. Never fetched nor checked against the chain. */
  registryTxHash: Hex | null;
}

/** A declaration to append: everything but its time, which `append` decides from `at`. */
export interface NewTreasuryDeclaration {
  legalBodyId: string;
  address: Address;
  provider: TreasuryProvider;
  providerName: string | null;
  limitsReadableAt: string | null;
  registryTxHash: Hex | null;
  /** Unix seconds: the clock when the declaration was made. */
  at: number;
}

export interface LegalBodyTreasuryRepository {
  /**
   * Appends the declaration, in one immediate transaction (a savepoint of the caller's, inside
   * one), and returns it as stored. Its `declaredAt` is `at`, or one second past the body's latest
   * declaration when `at` is not past it: so two declarations in one second, or a clock that went
   * back, are both kept, in the order they were made, and the latest row is always the last one
   * written. A value no row may hold throws a `LegalBodyInputError` before anything is written; a
   * body that does not exist is refused by the database's foreign key.
   */
  append(d: NewTreasuryDeclaration): TreasuryDeclaration;
  /** The body's latest declaration: its record. */
  latest(legalBodyId: string): TreasuryDeclaration | undefined;
}

interface Row {
  legal_body_id: string;
  address: string;
  provider: TreasuryProvider;
  provider_name: string | null;
  limits_readable_at: string | null;
  declared_by: "guardian";
  declared_at: number;
  registry_tx_hash: string | null;
}

function toDeclaration(r: Row): TreasuryDeclaration {
  return {
    legalBodyId: r.legal_body_id,
    address: r.address as Address,
    provider: r.provider,
    providerName: r.provider_name,
    limitsReadableAt: r.limits_readable_at,
    declaredBy: r.declared_by,
    declaredAt: r.declared_at,
    registryTxHash: r.registry_tx_hash as Hex | null,
  };
}

/** The declaration as a row, every field checked and in the form rows store it; its time is
 *  decided inside the transaction. */
function toNewRow(d: NewTreasuryDeclaration): Omit<Row, "declared_at" | "declared_by"> {
  if (typeof d.legalBodyId !== "string" || d.legalBodyId === "")
    throw new LegalBodyInputError("legalBodyId must be a legal body's id");
  const address = requireAddress("address", d.address);
  if (address.toLowerCase() === ZERO_ADDRESS)
    throw new LegalBodyInputError("address must not be the zero address");
  if (!isTreasuryProvider(d.provider))
    throw new LegalBodyInputError(`provider must be one of ${TREASURY_PROVIDERS.join(", ")}`);
  const name = d.providerName;
  if (d.provider === "other") {
    if (typeof name !== "string" || name === "" || [...name].length > MAX_PROVIDER_NAME_LENGTH)
      throw new LegalBodyInputError(
        `providerName must be 1 to ${MAX_PROVIDER_NAME_LENGTH} characters for another provider`,
      );
  } else if (name !== null)
    throw new LegalBodyInputError("providerName is held for another provider only");
  const url = d.limitsReadableAt;
  if (
    url !== null &&
    (typeof url !== "string" || !url.startsWith("https://") || url.length > MAX_LIMITS_URL_LENGTH)
  )
    throw new LegalBodyInputError(
      `limitsReadableAt must be an https:// link of at most ${MAX_LIMITS_URL_LENGTH} characters, or null`,
    );
  const hash = d.registryTxHash === null ? null : lowerHash(d.registryTxHash);
  if (d.registryTxHash !== null && hash === null)
    throw new LegalBodyInputError("registryTxHash must be 0x and 64 hex digits, or null");
  requireSeconds("at", d.at);
  return {
    legal_body_id: d.legalBodyId,
    address,
    provider: d.provider,
    provider_name: name,
    limits_readable_at: url,
    registry_tx_hash: hash,
  };
}

export class SqliteLegalBodyTreasuryRepository implements LegalBodyTreasuryRepository {
  private readonly stmts;

  constructor(private readonly db: Database.Database) {
    this.stmts = {
      // The primary key (legal_body_id, declared_at) answers this from its index.
      latest: db.prepare(
        "SELECT * FROM treasury_declarations WHERE legal_body_id = ? ORDER BY declared_at DESC LIMIT 1",
      ),
      insert: db.prepare(
        `INSERT INTO treasury_declarations
           (legal_body_id, address, provider, provider_name, limits_readable_at, declared_at,
            registry_tx_hash)
         VALUES (@legal_body_id, @address, @provider, @provider_name, @limits_readable_at,
                 @declared_at, @registry_tx_hash)`,
      ),
    };
  }

  append(d: NewTreasuryDeclaration): TreasuryDeclaration {
    const row = toNewRow(d);
    // IMMEDIATE: the write lock is held from the read of the latest row, so no other writer can
    // add a row between the time chosen and the insert.
    return this.db
      .transaction((): TreasuryDeclaration => {
        const latest = this.stmts.latest.get(row.legal_body_id) as Row | undefined;
        const declaredAt = latest === undefined ? d.at : Math.max(d.at, latest.declared_at + 1);
        const stored: Row = { ...row, declared_by: "guardian", declared_at: declaredAt };
        this.stmts.insert.run({ ...row, declared_at: declaredAt });
        return toDeclaration(stored);
      })
      .immediate();
  }

  latest(legalBodyId: string): TreasuryDeclaration | undefined {
    const r = this.stmts.latest.get(legalBodyId) as Row | undefined;
    return r ? toDeclaration(r) : undefined;
  }
}
