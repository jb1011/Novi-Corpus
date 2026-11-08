import type { Context } from "hono";
import { readCappedText } from "../util/readStreamCapped";

/**
 * The inbound webhooks' body reader: the doola webhook (`routes/doolaWebhook.ts`) and the email
 * provider's delivery webhook (`routes/emailWebhook.ts`) read their raw body through it, each with
 * its own cap, on the shared capped reader (`util/readStreamCapped`).
 */

/** The receiver's own overflow signal. Never leaves this module: the route turns it into a 413. */
class WebhookTooLargeError extends Error {}

/**
 * Read the body under a running byte cap, on the shared capped reader (M4).
 *
 * Read as TEXT, before any JSON parse: the signature covers the RAW bytes, so re-serializing a
 * parsed object would verify a different string than the one the sender signed. Returns
 * `undefined` when the cap is exceeded — a size refusal is a 413 here, not a signature verdict.
 */
export async function readCappedBody(c: Context, max: number): Promise<string | undefined> {
  try {
    return await readCappedText(
      {
        body: c.req.raw.body as ReadableStream<Uint8Array> | null | undefined,
        contentLength: c.req.header("content-length"),
        // No stream (an empty body, or a hand-rolled Request in a test): there is nothing to
        // meter, so read it and let the shared reader check the result.
        readAll: async () => Buffer.from(await c.req.text(), "utf8"),
      },
      max,
      { declared: () => new WebhookTooLargeError(), streamed: () => new WebhookTooLargeError() },
    );
  } catch (e) {
    if (e instanceof WebhookTooLargeError) return undefined;
    throw e;
  }
}
