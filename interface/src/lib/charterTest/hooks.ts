"use client";

/**
 * The hooks of the Charter flow's test page: thin wrappers over `./client`, built as the
 * legal-body hooks are. Keys are scoped by the session's token; a mutation without a session
 * fails before any request leaves the browser; nothing writes on mount.
 *
 * No query here retries: a refusal is an answer the page shows at once, as served. Each query and
 * each mutation has a key that names its door, so a failure can be named where it is listed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthToken } from "@/lib/api/hooks";
import { apiKeys } from "@/lib/api/keys";
import {
  getGrantForm,
  getOrderGrant,
  placeOrder,
  previewGrant,
  requestAdoptionMessage,
} from "./client";

/** The page's keys. The token, where there is one, is the third element, as in `apiKeys`. */
export const CHARTER_TEST_KEYS = {
  grantForm: (token: string) => [...apiKeys.all, "charterTest:grantForm", token] as const,
  orderGrant: (token: string, id: string) =>
    [...apiKeys.all, "charterTest:orderGrant", token, id] as const,
  grantPreview: () => [...apiKeys.all, "charterTest:grantPreview"] as const,
  placeOrder: () => [...apiKeys.all, "charterTest:placeOrder"] as const,
  adoptionMessage: () => [...apiKeys.all, "charterTest:adoptionMessage"] as const,
};

/** The token a mutation sends, or a failure before any request: the page signs in first. It is
 *  not an answer of the API, so it is never shown as one. */
function requireToken(token: string | undefined): string {
  if (!token) throw new Error("No session: sign in first. Nothing was sent.");
  return token;
}

/** What the form of a grant must hold on this deployment. Read once per session; `refetch` reads
 *  it again. */
export function useGrantFormQuery() {
  const token = useAuthToken();
  return useQuery({
    queryKey: CHARTER_TEST_KEYS.grantForm(token ?? ""),
    queryFn: () => getGrantForm(token!),
    enabled: !!token,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** The grant as the agreement would state it. Writes nothing, so it invalidates nothing. */
export function useGrantPreviewMutation() {
  const token = useAuthToken();
  return useMutation({
    mutationKey: CHARTER_TEST_KEYS.grantPreview(),
    mutationFn: (grant: unknown) => previewGrant(requireToken(token), grant),
  });
}

/** The order, with its grant when one is given. The tenant's orders are read again before the
 *  mutation settles. */
export function usePlaceOrderMutation() {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationKey: CHARTER_TEST_KEYS.placeOrder(),
    mutationFn: (input: { companyId: string; grant: unknown }) =>
      placeOrder(requireToken(token), input.companyId, input.grant),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrders(token ?? "") });
    },
  });
}

/** The order's grant, read back: the same for the life of the order, so read once. */
export function useOrderGrantQuery(id: string | null | undefined) {
  const token = useAuthToken();
  return useQuery({
    queryKey: CHARTER_TEST_KEYS.orderGrant(token ?? "", id ?? ""),
    queryFn: () => getOrderGrant(token!, id!),
    enabled: !!token && !!id,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}

/** The adoption to sign, as served. Writes nothing, so it invalidates nothing. */
export function useServedAdoptionMessageMutation(orderId: string) {
  const token = useAuthToken();
  return useMutation({
    mutationKey: CHARTER_TEST_KEYS.adoptionMessage(),
    mutationFn: () => requestAdoptionMessage(requireToken(token), orderId),
  });
}
