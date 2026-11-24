"use client";

import { Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useBytecode } from "wagmi";
import { Blank, FlowBackground, FlowHeader } from "@/components/legalBody/FlowFrame";
import { HumanStep } from "@/components/legalBody/HumanStep";
import { SignInStep } from "@/components/legalBody/SignInStep";
import { AuthProvider, useAuth } from "@/components/onboarding/AuthProvider";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Card } from "@/components/onboarding/primitives";
import { Web3Provider } from "@/components/providers/Web3Provider";
import { useCompaniesQuery, usePublicConfigQuery, useWorldIdMeQuery } from "@/lib/api/hooks";
import type { AuthSession, PublicConfig } from "@/lib/api/types";
import { arcTestnet } from "@/lib/chain";
import {
  anySignInRequired,
  identityBlocksGate,
  legalBodyGate,
  signInStepState,
  type CodeRead,
  type GateView,
} from "@/lib/legalBody/gates";
import { readLegalBodyMemory, writeLegalBodyMemory } from "@/lib/legalBody/storage";
import { worldIdGateState, worldIdMeStatus } from "@/lib/legalBody/worldIdGate";
import { readPersistedOnboarding } from "@/lib/onboarding/storage";
import { START_COPY } from "@/lib/start/copy";
import {
  escapeToFullProduct,
  fullProductHref,
  parsePathParam,
  pathFacts,
  preselectedPath,
  startContinue,
  startDestination,
  type PathCard,
  type PathId,
} from "@/lib/start/paths";
import { PathChoice } from "./PathChoice";

/**
 * The start at `/start`: the one way in. Sign in with a wallet, pass the World ID check, then
 * choose a path.
 *
 * The deployment's config decides first (`startDestination`): which cards there are, or that there
 * is nothing to choose. Then the legal-body flow's two gates, composed from the same pure
 * functions `/legal-body` uses, so a person who passes them here passes them there. Where the
 * full product is offered, a gate that stops a legal body shows one link past it
 * (`escapeToFullProduct`).
 *
 * The choice hands over and leaves (`startContinue`): a legal-body path writes the per-account
 * memory (`newCompanyHandover`, which knows the companies there are at the click) and opens
 * `/legal-body`; the full product opens the wizard. `?path=` only picks which card opens
 * selected, among the cards there are. Nothing here writes to the server.
 */

const NO_CODE: CodeRead = { status: "pending", data: undefined };
const MAIN = "mx-auto max-w-[820px] px-5 pb-24 pt-10 lg:px-8 lg:pt-14";

export function StartFlow() {
  return (
    <Web3Provider>
      <AuthProvider>
        <Suspense fallback={<Blank />}>
          <StartHydrated />
        </Suspense>
      </AuthProvider>
    </Web3Provider>
  );
}

const noSubscription = () => () => {};

/** The server renders the blank: the session and the memory live in this browser only. */
function StartHydrated() {
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!hydrated) return <Blank />;
  return (
    <div className="min-h-screen bg-paper font-mono text-ink">
      <FlowBackground />
      <FlowHeader />
      <StartDestination />
    </div>
  );
}

/** The page under the frame, as the deployment's config decides it. Exported for its test. */
export function StartDestination() {
  const { data, isError, refetch } = usePublicConfigQuery();
  const destination = startDestination({
    status: data ? "ready" : isError ? "error" : "loading",
    config: data,
  });
  switch (destination.kind) {
    case "loading":
      return <main className="min-h-[60vh]" aria-busy />;
    case "error":
      return (
        <StartNotice sentence={START_COPY.unreadable}>
          <Button onClick={() => void refetch()}>{START_COPY.retry}</Button>
        </StartNotice>
      );
    case "none":
      return (
        <StartNotice sentence={START_COPY.none}>
          <Link
            href="/"
            className="rounded-full border hairline-strong px-4 py-2 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
          >
            {START_COPY.home}
          </Link>
        </StartNotice>
      );
    case "full_only":
      return <FullProductOnly />;
    case "choice":
      return (
        <main className={MAIN}>
          <StartOpen cards={destination.cards} config={data} />
        </main>
      );
  }
}

/** The start before a session: the sign-in step alone. Once signed in, the session's own screen,
 *  remounted for each wallet so one wallet's memory never serves another. */
function StartOpen({ cards, config }: { cards: PathCard[]; config: PublicConfig | undefined }) {
  const { session } = useAuth();
  // Whether the person acted on the sign-in card here: if so, the sign-in step stays on screen
  // after the session appears, with its Continue.
  const [engaged, setEngaged] = useState(false);

  if (!session) {
    return (
      <SignInStep
        code={NO_CODE}
        expired={false}
        onEngage={() => setEngaged(true)}
        onContinue={() => {}}
        onRetryCheck={() => {}}
      />
    );
  }
  return (
    <StartSession
      key={session.address.toLowerCase()}
      cards={cards}
      config={config}
      session={session}
      engaged={engaged}
    />
  );
}

function StartSession({
  cards,
  config,
  session,
  engaged,
}: {
  cards: PathCard[];
  config: PublicConfig | undefined;
  session: AuthSession;
  engaged: boolean;
}) {
  const tenant = session.address;
  const router = useRouter();
  const wanted = parsePathParam(useSearchParams().get("path"));
  const [view, setView] = useState<GateView>(engaged ? "signin" : null);

  // Reads only.
  const code = useBytecode({ address: tenant, chainId: arcTestnet.id });
  const meQuery = useWorldIdMeQuery();
  const companiesQuery = useCompaniesQuery();

  // The gate, from the legal-body flow's own decisions: what passes here passes on `/legal-body`.
  const expired = anySignInRequired([meQuery.error, companiesQuery.error]);
  const codeRead: CodeRead = { status: code.status, data: code.data };
  const signIn = signInStepState({ hasSession: true, attempt: null, expired, code: codeRead });
  const me = meQuery.data ?? null;
  const human = worldIdGateState({
    me,
    meStatus: worldIdMeStatus(me, meQuery.error),
    requireRealHuman: true,
    forceRequired: true,
  });
  const gate = legalBodyGate({
    signIn,
    human,
    view,
    identityBlocks: identityBlocksGate(me?.identity),
  });
  const escape = escapeToFullProduct({ cards, gate, signIn });

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [gate]);

  const companies = companiesQuery.data?.companies;

  /** Continue: `startContinue` decides. A legal-body path is handed over through the memory, with
   *  the companies there are at the click; the full product opens the wizard where it was left.
   *  Continue waits for the list (`busy`), so a null answer only guards a click the button
   *  refuses. */
  function choose(path: PathId) {
    const next = startContinue({
      path,
      tenant,
      stored: readLegalBodyMemory(tenant),
      companies,
      wizard: readPersistedOnboarding(),
    });
    if (next === null) return;
    if (next.write) writeLegalBodyMemory(next.write);
    router.push(next.href);
  }

  if (gate === "signin")
    return (
      <>
        <SignInStep
          code={codeRead}
          expired={expired}
          onEngage={() => setView("signin")}
          onContinue={() => setView(null)}
          onRetryCheck={() => void code.refetch()}
        />
        {escape && <EscapeLink />}
      </>
    );
  if (gate === "human")
    return (
      <>
        <HumanStep
          onEngage={() => setView("human")}
          onContinue={() => setView(null)}
          onBack={() => setView("signin")}
          returnPath="/start"
        />
        {escape && <EscapeLink />}
      </>
    );

  // A refusal that means "sign in" never gets here: it is the sign-in step's `expired`.
  if (!companies && companiesQuery.error)
    return (
      <div>
        <Callout tone="warn">{START_COPY.companiesUnreadable}</Callout>
        <StepNav>
          <Button onClick={() => void companiesQuery.refetch()}>{START_COPY.retry}</Button>
        </StepNav>
      </div>
    );
  return (
    <PathChoice
      cards={cards}
      initial={preselectedPath(cards, wanted)}
      facts={pathFacts(config)}
      busy={!companies}
      onContinue={choose}
    />
  );
}

/** The one muted sentence past a gate that stops a legal body, to the full product. */
function EscapeLink() {
  return (
    <p className="mt-6 text-[12.5px] leading-[1.6] text-muted">
      {START_COPY.escape.sentence}{" "}
      <Link
        href={fullProductHref(readPersistedOnboarding())}
        className="text-ink underline underline-offset-2"
      >
        {START_COPY.escape.link}
      </Link>
    </p>
  );
}

/** A deployment that offers the full product alone: the wizard, where it was left. */
function FullProductOnly() {
  const router = useRouter();
  useEffect(() => {
    router.replace(fullProductHref(readPersistedOnboarding()));
  }, [router]);
  return <main className="min-h-[60vh]" aria-busy />;
}

function StartNotice({ sentence, children }: { sentence: string; children: ReactNode }) {
  return (
    <main className={MAIN}>
      <Card className="p-6">
        <p className="text-[14px] leading-[1.6] text-ink">{sentence}</p>
      </Card>
      <StepNav>{children}</StepNav>
    </main>
  );
}
