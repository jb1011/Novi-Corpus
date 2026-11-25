/**
 * The flow at `/legal-body` coming back from the identity check, rendered as the server renders
 * it past the hydration guard (`LegalBodyFrame`): the provider sends the person back to the page
 * the check was started from (`?identityCheck=returned`), and the page holds the human step, with
 * the card's result, until its Continue. Never the thread or the choice of paths before it; after
 * the sign-in step when the session is gone or no longer accepted.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";
import {
  ApiError,
  type AuthSession,
  type CompanyView,
  type IdentitySessionView,
  type PublicConfig,
  type WorldIdMe,
} from "@/lib/api/types";

const state = vi.hoisted(() => ({
  session: null as AuthSession | null,
  config: undefined as PublicConfig | undefined,
  me: { data: undefined as WorldIdMe | undefined, error: null as unknown },
  companies: { data: undefined as { companies: CompanyView[] } | undefined, error: null as unknown },
  identitySession: { status: "none" } as unknown,
  search: "",
}));

vi.mock("@/components/onboarding/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => ({
    session: state.session,
    address: state.session?.address,
    isConnected: state.session !== null,
    isConnecting: false,
    isLoggingIn: false,
    connectWallet: async () => {},
    login: async () => {},
    logout: () => {},
    ensureSession: async () => state.session,
  }),
}));

vi.mock("@/components/providers/Web3Provider", () => ({
  Web3Provider: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/lib/api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/hooks")>()),
  usePublicConfigQuery: () => ({ data: state.config, isError: false, refetch: async () => undefined }),
  useWorldIdMeQuery: () => ({
    data: state.me.data,
    error: state.me.error,
    refetch: async () => undefined,
  }),
  useCompaniesQuery: () => ({
    data: state.companies.data,
    error: state.companies.error,
    dataUpdatedAt: 0,
    refetch: async () => undefined,
  }),
}));

vi.mock("@/lib/api/legalBodyHooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/legalBodyHooks")>()),
  useLegalBodyOrdersQuery: () => ({
    data: { orders: [] },
    error: null,
    dataUpdatedAt: 0,
    refetch: async () => undefined,
  }),
  useIdentityCheckSessionQuery: () => ({
    data: state.identitySession,
    error: null,
    dataUpdatedAt: 0,
    isFetchedAfterMount: false,
    refetch: async () => undefined,
  }),
  useStartIdentityCheckMutation: () => ({
    mutateAsync: async () => ({}),
    isPending: false,
    reset() {},
  }),
  useSyncIdentityCheckMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useBytecode: () => ({ status: "success", data: undefined, refetch: async () => undefined }),
  useReadContract: () => ({
    status: "pending",
    data: undefined,
    error: null,
    refetch: async () => undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

import { LegalBodyFrame } from "@/components/legalBody/LegalBodyFlow";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { START_COPY } from "@/lib/start/copy";

const S = LEGAL_BODY_COPY.signIn;
const H = LEGAL_BODY_COPY.human;
const A = H.guardianIdentity.automatic;

const TENANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SESSION: AuthSession = { token: "t", address: TENANT, expiresAt: 0 } as AuthSession;

/** Testnet today: both legal-body doors, and the identity check offered as a test. */
const TESTNET: PublicConfig = {
  walletProviderDefault: "circle",
  circleCustodyAvailable: true,
  fullProductAvailable: true,
  legalBodies: {
    available: true,
    declarations: true,
    environment: "sandbox",
    formedDoor: "offered",
    filingWorkingDays: 5,
    paymentRequired: false,
  } as never,
};

/** An accepted person, with the identity record the card reads. */
const ACCEPTED: WorldIdMe = {
  verified: true,
  required: true,
  credential: "orb",
  realHuman: true,
  identity: { required: false, automatic: true, state: "none" },
};

function given(over: {
  session?: AuthSession | null;
  me?: WorldIdMe;
  companiesError?: unknown;
  identitySession?: IdentitySessionView;
  search?: string;
}) {
  state.session = "session" in over ? (over.session ?? null) : SESSION;
  state.config = TESTNET;
  state.me = { data: over.me ?? ACCEPTED, error: null };
  state.companies = over.companiesError
    ? { data: undefined, error: over.companiesError }
    : { data: { companies: [] }, error: null };
  state.identitySession = over.identitySession ?? { status: "none" };
  state.search = over.search ?? "";
}

/** The markup, with the apostrophes a person reads as they read them. */
function render(): string {
  const html = renderToString(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(LegalBodyFrame)),
  );
  return html.replace(/&#x27;/g, "'");
}

/** A button's label as React renders it, so a sentence that contains the word does not count. */
const button = (label: string) => new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`, "s");

describe("the return from the identity check on /legal-body", () => {
  test("back from the check on the testnet: the human step with the card and its Continue, not the choice of paths", () => {
    given({ search: "identityCheck=returned" });
    const html = render();
    expect(html).toContain(H.titleAccepted);
    expect(html).toContain(A.why);
    expect(html).toMatch(button(H.continue));
    expect(html).not.toContain(START_COPY.title);

    // The same person without the flag: past the gates, on the thread.
    given({});
    const past = render();
    expect(past).not.toContain(H.titleAccepted);
    expect(past).toContain(START_COPY.title);
  });

  test("an order named in the address waits behind the human step", () => {
    given({ search: "order=o_1&identityCheck=returned" });
    const html = render();
    expect(html).toContain(H.titleAccepted);
    expect(html).not.toContain(START_COPY.title);
  });

  test("back from the check to a session that ended while the person was away: sign-in first", () => {
    given({
      search: "identityCheck=returned",
      companiesError: new ApiError(401, { code: "unauthorized", message: "session expired" }),
    });
    const html = render();
    expect(html).toContain(S.expiredTitle);
    expect(html).not.toContain(H.titleAccepted);
    expect(html).not.toContain(START_COPY.title);
  });

  test("back from the check to a tab with no session: the sign-in step, never the thread", () => {
    given({ session: null, search: "identityCheck=returned" });
    const html = render();
    expect(html).toContain(S.title);
    expect(html).not.toContain(H.titleAccepted);
    expect(html).not.toContain(START_COPY.title);
  });
});
