"use client";

import Link from "next/link";
import { useId, useState } from "react";
import {
  AmberPill,
  Button,
  Callout,
  Card,
  CheckIcon,
  Field,
  Spinner,
  TextInput,
} from "@/components/onboarding/primitives";
import type { GuardianIdentityState } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  GUARDIAN_NOTICE_URL,
  identityCardText,
  type AutomaticCardView,
  type IdentityCardKind,
  type IdentityCardView,
} from "@/lib/legalBody/identityCheck";

const G = LEGAL_BODY_COPY.human.guardianIdentity;
const A = G.automatic;

type Names = { firstName: string; lastName: string };

type CardProps = {
  view: Exclude<IdentityCardView, { kind: "hidden" }>;
  busy: boolean;
  /** The start answered an address and the browser is leaving for it. */
  leaving: boolean;
  problem: string | null;
  longWait: boolean;
  canCheckAgain: boolean;
  onStart(names: Names): void;
  onCheckAgain(): void;
  onRetryRead(): void;
};

/**
 * The identity record on the human step. World ID proves one real person; the identity check says
 * who. Where the check runs automatically the guardian starts it here, leaves for the provider's
 * page and comes back to the result; elsewhere an operator runs it and the card says where it
 * stands. What the card says in each state is `identityCardText`'s. No provider name, no
 * document, and never the person's name, in any state.
 */
export function GuardianIdentityCard(props: CardProps) {
  const { view } = props;
  if (view.kind === "operator")
    return <OperatorCard state={view.state} verifiedAt={view.verifiedAt} />;
  return <AutomaticCard {...props} view={view} />;
}

/* ── The check an operator runs ────────────────────────────────────────────────────────────── */

const WAITING: readonly GuardianIdentityState[] = ["pending", "needs_review", "expired"];

/** Amber while the record is not verified. */
function OperatorCard({
  state,
  verifiedAt,
}: {
  state: GuardianIdentityState;
  verifiedAt: number | null;
}) {
  const verified = state === "verified";
  const line = verified
    ? typeof verifiedAt === "number"
      ? fillCopy(G.verifiedOn, { date: formatDate(verifiedAt) })
      : G.verified
    : G[state];

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[15px] text-ink">{G.title}</p>
        {verified ? (
          <CheckIcon className="h-4 w-4 text-accent" />
        ) : WAITING.includes(state) ? (
          <AmberPill size="sm">{line}</AmberPill>
        ) : null}
      </div>
      {verified || state === "none" ? (
        <p className="mt-3 text-[13px] leading-[1.6] text-muted">{line}</p>
      ) : WAITING.includes(state) ? null : (
        <Callout tone="warn" className="mt-3">
          {line}
        </Callout>
      )}
      <ul className="mt-4 flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
        <li>{G.checked}</li>
        <li>{G.kept}</li>
        <li>{G.never}</li>
      </ul>
      <Link href="/personhood" className="mt-4 inline-block text-[12.5px] text-accent">
        {G.policy}
      </Link>
    </Card>
  );
}

/* ── The automatic check ───────────────────────────────────────────────────────────────────── */

/** The states whose sentence asks the guardian to act on something that went wrong. */
const WARN_KINDS: readonly IdentityCardKind[] = [
  "start_again",
  "expired",
  "revoked",
  "retry",
  "unreadable",
];

function AutomaticCard({
  view,
  busy,
  leaving,
  problem,
  longWait,
  canCheckAgain,
  onStart,
  onCheckAgain,
  onRetryRead,
}: CardProps & { view: AutomaticCardView }) {
  const text = identityCardText(view, { longWait, formatDate });
  const spinning = view.kind === "loading" || view.kind === "reading";

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-[15px] text-ink">{G.title}</p>
          <p className="text-[13px] leading-[1.6] text-muted">{A.why}</p>
        </div>

        {text.record && (
          <p className="flex items-center gap-2 text-[13px] text-ink">
            <CheckIcon className="h-4 w-4 shrink-0 text-accent" />
            {text.record}
          </p>
        )}

        <div aria-live="polite" className="empty:hidden">
          {text.status &&
            (WARN_KINDS.includes(view.kind) ? (
              <Callout tone="warn">{text.status}</Callout>
            ) : spinning ? (
              <p className="flex items-center gap-2 text-[13px] leading-[1.6] text-muted">
                <Spinner className="h-3.5 w-3.5 shrink-0" />
                <span>{text.status}</span>
              </p>
            ) : (
              <p className="text-[13px] leading-[1.6] text-muted">{text.status}</p>
            ))}
        </div>

        {/* Both reads at the provider wait for the server to take a new one. */}
        {view.kind === "unreadable" && (
          <div>
            <Button variant="ghost" onClick={onRetryRead} disabled={!canCheckAgain}>
              {A.retryRead}
            </Button>
          </div>
        )}
        {view.kind === "reading" && longWait && (
          <div>
            <Button variant="ghost" onClick={onCheckAgain} disabled={!canCheckAgain}>
              {A.checkAgain}
            </Button>
          </div>
        )}

        {text.notes.length > 0 && (
          <div className="flex flex-col gap-1 text-[12.5px] leading-[1.6] text-muted">
            {text.notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        )}

        {/* A new, empty form in each form state (a continue or a retry asks for the name again),
            and once the browser is leaving: the name is not left in the page. */}
        {text.form && (
          <NameForm
            key={leaving ? "left" : view.kind}
            lines={text.form.lines}
            button={text.form.button}
            busy={busy}
            onStart={onStart}
          />
        )}

        {problem && <Callout tone="warn">{problem}</Callout>}

        <ul className="flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
          <li>{A.checked}</li>
          <li>{A.kept}</li>
          <li>{A.neverHeld}</li>
        </ul>

        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[12.5px]">
          <a href={GUARDIAN_NOTICE_URL} target="_blank" rel="noreferrer" className="text-accent">
            {A.notice}
          </a>
          <Link href="/personhood" className="text-accent">
            {G.policy}
          </Link>
        </div>
      </div>
    </Card>
  );
}

/**
 * The two names, as the document prints them. They live in these two inputs' state and leave
 * only in the start's request body: never stored, never in the address.
 */
function NameForm({
  lines,
  button,
  busy,
  onStart,
}: {
  lines: string[];
  button: string;
  busy: boolean;
  onStart(names: Names): void;
}) {
  const id = useId();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onStart({ firstName, lastName });
      }}
    >
      <div className="flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={A.form.firstName} htmlFor={`${id}-first`}>
          <TextInput
            id={`${id}-first`}
            autoComplete="given-name"
            spellCheck={false}
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
          />
        </Field>
        <Field label={A.form.lastName} htmlFor={`${id}-last`}>
          <TextInput
            id={`${id}-last`}
            autoComplete="family-name"
            spellCheck={false}
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" loading={busy} disabled={busy}>
          {busy ? A.form.opening : button}
        </Button>
      </div>
    </form>
  );
}
