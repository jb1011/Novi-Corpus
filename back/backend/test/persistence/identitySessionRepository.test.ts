import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type PiiKeyring, decryptText, encryptText, parsePiiKey } from "../../src/formation/pii";
import { migrate, openDatabase } from "../../src/persistence/db";
import type { EncryptedName } from "../../src/persistence/identityRepository";
import {
  type NewIdentitySession,
  type SessionClose,
  SqliteIdentitySessionRepository,
  type TypedNames,
} from "../../src/persistence/identitySessionRepository";

const DAY = 86_400_000;
/** 20 November 2026, 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 20, 12);
/** A tenant id as the session spells it: EIP-55 checksummed, with letters for the checksum to case. */
const tenant = (n: number) => getAddress(`0x${"cd".repeat(18)}${n.toString(16).padStart(4, "0")}`);
/** Our opaque session id: 32 lower-case hex digits. */
const sid = (n: number) => n.toString(16).padStart(32, "0");

/** Ciphertext and IV bytes only: no fixture here holds a readable name. */
const sealed = (byte: number): EncryptedName => ({
  ciphertext: Buffer.alloc(24, byte),
  iv: Buffer.alloc(12, byte),
});
const TYPED: TypedNames = { first: sealed(1), last: sealed(2), keyId: "k1" };

/** A constant test key, for the one test that seals a name and reads it back. */
const RING: PiiKeyring = {
  current: parsePiiKey(Buffer.alloc(32, 7).toString("base64"), "FORMATION_PII_KEY"),
};
const SESSION_AAD = (sessionId: string, field: "first" | "last") =>
  `identity-session|${sessionId}|${field}`;

let db: Database.Database;
let repo: SqliteIdentitySessionRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteIdentitySessionRepository(db);
});
afterEach(() => db.close());

function session(n: number, over: Partial<NewIdentitySession> = {}): NewIdentitySession {
  return {
    sessionId: sid(n),
    tenantId: tenant(n),
    nullifier: "0xnullifier",
    provider: "stripe",
    providerRef: `vs_test${n}`,
    environment: "sandbox",
    livemode: false,
    returnPath: "/legal-body",
    createdAt: T0,
    startedCheckId: n,
    typedNames: TYPED,
    ...over,
  };
}

const CLOSE = { at: T0 + DAY, completedCheckId: 9, reportId: "vr_done", redactDueAt: T0 + 8 * DAY };

/** The stored row as the table holds it, for the columns no reader maps one to one. */
const raw = (sessionId: string) =>
  db.prepare("SELECT * FROM identity_sessions WHERE session_id = ?").get(sessionId) as Record<
    string,
    unknown
  >;

const count = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM identity_sessions").get() as { n: number }).n;

describe("SqliteIdentitySessionRepository", () => {
  test("insert stores the session, and byId, byProviderRef and openForTenant read it back", () => {
    const stored = repo.insert(session(1));
    expect(stored).toEqual({
      sessionId: sid(1),
      tenantId: tenant(1),
      nullifier: "0xnullifier",
      provider: "stripe",
      providerRef: "vs_test1",
      environment: "sandbox",
      livemode: false,
      returnPath: "/legal-body",
      createdAt: T0,
      startedCheckId: 1,
      completedCheckId: null,
      closedAt: null,
      lastStatus: null,
      lastErrorCode: null,
      lastReadAt: null,
      failedAttempts: 0,
      reportId: null,
      screenPendingSince: null,
      dobUnavailable: false,
      typedNames: TYPED,
      typedErasedAt: null,
      redactDueAt: null,
      redactionRequestedAt: null,
      redactedAt: null,
      updatedAt: T0,
    });
    expect(repo.byId(sid(1))).toEqual(stored);
    expect(repo.byProviderRef("vs_test1")).toEqual(stored);
    expect(repo.openForTenant(tenant(1))).toEqual(stored);

    expect(repo.byId(sid(2))).toBeUndefined();
    expect(repo.byProviderRef("vs_test2")).toBeUndefined();
    expect(repo.openForTenant(tenant(2))).toBeUndefined();
  });

  test("a production session stores livemode as true", () => {
    const stored = repo.insert(session(1, { environment: "production", livemode: true }));
    expect(stored.livemode).toBe(true);
    expect(raw(sid(1)).livemode).toBe(1);
  });

  test("openForTenant reads only an open session, the newest", () => {
    repo.insert(session(1, { tenantId: tenant(7) }));
    repo.close(sid(1), CLOSE);
    expect(repo.openForTenant(tenant(7))).toBeUndefined();

    repo.insert(session(2, { tenantId: tenant(7), createdAt: T0 + 2 * DAY }));
    expect(repo.openForTenant(tenant(7))?.sessionId).toBe(sid(2));
  });

  test("latestForTenant reads the tenant's newest session, open or closed", () => {
    expect(repo.latestForTenant(tenant(7))).toBeUndefined();
    repo.insert(session(1, { tenantId: tenant(7) }));
    repo.close(sid(1), CLOSE);
    repo.insert(session(2, { tenantId: tenant(7), createdAt: T0 + 2 * DAY }));
    repo.close(sid(2), { ...CLOSE, at: T0 + 3 * DAY });
    repo.insert(session(3)); // another tenant's, newer
    repo.close(sid(3), { ...CLOSE, at: T0 + 4 * DAY });

    expect(repo.latestForTenant(tenant(7))).toMatchObject({
      sessionId: sid(2),
      closedAt: T0 + 3 * DAY,
    });
    // Two sessions created in one millisecond: the later insert is the newer.
    repo.insert(session(4, { tenantId: tenant(7), createdAt: T0 + 2 * DAY }));
    expect(repo.latestForTenant(tenant(7))).toMatchObject({ sessionId: sid(4), closedAt: null });
    expect(() => repo.latestForTenant(tenant(7).toLowerCase())).toThrow(
      "identity session: tenantId must be an EIP-55 checksummed address",
    );
  });

  test("a second open session for one tenant is refused, and nothing is written", () => {
    repo.insert(session(1, { tenantId: tenant(7) }));
    expect(() => repo.insert(session(2, { tenantId: tenant(7) }))).toThrow(
      "identity session: an open session exists",
    );
    expect(count()).toBe(1);

    // Another tenant is not held by it, and once the first is closed the tenant may open one.
    repo.insert(session(3));
    repo.close(sid(1), CLOSE);
    repo.insert(session(2, { tenantId: tenant(7), createdAt: T0 + 2 * DAY }));
    expect(count()).toBe(3);
  });

  test("the open-session check is read inside the caller's transaction, which an insert joins", () => {
    expect(() =>
      repo.transaction(() => {
        repo.insert(session(1, { tenantId: tenant(7) }));
        repo.insert(session(2, { tenantId: tenant(7) }));
      }),
    ).toThrow("identity session: an open session exists");
    // The first insert went with the transaction that refused the second.
    expect(count()).toBe(0);

    const stored = repo.transaction(() => repo.insert(session(1)));
    expect(repo.byId(sid(1))).toEqual(stored);
  });

  test("a provider ref is stored once", () => {
    repo.insert(session(1));
    expect(() => repo.insert(session(2, { providerRef: "vs_test1" }))).toThrow(
      /UNIQUE constraint failed: identity_sessions.provider_ref/,
    );
  });

  test("countCreatedSince counts the tenant's sessions created since the bound, closed ones too", () => {
    const t = tenant(7);
    repo.insert(session(1, { tenantId: t, createdAt: T0 - 2 * DAY }));
    repo.close(sid(1), { ...CLOSE, at: T0 - DAY });
    repo.insert(session(2, { tenantId: t, createdAt: T0 - DAY / 2 }));
    repo.close(sid(2), { ...CLOSE, at: T0 - DAY / 4 });
    repo.insert(session(3, { tenantId: t, createdAt: T0 }));
    repo.insert(session(4)); // another tenant's

    expect(repo.countCreatedSince(t, T0 - DAY)).toBe(2);
    expect(repo.countCreatedSince(t, T0 - 3 * DAY)).toBe(3);
    expect(repo.countCreatedSince(t, T0)).toBe(1); // the bound is inclusive
    expect(repo.countCreatedSince(t, T0 + 1)).toBe(0);
    expect(repo.countCreatedSince(tenant(9), T0 - 3 * DAY)).toBe(0);
  });

  test("close sets its fields and erases every typed column in the same statement", () => {
    repo.insert(session(1));
    repo.close(sid(1), CLOSE);

    const s = repo.byId(sid(1));
    expect(s).toMatchObject({
      closedAt: T0 + DAY,
      completedCheckId: 9,
      reportId: "vr_done",
      redactDueAt: T0 + 8 * DAY,
      typedNames: null,
      typedErasedAt: T0 + DAY,
      updatedAt: T0 + DAY,
    });
    const r = raw(sid(1));
    for (const column of [
      "typed_first_ciphertext",
      "typed_first_iv",
      "typed_last_ciphertext",
      "typed_last_iv",
      "typed_key_id",
    ])
      expect(r[column]).toBeNull();
    expect(repo.openForTenant(tenant(1))).toBeUndefined();
  });

  test("close takes an abandon: no completion row, no report, no redaction date", () => {
    repo.insert(session(1));
    repo.close(sid(1), { at: T0 + DAY, completedCheckId: null, reportId: null, redactDueAt: null });
    expect(repo.byId(sid(1))).toMatchObject({
      closedAt: T0 + DAY,
      completedCheckId: null,
      reportId: null,
      redactDueAt: null,
      typedNames: null,
    });
  });

  test("a closed session is not closed again, and an unknown session is refused", () => {
    repo.insert(session(1));
    repo.close(sid(1), CLOSE);
    expect(() => repo.close(sid(1), { ...CLOSE, completedCheckId: 10 })).toThrow(
      "identity session: the session is closed already",
    );
    expect(repo.byId(sid(1))?.completedCheckId).toBe(9);
    expect(() => repo.close(sid(2), CLOSE)).toThrow("identity session: sessionId names no session");
  });

  test("recordRead stores the read and leaves what it does not carry", () => {
    repo.insert(session(1));
    repo.recordRead(sid(1), {
      at: T0 + 1_000,
      status: "requires_input",
      lastErrorCode: "selfie_face_mismatch",
      failedAttempts: 1,
      reportId: "vr_first",
    });
    expect(repo.byId(sid(1))).toMatchObject({
      lastReadAt: T0 + 1_000,
      lastStatus: "requires_input",
      lastErrorCode: "selfie_face_mismatch",
      failedAttempts: 1,
      reportId: "vr_first",
      dobUnavailable: false,
      screenPendingSince: null,
      updatedAt: T0 + 1_000,
      closedAt: null,
    });

    repo.recordRead(sid(1), {
      at: T0 + 2_000,
      status: "verified",
      lastErrorCode: null,
      failedAttempts: 1,
      reportId: "vr_first",
      dobUnavailable: true,
      screenPendingSince: T0 + 2_000,
    });
    expect(repo.byId(sid(1))).toMatchObject({
      lastStatus: "verified",
      lastErrorCode: null,
      dobUnavailable: true,
      screenPendingSince: T0 + 2_000,
    });

    // Absent leaves both; a null screenPendingSince clears it.
    repo.recordRead(sid(1), {
      at: T0 + 3_000,
      status: "verified",
      lastErrorCode: null,
      failedAttempts: 1,
      reportId: "vr_first",
    });
    expect(repo.byId(sid(1))).toMatchObject({
      dobUnavailable: true,
      screenPendingSince: T0 + 2_000,
    });
    repo.recordRead(sid(1), {
      at: T0 + 4_000,
      status: "verified",
      lastErrorCode: null,
      failedAttempts: 1,
      reportId: "vr_first",
      screenPendingSince: null,
    });
    expect(repo.byId(sid(1))?.screenPendingSince).toBeNull();
  });

  test("recordRead stores the read's report id, and a later read with another id replaces it", () => {
    repo.insert(session(1));
    const read = { status: "requires_input" as const, lastErrorCode: "document_expired" };
    repo.recordRead(sid(1), { ...read, at: T0 + 1_000, failedAttempts: 1, reportId: "vr_one" });
    expect(repo.byId(sid(1))?.reportId).toBe("vr_one");
    expect(raw(sid(1)).report_id).toBe("vr_one");

    repo.recordRead(sid(1), { ...read, at: T0 + 2_000, failedAttempts: 2, reportId: "vr_two" });
    expect(repo.byId(sid(1))).toMatchObject({ reportId: "vr_two", failedAttempts: 2 });
  });

  test("recordRead is refused on a closed session, which keeps the completion's report", () => {
    repo.insert(session(1));
    repo.close(sid(1), CLOSE);
    expect(() =>
      repo.recordRead(sid(1), {
        at: T0 + 2 * DAY,
        status: "verified",
        lastErrorCode: null,
        failedAttempts: 0,
        reportId: "vr_late",
      }),
    ).toThrow("identity session: a closed session takes no read");
    expect(repo.byId(sid(1))).toMatchObject({ reportId: "vr_done", lastReadAt: null });
  });

  test("recordRead refuses a status outside the union, a reason text for a code and a bad report id, never echoing them", () => {
    repo.insert(session(1));
    const read = {
      at: T0 + 1_000,
      status: "requires_input" as const,
      lastErrorCode: null,
      failedAttempts: 0,
      reportId: null,
    };
    expect(() => repo.recordRead(sid(1), { ...read, status: "expired" as "verified" })).toThrow(
      /^identity session: status must be one of /,
    );
    const reasonText = "The name on the document does not match";
    let message = "";
    try {
      repo.recordRead(sid(1), { ...read, lastErrorCode: reasonText });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^identity session: lastErrorCode must be a code/);
    expect(message).not.toContain(reasonText);
    expect(() => repo.recordRead(sid(1), { ...read, reportId: "rep_1" })).toThrow(
      /^identity session: reportId must start with vr_/,
    );
    expect(() => repo.recordRead(sid(1), { ...read, failedAttempts: -1 })).toThrow(
      /^identity session: failedAttempts must be a whole number/,
    );
    expect(() => repo.recordRead(sid(1), { ...read, at: 1_790_000_000 })).toThrow(
      /^identity session: at must be a whole number of unix milliseconds/,
    );
    expect(repo.byId(sid(1))?.lastReadAt).toBeNull();
  });

  test("setTypedNames replaces the sealed typed names of an open session", () => {
    repo.insert(session(1));
    const seal = (value: string, field: "first" | "last") => {
      const { ciphertext, iv, keyId } = encryptText(RING, value, SESSION_AAD(sid(1), field));
      return { name: { ciphertext, iv }, keyId };
    };
    const first = seal("Ines", "first");
    const last = seal("Exemplar", "last");
    repo.setTypedNames(sid(1), { first: first.name, last: last.name, keyId: first.keyId }, T0 + 5);

    const s = repo.byId(sid(1));
    expect(s?.updatedAt).toBe(T0 + 5);
    expect(s?.typedNames?.keyId).toBe(RING.current.id);
    const open = (field: "first" | "last") => {
      const n = s?.typedNames?.[field] as EncryptedName;
      return decryptText(
        RING,
        { ...n, keyId: s?.typedNames?.keyId as string },
        SESSION_AAD(sid(1), field),
      );
    };
    expect(open("first")).toBe("Ines");
    expect(open("last")).toBe("Exemplar");
    // Sealed at rest: the table holds no readable name.
    const r = raw(sid(1));
    expect((r.typed_first_ciphertext as Buffer).includes("Ines")).toBe(false);
    expect((r.typed_last_ciphertext as Buffer).includes("Exemplar")).toBe(false);
  });

  test("setTypedNames is refused on a closed session and on an unknown one, the names unwritten", () => {
    repo.insert(session(1));
    repo.close(sid(1), CLOSE);
    expect(() => repo.setTypedNames(sid(1), TYPED, T0 + 2 * DAY)).toThrow(
      "identity session: the typed names of a closed session are not replaced",
    );
    expect(repo.byId(sid(1))?.typedNames).toBeNull();
    expect(() => repo.setTypedNames(sid(2), TYPED, T0 + 2 * DAY)).toThrow(
      "identity session: sessionId names no session",
    );
  });

  test("setTypedNames checks the shape of the names before writing", () => {
    repo.insert(session(1));
    expect(() =>
      repo.setTypedNames(
        sid(1),
        { ...TYPED, last: { ciphertext: Buffer.alloc(8), iv: Buffer.alloc(8) } },
        T0 + 5,
      ),
    ).toThrow("identity session: typedNames.last.iv must be 12 bytes");
    expect(() => repo.setTypedNames(sid(1), { ...TYPED, keyId: "" }, T0 + 5)).toThrow(
      /^identity session: typedNames.keyId /,
    );
    expect(repo.byId(sid(1))?.typedNames).toEqual(TYPED);
  });

  test("eraseTypedNames erases the five typed columns once, and setTypedNames may seal new ones", () => {
    repo.insert(session(1));
    repo.eraseTypedNames(sid(1), T0 + 10);
    expect(repo.byId(sid(1))).toMatchObject({
      typedNames: null,
      typedErasedAt: T0 + 10,
      closedAt: null,
    });
    repo.eraseTypedNames(sid(1), T0 + 20);
    expect(repo.byId(sid(1))?.typedErasedAt).toBe(T0 + 10);

    // A person restarting the open session with a corrected name seals the names again.
    repo.setTypedNames(sid(1), TYPED, T0 + 30);
    expect(repo.byId(sid(1))).toMatchObject({ typedNames: TYPED, typedErasedAt: null });

    // A close after an erasure keeps the first erasure time it finds.
    repo.eraseTypedNames(sid(1), T0 + 40);
    repo.close(sid(1), CLOSE);
    expect(repo.byId(sid(1))?.typedErasedAt).toBe(T0 + 40);
    expect(() => repo.eraseTypedNames(sid(2), T0)).toThrow(
      "identity session: sessionId names no session",
    );
  });

  test("openOlderThan reads open sessions not read since the bound, least recently read first", () => {
    const bound = T0 + DAY;
    repo.insert(session(1, { createdAt: T0 })); // never read
    repo.insert(session(2, { createdAt: T0 }));
    repo.recordRead(sid(2), {
      at: bound - 1,
      status: "processing",
      lastErrorCode: null,
      failedAttempts: 0,
      reportId: null,
    });
    repo.insert(session(3, { createdAt: T0 }));
    repo.recordRead(sid(3), {
      at: bound, // read at the bound: read since
      status: "processing",
      lastErrorCode: null,
      failedAttempts: 0,
      reportId: null,
    });
    repo.insert(session(4, { createdAt: T0 - DAY })); // closed
    repo.close(sid(4), CLOSE);
    repo.insert(session(5, { createdAt: T0 - DAY })); // never read, older

    expect(repo.openOlderThan(bound, 50).map((s) => s.sessionId)).toEqual([sid(5), sid(1), sid(2)]);
    expect(repo.openOlderThan(bound, 2).map((s) => s.sessionId)).toEqual([sid(5), sid(1)]);
  });

  test("redactionDue reads the due sessions not requested, and those requested over 7 days ago", () => {
    const now = T0 + 30 * DAY;
    const closeWith = (n: number, redactDueAt: number | null) => {
      repo.insert(session(n));
      repo.close(sid(n), { ...CLOSE, redactDueAt });
    };
    closeWith(1, now); // due at now, not requested
    closeWith(2, now - DAY); // requested 8 days ago, not redacted
    repo.markRedactionRequested(sid(2), now - 8 * DAY);
    closeWith(3, now - DAY); // requested 6 days ago: waits
    repo.markRedactionRequested(sid(3), now - 6 * DAY);
    closeWith(4, now - DAY); // redacted
    repo.markRedactionRequested(sid(4), now - 8 * DAY);
    repo.markRedacted(sid(4), now - 7 * DAY);
    closeWith(5, now + 1); // not due yet
    closeWith(6, null); // a review waiting for the operator
    closeWith(7, now - 2 * DAY); // due earlier

    expect(repo.redactionDue(now, 50).map((s) => s.sessionId)).toEqual([sid(7), sid(2), sid(1)]);
    expect(repo.redactionDue(now, 1).map((s) => s.sessionId)).toEqual([sid(7)]);
  });

  test("awaitingDecision reads the closed sessions with a completion and no redaction date, earliest closed first", () => {
    const closeWith = (n: number, c: Partial<SessionClose>) => {
      repo.insert(session(n));
      repo.close(sid(n), { ...CLOSE, ...c });
    };
    closeWith(1, { at: T0 + 2 * DAY, redactDueAt: null }); // a review waiting for the operator
    closeWith(2, { redactDueAt: T0 + 8 * DAY }); // a pass or a failure: its date is set
    closeWith(3, { completedCheckId: null, reportId: null, redactDueAt: null }); // no completion
    closeWith(4, { redactDueAt: null }); // a review, closed earlier
    closeWith(5, { redactDueAt: null }); // a review, redacted at the provider on its own
    repo.markRedacted(sid(5), T0 + 3 * DAY);
    repo.insert(session(6)); // open

    expect(repo.awaitingDecision(50).map((s) => s.sessionId)).toEqual([sid(4), sid(1)]);
    expect(repo.awaitingDecision(1).map((s) => s.sessionId)).toEqual([sid(4)]);
    expect(() => repo.awaitingDecision(0)).toThrow("identity session: limit must be");
  });

  test("setRedactDue sets the date on a closed session only", () => {
    repo.insert(session(1));
    expect(() => repo.setRedactDue(sid(1), T0 + 7 * DAY)).toThrow(
      "identity session: a redaction is due only once the session is closed",
    );
    expect(repo.byId(sid(1))?.redactDueAt).toBeNull();

    repo.close(sid(1), { ...CLOSE, redactDueAt: null });
    repo.setRedactDue(sid(1), T0 + 7 * DAY);
    expect(repo.byId(sid(1))?.redactDueAt).toBe(T0 + 7 * DAY);
    expect(() => repo.setRedactDue(sid(2), T0)).toThrow(
      "identity session: sessionId names no session",
    );
  });

  test("markRedactionRequested and markRedacted record their times", () => {
    repo.insert(session(1));
    repo.close(sid(1), CLOSE);
    repo.markRedactionRequested(sid(1), T0 + 8 * DAY);
    expect(repo.byId(sid(1))).toMatchObject({
      redactionRequestedAt: T0 + 8 * DAY,
      updatedAt: T0 + 8 * DAY,
    });
    repo.markRedactionRequested(sid(1), T0 + 16 * DAY); // a retry moves the request
    repo.markRedacted(sid(1), T0 + 17 * DAY);
    repo.markRedacted(sid(1), T0 + 18 * DAY); // the first redaction stands
    expect(repo.byId(sid(1))).toMatchObject({
      redactionRequestedAt: T0 + 16 * DAY,
      redactedAt: T0 + 17 * DAY,
    });

    // A session redacted at the provider while still open is marked too.
    repo.insert(session(2));
    repo.markRedacted(sid(2), T0 + 2 * DAY);
    expect(repo.byId(sid(2))).toMatchObject({ redactedAt: T0 + 2 * DAY, closedAt: null });
    expect(() => repo.markRedacted(sid(3), T0)).toThrow(
      "identity session: sessionId names no session",
    );
  });

  test("the session id and the provider ref are checked before insert, the message naming the field and never the value", () => {
    const refusal = (over: Partial<NewIdentitySession>): string => {
      try {
        repo.insert(session(1, over));
      } catch (e) {
        return (e as Error).message;
      }
      return "no refusal";
    };
    for (const bad of [
      "ABCDEF0123456789ABCDEF0123456789",
      "abc123",
      `${sid(1)}0`,
      "g".repeat(32),
    ]) {
      const message = refusal({ sessionId: bad });
      expect(message).toBe("identity session: sessionId must be 32 lower-case hex digits");
      expect(message).not.toContain(bad);
    }
    for (const bad of ["vr_test1", "test1", "vs_has space", "VS_test1", "vs_test1\n"]) {
      const message = refusal({ providerRef: bad });
      expect(message).toMatch(/^identity session: providerRef must start with vs_/);
      expect(message).not.toContain(bad);
    }
    // The prefix alone is refused too (the rule names the prefix, so it is in the message).
    expect(refusal({ providerRef: "vs_" })).toMatch(/^identity session: providerRef must start/);
    expect(count()).toBe(0);
  });

  test("insert refuses the other shapes the table forbids", () => {
    const refused = (over: Partial<NewIdentitySession>) =>
      expect(() => repo.insert(session(1, over)));
    refused({ tenantId: tenant(1).toLowerCase() }).toThrow(
      "identity session: tenantId must be an EIP-55 checksummed address",
    );
    refused({ provider: "persona" as "stripe" }).toThrow(
      /^identity session: provider must be one of stripe/,
    );
    refused({ environment: "staging" as "sandbox" }).toThrow(
      /^identity session: environment must be one of/,
    );
    refused({ livemode: true }).toThrow(
      "identity session: livemode must be true on production and false on a sandbox",
    );
    refused({ environment: "production" }).toThrow(/livemode must be true on production/);
    refused({ returnPath: "https://elsewhere.example/x" }).toThrow(
      /^identity session: returnPath must/,
    );
    refused({ createdAt: 1_790_000_000 }).toThrow(
      /^identity session: createdAt must be a whole number of unix milliseconds/,
    );
    refused({ startedCheckId: 0 }).toThrow(
      "identity session: startedCheckId must be a positive whole number",
    );
    refused({ nullifier: "" }).toThrow("identity session: nullifier must not be empty");
    refused({ typedNames: null as unknown as TypedNames }).toThrow(
      "identity session: typedNames must be the sealed typed names",
    );
    refused({
      typedNames: { ...TYPED, first: { ciphertext: Buffer.alloc(0), iv: Buffer.alloc(12) } },
    }).toThrow("identity session: typedNames.first.ciphertext must be a non-empty Buffer");
    expect(count()).toBe(0);

    // A null nullifier is allowed: World ID may be optional.
    expect(repo.insert(session(1, { nullifier: null })).nullifier).toBeNull();
  });

  test("the table holds its own CHECKs, and migrate runs twice", () => {
    migrate(db);
    const insert = (over: Record<string, unknown> = {}) =>
      db
        .prepare(
          `INSERT INTO identity_sessions (session_id, tenant_id, provider, provider_ref, environment,
             livemode, return_path, created_at, started_check_id, last_status, updated_at)
           VALUES (@session_id, 't', @provider, @provider_ref, @environment, @livemode, '/', 1, 1,
             @last_status, 1)`,
        )
        .run({
          session_id: sid(1),
          provider: "stripe",
          provider_ref: "vs_1",
          environment: "sandbox",
          livemode: 0,
          last_status: null,
          ...over,
        });
    expect(() => insert({ provider: "persona" })).toThrow(/CHECK/);
    expect(() => insert({ environment: "staging" })).toThrow(/CHECK/);
    expect(() => insert({ livemode: 2 })).toThrow(/CHECK/);
    expect(() => insert({ last_status: "expired" })).toThrow(/CHECK/);
    expect(insert().changes).toBe(1);
    expect(raw(sid(1))).toMatchObject({ failed_attempts: 0, dob_unavailable: 0 });
  });
});
