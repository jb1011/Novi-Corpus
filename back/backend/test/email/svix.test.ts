/**
 * The Svix signature check of the provider's delivery webhook (`src/email/svix.ts`): the secret is
 * `whsec_` and base64, the signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, the
 * signature is the HMAC-SHA256 of it in base64, and the `svix-signature` header carries one or
 * more space-separated `v1,<signature>` candidates, any of which may match. A timestamp more than
 * five minutes from now, either way, is refused, and so is a missing header.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  SVIX_MIN_KEY_BYTES,
  SVIX_TOLERANCE_MS,
  decodeSvixSecret,
  svixSigningKey,
  verifySvixSignature,
} from "../../src/email/svix";

/** Svix's own published example, so the check is held to the scheme and not only to itself. */
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: "1614265330",
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const VECTOR_NOW = 1614265330 * 1000;

const SECRET = `whsec_${Buffer.from("a-test-signing-secret-of-32-bytes").toString("base64")}`;
const KEY = svixSigningKey(SECRET);
const NOW = Date.UTC(2026, 10, 10, 12);
const TS = String(NOW / 1000);
const BODY = '{"type":"email.delivered","data":{"email_id":"msg_1"}}';

/** A `v1,<signature>` candidate over the given parts, with the given secret. */
function candidate(id: string, ts: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}
const headers = (over: Partial<Record<"id" | "timestamp" | "signature", string | undefined>>) => ({
  id: "msg_1",
  timestamp: TS,
  signature: candidate("msg_1", TS, BODY),
  ...over,
});

test("Svix's published example verifies: the secret is base64-decoded, the content is id.timestamp.body", () => {
  expect(
    verifySvixSignature(
      svixSigningKey(VECTOR.secret),
      VECTOR.body,
      { id: VECTOR.id, timestamp: VECTOR.timestamp, signature: VECTOR.signature },
      VECTOR_NOW,
    ),
  ).toBe("verified");
});

test("a correctly signed delivery verifies", () => {
  expect(verifySvixSignature(KEY, BODY, headers({}), NOW)).toBe("verified");
});

describe("the header carries several candidates", () => {
  test("any one of them may match, wherever it stands", () => {
    const good = candidate("msg_1", TS, BODY);
    const other = candidate("msg_1", TS, BODY, `whsec_${Buffer.from("other").toString("base64")}`);
    for (const signature of [`${other} ${good}`, `${good} ${other}`, `v1,AAAA ${other} ${good}`])
      expect(verifySvixSignature(KEY, BODY, headers({ signature }), NOW)).toBe("verified");
  });

  test("only v1 candidates count: the right signature under another version is refused", () => {
    const sig = candidate("msg_1", TS, BODY).slice("v1,".length);
    for (const signature of [`v2,${sig}`, sig, `,${sig}`, `v1${sig}`])
      expect(verifySvixSignature(KEY, BODY, headers({ signature }), NOW)).toBe("bad_signature");
  });

  test("none matching is refused, and a candidate of another length is refused without a throw", () => {
    const sig = candidate("msg_1", TS, BODY);
    for (const signature of ["v1,", "v1,AAAA", `${sig}A`, sig.slice(0, -2), "v1,not base64 at all"])
      expect(verifySvixSignature(KEY, BODY, headers({ signature }), NOW)).toBe("bad_signature");
  });
});

test("the signature covers the body, the id and the timestamp: changing any of them is refused", () => {
  expect(verifySvixSignature(KEY, `${BODY} `, headers({}), NOW)).toBe("bad_signature");
  expect(verifySvixSignature(KEY, BODY, headers({ id: "msg_2" }), NOW)).toBe("bad_signature");
  expect(verifySvixSignature(KEY, BODY, headers({ timestamp: String(NOW / 1000 + 1) }), NOW)).toBe(
    "bad_signature",
  );
});

test("another secret's signature is refused", () => {
  const other = svixSigningKey(`whsec_${Buffer.from("a-different-secret").toString("base64")}`);
  expect(verifySvixSignature(other, BODY, headers({}), NOW)).toBe("bad_signature");
});

test("a missing or empty header is refused, each of the three", () => {
  for (const name of ["id", "timestamp", "signature"] as const)
    for (const value of [undefined, ""])
      expect(verifySvixSignature(KEY, BODY, headers({ [name]: value }), NOW), name).toBe(
        "missing_header",
      );
});

describe("the timestamp", () => {
  const at = (offsetMs: number) => {
    const ts = String((NOW + offsetMs) / 1000);
    return verifySvixSignature(
      KEY,
      BODY,
      { id: "msg_1", timestamp: ts, signature: candidate("msg_1", ts, BODY) },
      NOW,
    );
  };

  test("five minutes from now, either way, is accepted; a second more, either way, is refused", () => {
    expect(SVIX_TOLERANCE_MS).toBe(5 * 60 * 1000);
    expect(at(-SVIX_TOLERANCE_MS)).toBe("verified");
    expect(at(SVIX_TOLERANCE_MS)).toBe("verified");
    expect(at(-SVIX_TOLERANCE_MS - 1000)).toBe("bad_timestamp");
    expect(at(SVIX_TOLERANCE_MS + 1000)).toBe("bad_timestamp");
  });

  test("a timestamp that is not whole seconds is refused, signed or not", () => {
    for (const ts of ["abc", "1.5", "-1", " 1", "1e9", "0x10", String(NOW)])
      expect(
        verifySvixSignature(
          KEY,
          BODY,
          { id: "msg_1", timestamp: ts, signature: candidate("msg_1", ts, BODY) },
          NOW,
        ),
        ts,
      ).toBe("bad_timestamp");
  });
});

test("the signing key is the base64 after whsec_, and anything else is refused", () => {
  const sixteen = Buffer.alloc(16, 7);
  expect(svixSigningKey(`whsec_${sixteen.toString("base64")}`)).toEqual(sixteen);
  const b64 = sixteen.toString("base64");
  for (const bad of ["", "whsec_", b64, `whsec-${b64}`, "whsec_not base64", "whsec_====="])
    expect(() => svixSigningKey(bad), bad).toThrow(/whsec_/);
});

test("the key must decode to at least 16 bytes, and the refusal never quotes the secret", () => {
  expect(SVIX_MIN_KEY_BYTES).toBe(16);
  for (const bad of ["whsec_A", "whsec_AAEC", `whsec_${Buffer.alloc(15, 7).toString("base64")}`]) {
    expect(decodeSvixSecret(bad), bad).toBeUndefined();
    let message = "";
    try {
      svixSigningKey(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message, bad).toBe(
      "svix: the signing secret must be whsec_ followed by a base64 key of at least 16 bytes",
    );
    expect(message, bad).not.toContain(bad);
  }
  expect(decodeSvixSecret(`whsec_${Buffer.alloc(16, 7).toString("base64")}`)).toEqual(
    Buffer.alloc(16, 7),
  );
});

test("written with node's crypto and a constant-time compare: no Svix package", () => {
  const root = join(import.meta.dirname, "..", "..");
  const src = readFileSync(join(root, "src", "email", "svix.ts"), "utf8");
  expect(src).toContain('from "node:crypto"');
  expect(src).toContain("timingSafeEqual(");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty("svix");
});
