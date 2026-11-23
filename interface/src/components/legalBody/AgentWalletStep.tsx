"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { useConnection, usePublicClient, useSignTypedData } from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  Spinner,
  StepHeader,
  TextInput,
  Textarea,
} from "@/components/onboarding/primitives";
import { useAllowedWrite } from "@/lib/api/legalBodyHooks";
import type { Address, Hex } from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import {
  WALLET_SET_SEND_MARGIN_SECONDS,
  parseAgentWalletAddress,
  registryDomainOf,
  walletSetSendable,
  walletSetText,
  walletSetTypedData,
  type RegistryDomain,
  type WalletSetMessage,
} from "@/lib/legalBody/agentWallet";
import {
  SET_AGENT_WALLET_FUNCTION,
  agentWalletPrepare,
  agentWalletSendPreflight,
  agentWalletSignatureCheck,
  agentWalletStepView,
  browserAgentAccounts,
  chainClockAt,
  chainNowSeconds,
  erc1271Abi,
  stageSecondsLeft,
  walletAddressSentence,
  walletCallRefusalSentence,
  walletPreflightSentence,
  walletSendFailureLines,
  walletSignatureSentence,
  type AgentWalletButton,
  type AgentWalletChoice,
  type AgentWalletStage,
  type AgentWalletStepView,
  type ChainClock,
} from "@/lib/legalBody/agentWalletStep";
import { agentWalletCall, identityRegistryAbi } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { REGISTER_RECEIPT_TIMEOUT_MS, isRevert, readOwnerOf } from "@/lib/legalBody/identity";
import { stepLifetime } from "@/lib/legalBody/lifetime";
import {
  POINTER_WATCH_MS,
  parsePastedSignature,
  pointerWatchInterval,
  type SignatureProblem,
} from "@/lib/legalBody/paste";
import { pointerTxStage } from "@/lib/legalBody/pointer";
import { IdentityLine } from "./IdentityLine";
import type { LegalBodyStepKit } from "./LegalBodyFlow";
import { CopyBox, FieldRows } from "./PasteLinkPanel";

const AW = LEGAL_BODY_COPY.agentWallet;
const P = LEGAL_BODY_COPY.paste;
const I = LEGAL_BODY_COPY.identity;

/** One tick of the countdown. */
const TICK_MS = 1_000;

const BUTTON_LABELS: Record<AgentWalletButton, string> = {
  retry: AW.retry,
  check_again: AW.checkAgain,
  prepare: AW.prepare,
  send: AW.send,
};

/** The signature field's problems, said after its label as the paste panel's are. */
function signatureFieldSentence(problem: SignatureProblem): string {
  return problem === "empty" ? AW.signatureEmpty : P.problems[problem];
}

/** The prepared message and its domain, as the message stage holds them. */
type Prepared = { message: WalletSetMessage; domain: RegistryDomain };

/**
 * Your agent's wallet: the agent's own wallet, written on its identity before the link, so anyone
 * it pays can find its company.
 *
 * What it shows is `agentWalletStepView`'s answer for the derivation's wallet step and branch and
 * this step's stage. On the browser branch, three choices: the agent's own key, a key still to be
 * made where the agent runs (the page says how, and never makes one), or a provider's wallet. Then
 * the address, and "Prepare the message": the head's timestamp, the registry's domain, the
 * identity's owner and the wallet's code, read through the public client (`agentWalletPrepare`
 * refuses a provider's address with no code, and prepares nothing). Then the message to copy, the
 * two ways to sign it, a countdown from the step's estimate of the chain's time (`chainNowSeconds`),
 * and the signature field. For "My agent has its own key", each other account of the browser
 * wallet connected to this site (`browserAgentAccounts`: never the guardian, never the identity's
 * owner) is a button: a click takes it as the address, prepares the message, and asks the wallet to
 * sign it with that account; the signature fills the field, nothing more. "Write the wallet on the
 * identity" checks the signature against the chain (`agentWalletSignatureCheck`), then the owner,
 * the owner the message was prepared for, and the time (`agentWalletSendPreflight`), then
 * simulates the exact call from the owner, checks the time once more, and only then opens the
 * wallet through the one allowlist (`useAllowedWrite`). After the receipt the registry is read
 * again, and the derivation moves on to the link by itself; with no receipt in time, Check again
 * or a new message.
 *
 * On the paste branch, no field and no wallet: what the owning key must do, and the registry read
 * again every 30 seconds for two minutes, and on Check again.
 *
 * Every read, the browser wallet's signature and the one transaction are a click's, the paste
 * branch's timed reads aside; nothing is sent on mount. The address and the signature are this
 * step's state only, never stored.
 * Timers go through a lifetime that the effect's cleanup ends, and a click's continuation stops
 * after its next await once the step is gone.
 */
export function AgentWalletStep({ kit, agentId }: { kit: LegalBodyStepKit; agentId: string }) {
  const { config, tenant, derivation } = kit;
  const environment = config.environment;
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { address, addresses } = useConnection();
  const connected = (address ?? null) as Address | null;
  const send = useAllowedWrite();
  // Only ever called with the agent's account named, over the step's own message.
  const { signTypedDataAsync } = useSignTypedData();

  // On screen from the effect below, gone at its cleanup.
  const [life] = useState(() => stepLifetime());
  useEffect(() => {
    life.begin();
    return () => life.end();
  }, [life]);

  const [stage, setStage] = useState<AgentWalletStage>({ at: "choose" });
  // The card chosen, kept once the stage moves past the address.
  const [choice, setChoice] = useState<AgentWalletChoice | null>(null);
  const [addressDraft, setAddressDraft] = useState("");
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const [signatureDraft, setSignatureDraft] = useState("");
  const [signatureProblem, setSignatureProblem] = useState<string | null>(null);
  // The browser wallet did not sign with the account asked: said, and the field stays for a paste.
  const [accountDeclined, setAccountDeclined] = useState(false);
  // The sentences of the last click that did not move the step.
  const [lines, setLines] = useState<string[]>([]);
  // The head's timestamp read at preparation, and this browser's clock then; ticked once a second.
  const [clock, setClock] = useState<ChainClock | null>(null);
  const [tickMs, setTickMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  // Set and cleared inside a click: a second click before the first settles reads and sends nothing.
  const inFlight = useRef(false);

  const secondsLeft = stageSecondsLeft(stage, clock, tickMs);
  // The countdown ticks while the message can still be sent, and stops once it cannot.
  const ticking = secondsLeft !== null && secondsLeft >= WALLET_SET_SEND_MARGIN_SECONDS;
  useEffect(() => {
    if (!ticking) return;
    const countdown = stepLifetime();
    const tick = () => {
      setTickMs(Date.now());
      countdown.later(tick, TICK_MS);
    };
    countdown.later(tick, TICK_MS);
    return () => countdown.end();
  }, [ticking]);

  // The identity's owner, as far as the step knows it without a read: the registry's answer once a
  // message is prepared; before, the wallet connected, which the browser branch requires to be it.
  const ownerKnown: Address | "none" = stage.at === "message" ? stage.message.owner : (connected ?? "none");
  const browserAccounts = browserAgentAccounts(addresses, tenant, ownerKnown);

  const view = agentWalletStepView({
    walletStep: derivation.walletStep ?? "checking",
    // A branch not given is the one that opens no wallet.
    branch: derivation.branch ?? "paste",
    read: kit.agentWallet,
    guardian: tenant,
    stage,
    secondsLeft,
    environment,
    choice,
    browserAccounts,
    accountDeclined,
  });

  /** The prepared message is dropped, with its clock and any signature. */
  function dropMessage() {
    setClock(null);
    setSignatureDraft("");
    setSignatureProblem(null);
    setAccountDeclined(false);
  }

  /** Back to the address of the card chosen: the prepared message, if any, is dropped. */
  function toAddress(next: AgentWalletChoice) {
    setChoice(next);
    setStage({ at: "address", choice: next });
    dropMessage();
  }

  function choose(next: AgentWalletChoice) {
    if (inFlight.current) return;
    setLines([]);
    setAddressProblem(null);
    toAddress(next);
  }

  function editAddress(value: string) {
    setAddressDraft(value);
    setAddressProblem(null);
    // A message names its wallet: another address needs a new one.
    if (choice !== null && stage.at !== "address") toAddress(choice);
  }

  /** The four reads for this address, then the message stage; or the sentence of why not, and
   *  null. The click that calls it holds `inFlight`. */
  async function prepareFor(raw: string, chosen: AgentWalletChoice): Promise<Prepared | null> {
    setLines([]);
    setAccountDeclined(false);
    const newWallet = parseAgentWalletAddress(raw, tenant);
    if (typeof newWallet === "object") {
      setAddressProblem(walletAddressSentence(newWallet.problem));
      return null;
    }
    setAddressProblem(null);
    const client = publicClient;
    if (!client) {
      setLines([walletCallRefusalSentence("chain_not_configured", environment)]);
      return null;
    }
    // This browser's clock is read before the head is asked for, so the time the reads take
    // counts as time already spent on the message.
    const readAtMs = Date.now();
    let reads;
    try {
      reads = await Promise.all([
        client.getBlock(),
        client.readContract({
          address: config.identityRegistry,
          abi: identityRegistryAbi,
          functionName: "eip712Domain",
        }),
        client.getCode({ address: newWallet }),
        readOwnerOf(() =>
          client.readContract({
            address: config.identityRegistry,
            abi: identityRegistryAbi,
            functionName: "ownerOf",
            args: [BigInt(agentId)],
          }),
        ),
      ]);
    } catch {
      if (life.alive()) setLines([AW.unreadable]);
      return null;
    }
    if (!life.alive()) return null;
    const [head, domain, code, ownerOf] = reads;
    const prepared = agentWalletPrepare({
      choice: chosen,
      agentId,
      newWallet,
      ownerOf,
      connected,
      domain: registryDomainOf(domain, config),
      code,
      headTimestamp: head.timestamp,
      environment,
    });
    if (!prepared.ok) {
      setLines([prepared.line]);
      return null;
    }
    setClock(chainClockAt(head.timestamp, readAtMs));
    setTickMs(Date.now());
    setSignatureDraft("");
    setSignatureProblem(null);
    setTxHash(null);
    setStage({ at: "message", message: prepared.message, domain: prepared.domain });
    return { message: prepared.message, domain: prepared.domain };
  }

  /** "Prepare the message": the four reads, then the message, or the sentence of why not. */
  async function onPrepare() {
    if (inFlight.current || choice === null) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await prepareFor(addressDraft, choice);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /**
   * "Sign with {address}": that account as the address, the message prepared for it, then the
   * browser wallet asked to sign it with that account. The signature only fills the field: the send
   * parses and checks it as it would a pasted one. A refusal or an error of the wallet is said, and
   * the field stays for a paste.
   */
  async function onSignWith(account: Address) {
    if (inFlight.current || choice !== "has_key") return;
    // As if typed: a message prepared for another wallet is dropped first.
    editAddress(account);
    inFlight.current = true;
    setBusy(true);
    try {
      const prepared = await prepareFor(account, choice);
      if (prepared === null || !life.alive()) return;
      let signed: Hex;
      try {
        signed = await signTypedDataAsync({ ...walletSetTypedData(prepared.domain, prepared.message), account });
      } catch {
        if (life.alive()) setAccountDeclined(true);
        return;
      }
      if (!life.alive()) return;
      setSignatureDraft(signed);
      setSignatureProblem(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** "Write the wallet on the identity": the signature, the owner and the time, the simulation,
   *  the time again, then the wallet; then the receipt, and the registry read again. */
  async function onSend() {
    if (inFlight.current || stage.at !== "message" || clock === null) return;
    const { message, domain } = stage;
    setLines([]);
    // The view says "expired" from the new tick; nothing else happens.
    const startMs = Date.now();
    setTickMs(startMs);
    if (!walletSetSendable(message.deadline, chainNowSeconds(clock, startMs))) return;
    const signature = parsePastedSignature(signatureDraft);
    if (typeof signature === "object") {
      setSignatureProblem(signatureFieldSentence(signature.problem));
      return;
    }
    setSignatureProblem(null);
    const client = publicClient;
    if (!client) {
      setLines([walletCallRefusalSentence("chain_not_configured", environment)]);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const typed = walletSetTypedData(domain, message);
      const check = await agentWalletSignatureCheck({
        newWallet: message.newWallet,
        signature,
        readCode: () => client.getCode({ address: message.newWallet }),
        recover: () => recoverTypedDataAddress({ ...typed, signature }),
        isValidSignature: () =>
          client.readContract({
            address: message.newWallet,
            abi: erc1271Abi,
            functionName: "isValidSignature",
            args: [hashTypedData(typed), signature],
          }),
      });
      if (!life.alive()) return;
      if (!check.ok) {
        setLines([walletSignatureSentence(check.problem, environment)]);
        return;
      }

      // The identity's owner now, the wallet connected, the time left.
      const ownerOf = await readOwnerOf(() =>
        client.readContract({
          address: config.identityRegistry,
          abi: identityRegistryAbi,
          functionName: "ownerOf",
          args: [BigInt(message.agentId)],
        }),
      );
      if (!life.alive()) return;
      if (ownerOf === "unreadable") {
        setLines([AW.unreadable]);
        return;
      }
      const preflight = agentWalletSendPreflight({
        ownerOf,
        connected,
        deadline: message.deadline,
        nowSeconds: chainNowSeconds(clock, Date.now()),
        preparedFor: message.owner,
      });
      // An owner of "none" is always refused here; the second test only tells the type so.
      if (!preflight.ok || ownerOf === "none") {
        setTickMs(Date.now());
        // The signature names the owner it was made for: the message is dropped, a new one offered.
        if (!preflight.ok && preflight.reason === "owner_changed") {
          setStage({ at: "owner_changed" });
          dropMessage();
          return;
        }
        // An expired message is said by the view itself.
        if (!preflight.ok && preflight.reason !== "expired")
          setLines([walletPreflightSentence(preflight.reason, { agentId, environment })]);
        return;
      }

      // The exact call, from the owner: a revert sends nothing.
      const args = [BigInt(message.agentId), message.newWallet, message.deadline, signature] as const;
      try {
        await client.simulateContract({
          address: config.identityRegistry,
          abi: identityRegistryAbi,
          functionName: "setAgentWallet",
          args,
          account: ownerOf,
        });
      } catch (e) {
        if (!life.alive()) return;
        if (isRevert(e)) setStage({ at: "would_revert" });
        else setLines([AW.unreadable]);
        return;
      }
      if (!life.alive()) return;
      // The window once more, right before the wallet opens.
      const sendMs = Date.now();
      const nowSeconds = chainNowSeconds(clock, sendMs);
      if (!walletSetSendable(message.deadline, nowSeconds)) {
        setTickMs(sendMs);
        return;
      }

      setStage({ at: "sending" });
      let sent: Awaited<ReturnType<typeof send>>;
      try {
        sent = await send(
          agentWalletCall(config, {
            agentId: message.agentId,
            newWallet: message.newWallet,
            deadline: message.deadline,
            signature,
          }),
          { config, order: null, wallet: { agentId, guardian: tenant, nowSeconds } },
        );
      } catch (e) {
        // The wallet said no, or failed: said plainly, and nothing is tried again by itself.
        if (!life.alive()) return;
        backToMessage(message, domain);
        setLines(walletSendFailureLines(e, environment));
        return;
      }
      if (!life.alive()) return;
      if (!sent.ok) {
        backToMessage(message, domain);
        setLines([walletCallRefusalSentence(sent.problem, environment)]);
        return;
      }

      const hash = sent.hash;
      setTxHash(hash);
      setStage({ at: "waiting", hash });
      let receipt: { status?: string } | null;
      try {
        receipt = await client.waitForTransactionReceipt({ hash, timeout: REGISTER_RECEIPT_TIMEOUT_MS });
      } catch {
        receipt = null;
      }
      if (!life.alive()) return;
      const outcome = pointerTxStage(receipt);
      if (outcome === "reverted") {
        setStage({ at: "reverted" });
        return;
      }
      // The transaction may still land, or was dropped: Check again, or a new message.
      if (outcome === "no_receipt") setStage({ at: "no_receipt", hash });
      // The registry decides: once it names the wallet, the derivation moves on to the link.
      await kit.refreshAgentWallet();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** The wallet did not send: the same message again, while its time lasts. */
  function backToMessage(message: WalletSetMessage, domain: RegistryDomain) {
    setStage({ at: "message", message, domain });
    setTickMs(Date.now());
  }

  /** "Check again" and "Try again": the registry read again, a read only. */
  async function onReread() {
    if (rereading) return;
    setRereading(true);
    try {
      await kit.refreshAgentWallet();
    } finally {
      setRereading(false);
    }
  }

  /** The one button's click, as the view names it. */
  function onButton(button: AgentWalletButton) {
    switch (button) {
      case "retry":
      case "check_again":
        void onReread();
        return;
      case "prepare":
        void onPrepare();
        return;
      case "send":
        void onSend();
        return;
    }
  }

  const button = view.button;
  const secondButton = view.secondButton;
  // A read's button spins while the registry is read; the others while a click is in flight.
  const buttonLoading = button === "retry" || button === "check_again" ? rereading : busy;
  const secondLoading = secondButton === "retry" || secondButton === "check_again" ? rereading : busy;

  return (
    <div>
      <StepHeader
        eyebrow={LEGAL_BODY_COPY.rail.labels.wallet}
        title={view.title}
        intro={view.panel === "checking" || view.panel === "unreadable" ? undefined : AW.why}
      />
      <IdentityLine agentId={agentId} />

      {view.panel === "checking" && (
        <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
          <Spinner className="h-3.5 w-3.5" /> {view.lines[0]}
        </div>
      )}
      {view.panel === "unreadable" && <Callout tone="warn">{view.lines[0]}</Callout>}
      {(view.panel === "browser" || view.panel === "elsewhere") && view.lines.length > 1 && (
        <Callout tone="info" className="mb-6">
          {view.lines.slice(1).join(" ")}
        </Callout>
      )}

      {view.panel === "elsewhere" && (
        <ElsewherePanel
          view={view}
          registry={config.identityRegistry}
          agentId={agentId}
          refresh={kit.refreshAgentWallet}
        />
      )}

      {view.panel === "browser" && (
        <BrowserPanel
          view={view}
          busy={busy}
          choose={choose}
          signWith={(account) => void onSignWith(account)}
          address={
            <AddressForm
              value={addressDraft}
              problem={addressProblem}
              disabled={busy}
              onChange={editAddress}
              onSubmit={() => void onPrepare()}
            />
          }
          message={
            stage.at === "message" && view.sign ? (
              <MessagePanel
                view={view}
                text={walletSetText(stage.domain, stage.message)}
                signature={signatureDraft}
                problem={signatureProblem}
                disabled={busy}
                onSignature={(value) => {
                  setSignatureDraft(value);
                  setSignatureProblem(null);
                  setAccountDeclined(false);
                }}
              />
            ) : null
          }
          txHash={
            stage.at === "waiting" || stage.at === "no_receipt"
              ? stage.hash
              : stage.at === "reverted"
                ? txHash
                : null
          }
        />
      )}

      {lines.length > 0 && (
        <Callout tone="warn" className="mt-6">
          <span className="flex flex-col gap-2">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        </Callout>
      )}

      {button && (
        <StepNav>
          {secondButton && (
            <Button
              variant="ghost"
              onClick={() => onButton(secondButton)}
              loading={secondLoading}
              disabled={busy || rereading}
            >
              {BUTTON_LABELS[secondButton]}
            </Button>
          )}
          <Button onClick={() => onButton(button)} loading={buttonLoading}>
            {BUTTON_LABELS[button]}
          </Button>
        </StepNav>
      )}
    </div>
  );
}

/** The browser branch: the three cards, the address (and, for the agent's own key, the other
 *  accounts of the browser wallet) inside the chosen one, the message, and where the transaction
 *  is. */
function BrowserPanel({
  view,
  busy,
  choose,
  signWith,
  address,
  message,
  txHash,
}: {
  view: AgentWalletStepView;
  busy: boolean;
  choose: (choice: AgentWalletChoice) => void;
  signWith: (account: Address) => void;
  address: ReactNode;
  message: ReactNode;
  txHash: Hex | null;
}) {
  return (
    <>
      {view.choices.length > 0 && (
        <div className="flex flex-col gap-4">
          {view.choices.map((c) => (
            <ChoiceCard
              key={c.choice}
              title={c.title}
              body={c.line}
              chosen={c.chosen}
              disabled={busy}
              onChoose={() => choose(c.choice)}
            >
              {c.choice === "no_key" && view.noKey && (
                <div className="mt-5 flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
                  <p>{view.noKey.ask}</p>
                  <p>{view.noKey.commandIntro}</p>
                  <Command text={view.noKey.command} />
                </div>
              )}
              {view.addressField && address}
              {c.choice === "has_key" && view.otherAccounts && (
                <OtherAccounts other={view.otherAccounts} disabled={busy} signWith={signWith} />
              )}
            </ChoiceCard>
          ))}
        </div>
      )}

      {message}

      {view.status && (
        <Callout tone={view.status.tone} className="mt-6">
          <span className="flex flex-col gap-2">
            <span className="flex items-center gap-2">
              {view.status.busy && <Spinner className="h-3.5 w-3.5" />}
              {view.status.text}
            </span>
            {txHash && <TxLink hash={txHash} />}
          </span>
        </Callout>
      )}

      <p className="mt-6 text-[12.5px] leading-[1.6] text-muted">
        {LEGAL_BODY_COPY.wallet.neverApprove}
      </p>
    </>
  );
}

/** The address of the agent's wallet, typed. Enter prepares the message. */
function AddressForm({
  value,
  problem,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  problem: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      className="mt-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <Field label={AW.addressLabel} error={problem ?? undefined} htmlFor="legal-body-agent-wallet">
        <TextInput
          id="legal-body-agent-wallet"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={problem !== null}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={disabled}
          className="font-mono text-[12.5px]"
        />
      </Field>
    </form>
  );
}

/** The one-click way: a button per other account of the browser wallet, or how to connect one;
 *  and the wallet's no, said, the paste field kept below. */
function OtherAccounts({
  other,
  disabled,
  signWith,
}: {
  other: NonNullable<AgentWalletStepView["otherAccounts"]>;
  disabled: boolean;
  signWith: (account: Address) => void;
}) {
  return (
    <div className="mt-5 border-t hairline pt-5">
      <div className="text-[13px] font-medium text-ink">{other.title}</div>
      {other.how && <p className="mt-1 text-[12.5px] leading-[1.6] text-muted">{other.how}</p>}
      {other.accounts.length > 0 && (
        <div className="mt-3 flex flex-col items-start gap-2">
          {other.accounts.map((a) => (
            <Button
              key={a.account}
              variant="ghost"
              disabled={disabled}
              onClick={() => signWith(a.account)}
              className="max-w-full break-all font-mono text-[12px]"
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {other.declined && (
        <Callout tone="warn" className="mt-3">
          {other.declined}
        </Callout>
      )}
    </div>
  );
}

/** The prepared message to copy, the two ways to sign it, the countdown, and the signature. */
function MessagePanel({
  view,
  text,
  signature,
  problem,
  disabled,
  onSignature,
}: {
  view: AgentWalletStepView;
  text: string;
  signature: string;
  problem: string | null;
  disabled: boolean;
  onSignature: (value: string) => void;
}) {
  if (!view.sign) return null;
  return (
    <>
      <Card className="mt-6 p-6">
        <p className="mb-4 text-[13.5px] leading-[1.6] text-muted">{view.sign.intro}</p>
        <CopyBox heading={view.sign.heading} text={text} />
        <div className="mt-5 flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
          <p>{view.sign.ask}</p>
          <p>{view.sign.commandIntro}</p>
          <Command text={view.sign.command} />
        </div>
        {view.countdown && <p className="mt-4 text-[12.5px] text-muted">{view.countdown}</p>}
      </Card>

      {view.signatureField && (
        <Card className="mt-6 p-6">
          <Field
            label={AW.signatureLabel}
            hint={P.signatureHint}
            error={problem ?? undefined}
            htmlFor="legal-body-agent-wallet-signature"
          >
            <Textarea
              id="legal-body-agent-wallet-signature"
              rows={3}
              value={signature}
              invalid={problem !== null}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              disabled={disabled}
              className="break-all font-mono text-[12px]"
              onChange={(e) => onSignature(e.target.value)}
            />
          </Field>
        </Card>
      )}
    </>
  );
}

/**
 * The paste branch: what the owning key must call, and the registry read again every 30 seconds
 * for two minutes from when the panel is shown. Reads only: no field, no wallet.
 */
function ElsewherePanel({
  view,
  registry,
  agentId,
  refresh,
}: {
  view: AgentWalletStepView;
  registry: Address;
  agentId: string;
  refresh: () => Promise<void>;
}) {
  // The shell's read as it is now: a new function on each render of the shell, read when due.
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    const watch = stepLifetime();
    const startedAtMs = Date.now();
    const read = () => {
      void latest.current();
      const next = pointerWatchInterval({ startedAtMs, nowMs: Date.now(), sent: false, seen: false });
      if (next !== false) watch.later(read, next);
    };
    watch.later(read, POINTER_WATCH_MS);
    return () => watch.end();
  }, []);

  const rows = [
    { label: P.rows.to, value: registry, note: P.notes.to },
    { label: P.rows.function, value: SET_AGENT_WALLET_FUNCTION, note: null },
    { label: P.rows.agentId, value: agentId, note: null },
  ];
  return (
    <>
      {view.status && <Callout tone={view.status.tone}>{view.status.text}</Callout>}
      <Card className="mt-6 p-6">
        <SectionTitle>{P.sendFromOwner}</SectionTitle>
        <FieldRows rows={rows} />
      </Card>
    </>
  );
}

/** One of the three cards: its name and what it means; once chosen, what it needs. */
function ChoiceCard({
  title,
  body,
  chosen,
  disabled,
  onChoose,
  children,
}: {
  title: string;
  body: string;
  chosen: boolean;
  disabled: boolean;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <Card className={chosen ? "p-6 ring-1 ring-accent/40" : "p-6"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">{title}</div>
          <p className="mt-1 text-[12.5px] leading-[1.6] text-muted">{body}</p>
        </div>
        {chosen ? (
          <span className="rounded-full border hairline-strong px-2.5 py-0.5 font-mono text-[11px] text-muted">
            {I.chosen}
          </span>
        ) : (
          <Button variant="subtle" onClick={onChoose} disabled={disabled} aria-label={`${I.choose}: ${title}`}>
            {I.choose}
          </Button>
        )}
      </div>
      {chosen && children}
    </Card>
  );
}

/** A command to run where the agent runs, shown whole and selectable. */
function Command({ text }: { text: string }) {
  return (
    <code className="block select-all break-all rounded-lg border hairline bg-paper-2/60 px-3 py-2 font-mono text-[11.5px] text-ink">
      {text}
    </code>
  );
}

function TxLink({ hash }: { hash: Hex }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="break-all font-mono text-[11.5px] underline underline-offset-2"
    >
      {I.viewTransaction}: {hash}
    </a>
  );
}
