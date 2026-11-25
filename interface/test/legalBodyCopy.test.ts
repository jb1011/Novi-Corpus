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
  POT_DECLARATION_VERSION,
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
    // The pot: no read proves more than that the agent's key cannot take (Ruling R5), and the
    // ceiling is read from the chain, never claimed as held by anyone.
    "no key may take",
    "enforced",
    "guaranteed",
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
      "Two signatures and one or two transactions from your wallet to get a legal body. Never an approval or a transfer.",
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
    ["doneTitle", AW.doneTitle, "Set your agent's wallet"],
    [
      "doneLine",
      AW.doneLine,
      "The registry still names your own wallet as this agent's wallet. A payment made by the agent does not lead to its company yet.",
    ],
    [
      "doneLineNone",
      AW.doneLineNone,
      "The registry names no wallet for this agent. It cannot act under its Charter until it has one.",
    ],
    ["account.walletOwed", LEGAL_BODY_COPY.account.walletOwed, "Agent's wallet not set"],
  ])("%s, word for word", (_key, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("the company's pot", () => {
  const POT = LEGAL_BODY_COPY.pot;
  const section = stringsOf(POT);

  test("the section is walked with the rest, and passes the same rules", () => {
    expect(section.length).toBeGreaterThan(120);
    for (const s of section) {
      expect(ALL).toContain(s);
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/\bfree\b/i);
      expect(s).not.toMatch(/our agents/i);
      expect(s).not.toMatch(/verified/i);
      expect(s).not.toMatch(/\bNovi\b(?! Corpus)/);
      expect(s).not.toMatch(/enforced|guarantee|no key may take/i);
    }
  });

  test("'per thirty days' is said only of the grant's own amounts, never of the pot's ceiling", () => {
    // The pot counts fixed periods: "in each thirty-day period". A grant's amounts are counted
    // back from each act, so they keep "per thirty days".
    const saying = ALL.filter((s) => /per thirty days/i.test(s));
    expect(saying).toEqual([POT.ceilingProblems.above_grant]);
    expect(section.filter((s) => /in each thirty-day period/.test(s)).length).toBeGreaterThan(4);
  });

  test("the pot's page says Novi Corpus holds no key and no money", () => {
    expect(POT.what).toContain("Novi Corpus holds no key and no money");
  });

  test("the declaration's version is the one the server stores", () => {
    expect(POT_DECLARATION_VERSION).toBe("pot-declaration-1");
  });

  test("the stopped pot says only what was read: the agent's key cannot take from it (Ruling R5)", () => {
    expect(POT.stoppedLine).toBe(
      "The allowance of this pot is switched off: the agent's key cannot take from it.",
    );
    expect(POT.recordStopped).toBe(
      "The guardian declared this pot for the company: {address}. The agent's key cannot take from it: its allowance is switched off. It holds {balance} USDC. Read from the chain on {date}.",
    );
  });

  test("the two codes of the fee money rule read the same sentence (Ruling R10)", () => {
    expect(POT.refusals.fee_money_needs_plain_key).toBe(POT.refusals.fee_money_contract_wallet);
  });

  test.each([
    ["cardTitle", POT.cardTitle, "Give your agent an allowance"],
    [
      "cardLine",
      POT.cardLine,
      "Keep the company's money in a pot that only your wallet owns. Your agent's key takes from it up to a ceiling in each thirty-day period.",
    ],
    ["title", POT.title, "The company's pot"],
    [
      "what",
      POT.what,
      "The pot is a Safe wallet on {network}. Your wallet is its only owner. Your agent's key can take USDC from it up to the ceiling, and nothing more. Novi Corpus holds no key and no money.",
    ],
    [
      "periods",
      POT.periods,
      "The pot counts in fixed periods of thirty days, one after the other, from the minute it is created. What is not taken in a period is not carried over. Around the end of a period your agent's key can take the ceiling just before it ends and the ceiling again just after, so up to twice the ceiling within a few minutes.",
    ],
    [
      "limits",
      POT.limits,
      "The ceiling is one amount for each period. It does not look at who is paid, at the size of one payment or at the kind of act, and it does not cover money paid straight to your agent's key.",
    ],
    ["keepLittle", POT.keepLittle, "Keep in the pot only what your agent needs."],
    [
      "noRecovery",
      POT.noRecovery,
      "If you lose this wallet, nobody can recover the money in the pot, Novi Corpus included.",
    ],
    ["checking", POT.checking, "Reading the pot on the chain."],
    ["ceilingLabel", POT.ceilingLabel, "Ceiling for each thirty-day period, in USDC"],
    [
      "ceilingMax",
      POT.ceilingMax,
      "At most {cap} USDC, the grant's thirty-day total for buying, paying and engaging a contractor.",
    ],
    [
      "ceilingNoGrant",
      POT.ceilingNoGrant,
      "Choose the most your agent's key may take in each thirty-day period.",
    ],
    [
      "grantNoSpending",
      POT.grantNoSpending,
      "Your agent's grant allows no buying, no paying and no engaging of contractors, so a pot has nothing to release.",
    ],
    [
      "grantEnds",
      POT.grantEnds,
      "Your agent's grant ends on {date}. The pot does not stop by itself on that day: stop the allowance then.",
    ],
    [
      "grantUnreadable",
      POT.grantUnreadable,
      "Your agent's grant could not be read just now, so the ceiling's limit cannot be shown.",
    ],
    ["ceilingProblems.empty", POT.ceilingProblems.empty, "Give a ceiling."],
    [
      "ceilingProblems.not_whole",
      POT.ceilingProblems.not_whole,
      "Write a whole number of USDC, with no decimals.",
    ],
    ["ceilingProblems.zero", POT.ceilingProblems.zero, "The ceiling must be at least 1 USDC."],
    ["ceilingProblems.too_large", POT.ceilingProblems.too_large, "This is more than a pot takes."],
    [
      "ceilingProblems.above_grant",
      POT.ceilingProblems.above_grant,
      "This is above the {amount} USDC your agent's grant allows per thirty days.",
    ],
    ["fundLabel", POT.fundLabel, "Put in the pot now, in USDC (optional)"],
    [
      "fundLine",
      POT.fundLine,
      "You can add more later with Add money, or by sending USDC to the pot's address from any wallet.",
    ],
    ["gasLabel", POT.gasLabel, "Fee money for your agent's key, in USDC"],
    [
      "gasLine",
      POT.gasLine,
      "Your agent's key pays a small network fee each time it takes from the pot, so it needs a little USDC of its own first. This amount goes straight to the key and is outside the ceiling.",
    ],
    [
      "gasContract",
      POT.gasContract,
      "Your agent's wallet is a contract wallet. It pays its fees its own way, so nothing is sent to it here. It must be able to call a contract itself to take from the pot.",
    ],
    [
      "amountProblems.not_amount",
      POT.amountProblems.not_amount,
      "Write an amount in USDC, such as 25 or 0.5.",
    ],
    ["amountProblems.too_precise", POT.amountProblems.too_precise, "USDC has six decimals at most."],
    ["amountProblems.too_large", POT.amountProblems.too_large, "This amount is too large."],
    [
      "amountProblems.gas_too_large",
      POT.amountProblems.gas_too_large,
      "Fee money is at most 1 USDC. Money for the company goes in the pot.",
    ],
    ["amountProblems.empty", POT.amountProblems.empty, "Give an amount."],
    ["amountProblems.zero", POT.amountProblems.zero, "Give an amount above 0 USDC."],
    ["review", POT.review, "Review"],
    ["reviewTitle", POT.reviewTitle, "Check before you sign"],
    ["reviewOwner", POT.reviewOwner, "Only owner of the pot: {address} (your wallet)"],
    [
      "reviewAgent",
      POT.reviewAgent,
      "The key that may take from it: {address} (your agent's wallet in the registry)",
    ],
    [
      "reviewCeiling",
      POT.reviewCeiling,
      "Ceiling: {amount} USDC in each thirty-day period. The first period starts when the pot is created.",
    ],
    [
      "reviewAgentNoted",
      POT.reviewAgentNoted,
      "The key that may take from it: {address}, the key this pot was noted for. Your agent's wallet in the registry is now {registry}.",
    ],
    [
      "reviewKeyChanged",
      POT.reviewKeyChanged,
      "So this transaction puts no money in the pot and sends nothing to that earlier key. Once the pot exists, use My agent has a new key to let the new key take from it, then add money.",
    ],
    ["reviewAddress", POT.reviewAddress, "The pot's address will be {address}"],
    [
      "reviewTotal",
      POT.reviewTotal,
      "Your wallet will ask you to send {total} USDC to a contract called Multicall3. In the same transaction it creates the pot, puts {fund} USDC in it and sends {gas} USDC to your agent's key. Nothing goes to Novi Corpus.",
    ],
    [
      "reviewFundOnly",
      POT.reviewFundOnly,
      "Your wallet will ask you to send {total} USDC to a contract called Multicall3. In the same transaction it creates the pot and puts the {total} USDC in it. Nothing goes to Novi Corpus.",
    ],
    [
      "reviewGasOnly",
      POT.reviewGasOnly,
      "Your wallet will ask you to send {total} USDC to a contract called Multicall3. In the same transaction it creates the pot and sends the {total} USDC to your agent's key. The pot starts empty. Nothing goes to Novi Corpus.",
    ],
    [
      "reviewNoMoney",
      POT.reviewNoMoney,
      "Your wallet will ask you to confirm a transaction that sends no money. It creates the pot.",
    ],
    [
      "declaration",
      POT.declaration,
      "I declare this pot for the company: it holds the company's money, and its address, its ceiling, what was taken from it and what it holds will show in the public record.",
    ],
    ["declarationNeeded", POT.declarationNeeded, "Tick the declaration to go on."],
    ["create", POT.create, "Create the pot"],
    ["back", POT.back, "Change something"],
    ["sending", POT.sending, "Waiting for your wallet."],
    ["waiting", POT.waiting, "Waiting for the pot to appear on the chain."],
    ["waitingChange", POT.waitingChange, "Waiting for the chain."],
    ["created", POT.created, "The pot exists. This is what the chain shows:"],
    ["done", POT.done, "Done. This is what the chain shows now:"],
    ["problems.unsupported", POT.problems.unsupported, "The pot is not offered on this network."],
    [
      "problems.agent_wallet",
      POT.problems.agent_wallet,
      "The agent's wallet in the registry is not one a pot can use: it is unset, or it is your own wallet. Set your agent's wallet first.",
    ],
    [
      "problems.pot_exists",
      POT.problems.pot_exists,
      "A pot already exists at this address. Nothing was sent.",
    ],
    [
      "problems.not_enough",
      POT.problems.not_enough,
      "Your wallet holds {balance} USDC. This needs {total} USDC and a small fee.",
    ],
    [
      "problems.not_this_wallet",
      POT.problems.not_this_wallet,
      "The wallet connected here is not this legal body's guardian wallet. Connect {address}.",
    ],
    [
      "problems.wrong_network",
      POT.problems.wrong_network,
      "Your wallet is on another network. Switch it to {network}.",
    ],
    [
      "problems.record_failed",
      POT.problems.record_failed,
      "Novi Corpus could not note the pot's address, so nothing was sent. Try again.",
    ],
    [
      "problems.would_revert",
      POT.problems.would_revert,
      "The chain would refuse this transaction, so nothing was sent.",
    ],
    ["problems.declined", POT.problems.declined, "You declined in your wallet. Nothing was sent."],
    [
      "problems.reverted",
      POT.problems.reverted,
      "The transaction did not go through. Nothing changed and no money moved.",
    ],
    [
      "problems.no_receipt",
      POT.problems.no_receipt,
      "No answer from the chain after three minutes. Check again before you start over: the transaction may have gone through.",
    ],
    [
      "problems.read_failed",
      POT.problems.read_failed,
      "The chain could not be read just now. Nothing was changed.",
    ],
    [
      "problems.refused",
      POT.problems.refused,
      "This transaction is not one this page may send, so nothing was sent.",
    ],
    [
      // Ruling R34: a setup declined or dropped keeps the noted ceiling; the sentence says the way
      // out.
      "problems.noted_pot",
      POT.problems.noted_pot,
      "A pot with a ceiling of {amount} USDC was noted for this legal body and is not on the chain yet. Keep that ceiling to create it: another ceiling would make a second pot. To use another ceiling, create it with no money, then use Change the allowance before you add any. Nothing was sent.",
    ],
    ["checkAgain", POT.checkAgain, "Check again"],
    ["shownAddress", POT.shownAddress, "The pot's address: {address}"],
    ["shownOwner", POT.shownOwner, "Only owner: {address}"],
    ["shownAgent", POT.shownAgent, "May take from it: {address}"],
    ["shownCeiling", POT.shownCeiling, "Ceiling: {amount} USDC in each thirty-day period"],
    [
      "shownSpent",
      POT.shownSpent,
      "Taken in this period: {spent} USDC. {left} USDC left until {date}, when the next period starts.",
    ],
    ["shownBalance", POT.shownBalance, "In the pot: {balance} USDC"],
    ["shownFeeMoney", POT.shownFeeMoney, "Your agent's key holds {amount} USDC for network fees."],
    [
      "feeMoneyLow",
      POT.feeMoneyLow,
      "This is low. Each take costs the key a small fee in USDC, and the network refuses a take the key cannot pay for. Send it a little with Send fee money.",
    ],
    [
      "limitsNotRead",
      POT.limitsNotRead,
      "This pot is set up in a way this page does not read: {reason}. Its ceiling is not shown.",
    ],
    ["limitReasons.other_module", POT.limitReasons.other_module, "it has another add-on switched on"],
    ["limitReasons.guard_set", POT.limitReasons.guard_set, "it has a guard"],
    [
      "limitReasons.other_handler",
      POT.limitReasons.other_handler,
      "it has a fallback handler other than Safe's own",
    ],
    [
      "limitReasons.usdc_approved",
      POT.limitReasons.usdc_approved,
      "it lets your agent's key spend its USDC directly, outside the ceiling",
    ],
    [
      "limitReasons.other_delegate",
      POT.limitReasons.other_delegate,
      "a key other than your agent's wallet may take from it",
    ],
    [
      "limitReasons.other_token",
      POT.limitReasons.other_token,
      "it has an allowance on something other than USDC",
    ],
    ["limitReasons.other_period", POT.limitReasons.other_period, "its period is not thirty days"],
    [
      "notYours",
      POT.notYours,
      "The address noted for this legal body is not a pot that only your wallet owns.",
    ],
    [
      "onePot",
      POT.onePot,
      "A legal body keeps one pot for its whole life. To give your agent an allowance again, use Start again on this pot.",
    ],
    ["changeTitle", POT.changeTitle, "Change the allowance"],
    [
      "changeLine",
      POT.changeLine,
      "Sets a new ceiling from now on. The running period, and what was already taken in it, stay as they are.",
    ],
    ["changeSend", POT.changeSend, "Set the new ceiling"],
    ["stopTitle", POT.stopTitle, "Stop the allowance"],
    [
      "stopLine",
      POT.stopLine,
      "Removes your agent's key from the pot and switches the allowance off, in one transaction. Your agent can take nothing after it. The money stays in the pot until you take it back.",
    ],
    ["stopSend", POT.stopSend, "Stop the allowance"],
    ["withdrawTitle", POT.withdrawTitle, "Take the money back"],
    [
      "withdrawLine",
      POT.withdrawLine,
      "Sends everything in the pot, {balance} USDC, to your wallet.",
    ],
    ["withdrawSend", POT.withdrawSend, "Take {balance} USDC back"],
    ["startAgainTitle", POT.startAgainTitle, "Start again"],
    [
      "startAgainLine",
      POT.startAgainLine,
      "Lets this key take from the pot again: {address}, your agent's wallet in the registry. One transaction, with the ceiling you choose. A new thirty-day period starts now, with nothing taken yet.",
    ],
    ["startAgainSend", POT.startAgainSend, "Start again"],
    ["newKeyTitle", POT.newKeyTitle, "My agent has a new key"],
    [
      "newKeyLine",
      POT.newKeyLine,
      "Your agent's wallet in the registry is now {address}. This takes the old key off the pot and lets the new one take from it, with the ceiling you choose, in one transaction. A new thirty-day period starts now for the new key.",
    ],
    ["newKeySend", POT.newKeySend, "Move the allowance to the new key"],
    ["addMoneyTitle", POT.addMoneyTitle, "Add money"],
    [
      "addMoneyLine",
      POT.addMoneyLine,
      "Sends USDC from your wallet to the pot, {address}. Nothing goes to Novi Corpus.",
    ],
    ["addMoneyLabel", POT.addMoneyLabel, "Amount, in USDC"],
    ["addMoneySend", POT.addMoneySend, "Add {amount} USDC"],
    ["feeMoneyTitle", POT.feeMoneyTitle, "Send fee money"],
    [
      "feeMoneyLine",
      POT.feeMoneyLine,
      "Sends a little USDC from your wallet to your agent's key, {address}, for its network fees. It is outside the ceiling. At most 1 USDC.",
    ],
    ["feeMoneySend", POT.feeMoneySend, "Send {amount} USDC"],
    ["offRecordTitle", POT.offRecordTitle, "Take the pot off the public record"],
    [
      "offRecordLine",
      POT.offRecordLine,
      "The record stops showing this pot beside the legal body. The pot, its money and its allowance stay as they are. A search by the pot's address still leads to the company, marked as a former pot.",
    ],
    ["offRecordSend", POT.offRecordSend, "Take it off the record"],
    [
      "offRecord",
      POT.offRecord,
      "This pot is off the public record. A search by its address still leads to the company, marked as a former pot.",
    ],
    ["backOnTitle", POT.backOnTitle, "Put the pot back on the public record"],
    ["backOnSend", POT.backOnSend, "Put it back on the record"],
    [
      "recordAnswerLost",
      POT.recordAnswerLost,
      "The answer did not come back, so this page reads the pot again to show where it stands.",
    ],
    ["agentTitle", POT.agentTitle, "For your agent"],
    [
      "agentLine",
      POT.agentLine,
      "Your agent takes from the pot with its own key. Novi Corpus never holds that key and sends nothing for it.",
    ],
    [
      "agentMcp",
      POT.agentMcp,
      "Over MCP: the tool get_pot reads what is left, and prepare_pot_take prepares a take for the agent's key to send.",
    ],
    [
      "agentCommandIntro",
      POT.agentCommandIntro,
      "Or, with Foundry where the agent runs, one command. PAYEE is who is paid. UNITS is the amount in millionths of a USDC: 1 USDC is 1000000.",
    ],
    [
      "agentCommand",
      POT.agentCommand,
      'cast send {module} "executeAllowanceTransfer(address,address,address,uint96,address,uint96,address,bytes)" {pot} {token} PAYEE UNITS 0x0000000000000000000000000000000000000000 0 {agent} 0x --gas-limit 200000 --rpc-url {rpc} --account agent-key',
    ],
    ["agentReadIntro", POT.agentReadIntro, "To read what is left:"],
    [
      "agentRead",
      POT.agentRead,
      'cast call {module} "getTokenAllowance(address,address,address)(uint256[5])" {pot} {agent} {token} --rpc-url {rpc}',
    ],
    [
      "agentReadLine",
      POT.agentReadLine,
      "The five numbers are the ceiling, what was taken in this period, the period in minutes, the minute the period started, and a counter.",
    ],
    [
      "recordCeiling",
      POT.recordCeiling,
      "The guardian declared this pot for the company: {address}. The agent's key may take up to {amount} USDC from it in each thirty-day period; the current one ends on {ends}. It holds {balance} USDC. Read from the chain on {date}.",
    ],
    [
      "recordNotRead",
      POT.recordNotRead,
      "The guardian declared this pot for the company: {address}. Its limits were not read.",
    ],
    ["recordUnavailable", POT.recordUnavailable, "The company's pot could not be read just now."],
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
