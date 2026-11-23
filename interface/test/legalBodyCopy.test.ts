/**
 * Every sentence the legal-body flow shows, against the claims ceiling.
 *
 * The flow keeps its words in one file, so one walk covers them all: every string of the copy
 * object, every check-reason sentence, and every notice sentence for every kind of notice on both
 * environments. None claims more than the facts behind it, none carries an em dash, "verified"
 * is said only of the person, and "Novi" stands alone only in the one approved sentence.
 */
import { describe, expect, test } from "vitest";
import {
  APPROVED_NOVI_SENTENCES,
  CHECK_REASON_SENTENCES,
  LEGAL_BODY_COPY,
  PERSON_SENTENCES,
  fillCopy,
} from "@/lib/legalBody/copy";
import { closedSentence, noticeSentence } from "@/lib/legalBody/notice";
import { LEGAL_BODY_PHASES } from "@/lib/legalBody/phases";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";
import { CHECK_REASON_CODES, LAPSE_REASONS } from "@/lib/api/types";

const YES =
  "a registered legal body stands behind this agent, and Novi states its standing as active";
const BANNER = "Arc testnet. The company is a test, the wording is a draft, and nothing here is a filing.";
const SANDBOX_STATEMENT =
  "sandbox: this statement is a test about a test company, and nothing in it is a filing";
const MONEY = "There is no payment step on this testnet deployment.";
const NEVER_APPROVE = "Never approve or transfer anything to Novi Corpus.";

/** Every string reachable from a value, depth first. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

/** One notice of every kind, with each variant its sentence depends on. */
const NOTICES: LegalBodyNotice[] = [
  { kind: "expired" },
  ...LAPSE_REASONS.map((reason) => ({ kind: "lapsed" as const, reason })),
  { kind: "lapsed", reason: null },
  { kind: "superseded", by: null },
  { kind: "superseded", by: "lbo_newer" },
  { kind: "replaced", by: null },
  { kind: "replaced", by: "lbo_newer" },
  { kind: "abandoned" },
  { kind: "order_revoked" },
  { kind: "other_deployment" },
  ...CHECK_REASON_CODES.map((reasonCode) => ({ kind: "company_failed" as const, reasonCode })),
  { kind: "company_failed", reasonCode: null },
  { kind: "company_revoked" },
  { kind: "company_awaiting_check" },
  { kind: "company_abandoned" },
  { kind: "formation_failed" },
  { kind: "creating" },
  { kind: "winding_down" },
  { kind: "dissolved" },
  { kind: "broken_reason_unknown" },
  { kind: "identity_taken", agentId: "897126" },
];

const ENVIRONMENTS = ["sandbox", "production"] as const;

const noticeStrings = ENVIRONMENTS.flatMap((environment) => [
  ...NOTICES.flatMap((n) => {
    const s = noticeSentence(n, environment);
    return [s.title, s.body];
  }),
  ...(() => {
    const s = closedSentence(undefined, environment);
    return [s.title, s.body];
  })(),
]);

const ALL = [
  ...stringsOf(LEGAL_BODY_COPY),
  ...stringsOf(CHECK_REASON_SENTENCES),
  ...LEGAL_BODY_PHASES.map((p) => p.label),
  ...noticeStrings,
];

describe("the claims ceiling", () => {
  test("the walk reaches a real number of sentences", () => {
    // A guard that walks nothing passes vacuously.
    expect(ALL.length).toBeGreaterThan(100);
    for (const s of ALL) expect(s.trim().length).toBeGreaterThan(0);
  });

  test.each([
    "verified company",
    "kyc",
    "licensed",
    "good standing",
    "human-backed",
    "guarantee",
    "included during the beta",
    "non-custodial",
    "autonomous legal person",
    "winds down",
    "wound down",
  ])("no sentence says %j", (forbidden) => {
    for (const s of ALL) expect(s.toLowerCase()).not.toContain(forbidden);
  });

  test("no sentence says free: the money sentence says there is no payment step", () => {
    for (const s of ALL) expect(s).not.toMatch(/\bfree\b/i);
  });

  test("no sentence carries an em dash", () => {
    for (const s of ALL) expect(s).not.toContain("\u2014");
  });

  test("'verified' is said only of the person", () => {
    const saying = ALL.filter((s) => /verified/i.test(s));
    for (const s of saying) expect(PERSON_SENTENCES).toContain(s);
    // The list is not empty by accident: the accepted human gate says it of the person.
    expect(PERSON_SENTENCES.length).toBeGreaterThan(0);
    for (const s of PERSON_SENTENCES) expect(ALL).toContain(s);
  });

  test("'Novi' stands alone only in the approved sentence; elsewhere it is Novi Corpus", () => {
    const alone = ALL.filter((s) => /\bNovi\b(?! Corpus)/.test(s));
    expect(alone.length).toBeGreaterThan(0);
    for (const s of alone) expect(APPROVED_NOVI_SENTENCES).toContain(s);
    expect(APPROVED_NOVI_SENTENCES).toEqual([YES]);
  });
});

describe("the sentences carried verbatim", () => {
  test.each([
    ["the yes sentence", YES],
    ["the sandbox banner", BANNER],
    ["the done page's sandbox statement line", SANDBOX_STATEMENT],
    ["the money sentence", MONEY],
    ["the never-approve sentence", NEVER_APPROVE],
    ["the deployment gate", "This deployment does not offer legal bodies on your own identity."],
    ["the declarations-off sentence", "This deployment does not take new declarations."],
    [
      "the product sentence of the human gate",
      "A legal body for your agent needs a real person on record; a waiver is not accepted for this product.",
    ],
    [
      "the smart-account sentence",
      "This wallet is a smart account. The declaration needs a plain wallet signature, so a smart account cannot be the guardian here.",
    ],
    [
      "the rail's footer",
      "Two signatures and one or two transactions from your wallet. Never an approval or a transfer.",
    ],
  ])("%s", (_name, sentence) => {
    expect(ALL).toContain(sentence);
  });

  test("the testnet banner and the statement line are true on both doors: a formed company is no declaration", () => {
    // The banner shows above the choice of paths and on both doors; the statement line on both
    // doors' done page. Neither may name one door's kind of company, nor the declared door's check.
    for (const s of [LEGAL_BODY_COPY.sandbox.banner, LEGAL_BODY_COPY.done.sandboxStatement]) {
      expect(s.toLowerCase()).not.toContain("declaration");
      expect(s.toLowerCase()).not.toContain("check");
      expect(s).toContain("filing");
    }
    expect(LEGAL_BODY_COPY.sandbox.banner).toBe(BANNER);
    expect(LEGAL_BODY_COPY.done.sandboxStatement).toBe(SANDBOX_STATEMENT);
  });

  test("registering says it moves no funds, never that it transfers nothing: it mints a token and spends gas", () => {
    expect(LEGAL_BODY_COPY.identity.registerBody).toContain("It approves nothing and moves no funds.");
    expect(LEGAL_BODY_COPY.identity.registerBody).not.toContain("transfers nothing");
  });

  test("the page and the rail are headed the same way", () => {
    expect(LEGAL_BODY_COPY.page.title).toBe("A legal body for your agent");
    expect(LEGAL_BODY_COPY.rail.heading).toBe("A legal body for your agent");
  });

  test("every reason a check can fail has its sentence", () => {
    expect(Object.keys(CHECK_REASON_SENTENCES).sort()).toEqual([...CHECK_REASON_CODES].sort());
  });
});

describe("the agent's wallet step", () => {
  const AW = LEGAL_BODY_COPY.agentWallet;
  const section = stringsOf(AW);

  test("the section is walked with the rest, and passes the same rules", () => {
    expect(section.length).toBeGreaterThan(40);
    for (const s of section) {
      expect(ALL).toContain(s);
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/\bfree\b/i);
      expect(s).not.toMatch(/our agents/i);
      expect(s).not.toMatch(/verified/i);
      expect(s).not.toMatch(/\bNovi\b(?! Corpus)/);
    }
  });

  test.each([
    ["title", AW.title, "Your agent's wallet"],
    [
      "why",
      AW.why,
      "Your agent needs a wallet of its own: the key it signs and pays with. Anyone it pays can then find its company. It must not be your wallet.",
    ],
    ["checking", AW.checking, "Reading the agent's wallet on the registry."],
    ["unreadable", AW.unreadable, "The registry could not be read just now. Nothing was changed."],
    ["todayGuardian", AW.todayGuardian, "Today the registry names your own wallet as this agent's wallet."],
    ["todayNone", AW.todayNone, "Today the registry names no wallet for this agent."],
    ["hasKeyTitle", AW.hasKeyTitle, "My agent has its own key"],
    ["hasKeyLine", AW.hasKeyLine, "Give the key's address. The key signs one message to prove itself."],
    ["noKeyTitle", AW.noKeyTitle, "My agent has no key yet"],
    ["noKeyLine", AW.noKeyLine, "Create one where your agent runs. The key never passes through this site."],
    ["providerTitle", AW.providerTitle, "My agent has a wallet with a provider"],
    [
      "providerLine",
      AW.providerLine,
      "Give the wallet's address. The wallet signs one message through its provider. It must already exist on {network}.",
    ],
    [
      "noKeyAsk",
      AW.noKeyAsk,
      'Ask your agent: "Create an Ethereum key for yourself. Keep the private key in your own secret storage and never show it. Tell me only the address."',
    ],
    ["noKeyCommandIntro", AW.noKeyCommandIntro, "Or, with Foundry installed where the agent runs:"],
    ["noKeyCommand", AW.noKeyCommand, "cast wallet new ~/.foundry/keystores agent-key"],
    ["addressLabel", AW.addressLabel, "The agent's wallet address"],
    [
      "addressProblems.not_address",
      AW.addressProblems.not_address,
      "This is not an address: it starts with 0x and has 40 more characters.",
    ],
    ["addressProblems.zero", AW.addressProblems.zero, "This address cannot be an agent's wallet."],
    [
      "addressProblems.guardian",
      AW.addressProblems.guardian,
      "This is your own wallet. The agent's wallet must be a different one.",
    ],
    ["prepare", AW.prepare, "Prepare the message"],
    ["messageIntro", AW.messageIntro, "The agent's wallet signs this message. It is valid for a few minutes."],
    [
      "signAsk",
      AW.signAsk,
      'Ask your agent: "Sign this EIP-712 message with your key and give me the signature."',
    ],
    ["signCommandIntro", AW.signCommandIntro, "Or save it as message.json and run:"],
    ["signCommand", AW.signCommand, "cast wallet sign --data --from-file message.json --account agent-key"],
    ["countdown", AW.countdown, "Valid for {seconds} more seconds."],
    ["expired", AW.expired, "This message has expired. Prepare a new one."],
    ["signatureLabel", AW.signatureLabel, "The signature"],
    [
      "signatureProblems.wrong_key",
      AW.signatureProblems.wrong_key,
      "This signature was not made by that wallet's key, or not over this message.",
    ],
    [
      "signatureProblems.compact",
      AW.signatureProblems.compact,
      "This is a compact signature of 64 bytes. The registry takes the usual 65-byte form: sign again without the compact option.",
    ],
    [
      "signatureProblems.wrapped",
      AW.signatureProblems.wrapped,
      "This signature is made for a wallet that does not exist on {network} yet. The wallet must exist on the chain first.",
    ],
    [
      "signatureProblems.not_on_chain",
      AW.signatureProblems.not_on_chain,
      "No wallet exists at this address on {network} yet. A provider's wallet must exist on the chain before it can sign.",
    ],
    [
      "signatureProblems.contract_refused",
      AW.signatureProblems.contract_refused,
      "The wallet did not accept this signature.",
    ],
    ["send", AW.send, "Write the wallet on the identity"],
    ["sending", AW.sending, "Waiting for your wallet."],
    ["waiting", AW.waiting, "Waiting for the registry to show the wallet."],
    [
      "wouldRevert",
      AW.wouldRevert,
      "The registry would refuse this transaction, so nothing was sent. Prepare a new message.",
    ],
    [
      "reverted",
      AW.reverted,
      "The transaction did not go through. Nothing was changed. Prepare a new message.",
    ],
    [
      "notThisWallet",
      AW.notThisWallet,
      "The wallet connected here does not own this identity. Connect the wallet that owns it.",
    ],
    [
      "elsewhere",
      AW.elsewhere,
      "This identity is owned by another key. That key must write the agent's wallet on the registry (setAgentWallet), with a signature of the new wallet that is at most five minutes old. This page checks again by itself.",
    ],
    ["checkAgain", AW.checkAgain, "Check again"],
    ["line", AW.line, "This agent's wallet: {address}"],
    [
      "noReceipt",
      AW.noReceipt,
      "No receipt came back within {minutes} minutes, so whether the wallet was written is not known yet. Look at the transaction, then check again. If it is not on the chain, prepare a new message.",
    ],
    [
      "ownerChanged",
      AW.ownerChanged,
      "The identity's owner changed since the message was prepared. Prepare a new message.",
    ],
    ["otherAccountTitle", AW.otherAccountTitle, "Sign with another account of your browser wallet"],
    [
      "otherAccountHow",
      AW.otherAccountHow,
      "In your wallet, connect the agent's account to this site as well, and keep your own account selected.",
    ],
    ["otherAccountSign", AW.otherAccountSign, "Sign with {address}"],
    [
      "otherAccountDeclined",
      AW.otherAccountDeclined,
      "Your wallet did not sign with that account. You can paste the signature instead.",
    ],
  ])("%s, word for word", (_key, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("fillCopy", () => {
  test("fills every named value", () => {
    expect(fillCopy("Identity {agentId} of {who}", { agentId: "42", who: "you" })).toBe(
      "Identity 42 of you",
    );
  });

  test("a value it is not given stays named, never silently empty", () => {
    expect(fillCopy("Identity {agentId}", {})).toBe("Identity {agentId}");
  });

  test("no template is left half-filled in a notice", () => {
    for (const s of noticeStrings) expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
