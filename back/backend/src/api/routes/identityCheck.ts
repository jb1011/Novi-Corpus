import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError, z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import {
  type IdentitySessionDeps,
  type SessionView,
  type StartedSession,
  type SyncOutcome,
  sessionView,
  startSession,
  syncSession,
} from "../../identity/sessions";
import { identityView } from "../../identity/state";
import type { IdentityState } from "../../identity/types";
import { opsLog } from "../../observability/opsLog";
import { ApiError, readJson } from "../errors";

/**
 * THE IDENTITY CHECK ROUTES: the guardian's identity step in the browser. World ID proves one
 * real person; the identity check says who.
 *
 *  - `POST /identity-check/sessions` with `{ firstName, lastName, returnPath? }` starts the
 *    guardian's identity check, or reuses the one under way: 201 with `{ sessionId, url,
 *    expiresAt }`, our session id (never the provider's), the provider's page the person is sent
 *    to, and when that page stops taking them;
 *  - `GET /identity-check/session` shows the tenant's open session, ids and counts only, or
 *    `{ status: "none" }`;
 *  - `POST /identity-check/sync` reads the tenant's open session back from the provider (the
 *    person is back on the page, or the card checks again) and answers `{ outcome, state }`: what
 *    the read did, and the identity state as `/world-id/me` shows it. Without an open session it
 *    reads nothing: `{ outcome: "unchanged", state }`. At most one call every 5 seconds per
 *    tenant, else 429 `identity_sync_too_soon`; a refused call does not move the window.
 *
 * Every rule of a check is the service's (`identity/sessions.ts`), the names and the return path
 * included: these handlers check only the body's shape. The three routes answer 404
 * `identity_check_not_offered` where the deployment does not run the check automatically, are
 * mounted under the app's session protection of the `/identity-check` prefix, and answer with
 * `Cache-Control: private, no-store`, their refusals too.
 *
 * No answer carries the provider's session id, a name or a birth date: the start's answer is
 * passed on field by field, and the view is the service's, ids and counts only. An error the
 * routes did not choose (anything but an `ApiError` or a `ZodError`) answers 500 `internal_error`
 * with a fixed sentence, after one ops line naming the route and the error's name: the app's own
 * handler would render the message of any error with a numeric `status`, and a provider's error
 * may carry one.
 */

/** The largest body the start reads, in bytes: two names and a path are a few hundred. */
export const IDENTITY_CHECK_MAX_BODY_BYTES = 4 * 1024;
/** The sync's window per tenant. */
export const IDENTITY_SYNC_MIN_INTERVAL_MS = 5_000;

/** The start's body. The names and the path are checked by the service (`startSession`). */
const StartBody = z.object({
  firstName: z.string(),
  lastName: z.string(),
  returnPath: z.string().optional(),
});

type Route = "start" | "session" | "sync";
type IdentityCheckContext = Context<{ Variables: AuthVars }>;

/** The service's deps, or 404 where the deployment does not run the check automatically. */
function offered(deps: { identityCheck?: IdentitySessionDeps }): IdentitySessionDeps {
  if (deps.identityCheck === undefined)
    throw new ApiError(
      "identity_check_not_offered",
      404,
      "the identity check does not run automatically on this deployment",
    );
  return deps.identityCheck;
}

/** The route's answer, uncached, or the 500 `internal_error` for anything it did not choose. */
async function answer(
  c: IdentityCheckContext,
  route: Route,
  run: () => Response | Promise<Response>,
): Promise<Response> {
  // Set first, so a refusal rendered by the app's error handler carries it too.
  c.header("Cache-Control", "private, no-store");
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError || err instanceof ZodError) throw err;
    opsLog("identity_check_route_failed", {
      level: "error",
      route,
      errorName: err instanceof Error ? err.name : "not_an_error",
    });
    throw new ApiError(
      "internal_error",
      500,
      "something went wrong on our side: try again in a moment",
    );
  }
}

/**
 * The sync's throttle: at most one call every `IDENTITY_SYNC_MIN_INTERVAL_MS` per tenant, counted
 * from the last call taken. A clock set back since that call does not hold the tenant until it
 * catches up. The map holds only the tenants that called within the window: a tenant taken is
 * moved to its end, and the entries at its front whose window has passed are dropped.
 */
function syncThrottle(): (tenantId: string, nowMs: number) => void {
  const lastCall = new Map<string, number>();
  return (tenantId, nowMs) => {
    const last = lastCall.get(tenantId);
    const elapsed = last === undefined ? undefined : nowMs - last;
    if (elapsed !== undefined && elapsed >= 0 && elapsed < IDENTITY_SYNC_MIN_INTERVAL_MS)
      throw new ApiError(
        "identity_sync_too_soon",
        429,
        "the identity check was read a moment ago: wait a few seconds before reading it again",
      );
    lastCall.delete(tenantId);
    lastCall.set(tenantId, nowMs);
    for (const [key, at] of lastCall) {
      if (nowMs - at < IDENTITY_SYNC_MIN_INTERVAL_MS) break;
      lastCall.delete(key);
    }
  };
}

/** The identity state as `/world-id/me` shows it, read as this deployment reads it. */
function stateOf(check: IdentitySessionDeps, tenantId: string): IdentityState {
  return identityView(check.identity, check.world, tenantId, check.environment).state;
}

export function mountIdentityCheckRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: { identityCheck?: IdentitySessionDeps },
): void {
  const limit = bodyLimit({
    maxSize: IDENTITY_CHECK_MAX_BODY_BYTES,
    onError: () => {
      throw new ApiError(
        "payload_too_large",
        413,
        "the request body is too large: the identity check reads at most 4 KiB",
      );
    },
  });
  // One per mounted app: a second app keeps its own.
  const throttle = syncThrottle();

  app.post("/identity-check/sessions", limit, (c) =>
    answer(c, "start", async () => {
      const check = offered(deps);
      const body = StartBody.parse(await readJson(c));
      const started: StartedSession = await startSession(check, c.get("tenantId"), {
        firstName: body.firstName,
        lastName: body.lastName,
        returnPath: body.returnPath,
      });
      return c.json(
        { sessionId: started.sessionId, url: started.url, expiresAt: started.expiresAt },
        201,
      );
    }),
  );

  app.get("/identity-check/session", (c) =>
    answer(c, "session", () => {
      const check = offered(deps);
      const view: SessionView = sessionView(check, c.get("tenantId"));
      return c.json(view);
    }),
  );

  app.post("/identity-check/sync", (c) =>
    answer(c, "sync", async () => {
      const check = offered(deps);
      const tenantId = c.get("tenantId");
      throttle(tenantId, (check.now ?? Date.now)());
      const view = sessionView(check, tenantId);
      const outcome: SyncOutcome =
        view.status === "open" ? await syncSession(check, view.sessionId) : "unchanged";
      return c.json({ outcome, state: stateOf(check, tenantId) });
    }),
  );
}
