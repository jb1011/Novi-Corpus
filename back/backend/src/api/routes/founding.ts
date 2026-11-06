import { createHash, randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuthVars } from "../../auth/middleware";
import { requireAuth } from "../../auth/middleware";
import { FOUNDING_SPOTS, type FoundingDeps, foundingOpen } from "../../founding/config";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  findApplication,
  insertApplication,
  listApplications,
  setApplicationStatus,
  upsertReview,
} from "../../founding/repository";
import {
  applicationSchema,
  honeypotFilled,
  reviewSchema,
  statusSchema,
} from "../../founding/schema";
import { opsLog } from "../../observability/opsLog";
import { ApiError } from "../errors";

type App = Hono<{ Variables: AuthVars }>;

const NO_STORE = "no-store";

/**
 * Public apply form plus the reviewer surface.
 *
 * `via` is not a field a caller can set. This route always stores `web`. An MCP tool, if one is
 * added later, would call the repository itself with `mcp`.
 *
 * Marking a row `winner` or `waitlist` changes the label only. It does not mint an invite, verify
 * World ID, or waive a formation fee.
 */
export function mountFoundingRoutes(
  app: App,
  deps: { jwtSecret: string; founding: FoundingDeps },
): void {
  const now = () => deps.founding.now?.() ?? Date.now();
  const noStore: MiddlewareHandler = async (c, next) => {
    c.header("Cache-Control", NO_STORE);
    await next();
  };
  app.use("/founding/applications", noStore);
  app.use("/founding/applications/*", noStore);

  app.get("/founding/config", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    const at = now();
    return c.json({
      open: foundingOpen(deps.founding, at),
      closesAt: deps.founding.closesAt,
      picksAt: deps.founding.picksAt,
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

    if (!foundingOpen(deps.founding, now())) {
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
        ipHash: hashIp(deps.founding.ipSalt, caller),
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

  const auth = requireAuth(deps.jwtSecret);
  const reviewer = requireReviewer(deps.founding.admins);

  app.get("/founding/applications", auth, reviewer, (c) => {
    const status = readEnum(c.req.query("status"), APPLICATION_STATUSES, "status");
    const sort = c.req.query("sort") ?? "date";
    const dir = c.req.query("dir") ?? "desc";
    if (sort !== "score" && sort !== "date") {
      throw new ApiError("validation_error", 400, "sort must be score or date");
    }
    if (dir !== "asc" && dir !== "desc") {
      throw new ApiError("validation_error", 400, "dir must be asc or desc");
    }
    return c.json({
      applications: listApplications(deps.founding.db, { status, sort, dir }),
    });
  });

  app.get("/founding/applications.csv", auth, reviewer, (c) => {
    const applications = listApplications(deps.founding.db, {
      status: null,
      sort: "date",
      dir: "desc",
    });
    return c.body(toCsv(applications), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="founding-applications.csv"',
    });
  });

  app.get("/founding/applications/:id", auth, reviewer, (c) => {
    const row = findApplication(deps.founding.db, c.req.param("id"));
    if (!row) throw new ApiError("not_found", 404, "application not found");
    return c.json({ application: row });
  });

  app.put("/founding/applications/:id/review", auth, reviewer, async (c) => {
    const input = reviewSchema.parse(await readObject(c));
    const reviewerAddress = c.get("tenantId");
    const saved = upsertReview(deps.founding.db, {
      applicationId: c.req.param("id"),
      reviewer: reviewerAddress,
      useCase: input.useCase,
      moneyFlow: input.moneyFlow,
      builder: input.builder,
      note: input.note,
      updatedAt: now(),
    });
    if (!saved) throw new ApiError("not_found", 404, "application not found");
    opsLog("founding_review", { id: c.req.param("id"), reviewer: reviewerAddress });
    return c.json({
      review: {
        reviewer: reviewerAddress,
        useCase: input.useCase,
        moneyFlow: input.moneyFlow,
        builder: input.builder,
        note: input.note,
      },
    });
  });

  app.patch("/founding/applications/:id", auth, reviewer, async (c) => {
    const input = statusSchema.parse(await readObject(c));
    const saved = setApplicationStatus(deps.founding.db, c.req.param("id"), input.status);
    if (!saved) throw new ApiError("not_found", 404, "application not found");
    opsLog("founding_status", { id: c.req.param("id"), status: input.status });
    return c.json({ id: c.req.param("id"), status: input.status });
  });
}

/**
 * The last non-empty `X-Forwarded-For` entry, or `direct` when the request arrived with none.
 *
 * Last, because every entry before it is a value the caller was free to invent. This is the same
 * choice the public legal-body limiter makes.
 */
export function callerKey(header: string | undefined): string {
  const appended = header
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
    .pop();
  return appended ?? "direct";
}

export function hashIp(salt: string, caller: string): string | null {
  if (!salt) return null;
  return createHash("sha256").update(`${salt}:${caller}`).digest("hex");
}

function requireReviewer(
  admins: readonly `0x${string}`[],
): MiddlewareHandler<{ Variables: AuthVars }> {
  const allowed = new Set(admins.map((address) => address.toLowerCase()));
  return async (c, next) => {
    if (!allowed.has(c.get("tenantId").toLowerCase())) {
      throw new ApiError("forbidden", 403, "not a founding reviewer");
    }
    await next();
  };
}

function readEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  name: string,
): T | null {
  if (raw == null || raw === "") return null;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ApiError("validation_error", 400, `${name} is not a known value`);
}

async function readObject(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("validation_error", 400, "invalid JSON body");
  }
}

function isUnique(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function toCsv(
  rows: {
    createdAt: number;
    email: string;
    xHandle: string | null;
    agentName: string;
    status: ApplicationStatus;
    reviewCount: number;
    averageScore: number | null;
  }[],
): string {
  const header = [
    "created_at",
    "email",
    "x_handle",
    "agent_name",
    "status",
    "review_count",
    "average_score",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        new Date(row.createdAt).toISOString(),
        row.email,
        row.xHandle ?? "",
        row.agentName,
        row.status,
        String(row.reviewCount),
        row.averageScore === null ? "" : row.averageScore.toFixed(2),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}
