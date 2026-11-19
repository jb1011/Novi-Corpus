"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/onboarding/primitives";
import {
  useAbandonLegalBodyOrderMutation,
  useLegalBodyOrdersQuery,
} from "@/lib/api/legalBodyHooks";
import type { LegalBodyOrderView } from "@/lib/api/types";
import {
  emptyGrantFormState,
  grantFromState,
  grantKey,
  orderCanBePlaced,
  readGrantForm,
  readServedGrant,
  type GrantFormState,
} from "@/lib/charterTest/grantForm";
import {
  useGrantFormQuery,
  useGrantPreviewMutation,
  usePlaceOrderMutation,
} from "@/lib/charterTest/hooks";
import { ApiError } from "@/lib/api/types";
import { fieldProblems } from "@/lib/charterTest/refusal";
import { GrantForm } from "./GrantForm";
import { Facts, Json, Line, Refusal, Section, Served } from "./parts";

/**
 * The grant and the order: the served form, the preview of the choices on it, the order placed
 * with them, and the tenant's orders.
 *
 * The form is the server's (`GrantForm`), and what it sends is on screen as JSON before it is
 * sent. The preview shows the Schedule A text the server would write for those choices: the only
 * place where the page says what a choice means, in the server's words. An order freezes its
 * agreement for good, so on a deployment that takes a grant the order is placed only with choices
 * whose preview is on screen and reads as a grant (`orderCanBePlaced`): any change of the form
 * removes the preview.
 *
 * On a deployment whose agreement takes no grant the form is not drawn, and the order is placed
 * without one. The order is placed by its click alone, once per click.
 */
export function GrantSection({
  companyId,
  orderId,
  onSelectOrder,
}: {
  companyId: string | null;
  orderId: string | null;
  onSelectOrder: (order: LegalBodyOrderView) => void;
}) {
  const formQuery = useGrantFormQuery();
  const preview = useGrantPreviewMutation();
  const place = usePlaceOrderMutation();
  const ordersQuery = useLegalBodyOrdersQuery();

  const [state, setState] = useState<GrantFormState>(emptyGrantFormState);
  // The choices the preview on screen was made for, as one spelling, and the server's answer.
  const [previewed, setPreviewed] = useState<{ key: string; answer: unknown } | null>(null);
  // Set and cleared inside the click: a second click before the first settles places nothing.
  const placing = useRef(false);

  const read = formQuery.data === undefined ? null : readGrantForm(formQuery.data);
  const grant = grantFromState(state);
  const key = grantKey(grant);
  const current = previewed !== null && previewed.key === key ? previewed : null;
  // Undefined while there is no preview of the choices now on the form.
  const servedGrant = current === null ? undefined : readServedGrant(current.answer);
  // The preview's last refusal, with the choices it refused: shown while the form holds them.
  const [refused, setRefused] = useState<{ key: string; error: unknown } | null>(null);
  const refusal = refused !== null && refused.key === key ? refused.error : null;
  // The order's last refusal, with the choices and the company it refused: shown while both hold.
  const [placeRefused, setPlaceRefused] = useState<{
    key: string;
    companyId: string;
    error: unknown;
  } | null>(null);
  const placeRefusal =
    placeRefused !== null && placeRefused.key === key && placeRefused.companyId === companyId
      ? placeRefused.error
      : null;
  // Each refusal's problems, under the lines they name.
  const problems = [refusal, placeRefusal].flatMap((e) =>
    e instanceof ApiError ? fieldProblems(e.details) : [],
  );

  async function onPreview() {
    const sent = grant;
    const sentKey = key;
    setRefused(null);
    try {
      const answer = await preview.mutateAsync(sent);
      setPreviewed({ key: sentKey, answer });
    } catch (error) {
      // Shown as served, with each problem beside the line it names.
      setRefused({ key: sentKey, error });
      setPreviewed(null);
    }
  }

  const takesGrant = read?.kind === "form";
  const canPlace = orderCanBePlaced({ companyId, read, key, previewed });

  async function onPlace() {
    if (!canPlace || companyId === null || placing.current) return;
    placing.current = true;
    const sentKey = key;
    setPlaceRefused(null);
    try {
      const order = await place.mutateAsync({ companyId, grant: takesGrant ? grant : undefined });
      onSelectOrder(order);
    } catch (error) {
      // Shown below as served, with each problem beside the line it names.
      setPlaceRefused({ key: sentKey, companyId, error });
    } finally {
      placing.current = false;
    }
  }

  return (
    <>
      <Section title="4. Grant (GET /legal-body-orders/grant-form)">
        {formQuery.isPending && <Line>Reading the grant form.</Line>}
        <Refusal error={formQuery.error} />
        {read?.kind === "none" && (
          <Line>
            takesGrant: false. This deployment&apos;s agreement takes no grant: the order is placed
            without one.
          </Line>
        )}
        {read?.kind === "unreadable" && (
          <>
            <Line>This page cannot draw the served form: {read.problem}.</Line>
            <Json value={formQuery.data} />
          </>
        )}
        {read?.kind === "form" && (
          <>
            <GrantForm
              form={read.form}
              state={state}
              onChange={setState}
              problems={problems}
              disabled={preview.isPending || place.isPending}
            />
            <h3 className="text-[13px] font-medium text-ink">The grant this form sends</h3>
            <Json value={grant} />
            <div>
              <Button onClick={() => void onPreview()} loading={preview.isPending}>
                Preview (POST /legal-body-orders/grant-preview)
              </Button>
            </div>
            <Refusal error={refusal} />
            {current === null && <Line>No preview of the choices now on the form.</Line>}
            {current !== null && (servedGrant === null || servedGrant === "unreadable") && (
              <>
                <Line>The preview&apos;s answer is not a grant this page can read.</Line>
                <Json value={current.answer} />
              </>
            )}
            {servedGrant !== undefined && servedGrant !== null && servedGrant !== "unreadable" && (
              <>
                <Facts
                  rows={[
                    ["number", servedGrant.number],
                    ["version", servedGrant.version],
                    ["digest", servedGrant.digest],
                    ["wording", servedGrant.wording],
                  ]}
                />
                <Served
                  name="scheduleA (Schedule A as the agreement would state these choices, as served)"
                  text={servedGrant.scheduleA}
                  long
                />
              </>
            )}
          </>
        )}
        <div>
          <Button variant="ghost" onClick={() => void formQuery.refetch()}>
            Read the form again
          </Button>
        </div>
      </Section>

      <Section title="5. Order (POST /legal-body-orders)">
        <Facts
          rows={[
            ["companyId", companyId ?? "none selected"],
            [
              "grant",
              read === null
                ? "the form is not read"
                : read.kind === "none"
                  ? "none: takesGrant is false"
                  : read.kind === "form"
                    ? "the grant shown in step 4"
                    : "the form cannot be drawn",
            ],
          ]}
        />
        {companyId === null && <Line>Select or declare a company first.</Line>}
        {takesGrant && current === null && (
          <Line>
            Preview the choices now on the form first: the order freezes them, and an order&apos;s
            agreement never changes.
          </Line>
        )}
        <div>
          <Button onClick={() => void onPlace()} disabled={!canPlace} loading={place.isPending}>
            Place the order
          </Button>
        </div>
        <Refusal error={placeRefusal} />

        <h3 className="text-[13px] font-medium text-ink">Your orders (GET /legal-body-orders)</h3>
        <Refusal error={ordersQuery.error} />
        {ordersQuery.data !== undefined && ordersQuery.data.orders.length === 0 && <Line>None.</Line>}
        {(ordersQuery.data?.orders ?? []).map((order) => (
          <OrderRow
            key={order.id}
            order={order}
            selected={order.id === orderId}
            onSelect={() => onSelectOrder(order)}
          />
        ))}
        <div>
          <Button variant="ghost" onClick={() => void ordersQuery.refetch()}>
            Read again
          </Button>
        </div>
      </Section>
    </>
  );
}

function OrderRow({
  order,
  selected,
  onSelect,
}: {
  order: LegalBodyOrderView;
  selected: boolean;
  onSelect: () => void;
}) {
  const abandon = useAbandonLegalBodyOrderMutation(order.id);
  return (
    <div className="flex flex-col gap-2 rounded-xl border hairline px-4 py-3">
      <Facts
        rows={[
          ["id", order.id],
          ["companyId", order.companyId],
          ["companyName", order.companyName],
          ["state", order.state],
          ["createdAt", order.createdAt],
          ["adoptedAt", order.adoptedAt],
          ["agentId", order.agentId],
        ]}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" disabled={selected} onClick={onSelect}>
          {selected ? "Selected" : "Use this order"}
        </Button>
        {order.state === "draft" && (
          <Button variant="subtle" loading={abandon.isPending} onClick={() => abandon.mutate()}>
            Abandon (POST /legal-body-orders/:id/abandon)
          </Button>
        )}
      </div>
      <Refusal error={abandon.error} />
    </div>
  );
}
