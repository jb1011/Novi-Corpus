/**
 * The start page at `/start`, rendered as the server renders it.
 *
 * The session and the per-account memory live in the browser only, so the server never decides:
 * whatever the browser will find, the markup it hydrates against is the blank. Past the hydration
 * guard (`StartDestination`, rendered here directly), the page reads the deployment's config, then
 * the two legal-body gates, then the choice of paths; and where the full product is offered, the
 * gate that stops a legal body shows one link past it to the full product.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";
import {
  ApiError,
  type AuthSession,
  type CompanyView,
  type Hex,
  type PublicConfig,
  type WorldIdMe,
} from "@/lib/api/types";

const state = vi.hoisted(() => ({
  session: null as AuthSession | null,
  config: { data: undefined as PublicConfig | undefined, isError: false },
  me: { data: undefined as WorldIdMe | undefined, error: null as unknown },
  companies: {
    data: undefined as { companies: CompanyView[] } | undefined,
    error: null as unknown,
  },
  code: { status: "success" as "pending" | "error" | "success", data: undefined as Hex | undefined },
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
  usePublicConfigQuery: () => ({
    data: state.config.data,
    isError: state.config.isError,
    refetch: async () => undefined,
  }),
  useWorldIdMeQuery: () => ({
    data: state.me.data,
    error: state.me.error,
    refetch: async () => undefined,
  }),
  useCompaniesQuery: () => ({
    data: state.companies.data,
    error: state.companies.error,
    refetch: async () => undefined,
  }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useBytecode: () => ({
    status: state.code.status,
    data: state.code.data,
    refetch: async () => undefined,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

import { StartDestination, StartFlow } from "@/components/start/StartFlow";
import { FlowHeader } from "@/components/legalBody/FlowFrame";
import { metadata } from "@/app/start/page";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyGate, SignInStepState } from "@/lib/legalBody/gates";
import { START_COPY } from "@/lib/start/copy";
import { escapeToFullProduct, pathCards, type PathCard, type PathId } from "@/lib/start/paths";

const C = START_COPY.cards;
const S = LEGAL_BODY_COPY.signIn;
const H = LEGAL_BODY_COPY.human;
const TITLES = [C.form.title, C.declare.title, C.full.title];

const TENANT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SESSION: AuthSession = { token: "t", address: TENANT, expiresAt: 0 } as AuthSession;

/** A legal-body config that offers both doors on testnet, with the fields a case changes. */
const lb = (over: object = {}) =>
  ({
    available: true,
    declarations: true,
    environment: "sandbox",
    formedDoor: "offered",
    filingWorkingDays: 5,
    paymentRequired: false,
    ...over,
  }) as never;

const base: PublicConfig = { walletProviderDefault: "circle", circleCustodyAvailable: true };
/** Testnet today: the two legal-body doors and the full product. */
const TESTNET: PublicConfig = { ...base, fullProductAvailable: true, legalBodies: lb() };
/** Mainnet before invitations: the declared door alone, no full product. */
const MAINNET: PublicConfig = {
  ...base,
  fullProductAvailable: false,
  legalBodies: lb({ environment: "production", formedDoor: "hidden" }),
};

const ACCEPTED: WorldIdMe = { verified: true, required: true, credential: "orb", realHuman: true };
const WAIVER: WorldIdMe = { verified: true, required: true, credential: "waiver", realHuman: false };
/** A deployed contract's code: a smart account, which cannot sign the declaration. */
const SMART_ACCOUNT_CODE = "0x6080604052348015600f57600080fd5b50" as Hex;

/** Every input at its "signed in, accepted, lists read" value, then the case's changes. */
function given(over: {
  session?: AuthSession | null;
  config?: PublicConfig | undefined;
  configError?: boolean;
  me?: WorldIdMe | undefined;
  meError?: unknown;
  companies?: CompanyView[] | undefined;
  companiesError?: unknown;
  code?: { status: "pending" | "error" | "success"; data: Hex | undefined };
  search?: string;
}) {
  state.session = "session" in over ? (over.session ?? null) : SESSION;
  state.config = {
    data: "config" in over ? over.config : TESTNET,
    isError: over.configError ?? false,
  };
  state.me = { data: "me" in over ? over.me : ACCEPTED, error: over.meError ?? null };
  state.companies = {
    data: "companies" in over ? (over.companies ? { companies: over.companies } : undefined) : { companies: [] },
    error: over.companiesError ?? null,
  };
  state.code = over.code ?? { status: "success", data: undefined };
  state.search = over.search ?? "";
}

/** The markup, with the apostrophes a person reads ("My agent's company") as they read them. */
function render(component: typeof StartFlow | typeof StartDestination | typeof FlowHeader): string {
  const html = renderToString(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(component)),
  );
  return html.replace(/&#x27;/g, "'");
}

/** The opening tag of the radio for one path. */
const radio = (html: string, id: PathId) =>
  html.match(new RegExp(`<input[^>]*value="${id}"[^>]*>`))?.[0] ?? null;

/** A button's opening tag, found by its label. */
const buttonWith = (html: string, label: string) =>
  html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}`, "s"))?.[0] ?? null;

const CHECKED = /\schecked=""/;
const DISABLED = /\sdisabled=""/;

describe("the server render of /start", () => {
  test("with a session and a config that offers every path: the blank, nothing that lives in the browser", () => {
    given({});
    const html = render(StartFlow);
    expect(html).toContain('class="min-h-screen bg-paper"');
    for (const title of TITLES) expect(html).not.toContain(title);
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain(START_COPY.title);
    expect(html).not.toContain(START_COPY.needs);
    expect(html).not.toContain(START_COPY.escape.sentence);
  });

  test("with no session: the same blank, never the sign-in card", () => {
    given({ session: null });
    const html = render(StartFlow);
    expect(html).toContain('class="min-h-screen bg-paper"');
    for (const title of TITLES) expect(html).not.toContain(title);
    expect(html).not.toContain("Sign in");
    expect(html).not.toContain(START_COPY.title);
  });

  test("the page's title", () => {
    expect(metadata.title).toBe("Get started: Novi Corpus");
    expect(metadata.title).toBe(START_COPY.page.title);
  });
});

describe("the deployment decides first", () => {
  test("a config still loading: an empty busy page, no card and no sign-in", () => {
    given({ config: undefined });
    const html = render(StartDestination);
    expect(html).toContain('aria-busy="true"');
    for (const title of TITLES) expect(html).not.toContain(title);
    expect(html).not.toContain(S.title);
  });

  test("a config that cannot be read: its sentence and a retry, never a guess", () => {
    given({ config: undefined, configError: true });
    const html = render(StartDestination);
    expect(html).toContain(START_COPY.unreadable);
    expect(buttonWith(html, START_COPY.retry)).not.toBeNull();
    for (const title of TITLES) expect(html).not.toContain(title);
    expect(html).not.toContain(S.title);
  });

  test("a deployment with no way in: its sentence and the way home", () => {
    given({ config: { ...base, fullProductAvailable: false, legalBodies: { available: false } } });
    const html = render(StartDestination);
    expect(html).toContain(START_COPY.none);
    expect(html).toMatch(new RegExp(`<a[^>]*href="/"[^>]*>${START_COPY.home}</a>`));
    expect(html).not.toContain(S.title);
  });

  test("the full product alone: no gate and no choice, the page is on its way to the wizard", () => {
    given({ config: { ...base, fullProductAvailable: true, legalBodies: { available: false } } });
    const html = render(StartDestination);
    expect(html).toContain('aria-busy="true"');
    for (const title of TITLES) expect(html).not.toContain(title);
    expect(html).not.toContain(S.title);
  });
});

describe("the gates", () => {
  test("no session: the sign-in step alone, with no way past it", () => {
    given({ session: null });
    const html = render(StartDestination);
    expect(html).toContain(S.title);
    expect(html).not.toContain(START_COPY.title);
    expect(html).not.toContain(START_COPY.escape.sentence);
  });

  test("a smart account on testnet: the stop, and the link past it to the full product", () => {
    given({ code: { status: "success", data: SMART_ACCOUNT_CODE } });
    const html = render(StartDestination);
    expect(html).toContain(S.smartAccountTitle);
    expect(html).toContain(START_COPY.escape.sentence);
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="/onboarding\\?new=1"[^>]*>${START_COPY.escape.link}</a>`),
    );
    expect(html).not.toContain(START_COPY.title);
  });

  test("a smart account where the full product is not offered: the stop alone", () => {
    given({ config: MAINNET, code: { status: "success", data: SMART_ACCOUNT_CODE } });
    const html = render(StartDestination);
    expect(html).toContain(S.smartAccountTitle);
    expect(html).not.toContain(START_COPY.escape.sentence);
  });

  test("a wallet still being read: the sign-in step, and no link past it", () => {
    given({ code: { status: "pending", data: undefined } });
    const html = render(StartDestination);
    expect(html).toContain(S.checking);
    expect(html).not.toContain(START_COPY.escape.sentence);
    expect(html).not.toContain(START_COPY.title);
  });

  test("a waiver on testnet: the human step, and the link past it to the full product", () => {
    given({ me: WAIVER });
    const html = render(StartDestination);
    expect(html).toContain(H.notAccepted);
    expect(html).toContain(START_COPY.escape.sentence);
    expect(html).toContain('href="/onboarding?new=1"');
    expect(html).not.toContain(START_COPY.title);
  });

  test("a waiver where the full product is not offered: the human step alone", () => {
    given({ config: MAINNET, me: WAIVER });
    const html = render(StartDestination);
    expect(html).toContain(H.notAccepted);
    expect(html).not.toContain(START_COPY.escape.sentence);
    expect(html).not.toContain(START_COPY.title);
  });

  test("a session the server no longer accepts, said by the companies read: back to sign-in", () => {
    given({
      companies: undefined,
      companiesError: new ApiError(401, { code: "unauthorized", message: "session expired" }),
    });
    const html = render(StartDestination);
    expect(html).toContain(S.expiredTitle);
    expect(html).not.toContain("session expired");
    expect(html).not.toContain(START_COPY.title);
  });

  test("a session the server no longer accepts, said by the record read: back to sign-in", () => {
    given({
      me: undefined,
      meError: new ApiError(401, { code: "unauthorized", message: "session expired" }),
    });
    const html = render(StartDestination);
    expect(html).toContain(S.expiredTitle);
    expect(html).not.toContain(START_COPY.title);
  });
});

describe("the return from the identity check", () => {
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/${file}`, import.meta.url)), "utf8");
  const PAGES = [
    ["start/StartFlow.tsx", "/start"],
    ["legalBody/LegalBodyFlow.tsx", "/legal-body"],
  ] as const;

  test("back from the check on the testnet: the human step with its Continue, not the choice of paths", () => {
    given({ search: "identityCheck=returned" });
    const html = render(StartDestination);
    expect(html).toContain(H.titleAccepted);
    expect(html).not.toContain(START_COPY.title);
    given({});
    expect(render(StartDestination)).toContain(START_COPY.title);
  });

  test("back from the check to a session that ended while the person was away: sign-in first", () => {
    given({
      search: "identityCheck=returned",
      companies: undefined,
      companiesError: new ApiError(401, { code: "unauthorized", message: "session expired" }),
    });
    const html = render(StartDestination);
    expect(html).toContain(S.expiredTitle);
    expect(html).not.toContain(H.titleAccepted);
    expect(html).not.toContain(START_COPY.title);
  });

  test("back from the check to a tab with no session: the sign-in step, never the choice", () => {
    given({ session: null, search: "identityCheck=returned" });
    const html = render(StartDestination);
    expect(html).toContain(S.title);
    expect(html).not.toContain(START_COPY.title);
  });

  // The render tests (here, and `legalBodyFlowReturn.server.test.ts` for `/legal-body`) show
  // each page reading the return. No render reaches a click, so the two handlers that carry the
  // return on are pinned by their source: the sign-in step's Continue, and the human step's, where
  // the return is spent (`addressAfterContinue`).
  test("both pages spend the return on the human step's Continue, the flag leaving the address there and nowhere else, and name their own return path", () => {
    for (const [file, path] of PAGES) {
      const code = read(file);
      expect(code, file).toContain(`returnPath="${path}"`);
      expect(code, file).toContain("onContinue={() => setView(gateViewAfterSignIn(returned))}");
      expect(code, file).toMatch(
        new RegExp(
          String.raw`onContinue=\{\(\) => \{\s*(?://[^\n]*\n\s*)*` +
            String.raw`const address = addressAfterContinue\(\{\s*returned,\s*path: "${path}",\s*search: window\.location\.search,\s*\}\);\s*` +
            String.raw`if \(address !== null\) window\.history\.replaceState\(null, "", address\);\s*` +
            String.raw`setReturned\(false\);\s*setView\(null\);\s*\}\}`,
        ),
      );
      // The flag leaves the address in that one place, in place, and never by a navigation.
      expect(code.match(/replaceState\(/g), file).toHaveLength(1);
      expect(code, file).not.toContain("returnTaken(");
      expect(code, file).not.toMatch(/router\.(replace|push)\([^)]*identityCheck/);
    }
  });
});

describe("the choice", () => {
  test("signed in and accepted, with the declared path asked for: the choice, that card selected", () => {
    given({ search: "path=declare" });
    const html = render(StartDestination);
    expect(html).toContain(START_COPY.title);
    for (const title of TITLES) expect(html).toContain(title);
    expect(radio(html, "declare")).toMatch(CHECKED);
    expect(radio(html, "form")).not.toMatch(CHECKED);
    expect(radio(html, "full")).not.toMatch(CHECKED);
    expect(buttonWith(html, START_COPY.continue)).not.toMatch(DISABLED);
    expect(html).not.toContain(START_COPY.escape.sentence);
  });

  test("an address parameter outside the three names picks nothing: the first card", () => {
    given({ search: "path=Declare" });
    const html = render(StartDestination);
    expect(radio(html, "form")).toMatch(CHECKED);
    expect(radio(html, "declare")).not.toMatch(CHECKED);
  });

  test("the facts come from the config: testnet's lines on the cards", () => {
    given({});
    const html = render(StartDestination);
    expect(html).toContain(C.form.timeSandbox);
    expect(html).toContain(C.declare.needsSandbox);
    expect(html).toContain("No payment on testnet");
  });

  test("the choice on the start carries no back link of its own: the header has the way to the account", () => {
    given({});
    expect(render(StartDestination)).not.toContain(START_COPY.backToAgents);
  });

  test("the companies list still being read: Continue waits", () => {
    given({ companies: undefined });
    const html = render(StartDestination);
    expect(html).toContain(START_COPY.title);
    expect(buttonWith(html, START_COPY.continue)).toMatch(DISABLED);
  });

  test("a companies list that cannot be read: its sentence and a retry", () => {
    given({
      companies: undefined,
      companiesError: new ApiError(500, { code: "internal", message: "boom" }),
    });
    const html = render(StartDestination);
    expect(html).toContain(START_COPY.companiesUnreadable);
    expect(buttonWith(html, START_COPY.retry)).not.toBeNull();
    expect(html).not.toContain("boom");
  });
});

describe("the header of /start and /legal-body", () => {
  const F = LEGAL_BODY_COPY.frame;
  const link = (html: string, href: string) =>
    html.match(new RegExp(`<a[^>]*href="${href}"[^>]*>([^<]*)</a>`))?.[1] ?? null;

  test("signed in: a link to My agents beside Exit, so a stored new company never hides the account's legal bodies", () => {
    given({});
    const html = render(FlowHeader);
    expect(link(html, "/agents")).toBe(F.myAgents);
    expect(link(html, "/")).toBe(F.exit);
    expect(F.myAgents).toBe("My agents");
  });

  test("no session: Exit alone", () => {
    given({ session: null });
    const html = render(FlowHeader);
    expect(html).not.toContain('href="/agents"');
    expect(html).not.toContain(F.myAgents);
    expect(link(html, "/")).toBe(F.exit);
  });
});

describe("the one link past the gate", () => {
  const withFull: PathCard[] = pathCards(TESTNET);
  const withoutFull: PathCard[] = pathCards(MAINNET);
  const gates: LegalBodyGate[] = ["signin", "human", "flow"];
  const signIns: SignInStepState[] = [
    "sign_in",
    "expired",
    "checking",
    "check_failed",
    "smart_account",
    "ready",
  ];

  test("never where the full product is not offered", () => {
    for (const gate of gates)
      for (const signIn of signIns)
        expect(escapeToFullProduct({ cards: withoutFull, gate, signIn })).toBe(false);
    expect(escapeToFullProduct({ cards: [], gate: "human", signIn: "ready" })).toBe(false);
  });

  test("under the human step always", () => {
    for (const signIn of signIns)
      expect(escapeToFullProduct({ cards: withFull, gate: "human", signIn })).toBe(true);
  });

  test("under the sign-in step only for a smart account", () => {
    for (const signIn of signIns)
      expect(escapeToFullProduct({ cards: withFull, gate: "signin", signIn })).toBe(
        signIn === "smart_account",
      );
  });

  test("never on the choice, which has its own card", () => {
    for (const signIn of signIns)
      expect(escapeToFullProduct({ cards: withFull, gate: "flow", signIn })).toBe(false);
  });
});
