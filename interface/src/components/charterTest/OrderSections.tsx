"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnection, useSignTypedData } from "wagmi";
import { Button, Field, TextInput } from "@/components/onboarding/primitives";
import { useAuthToken } from "@/lib/api/hooks";
import { apiKeys } from "@/lib/api/keys";
import {
  useAdoptOrderMutation,
  useLegalBodyAgreementQuery,
  useLegalBodyBindingQuery,
  useLegalBodyOrderQuery,
  useLinkMessageMutation,
  useSubmitLinkMutation,
} from "@/lib/api/legalBodyHooks";
import type {
  Address,
  LegalBodyAgreement,
  LegalBodyOrderView,
  LinkMessageResult,
  LinkSubmitAnswer,
} from "@/lib/api/types";
import {
  CHARTER_ADOPTION_TYPE,
  adoptionSignGate,
  type WagmiAdoptionTypedData,
} from "@/lib/charterTest/adoptionGate";
import { readServedGrant } from "@/lib/charterTest/grantForm";
import { useOrderGrantQuery, useServedAdoptionMessageMutation } from "@/lib/charterTest/hooks";
import type { CharterTestConfig } from "@/lib/charterTest/served";
import { agreementProblem } from "@/lib/legalBody/agreement";
import { sameAddress } from "@/lib/legalBody/flow";
import { linkRequestFor } from "@/lib/legalBody/link";
import { RESERVED_POLL_MS } from "@/lib/legalBody/polling";
import { linkSignGate, signThroughGate } from "@/lib/legalBody/signGate";
import { Facts, Json, Line, Refusal, Section, Served } from "./parts";

/**
 * The steps of one order: its agreement, its adoption, its link, and its state.
 *
 * The order and its agreement are read once here and handed to each step, so every step speaks of
 * the same bytes. The agreement is checked in the browser before a word of it is shown, by the
 * product's own check: against its own hashes, and against the hash this order froze. One that
 * does not check stops the three steps that need it.
 */
export function OrderSections({
  config,
  tenant,
  orderId,
}: {
  config: CharterTestConfig;
  tenant: Address;
  orderId: string;
}) {
  const orderQuery = useLegalBodyOrderQuery(orderId, { pollWhileReserved: true });
  const agreementQuery = useLegalBodyAgreementQuery(orderId);
  const order = orderQuery.data;
  const agreement = agreementQuery.data;
  const problem = order && agreement ? agreementProblem(order, agreement) : null;
  const checked = order && agreement && problem === null ? { order, agreement } : null;

  return (
    <>
      <Section title="6. Agreement (GET /legal-body-orders/:id/agreement)">
        <Refusal error={orderQuery.error} />
        <Refusal error={agreementQuery.error} />
        {(orderQuery.isPending || agreementQuery.isPending) && <Line>Reading the order and its agreement.</Line>}
        {problem !== null && (
          <Line>
            The served agreement does not check against its own hashes or against the hash this
            order froze, so it is not shown: {problem}.
          </Line>
        )}
        {checked && <Agreement orderId={orderId} agreement={checked.agreement} />}
      </Section>

      <Section title="7. Adoption">
        {checked ? (
          <Adoption order={checked.order} agreement={checked.agreement} tenant={tenant} />
        ) : (
          <Line>The adoption needs the order&apos;s agreement, read and checked.</Line>
        )}
      </Section>

      <Section title="8. Link">
        {checked ? (
          <Link config={config} order={checked.order} agreement={checked.agreement} tenant={tenant} />
        ) : (
          <Line>The link needs the order&apos;s agreement, read and checked.</Line>
        )}
      </Section>

      <OrderState orderId={orderId} order={order} onReadAgain={() => void orderQuery.refetch()} />
    </>
  );
}

/* ── 6. The agreement ─────────────────────────────────────────────────────────────────────── */

/** The notice first, then the text's facts, the terms, and the order's grant read back. */
function Agreement({ orderId, agreement }: { orderId: string; agreement: LegalBodyAgreement }) {
  const grantQuery = useOrderGrantQuery(orderId);
  const grant = grantQuery.data === undefined ? undefined : readServedGrant(grantQuery.data);
  return (
    <>
      <Served name="notice (served with the agreement)" text={agreement.notice ?? null} />
      <Facts
        rows={[
          ["textId", agreement.textId],
          ["textVersion", agreement.textVersion],
          ["textStatus", agreement.textStatus],
          ["manifestHash", agreement.manifestHash],
        ]}
      />
      <Served name="termsDoc (the agreement, as frozen for this order)" text={agreement.termsDoc} long />

      <h3 className="text-[13px] font-medium text-ink">
        The order&apos;s grant, read back (GET /legal-body-orders/:id/grant)
      </h3>
      <Refusal error={grantQuery.error} />
      {grant === null && <Facts rows={[["grant", null]]} />}
      {grant === "unreadable" && (
        <>
          <Line>The answer is not a grant this page can read.</Line>
          <Json value={grantQuery.data} />
        </>
      )}
      {grant !== undefined && grant !== null && grant !== "unreadable" && (
        <>
          <Facts
            rows={[
              ["number", grant.number],
              ["version", grant.version],
              ["digest", grant.digest],
              ["wording", grant.wording],
            ]}
          />
          <Served name="scheduleA (as served)" text={grant.scheduleA} long />
          <Json value={grant.choices} />
        </>
      )}
    </>
  );
}

/* ── 7. The adoption ──────────────────────────────────────────────────────────────────────── */

/**
 * The notice again, then the words of adoption as served, then the button. One click is one chain:
 * the adoption message asked for once; the gate (the form served against the agreement on screen,
 * then every field against the order, the agreement and this wallet); what the wallet is asked to
 * sign, shown; one signature; one send. The wallet opens only for typed data the gate accepted.
 */
function Adoption({
  order,
  agreement,
  tenant,
}: {
  order: LegalBodyOrderView;
  agreement: LegalBodyAgreement;
  tenant: Address;
}) {
  const adoptionMessage = useServedAdoptionMessageMutation(order.id);
  const adopt = useAdoptOrderMutation(order.id);
  const { signTypedDataAsync } = useSignTypedData();
  const { address: connected, chainId: walletChainId } = useConnection();

  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [asked, setAsked] = useState<WagmiAdoptionTypedData | null>(null);
  const [adoptedAt, setAdoptedAt] = useState<number | null>(null);
  const adopted = order.adoptedAt ?? adoptedAt;

  /** Each form goes to the wallet under its own primary type.
   *  Both branches are the same call: the ternary narrows the union so wagmi infers each form's
   *  own types. */
  const sign = (typedData: WagmiAdoptionTypedData) =>
    typedData.primaryType === CHARTER_ADOPTION_TYPE
      ? signTypedDataAsync(typedData)
      : signTypedDataAsync(typedData);

  async function onAdopt() {
    if (busy) return;
    adoptionMessage.reset();
    adopt.reset();
    setSaid(null);
    setAsked(null);
    if (!sameAddress(connected, tenant)) {
      setSaid("The connected wallet is not the wallet signed in: sign in again with this wallet.");
      return;
    }
    setBusy(true);
    try {
      const served = await adoptionMessage.mutateAsync();
      const gate = adoptionSignGate(served, { order, agreement, sessionAddress: tenant });
      if (!gate.ok) {
        setSaid(`The served adoption did not pass this page's check, and the wallet was not opened: ${gate.problem}.`);
        return;
      }
      setAsked(gate.typedData);
      const signed = await signThroughGate(gate, sign);
      if (signed.kind !== "signed") {
        setSaid(
          `The wallet did not sign. The typed data is for chain ${gate.typedData.domain.chainId}; the wallet is on chain ${walletChainId ?? "unknown"}.`,
        );
        return;
      }
      const answer = await adopt.mutateAsync({
        issuedAt: gate.typedData.message.issuedAt.toString(),
        signature: signed.signature,
      });
      setAdoptedAt(answer.adoptedAt);
    } catch {
      // The refusal is the mutation's error, shown below as served.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Served name="notice (served with the agreement)" text={agreement.notice ?? null} />
      <Served
        name="adoptionStatement (the words the wallet will sign, as served)"
        text={agreement.adoptionStatement ?? null}
      />
      {(agreement.adoptionStatement ?? null) === null && (
        <Line>This agreement is adopted by its fields alone: there are no words to sign.</Line>
      )}
      {adopted != null ? (
        <Facts rows={[["adoptedAt", adopted], ["adoptedAt (UTC)", new Date(adopted * 1000).toISOString()]]} />
      ) : (
        <div>
          <Button onClick={() => void onAdopt()} loading={busy}>
            Sign the adoption (adoption-message, then the wallet, then adoption)
          </Button>
        </div>
      )}
      {asked && (
        <>
          <h3 className="text-[13px] font-medium text-ink">What the wallet is asked to sign</h3>
          <Facts
            rows={[
              ["primaryType", asked.primaryType],
              ["domain", asked.domain],
              ...Object.entries(asked.message).map(
                ([name, value]) => [`message.${name}`, String(value)] as const,
              ),
            ]}
          />
        </>
      )}
      {said && <Line>{said}</Line>}
      {!asked && adoptionMessage.data !== undefined && <Json value={adoptionMessage.data} />}
      <Refusal error={adoptionMessage.error} />
      <Refusal error={adopt.error} />
    </>
  );
}

/* ── 8. The link ──────────────────────────────────────────────────────────────────────────── */

/**
 * The link of an agent identity the signed-in wallet owns. One click is one chain: the link asked
 * for once, with the server's own lifetime; the product's gate (every field against the order,
 * the agreement, the identity typed and this wallet, then the owner the door read against this
 * wallet); the link shown; one signature; one send. Both of the link door's answers that carry an
 * order are shown: the order as it now stands, or the refusal with its code and its detail.
 */
function Link({
  config,
  order,
  agreement,
  tenant,
}: {
  config: CharterTestConfig;
  order: LegalBodyOrderView;
  agreement: LegalBodyAgreement;
  tenant: Address;
}) {
  const linkMessage = useLinkMessageMutation(order.id);
  const submitLink = useSubmitLinkMutation(order.id);
  const { signTypedDataAsync } = useSignTypedData();
  const { address: connected, chainId: walletChainId } = useConnection();

  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [served, setServed] = useState<LinkMessageResult | null>(null);
  const [answer, setAnswer] = useState<LinkSubmitAnswer | null>(null);
  // The served message read as untrusted: an answer of another shape is shown whole, never read.
  const msg: unknown = served?.typedData?.message;
  const servedMessage =
    typeof msg === "object" && msg !== null && !Array.isArray(msg)
      ? (msg as Record<string, unknown>)
      : null;

  async function onLink() {
    if (busy) return;
    linkMessage.reset();
    submitLink.reset();
    setSaid(null);
    setServed(null);
    setAnswer(null);
    if (!sameAddress(connected, tenant)) {
      setSaid("The connected wallet is not the wallet signed in: sign in again with this wallet.");
      return;
    }
    const id = agentId.trim();
    const asked = linkRequestFor("browser", config);
    if ("problem" in asked) {
      setSaid(`The link was not asked for: ${asked.problem}.`);
      return;
    }
    setBusy(true);
    try {
      const message = await linkMessage.mutateAsync({ agentId: id, ...asked });
      setServed(message);
      const gate = linkSignGate(message, {
        order,
        agreement,
        sessionAddress: tenant,
        agentId: id,
        nowSeconds: Math.floor(Date.now() / 1000),
        linkTtlMax: config.linkTtl.max,
        branch: "browser",
      });
      if (!gate.ok) {
        setSaid(`The served link did not pass the check, and the wallet was not opened: ${gate.problem}.`);
        return;
      }
      const signed = await signThroughGate(gate, (typedData) => signTypedDataAsync(typedData));
      if (signed.kind !== "signed") {
        setSaid(
          `The wallet did not sign. The typed data is for chain ${message.typedData.domain.chainId}; the wallet is on chain ${walletChainId ?? "unknown"}.`,
        );
        return;
      }
      setAnswer(
        await submitLink.mutateAsync({
          message: message.typedData.message,
          signature: signed.signature,
        }),
      );
    } catch {
      // The refusal is the mutation's error, shown below as served.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Line>
        The ERC-8004 id of an agent identity this wallet owns on the deployment&apos;s chain, in
        decimal. The link door reads its owner.
      </Line>
      <Field label="agentId" htmlFor="charter-test-agent-id" className="max-w-xs">
        <TextInput
          id="charter-test-agent-id"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
      </Field>
      <div>
        <Button onClick={() => void onLink()} loading={busy}>
          Sign the link (link-message, then the wallet, then link)
        </Button>
      </div>
      {served && (
        <>
          <h3 className="text-[13px] font-medium text-ink">The link as served</h3>
          {servedMessage !== null ? (
            <Facts
              rows={[
                ["identityOwner", served.identityOwner],
                ["deadline", served.deadline],
                ...Object.entries(servedMessage).map(
                  ([name, value]) => [`message.${name}`, value] as const,
                ),
              ]}
            />
          ) : (
            <Json value={served} />
          )}
        </>
      )}
      {said && <Line>{said}</Line>}
      <Refusal error={linkMessage.error} />
      <Refusal error={submitLink.error} />
      {answer && answer.status !== 422 && (
        <Facts rows={[["HTTP", answer.status], ["order.state", answer.body.state]]} />
      )}
      {answer && answer.status === 422 && (
        <>
          <Facts
            rows={[
              ["HTTP", 422],
              ["code", answer.body.code],
              ["message", answer.body.message],
              ["order.state", answer.body.order.state],
            ]}
          />
          <Json value={answer.body.detail} />
        </>
      )}
    </>
  );
}

/* ── 9. The order's state ─────────────────────────────────────────────────────────────────── */

/** The order and its binding as the server holds them, whole. */
function OrderState({
  orderId,
  order,
  onReadAgain,
}: {
  orderId: string;
  order: LegalBodyOrderView | undefined;
  onReadAgain: () => void;
}) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return (
    <Section title="9. Order state (GET /legal-body-orders/:id, and its binding)">
      {order && <Json value={order} />}
      {/* A change of the order's state mounts the binding's read anew, so it is read again. */}
      <BindingRead key={order?.state ?? "unread"} orderId={orderId} />
      <Line>
        While the state is reserved, the order is read again every {RESERVED_POLL_MS / 1000}{" "}
        seconds.
      </Line>
      {order?.state === "deployed" && (
        <Line>
          The legal body is created. Writing the pointer on the identity is the step that follows,
          and it is not on this page: the flow at /legal-body shows it for this order.
        </Line>
      )}
      <div>
        <Button
          variant="ghost"
          onClick={() => {
            onReadAgain();
            void queryClient.refetchQueries({
              queryKey: apiKeys.legalBodyBinding(token ?? "", orderId),
              exact: true,
            });
          }}
        >
          Read again
        </Button>
      </div>
    </Section>
  );
}

/** The order's binding, whole. Mounted anew for each state of the order, so each is read. */
function BindingRead({ orderId }: { orderId: string }) {
  const bindingQuery = useLegalBodyBindingQuery(orderId);
  return (
    <>
      <Refusal error={bindingQuery.error} />
      {bindingQuery.data && <Json value={bindingQuery.data} />}
    </>
  );
}
