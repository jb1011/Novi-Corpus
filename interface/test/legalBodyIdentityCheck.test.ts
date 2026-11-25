/**
 * The identity check card, decided as data: which state the card is in from the server's two
 * reads (the identity record and the open session), the words it says in each, what the start
 * may send, how a refusal reads, and when the card reads at the provider. The card only renders
 * these answers.
 */
import { describe, expect, test } from "vitest";
import {
  ApiError,
  type GuardianIdentityState,
  type GuardianIdentityView,
  type IdentitySessionOpen,
  type IdentitySessionView,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  READ_SYNC_EVERY_MS,
  SYNC_MIN_INTERVAL_MS,
  arrivalAfter,
  arrivalOf,
  attemptSentence,
  cardUnderWay,
  identityCardText,
  identityCardView,
  providerPageUrl,
  providerReadStep,
  readingStep,
  refusalStands,
  returnedFromCheck,
  sessionMark,
  shouldReadBack,
  shownProblem,
  stripReturnedFlag,
  startRefusal,
  syncRefusal,
  typedNames,
  type AutomaticCardView,
} from "@/lib/legalBody/identityCheck";

const A = LEGAL_BODY_COPY.human.guardianIdentity.automatic;
const G = LEGAL_BODY_COPY.human.guardianIdentity;

const NOW = Date.UTC(2026, 10, 24), DAY = 86_400_000;
const id = (state: GuardianIdentityState, over: Partial<GuardianIdentityView> = {}): GuardianIdentityView =>
  ({ required: false, automatic: true, state, ...over });
const open = (over: Partial<IdentitySessionOpen> = {}): IdentitySessionView =>
  ({ status: "open", sessionId: "s1", startedAt: NOW, attemptsLeft: 3, lastErrorCode: null, reading: false, held: null, ...over });
const view = (over: Partial<Parameters<typeof identityCardView>[0]> = {}) =>
  identityCardView({ identity: id("none"), worldAccepted: true, session: { status: "none" }, arrival: "done", startRefused: null, nowMs: NOW, ...over });
const due = (days: number) => id("verified", { verifiedAt: NOW - DAY, expiresAt: NOW + days * DAY });

describe("which state the card is in", () => {
  test.each([
    ["no identity block", { identity: undefined }, "hidden"],
    ["neither offered nor required", { identity: id("none", { automatic: false }) }, "hidden"],
    ["a backend that does not say automatic", { identity: { required: false, state: "none" } as GuardianIdentityView }, "hidden"],
    ["required, the operator's path", { identity: id("failed", { required: true, automatic: false }) }, "operator"],
    ["World ID not accepted", { worldAccepted: false }, "locked"],
    ["the session not read yet", { session: "loading" }, "loading"],
    ["the session unreadable", { session: "unreadable" }, "unreadable"],
    ["none", {}, "start"],
    ["an operator's started row and no session", { identity: id("pending") }, "start"],
    ["failed", { identity: id("failed") }, "start_again"],
    ["expired", { identity: id("expired") }, "expired"],
    ["revoked", { identity: id("revoked") }, "revoked"],
    ["under review", { identity: id("needs_review") }, "review"],
    ["under review over a stale open session", { identity: id("needs_review"), session: open({ reading: true }) }, "review"],
    ["verified, 91 days left", { identity: due(91) }, "verified"],
    ["verified, 90 days left", { identity: due(90) }, "renewal_due"],
    ["verified, no expiry served", { identity: id("verified") }, "verified"],
    ["a renewal the start said is under review", { identity: due(30), startRefused: "identity_under_review" }, "review"],
    ["open, came back without finishing", { identity: id("pending"), session: open() }, "continue"], // Review Focus 1
    ["open, not read back yet", { session: open(), arrival: "pending" }, "loading"],
    ["open, the read-back failed", { session: open(), arrival: "failed" }, "unreadable"],
    ["open, a failed attempt, two left", { session: open({ lastErrorCode: "document_expired", attemptsLeft: 2 }) }, "retry"],
    ["open, a failed attempt, none left", { session: open({ lastErrorCode: "document_expired", attemptsLeft: 0 }) }, "continue"],
    ["open, the provider is processing", { session: open({ reading: true }) }, "reading"],
    ["held by the system, before any read-back", { session: open({ held: "system" }), arrival: "pending" }, "finishing"], // Review Focus 4
    ["held by the system, a server that also says reading", { session: open({ held: "system", reading: true }) }, "finishing"],
    ["held for an operator", { session: open({ held: "operator" }), arrival: "pending" }, "review"],
    ["a renewal in flight, held", { identity: due(30), session: open({ held: "system" }) }, "finishing"],
  ] as const)("%s", (_name, over, kind) => expect(view(over).kind).toBe(kind));

  test("every automatic kind is decided the same on production, and says whether a check counts", () => {
    expect(view({ identity: id("none", { required: true }) })).toMatchObject({ kind: "start", required: true, counts: false });
    expect(view({ identity: { ...due(30), required: true }, session: open() })).toMatchObject({ kind: "continue", counts: true, verifiedAt: NOW - DAY });
    expect(view({ identity: due(30) })).toMatchObject({ kind: "renewal_due", dueAt: NOW + 30 * DAY });
    expect(view({ session: open({ lastErrorCode: "selfie_face_mismatch", attemptsLeft: 1 }) })).toMatchObject({ attemptsLeft: 1, errorCode: "selfie_face_mismatch" });
  });

  test("the start's refusal counts only for a renewal: elsewhere the two reads already say it", () => {
    expect(view({ startRefused: "identity_under_review" }).kind).toBe("start");
    expect(view({ identity: due(200), startRefused: "identity_under_review" }).kind).toBe("verified");
    expect(view({ session: open(), startRefused: "identity_under_review" }).kind).toBe("continue");
  });

  test("a state this site does not know, or none, reads as unreadable, never as nothing", () => {
    const unknown = { required: true, automatic: true, state: "suspended" } as unknown as GuardianIdentityView;
    const missing = { required: true, automatic: true } as unknown as GuardianIdentityView;
    for (const identity of [unknown, missing]) {
      expect(view({ identity })).toMatchObject({ kind: "unreadable", counts: false });
      expect(view({ identity, session: open() }).kind).toBe("unreadable");
      expect(view({ identity, session: open({ held: "system" }) }).kind).toBe("unreadable");
      expect(view({ identity, worldAccepted: false }).kind).toBe("unreadable");
      expect(identityCardText(view({ identity }) as AutomaticCardView, { longWait: false, formatDate: () => "" }))
        .toEqual({ record: null, status: A.unreadable, notes: [A.required], form: null });
    }
  });

  test("the operator's card keeps today's state and the record's date", () => {
    expect(view({ identity: { ...due(200), required: true, automatic: false } })).toEqual({
      kind: "operator",
      state: "verified",
      verifiedAt: NOW - DAY,
    });
  });
});

const text = (over: Parameters<typeof view>[0], longWait = false) =>
  identityCardText(view(over) as AutomaticCardView, { longWait, formatDate: () => "24 Nov 2026" });

describe("what the card says", () => {
  test("the words: the testnet is optional and a test, mainnet is required", () => {
    expect(text({})).toEqual({ record: null, status: null, notes: [A.optional], form: { lines: [A.testNote], button: A.buttons.start } });
    expect(text({ identity: id("none", { required: true }) })).toEqual({ record: null, status: null, notes: [A.required],
      form: { lines: [A.form.intro, A.form.nameWhy, A.form.nameHelp], button: A.buttons.start } });
    expect(text({ identity: due(200) })).toEqual({ record: "Verified on 24 Nov 2026 (test check)", status: null, notes: [A.testCounts], form: null });
    expect(text({ identity: { ...due(200), required: true } })).toEqual({ record: "Verified on 24 Nov 2026", status: null, notes: [], form: null });
  });

  test("a record served without its date says verified alone", () => {
    expect(text({ identity: id("verified") }).record).toBe(A.verifiedTest);
    expect(text({ identity: id("verified", { required: true }) }).record).toBe(G.verified);
  });

  test("a retry names the reason, the attempts left, and asks for the name again", () => {
    const t = text({ identity: id("pending", { required: true }), session: open({ lastErrorCode: "document_expired", attemptsLeft: 1 }) });
    expect(t.status).toBe("That attempt did not go through. The document has expired. Use a document in date.");
    expect(t.notes).toEqual([A.oneAttemptLeft, A.required]);
    expect(t.form).toEqual({ lines: [A.form.nameAgain, A.form.nameWhy, A.form.nameHelp], button: A.buttons.retry });
    expect(attemptSentence("a_code_not_known")).toBe(A.attempts.other);
  });

  test("two attempts left are counted, and a test continue asks for the name again", () => {
    expect(text({ session: open({ lastErrorCode: "selfie_manipulated", attemptsLeft: 2 }) }).notes).toEqual([
      "2 attempts left on this check.",
      A.optional,
    ]);
    expect(text({ session: open() }).form).toEqual({ lines: [A.form.nameAgain, A.testNote], button: A.buttons.continue });
    expect(attemptSentence(null)).toBe(A.attempts.other);
    expect(attemptSentence("toString")).toBe(A.attempts.other);
  });

  test.each([
    ["locked", { worldAccepted: false }, A.locked, null],
    ["loading", { session: "loading" }, A.loading, null],
    ["unreadable", { session: "unreadable" }, A.unreadable, null],
    ["start_again", { identity: id("failed") }, A.startAgain, A.buttons.startAgain],
    ["expired", { identity: id("expired") }, A.expired, A.buttons.startAgain],
    ["revoked", { identity: id("revoked") }, A.revoked, A.buttons.runAgain],
    ["continue", { session: open() }, A.continue, A.buttons.continue],
    ["renewal_due", { identity: due(30) }, "Due again on 24 Nov 2026. You can renew now. Your current check counts until then.", A.buttons.renew],
    ["review", { identity: id("needs_review") }, A.review, null],
    ["verified", { identity: due(200) }, null, null],
  ] as const)("%s says its sentence and offers its button", (_kind, over, status, button) => {
    const t = text(over);
    expect(t.status).toBe(status);
    expect(t.form?.button ?? null).toBe(button);
  });

  test("a check under way on production, while one counts, says neither required nor a test", () => {
    expect(text({ identity: { ...due(30), required: true }, session: open() }).notes).toEqual([]);
    expect(text({ identity: id("none", { required: true }), worldAccepted: false }).notes).toEqual([A.required]);
  });

  test("a held check is never said to be read, and a long wait says so", () => { // Review Focus 4
    expect(text({ session: open({ held: "system" }) }).status).toBe(A.finishing);
    expect(text({ session: open({ held: "operator" }) }).status).toBe(A.review);
    expect(text({ session: open({ reading: true }) }).status).toBe(A.reading);
    expect(text({ session: open({ reading: true }) }, true).status).toBe(A.readingLong);
    expect(shouldReadBack(open())).toBe(true);
    for (const s of [open({ held: "system" }), open({ held: "operator" }), { status: "none" } as const, "loading" as const, "unreadable" as const])
      expect(shouldReadBack(s)).toBe(false);
  });
});

describe("what the start may send, and how a refusal reads", () => {
  test("the name rule is the server's", () => { // Review Focus 3
    expect(typedNames({ firstName: "  Jean-Pierre ", lastName: "O'Neil" })).toEqual({ firstName: "Jean-Pierre", lastName: "O'Neil" });
    expect(typedNames({ firstName: "Łukasz", lastName: "山田" })).toEqual({ firstName: "Łukasz", lastName: "山田" });
    expect(typedNames({ firstName: "a".repeat(100), lastName: "b" })).not.toBeNull();
    for (const bad of ["", "   ", "a".repeat(101), "Ana\u200B", "Ana\u0000", "Ana\u200D"])
      expect(typedNames({ firstName: bad, lastName: "Person" })).toBeNull();
  });

  test("the length is counted in code points, and each name is held to the rule", () => {
    // 100 characters outside the basic plane: 200 UTF-16 units, still 100 code points.
    expect(typedNames({ firstName: "\u{1D400}".repeat(100), lastName: "b" })).not.toBeNull();
    expect(typedNames({ firstName: "Ana", lastName: "  " })).toBeNull();
  });

  test("each refusal has its sentence and its next step", () => { // Review Focus 5
    const refused = (code: string, status: number) => startRefusal(new ApiError(status, { code, message: "the server's own words" }));
    for (const code of ["identity_already_verified", "identity_under_review", "identity_session_limit", "identity_provider_unavailable", "validation_error", "guardian_not_verified", "identity_check_not_offered"] as const)
      expect(refused(code, 409)).toEqual({ code, sentence: A.refusals[code], signIn: false });
    expect(refused("identity_unavailable", 503).sentence).toBe(A.refusals.identity_provider_unavailable);
    expect(refused("unauthorized", 401)).toEqual({ code: "unauthorized", sentence: null, signIn: true });
    expect(refused("internal_error", 500).sentence).toBe(A.refusals.other);
    expect(startRefusal(new Error("network")).sentence).toBe(A.refusals.other);
    expect(A.refusals.identity_session_limit).toContain("tomorrow");
    expect(syncRefusal(new ApiError(429, { code: "identity_sync_too_soon", message: "m" }))).toEqual({ sentence: null, signIn: false, counted: true });
    expect(syncRefusal(new ApiError(503, { code: "identity_provider_unavailable", message: "m" })).sentence).toBe(A.refusals.identity_provider_unavailable);
  });

  test("a refusal never shows the server's own words", () => {
    expect(startRefusal(new Error("network"))).toEqual({ code: null, sentence: A.refusals.other, signIn: false });
    expect(startRefusal(new ApiError(413, { code: "payload_too_large", message: "m" })).sentence).toBe(A.refusals.other);
    expect(syncRefusal(new ApiError(503, { code: "identity_unavailable", message: "m" }))).toEqual({
      sentence: A.refusals.identity_provider_unavailable,
      signIn: false,
      counted: false,
    });
    expect(syncRefusal(new ApiError(401, { code: "unauthorized", message: "m" }))).toEqual({ sentence: null, signIn: true, counted: false });
    expect(syncRefusal(new ApiError(500, { code: "internal_error", message: "m" }))).toEqual({ sentence: null, signIn: false, counted: false });
    expect(syncRefusal(new Error("network"))).toEqual({ sentence: null, signIn: false, counted: false });
  });
});

describe("what the card keeps from a click", () => {
  test("a problem shows while the card is in the kind it was said under, and not once the card moved on", () => {
    const unavailable = { sentence: A.refusals.identity_provider_unavailable, kind: "reading" } as const;
    expect(shownProblem(unavailable, "reading")).toBe(A.refusals.identity_provider_unavailable);
    // Check again met the provider down, then the check passed: the card says the pass, alone.
    expect(shownProblem(unavailable, "verified")).toBeNull();
    // A renewal refused as under review, then decided: the review sentence does not outlive it.
    const underReview = { sentence: A.refusals.identity_under_review, kind: "renewal_due" } as const;
    expect(shownProblem(underReview, "renewal_due")).toBe(A.refusals.identity_under_review);
    expect(shownProblem(underReview, "review")).toBeNull();
    expect(shownProblem(null, "start")).toBeNull();
  });

  test("the start's refusal stands while the session reads the same, and ends with a new session or a closed one", () => {
    expect(sessionMark({ status: "none" })).toBe("none");
    expect(sessionMark(open({ sessionId: "s1" }))).toBe("open:s1");
    expect(sessionMark("loading")).toBeNull();
    expect(sessionMark("unreadable")).toBeNull();

    const none = sessionMark({ status: "none" });
    expect(refusalStands(none, { status: "none" })).toBe(true);
    expect(refusalStands(none, open())).toBe(false);
    const first = sessionMark(open({ sessionId: "s1" }));
    // The same session read again, its counts moved: the same session.
    expect(refusalStands(first, open({ sessionId: "s1", attemptsLeft: 2, lastErrorCode: "document_expired" }))).toBe(true);
    expect(refusalStands(first, open({ sessionId: "s2" }))).toBe(false);
    expect(refusalStands(first, { status: "none" })).toBe(false);
    // A read not made yet changes nothing.
    expect(refusalStands(first, "loading")).toBe(true);
    expect(refusalStands(none, "unreadable")).toBe(true);
  });

  test("the card is under way while its read-back runs, its wait runs, or the provider is processing", () => {
    const idle = { session: open(), readBackRunning: false, waiting: false };
    expect(cardUnderWay(idle)).toBe(false);
    expect(cardUnderWay({ ...idle, readBackRunning: true })).toBe(true);
    expect(cardUnderWay({ ...idle, waiting: true })).toBe(true);
    expect(cardUnderWay({ ...idle, session: open({ reading: true }) })).toBe(true);
    // A held session, no session, or one not read: nothing under way on the card's side.
    for (const session of [open({ held: "system" }), open({ held: "operator" }), { status: "none" } as const, "loading" as const, "unreadable" as const])
      expect(cardUnderWay({ ...idle, session })).toBe(false);
  });
});

describe("the wait and the return", () => {
  test("the wait: a sync every 20 seconds, the reads between, three minutes in all", () => {
    expect(readingStep({ elapsedMs: 5_000, sinceSyncMs: 5_000 })).toBe("poll");
    expect(readingStep({ elapsedMs: 20_000, sinceSyncMs: 20_000 })).toBe("sync");
    expect(readingStep({ elapsedMs: 179_999, sinceSyncMs: 0 })).toBe("poll");
    expect(readingStep({ elapsedMs: 180_000, sinceSyncMs: 20_000 })).toBe("stop");
  });

  test("the read-back on arrival: done on an answer or on a read made a moment ago, failed otherwise", () => {
    expect(arrivalOf({ ok: true })).toBe("done");
    const refused = (code: string, status: number) =>
      arrivalOf({ ok: false, error: new ApiError(status, { code, message: "m" }) });
    expect(refused("identity_sync_too_soon", 429)).toBe("done");
    expect(refused("identity_provider_unavailable", 503)).toBe("failed");
    expect(arrivalOf({ ok: false, error: new Error("network") })).toBe("failed");
  });

  // Ruling R35: no read at the provider over a read of the session older than the moment it is
  // for (the card's mount, a click), nor over one that says the session is held, closed or gone.
  test("a read at the provider goes out only over a fresh read of the session that says it is open and not held", () => {
    const fresh = (session: Parameters<typeof providerReadStep>[0]["session"]) =>
      providerReadStep({ session, readAt: NOW + 1, after: NOW, by: "arrival" });
    expect(fresh(open())).toBe("sync");
    expect(fresh(open({ reading: true }))).toBe("sync");
    expect(fresh(open({ lastErrorCode: "document_expired", attemptsLeft: 2 }))).toBe("sync");
    // Held, or closed and gone: the card shows the fresh read, with no read at the provider.
    expect(fresh(open({ held: "system" }))).toBe("show");
    expect(fresh(open({ held: "operator" }))).toBe("show");
    expect(fresh({ status: "none" })).toBe("show");
    // Only a read from before (the cache when the card mounted, or a read again that failed): wait.
    expect(providerReadStep({ session: open(), readAt: NOW, after: NOW, by: "arrival" })).toBe("wait");
    expect(providerReadStep({ session: open(), readAt: NOW - 1, after: NOW, by: "arrival" })).toBe("wait");
    expect(providerReadStep({ session: { status: "none" }, readAt: NOW, after: NOW, by: "wait" })).toBe("wait");
    // No read yet.
    expect(providerReadStep({ session: "loading", readAt: 0, after: 0, by: "arrival" })).toBe("wait");
    expect(providerReadStep({ session: "unreadable", readAt: 0, after: 0, by: "wait" })).toBe("wait");
    // The same fresh read decides the same, whoever asks.
    for (const by of ["arrival", "wait", "click"] as const)
      expect(providerReadStep({ session: open(), readAt: NOW + 1, after: NOW, by })).toBe("sync");
  });

  // Follow-up U2: a click whose read again fails says so, like a read-back that failed, where
  // the wait's own tick keeps waiting quietly.
  test("on a click, no fresh read leaves the check unread, never a quiet wait", () => {
    for (const read of [
      { session: open(), readAt: NOW, after: NOW },
      { session: open({ reading: true }), readAt: NOW - 1, after: NOW },
      { session: "unreadable" as const, readAt: 0, after: 0 },
      { session: "loading" as const, readAt: 0, after: 0 },
    ]) {
      expect(providerReadStep({ ...read, by: "click" })).toBe("unreadable");
      expect(providerReadStep({ ...read, by: "wait" })).toBe("wait");
    }
  });

  test("the read-back tried again settles as the read did, as done when the fresh read showed the session held or gone, and unread with no fresh read", () => {
    expect(arrivalAfter({ sent: true, result: { ok: true } })).toBe("done");
    expect(
      arrivalAfter({ sent: true, result: { ok: false, error: new ApiError(503, { code: "identity_provider_unavailable", message: "m" }) } }),
    ).toBe("failed");
    expect(arrivalAfter({ sent: false, step: "show" })).toBe("done");
    expect(arrivalAfter({ sent: false, step: "wait" })).toBe("failed");
    // A click's read again that failed: unread, with Try again.
    expect(arrivalAfter({ sent: false, step: "unreadable" })).toBe("failed");
    // Another read at the provider under way or cooling: this one did not go out.
    expect(arrivalAfter({ sent: false, step: "busy" })).toBe("failed");
  });

  test("a sync the card asks for is never inside the server's throttle", () => {
    expect(READ_SYNC_EVERY_MS).toBeGreaterThanOrEqual(SYNC_MIN_INTERVAL_MS);
  });

  test("the return flag and the provider's address", () => {
    expect(returnedFromCheck(new URLSearchParams("identityCheck=returned"))).toBe(true);
    for (const q of ["", "identityCheck=1", "identitycheck=returned"]) expect(returnedFromCheck(new URLSearchParams(q))).toBe(false);
    expect(providerPageUrl("https://verify.example.test/start/abc")).toBe("https://verify.example.test/start/abc");
    for (const bad of ["http://verify.example.test/x", "javascript:alert(1)", "/relative", "", 5, null]) expect(providerPageUrl(bad)).toBeNull();
  });

  test("the address once the flag is read: the page's own path, every other part of the query kept", () => {
    expect(stripReturnedFlag("/start", "?identityCheck=returned")).toBe("/start");
    expect(stripReturnedFlag("/legal-body", "identityCheck=returned")).toBe("/legal-body");
    expect(stripReturnedFlag("/start", "")).toBe("/start");
    expect(stripReturnedFlag("/legal-body", "?order=o_1&identityCheck=returned")).toBe(
      "/legal-body?order=o_1",
    );
    expect(stripReturnedFlag("/start", "?path=declare")).toBe("/start?path=declare");
    // Any value of the flag leaves: the address never keeps a half-read return.
    expect(stripReturnedFlag("/start", "?identityCheck=1&path=form")).toBe("/start?path=form");
  });
});
