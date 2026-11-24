/**
 * The identity check card, rendered as the server renders it: in each of its states, the words
 * the card's rules give, the name form only where a check starts or continues, nothing a guardian
 * must not read (the provider, the screen, a dash), and no button where the guardian has nothing
 * to do. The operator's card reads as it did before the automatic check.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GuardianIdentityCard } from "@/components/legalBody/GuardianIdentityCard";
import { formatDate } from "@/lib/format";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  GUARDIAN_NOTICE_URL,
  identityCardText,
  type AutomaticCardView,
  type IdentityCardKind,
  type IdentityCardView,
} from "@/lib/legalBody/identityCheck";

const A = LEGAL_BODY_COPY.human.guardianIdentity.automatic;
const G = LEGAL_BODY_COPY.human.guardianIdentity;

const NOW = Date.UTC(2026, 10, 24);

/** A button's label as React renders it, so a sentence that contains the word does not count. */
const button = (label: string) => new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`, "s");

const KINDS: IdentityCardKind[] = [
  "locked",
  "loading",
  "unreadable",
  "start",
  "start_again",
  "expired",
  "revoked",
  "continue",
  "retry",
  "reading",
  "finishing",
  "review",
  "verified",
  "renewal_due",
];
const FORM_KINDS: IdentityCardKind[] = [
  "start",
  "start_again",
  "expired",
  "revoked",
  "continue",
  "retry",
  "renewal_due",
];

type CardProps = Parameters<typeof GuardianIdentityCard>[0];

const card = (view: Exclude<IdentityCardView, { kind: "hidden" }>, over: Partial<CardProps> = {}) =>
  renderToString(
    createElement(GuardianIdentityCard, {
      view,
      busy: false,
      problem: null,
      longWait: false,
      canCheckAgain: true,
      onStart() {},
      onCheckAgain() {},
      onRetryRead() {},
      ...over,
    }),
  );

const automatic = (kind: IdentityCardKind, required: boolean): AutomaticCardView => ({
  kind,
  counts: kind === "verified" || kind === "renewal_due",
  required,
  verifiedAt: NOW,
  dueAt: kind === "renewal_due" ? NOW : null,
  attemptsLeft: kind === "retry" ? 2 : null,
  errorCode: kind === "retry" ? "document_expired" : null,
});

describe("GuardianIdentityCard, automatic", () => {
  test.each(KINDS.flatMap((k) => [[k, true], [k, false]] as const))(
    "%s (required %s): its words, a form only where there is one, and nothing a guardian must not read",
    (kind, required) => {
      const view = automatic(kind, required);
      const out = card(view).replace(/&#x27;/g, "'");
      const t = identityCardText(view, { longWait: false, formatDate });
      for (const s of [t.record, t.status, ...t.notes, ...(t.form?.lines ?? [])])
        if (s) expect(out).toContain(s);
      expect(out.includes("<form")).toBe(FORM_KINDS.includes(kind));
      expect((out.match(/<input/g) ?? []).length).toBe(FORM_KINDS.includes(kind) ? 2 : 0);
      if (t.form) expect(out).toMatch(button(t.form.button));
      expect(out).toContain(A.why);
      expect(out).toContain(GUARDIAN_NOTICE_URL);
      // The provider, the screen, the old word for the check, and an em dash (U+2014, escaped).
      expect(out).not.toMatch(/stripe|opensanctions|sanction|watchlist|kyc|\u2014/i);
    },
  );

  // Review Focus 4.
  test("the held and the review states offer no button at all", () => {
    for (const kind of ["finishing", "review"] as const)
      expect(card(automatic(kind, true))).not.toContain("<button");
  });

  // Review Focus 1.
  test("came back without finishing: the continue sentence and its button, never the reading sentence", () => {
    const out = card(automatic("continue", true));
    expect(out).toContain(A.continue);
    expect(out).toMatch(button(A.buttons.continue));
    expect(out).not.toContain(A.reading);
  });

  // Review Focus 5.
  test("busy: the start button is disabled and says the check is opening", () => {
    const out = card(automatic("start", true), { busy: true });
    expect(out).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>).)*Opening the check`, "s"));
  });

  test("a long wait offers Check again; a refusal is shown as the card's own sentence", () => {
    expect(card(automatic("reading", true), { longWait: true })).toMatch(button(A.checkAgain));
    expect(card(automatic("reading", true))).not.toMatch(button(A.checkAgain));
    expect(card(automatic("start", true), { problem: A.refusals.identity_session_limit })).toContain(
      A.refusals.identity_session_limit,
    );
  });
});

describe("GuardianIdentityCard, the operator's", () => {
  test("the operator's card reads as before", () => {
    const out = card({ kind: "operator", state: "none", verifiedAt: null });
    expect(out).toContain(G.none);
    expect(out).toContain(G.never);
    expect(out).not.toContain("<input");
    expect(out).not.toContain(A.why);
  });
});
