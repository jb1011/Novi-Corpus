/**
 * The calls the Charter flow's test page makes that the legal-body client does not have: the three
 * grant doors, the order placed with a grant, and the adoption message read as it is served.
 *
 * Each goes through `request`, like every authenticated call: the site's proxy, the session's
 * bearer token, and an `ApiError` with the API's own code and sentence on a refusal. The answers
 * are typed `unknown` where the page checks their shape itself before it shows or signs anything.
 */
import { request } from "@/lib/api/client";
import type { LegalBodyOrderView } from "@/lib/api/types";

const orderPath = (id: string) => `/legal-body-orders/${encodeURIComponent(id)}`;

/** `GET /legal-body-orders/grant-form`: what the form of a grant must hold on this deployment. */
export function getGrantForm(token: string): Promise<unknown> {
  return request("/legal-body-orders/grant-form", { token });
}

/** `POST /legal-body-orders/grant-preview`: the grant as the agreement would state it. Writes
 *  nothing. */
export function previewGrant(token: string, grant: unknown): Promise<unknown> {
  return request("/legal-body-orders/grant-preview", { method: "POST", token, body: { grant } });
}

/** `POST /legal-body-orders`: the order, with its grant when one is given. `grant` undefined sends
 *  no `grant` key: a deployment whose agreement takes none refuses the key. */
export function placeOrder(
  token: string,
  companyId: string,
  grant: unknown,
): Promise<LegalBodyOrderView> {
  const body = grant === undefined ? { companyId } : { companyId, grant };
  return request("/legal-body-orders", { method: "POST", token, body });
}

/** `GET /legal-body-orders/:id/grant`: the order's grant, read back. */
export function getOrderGrant(token: string, id: string): Promise<unknown> {
  return request(`${orderPath(id)}/grant`, { token });
}

/** `POST /legal-body-orders/:id/adoption-message`: the adoption to sign, in the form the server
 *  chose. Writes nothing. */
export function requestAdoptionMessage(token: string, id: string): Promise<unknown> {
  return request(`${orderPath(id)}/adoption-message`, { method: "POST", token });
}
