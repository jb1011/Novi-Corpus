import type { Context, Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { verifySession } from "../../auth/session";
import type { SignedStatementJson } from "../../legalBody/publicStatement";
import type { Standing } from "../../legalBody/standing";
import {
  type StatementOutcome,
  isCanonicalAgentId,
  statementForAgent,
} from "../../legalBody/statements";
import { opsLog } from "../../observability/opsLog";
import {
  type StatementRead,
  type StatementReadCaller,
  callerDayHash,
  utcDay,
} from "../../persistence/statementReadRepository";
import type { ApiDeps } from "../app";
import { TokenBucket } from "./agentBook";
import {
  AnswerMemo,
  FRESH_CACHE_CONTROL,
  MEMO_MAX_ENTRIES,
  MEMO_TTL_MS,
  NO_STORE,
  RATE_LIMITED_BODY,
  THROTTLE_LOG_WINDOW_MS,
  UNAVAILABLE_BODY,
  clientKeyOf,
  createClientLimiter,
  errorNameOf,
} from "./legalBodies";

/**
 * GET /legal-bodies/by-agent/:agentId: what Novi states about an agent's legal body, signed on
 * each request from one block's chain reads by the statement service (`legalBody/statements.ts`).
 *
 * PUBLIC and unauthenticated, like the lookup by address beside it, for the same caller: a seller
 * that has never heard of us. Bounded the same way, and by the same instances:
 *  - a 15-second memo of definitive answers, checked before any budget, so a memo hit costs no
 *    token and no read;
 *  - on a miss, one token from the caller's own bucket (the lookup's per-client limiter, so a
 *    caller that spent its allowance on one route is refused by the other), then one from the
 *    shared read budget (the lookup's).
 *
 * A chain read that failed answers `unknown`, unsigned, `no-store` and never memoised: it is the
 * absence of an answer. Only a failed DATABASE read answers 503. No error text reaches an answer
 * or an ops line.
 *
 * On production a body answer also carries `guardianIdentityVerified`, beside the statement and
 * outside it: the signed statement is untouched (statement v3 signs the fact).
 *
 * EVERY ANSWER THAT IS A BODY'S SIGNED STATEMENT IS A READ (the funnel's last stage), the memo's
 * replays included, recorded in `statement_reads` where FUNNEL_SALT is set (`deps.statementReads`)
 * and nowhere else: once per body, UTC day, caller kind and caller. The caller is the per-client
 * limiter's key, kept only as sha256 of the key, the day and the salt. It is `owner` when the
 * request carries a valid session of the body's own tenant, else `anonymous`. The route stays
 * public: a bearer is read when present, never required, and one that is missing, malformed,
 * expired or signed with another secret is no session, so the caller reads as anonymous and
 * nothing else changes. The record changes nothing in the answer, for any caller, and a record
 * that fails is an ops line naming the error, never the answer's failure.
 *
 * THE ROW IS WRITTEN AFTER THE ANSWER IS HANDED BACK (`setImmediate`), so a busy database never
 * delays a public read; the caller kind and the hash are decided before, while the request is in
 * hand. A memo replay takes no token, so the writes are bounded on their own:
 *  - a repeat of a recent (body, day, kind, caller) is skipped before the database and the budget
 *    (the last 4096 keys, least recently seen evicted first);
 *  - every other write takes one token from the route's own budget, 600 at once and 1 a second
 *    for all callers together, so a caller who changes its key on every request (a new last
 *    X-Forwarded-For entry) cannot write without bound, while a burst of real readers (a page
 *    shared to an audience) is counted. A write the budget refuses is dropped and counted; the
 *    answer is the same either way.
 * A failed write and a dropped one each have one ops line per minute at most, counting how many
 * since the last: `legal_body_statement_read_failed` (with the error's name) and
 * `legal_body_statement_read_dropped`. Neither names a caller. A count held back is printed when
 * its minute ends, with no further event needed (`StatementReadLines`), and at the API's shutdown.
 */

/** The read rows the route may write, for all callers together: 600 at once, then 1 a second. */
const READ_ROW_BURST = 600;
const READ_ROW_REFILL_PER_SECOND = 1;
/** How many recent read keys are remembered, so a repeat never reaches the database. */
const RECENT_READ_KEYS = 4096;

/** A bounded set of keys, the least recently seen evicted first. */
class RecentKeys {
  private readonly keys = new Set<string>();

  constructor(private readonly max: number) {}

  /** Whether `key` was seen; a key seen again becomes the most recent. */
  has(key: string): boolean {
    if (!this.keys.has(key)) return false;
    this.keys.delete(key);
    this.keys.add(key);
    return true;
  }

  add(key: string): void {
    this.keys.delete(key);
    this.keys.add(key);
    while (this.keys.size > this.max) {
      const oldest = this.keys.values().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
  }
}

/**
 * At most one `event` ops line per window, carrying how many happened since the last line, the
 * held ones with the fields of the last of them. A count held back is printed when its window
 * closes, by a timer that never keeps the process alive, or at once by `flush`: never left waiting
 * for a next event that may not come.
 */
function windowedLine(event: string, now: () => number) {
  let loggedAt: number | undefined;
  let count = 0;
  let held: Record<string, unknown> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const print = (fields: Record<string, unknown>): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    loggedAt = now();
    opsLog(event, { ...fields, count });
    count = 0;
  };
  const note = (fields: Record<string, unknown> = {}): void => {
    count += 1;
    const at = now();
    if (loggedAt === undefined || at - loggedAt >= THROTTLE_LOG_WINDOW_MS) {
      print(fields);
      return;
    }
    held = fields;
    if (timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        if (count > 0) print(held);
      },
      loggedAt + THROTTLE_LOG_WINDOW_MS - at,
    );
    timer.unref?.();
  };
  const flush = (): void => {
    if (count > 0) print(held);
  };
  return { note, flush };
}

/**
 * The route's two once-a-minute lines, a failed read write and a dropped one. The composition root
 * builds them and hands the same object to the API's shutdown, which flushes what they hold before
 * the process exits; a route given none makes its own.
 */
export class StatementReadLines {
  readonly failed;
  readonly dropped;

  constructor(now: () => number = Date.now) {
    this.failed = windowedLine("legal_body_statement_read_failed", now);
    this.dropped = windowedLine("legal_body_statement_read_dropped", now);
  }

  /** Prints every count held back, now. */
  flush(): void {
    this.failed.flush();
    this.dropped.flush();
  }
}

/** The three answers. The agent id is the canonical decimal the caller supplied. */
export type ByAgentAnswer =
  | { agentId: string; legalBody: false; standing: null; checkedAt: string }
  | {
      agentId: string;
      legalBody: true;
      standing: "unknown";
      publicId: null;
      network: "testnet" | "mainnet";
      links: { transparency: string };
      checkedAt: string;
      statement: null;
    }
  | {
      agentId: string;
      legalBody: true;
      standing: Standing;
      publicId: string;
      network: "testnet" | "mainnet";
      links: { transparency: string; statement: string };
      checkedAt: string;
      /** Production only, and NOT SIGNED: whether the guardian's identity record is verified at
       *  the statement's issue. Absent on a sandbox. Statement v3 signs the fact and removes this
       *  key; until then this is the fact. */
      guardianIdentityVerified?: boolean;
      statement: SignedStatementJson;
    };

/** What the memo keeps for an agent: the answer, and the legal body it states when it states one,
 *  so that a replay is recorded as a read like the answer it replays. */
interface Memoised {
  answer: ByAgentAnswer;
  legalBodyId: string | null;
}

/**
 * The tenant of the request's session, when it carries a valid one: read, never required. The
 * header is parsed as `requireAuth` parses it. A missing, malformed, expired or foreign bearer is
 * no session at all, and fails nothing.
 */
async function sessionTenantOf(c: Context, secret: string): Promise<string | undefined> {
  const header = c.req.header("authorization");
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return undefined;
  try {
    return (await verifySession(token, secret)).tenantId;
  } catch {
    return undefined;
  }
}

/** Mounts nothing without `deps.legalBodyStatements`: the route is then a 404. */
export function mountLegalBodyStatementRoutes(
  app: Hono<{ Variables: AuthVars }>,
  deps: ApiDeps,
): void {
  const st = deps.legalBodyStatements;
  if (!st) return;
  const now = () => (deps.now ?? Date.now)();
  /** Keyed by the canonical agent id. */
  const memo = new AnswerMemo<Memoised>(MEMO_TTL_MS, MEMO_MAX_ENTRIES, now);
  const reads = deps.statementReads;
  const readBudget = new TokenBucket(READ_ROW_BURST, READ_ROW_REFILL_PER_SECOND);
  const recentReads = new RecentKeys(RECENT_READ_KEYS);
  const lines = reads?.lines ?? new StatementReadLines(now);

  /** Writes one read row, after the answer: a recent repeat is skipped, then the budget decides.
   *  Never throws. */
  const writeRead = (read: StatementRead): void => {
    if (reads === undefined) return;
    const key = `${read.legalBodyId}|${read.day}|${read.callerKind}|${read.callerDayHash}`;
    if (recentReads.has(key)) return;
    if (!readBudget.take()) {
      lines.dropped.note();
      return;
    }
    try {
      reads.repo.record(read);
      recentReads.add(key);
    } catch (e) {
      lines.failed.note({ errorName: errorNameOf(e) });
    }
  };

  /** Decides the read of the body's statement where FUNNEL_SALT is set (the caller kind and the
   *  caller's hash, while the request is in hand) and defers its write past the answer. Never
   *  throws: the answer is served whatever happens here. */
  const recordRead = async (c: Context, legalBodyId: string): Promise<void> => {
    if (reads === undefined) return;
    let read: StatementRead;
    try {
      const at = now();
      const day = utcDay(at);
      const tenant = await sessionTenantOf(c, deps.jwtSecret);
      const callerKind: StatementReadCaller =
        tenant !== undefined && st.repo.findOwned(tenant, legalBodyId) !== undefined
          ? "owner"
          : "anonymous";
      read = {
        legalBodyId,
        day,
        callerKind,
        callerDayHash: callerDayHash(clientKeyOf(c), day, reads.salt),
        firstReadAt: at,
      };
    } catch (e) {
      lines.failed.note({ errorName: errorNameOf(e) });
      return;
    }
    setImmediate(() => writeRead(read));
  };
  const clientBucket = createClientLimiter(deps);
  /** When the last throttle line was written, so a sustained drain costs one line per minute. */
  let throttleLoggedAt: number | undefined;

  /** The same refusal whichever budget ran out, plus at most one ops line per window naming
   *  WHICH budget, never who asked. */
  const throttled = (c: Context, bucket: "client" | "shared") => {
    const at = now();
    if (throttleLoggedAt === undefined || at - throttleLoggedAt >= THROTTLE_LOG_WINDOW_MS) {
      throttleLoggedAt = at;
      opsLog("legal_body_statement_throttled", { bucket });
    }
    c.header("Cache-Control", NO_STORE);
    return c.json(RATE_LIMITED_BODY, 429);
  };

  app.get("/legal-bodies/by-agent/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    // One spelling per agent: the memo is keyed by it.
    if (!isCanonicalAgentId(agentId)) {
      c.header("Cache-Control", NO_STORE);
      return c.json(
        {
          error: "validation_error",
          message: "agentId must be a decimal token id of at most 78 digits, without leading zeros",
        },
        400,
      );
    }

    const hit = memo.get(agentId);
    if (hit !== undefined) {
      // Definitive by construction: replayed as checked, with no token and no chain read. A
      // replayed statement is a read of it all the same.
      if (hit.legalBodyId !== null) await recordRead(c, hit.legalBodyId);
      c.header("Cache-Control", FRESH_CACHE_CONTROL);
      return c.json(hit.answer);
    }
    // The caller's own allowance first, so a scanner runs itself out before the shared one.
    if (!clientBucket(c).take()) return throttled(c, "client");
    if (!st.readBudget.take()) return throttled(c, "shared");

    let outcome: StatementOutcome;
    try {
      outcome = await statementForAgent(st, agentId);
    } catch (e) {
      // Only a DATABASE read throws out of the service: we cannot tell whether the agent has a
      // legal body at all, which no answer here has a value for.
      opsLog("legal_body_statement_db_failed", { errorName: errorNameOf(e) });
      c.header("Cache-Control", NO_STORE);
      return c.json(UNAVAILABLE_BODY, 503);
    }
    const checkedAt = new Date(now()).toISOString();

    if (outcome.kind === "unknown") {
      // Not an answer anything may reuse: never memoised, never stored downstream.
      const unknown: ByAgentAnswer = {
        agentId,
        legalBody: true,
        standing: "unknown",
        publicId: null,
        network: st.network,
        links: { transparency: st.links.transparency },
        checkedAt,
        statement: null,
      };
      c.header("Cache-Control", NO_STORE);
      return c.json(unknown);
    }
    const answer: ByAgentAnswer =
      outcome.kind === "none"
        ? { agentId, legalBody: false, standing: null, checkedAt }
        : {
            agentId,
            legalBody: true,
            standing: outcome.standing,
            publicId: outcome.publicId,
            network: st.network,
            links: {
              transparency: st.links.transparency,
              statement: `${st.links.statementBase}${agentId}`,
            },
            checkedAt,
            // Production only, unsigned, outside the statement: a sandbox answer has no such key.
            ...(st.environment === "production"
              ? { guardianIdentityVerified: outcome.guardianIdentityVerified }
              : {}),
            statement: outcome.statement,
          };
    const legalBodyId = outcome.kind === "statement" ? outcome.legalBodyId : null;
    memo.set(agentId, { answer, legalBodyId });
    if (legalBodyId !== null) await recordRead(c, legalBodyId);
    c.header("Cache-Control", FRESH_CACHE_CONTROL);
    return c.json(answer);
  });
}
