"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  Spinner,
  TextInput,
  Textarea,
} from "@/components/onboarding/primitives";
import type { Address, Hex } from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import {
  SET_AGENT_WALLET_FUNCTION,
  type AgentWalletChoice,
  type AgentWalletStepView,
} from "@/lib/legalBody/agentWalletStep";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { stepLifetime } from "@/lib/legalBody/lifetime";
import { POINTER_WATCH_MS, pointerWatchInterval } from "@/lib/legalBody/paste";
import { CopyBox, FieldRows } from "./PasteLinkPanel";

/**
 * The agent's wallet step's panels (`AgentWalletStep.tsx`): what it draws from the view it is
 * given, and nothing it decides. The browser branch's cards, address, other accounts and message;
 * the paste branch's panel, whose timed reads of the registry are the step's `refresh`. No panel
 * reads the chain, signs or sends: every click is handed back to the step.
 */

const AW = LEGAL_BODY_COPY.agentWallet;
const P = LEGAL_BODY_COPY.paste;
const I = LEGAL_BODY_COPY.identity;

/** The browser branch: the three cards, the address (and, for the agent's own key, the other
 *  accounts of the browser wallet) inside the chosen one, the message, and where the transaction
 *  is. */
export function BrowserPanel({
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
export function AddressForm({
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
export function MessagePanel({
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
export function ElsewherePanel({
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
