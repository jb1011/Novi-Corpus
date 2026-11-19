"use client";

import { useState, useSyncExternalStore } from "react";
import { AuthProvider, useAuth } from "@/components/onboarding/AuthProvider";
import { Button } from "@/components/onboarding/primitives";
import { Web3Provider } from "@/components/providers/Web3Provider";
import { usePublicConfigQuery } from "@/lib/api/hooks";
import { useLegalBodyConfig } from "@/lib/api/legalBodyHooks";
import type { AuthSession } from "@/lib/api/types";
import { deploymentStop, type CharterTestConfig } from "@/lib/charterTest/served";
import { CompanySection } from "./CompanySection";
import { GrantSection } from "./GrantSection";
import { HumanSection, SignInSection } from "./GateSections";
import { OrderSections } from "./OrderSections";
import { RefusalLog } from "./RefusalLog";
import { Facts, Line, Section } from "./parts";

/**
 * The test page of the legal-body flow on a deployment that serves the Legal Body Charter: every
 * step on one page, in the flow's order, each showing what the server serves, as served.
 *
 * It reuses the product's sign-in, real-human check, API client and checks, and changes none of
 * them. What the product's own screens do not do yet on such a deployment, it does itself: the
 * rule of the adoption shown before the declaration is signed, the grant form, the order placed
 * with its grant, the notice and the words of adoption, and the adoption signed in the form the
 * server serves.
 *
 * Two things live in this page's state and nowhere else: the company and the order it is about.
 * A reload starts again from the server's lists. Nothing is written on mount: every write is a
 * click's. The session and the wallet live in this browser only, so the server renders nothing.
 */
export function CharterTestPage() {
  return (
    <Web3Provider>
      <AuthProvider>
        <Hydrated />
      </AuthProvider>
    </Web3Provider>
  );
}

const noSubscription = () => () => {};

function Hydrated() {
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  return hydrated ? <Frame /> : null;
}

function Frame() {
  const read = useLegalBodyConfig();
  const { refetch } = usePublicConfigQuery();
  const { session } = useAuth();
  const stop = deploymentStop(read);
  const config = stop === null && read.config?.available ? read.config : null;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-[20px] font-medium text-ink">Charter flow test page</h1>
        <Line>
          A test page for the legal-body flow on a deployment that serves the Legal Body Charter.
          It is not part of the product. It shows what the server serves, as served, and every
          refusal with its code. The words of the agreement, of the notice and of the adoption are
          the server&apos;s.
        </Line>
      </header>

      <Section title="0. Deployment (GET /config)">
        {config === null ? (
          <>
            <Line>{stop}</Line>
            {read.status === "error" && (
              <div>
                <Button variant="ghost" onClick={() => void refetch()}>
                  Read again
                </Button>
              </div>
            )}
          </>
        ) : (
          <Facts
            rows={[
              ["environment", config.environment],
              ["chainId", config.chainId],
              ["factory", config.factory],
              ["identityRegistry", config.identityRegistry],
              ["declarations", config.declarations],
              ["paymentRequired", config.paymentRequired],
              ["identityRequired", config.identityRequired],
              ["linkTtl", config.linkTtl],
            ]}
          />
        )}
      </Section>

      {config !== null && (
        <>
          <SignInSection />
          {session ? (
            <Flow key={session.address.toLowerCase()} config={config} session={session} />
          ) : (
            <Line>Sign in to go on.</Line>
          )}
        </>
      )}

      <RefusalLog />
    </main>
  );
}

/** The steps after sign-in, remounted for each wallet so one wallet's choices never serve another. */
function Flow({ config, session }: { config: CharterTestConfig; session: AuthSession }) {
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);

  return (
    <>
      <HumanSection />
      <CompanySection
        config={config}
        tenant={session.address}
        companyId={companyId}
        onSelect={(id) => {
          setCompanyId(id);
          setOrderId(null);
        }}
      />
      <GrantSection
        companyId={companyId}
        orderId={orderId}
        onSelectOrder={(order) => {
          setCompanyId(order.companyId);
          setOrderId(order.id);
        }}
      />
      {orderId === null ? (
        <Section title="6. Agreement">
          <Line>Place or select an order first.</Line>
        </Section>
      ) : (
        <OrderSections key={orderId} config={config} tenant={session.address} orderId={orderId} />
      )}
    </>
  );
}
