import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * THE SVIX SIGNATURE CHECK of the email provider's delivery webhook
 * (src/api/routes/emailWebhook.ts), with node's `crypto` and nothing else (no Svix package).
 *
 * The scheme, as the provider documents it:
 *  - the signing secret is `whsec_` and a base64 key; the HMAC key is the decoded bytes, never the
 *    string;
 *  - every delivery carries three headers: `svix-id` (the message), `svix-timestamp` (Unix
 *    SECONDS) and `svix-signature`;
 *  - the signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, and the signature is its
 *    HMAC-SHA256, base64;
 *  - `svix-signature` holds one or more space-separated `v1,<signature>` candidates (more than one
 *    while a secret is being rotated), and any of them may match.
 *
 * A timestamp more than five minutes from now, either way, is refused, so a captured delivery
 * cannot be replayed later. Every refusal is one of three codes, for the route's ops line; the
 * route answers each with the same 401.
 */

/** How far a delivery's timestamp may be from now, either way. */
export const SVIX_TOLERANCE_MS = 5 * 60 * 1000;

/** The three headers, as the route reads them. */
export const SVIX_ID_HEADER = "svix-id";
export const SVIX_TIMESTAMP_HEADER = "svix-timestamp";
export const SVIX_SIGNATURE_HEADER = "svix-signature";

export type SvixRefusal = "missing_header" | "bad_timestamp" | "bad_signature";
export type SvixVerdict = "verified" | SvixRefusal;

const SECRET_PREFIX = "whsec_";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Whole seconds, no sign, no exponent, no space. */
const WHOLE_SECONDS = /^[0-9]{1,15}$/;

/** The shortest signing key accepted, in bytes: a shorter one is truncated or guessable. */
export const SVIX_MIN_KEY_BYTES = 16;

/**
 * The HMAC key of a `whsec_` secret, the base64 after the prefix decoded; undefined when the
 * secret has another form or its key is under 16 bytes. The boot's check of
 * RESEND_WEBHOOK_SECRET and `svixSigningKey` both read it, so the two cannot disagree.
 */
export function decodeSvixSecret(secret: string): Buffer | undefined {
  const b64 = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : "";
  if (!BASE64.test(b64)) return undefined;
  const key = Buffer.from(b64, "base64");
  return key.length >= SVIX_MIN_KEY_BYTES ? key : undefined;
}

/**
 * The HMAC key of a `whsec_` secret. Throws on any other form or a key under 16 bytes; the boot
 * already refuses both (RESEND_WEBHOOK_SECRET's own check), so this is the second guard, at the
 * route's mount, never per request. The message never quotes the secret.
 */
export function svixSigningKey(secret: string): Buffer {
  const key = decodeSvixSecret(secret);
  if (key === undefined)
    throw new Error(
      "svix: the signing secret must be whsec_ followed by a base64 key of at least 16 bytes",
    );
  return key;
}

/**
 * Whether a delivery is the provider's: its headers' timestamp within five minutes of `nowMs`,
 * either way, and one of its `v1` candidates the signature of `${id}.${timestamp}.${rawBody}`.
 *
 * Each candidate is compared with `timingSafeEqual` on buffers of the same length (it throws on
 * two lengths, so a candidate of another length is skipped, never thrown on), and every candidate
 * is compared: the answer does not depend on which one matched.
 */
export function verifySvixSignature(
  key: Buffer,
  rawBody: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  nowMs: number,
): SvixVerdict {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return "missing_header";

  if (!WHOLE_SECONDS.test(timestamp)) return "bad_timestamp";
  if (Math.abs(nowMs - Number(timestamp) * 1000) > SVIX_TOLERANCE_MS) return "bad_timestamp";

  const expected = Buffer.from(
    createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest("base64"),
    "utf8",
  );
  let matched = false;
  for (const entry of signature.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
    // Compared as the base64 text the provider sent, not decoded: node's base64 decoder skips
    // characters it does not know, so two different strings could decode to the same bytes.
    const candidate = Buffer.from(entry.slice(comma + 1), "utf8");
    if (candidate.length !== expected.length) continue;
    if (timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched ? "verified" : "bad_signature";
}
