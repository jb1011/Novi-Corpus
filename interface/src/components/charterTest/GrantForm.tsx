"use client";

import type { ReactNode } from "react";
import {
  ABOVE_VALUES,
  ACT_LINES,
  COUNTERPARTY_VALUES,
  FIXED_RULES,
  HEAVY_ACTS,
  type Above,
  type ActKey,
  type ActLineKind,
  type ActLineState,
  type Counterparties,
  type GrantFormState,
  type HeavyAct,
  type HeavyLineState,
  type HeavyMode,
  type ServedGrantForm,
} from "@/lib/charterTest/grantForm";
import type { FieldProblem } from "@/lib/charterTest/refusal";
import { Served } from "./parts";

/**
 * The grant form of the test page, drawn from the served form and the form's state. It holds no
 * state and sends nothing: every change goes to `onChange`, and the page decides what is sent.
 *
 * Every line is named by its key in the grant and every setting by its value in the grant, so the
 * form says nothing of its own about what a choice means. The notice comes first, as served,
 * under its served key, and a served `null` is written out. The settings offered for the four acts
 * of `heavyActs` are the served ones, in the served order, and an act's amount is drawn only where
 * `alone` is among them. The three rules of the schema that never vary stand beside their lines,
 * in the words the server answers when one is broken. A problem the server answered is shown
 * under the line it names.
 *
 * Nothing is filled in: no control has a placeholder or a starting value of the page's, and the
 * settings that have no "not allowed" (`above`, `counterparties`, the end) start not chosen.
 */
export function GrantForm({
  form,
  state,
  onChange,
  problems,
  disabled = false,
}: {
  form: ServedGrantForm;
  state: GrantFormState;
  onChange: (next: GrantFormState) => void;
  /** The `{ field, problem }` rows of the server's last refusal of these choices. */
  problems: readonly FieldProblem[];
  disabled?: boolean;
}) {
  const setAct = (key: ActKey, patch: Partial<ActLineState>) =>
    onChange({ ...state, acts: { ...state.acts, [key]: { ...state.acts[key], ...patch } } });
  const setHeavy = (act: HeavyAct, patch: Partial<HeavyLineState>) =>
    onChange({
      ...state,
      heavyActs: { ...state.heavyActs, [act]: { ...state.heavyActs[act], ...patch } },
    });

  return (
    <div className="flex flex-col gap-6 text-[13px] text-ink">
      <Served name="notice (served with the grant form)" text={form.notice} />

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[12px] text-muted">
        <dt>schema</dt>
        <dd>{form.schema}</dd>
        <dt>text</dt>
        <dd>
          {form.text.id} {form.text.version} ({form.text.status})
        </dd>
        <dt>amountMax</dt>
        <dd>{String(form.amountMax)}</dd>
      </dl>
      <p className="text-[12.5px] text-muted">
        An amount is a whole number of US dollars, from 1 to amountMax.
      </p>

      <Group name="acts">
        {ACT_LINES.map(({ key, kind }) => (
          <ActLine
            key={key}
            name={key}
            kind={kind}
            line={state.acts[key]}
            onChange={(patch) => setAct(key, patch)}
            problems={problemsUnder(problems, `acts.${key}`)}
            disabled={disabled}
          />
        ))}
      </Group>

      <Group name="heavyActs">
        {HEAVY_ACTS.map((act) => (
          <HeavyLine
            key={act}
            name={act}
            modes={form.heavyActModes[act]}
            line={state.heavyActs[act]}
            onChange={(patch) => setHeavy(act, patch)}
            problems={problemsUnder(problems, `heavyActs.${act}`)}
            disabled={disabled}
          />
        ))}
      </Group>

      <Group name="counterparties">
        <Line>
          <Labelled label="counterparties">
            <select
              aria-label="counterparties"
              className={CONTROL}
              value={state.counterparties}
              disabled={disabled}
              onChange={(e) =>
                onChange({ ...state, counterparties: e.target.value as "" | Counterparties })
              }
            >
              <option value="">{NOT_CHOSEN}</option>
              {COUNTERPARTY_VALUES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labelled>
          <Problems rows={problemsUnder(problems, "counterparties")} />
        </Line>
      </Group>

      <Group name="endsOn">
        <Line>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 font-mono text-[12px]">
              <input
                type="radio"
                name="charter-test-ends"
                aria-label="endsOn: null"
                checked={state.ends === "none"}
                disabled={disabled}
                onChange={() => onChange({ ...state, ends: "none" })}
              />
              endsOn: null
            </label>
            <label className="flex items-center gap-2 font-mono text-[12px]">
              <input
                type="radio"
                name="charter-test-ends"
                aria-label="endsOn: a date"
                checked={state.ends === "date"}
                disabled={disabled}
                onChange={() => onChange({ ...state, ends: "date" })}
              />
              endsOn: a date, written YYYY-MM-DD
            </label>
            <input
              type="text"
              aria-label="endsOn date"
              className={CONTROL}
              value={state.endsOn}
              disabled={disabled || state.ends !== "date"}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onChange({ ...state, endsOn: e.target.value })}
            />
          </div>
          <Rule field="endsOn">{FIXED_RULES.endsOn}</Rule>
          <Problems rows={problemsUnder(problems, "endsOn")} />
        </Line>
      </Group>
    </div>
  );
}

const NOT_CHOSEN = "(not chosen)";
const CONTROL =
  "rounded-lg border hairline-strong bg-paper-2/80 px-2.5 py-1.5 font-mono text-[12px] text-ink disabled:opacity-45";

/** The problems of `field` itself and of every field under it. */
function problemsUnder(problems: readonly FieldProblem[], field: string): FieldProblem[] {
  return problems.filter((p) => p.field === field || p.field.startsWith(`${field}.`));
}

function Group({ name, children }: { name: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border hairline px-4 py-3">
      <legend className="px-1 font-mono text-[12px] text-muted-2">{name}</legend>
      {children}
    </fieldset>
  );
}

function Line({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5 border-b hairline pb-3 last:border-b-0 last:pb-0">{children}</div>;
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 font-mono text-[12px] text-muted">
      {label}
      {children}
    </label>
  );
}

/** One of the schema's fixed rules, beside its line: the field, then the server's words. */
function Rule({ field, children }: { field: string; children: string }) {
  return (
    <p className="font-mono text-[11.5px] text-muted-2">
      Rule: {field} {children}
    </p>
  );
}

function Problems({ rows }: { rows: readonly FieldProblem[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-[#ff8a84]">
      {rows.map((row, i) => (
        <li key={`${row.field}:${i}`}>
          {row.field}: {row.problem}
        </li>
      ))}
    </ul>
  );
}

function Amount({
  label,
  field,
  value,
  disabled,
  onChange,
}: {
  label: string;
  field: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Labelled label={label}>
      <input
        type="text"
        inputMode="numeric"
        aria-label={field}
        className={`${CONTROL} w-36`}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </Labelled>
  );
}

function ActLine({
  name,
  kind,
  line,
  onChange,
  problems,
  disabled,
}: {
  name: ActKey;
  kind: ActLineKind;
  line: ActLineState;
  onChange: (patch: Partial<ActLineState>) => void;
  problems: readonly FieldProblem[];
  disabled: boolean;
}) {
  const field = `acts.${name}`;
  const off = disabled || !line.allowed;
  return (
    <Line>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="w-44 font-mono text-[12.5px] text-ink">{field}</span>
        <label className="flex items-center gap-2 font-mono text-[12px] text-muted">
          <input
            type="checkbox"
            aria-label={`${field}.allowed`}
            checked={line.allowed}
            disabled={disabled}
            onChange={(e) => onChange({ allowed: e.target.checked })}
          />
          allowed
        </label>
        {kind !== "flag" && (
          <Amount
            label="perAct"
            field={`${field}.perAct`}
            value={line.perAct}
            disabled={off}
            onChange={(perAct) => onChange({ perAct })}
          />
        )}
        {kind === "spend" && (
          <Amount
            label="per30Days"
            field={`${field}.per30Days`}
            value={line.per30Days}
            disabled={off}
            onChange={(per30Days) => onChange({ per30Days })}
          />
        )}
        {kind !== "flag" && (
          <Labelled label="above">
            <select
              aria-label={`${field}.above`}
              className={CONTROL}
              value={line.above}
              disabled={off}
              onChange={(e) => onChange({ above: e.target.value as "" | Above })}
            >
              <option value="">{NOT_CHOSEN}</option>
              {ABOVE_VALUES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Labelled>
        )}
      </div>
      {name === "receivePayment" && (
        <Rule field={`${field}.allowed`}>{FIXED_RULES.receivePayment}</Rule>
      )}
      {kind === "spend" && <Rule field={`${field}.per30Days`}>{FIXED_RULES.per30Days}</Rule>}
      <Problems rows={problems} />
    </Line>
  );
}

function HeavyLine({
  name,
  modes,
  line,
  onChange,
  problems,
  disabled,
}: {
  name: HeavyAct;
  /** The settings the server offers for this act, in its order. */
  modes: readonly HeavyMode[];
  line: HeavyLineState;
  onChange: (patch: Partial<HeavyLineState>) => void;
  problems: readonly FieldProblem[];
  disabled: boolean;
}) {
  const field = `heavyActs.${name}`;
  return (
    <Line>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="w-44 font-mono text-[12.5px] text-ink">{field}</span>
        <Labelled label="mode">
          <select
            aria-label={`${field}.mode`}
            className={CONTROL}
            value={line.mode}
            disabled={disabled}
            onChange={(e) => onChange({ mode: e.target.value as HeavyMode })}
          >
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </Labelled>
        {modes.includes("alone") && (
          <Amount
            label="perAct"
            field={`${field}.perAct`}
            value={line.perAct}
            disabled={disabled || line.mode !== "alone"}
            onChange={(perAct) => onChange({ perAct })}
          />
        )}
      </div>
      <Problems rows={problems} />
    </Line>
  );
}
