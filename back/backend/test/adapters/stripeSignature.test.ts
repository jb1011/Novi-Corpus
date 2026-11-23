/**
 * The Stripe webhook signature check (identity check plan, Task 4). Stripe's header is
 * `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>...]`; the signed payload is
 * `${t}.${rawBody}`; the digest is HMAC-SHA256 with the endpoint's secret, in hex. Keys other
 * than `t` and `v1` (Stripe's `v0` test scheme) are ignored.
 *
 * What is pinned: a signed fixture passes; every way of being wrong is `"bad"` and throws
 * nothing (a throw in the receiver would be a 500, which Stripe counts against the endpoint);
 * an old but authentic event is `"stale"`; both secrets of a rotation are accepted.
 */
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { verifyStripeSignature } from "../../src/adapters/stripe/identityClient";

const SECRET = "whsec_fixtureCurrentSecret";
const PREVIOUS = "whsec_fixturePreviousSecret";
const NOW = 1_763_900_000;
const TOLERANCE = 300;
const BODY = JSON.stringify({
  id: "evt_1Fixture",
  type: "identity.verification_session.verified",
  livemode: false,
  data: { object: { id: "vs_1Fixture", client_reference_id: "0123456789abcdef" } },
});

function sign(secret: string, t: number, body = BODY): string {
  return createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
}

function check(header: string | undefined, secrets: (string | undefined)[] = [SECRET]) {
  return verifyStripeSignature(BODY, header, secrets, NOW, TOLERANCE);
}

describe("an authentic event", () => {
  test("a signed fixture passes", () => {
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW)}`)).toBe("ok");
  });

  test("a header with two v1 entries where the second matches passes", () => {
    const wrong = sign("whsec_someOtherSecret", NOW);
    expect(check(`t=${NOW},v1=${wrong},v1=${sign(SECRET, NOW)}`)).toBe("ok");
  });

  test("the previous secret passes during a rotation", () => {
    expect(check(`t=${NOW},v1=${sign(PREVIOUS, NOW)}`, [SECRET, PREVIOUS])).toBe("ok");
  });

  test("an absent previous secret is skipped", () => {
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW)}`, [SECRET, undefined])).toBe("ok");
  });

  test("keys other than t and v1 are ignored", () => {
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW)},v0=abcd,foo=bar`)).toBe("ok");
  });

  test("the hex digest is read in either case", () => {
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW).toUpperCase()}`)).toBe("ok");
  });

  test("an event at the edge of the tolerance passes", () => {
    const t = NOW - TOLERANCE;
    expect(check(`t=${t},v1=${sign(SECRET, t)}`)).toBe("ok");
  });
});

describe("an old event", () => {
  test("a timestamp six minutes old is stale at tolerance 300", () => {
    const t = NOW - 360;
    expect(check(`t=${t},v1=${sign(SECRET, t)}`)).toBe("stale");
  });

  test("a timestamp six minutes ahead is stale too", () => {
    const t = NOW + 360;
    expect(check(`t=${t},v1=${sign(SECRET, t)}`)).toBe("stale");
  });

  test("an old timestamp with a wrong signature is bad, not stale (stale means authentic)", () => {
    const t = NOW - 360;
    expect(check(`t=${t},v1=${sign("whsec_someOtherSecret", t)}`)).toBe("bad");
  });

  test("a clock that is not a number fails closed: stale, never ok", () => {
    const header = `t=${NOW},v1=${sign(SECRET, NOW)}`;
    expect(verifyStripeSignature(BODY, header, [SECRET], Number.NaN, TOLERANCE)).toBe("stale");
  });
});

describe("everything else is bad, and nothing throws", () => {
  test("a wrong secret is bad", () => {
    expect(check(`t=${NOW},v1=${sign("whsec_someOtherSecret", NOW)}`)).toBe("bad");
  });

  test("a tampered body is bad", () => {
    const header = `t=${NOW},v1=${sign(SECRET, NOW)}`;
    expect(verifyStripeSignature(`${BODY} `, header, [SECRET], NOW, TOLERANCE)).toBe("bad");
  });

  test("a signature made over another timestamp is bad", () => {
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW - 1)}`)).toBe("bad");
  });

  test("an odd-length hex is bad and throws nothing", () => {
    const odd = sign(SECRET, NOW).slice(0, 63);
    expect(() => check(`t=${NOW},v1=${odd}`)).not.toThrow();
    expect(check(`t=${NOW},v1=${odd}`)).toBe("bad");
  });

  test("a digest of the wrong length is bad and throws nothing", () => {
    const short = sign(SECRET, NOW).slice(0, 32);
    expect(() => check(`t=${NOW},v1=${short}`)).not.toThrow();
    expect(check(`t=${NOW},v1=${short}`)).toBe("bad");
  });

  test("a digest with a character outside hex is bad", () => {
    const notHex = `${sign(SECRET, NOW).slice(0, 62)}zz`;
    expect(check(`t=${NOW},v1=${notHex}`)).toBe("bad");
  });

  test("a missing header is bad", () => {
    expect(check(undefined)).toBe("bad");
    expect(check("")).toBe("bad");
  });

  test("a header without a timestamp is bad", () => {
    expect(check(`v1=${sign(SECRET, NOW)}`)).toBe("bad");
  });

  test("a header with a timestamp that is not a number is bad", () => {
    expect(check(`t=abc,v1=${sign(SECRET, NOW)}`)).toBe("bad");
    expect(check(`t=${NOW}.5,v1=${sign(SECRET, NOW)}`)).toBe("bad");
    expect(check(`t=-${NOW},v1=${sign(SECRET, NOW)}`)).toBe("bad");
  });

  test("a header with two timestamps is bad", () => {
    expect(check(`t=${NOW},t=${NOW},v1=${sign(SECRET, NOW)}`)).toBe("bad");
  });

  test("a header with no v1 entry is bad, even when a v0 entry would match", () => {
    expect(check(`t=${NOW},v0=${sign(SECRET, NOW)}`)).toBe("bad");
  });

  test("no secret at all is bad", () => {
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW)}`, [])).toBe("bad");
    expect(check(`t=${NOW},v1=${sign(SECRET, NOW)}`, [undefined, ""])).toBe("bad");
  });

  test("a garbled header is bad and throws nothing", () => {
    for (const h of ["garbage", ",,,", "t=", "v1=", "=", `t=${NOW},v1`, "t==1,v1==ab"]) {
      expect(() => check(h)).not.toThrow();
      expect(check(h)).toBe("bad");
    }
  });
});
