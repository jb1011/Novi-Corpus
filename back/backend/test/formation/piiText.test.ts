/**
 * Encrypted text fields on the PII keyring (the same AES-256-GCM construction as the SSN, with the
 * AAD the caller names) and the name fingerprint for duplicate search: a keyed digest of a name
 * under its own secret, `IDENTITY_NAME_HMAC_KEY`, which the PII key takes no part in.
 *
 * Every name here is a made-up fixture, every key a random test key.
 */
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  type PiiKeyring,
  decryptText,
  encryptText,
  nameHmac,
  parsePiiKey,
} from "../../src/formation/pii";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
/** The fingerprint secret: 32 bytes, as `IDENTITY_NAME_HMAC_KEY` decodes to. */
const FINGERPRINT = randomBytes(32);
const AAD = "identity|0x00000000000000000000000000000000000000Aa|first";

function ring(current: string, previous?: string): PiiKeyring {
  return {
    current: parsePiiKey(current, "FORMATION_PII_KEY"),
    previous: previous ? parsePiiKey(previous, "FORMATION_PII_KEY_PREVIOUS") : undefined,
  };
}

test("round trips under the current key, with a fresh IV each time", () => {
  const k = ring(KEY_A);
  const one = encryptText(k, "Élodie", AAD);
  const two = encryptText(k, "Élodie", AAD);
  expect(decryptText(k, one, AAD)).toBe("Élodie");
  expect(one.keyId).toBe(k.current.id);
  expect(one.iv).toHaveLength(12);
  expect(one.iv.equals(two.iv)).toBe(false);
});

test("a different AAD will not open the ciphertext", () => {
  const k = ring(KEY_A);
  const rec = encryptText(k, "Élodie", AAD);
  expect(() => decryptText(k, rec, `${AAD}x`)).toThrow();
  expect(() =>
    decryptText(k, rec, "identity|0x00000000000000000000000000000000000000Aa|last"),
  ).toThrow();
});

test("a ciphertext written under the previous key opens by its key id", () => {
  const written = encryptText(ring(KEY_A), "Élodie", AAD);
  const rotated = ring(KEY_B, KEY_A);
  expect(written.keyId).toBe(rotated.previous!.id);
  expect(decryptText(rotated, written, AAD)).toBe("Élodie");
  expect(encryptText(rotated, "Élodie", AAD).keyId).toBe(rotated.current.id);
});

test("a key this box does not have is a named error, never a trial decrypt", () => {
  const written = encryptText(ring(KEY_A), "Élodie", AAD);
  expect(() => decryptText(ring(KEY_B), written, AAD)).toThrow(/no PII key with id fpk1:/);
});

test("a tampered or truncated ciphertext throws", () => {
  const k = ring(KEY_A);
  const rec = encryptText(k, "Élodie", AAD);
  const flipped = Buffer.from(rec.ciphertext);
  flipped[0] = (flipped[0] ?? 0) ^ 1;
  expect(() => decryptText(k, { ...rec, ciphertext: flipped }, AAD)).toThrow();
  expect(() => decryptText(k, { ...rec, ciphertext: rec.ciphertext.subarray(0, 4) }, AAD)).toThrow(
    /truncated/,
  );
  expect(() => decryptText(k, { ...rec, iv: rec.iv.subarray(0, 4) }, AAD)).toThrow(/malformed IV/);
});

test("the name HMAC ignores case and is 64 hex characters", () => {
  const h = nameHmac(FINGERPRINT, "Jean", "DUPONT");
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  expect(nameHmac(FINGERPRINT, "jean", "Dupont")).toBe(h);
});

test("the name HMAC differs for a different name", () => {
  expect(nameHmac(FINGERPRINT, "Jean", "Dupond")).not.toBe(nameHmac(FINGERPRINT, "Jean", "Dupont"));
});

test("the name HMAC collapses whitespace and applies NFKC", () => {
  const h = nameHmac(FINGERPRINT, "Ana María", "Dupont");
  expect(nameHmac(FINGERPRINT, "  Ana   María ", " Dupont")).toBe(h);
  // A decomposed accent and a full-width letter normalise to the same text.
  expect(nameHmac(FINGERPRINT, "Ana María", "Dupont")).toBe(h);
  expect(nameHmac(FINGERPRINT, "Ana María", "Ｄupont")).toBe(h);
});

test("the name HMAC is keyed by HKDF of the fingerprint secret with the v1 info string", () => {
  const derived = Buffer.from(
    hkdfSync("sha256", FINGERPRINT, Buffer.alloc(0), "novi:identity:name-hmac:v1", 32),
  );
  const expected = createHmac("sha256", derived).update("jean\ndupont", "utf8").digest("hex");
  expect(nameHmac(FINGERPRINT, "Jean", "Dupont")).toBe(expected);
  // Another secret is another digest.
  expect(nameHmac(randomBytes(32), "Jean", "Dupont")).not.toBe(expected);
});
