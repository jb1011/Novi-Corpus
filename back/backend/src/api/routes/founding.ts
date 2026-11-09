import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuthVars } from "../../auth/middleware";
import { FOUNDING_SPOTS, type FoundingDeps, foundingOpen } from "../../founding/config";
import { insertApplication } from "../../founding/repository";
import { applicationSchema, honeypotFilled } from "../../founding/schema";
import { opsLog } from "../../observability/opsLog";
import { ApiError } from "../errors";

type App = Hono<{ Variables: AuthVars }>;

const NO_STORE = "no-store";

/**
 * Public apply form.
 *
 * `via` is not a field a caller can set. This route always stores `web`. An MCP tool, if one is
 * added later, would call the repository itself with `mcp`.
 */
export function mountFoundingRoutes(app: App, deps: { founding: FoundingDeps }): void {
  const now = () => deps.founding.now?.() ?? Date.now();
  const noStore: MiddlewareHandler = async (c, next) => {
    c.header("Cache-Control", NO_STORE);
    await next();
  };
  app.use("/founding/applications", noStore);

  app.get("/founding/config", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json({
      open: foundingOpen(deps.founding),
      spots: FOUNDING_SPOTS,
    });
  });

  app.post("/founding/applications", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new ApiError("validation_error", 400, "invalid JSON body");
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }

    if (!foundingOpen(deps.founding)) {
      throw new ApiError("applications_closed", 403, "Applications are closed");
    }

    const caller = callerKey(c.req.header("x-forwarded-for"));
    if (!deps.founding.take(caller)) {
      throw new ApiError("rate_limited", 429, "Too many applications from this network");
    }

    // A filled honeypot looks like success and stores nothing, so the sender cannot tell the
    // field was the reason.
    if (honeypotFilled(body)) {
      opsLog("founding_honeypot", {});
      return c.json({ id: randomUUID() });
    }

    const input = applicationSchema.parse(body);
    const id = randomUUID();
    const at = now();
    try {
      insertApplication(deps.founding.db, {
        id,
        createdAt: at,
        email: input.email,
        xHandle: input.xHandle,
        agentName: input.agentName,
        description: input.description,
        utm: input.utm,
      });
    } catch (err) {
      if (isUnique(err)) {
        throw new ApiError(
          "already_applied",
          409,
          "An application with this email or X handle is already in",
        );
      }
      throw err;
    }
    // The id only. The email and the description never enter the log.
    opsLog("founding_application", { id });
    return c.json({ id });
  });
}

/**
 * The last non-empty `X-Forwarded-For` entry, or `direct` when the request arrived with none.
 *
 * Last, because every entry before it is a value the caller was free to invent. This is the same
 * choice the public legal-body limiter makes. The value keys the in-memory limiter and is not stored.
 */
export function callerKey(header: string | undefined): string {
  const appended = header
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
    .pop();
  return appended ?? "direct";
}

function isUnique(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
