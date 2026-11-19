"use client";

import { useState } from "react";
import { WalletSignInCard } from "@/components/guardian/WalletSignInCard";
import { useWorldIdGate } from "@/components/guardian/WorldIdGate";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button } from "@/components/onboarding/primitives";
import { Facts, Line, Section } from "./parts";

/**
 * The two gates before the flow, each the product's own piece, used as it is: the wallet sign-in
 * card, and the real-human check with its World ID widget.
 *
 * Neither gate blocks the steps below it on this page: every door makes its own checks and
 * answers for them, and the page shows that answer.
 */

export function SignInSection() {
  const { session } = useAuth();
  const [error, setError] = useState<string | null>(null);
  return (
    <Section title="1. Sign in">
      <WalletSignInCard
        body="Connect the wallet that will be the Guardian, and sign in with it."
        onError={setError}
      />
      {error && <Line>{error}</Line>}
      {session && <Facts rows={[["session.address", session.address]]} />}
    </Section>
  );
}

export function HumanSection() {
  const { state, me, begin, busy, error, widget, refetch } = useWorldIdGate({
    requireRealHuman: true,
    forceRequired: true,
  });
  const canVerify = state.kind === "verify" || state.kind === "not_accepted";
  return (
    <Section title="2. Real-human check (GET /world-id/me)">
      <Facts
        rows={[
          ["state", state.kind],
          ["verified", me?.verified],
          ["realHuman", me?.realHuman],
          ["credential", me?.credential],
          ["required", me?.required],
        ]}
      />
      {state.kind === "unavailable" && (
        <Line>GET /world-id/me answered 404: this deployment serves no World ID routes.</Line>
      )}
      {error && <Line>{error}</Line>}
      <Line>The doors below make this check themselves, and answer for it.</Line>
      <div className="flex flex-wrap gap-3">
        {canVerify && (
          <Button onClick={() => void begin()} loading={busy}>
            Verify with World ID
          </Button>
        )}
        <Button variant="ghost" onClick={refetch}>
          Read again
        </Button>
      </div>
      {widget}
    </Section>
  );
}
