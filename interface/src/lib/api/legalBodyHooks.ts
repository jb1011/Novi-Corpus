"use client";

/**
 * The legal-body flow's hooks: thin wrappers over `legalBodyClient`.
 *
 * Authenticated keys are scoped by the session's token, like the companies hooks, so a sign-out
 * cannot leave one tenant's orders in another's cache; the token is the one `useAuthToken` reads,
 * for queries and mutations alike. A mutation without a session refuses before any request leaves
 * the browser: the flow renders the sign-in before any of its steps, and a hook here never opens a
 * sign-in prompt of its own.
 *
 * No hook here writes on mount. Every write is a mutation a click calls; the two decisions a hook
 * makes about time, the poll interval and whether the orders list is asked again after a failure,
 * are `orderPollInterval`'s and `retryRead`'s, pure functions with tests.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useConnection, usePublicClient, useWriteContract } from "wagmi";
import { arcTestnet } from "@/lib/chain";
import { sendAllowedCall, type CallContext, type WriteRequest } from "@/lib/legalBody/chain";
import { orderPollInterval, retryRead } from "@/lib/legalBody/polling";
import { potAddresses } from "@/lib/legalBody/safePot";
import { readPotRaw } from "@/lib/legalBody/safePotRules";
import { getTransparency } from "./client";
import { useAuthToken, usePublicConfigQuery } from "./hooks";
import { apiKeys } from "./keys";
import {
  abandonCompany,
  abandonLegalBodyOrder,
  adoptOrder,
  adoptionMessage,
  createCustomerCompany,
  createLegalBodyOrder,
  declareOrderPot,
  getBinding,
  getLegalBodyAgreement,
  getLegalBodyByAgent,
  getLegalBodyOrder,
  getOrderGrant,
  getOrderPot,
  listLegalBodyOrders,
  refreshBinding,
  requestGasSeed,
  requestLinkMessage,
  requestStatementMessage,
  submitLink,
  takePotOffRecord,
} from "./legalBodyClient";
import { ApiError } from "./types";
import type {
  Address,
  CustomerCompanyInput,
  CustomerStatementInput,
  Hex,
  LegalBodyConfig,
  LinkTypedDataWire,
  OrderPotView,
} from "./types";

/** The token a mutation sends, or a refusal before any request: the flow signs in first. */
function requireToken(token: string | undefined): string {
  if (!token) throw new ApiError(401, { code: "unauthorized", message: "sign-in required" });
  return token;
}

/* ── Config ──────────────────────────────────────────────────────────────────────────────── */

/**
 * `/config.legalBodies`, from the one public config query. `ready` carries the deployment's answer;
 * a deployment that does not serve the field offers no legal-body door, which reads as
 * `{ available: false }`. A config already read stays `ready` through a failed retry.
 */
export function useLegalBodyConfig(): {
  status: "loading" | "error" | "ready";
  config: LegalBodyConfig | null;
} {
  const { data, isError } = usePublicConfigQuery();
  if (data) return { status: "ready", config: data.legalBodies ?? { available: false } };
  return { status: isError ? "error" : "loading", config: null };
}

/* ── Orders: reads ───────────────────────────────────────────────────────────────────────── */

/** The tenant's orders. A refusal (a 401, the 403 of an account the real-human check does not
 *  accept) is said at once, never retried (`retryRead`): "My agents" would otherwise wait seconds
 *  on a spinner for an answer it already has, and the flow on its way to the sign-in step. */
export function useLegalBodyOrdersQuery() {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.legalBodyOrders(token ?? ""),
    queryFn: () => listLegalBodyOrders(token!),
    enabled: !!token,
    retry: retryRead,
  });
}

/** One order. With `pollWhileReserved`, it is read again every 5 s while it is `reserved`, and
 *  not at all in any other state. */
export function useLegalBodyOrderQuery(
  id: string | null | undefined,
  options: { pollWhileReserved: boolean },
) {
  const token = useAuthToken();
  const { pollWhileReserved } = options;
  return useQuery({
    queryKey: apiKeys.legalBodyOrder(token ?? "", id ?? ""),
    queryFn: () => getLegalBodyOrder(token!, id!),
    enabled: !!token && !!id,
    refetchInterval: (query) => {
      const order = query.state.data;
      return pollWhileReserved && order ? orderPollInterval(order.state) : false;
    },
  });
}

/** The order's frozen agreement: the same bytes for the life of the order, so read once. */
export function useLegalBodyAgreementQuery(id: string | null | undefined) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.legalBodyAgreement(token ?? "", id ?? ""),
    queryFn: () => getLegalBodyAgreement(token!, id!),
    enabled: !!token && !!id,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useLegalBodyBindingQuery(id: string | null | undefined) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.legalBodyBinding(token ?? "", id ?? ""),
    queryFn: () => getBinding(token!, id!),
    enabled: !!token && !!id,
  });
}

/* ── The company ─────────────────────────────────────────────────────────────────────────── */

/** The statement to sign. Writes nothing, so it invalidates nothing. */
export function useStatementMessageMutation() {
  const token = useAuthToken();
  return useMutation({
    mutationFn: (input: CustomerStatementInput) =>
      requestStatementMessage(requireToken(token), input),
  });
}

/** The company, from the signed statement. The flow reads the tenant's companies next, so the list
 *  is read again before the mutation settles. */
export function useCreateCustomerCompanyMutation() {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: (input: CustomerCompanyInput) => createCustomerCompany(requireToken(token), input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiKeys.companies(token ?? "") });
    },
  });
}

export function useAdoptionMessageMutation(orderId: string) {
  const token = useAuthToken();
  return useMutation({
    mutationFn: () => adoptionMessage(requireToken(token), orderId),
  });
}

export function useAdoptOrderMutation(orderId: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: (body: { issuedAt: string; signature: Hex }) =>
      adoptOrder(requireToken(token), orderId, body),
    onSuccess: async () => {
      if (!token) return;
      await queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrder(token, orderId) });
      await queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrders(token) });
    },
  });
}

export function useAbandonCompanyMutation() {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: (companyId: string) => abandonCompany(requireToken(token), companyId),
    onSuccess: async (_data, companyId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: apiKeys.companies(token ?? "") }),
        queryClient.invalidateQueries({ queryKey: apiKeys.company(token ?? "", companyId) }),
      ]);
    },
  });
}

/* ── Orders: writes ──────────────────────────────────────────────────────────────────────── */

export function useCreateLegalBodyOrderMutation() {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: (companyId: string) => createLegalBodyOrder(requireToken(token), companyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrders(token ?? "") });
    },
  });
}

export function useAbandonLegalBodyOrderMutation(id: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: () => abandonLegalBodyOrder(requireToken(token), id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrder(token ?? "", id) }),
        queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrders(token ?? "") }),
      ]);
    },
  });
}

/** The link to sign. Writes nothing, so it invalidates nothing. */
export function useLinkMessageMutation(id: string) {
  const token = useAuthToken();
  return useMutation({
    mutationFn: (body: { agentId: string; ttlSeconds?: number }) =>
      requestLinkMessage(requireToken(token), id, body),
  });
}

/** Reads again everything a link or a refresh can move: the order, the list and the binding. */
function useInvalidateOrder(id: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrder(token ?? "", id) }),
      queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyOrders(token ?? "") }),
      queryClient.invalidateQueries({ queryKey: apiKeys.legalBodyBinding(token ?? "", id) }),
    ]);
  }, [queryClient, token, id]);
}

/**
 * The signed link. Resolves with the door's answer, a 422 refusal included (`linkSubmitOutcome`
 * reads it). Whatever the door answered, an error included, the order may have moved, so the
 * order, the list and the binding are read again before the mutation settles.
 */
export function useSubmitLinkMutation(id: string) {
  const token = useAuthToken();
  const invalidate = useInvalidateOrder(id);
  return useMutation({
    mutationFn: (body: { message: LinkTypedDataWire["message"]; signature: Hex }) =>
      submitLink(requireToken(token), id, body),
    onSettled: invalidate,
  });
}

/** One binding check now, a click's continuation after the pointer transaction (`refreshPlan`
 *  says when). Reads again what the link does. */
export function useRefreshBindingMutation(id: string) {
  const token = useAuthToken();
  const invalidate = useInvalidateOrder(id);
  return useMutation({
    mutationFn: () => refreshBinding(requireToken(token), id),
    onSettled: invalidate,
  });
}

/** A little native gas for the identity's owner. The order does not change, so nothing is read
 *  again; `gasSeedOutcome` reads a refusal's code. */
export function useGasSeedMutation(id: string) {
  const token = useAuthToken();
  return useMutation({
    mutationFn: () => requestGasSeed(requireToken(token), id),
  });
}

/* ── The company's pot ───────────────────────────────────────────────────────────────────── */

/** The order's noted pot (`{ pot: null }` for none). Read once, and again only when a screen asks
 *  after a transaction: never polled, never retried, never read again on focus, as the by-agent
 *  record. */
export function useOrderPotQuery(id: string | null | undefined, enabled: boolean) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.legalBodyOrderPot(token ?? "", id ?? ""),
    queryFn: () => getOrderPot(token!, id!),
    enabled: enabled && !!token && !!id,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** The order's grant, which caps the pot's ceiling. The same frozen agreement for the life of the
 *  order; a failure is shown with its retry, never retried by itself. */
export function useOrderGrantQuery(id: string | null | undefined, enabled: boolean) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.legalBodyOrderGrant(token ?? "", id ?? ""),
    queryFn: () => getOrderGrant(token!, id!),
    enabled: enabled && !!token && !!id,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** `GET /pot` read now, a click's own read: a request made in the click, never the cached answer
 *  (a stale "no note" is the one way left to plan a pot at another address). Its answer becomes the
 *  pot query's data, so the card reads what the click read. A failure throws, a missing session
 *  as a 401 before any request. */
export function useReadOrderPotNow(id: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useCallback(async (): Promise<OrderPotView | null> => {
    const t = requireToken(token);
    const answer = await getOrderPot(t, id);
    queryClient.setQueryData(apiKeys.legalBodyOrderPot(t, id), answer);
    return answer.pot;
  }, [queryClient, token, id]);
}

/**
 * A pot's raw facts, as one block answered them (`readPotRaw`), through the public client of
 * `chainId`: the noted pot read for the record's agent wallet. One query keyed by the chain and
 * the two addresses; nothing is read until both are given and the chain has the pot's table. Read
 * once as the done page shows it, and again only when a screen asks after a transaction: never
 * retried, never polled, never read again on focus or on reconnect. A failed read is the query's
 * error, never an answer.
 */
export function usePotRawQuery(chainId: number, pot: Address | null, agentWallet: Address | null) {
  const client = usePublicClient({ chainId });
  const addresses = potAddresses(chainId);
  return useQuery({
    queryKey: apiKeys.potRaw(chainId, pot ?? "", agentWallet ?? ""),
    queryFn: () => {
      if (!client || addresses === null || pot === null || agentWallet === null)
        throw new Error("no pot to read");
      return readPotRaw(client, addresses, { pot, agentWallet });
    },
    enabled: !!client && addresses !== null && pot !== null && agentWallet !== null,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** The guardian's note of the pot, before its setup transaction. The answer is the noted pot as the
 *  server now holds it, so it becomes the pot query's data. */
export function useDeclarePotMutation(id: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: (body: Parameters<typeof declareOrderPot>[2]) =>
      declareOrderPot(requireToken(token), id, body),
    onSuccess: (pot) => {
      queryClient.setQueryData(apiKeys.legalBodyOrderPot(token ?? "", id), { pot });
    },
  });
}

/** The pot off the public record. The answer is the noted pot with `onRecord` false, so it becomes
 *  the pot query's data. */
export function useTakePotOffRecordMutation(id: string) {
  const queryClient = useQueryClient();
  const token = useAuthToken();
  return useMutation({
    mutationFn: () => takePotOffRecord(requireToken(token), id),
    onSuccess: (pot) => {
      queryClient.setQueryData(apiKeys.legalBodyOrderPot(token ?? "", id), { pot });
    },
  });
}

/* ── Public reads ────────────────────────────────────────────────────────────────────────── */

/**
 * The public statement by agent, from the API's own origin with no token. Never polled and never
 * retried: the read never throws, and a "could not check" answer is shown as such, not asked
 * again in a loop against a public limiter.
 */
export function useLegalBodyByAgentQuery(agentId: string | null | undefined, enabled: boolean) {
  const token = useAuthToken();
  return useQuery({
    queryKey: apiKeys.legalBodyByAgent(agentId ?? ""),
    queryFn: () => getLegalBodyByAgent(agentId!, token),
    enabled: enabled && !!agentId,
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

/** The public transparency page's data, from the API's own origin with no token. A failure is
 *  shown once with its retry, not retried against the public limiter. */
export function useTransparencyQuery() {
  return useQuery({
    queryKey: apiKeys.transparency(),
    queryFn: getTransparency,
    retry: false,
  });
}

/* ── The wallet ──────────────────────────────────────────────────────────────────────────── */

/** The chains this site is configured for: wagmi's config holds `arcTestnet` alone. */
const CONFIGURED_CHAIN_IDS: readonly number[] = [arcTestnet.id];

/**
 * The one way the flow asks a wallet to write: `sendAllowedCall`, so the allowlist and the chain
 * checks come first, then one `writeContract` of the request it checked.
 *
 * The wallet's chain is `useConnection().chainId`, never `useChainId()`. wagmi's store adopts a
 * connection's chain only when that chain is configured, so with `[arcTestnet]` alone
 * `useChainId()` reports Arc testnet whatever network the wallet sits on: the
 * `wallet_on_another_chain` sentence would never show, and wagmi would refuse the send itself with
 * its own error instead. The connection's chain tracks the wallet. The connected account is read
 * from the same connection: a pot call is sent only from the order's guardian's own account.
 *
 * The cast is the only one of the flow: wagmi resolves the `register` overloads from literal
 * argument tuples, and the request here carries the arguments the allowlist checked as a wide
 * array.
 */
export function useAllowedWrite() {
  const { writeContractAsync } = useWriteContract();
  const { address, chainId } = useConnection();
  const writeContract = useCallback(
    (req: WriteRequest) => writeContractAsync(req as Parameters<typeof writeContractAsync>[0]),
    [writeContractAsync],
  );
  return useCallback(
    (req: WriteRequest, ctx: CallContext) =>
      sendAllowedCall(req, ctx, {
        walletChainId: chainId,
        walletAddress: address,
        configuredChainIds: CONFIGURED_CHAIN_IDS,
        writeContract,
      }),
    [address, chainId, writeContract],
  );
}
