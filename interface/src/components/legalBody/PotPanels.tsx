"use client";

import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  Spinner,
  TextInput,
} from "@/components/onboarding/primitives";
import type { Hex } from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { PotCardShown, PotFormMoney, PotProblemThen } from "@/lib/legalBody/safePotRun";
import type { PotForm, PotFormCheck } from "@/lib/legalBody/safePotStep";

/**
 * The company's pot's panels (`PotStep.tsx` and the done page's card): what they draw from the
 * values they are given, and nothing they decide. No panel reads the chain or the server, signs or
 * sends: every click is handed back to the step. Every word is the `pot` section's.
 */

const POT = LEGAL_BODY_COPY.pot;

/** Lines, each a paragraph of its own. */
function Lines({ lines, className }: { lines: readonly string[]; className?: string }) {
  return (
    <span className={className ?? "flex flex-col gap-2"}>
      {lines.map((line, i) => (
        <span key={`${i}:${line}`} className="block break-words">
          {line}
        </span>
      ))}
    </span>
  );
}

/** The done page's pot card: the offer (the whole card is the button that opens the step), the
 *  read in progress, a read that failed with its retry, or the pot as read. */
export function PotCardView({
  shown,
  onOpen,
  onRetry,
  retrying,
}: {
  shown: Exclude<PotCardShown, { kind: "hidden" }>;
  onOpen: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  switch (shown.kind) {
    case "offer":
      return (
        <Card className="mb-6 overflow-hidden">
          <button
            type="button"
            onClick={onOpen}
            className="block w-full cursor-pointer px-6 py-5 text-left transition-colors hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <span className="block text-[14px] font-medium text-ink">{POT.cardTitle}</span>
            <span className="mt-1 block text-[13px] leading-[1.6] text-muted">{POT.cardLine}</span>
          </button>
        </Card>
      );
    case "checking":
      return (
        <Card className="mb-6 px-6 py-5">
          <div className="text-[14px] font-medium text-ink">{POT.cardTitle}</div>
          <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
            <Spinner className="h-3.5 w-3.5" /> {POT.checking}
          </div>
        </Card>
      );
    case "unreadable":
      return (
        <Card className="mb-6 px-6 py-5">
          <div className="text-[14px] font-medium text-ink">{POT.title}</div>
          <p className="mt-2 text-[13px] leading-[1.6] text-muted">{POT.recordUnavailable}</p>
          <div className="mt-4">
            <Button variant="ghost" onClick={onRetry} loading={retrying}>
              {POT.retry}
            </Button>
          </div>
        </Card>
      );
    case "manage":
      return (
        <Card className="mb-6 p-6">
          <SectionTitle>{POT.title}</SectionTitle>
          <Lines
            lines={shown.lines}
            className="mt-3 flex flex-col gap-1.5 break-all text-[13px] leading-[1.6] text-muted"
          />
        </Card>
      );
  }
}

/** A sentence in place of the form: the grant that could not be read (with its retry), or the
 *  grant that allows no spending. */
export function PotNotice({
  line,
  tone,
  onRetry,
  retrying = false,
}: {
  line: string;
  tone: "info" | "warn";
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div>
      <Callout tone={tone}>{line}</Callout>
      {onRetry && (
        <div className="mt-4">
          <Button variant="ghost" onClick={onRetry} loading={retrying}>
            {POT.retry}
          </Button>
        </div>
      )}
    </div>
  );
}

type FieldProblems = Omit<Extract<PotFormCheck, { ok: false }>, "ok">;

/**
 * The setup's form: what the pot is, its periods and its limits; the ceiling (EMPTY unless the
 * step put the noted pot's own in it) with the grant's cap beside it, never in it; the pot's money
 * with its line and "keep little"; the fee money for a plain key, or the line that takes its place;
 * the money's absence for the noted pot made for another key; no recovery; the grant's last day.
 * Enter, like Review, hands the click to the step.
 */
export function PotFormPanel({
  network,
  form,
  problems,
  money,
  ceilingHint,
  grantLines,
  lines,
  busy,
  onChange,
  onReview,
}: {
  network: string;
  form: PotForm;
  problems: FieldProblems | null;
  money: PotFormMoney;
  ceilingHint: string;
  grantLines: readonly string[];
  /** The last click's sentences. */
  lines: readonly string[];
  busy: boolean;
  onChange: (field: keyof PotForm, value: string) => void;
  onReview: () => void;
}) {
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) onReview();
      }}
    >
      <div className="flex flex-col gap-3 text-[13px] leading-[1.6] text-muted">
        <p>{fillCopy(POT.what, { network })}</p>
        <p>{POT.periods}</p>
        <p>{POT.limits}</p>
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <div>
          <Field label={POT.ceilingLabel} error={problems?.ceiling} htmlFor="legal-body-pot-ceiling">
            <TextInput
              id="legal-body-pot-ceiling"
              value={form.ceiling}
              onChange={(e) => onChange("ceiling", e.target.value)}
              invalid={problems?.ceiling !== undefined}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </Field>
          <p className="mt-1.5 text-[12px] leading-[1.6] text-muted-2">{ceilingHint}</p>
        </div>

        {money.fields !== "none" && (
          <div>
            <Field label={POT.fundLabel} error={problems?.fund} htmlFor="legal-body-pot-fund">
              <TextInput
                id="legal-body-pot-fund"
                value={form.fund}
                onChange={(e) => onChange("fund", e.target.value)}
                invalid={problems?.fund !== undefined}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </Field>
            <p className="mt-1.5 text-[12px] leading-[1.6] text-muted-2">{POT.fundLine}</p>
            <p className="mt-1 text-[12px] leading-[1.6] text-muted-2">{POT.keepLittle}</p>
          </div>
        )}

        {money.fields === "key" ? (
          <div>
            <Field label={POT.gasLabel} error={problems?.agentGas} htmlFor="legal-body-pot-gas">
              <TextInput
                id="legal-body-pot-gas"
                value={form.agentGas}
                onChange={(e) => onChange("agentGas", e.target.value)}
                invalid={problems?.agentGas !== undefined}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </Field>
            <Lines lines={money.lines} className="mt-1.5 flex flex-col gap-1 text-[12px] leading-[1.6] text-muted-2" />
          </div>
        ) : (
          <Callout tone="info">
            <Lines lines={money.lines} />
          </Callout>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
        <p>{POT.noRecovery}</p>
        {grantLines.map((line, i) => (
          <p key={`${i}:${line}`}>{line}</p>
        ))}
      </div>

      {lines.length > 0 && (
        <Callout tone="warn" className="mt-6">
          <Lines lines={lines} />
        </Callout>
      )}

      <div className="mt-6 flex justify-end">
        <Button type="submit" loading={busy}>
          {POT.review}
        </Button>
      </div>
    </form>
  );
}

/**
 * The review: every line of the plan, a line for a wallet that takes no fee money, then the
 * declaration's tick box, unticked until the guardian ticks it. "Create the pot" stays disabled,
 * with `declarationNeeded` beside it, until it is ticked; "Change something" goes back to the form.
 */
export function PotReviewPanel({
  lines,
  note,
  declared,
  busy,
  problems,
  onDeclared,
  onCreate,
  onBack,
}: {
  lines: readonly string[];
  note: string | null;
  declared: boolean;
  busy: boolean;
  /** The last click's sentences. */
  problems: readonly string[];
  onDeclared: (declared: boolean) => void;
  onCreate: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <SectionTitle>{POT.reviewTitle}</SectionTitle>
      <ul className="mt-3 flex flex-col gap-2 text-[13px] leading-[1.6] text-ink">
        {lines.map((line, i) => (
          <li key={`${i}:${line}`} className="break-words">
            {line}
          </li>
        ))}
      </ul>
      {note && (
        <Callout tone="info" className="mt-4">
          {note}
        </Callout>
      )}

      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border hairline bg-paper/40 px-4 py-3 text-[13px] leading-[1.6] text-ink">
        <input
          type="checkbox"
          checked={declared}
          disabled={busy}
          onChange={(e) => onDeclared(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0"
        />
        <span>{POT.declaration}</span>
      </label>

      {problems.length > 0 && (
        <Callout tone="warn" className="mt-6">
          <Lines lines={problems} />
        </Callout>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        {!declared && <span className="text-[12.5px] text-muted-2">{POT.declarationNeeded}</span>}
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {POT.back}
        </Button>
        <Button onClick={onCreate} disabled={!declared} loading={busy}>
          {POT.create}
        </Button>
      </div>
    </div>
  );
}

/** While the wallet is open, or the chain is awaited: the sentence, and where the transaction is. */
export function PotStatusPanel({ text, hash }: { text: string; hash: Hex | null }) {
  return (
    <Callout tone="info">
      <span className="flex flex-col gap-2">
        <span className="flex items-center gap-2">
          <Spinner className="h-3.5 w-3.5" />
          {text}
        </span>
        {hash && <TxLink hash={hash} />}
      </span>
    </Callout>
  );
}

/**
 * After the setup, the pot as the chain shows it. A pot that reads its ceiling, the plan's: "The
 * pot exists" and the lines. Any other reading (the allowance off, another ceiling, a pot this page
 * does not read past) is a warning in the reading's own sentences, and nothing else is offered:
 * the page never shows a pot as working without having read its ceiling.
 */
export function PotCreatedPanel({ ok, lines }: { ok: boolean; lines: readonly string[] }) {
  if (!ok)
    return (
      <Callout tone="warn">
        <Lines lines={lines} />
      </Callout>
    );
  return (
    <Callout tone="info" title={POT.created}>
      <Lines lines={lines} className="mt-1 flex flex-col gap-1.5 break-all" />
    </Callout>
  );
}

/** A problem: its sentences, where the transaction is when there is one, and what it offers:
 *  Check again, Change something, or nothing. */
export function PotProblemPanel({
  lines,
  hash,
  then,
  busy,
  onCheckAgain,
  onBack,
}: {
  lines: readonly string[];
  hash: Hex | null;
  then: PotProblemThen;
  busy: boolean;
  onCheckAgain: () => void;
  onBack: () => void;
}) {
  return (
    <div>
      <Callout tone="warn">
        <span className="flex flex-col gap-2">
          <Lines lines={lines} />
          {hash && <TxLink hash={hash} />}
        </span>
      </Callout>
      {then !== "none" && (
        <div className="mt-6 flex justify-end">
          {then === "check_again" ? (
            <Button onClick={onCheckAgain} loading={busy}>
              {POT.checkAgain}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onBack} disabled={busy}>
              {POT.back}
            </Button>
          )}
        </div>
      )}
    </div>
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
      {POT.viewTransaction}: {hash}
    </a>
  );
}
