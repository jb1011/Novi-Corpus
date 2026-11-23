import type { Secret } from "../formation/pii";
import { opsLog } from "../observability/opsLog";
import { withDeadline } from "../util/deadline";
import { readCappedText } from "../util/readStreamCapped";

/**
 * The person screen (identity check plan, Task 5): the verified person's name, and the birth date
 * when the document gave one, searched against sanctions and politically-exposed-person lists
 * through OpenSanctions' match API. The session service calls it once per completed check.
 *
 * The request is pinned, and the tests pin it byte for byte:
 *
 * - `POST https://api.opensanctions.org/match/<dataset>?algorithm=logic-v2&threshold=<t>&limit=5`,
 *   with `Authorization: ApiKey <key>` and `Content-Type: application/json`, and no other header.
 * - One query, `q`: `{ schema: "Person", properties: { name: [name], birthDate: [date] } }`,
 *   `birthDate` left out when there is none.
 * - One deadline (10 s by default) covers the request and the body read and aborts both; the body
 *   is read under a size cap; a redirect is never followed (the key would ride along).
 *
 * The answer is a verdict or an error, never a throw:
 *
 * - `"hit"`: at least one result of query `q` says `match: true` (the API sets it when the score
 *   is at or above the threshold), even beside a result that cannot be read. A hit is a review for
 *   the caller, never a refusal here.
 * - `"clear"`: every result says `match: false`, or there is none.
 * - `"error"`: no verdict reached us. A non-2xx, a timeout, a torn connection, a body that cannot
 *   be read, a query whose own `status` is not 200, a result whose `match` is not a boolean (and
 *   no readable match beside it), or a query this screener will not send (a blank name, a birth
 *   date not shaped `YYYY-MM-DD`). The caller waits and retries; an error is never read as clear.
 *
 * Each error writes ONE ops line, `person_screen_error { status }`, with the HTTP status or a
 * short reason word. Never the query, the name, the birth date, the key or the body: an error body
 * can quote what was sent. Nothing of the answer is kept: the verdict is the only thing returned
 * (the `screenings` table is PR 4's).
 */

export const OPENSANCTIONS_MATCH_URL = "https://api.opensanctions.org/match";

/** The per-call deadline: the fetch and the body read together. */
export const OPENSANCTIONS_TIMEOUT_MS = 10_000;

/** The matching algorithm and the number of results asked for, pinned. */
const ALGORITHM = "logic-v2";
const LIMIT = "5";

/** Five results with their properties stay well under this; the cap only stops a runaway answer. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** The one query's id in the request and in the answer. */
const QUERY_ID = "q";

/** The dataset is a path segment of the request (the setting's own rule, kept here as well). */
const DATASET = /^[a-z0-9_-]+$/;
const BIRTH_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ScreenVerdict = "clear" | "hit" | "error";

/** The screening seam the identity session service calls. Tests fake it; production is OpenSanctions. */
export interface PersonScreener {
  screenPerson(q: { name: string; birthDate: string | null }): Promise<ScreenVerdict>;
}

/** Why no verdict came back: the HTTP status, or a short reason word. Never a value of the query. */
type Failure =
  | number
  | "timeout"
  | "unreachable"
  | "unreadable"
  | "invalid_query"
  | `query_${number}`;

class ScreenFailed extends Error {
  constructor(readonly status: Failure) {
    super(`person screen failed: ${status}`);
    this.name = "ScreenFailed";
  }
}

export class OpenSanctionsPersonScreener implements PersonScreener {
  readonly #apiKey: Secret;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: {
    apiKey: Secret;
    dataset: string;
    threshold: number;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    if (typeof opts.dataset !== "string" || !DATASET.test(opts.dataset))
      throw new Error("OpenSanctionsPersonScreener: the dataset must be a plain dataset name");
    if (!Number.isFinite(opts.threshold) || opts.threshold <= 0 || opts.threshold > 1)
      throw new Error("OpenSanctionsPersonScreener: the threshold must be above 0 and at most 1");
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? OPENSANCTIONS_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0)
      throw new Error("OpenSanctionsPersonScreener: timeoutMs must be a positive number");
    const query = new URLSearchParams([
      ["algorithm", ALGORITHM],
      ["threshold", String(opts.threshold)],
      ["limit", LIMIT],
    ]);
    this.#url = `${OPENSANCTIONS_MATCH_URL}/${opts.dataset}?${query.toString()}`;
  }

  async screenPerson(q: { name: string; birthDate: string | null }): Promise<ScreenVerdict> {
    try {
      return verdictOf(await this.#match(q));
    } catch (e) {
      // Only the status leaves: an exception's message here can quote the body or the query.
      const status: Failure = e instanceof ScreenFailed ? e.status : "unreadable";
      opsLog("person_screen_error", { status });
      return "error";
    }
  }

  /** One round trip: the query check, the headers, the deadline, the size cap, the status. */
  async #match(q: { name: string; birthDate: string | null }): Promise<unknown> {
    // A blank name would search for nothing and come back clear: refuse it rather than send it.
    if (typeof q.name !== "string" || q.name.trim() === "") throw new ScreenFailed("invalid_query");
    if (q.birthDate !== null && (typeof q.birthDate !== "string" || !BIRTH_DATE.test(q.birthDate)))
      throw new ScreenFailed("invalid_query");

    const properties: { name: string[]; birthDate?: string[] } = { name: [q.name] };
    if (q.birthDate !== null) properties.birthDate = [q.birthDate];
    const body = JSON.stringify({ queries: { [QUERY_ID]: { schema: "Person", properties } } });
    const headers = {
      // The key leaves its `Secret` wrapper here, at the wire, and nowhere else in this module.
      Authorization: `ApiKey ${this.#apiKey.reveal()}`,
      "Content-Type": "application/json",
    };

    return withDeadline(
      this.#timeoutMs,
      async (signal): Promise<unknown> => {
        let res: Response;
        try {
          res = await this.#fetch(this.#url, {
            method: "POST",
            headers,
            body,
            signal,
            redirect: "error",
          });
        } catch {
          // The cause is not kept: a transport error's message can quote the request.
          throw new ScreenFailed("unreachable");
        }
        if (res.status < 200 || res.status >= 300) {
          // The body is not needed: drop it, which frees the socket.
          await res.body?.cancel().catch(() => undefined);
          throw new ScreenFailed(res.status);
        }
        let text: string;
        try {
          text = await readCappedText(
            {
              body: res.body,
              contentLength: res.headers.get("content-length"),
              readAll: async () => Buffer.from(await res.text(), "utf8"),
            },
            MAX_RESPONSE_BYTES,
            {
              declared: () => new ScreenFailed("unreadable"),
              streamed: () => new ScreenFailed("unreadable"),
            },
            signal,
          );
        } catch {
          throw new ScreenFailed("unreadable");
        }
        try {
          return JSON.parse(text) as unknown;
        } catch {
          // The JSON error is not kept: its message quotes the text it failed on.
          throw new ScreenFailed("unreadable");
        }
      },
      () => new ScreenFailed("timeout"),
    );
  }
}

/**
 * The answer's verdict for query `q`. Anything that is not the documented shape is unreadable:
 * the screen fails closed, so a shape it cannot read is never clear (only a readable match
 * beside it turns it into a hit).
 */
function verdictOf(json: unknown): "clear" | "hit" {
  const responses = isObject(json) ? json.responses : undefined;
  const response = isObject(responses) ? responses[QUERY_ID] : undefined;
  if (!isObject(response)) throw new ScreenFailed("unreadable");
  if (response.status !== 200) {
    const s = response.status;
    throw new ScreenFailed(Number.isSafeInteger(s) ? `query_${s as number}` : "unreadable");
  }
  const results = response.results;
  if (!Array.isArray(results)) throw new ScreenFailed("unreadable");
  // A readable match wins over an unreadable sibling: a hit reaches an operator's review, while an
  // error would make the completion retry for as long as the provider sends that shape.
  if (results.some((r) => isObject(r) && r.match === true)) return "hit";
  if (results.some((r) => !isObject(r) || typeof r.match !== "boolean"))
    throw new ScreenFailed("unreadable");
  return "clear";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
