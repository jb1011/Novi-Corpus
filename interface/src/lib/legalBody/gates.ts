import {
  ApiError,
  type GuardianIdentityView,
  type Hex,
  type LegalBodyConfig,
} from "@/lib/api/types";
import { walletKindOf } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { WorldIdGateState } from "@/lib/legalBody/worldIdGate";
import { walletSignedIn, type WalletAttempt } from "@/lib/walletSignIn";

/**
 * The doors in front of the legal-body flow, each decided here so a screen only renders it:
 *  1. the deployment offers the flow (`legalBodyDoor`);
 *  2. the wallet is signed in, the server still accepts the session, and the wallet can sign the
 *     declaration (`signInStepState`);
 *  3. a person the real-human check accepts is on record (`humanStepView`, over the World ID
 *     gate's state);
 * and which of them a screen shows (`legalBodyGate`).
 */

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;

/* ── 1. The deployment ─────────────────────────────────────────────────────────────────────── */

export type LegalBodyDoor =
  | { kind: "loading" }
  | { kind: "error"; sentence: string }
  | { kind: "closed"; sentence: string }
  | { kind: "open"; config: AvailableConfig };

/**
 * Whether this deployment offers the flow. Only an explicit `available: true` opens it: a backend
 * that serves no `legalBodies` field offers no door, exactly like `{ available: false }`.
 */
export function legalBodyDoor(answer: {
  status: "loading" | "error" | "ready";
  config: LegalBodyConfig | null | undefined;
}): LegalBodyDoor {
  if (answer.status === "loading") return { kind: "loading" };
  if (answer.status === "error") return { kind: "error", sentence: LEGAL_BODY_COPY.door.unreadable };
  const config = answer.config;
  if (config && config.available === true) return { kind: "open", config };
  return { kind: "closed", sentence: LEGAL_BODY_COPY.door.notOffered };
}

/* ── 2. Sign-in ────────────────────────────────────────────────────────────────────────────── */

/**
 * A refusal that means "sign in": the hooks' own, raised before any request when there is no
 * session, and the server's 401 for a session it no longer accepts. Its message is never shown;
 * the screen goes to the sign-in step instead.
 */
export function isSignInRequired(e: unknown): boolean {
  return e instanceof ApiError && e.code === "unauthorized";
}

export function anySignInRequired(errors: readonly unknown[]): boolean {
  return errors.some(isSignInRequired);
}

/** `getCode` for the signed-in wallet, as its query reports it: null or `0x` for no code. */
export type CodeRead = { status: "pending" | "error" | "success"; data: Hex | null | undefined };

export type SignInStepState =
  | "sign_in"
  | "expired"
  | "checking"
  | "check_failed"
  | "smart_account"
  | "ready";

/**
 * The sign-in step, in order: signed in by the card's own rule (a session, and no connect or
 * sign-in under way or failed); a session the server still accepts; the wallet's code read; and
 * the wallet a plain key, which signs the declaration with a 65-byte signature. A key delegated
 * under EIP-7702 still signs as its key. A smart account is a stop: the declaration cannot take
 * its signature, so there is no Continue.
 */
export function signInStepState(p: {
  hasSession: boolean;
  attempt: WalletAttempt;
  expired: boolean;
  code: CodeRead;
}): SignInStepState {
  if (!walletSignedIn(p.hasSession, p.attempt)) return "sign_in";
  if (p.expired) return "expired";
  if (p.code.status === "pending") return "checking";
  if (p.code.status === "error") return "check_failed";
  return walletKindOf(p.code.data ?? undefined) === "contract" ? "smart_account" : "ready";
}

/* ── Which screen ──────────────────────────────────────────────────────────────────────────── */

/** A gate a person went back to, or acted on: it stays on screen until its Continue. */
export type GateView = "signin" | "human" | null;

export type LegalBodyGate = "signin" | "human" | "flow";

/**
 * Sign-in first, then the person, then the thread. A gate already passed is not shown again
 * unless the person went back to it or is acting on it, so a reload with a live session and an
 * accepted person lands on the thread's own step. Going back to the person never skips sign-in.
 */
/** The identity record holds the human step when production requires it and it is not verified.
 *  A `/me` with no block, and a deployment that does not require it, hold nothing. */
export function identityBlocksGate(identity: GuardianIdentityView | null | undefined): boolean {
  return identity?.required === true && identity.state !== "verified";
}

export function legalBodyGate(p: {
  signIn: SignInStepState;
  human: WorldIdGateState;
  view: GateView;
  identityBlocks?: boolean;
}): LegalBodyGate {
  if (p.signIn !== "ready" || p.view === "signin") return "signin";
  if (p.human.kind !== "accepted" || p.view === "human" || p.identityBlocks === true) return "human";
  return "flow";
}

/**
 * The view a session starts on: the sign-in step when the person signed in on this page, else the
 * human step when they come back from the identity check. The provider sends the person back to
 * the page the check was started from (`?identityCheck=returned`); the human step holds the card
 * with the result, so it stays on screen until its Continue even where nothing else holds it.
 */
export function arrivalGateView(p: { engaged: boolean; returned: boolean }): GateView {
  if (p.engaged) return "signin";
  return p.returned ? "human" : null;
}

/** The view after the sign-in step's Continue: the human step when the person came back from the
 *  check, so a person who had to sign in first still reads the result. */
export function gateViewAfterSignIn(returned: boolean): GateView {
  return returned ? "human" : null;
}

/**
 * Whether the return flag may leave the address now: once the human step is on screen for a
 * session the server answered (its record read). Until then the flag stays, so a session that is
 * refused or cleared a moment later never spends it, and a reload of the sign-in step in front of
 * it still lands on the result.
 */
export function returnTaken(p: {
  returned: boolean;
  gate: LegalBodyGate;
  recordRead: boolean;
}): boolean {
  return p.returned && p.gate === "human" && p.recordRead;
}

/* ── 3. The person ─────────────────────────────────────────────────────────────────────────── */

export type HumanStepView = {
  /** The title keys on accepted, never on "verified": a refused record is not a person on record
   *  for this product. */
  title: "ask" | "accepted";
  /** The line under the seal: reading, no World ID here, a failed read, or the record. */
  line: "checking" | "unavailable" | "unreadable" | "record" | null;
  /** The three points and the help for someone without a World ID. */
  points: boolean;
  verify: boolean;
  continue: boolean;
  retry: boolean;
};

/**
 * The human gate's screen under this product's rule (`requireRealHuman`, `forceRequired`): a
 * record the real-human check refuses offers Verify and never Continue; a deployment without World
 * ID says so and offers no button at all. An accepted person's Continue waits, like the gate, on
 * an identity record that production requires and that is not verified (`identityBlocksGate`).
 * The identity card itself is `identityCardView`'s.
 */
export function humanStepView(
  state: WorldIdGateState,
  identity?: GuardianIdentityView | null,
): HumanStepView {
  const none = {
    title: "ask" as const,
    points: false,
    verify: false,
    continue: false,
    retry: false,
  };
  switch (state.kind) {
    case "loading":
      return { ...none, line: "checking" };
    case "unavailable":
    case "skip":
      // `skip` never comes out of a forced gate; if it did, it is still no way forward.
      return { ...none, line: "unavailable" };
    case "error":
      return { ...none, line: "unreadable", retry: true };
    case "verify":
      return { ...none, line: null, points: true, verify: true };
    case "not_accepted":
      return { ...none, line: "record", points: true, verify: true };
    case "accepted":
      return {
        ...none,
        title: "accepted",
        line: "record",
        continue: !identityBlocksGate(identity),
      };
  }
}

/**
 * A World ID failure in plain words. World's own refusals of the same person and of a dismissed
 * request have their sentence; any other World code is named; anything else is the API's own
 * sentence, shown as served.
 */
export function humanErrorSentence(error: string | null): string | null {
  if (error === null) return null;
  const W = LEGAL_BODY_COPY.human.worldErrors;
  if (!error.startsWith("world:")) return error;
  const code = error.slice("world:".length);
  if (code === "nullifier_replayed" || code === "max_verifications_reached") return W.sameHuman;
  if (code === "user_rejected" || code === "verification_rejected") return W.dismissed;
  return fillCopy(W.other, { code });
}

/* ── What the frame says on every screen ───────────────────────────────────────────────────── */

/**
 * The sandbox said out loud: the banner on a sandbox deployment, and there, when it charges
 * nothing, the one sentence about money. A production deployment shows neither: the money
 * sentence names a testnet.
 */
export function bannerLines(config: AvailableConfig): string[] {
  if (config.environment !== "sandbox") return [];
  const S = LEGAL_BODY_COPY.sandbox;
  return config.paymentRequired ? [S.banner] : [S.banner, S.noPaymentStep];
}
