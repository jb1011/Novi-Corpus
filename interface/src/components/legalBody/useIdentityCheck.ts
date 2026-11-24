"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthToken } from "@/lib/api/hooks";
import { apiKeys } from "@/lib/api/keys";
import {
  useIdentityCheckSessionQuery,
  useInvalidateIdentity,
  useStartIdentityCheckMutation,
  useSyncIdentityCheckMutation,
} from "@/lib/api/legalBodyHooks";
import type { GuardianIdentityView } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  READ_POLL_MS,
  SYNC_MIN_INTERVAL_MS,
  identityCardView,
  providerPageUrl,
  readingStep,
  shouldReadBack,
  startRefusal,
  syncRefusal,
  typedNames,
  type Arrival,
  type IdentityCardView,
  type IdentityReturnPath,
  type SessionRead,
} from "@/lib/legalBody/identityCheck";

const A = LEGAL_BODY_COPY.human.guardianIdentity.automatic;

/** A read at the provider, as it settled. */
type SyncResult = { ok: true } | { ok: false; error: unknown };

/** The read-back is done on an answer, and on a refusal that counts as one (a read a moment
 *  ago); any other refusal leaves the check unread. */
const arrivalOf = (result: SyncResult): Arrival =>
  result.ok || syncRefusal(result.error).counted ? "done" : "failed";

/**
 * The identity check card's state and its three clicks. The card's state is `identityCardView`'s,
 * over the two reads (`/world-id/me`'s identity block, passed in, and the open session, read
 * here); every timing is `readingStep`'s and the constants beside it.
 *
 * One write is not a click: the read-back. When the session first reads open and not held, the
 * hook reads it back from the provider once per mount (`POST /identity-check/sync`). It continues
 * the Start click that sent the person away, whichever way they came back, and the server keeps
 * one row at most. Until it settles the card says it is reading the check, never the continue
 * form. A session with nothing to read back is `"done"` from the first render.
 *
 * While the provider is processing, a timer does what `readingStep` says every `READ_POLL_MS`,
 * for a bounded window; then the card offers Check again. A read at the provider is never sent
 * while one is in flight, nor within `SYNC_MIN_INTERVAL_MS` of the last for a click.
 *
 * The typed names pass through `start` into the one request body: never stored, never in a key.
 * The browser goes to the provider only by `window.location.assign` of the `https:` address the
 * start answered.
 */
export function useIdentityCheck(p: {
  identity: GuardianIdentityView | null | undefined;
  worldAccepted: boolean;
  returnPath: IdentityReturnPath;
}): {
  view: IdentityCardView;
  busy: boolean;
  problem: string | null;
  longWait: boolean;
  canCheckAgain: boolean;
  start(names: { firstName: string; lastName: string }): void;
  checkAgain(): void;
  retryRead(): void;
} {
  const { identity, worldAccepted, returnPath } = p;
  const queryClient = useQueryClient();
  const token = useAuthToken();
  const invalidate = useInvalidateIdentity();
  const sessionQuery = useIdentityCheckSessionQuery({ enabled: identity?.automatic === true });
  const { mutateAsync: startCheck, isPending: starting } = useStartIdentityCheckMutation();
  const { mutateAsync: syncCheck } = useSyncIdentityCheckMutation();

  // The clock the record's renewal window is read against: once, when the card mounts.
  const [nowMs] = useState(() => Date.now());

  // A session already read stays through a failed read again (the wait's next tick asks again);
  // with nothing read yet, a failure is unreadable.
  const session: SessionRead =
    sessionQuery.data ?? (sessionQuery.error ? "unreadable" : "loading");

  /* ── The reads at the provider ───────────────────────────────────────────────────────────── */

  // One read in flight at most: a second caller shares it. `cooling` is true from the send until
  // `SYNC_MIN_INTERVAL_MS` after it settled, which is when the server takes the next one.
  const inFlight = useRef<Promise<SyncResult> | null>(null);
  const lastSyncAt = useRef<number | null>(null);
  const coolTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cooling, setCooling] = useState(false);

  const runSync = useCallback((): Promise<SyncResult> => {
    if (inFlight.current) return inFlight.current;
    setCooling(true);
    const sent = syncCheck()
      .then(
        (): SyncResult => ({ ok: true }),
        (error: unknown): SyncResult => ({ ok: false, error }),
      )
      .then((result) => {
        inFlight.current = null;
        lastSyncAt.current = Date.now();
        if (coolTimer.current !== null) clearTimeout(coolTimer.current);
        coolTimer.current = setTimeout(() => setCooling(false), SYNC_MIN_INTERVAL_MS);
        return result;
      });
    inFlight.current = sent;
    return sent;
  }, [syncCheck]);

  // A cleanup only: the cooling timer goes with the card.
  useEffect(
    () => () => {
      if (coolTimer.current !== null) clearTimeout(coolTimer.current);
    },
    [],
  );

  /* ── The read-back on arrival ────────────────────────────────────────────────────────────── */

  // Decided once, on the session's first read (React's pattern for state that follows a value,
  // set during render, so no render shows a decision not yet taken).
  const [firstRead, setFirstRead] = useState<"read_back" | "nothing" | null>(null);
  if (firstRead === null && typeof session === "object")
    setFirstRead(shouldReadBack(session) ? "read_back" : "nothing");
  const wantsReadBack = firstRead === null ? shouldReadBack(session) : firstRead === "read_back";
  const [readBack, setReadBack] = useState<Arrival>("pending");
  const arrival: Arrival = wantsReadBack ? readBack : "done";

  const readBackSent = useRef(false);
  useEffect(() => {
    if (firstRead !== "read_back" || readBackSent.current) return;
    readBackSent.current = true;
    void runSync().then((result) => setReadBack(arrivalOf(result)));
  }, [firstRead, runSync]);

  /* ── The card's state ────────────────────────────────────────────────────────────────────── */

  // The start's refusal code, for the one row that reads it (a renewal under review).
  const [startRefused, setStartRefused] = useState<string | null>(null);
  const view = identityCardView({ identity, worldAccepted, session, arrival, startRefused, nowMs });

  /* ── The wait while the provider is processing ───────────────────────────────────────────── */

  const reading = view.kind === "reading";
  const [longWait, setLongWait] = useState(false);
  // Leaving `reading` ends the wait, and its long-wait flag with it.
  const [wasReading, setWasReading] = useState(reading);
  if (wasReading !== reading) {
    setWasReading(reading);
    if (!reading) setLongWait(false);
  }

  useEffect(() => {
    if (!reading || longWait) return;
    const waitStartedAt = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      const step = readingStep({
        elapsedMs: now - waitStartedAt,
        sinceSyncMs: now - (lastSyncAt.current ?? waitStartedAt),
      });
      if (step === "stop") setLongWait(true);
      else if (step === "sync") void runSync();
      else void invalidate();
    }, READ_POLL_MS);
    return () => clearInterval(timer);
  }, [reading, longWait, runSync, invalidate]);

  /* ── The start ───────────────────────────────────────────────────────────────────────────── */

  const [problem, setProblem] = useState<string | null>(null);
  // Once the provider's address is assigned the page is leaving: the button stays busy.
  const [leaving, setLeaving] = useState(false);
  // One request per click, a double click included.
  const startSent = useRef(false);

  // A page restored from the browser's back-forward cache (Back on the provider's page) is no
  // longer leaving: the button comes back, and the two reads are asked again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      startSent.current = false;
      setLeaving(false);
      void invalidate();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [invalidate]);

  function start(names: { firstName: string; lastName: string }) {
    if (startSent.current) return;
    const typed = typedNames(names);
    if (typed === null) {
      setProblem(A.form.nameProblem);
      return;
    }
    setProblem(null);
    startSent.current = true;
    startCheck({ ...typed, returnPath }).then(
      (started) => {
        const url = providerPageUrl(started.url);
        if (url === null) {
          startSent.current = false;
          setProblem(A.refusals.other);
          return;
        }
        setLeaving(true);
        window.location.assign(url);
      },
      (error: unknown) => {
        startSent.current = false;
        const refusal = startRefusal(error);
        setProblem(refusal.sentence);
        setStartRefused(refusal.code);
        // The page's own sign-in gate reads the record's refusal and takes over.
        if (refusal.signIn)
          void queryClient.invalidateQueries({ queryKey: apiKeys.worldIdMe(token ?? "") });
      },
    );
  }

  /* ── Check again, and the retry of a failed read ─────────────────────────────────────────── */

  function checkAgain() {
    if (cooling) return;
    void runSync().then((result) => {
      setProblem(result.ok ? null : syncRefusal(result.error).sentence);
      // The wait starts again while the provider is still processing.
      setLongWait(false);
    });
  }

  function retryRead() {
    void sessionQuery.refetch();
    if (arrival !== "failed") return;
    setReadBack("pending");
    void runSync().then((result) => setReadBack(arrivalOf(result)));
  }

  return {
    view,
    busy: starting || leaving,
    problem,
    longWait,
    canCheckAgain: !cooling,
    start,
    checkAgain,
    retryRead,
  };
}
