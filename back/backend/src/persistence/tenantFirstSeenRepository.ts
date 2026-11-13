import type Database from "better-sqlite3";
import { type Address, getAddress, isAddress } from "viem";

/**
 * AN ACCOUNT'S FIRST SIGN-IN: the funnel's "signed in" stage (`funnel:export`, design §6.14). One
 * row per wallet address, written by `POST /auth/verify` once the SIWE signature has been checked,
 * with INSERT OR IGNORE: a later sign-in writes nothing, so the time is the first one for good.
 * `auth_nonces` holds no address and the sign-in's ops line lives only on the box, so without this
 * table the funnel has no first stage.
 *
 * The table is `tenant_first_seen` in db.ts. Nothing but the funnel reads it.
 */

export interface TenantFirstSeen {
  /** Checksummed. */
  address: Address;
  /** Unix milliseconds. */
  firstSeenAt: number;
}

export interface TenantFirstSeenRepository {
  /**
   * Records the account's first sign-in at `at` (unix milliseconds) unless it has one. True when
   * this call wrote the row. Throws, before writing, for a value that is not an address or not a
   * time in milliseconds.
   */
  recordFirstSeen(address: string, at: number): boolean;
  find(address: string): TenantFirstSeen | undefined;
}

/** The smallest time in milliseconds the table takes: past the largest the seconds columns do. */
const MIN_MILLIS = 100_000_000_000;

function addressOf(value: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    throw new Error("tenant_first_seen: the account must be a 0x address");
  return getAddress(value);
}

export class SqliteTenantFirstSeenRepository implements TenantFirstSeenRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        "INSERT OR IGNORE INTO tenant_first_seen (address, first_seen_at) VALUES (?, ?)",
      ),
      find: db.prepare("SELECT address, first_seen_at FROM tenant_first_seen WHERE address = ?"),
    };
  }

  recordFirstSeen(address: string, at: number): boolean {
    const account = addressOf(address);
    if (!Number.isSafeInteger(at) || at < MIN_MILLIS)
      throw new Error("tenant_first_seen: the time must be whole unix milliseconds");
    return this.stmts.insert.run(account, at).changes === 1;
  }

  find(address: string): TenantFirstSeen | undefined {
    const row = this.stmts.find.get(addressOf(address)) as
      | { address: string; first_seen_at: number }
      | undefined;
    return row === undefined
      ? undefined
      : { address: row.address as Address, firstSeenAt: row.first_seen_at };
  }
}
