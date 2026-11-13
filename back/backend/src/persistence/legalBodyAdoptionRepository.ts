import type Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import {
  ECDSA_SIGNATURE,
  LegalBodyInputError,
  requireAddress,
  requireHash,
  requireSeconds,
} from "./legalBodyInput";

/**
 * THE ADOPTIONS OF AN ORDER'S OPERATING AGREEMENT: one row per order, written once, when its
 * guardian signs the adoption of the agreement frozen for it (`legalBody/adoption.ts`). The link
 * doors read only whether the row exists; the row itself is evidence, holding exactly what the
 * guardian signed (the manifest hash, the text id and version, the guardian, the time it was
 * issued) and the signature and digest, so the signature can be checked again from the row alone.
 *
 * The table and the guards the database itself holds (one row per order, no update, no delete, no
 * replace) are `agreement_adoptions` in db.ts.
 */

export interface AgreementAdoption {
  legalBodyId: string;
  /** The order's frozen manifest hash, lower-case. */
  manifestHash: Hex;
  textId: string;
  textVersion: string;
  /** Checksummed: always the order's tenant. */
  guardian: Address;
  /** Unix seconds: when the message was issued, by the server's clock. */
  issuedAt: number;
  /** 65 bytes, lower-case hex. */
  signature: Hex;
  /** The EIP-712 digest the signature covers, lower-case. */
  digest: Hex;
  /** Unix seconds: when the adoption was stored. */
  adoptedAt: number;
  /** UTC, `YYYY-MM-DD HH:MM:SS`. */
  createdAt: string;
}

export type NewAgreementAdoption = Omit<AgreementAdoption, "createdAt">;

export interface LegalBodyAdoptionRepository {
  /** The order's adoption, if one was stored. */
  find(legalBodyId: string): AgreementAdoption | undefined;
  /**
   * Stores the adoption. Throws a `LegalBodyInputError`, before writing, for a value no row may
   * hold; throws the database's own refusal for a second adoption of the same order and for an
   * order that does not exist.
   */
  insert(a: NewAgreementAdoption): void;
}

interface Row {
  legal_body_id: string;
  manifest_hash: string;
  text_id: string;
  text_version: string;
  guardian: string;
  issued_at: number;
  signature: string;
  digest: string;
  adopted_at: number;
  created_at: string;
}

function toAdoption(r: Row): AgreementAdoption {
  return {
    legalBodyId: r.legal_body_id,
    manifestHash: r.manifest_hash as Hex,
    textId: r.text_id,
    textVersion: r.text_version,
    guardian: r.guardian as Address,
    issuedAt: r.issued_at,
    signature: r.signature as Hex,
    digest: r.digest as Hex,
    adoptedAt: r.adopted_at,
    createdAt: r.created_at,
  };
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new LegalBodyInputError(`${field} must be a non-empty string`);
  return value;
}

export class SqliteLegalBodyAdoptionRepository implements LegalBodyAdoptionRepository {
  private readonly stmts;

  constructor(db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO agreement_adoptions
           (legal_body_id, manifest_hash, text_id, text_version, guardian, issued_at, signature,
            digest, adopted_at)
         VALUES (@legal_body_id, @manifest_hash, @text_id, @text_version, @guardian, @issued_at,
                 @signature, @digest, @adopted_at)`,
      ),
      find: db.prepare("SELECT * FROM agreement_adoptions WHERE legal_body_id = ?"),
    };
  }

  find(legalBodyId: string): AgreementAdoption | undefined {
    const row = this.stmts.find.get(legalBodyId) as Row | undefined;
    return row === undefined ? undefined : toAdoption(row);
  }

  insert(a: NewAgreementAdoption): void {
    if (typeof a.signature !== "string" || !ECDSA_SIGNATURE.test(a.signature))
      throw new LegalBodyInputError("signature must be 0x and 130 hex digits (65 bytes)");
    this.stmts.insert.run({
      legal_body_id: requireText("legalBodyId", a.legalBodyId),
      manifest_hash: requireHash("manifestHash", a.manifestHash),
      text_id: requireText("textId", a.textId),
      text_version: requireText("textVersion", a.textVersion),
      guardian: requireAddress("guardian", a.guardian),
      issued_at: requireSeconds("issuedAt", a.issuedAt),
      signature: a.signature.toLowerCase(),
      digest: requireHash("digest", a.digest),
      adopted_at: requireSeconds("adoptedAt", a.adoptedAt),
    });
  }
}
