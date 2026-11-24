"use client";

import { useEffect, useRef, useState } from "react";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { useConnection, usePublicClient, useSignTypedData } from "wagmi";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Spinner, StepHeader } from "@/components/onboarding/primitives";
import { useAllowedWrite } from "@/lib/api/legalBodyHooks";
import type { Address, Hex } from "@/lib/api/types";
import {
  WALLET_SET_SEND_MARGIN_SECONDS,
  parseAgentWalletAddress,
  parseAgentWalletSignature,
  readAgentWallet,
  registryDomainOf,
  walletSetSendable,
  walletSetText,
  walletSetTypedData,
  type AgentWalletRead,
  type RegistryDomain,
  type WalletSetMessage,
} from "@/lib/legalBody/agentWallet";
import {
  agentWalletPrepare,
  agentWalletSendPreflight,
  agentWalletSignatureCheck,
  agentWalletStepView,
  browserAgentAccounts,
  chainClockAt,
  chainNowSeconds,
  erc1271Abi,
  linkedWalletState,
  stageSecondsLeft,
  walletAddressSentence,
  walletCallRefusalSentence,
  walletPreflightSentence,
  walletSendFailureLines,
  walletSignatureSentence,
  type AgentWalletButton,
  type AgentWalletChoice,
  type AgentWalletStage,
  type ChainClock,
} from "@/lib/legalBody/agentWalletStep";
import { agentWalletCall, identityRegistryAbi } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { REGISTER_RECEIPT_TIMEOUT_MS, isRevert, readOwnerOf } from "@/lib/legalBody/identity";
import { stepLifetime } from "@/lib/legalBody/lifetime";
import type { SignatureProblem } from "@/lib/legalBody/paste";
import { pointerTxStage } from "@/lib/legalBody/pointer";
import { AddressForm, BrowserPanel, ElsewherePanel, MessagePanel } from "./AgentWalletPanels";
import { IdentityLine } from "./IdentityLine";
import type { LegalBodyStepKit } from "./LegalBodyFlow";

const AW = LEGAL_BODY_COPY.agentWallet;
const P = LEGAL_BODY_COPY.paste;

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
 * step's state only, never stored. The panels it draws live in `AgentWalletPanels.tsx`, the paste
 * branch's timer among them, which calls this step's read; every read, the signature and the send
 * are this file's.
 * Timers go through a lifetime that the effect's cleanup ends, and a click's continuation stops
 * after its next await once the step is gone.
 *
 * `mode` "linked" is the same step for a legal body that already exists, opened in place from its
 * done page's card: there is no derivation to follow, so the step reads the registry itself
 * (`getAgentWallet`) through the public client, once as it opens (the person has just clicked the
 * card) and then again on a click, the paste branch's timed reads and the read after the
 * transaction. `linkedWalletState` decides from that read, and takes the branch from the order's
 * identity owner against the signed-in wallet; once the registry names a wallet of the agent's own,
 * the step says it (`agentWallet.line`). The guardian is still the signed-in wallet everywhere,
 * the allowlist's context included. "draft", the default, is the step as the flow shows it.
 */
export function AgentWalletStep({
  kit,
  agentId,
  mode = "draft",
}: {
  kit: LegalBodyStepKit;
  agentId: string;
  mode?: "draft" | "linked";
}) {
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

  const linked = mode === "linked";
  // "linked" only: the registry's answer for this identity, as this step last read it; null until
  // its first read is back. A draft's is the shell's (`kit.agentWallet`).
  const [linkedRead, setLinkedRead] = useState<AgentWalletRead | null>(null);

  /** "linked" only: `getAgentWallet(agentId)` through the public client. A read that fails, or
   *  no client, is unreadable, never "no wallet". */
  async function readLinkedWallet() {
    const client = publicClient;
    const read = await readAgentWallet(() => {
      if (!client) throw new Error("no public client");
      return client.readContract({
        address: config.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [BigInt(agentId)],
      });
    });
    if (life.alive()) setLinkedRead(read);
  }

  /** The registry read again, a read only: the shell's for a draft, this step's own when linked. */
  const refresh = linked ? readLinkedWallet : kit.refreshAgentWallet;

  // "linked": the person opened this step by clicking the done page's card, so a first read as the
  // step opens is that click's read. It runs once (StrictMode's second run included); every later
  // read is a click's, the paste branch's timed one, or the one after the transaction. A draft
  // reads nothing here: the shell reads its wallet.
  const openingRead = useRef(readLinkedWallet);
  useEffect(() => {
    openingRead.current = readLinkedWallet;
  });
  const opened = useRef(false);
  useEffect(() => {
    if (mode !== "linked" || opened.current) return;
    opened.current = true;
    void openingRead.current();
  }, [mode]);

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
  // The head's timestamp read at preparation, and this browser's monotonic clock then
  // (`performance.now()`, as every time below that the estimate is measured with); ticked once a
  // second. A wall clock set back would hold the countdown still.
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
      setTickMs(performance.now());
      countdown.later(tick, TICK_MS);
    };
    countdown.later(tick, TICK_MS);
    return () => countdown.end();
  }, [ticking]);

  // The identity's owner, as far as the step knows it without a read: the registry's answer once a
  // message is prepared; before, the wallet connected, which the browser branch requires to be it.
  const ownerKnown: Address | "none" = stage.at === "message" ? stage.message.owner : (connected ?? "none");
  const browserAccounts = browserAgentAccounts(addresses, tenant, ownerKnown);

  // "linked": the step's own read decides, as the derivation decides for a draft. Once the wallet
  // is set the step shows only its line (below), whatever the view would say.
  const linkedState = linked
    ? linkedWalletState({
        read: linkedRead,
        signedIn: tenant,
        identityOwner: kit.order?.identityOwner ?? null,
      })
    : null;
  const linkedStep = linkedState?.at === "step" ? linkedState : null;

  const view = agentWalletStepView({
    walletStep: linkedStep ? linkedStep.walletStep : (derivation.walletStep ?? "checking"),
    // A branch not given is the one that opens no wallet.
    branch: linkedStep ? linkedStep.branch : (derivation.branch ?? "paste"),
    read: linked ? linkedRead : kit.agentWallet,
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
    // This browser's monotonic clock is read before the head is asked for, so the time the reads
    // take counts as time already spent on the message.
    const readAtMs = performance.now();
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
    setTickMs(performance.now());
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
    const startMs = performance.now();
    setTickMs(startMs);
    if (!walletSetSendable(message.deadline, chainNowSeconds(clock, startMs))) return;
    const signature = parseAgentWalletSignature(signatureDraft);
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
        nowSeconds: chainNowSeconds(clock, performance.now()),
        preparedFor: message.owner,
      });
      // An owner of "none" is always refused here; the second test only tells the type so.
      if (!preflight.ok || ownerOf === "none") {
        setTickMs(performance.now());
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
      const sendMs = performance.now();
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
      // The registry decides: once it names the wallet, the derivation moves on to the link (a
      // linked body's step says the wallet instead).
      await refresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** The wallet did not send: the same message again, while its time lasts. */
  function backToMessage(message: WalletSetMessage, domain: RegistryDomain) {
    setStage({ at: "message", message, domain });
    setTickMs(performance.now());
  }

  /** "Check again" and "Try again": the registry read again, a read only. */
  async function onReread() {
    if (rereading) return;
    setRereading(true);
    try {
      await refresh();
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

  // "linked": the registry names a wallet of the agent's own now. Nothing more to do here.
  if (linkedState?.at === "set")
    return (
      <div>
        <StepHeader eyebrow={LEGAL_BODY_COPY.rail.labels.wallet} title={view.title} />
        <IdentityLine agentId={agentId} />
        <Callout tone="info">
          <span className="break-all font-mono text-[12.5px]">{linkedState.line}</span>
        </Callout>
      </div>
    );

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
          refresh={refresh}
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
