/**
 * The session mapping (identity check plan, Task 4): Stripe's VerificationSession JSON to the
 * adapter's `ProviderSession`, and a `ProviderSession` to the one outcome the service acts on.
 *
 * The fixtures are made-up sessions in the shapes Stripe answers a read expanded with
 * `verified_outputs.dob` and `last_verification_report`. The person is Stripe's own test person.
 * They carry fields the adapter must never keep (the address, the document number, the file ids,
 * `last_error.reason`), so the tests can say those are dropped.
 */
import { describe, expect, test } from "vitest";
import { ISO3166_ALPHA2_TO_ALPHA3 } from "../../src/adapters/stripe/countries";
import {
  type ProviderSession,
  alpha3Of,
  outcomeOf,
  parseProviderSession,
} from "../../src/adapters/stripe/mapSession";

const SESSION_ID = "0123456789abcdef0123456789abcdef";
const REPORT_CREATED = 1_763_900_300;

/** A fresh session: created, nobody has opened the URL yet. */
const STARTED = {
  id: "vs_1FixtureStarted",
  object: "identity.verification_session",
  client_reference_id: SESSION_ID,
  client_secret: "vs_1FixtureStarted_secret_fixture",
  created: 1_763_900_000,
  last_error: null,
  last_verification_report: null,
  livemode: false,
  metadata: {},
  options: {},
  redaction: null,
  status: "requires_input",
  type: "document",
  url: "https://verify.stripe.com/start/test_fixtureStarted",
  verification_flow: "vf_1FixtureFlow",
  verified_outputs: null,
};

const ADDRESS = {
  city: "Fixtureville",
  country: "GB",
  line1: "1 Fixture Street",
  line2: null,
  postal_code: "FX1 1AA",
  state: null,
};

/** A verified session, both expands applied. */
const VERIFIED = {
  ...STARTED,
  id: "vs_1FixtureVerified",
  status: "verified",
  url: null,
  last_verification_report: {
    id: "vr_1FixtureVerified",
    object: "identity.verification_report",
    created: REPORT_CREATED,
    livemode: false,
    type: "document",
    verification_session: "vs_1FixtureVerified",
    document: {
      status: "verified",
      type: "driving_license",
      issuing_country: "GB",
      first_name: "Jenny",
      last_name: "Rosen",
      address: ADDRESS,
      number: "ROSEN901019JR9AB",
      files: ["file_1FixtureFront", "file_1FixtureBack"],
      error: null,
    },
    selfie: {
      status: "verified",
      document: "file_1FixtureFace",
      selfie: "file_1FixtureSelfie",
      error: null,
    },
  },
  verified_outputs: {
    first_name: "Jenny",
    last_name: "Rosen",
    address: ADDRESS,
    dob: { day: 4, month: 7, year: 1990 },
    id_number_type: null,
  },
};

/** A document attempt failed; the session waits for another try, with a fresh URL. */
const DOCUMENT_EXPIRED = {
  ...STARTED,
  id: "vs_1FixtureRetry",
  url: "https://verify.stripe.com/start/test_fixtureRetry",
  last_error: { code: "document_expired", reason: "The document is expired: Jenny Rosen" },
  last_verification_report: {
    id: "vr_1FixtureRetry",
    object: "identity.verification_report",
    created: REPORT_CREATED,
    livemode: false,
    type: "document",
    document: {
      status: "unverified",
      type: "passport",
      issuing_country: "FR",
      error: { code: "document_expired", reason: "The document is expired." },
    },
    selfie: null,
  },
};

const PROCESSING = { ...STARTED, id: "vs_1FixtureProcessing", status: "processing", url: null };
const CANCELED = { ...STARTED, id: "vs_1FixtureCanceled", status: "canceled", url: null };
const REDACTED = {
  ...VERIFIED,
  id: "vs_1FixtureRedacted",
  redaction: { status: "redacted" },
  verified_outputs: { first_name: "[redacted]", last_name: "[redacted]", dob: null },
};

function withError(code: string) {
  return { ...STARTED, last_error: { code, reason: "a reason text" } };
}

function withReport(patch: { document?: unknown; selfie?: unknown }) {
  return {
    ...VERIFIED,
    last_verification_report: { ...VERIFIED.last_verification_report, ...patch },
  };
}

describe("parseProviderSession", () => {
  test("a verified session reads into the adapter's shape", () => {
    expect(parseProviderSession(VERIFIED)).toEqual<ProviderSession>({
      id: "vs_1FixtureVerified",
      livemode: false,
      status: "verified",
      clientReferenceId: SESSION_ID,
      url: null,
      lastErrorCode: null,
      redaction: null,
      outputs: { firstName: "Jenny", lastName: "Rosen", dob: { year: 1990, month: 7, day: 4 } },
      report: {
        id: "vr_1FixtureVerified",
        created: REPORT_CREATED,
        documentType: "driving_license",
        issuingCountry: "GB",
        selfieStatus: "verified",
      },
    });
  });

  test("a fresh session reads with its URL and nothing else", () => {
    expect(parseProviderSession(STARTED)).toEqual<ProviderSession>({
      id: "vs_1FixtureStarted",
      livemode: false,
      status: "requires_input",
      clientReferenceId: SESSION_ID,
      url: "https://verify.stripe.com/start/test_fixtureStarted",
      lastErrorCode: null,
      redaction: null,
      outputs: null,
      report: null,
    });
  });

  test("a failed attempt keeps the error's code, never its reason", () => {
    const s = parseProviderSession(DOCUMENT_EXPIRED);
    expect(s.lastErrorCode).toBe("document_expired");
    expect(s.url).toBe("https://verify.stripe.com/start/test_fixtureRetry");
    expect(s.report).toEqual({
      id: "vr_1FixtureRetry",
      created: REPORT_CREATED,
      documentType: "passport",
      issuingCountry: "FR",
      selfieStatus: null,
    });
    expect(JSON.stringify(s)).not.toContain("expired:");
    expect(JSON.stringify(s)).not.toContain("is expired");
  });

  test("the address, the document number, the file ids and the client secret are dropped", () => {
    const kept = JSON.stringify(parseProviderSession(VERIFIED));
    for (const dropped of ["Fixture Street", "FX1 1AA", "ROSEN901019", "file_1", "_secret_"])
      expect(kept).not.toContain(dropped);
  });

  test("a read without the birth date expand has a null birth date", () => {
    const s = parseProviderSession({
      ...VERIFIED,
      verified_outputs: { first_name: "Jenny", last_name: "Rosen" },
    });
    expect(s.outputs).toEqual({ firstName: "Jenny", lastName: "Rosen", dob: null });
  });

  test("a birth date with a missing or impossible part is null", () => {
    for (const dob of [
      { day: null, month: 7, year: 1990 },
      { day: 30, month: 2, year: 1990 },
      { day: 4, month: 13, year: 1990 },
      { day: 4.5, month: 7, year: 1990 },
      { day: 4, month: 7, year: 990 },
      "1990-07-04",
    ]) {
      const s = parseProviderSession({
        ...VERIFIED,
        verified_outputs: { ...VERIFIED.verified_outputs, dob },
      });
      expect(s.outputs?.dob).toBeNull();
    }
  });

  test("a report left unexpanded (an id) reads as no report", () => {
    const s = parseProviderSession({
      ...VERIFIED,
      last_verification_report: "vr_1FixtureVerified",
    });
    expect(s.report).toBeNull();
  });

  test("a document type Stripe adds later reads as null, not a throw", () => {
    const s = parseProviderSession(withReport({ document: { type: "residence_permit" } }));
    expect(s.report?.documentType).toBeNull();
  });

  test("the redaction status is read", () => {
    expect(parseProviderSession(REDACTED).redaction).toBe("redacted");
    expect(
      parseProviderSession({ ...STARTED, redaction: { status: "processing" } }).redaction,
    ).toBe("processing");
  });

  test("a shape it cannot read throws, naming the field and never the value", () => {
    const bad: [unknown, string][] = [
      [null, "session"],
      ["vs_1", "session"],
      [{ ...STARTED, id: 42 }, "id"],
      [{ ...STARTED, id: "cus_1Fixture" }, "id"],
      [{ ...STARTED, object: "identity.verification_report" }, "object"],
      [{ ...STARTED, livemode: "false" }, "livemode"],
      [{ ...STARTED, status: "Jenny Rosen" }, "status"],
      [{ ...STARTED, client_reference_id: 7 }, "client_reference_id"],
      [{ ...STARTED, last_error: { code: "Jenny Rosen" } }, "last_error.code"],
      [{ ...STARTED, redaction: { status: "Jenny Rosen" } }, "redaction.status"],
      [{ ...STARTED, url: "http://verify.example.com/Jenny" }, "url"],
    ];
    for (const [json, field] of bad) {
      let caught: unknown;
      try {
        parseProviderSession(json);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain(field);
      expect((caught as Error).message).not.toContain("Jenny");
    }
  });
});

describe("outcomeOf", () => {
  test("a verified session is a verified outcome with the document's facts", () => {
    expect(outcomeOf(parseProviderSession(VERIFIED))).toEqual({
      kind: "verified",
      names: { first: "Jenny", last: "Rosen" },
      dob: "1990-07-04",
      country: "GBR",
      documentType: "driving_licence",
      liveness: "passed",
      reportId: "vr_1FixtureVerified",
      completedAt: REPORT_CREATED * 1000,
    });
  });

  test("the document type map: passport, id_card and driving_license", () => {
    const typeOf = (type: string) => {
      const o = outcomeOf(parseProviderSession(withReport({ document: { type } })));
      return o.kind === "verified" ? o.documentType : "not verified";
    };
    expect(typeOf("passport")).toBe("passport");
    expect(typeOf("id_card")).toBe("identity_card");
    expect(typeOf("driving_license")).toBe("driving_licence");
    expect(typeOf("residence_permit")).toBeNull();
  });

  test("liveness: a verified selfie passed, an unverified one failed, none not run", () => {
    const livenessOf = (selfie: unknown) => {
      const o = outcomeOf(parseProviderSession(withReport({ selfie })));
      return o.kind === "verified" ? o.liveness : "not verified";
    };
    expect(livenessOf({ status: "verified" })).toBe("passed");
    expect(livenessOf({ status: "unverified" })).toBe("failed");
    expect(livenessOf(null)).toBe("not_run");
    expect(livenessOf(undefined)).toBe("not_run");
  });

  test("the birth date is written YYYY-MM-DD, and null when it was not read", () => {
    const o = outcomeOf(parseProviderSession(VERIFIED));
    expect(o.kind === "verified" && o.dob).toBe("1990-07-04");
    const padded = outcomeOf(
      parseProviderSession({
        ...VERIFIED,
        verified_outputs: {
          first_name: "Jenny",
          last_name: "Rosen",
          dob: { day: 9, month: 1, year: 2001 },
        },
      }),
    );
    expect(padded.kind === "verified" && padded.dob).toBe("2001-01-09");
    const none = outcomeOf(
      parseProviderSession({
        ...VERIFIED,
        verified_outputs: { first_name: "Jenny", last_name: "Rosen" },
      }),
    );
    expect(none.kind === "verified" && none.dob).toBeNull();
  });

  test("an issuing country outside the table is a null country", () => {
    const o = outcomeOf(
      parseProviderSession(withReport({ document: { type: "passport", issuing_country: "XK" } })),
    );
    expect(o.kind === "verified" && o.country).toBeNull();
  });

  test("a requires_input with a document error is a failed attempt, not final", () => {
    expect(outcomeOf(parseProviderSession(DOCUMENT_EXPIRED))).toEqual({
      kind: "attempt_failed",
      code: "document_expired",
      final: false,
    });
    expect(outcomeOf(parseProviderSession(withError("selfie_face_mismatch")))).toEqual({
      kind: "attempt_failed",
      code: "selfie_face_mismatch",
      final: false,
    });
  });

  test("consent_declined, under_supported_age and country_not_supported are final", () => {
    for (const code of ["consent_declined", "under_supported_age", "country_not_supported"])
      expect(outcomeOf(parseProviderSession(withError(code)))).toEqual({
        kind: "attempt_failed",
        code,
        final: true,
      });
  });

  test("a requires_input without an error is pending (nobody has tried yet)", () => {
    expect(outcomeOf(parseProviderSession(STARTED))).toEqual({ kind: "pending" });
  });

  test("a processing session is pending", () => {
    expect(outcomeOf(parseProviderSession(PROCESSING))).toEqual({ kind: "pending" });
  });

  test("a canceled session is canceled", () => {
    expect(outcomeOf(parseProviderSession(CANCELED))).toEqual({ kind: "canceled" });
  });

  test("a verified session read without its outputs or its report throws", () => {
    expect(() => outcomeOf(parseProviderSession({ ...VERIFIED, verified_outputs: null }))).toThrow(
      /outputs/,
    );
    expect(() =>
      outcomeOf(parseProviderSession({ ...VERIFIED, last_verification_report: null })),
    ).toThrow(/report/);
  });

  test("a session under redaction has no outcome: its fields are no longer facts", () => {
    expect(() => outcomeOf(parseProviderSession(REDACTED))).toThrow(/redact/);
    expect(() =>
      outcomeOf(parseProviderSession({ ...VERIFIED, redaction: { status: "processing" } })),
    ).toThrow(/redact/);
  });
});

describe("alpha3Of and the table", () => {
  test("spot checks", () => {
    const expected: Record<string, string> = {
      GB: "GBR",
      US: "USA",
      FR: "FRA",
      ES: "ESP",
      DE: "DEU",
      CH: "CHE",
      IE: "IRL",
      JP: "JPN",
      KR: "KOR",
      KP: "PRK",
      ZA: "ZAF",
      AX: "ALA",
      GS: "SGS",
      KM: "COM",
      KY: "CYM",
      YT: "MYT",
    };
    for (const [a2, a3] of Object.entries(expected)) expect(alpha3Of(a2)).toBe(a3);
  });

  test("an unknown or malformed code is null", () => {
    for (const s of ["XX", "XK", "UK", "EU", "", "G", "GBR", " GB", "G1", "constructor", "ß"])
      expect(alpha3Of(s)).toBeNull();
  });

  test("lower case is normalised to the upper-case code", () => {
    expect(alpha3Of("gb")).toBe("GBR");
    expect(alpha3Of("Fr")).toBe("FRA");
  });

  test("the table holds the 249 assigned codes, each to a distinct three-letter code", () => {
    const entries = Object.entries(ISO3166_ALPHA2_TO_ALPHA3);
    expect(entries).toHaveLength(249);
    for (const [a2, a3] of entries) {
      expect(a2).toMatch(/^[A-Z]{2}$/);
      expect(a3).toMatch(/^[A-Z]{3}$/);
    }
    expect(new Set(entries.map(([, a3]) => a3)).size).toBe(249);
  });
});
