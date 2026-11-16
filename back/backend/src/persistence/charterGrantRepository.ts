import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { type Grant, SCHEDULE_A_WORDING, grantFromCanonical } from "../legalBody/grant";
import { LegalBodyInputError, isIntegerWithin, requireHash } from "./legalBodyInput";

/**
 * THE GRANTS OF AN ORDER: one row per version of an order's grant, written once. A row holds the
 * grant's canonical form, the text its fingerprint is taken over, and that fingerprint, both as the
 * grant's constructor computed them (`legalBody/grant.ts`), and the id of the Schedule A wording
 * the grant was written in. The grant is read back from its canonical form (`grantFromCanonical`).
 *
 * The table and the guards the database itself holds (no update, no delete, a new row only after
 * the order's latest) are `charter_grants` in db.ts.
 *
 * By the rules of the legal-body tables (`legalBodyInput.ts`), it throws a `LegalBodyInputError`,
 * before anything is written, for a value no row may hold: that is a bug in the caller, never the
 * outcome of a race.
 */

export interface CharterGrantRow {
  legalBodyId: string;
  number: number;
  version: number;
  /** The grant's canonical form: the text its fingerprint is taken over. */
  canonical: string;
  /** Lower-case. */
  digest: Hex;
  /** The id of the Schedule A wording the grant was written in. */
  wording: string;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. */
  createdAt: string;
}

export interface CharterGrantRepository {
  /** Writes `grant` for the order, in the wording SCHEDULE_A_WORDING names, from the grant its
   *  canonical form states: a grant whose number, version or fingerprint is not that one's is
   *  refused. The database refuses a row that is not after the order's latest (so a second row of
   *  the same number and version too), and an order that does not exist. */
  insert(legalBodyId: string, grant: Grant): void;
  /** The order's rows, by number, then version. */
  list(legalBodyId: string): CharterGrantRow[];
}

/** The longest canonical form a row holds, in characters: the table's CHECK holds the same. */
const MAX_CANONICAL_LENGTH = 4096;
/** Printable ASCII, the only characters the canonical form of a grant is written in: so its length
 *  in bytes is its length in characters, as the table's CHECK holds. */
const CANONICAL = new RegExp(`^[ -~]{2,${MAX_CANONICAL_LENGTH}}$`);

interface Row {
  legal_body_id: string;
  grant_number: number;
  grant_version: number;
  canonical: string;
  digest: string;
  wording: string;
  created_at: string;
}

function toGrantRow(r: Row): CharterGrantRow {
  return {
    legalBodyId: r.legal_body_id,
    number: r.grant_number,
    version: r.grant_version,
    canonical: r.canonical,
    digest: r.digest as Hex,
    wording: r.wording,
    createdAt: r.created_at,
  };
}

function requireWholeFromOne(field: string, value: unknown): number {
  if (!isIntegerWithin(value, 1, Number.MAX_SAFE_INTEGER))
    throw new LegalBodyInputError(`${field} must be a whole number of at least 1`);
  return value;
}

export class SqliteCharterGrantRepository implements CharterGrantRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO charter_grants
           (legal_body_id, grant_number, grant_version, canonical, digest, wording)
         VALUES (@legal_body_id, @grant_number, @grant_version, @canonical, @digest, @wording)`,
      ),
      // The primary key (legal_body_id, grant_number, grant_version) answers this from its index.
      list: db.prepare(
        `SELECT * FROM charter_grants WHERE legal_body_id = ?
          ORDER BY grant_number, grant_version`,
      ),
    };
  }

  insert(legalBodyId: string, grant: Grant): void {
    if (typeof legalBodyId !== "string" || legalBodyId === "")
      throw new LegalBodyInputError("legalBodyId must be a legal body's id");
    if (typeof grant.canonical !== "string" || !CANONICAL.test(grant.canonical))
      throw new LegalBodyInputError(
        `canonical must be 2 to ${MAX_CANONICAL_LENGTH} characters of printable ASCII`,
      );
    requireWholeFromOne("number", grant.value.number);
    requireWholeFromOne("version", grant.value.version);
    requireHash("digest", grant.digest);
    // The row is written from the grant its canonical form states, never from the object given: a
    // `Grant` is a structural type, so an object whose key or fingerprint disagrees with its
    // canonical form is one to the compiler, and a row is never corrected.
    const stated = grantFromCanonical(grant.canonical);
    if (
      stated === undefined ||
      stated.digest !== grant.digest ||
      stated.value.number !== grant.value.number ||
      stated.value.version !== grant.value.version
    )
      throw new LegalBodyInputError("grant must be the grant its canonical form states");
    this.stmts.insert.run({
      legal_body_id: legalBodyId,
      grant_number: stated.value.number,
      grant_version: stated.value.version,
      canonical: stated.canonical,
      digest: stated.digest,
      wording: SCHEDULE_A_WORDING,
    });
  }

  list(legalBodyId: string): CharterGrantRow[] {
    return (this.stmts.list.all(legalBodyId) as Row[]).map(toGrantRow);
  }
}
