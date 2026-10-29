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
