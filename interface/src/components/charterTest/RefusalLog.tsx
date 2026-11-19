"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { callLabel, refusalView, type RefusalView } from "@/lib/charterTest/refusal";
import { Json, Line, Section } from "./parts";

type Entry = { id: number; at: string; call: string; view: RefusalView };

/** The most failures kept on screen. */
const KEPT = 50;

/**
 * Every failed call of the page, newest first, as served.
 *
 * Every API call and every wallet request of the page, its own and the ones of the hooks it
 * shares with the product, runs through the one query client. This listens to that client and
 * lists each query and each mutation that ended in an error, so a refusal is on screen even where
 * a shared hook keeps only its sentence. A failure that is not a call (the World ID widget's own
 * error, a sign-in stopped before its first request) is shown beside its card only. A call is
 * named by the first parts of its key (`callLabel`), which never hold a token.
 *
 * The one effect subscribes and unsubscribes; the list changes only when the client reports.
 */
export function RefusalLog() {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<Entry[]>([]);
  // Kept across the effect's runs, so an entry's id is never given twice.
  const nextId = useRef(0);

  useEffect(() => {
    const add = (key: unknown, error: unknown) => {
      const entry: Entry = {
        id: nextId.current++,
        at: new Date().toISOString().slice(11, 19),
        call: callLabel(key),
        view: refusalView(error),
      };
      setEntries((list) => [entry, ...list].slice(0, KEPT));
    };
    const offQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error")
        add(event.query.queryKey, event.action.error);
    });
    const offMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error")
        add(event.mutation.options.mutationKey ?? ["mutation (no key)"], event.action.error);
    });
    return () => {
      offQueries();
      offMutations();
    };
  }, [queryClient]);

  return (
    <Section title="Refusals and failures, newest first">
      {entries.length === 0 ? (
        <Line>None yet.</Line>
      ) : (
        <ol className="flex flex-col gap-3">
          {entries.map(({ id, at, call, view }) => (
            <li key={id} className="flex flex-col gap-1 font-mono text-[12px] text-ink">
              <span>
                {at} UTC {call}: {view.api ? `HTTP ${view.status} ${view.code}` : "not an answer of the API"}
              </span>
              <span className="font-sans text-[12.5px] text-muted">{view.message}</span>
              {view.details !== null && <Json value={view.details} />}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
