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
import type { GuardianIdentityView, IdentitySessionView } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import {
  arrivalAfter,
  arrivalOf,
  cardUnderWay,
  clickLeftUnread,
  identityCardView,
  providerPageUrl,
  providerReadStep,
  refusalStands,
  sessionMark,
  shouldReadBack,
  shownProblem,
  startRefusal,
  syncRefusal,
  typedNames,
  type Arrival,
  type CardProblem,
  type IdentityCardView,
  type IdentityReturnPath,
  type SessionRead,
} from "@/lib/legalBody/identityCheck";
import {
  SYSTEM_TIMERS,
  createFreshSync,
  createReadingWait,
  createSyncGate,
  type FreshRead,
  type FreshSync,
  type ReadingWait,
  type SyncGate,
} from "@/lib/legalBody/identityCheckTimers";

const A = LEGAL_BODY_COPY.human.guardianIdentity.automatic;

/**
 * The identity check card's state and its three clicks. The card's state is `identityCardView`'s,
 * over the two reads (`/world-id/me`'s identity block, passed in, and the open session, read
 * here). The timed rules are two plain objects (`identityCheckTimers.ts`), made on first use and
 * kept for the mount: the gate in front of the reads at the provider, and the bounded wait while
 * the provider is processing. This hook only tells them when to run.
 *
 * One write is not a click: the read-back. When the session's first read made after this mount
 * says it is open and not held, the hook reads it back from the provider once per mount
 * (`POST /identity-check/sync`). It continues the Start click that sent the person away, whichever
 * way they came back, and the server keeps one row at most. Until it settles the card says it is
 * reading the check, never the continue form. A session with nothing to read back is `"done"`
 * from the first render.
 *
 * No read at the provider goes out over a read of the session older than the moment it is for
 * (ruling R35, `providerReadStep`): the read-back waits for a read made after the mount, not the
 * cache the card mounted on; Check again, Try again and the wait's own reads at the provider read
 * both reads again first (`createFreshSync`, one under way at most, none sent while another read
 * at the provider is in flight or cooling). A session held, closed or gone on that read is shown,
 * never read at the provider. A click whose read again fails leaves the check unread, with Try
 * again, like a read-back that failed; the wait's own tick keeps waiting quietly.
 *
 * Check again and Try again wait on the gate's cooling: a click within the server's interval
 * would be refused as too soon, and a refusal that reads as "read a moment ago" must not stand
 * for a read that never worked.
 *
 * What a click leaves behind lasts only while it still describes the card: a problem's sentence
 * while the card is in the kind it was said under (`shownProblem`), the start's refusal while the
 * session reads the same (`refusalStands`).
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
  /** The start answered an address and the browser is leaving for it. */
  leaving: boolean;
  problem: string | null;
  longWait: boolean;
  canCheckAgain: boolean;
  /** The read-back running, the wait running, or the provider processing (`cardUnderWay`). */
  underWay: boolean;
  start(names: { firstName: string; lastName: string }): void;
  checkAgain(): void;
  retryRead(): void;
} {
  const { identity, worldAccepted, returnPath } = p;
  const queryClient = useQueryClient();
  const token = useAuthToken();
  const invalidate = useInvalidateIdentity();
  const sessionQuery = useIdentityCheckSessionQuery({ enabled: identity?.automatic === true });
  const {
    mutateAsync: startCheck,
    isPending: starting,
    reset: resetStart,
  } = useStartIdentityCheckMutation();
  const { mutateAsync: syncCheck } = useSyncIdentityCheckMutation();

  // The clock the record's renewal window is read against: once, when the card mounts.
  const [nowMs] = useState(() => Date.now());

  // A session already read stays through a failed read again (the wait's next tick asks again);
  // with nothing read yet, a failure is unreadable.
  const session: SessionRead =
    sessionQuery.data ?? (sessionQuery.error ? "unreadable" : "loading");
  // The time of the session's data when the card mounted: TanStack's cache from an earlier visit
  // to the step, or 0. A read newer than it was made after this mount.
  const [mountReadAt] = useState(() => sessionQuery.dataUpdatedAt);

  // Both reads again, for a read at the provider: the session's, with its time and the time of the
  // read before it (`FreshRead`), and `/world-id/me`'s, so the card shows what the reads say.
  const readAgain = useCallback(async (): Promise<FreshRead> => {
    const sessionKey = apiKeys.identityCheckSession(token ?? "");
    const after = queryClient.getQueryState(sessionKey)?.dataUpdatedAt ?? 0;
    await Promise.all([
      queryClient.refetchQueries({ queryKey: sessionKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: apiKeys.worldIdMe(token ?? "") }),
    ]);
    const read = queryClient.getQueryState<IdentitySessionView>(sessionKey);
    return { session: read?.data ?? "unreadable", readAt: read?.dataUpdatedAt ?? 0, after };
  }, [queryClient, token]);

  /* ── The gate and the wait, once per mount ───────────────────────────────────────────────── */

  // The latest send, poll and read again, for the two objects below, which outlive a render.
  const calls = useRef({ send: syncCheck, poll: invalidate, readAgain });
  useEffect(() => {
    calls.current = { send: syncCheck, poll: invalidate, readAgain };
  }, [syncCheck, invalidate, readAgain]);

  const [cooling, setCooling] = useState(false);
  const [longWait, setLongWait] = useState(false);
  // Made on first use, from an effect or a click, never during a render, and kept for the mount.
  const timed = useRef<{ gate: SyncGate; fresh: FreshSync; wait: ReadingWait } | null>(null);
  const timedRules = useCallback(() => {
    if (timed.current === null) {
      const gate = createSyncGate({
        send: () => calls.current.send(),
        onCoolingChange: setCooling,
        timers: SYSTEM_TIMERS,
      });
      const fresh = createFreshSync({ read: () => calls.current.readAgain(), gate });
      const wait = createReadingWait({
        // Over a fresh read of the session, like a click's; a tick that finds one under way
        // starts none.
        sync: () => void fresh.run("wait"),
        lastSyncAt: gate.lastSyncAt,
        poll: () => void calls.current.poll(),
        onLongWait: () => setLongWait(true),
        timers: SYSTEM_TIMERS,
      });
      timed.current = { gate, fresh, wait };
    }
    return timed.current;
  }, []);

  /* ── The read-back on arrival ────────────────────────────────────────────────────────────── */

  // Decided once, on the session's first read made after this mount (React's pattern for state
  // that follows a value, set during render, so no render shows a decision not yet taken). Until
  // then the cache decides what shows: an open session not held reads as being read, never as the
  // continue form; a fresh read that failed leaves it unread, with Try again.
  const [firstRead, setFirstRead] = useState<"read_back" | "nothing" | null>(null);
  const arrivalStep = providerReadStep({
    session,
    readAt: sessionQuery.dataUpdatedAt,
    after: mountReadAt,
    by: "arrival",
  });
  if (firstRead === null && arrivalStep !== "wait")
    setFirstRead(arrivalStep === "sync" ? "read_back" : "nothing");
  const wantsReadBack = firstRead === null ? shouldReadBack(session) : firstRead === "read_back";
  // The card's last read at the provider, as it settled: the read-back, a Try again, or a click
  // whose read again failed (follow-up U2). Null before any: pending for a read-back still to
  // settle, done where there was none to make.
  const [lastRead, setLastRead] = useState<Arrival | null>(null);
  const undecided: Arrival = sessionQuery.isFetchedAfterMount ? "failed" : "pending";
  const arrival: Arrival =
    firstRead === null
      ? wantsReadBack
        ? undecided
        : "done"
      : (lastRead ?? (firstRead === "read_back" ? "pending" : "done"));

  const readBackSent = useRef(false);
  useEffect(() => {
    if (firstRead !== "read_back" || readBackSent.current) return;
    readBackSent.current = true;
    void timedRules()
      .gate.run()
      .then((result) => setLastRead(arrivalOf(result)));
  }, [firstRead, timedRules]);

  /* ── The card's state ────────────────────────────────────────────────────────────────────── */

  // The start's refusal code, for the one row that reads it (a renewal under review), kept against
  // the session it was refused over: a new session, or one that closed, ends it.
  const [refused, setRefused] = useState<{ code: string; mark: string | null } | null>(null);
  const startRefused =
    refused !== null && refusalStands(refused.mark, session) ? refused.code : null;
  if (refused !== null && startRefused === null) setRefused(null);
  const view = identityCardView({ identity, worldAccepted, session, arrival, startRefused, nowMs });

  /* ── The wait while the provider is processing ───────────────────────────────────────────── */

  const reading = view.kind === "reading";
  // Leaving `reading` ends the wait, and its long-wait flag with it.
  const [wasReading, setWasReading] = useState(reading);
  if (wasReading !== reading) {
    setWasReading(reading);
    if (!reading) setLongWait(false);
  }

  // The wait keeps its own start: this effect only says when it runs.
  const waiting = reading && !longWait;
  useEffect(() => {
    if (!waiting) return;
    const { wait } = timedRules();
    wait.start();
    return () => wait.stop();
  }, [waiting, timedRules]);

  /* ── The start ───────────────────────────────────────────────────────────────────────────── */

  // A click's problem, with the card's kind it was said under: once the card moved on, the
  // sentence no longer describes it, and it goes.
  const [raised, setRaised] = useState<CardProblem | null>(null);
  const problem = shownProblem(raised, view.kind);
  if (raised !== null && problem === null) setRaised(null);
  const say = (kind: IdentityCardView["kind"], sentence: string | null) =>
    setRaised(sentence === null ? null : { sentence, kind });
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
    // What the click was made on: the card's kind, and the session the refusal is kept against.
    const kind = view.kind;
    const mark = sessionMark(session);
    const typed = typedNames(names);
    if (typed === null) {
      say(kind, A.form.nameProblem);
      return;
    }
    say(kind, null);
    startSent.current = true;
    startCheck({ ...typed, returnPath }).then(
      (started) => {
        // The names are the mutation's variables: dropped from TanStack's cache once it settles.
        resetStart();
        const url = providerPageUrl(started.url);
        if (url === null) {
          startSent.current = false;
          say(kind, A.refusals.other);
          return;
        }
        setLeaving(true);
        window.location.assign(url);
      },
      (error: unknown) => {
        resetStart();
        startSent.current = false;
        const refusal = startRefusal(error);
        say(kind, refusal.sentence);
        setRefused(refusal.code === null ? null : { code: refusal.code, mark });
        // The page's own sign-in gate reads the record's refusal and takes over.
        if (refusal.signIn)
          void queryClient.invalidateQueries({ queryKey: apiKeys.worldIdMe(token ?? "") });
      },
    );
  }

  /* ── Check again, and the retry of a failed read ─────────────────────────────────────────── */

  function checkAgain() {
    const { gate, fresh } = timedRules();
    if (gate.cooling()) return;
    const kind = view.kind;
    void fresh.run("click").then((out) => {
      if (out.sent) say(kind, out.result.ok ? null : syncRefusal(out.result.error).sentence);
      // Its read again failed, its own or that of the wait's run it joined: the check is unread,
      // with Try again, and the wait does not start again (follow-up U2).
      if (clickLeftUnread(out)) {
        setLastRead("failed");
        return;
      }
      // The wait starts again while the provider is still processing.
      setLongWait(false);
    });
  }

  // Both reads: an unreadable card may come from either, the session or `/world-id/me`. Before
  // the read-back is decided, the fresh read decides it. A read at the provider that failed, or a
  // click's read again that failed, is tried again over this click's read.
  function retryRead() {
    const { gate, fresh } = timedRules();
    if (firstRead === null || lastRead !== "failed" || gate.cooling()) {
      void readAgain();
      return;
    }
    setLastRead("pending");
    void fresh.run("click").then((out) => setLastRead(arrivalAfter(out)));
  }

  const underWay = cardUnderWay({
    session,
    readBackRunning: firstRead !== null && arrival === "pending",
    waiting,
  });

  return {
    view,
    busy: starting || leaving,
    leaving,
    problem,
    longWait,
    canCheckAgain: !cooling,
    underWay,
    start,
    checkAgain,
    retryRead,
  };
}
