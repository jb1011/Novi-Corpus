/**
 * The argument helpers every pilot command module shares. A leaf: it imports nothing, so the
 * command modules can all depend on it without depending on each other.
 */

const CASE_ID = /^pc_[0-9a-f]{12}$/;

export function refuse(message: string): never {
  throw new Error(`refusing: ${message}`);
}

export function parseCaseId(option: string, value: string): string {
  if (!CASE_ID.test(value)) refuse(`${option} must be a pilot case id (pc_ and 12 hex digits)`);
  return value;
}

/** A transaction hash: 0x and 64 hex digits, returned in lower case. */
export function parseTxHash(option: string, value: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    refuse(`${option} must be a transaction hash (0x and 64 hex digits)`);
  return value.toLowerCase() as `0x${string}`;
}
