"use client";

import type { ReactNode } from "react";
import { fieldProblems, refusalView } from "@/lib/charterTest/refusal";

/**
 * The few shapes the test page is made of: a numbered section, a list of facts shown raw, a text
 * the server served shown under the key it was served in, and a failed call shown as served.
 * Plain on purpose: the page is a test harness, and it restyles nothing of the product.
 */

/** A step of the flow: its number and name, then what it holds. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t hairline pt-6">
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** A plain line of the page's own. */
export function Line({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-[1.6] text-muted">{children}</p>;
}

/** Values as served, each beside its key. `null` and `undefined` are written out. */
export function Facts({ rows }: { rows: readonly (readonly [string, unknown])[] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[12px]">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-2">{key}</dt>
          <dd className="break-all text-ink">{shown(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function shown(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

/** A value as JSON, as it arrived. */
export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-xl border hairline bg-paper-2/60 px-4 py-3 font-mono text-[11.5px] leading-[1.5] text-ink">
      {JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}
    </pre>
  );
}

/**
 * A text the server served, word for word, under the key it was served in. `long` keeps line
 * breaks and scrolls. A served `null` is written out, never left blank.
 */
export function Served({
  name,
  text,
  long = false,
}: {
  /** The key, and where it was served. */
  name: string;
  text: string | null;
  long?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[11.5px] text-muted-2">{name}</span>
      {text === null ? (
        <span className="font-mono text-[12px] text-ink">null</span>
      ) : long ? (
        <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-xl border hairline-strong px-4 py-3 text-[13px] leading-[1.6] text-ink">
          {text}
        </pre>
      ) : (
        <p className="rounded-xl border hairline-strong px-4 py-3 text-[13px] leading-[1.6] text-ink">
          {text}
        </p>
      )}
    </div>
  );
}

/**
 * A failed call, as served: the status and the code, the sentence, then the `{ field, problem }`
 * rows when there are any, otherwise the details whole as JSON; the list at the foot of the page
 * shows the details whole either way. Renders nothing for no error.
 */
export function Refusal({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const view = refusalView(error);
  const rows = fieldProblems(view.details);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-[#ff5f57]/45 bg-[#ff5f57]/[0.09] px-4 py-3 text-[12.5px] text-[#ff8a84]">
      <span className="font-mono">
        {view.api ? `HTTP ${view.status} ${view.code}` : "Not an answer of the API"}
      </span>
      <span>{view.message}</span>
      {rows.length > 0 && (
        <ul className="font-mono text-[11.5px]">
          {rows.map((row, i) => (
            <li key={`${row.field}:${i}`}>
              {row.field}: {row.problem}
            </li>
          ))}
        </ul>
      )}
      {view.details !== null && rows.length === 0 && <Json value={view.details} />}
    </div>
  );
}
