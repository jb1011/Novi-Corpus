import { createHash } from "node:crypto";

/**
 * THE IDENTITY-LINK EMAIL of the beta (slice I-0): an operator sends each guardian the link to the
 * identity check with `email:send-link` (src/cli/email.ts), and asks in the same email for the
 * guardian's legal name, which the record holds once the operator has confirmed it against the
 * document (docs/runbooks/guardian-identity.md).
 *
 * What it says, and what it never says:
 *  - the subject names no one and no address: "Confirm who you are";
 *  - one opening line; the three plain-words lines the guardian identity card shows (what is
 *    checked, what we keep, what we never keep: we never keep the document, the photo, the date of
 *    birth or the document number, though the provider reads them); the link; the request for the
 *    legal name; a link to the privacy page; the postal address;
 *  - no provider's name, and no expiry: the link is the provider's flow link, made to be shared,
 *    and it promises nothing about how long it lasts.
 *
 * A text and an HTML version, the same words. The HTML escapes everything it interpolates (the
 * link, the privacy link, the postal address). Neither version holds the guardian's address: the
 * link carries none (`email:send-link` refuses one that does).
 */

export const IDENTITY_LINK_SUBJECT = "Confirm who you are";

const OPENING =
  "We verify the identity of the person in control once, through the identity check below.";
/** The three plain-words lines, as the guardian identity card says them. */
const PLAIN_WORDS: readonly (readonly [label: string, line: string])[] = [
  ["What is checked", "a government document and a live photo, matched."],
  [
    "What we keep",
    "the result, the date, the country and type of the document, and your name, encrypted.",
  ],
  ["What we never keep", "the document itself, the photo, your date of birth or document number."],
];
const START = "Start your identity check";
const NAME_REQUEST =
  "Please also reply with your legal name exactly as printed on the document you will use.";
const PRIVACY = "How we handle your data";

/** `&`, `<`, `>`, `"` and `'` as entities: safe in an element and in a quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The identity link's idempotency key: one link per guardian per UTC day. The tenant is a digest's
 * first 16 hex characters, never the tenant id: the console sender prints keys, and a line names
 * a tenant by at most its first ten characters.
 */
export function identityLinkIdempotencyKey(tenantId: string, nowMs: number): string {
  const tenant = createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
  return `identity_link:${tenant}:${new Date(nowMs).toISOString().slice(0, 10)}`;
}

export function identityLinkEmail(input: {
  /** The full link to the identity check, as the operator built it. */
  link: string;
  /** The app's public origin, no trailing slash. */
  publicAppUrl: string;
  /** One line. */
  postalAddress: string;
}): { subject: string; text: string; html: string } {
  const privacyUrl = `${input.publicAppUrl}/privacy`;
  const text = [
    OPENING,
    "",
    ...PLAIN_WORDS.map(([label, line]) => `${label}: ${line}`),
    "",
    `${START}:`,
    input.link,
    "",
    NAME_REQUEST,
    "",
    `${PRIVACY}: ${privacyUrl}`,
    "",
    input.postalAddress,
    "",
  ].join("\n");

  const link = escapeHtml(input.link);
  const html = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${escapeHtml(IDENTITY_LINK_SUBJECT)}</title></head>`,
    '<body style="font-family: Arial, Helvetica, sans-serif; color: #111111; line-height: 1.5;">',
    `<p>${escapeHtml(OPENING)}</p>`,
    "<ul>",
    ...PLAIN_WORDS.map(
      ([label, line]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(line)}</li>`,
    ),
    "</ul>",
    `<p><a href="${link}">${escapeHtml(START)}</a></p>`,
    `<p>Or copy this link into your browser: ${link}</p>`,
    `<p>${escapeHtml(NAME_REQUEST)}</p>`,
    `<p><a href="${escapeHtml(privacyUrl)}">${escapeHtml(PRIVACY)}</a></p>`,
    `<p style="color: #666666; font-size: 12px;">${escapeHtml(input.postalAddress)}</p>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");

  return { subject: IDENTITY_LINK_SUBJECT, text, html };
}
