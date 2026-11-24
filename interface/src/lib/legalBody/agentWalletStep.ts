/**
 * The agent's wallet step's view model, each piece pure.
 *
 * The step writes the agent's own wallet on its identity: the identity's owner sends one
 * `setAgentWallet(agentId, newWallet, deadline, signature)`, with the new wallet's signature over a
 * message valid for a few minutes of the chain's time (`agentWallet.ts` holds the registry's rules).
 *
 * Here: the chain's time as the step estimates it (`chainClockAt`, `chainNowSeconds`, ruling R1);
 * the message prepared from what the chain answered (`agentWalletPrepare`); what a pasted signature
 * is worth once the chain is asked (`agentWalletSignatureCheck`); the check before any wallet prompt
 * (`agentWalletSendPreflight`); the other accounts of the browser wallet that could sign as the
 * agent's wallet (`browserAgentAccounts`); what the screen shows for a derivation and a stage
 * (`agentWalletStepView`); the line on the link screens (`agentWalletLineText`); for a legal body
 * that already exists, the done page's card (`doneWalletCard`) and the step's own reading of the
 * registry (`linkedWalletState`); and the sentence of every refusal.
 *
 * Nothing here holds a chain, a clock or a wallet: the answers and the time come in as values, or as
 * functions the screen hands in, so every decision has a test.
 */
import type { Address, Hex, LegalBodyStatementJson } from "@/lib/api/types";
import {
  agentWalletOwed,
  agentWalletStanding,
  parseAgentWalletAddress,
  walletSetDeadline,
  walletSetSecondsLeft,
  walletSetSendable,
  walletSignatureVerdict,
  WALLET_SET_SEND_MARGIN_SECONDS,
  type AgentWalletRead,
  type RegistryDomain,
  type WalletAddressProblem,
  type WalletSetMessage,
  type WalletSignatureVerdict,
} from "./agentWallet";
import { walletKindOf } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { sameAddress, type LegalBodyNotice, type OwnerBranch, type WalletStep } from "./flow";
import {
  REGISTER_RECEIPT_TIMEOUT_MS,
  isRevert,
  networkName,
  noGasLine,
  registerSendFailure,
  type OwnerRead,
} from "./identity";

const AW = LEGAL_BODY_COPY.agentWallet;

type Environment = "sandbox" | "production";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// ---------------------------------------------------------------------------------------------
// The step's stages
// ---------------------------------------------------------------------------------------------

/** The three ways in: the agent holds a key; it has none yet (made where it runs, never here); or
 *  a provider holds its wallet, which must already exist on the chain. */
export type AgentWalletChoice = "has_key" | "no_key" | "provider";

export type AgentWalletStage =
  | { at: "choose" }
  | { at: "address"; choice: AgentWalletChoice }
  /** Prepared, waiting for a signature. */
  | { at: "message"; message: WalletSetMessage; domain: RegistryDomain }
  | { at: "sending" }
  | { at: "waiting"; hash: Hex }
  /** No receipt within `REGISTER_RECEIPT_TIMEOUT_MS`: the transaction may still land, or was
   *  dropped. Check again, or a new message (ruling R12). */
  | { at: "no_receipt"; hash: Hex }
  | { at: "reverted" }
  | { at: "would_revert" }
  /** The identity's owner at the send is not the one the message names: nothing sent (ruling R13). */
  | { at: "owner_changed" };

/** The registry's function, as the owning key calls it. Data, not a sentence. */
export const SET_AGENT_WALLET_FUNCTION = "setAgentWallet(uint256,address,uint256,bytes)";

// ---------------------------------------------------------------------------------------------
// The chain's time
// ---------------------------------------------------------------------------------------------

/** The head's timestamp, in seconds, and a monotonic clock's reading when it was read, in ms (the
 *  step's `performance.now()`). */
export type ChainClock = { headSeconds: number; readAtMs: number };

export function chainClockAt(headTimestamp: bigint, readAtMs: number): ChainClock {
  return { headSeconds: Number(headTimestamp), readAtMs };
}

/**
 * The chain's time now, as the step estimates it: the head's timestamp read when the message was
 * prepared, plus the local seconds elapsed since that read. Never the bare wall clock: the deadline
 * counts from the chain's clock, and a computer clock some seconds off would otherwise block every
 * send. `localNowMs` and `clock.readAtMs` are milliseconds of one monotonic clock (the step's
 * `performance.now()`), so a wall clock set back or forward meanwhile changes nothing. A time
 * before the read never takes the estimate before the head; a time that cannot be read (NaN) gives
 * NaN, which leaves no time to send.
 */
export function chainNowSeconds(clock: ChainClock, localNowMs: number): number {
  const elapsedMs = localNowMs - clock.readAtMs;
  if (Number.isNaN(elapsedMs)) return Number.NaN;
  return clock.headSeconds + Math.max(0, elapsedMs) / 1000;
}

// ---------------------------------------------------------------------------------------------
// "Prepare the message"
// ---------------------------------------------------------------------------------------------

export type AgentWalletPrepared =
  | { ok: true; message: WalletSetMessage; domain: RegistryDomain }
  | { ok: false; line: string };

/**
 * The message, from the four reads of "Prepare the message": the head's timestamp, the registry's
 * domain (`registryDomainOf`'s answer, null when it is not the deployment's), the identity's owner
 * now, and the new wallet's code. Refused, in this order: an owner that could not be read; a domain
 * that is not the deployment's; for the provider choice, an address with no code, since a
 * provider's wallet must exist on the chain before it can sign; then the owner check of the send
 * (no identity, or an identity the connected wallet does not own). Otherwise the message for the
 * owner the registry named, valid 270 seconds from the head.
 */
export function agentWalletPrepare(p: {
  choice: AgentWalletChoice;
  agentId: string;
  newWallet: Address;
  ownerOf: OwnerRead;
  connected: Address | null;
  domain: RegistryDomain | null;
  code: Hex | undefined;
  headTimestamp: bigint;
  environment: Environment;
}): AgentWalletPrepared {
  if (p.ownerOf === "unreadable") return { ok: false, line: AW.unreadable };
  if (p.domain === null) return { ok: false, line: AW.domainMismatch };
  if (p.choice === "provider" && walletKindOf(p.code) === "key")
    return { ok: false, line: walletSignatureSentence("not_on_chain", p.environment) };
  const deadline = walletSetDeadline(p.headTimestamp);
  // A fresh deadline cannot be expired: only the identity and the wallet are asked here.
  const owner = agentWalletSendPreflight({
    ownerOf: p.ownerOf,
    connected: p.connected,
    deadline,
    nowSeconds: Number(p.headTimestamp),
  });
  if (!owner.ok)
    return {
      ok: false,
      line: walletPreflightSentence(owner.reason, { agentId: p.agentId, environment: p.environment }),
    };
  return {
    ok: true,
    domain: p.domain,
    message: { agentId: p.agentId, newWallet: p.newWallet, owner: p.ownerOf as Address, deadline },
  };
}

// ---------------------------------------------------------------------------------------------
// What a pasted signature is worth, once the chain is asked
// ---------------------------------------------------------------------------------------------

/** ERC-1271's yes: `isValidSignature(bytes32,bytes)` answers these four bytes. */
export const ERC1271_MAGIC = "0x1626ba7e";

/** A contract wallet's own check, read through the public client. */
export const erc1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
    stateMutability: "view",
  },
] as const;

/** Whether a wallet's `isValidSignature` answer is ERC-1271's yes. */
export function erc1271Accepts(answer: unknown): boolean {
  return typeof answer === "string" && answer.toLowerCase() === ERC1271_MAGIC;
}

export type AgentWalletSignatureCheck = WalletSignatureVerdict | { ok: false; problem: "unreadable" };

/**
 * What a pasted signature is worth, before the transaction is offered: the new wallet's code
 * (`walletKindOf`), then, unless it is a contract, the address the signature recovers to over the
 * message (a recovery that throws, as viem's does on a 64-byte signature, recovers to nothing);
 * then, for a contract, and for a delegated key whose recovery is not the wallet, the wallet's own
 * `isValidSignature` over the message's digest (a revert is a no). `walletSignatureVerdict`
 * decides from those. A code or an answer that could not be read is `unreadable`, never a
 * refusal: the person tries again.
 */
export async function agentWalletSignatureCheck(p: {
  newWallet: Address;
  signature: Hex;
  readCode: () => Promise<Hex | undefined>;
  recover: () => Promise<Address>;
  isValidSignature: () => Promise<unknown>;
}): Promise<AgentWalletSignatureCheck> {
  let code: Hex | undefined;
  try {
    code = await p.readCode();
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  const kind = walletKindOf(code);
  let recovered: Address | null = null;
  if (kind !== "contract") {
    try {
      recovered = await p.recover();
    } catch {
      recovered = null;
    }
  }
  let contractAccepts: boolean | null = null;
  if (kind === "contract" || (kind === "delegated" && !sameAddress(recovered, p.newWallet))) {
    try {
      contractAccepts = erc1271Accepts(await p.isValidSignature());
    } catch (e) {
      if (!isRevert(e)) return { ok: false, problem: "unreadable" };
      contractAccepts = false;
    }
  }
  return walletSignatureVerdict({
    kind,
    newWallet: p.newWallet,
    signature: p.signature,
    recovered,
    contractAccepts,
  });
}

// ---------------------------------------------------------------------------------------------
// Before any wallet prompt
// ---------------------------------------------------------------------------------------------

export type AgentWalletSendPreflight =
  | { ok: true }
  | { ok: false; reason: "no_identity" | "owner_changed" | "not_this_wallet" | "expired" };

/**
 * Before any wallet prompt, in this order: the identity's owner now (none: no identity with this
 * id); at the send, that owner against the one the message was prepared for (`preparedFor`), since
 * the signature names its owner and holds for no other (ruling R13); the wallet connected, which
 * must be that owner, in any letter case; and the time left, at least 30 whole seconds
 * (`walletSetSendable`). `nowSeconds` is the step's estimate of the chain's time
 * (`chainNowSeconds`). At preparation there is no message yet, so no `preparedFor`.
 */
export function agentWalletSendPreflight(p: {
  ownerOf: Address | "none";
  connected: Address | null;
  deadline: bigint;
  nowSeconds: number;
  preparedFor?: Address;
}): AgentWalletSendPreflight {
  if (p.ownerOf === "none") return { ok: false, reason: "no_identity" };
  if (p.preparedFor !== undefined && !sameAddress(p.ownerOf, p.preparedFor))
    return { ok: false, reason: "owner_changed" };
  if (!sameAddress(p.connected, p.ownerOf)) return { ok: false, reason: "not_this_wallet" };
  if (!walletSetSendable(p.deadline, p.nowSeconds)) return { ok: false, reason: "expired" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// The other accounts of the browser wallet
// ---------------------------------------------------------------------------------------------

/**
 * The accounts of the browser wallet connected to this site that could sign as the agent's wallet:
 * each one that is an address (`parseAgentWalletAddress`: never the zero address, never the
 * guardian's), never the identity's owner, in any letter case; each once, checksummed, in the
 * wallet's order. Empty when the wallet names no accounts (`undefined` while none is connected).
 */
export function browserAgentAccounts(
  addresses: readonly Address[] | undefined,
  guardian: Address,
  ownerOf: Address | "none",
): Address[] {
  const out: Address[] = [];
  for (const raw of addresses ?? []) {
    if (typeof raw !== "string") continue;
    const account = parseAgentWalletAddress(raw, guardian);
    if (typeof account === "object") continue;
    if (ownerOf !== "none" && sameAddress(account, ownerOf)) continue;
    if (out.some((a) => sameAddress(a, account))) continue;
    out.push(account);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What the screen shows
// ---------------------------------------------------------------------------------------------

export type AgentWalletPanel = "checking" | "unreadable" | "elsewhere" | "browser";
export type AgentWalletButton = "retry" | "check_again" | "prepare" | "send";

export type AgentWalletStepView = {
  title: string;
  /** Under the title: why the step is there and what the registry names today, or the read's line. */
  lines: string[];
  panel: AgentWalletPanel;
  /** The three choices, on the browser branch while no transaction is out; empty otherwise. */
  choices: { choice: AgentWalletChoice; title: string; line: string; chosen: boolean }[];
  /** How to make a key where the agent runs, for "My agent has no key yet". Never made here. */
  noKey: { ask: string; commandIntro: string; command: string } | null;
  addressField: boolean;
  /** The one-click way to sign, for "My agent has its own key" while its address field shows: a
   *  button per other account of the browser wallet, or how to connect one when there is none; and
   *  the wallet's no, said, with the paste field still in place. */
  otherAccounts: {
    title: string;
    how: string | null;
    accounts: { account: Address; label: string }[];
    declined: string | null;
  } | null;
  /** The ways to sign the prepared message, while it can still be sent. */
  sign: { intro: string; heading: string; ask: string; commandIntro: string; command: string } | null;
  countdown: string | null;
  signatureField: boolean;
  /** Where the step is, when it says so: the other key's part, the wallet open, the registry
   *  awaited, the message expired, a refusal. */
  status: { text: string; tone: "info" | "warn"; busy: boolean } | null;
  /** The main button: Try again, Check again, Prepare the message, or the send. */
  button: AgentWalletButton | null;
  /** A second button beside it, where two are offered: after no receipt, Prepare the message
   *  beside Check again. */
  secondButton: AgentWalletButton | null;
};

const CHOICES: readonly AgentWalletChoice[] = ["has_key", "no_key", "provider"];

function choiceWords(choice: AgentWalletChoice, environment: Environment): { title: string; line: string } {
  switch (choice) {
    case "has_key":
      return { title: AW.hasKeyTitle, line: AW.hasKeyLine };
    case "no_key":
      return { title: AW.noKeyTitle, line: AW.noKeyLine };
    case "provider":
      return {
        title: AW.providerTitle,
        line: fillCopy(AW.providerLine, { network: networkName(environment) }),
      };
  }
}

/** What the registry names today, said: the guardian's own wallet, or none. */
function todayLine(read: AgentWalletRead | null, guardian: Address): string | null {
  if (read === null || read === "unreadable") return null;
  switch (agentWalletStanding(read, guardian)) {
    case "guardians":
      return AW.todayGuardian;
    case "none":
      return AW.todayNone;
    case "own":
      return null;
  }
}

const NOTHING = {
  choices: [],
  noKey: null,
  addressField: false,
  otherAccounts: null,
  sign: null,
  countdown: null,
  signatureField: false,
  status: null,
  button: null,
  secondButton: null,
} as const satisfies Omit<AgentWalletStepView, "title" | "lines" | "panel">;

/** The one-click way's words: a button per account, or how to connect one; the decline, if any. */
function otherAccountsView(
  accounts: readonly Address[] | undefined,
  declined: boolean,
): NonNullable<AgentWalletStepView["otherAccounts"]> {
  const list = accounts ?? [];
  return {
    title: AW.otherAccountTitle,
    how: list.length === 0 ? AW.otherAccountHow : null,
    accounts: list.map((account) => ({ account, label: fillCopy(AW.otherAccountSign, { address: account }) })),
    declined: declined ? AW.otherAccountDeclined : null,
  };
}

/**
 * What the screen shows for the derivation's wallet step and branch, and the step's own stage.
 * `checking` is one line; `unreadable` the line and Try again. `needed` says why and what the
 * registry names today; on the paste branch, what the owning key must do and Check again, never a
 * field or a send; on the browser branch, the three choices, the address field once one is chosen
 * (with how to make a key for "no key yet"), the prepared message with its countdown, the signature
 * field and the send while at least 30 seconds are left, and otherwise "expired" with Prepare the
 * message. `choice` is the card chosen, as the step keeps it once the stage has moved past the
 * address; on the address stage the stage's own choice counts.
 *
 * For "My agent has its own key", wherever its address field shows: one button per account of
 * `browserAccounts` (`browserAgentAccounts`'s answer), or how to connect one when it is empty; and,
 * after the wallet declined (`accountDeclined`), that sentence, the paste field kept. After no
 * receipt, Check again with Prepare the message beside it; after the owner changed, Prepare the
 * message.
 */
export function agentWalletStepView(p: {
  walletStep: WalletStep;
  branch: OwnerBranch;
  read: AgentWalletRead | null;
  guardian: Address;
  stage: AgentWalletStage;
  secondsLeft: number | null;
  environment: Environment;
  choice?: AgentWalletChoice | null;
  browserAccounts?: readonly Address[];
  accountDeclined?: boolean;
}): AgentWalletStepView {
  const title = AW.title;
  if (p.walletStep === "checking") return { ...NOTHING, title, lines: [AW.checking], panel: "checking" };
  if (p.walletStep === "unreadable")
    return { ...NOTHING, title, lines: [AW.unreadable], panel: "unreadable", button: "retry" };

  const today = todayLine(p.read, p.guardian);
  const lines = today === null ? [AW.why] : [AW.why, today];
  if (p.branch === "paste")
    return {
      ...NOTHING,
      title,
      lines,
      panel: "elsewhere",
      status: { text: AW.elsewhere, tone: "info", busy: false },
      button: "check_again",
    };

  const base = { ...NOTHING, title, lines, panel: "browser" as const };
  const { stage } = p;
  if (stage.at === "sending")
    return { ...base, status: { text: AW.sending, tone: "info", busy: true } };
  if (stage.at === "waiting")
    return {
      ...base,
      status: { text: AW.waiting, tone: "info", busy: true },
      button: "check_again",
    };

  const chosen = stage.at === "address" ? stage.choice : stage.at === "choose" ? null : (p.choice ?? null);
  const choices = CHOICES.map((choice) => ({
    choice,
    ...choiceWords(choice, p.environment),
    chosen: choice === chosen,
  }));
  if (stage.at === "choose" || chosen === null) return { ...base, choices };

  const open = {
    ...base,
    choices,
    noKey:
      chosen === "no_key"
        ? { ask: AW.noKeyAsk, commandIntro: AW.noKeyCommandIntro, command: AW.noKeyCommand }
        : null,
    addressField: true,
    otherAccounts:
      chosen === "has_key" ? otherAccountsView(p.browserAccounts, p.accountDeclined === true) : null,
    button: "prepare" as const,
  };
  switch (stage.at) {
    case "address":
      return open;
    case "no_receipt":
      return {
        ...open,
        status: { text: walletNoReceiptLine(), tone: "warn", busy: false },
        button: "check_again",
        secondButton: "prepare",
      };
    case "reverted":
      return { ...open, status: { text: AW.reverted, tone: "warn", busy: false } };
    case "would_revert":
      return { ...open, status: { text: AW.wouldRevert, tone: "warn", busy: false } };
    case "owner_changed":
      return { ...open, status: { text: AW.ownerChanged, tone: "warn", busy: false } };
    case "message": {
      // A time not known counts as none left.
      const left = p.secondsLeft ?? 0;
      if (left < WALLET_SET_SEND_MARGIN_SECONDS)
        return { ...open, status: { text: AW.expired, tone: "warn", busy: false } };
      return {
        ...open,
        sign: {
          intro: AW.messageIntro,
          heading: AW.messageHeading,
          ask: AW.signAsk,
          commandIntro: AW.signCommandIntro,
          command: AW.signCommand,
        },
        countdown: fillCopy(AW.countdown, { seconds: String(left) }),
        signatureField: true,
        button: "send",
      };
    }
  }
}

/** The whole seconds the prepared message has left, from the step's clock (`localNowMs` of the
 *  same monotonic clock as `chainNowSeconds`); null when no message is prepared or the clock is
 *  not set. */
export function stageSecondsLeft(
  stage: AgentWalletStage,
  clock: ChainClock | null,
  localNowMs: number,
): number | null {
  if (stage.at !== "message" || clock === null) return null;
  return walletSetSecondsLeft(stage.message.deadline, chainNowSeconds(clock, localNowMs));
}

/** "This agent's wallet: {address}", on the link screens, when the registry names a wallet. */
export function agentWalletLineText(read: AgentWalletRead | null): string | null {
  if (read === null || !ADDRESS.test(read)) return null;
  return fillCopy(AW.line, { address: read });
}

// ---------------------------------------------------------------------------------------------
// A legal body that already exists
// ---------------------------------------------------------------------------------------------

/** The done page's card: the record names the guardian's own wallet, or none. */
export type DoneWalletCard = "guardian" | "none";

/**
 * The card on the done page of a legal body made before the rule, from its public record (the
 * signed statement's message, `publicRecordOf`), the order's guardian and the done derivation's
 * notice: "guardian" when the record's `agentWallet` is the guardian's own wallet, in any letter
 * case; "none" when it is the zero address; otherwise no card (the agent's own wallet, no record
 * read, or a field that is not an address). Never beside a notice (a revocation, a wind-down, a
 * dissolution, a break with no reason): the wallet step there would be noise (ruling R18). The page
 * shows it for a linked, not revoked order only.
 */
export function doneWalletCard(
  record: LegalBodyStatementJson | null,
  guardian: Address,
  notice: LegalBodyNotice | undefined,
): DoneWalletCard | null {
  if (notice) return null;
  if (record === null || !agentWalletOwed(record.agentWallet, guardian)) return null;
  return sameAddress(record.agentWallet, guardian) ? "guardian" : "none";
}

/** The step opened from the done page: its wallet step and branch, or the wallet already set. */
export type LinkedWalletState =
  | { at: "step"; walletStep: WalletStep; branch: OwnerBranch }
  | { at: "set"; line: string };

/**
 * The step in "linked" mode, for a legal body that already exists. There is no derivation to ask:
 * the step reads the registry itself (`read`, null until its first read is back), and decides as
 * the derivation decides for a draft. No read yet is checking; a read that failed, or an answer
 * that is not an address, unreadable; no wallet, the zero address or the signed-in wallet's own
 * (the guardian's), needed; any other wallet is set, and the line names it. The branch is the
 * order's identity owner against the signed-in wallet: the browser when they are the same, in any
 * letter case; otherwise (another owner, or none known) the paste branch, which opens no wallet.
 */
export function linkedWalletState(p: {
  read: AgentWalletRead | null;
  signedIn: Address;
  identityOwner: Address | null;
}): LinkedWalletState {
  const branch: OwnerBranch = sameAddress(p.identityOwner, p.signedIn) ? "browser" : "paste";
  const step = (walletStep: WalletStep): LinkedWalletState => ({ at: "step", walletStep, branch });
  const read = p.read;
  if (read === null) return step("checking");
  if (read === "none") return step("needed");
  if (read === "unreadable") return step("unreadable");
  const line = agentWalletLineText(read);
  if (line === null) return step("unreadable");
  if (agentWalletOwed(read, p.signedIn)) return step("needed");
  return { at: "set", line };
}

// ---------------------------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------------------------

/** Under the address field. An empty field is not an address either. */
export function walletAddressSentence(problem: WalletAddressProblem): string {
  return problem === "empty" ? AW.addressProblems.not_address : AW.addressProblems[problem];
}

/** A signature refused before the transaction is offered, the network named. */
export function walletSignatureSentence(
  problem: Extract<AgentWalletSignatureCheck, { ok: false }>["problem"],
  environment: Environment,
): string {
  if (problem === "unreadable") return AW.unreadable;
  return fillCopy(AW.signatureProblems[problem], { network: networkName(environment) });
}

/** The check before the wallet prompt, said. */
export function walletPreflightSentence(
  reason: Extract<AgentWalletSendPreflight, { ok: false }>["reason"],
  p: { agentId: string; environment: Environment },
): string {
  switch (reason) {
    case "no_identity":
      return fillCopy(AW.noIdentity, { agentId: p.agentId, network: networkName(p.environment) });
    case "owner_changed":
      return AW.ownerChanged;
    case "not_this_wallet":
      return AW.notThisWallet;
    case "expired":
      return AW.expired;
  }
}

/** No receipt within the wait: the minutes said are the wait's own (`REGISTER_RECEIPT_TIMEOUT_MS`),
 *  so the sentence and the timeout cannot drift apart. */
export function walletNoReceiptLine(): string {
  return fillCopy(AW.noReceipt, { minutes: String(REGISTER_RECEIPT_TIMEOUT_MS / 60_000) });
}

/** A refusal of the allowlist or of the chain check, before the wallet opened: each problem of the
 *  setAgentWallet call its own sentence, and one this page does not know named as it is. */
export function walletCallRefusalSentence(problem: string, environment: Environment): string {
  const problems: Readonly<Record<string, string>> = AW.callProblems;
  if (!Object.prototype.hasOwnProperty.call(problems, problem))
    return fillCopy(AW.callRefused, { problem });
  return fillCopy(problems[problem], { network: networkName(environment) });
}

/** The wallet said no or failed: declined, said plainly, and nothing is tried again by itself. A
 *  wallet that cannot pay the gas is told where the native USDC comes from. */
export function walletSendFailureLines(e: unknown, environment: Environment): string[] {
  return registerSendFailure(e).kind === "no_gas" ? [noGasLine(environment)] : [AW.declined];
}
