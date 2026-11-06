/**
 * The email settings (`cfg.email`): the email system is wired only where PUBLIC_APP_URL is set,
 * and then it names its sender and its postal address whichever provider sends; the provider
 * sender also needs its API key and its webhook secret. A box that sets none of them (the testnet
 * box) has no `cfg.email` and boots exactly as before. `redact()` hides the key and the secret.
 *
 * Every key and secret here is a placeholder.
 */
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const BASE = {
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}`,
  AUTH_JWT_SECRET: "s".repeat(16),
  ARC_TESTNET_RPC_URL: "http://localhost:8545",
};

const API_KEY = "re_placeholder_key_000";
const WEBHOOK_SECRET = "whsec_cGxhY2Vob2xkZXJzZWNyZXQ=";

/** What the console sender needs: the link base, the sender and the postal address. */
const CONSOLE = {
  ...BASE,
  PUBLIC_APP_URL: "https://www.example.com",
  EMAIL_FROM: "Novi Corpus <filings@example.com>",
  EMAIL_POSTAL_ADDRESS: "1 Example Street, Suite 100, Dover, DE 19901, USA",
};

/** And what the provider sender needs on top. */
const RESEND = {
  ...CONSOLE,
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: API_KEY,
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

/** The message `fn` throws, or undefined when it returns. */
function thrownBy(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return undefined;
}

/** `env` without the named settings. */
function without(env: Record<string, string>, ...names: string[]): Record<string, string> {
  const out = { ...env };
  for (const name of names) delete out[name];
  return out;
}

test("a box that sets no email setting has no email system (the testnet box, unchanged)", () => {
  expect(loadConfig(BASE).email).toBeUndefined();
});

test("the console sender boots with the link base, the sender and the postal address", () => {
  expect(loadConfig(CONSOLE).email).toEqual({
    provider: "console",
    publicAppUrl: "https://www.example.com",
    from: "Novi Corpus <filings@example.com>",
    postalAddress: "1 Example Street, Suite 100, Dover, DE 19901, USA",
  });
});

test("console is the default provider, and a blank one reads as unset", () => {
  expect(loadConfig({ ...CONSOLE, EMAIL_PROVIDER: "" }).email?.provider).toBe("console");
  expect(loadConfig({ ...CONSOLE, EMAIL_PROVIDER: "console" }).email?.provider).toBe("console");
});

test("the provider sender boots with its key and its secret", () => {
  expect(loadConfig(RESEND).email).toEqual({
    provider: "resend",
    publicAppUrl: "https://www.example.com",
    from: "Novi Corpus <filings@example.com>",
    postalAddress: "1 Example Street, Suite 100, Dover, DE 19901, USA",
    apiKey: API_KEY,
    webhookSecret: WEBHOOK_SECRET,
  });
});

test("the reply-to address and the marketing segment are carried when set", () => {
  const email = loadConfig({
    ...RESEND,
    EMAIL_REPLY_TO: "support@example.com",
    RESEND_MARKETING_SEGMENT_ID: "seg_placeholder",
  }).email;
  expect(email?.replyTo).toBe("support@example.com");
  expect(email?.marketingSegmentId).toBe("seg_placeholder");
});

test("the link base loses its trailing slash, so a path can be appended to it", () => {
  expect(
    loadConfig({ ...CONSOLE, PUBLIC_APP_URL: "https://www.example.com/" }).email?.publicAppUrl,
  ).toBe("https://www.example.com");
});

test("the provider sender without its webhook secret refuses to boot", () => {
  expect(thrownBy(() => loadConfig(without(RESEND, "RESEND_WEBHOOK_SECRET")))).toBe(
    "Invalid config: EMAIL_PROVIDER=resend requires RESEND_WEBHOOK_SECRET",
  );
});

test("the provider sender names everything it misses, in one message", () => {
  expect(thrownBy(() => loadConfig(without(RESEND, "RESEND_API_KEY")))).toBe(
    "Invalid config: EMAIL_PROVIDER=resend requires RESEND_API_KEY",
  );
  expect(
    thrownBy(() => loadConfig({ ...BASE, EMAIL_PROVIDER: "resend", RESEND_API_KEY: API_KEY })),
  ).toBe(
    "Invalid config: EMAIL_PROVIDER=resend requires RESEND_WEBHOOK_SECRET and EMAIL_FROM and EMAIL_POSTAL_ADDRESS and PUBLIC_APP_URL",
  );
});

test("with the link base set, either provider needs the sender and the postal address", () => {
  const needs =
    "Invalid config: PUBLIC_APP_URL turns the email system on, and every email needs EMAIL_FROM and EMAIL_POSTAL_ADDRESS (for either provider): missing ";
  expect(thrownBy(() => loadConfig(without(CONSOLE, "EMAIL_FROM")))).toBe(`${needs}EMAIL_FROM`);
  expect(thrownBy(() => loadConfig(without(CONSOLE, "EMAIL_POSTAL_ADDRESS")))).toBe(
    `${needs}EMAIL_POSTAL_ADDRESS`,
  );
  expect(thrownBy(() => loadConfig(without(CONSOLE, "EMAIL_FROM", "EMAIL_POSTAL_ADDRESS")))).toBe(
    `${needs}EMAIL_FROM and EMAIL_POSTAL_ADDRESS`,
  );
  expect(thrownBy(() => loadConfig(without(RESEND, "EMAIL_FROM")))).toBe(
    "Invalid config: EMAIL_PROVIDER=resend requires EMAIL_FROM",
  );
});

test("an email setting without the link base refuses to boot: it would wire nothing", () => {
  const { PUBLIC_APP_URL: _url, ...noUrl } = CONSOLE;
  expect(thrownBy(() => loadConfig(noUrl))).toBe(
    "Invalid config: EMAIL_FROM and EMAIL_POSTAL_ADDRESS are set but PUBLIC_APP_URL is missing: the email system is wired only with PUBLIC_APP_URL, which every link in an email is built on",
  );
  expect(thrownBy(() => loadConfig({ ...BASE, EMAIL_PROVIDER: "console" }))).toBe(
    "Invalid config: EMAIL_PROVIDER is set but PUBLIC_APP_URL is missing: the email system is wired only with PUBLIC_APP_URL, which every link in an email is built on",
  );
  expect(thrownBy(() => loadConfig({ ...BASE, RESEND_MARKETING_SEGMENT_ID: "seg" }))).toBe(
    "Invalid config: RESEND_MARKETING_SEGMENT_ID is set but PUBLIC_APP_URL is missing: the email system is wired only with PUBLIC_APP_URL, which every link in an email is built on",
  );
});

test("the provider's key or secret on a console box refuses to boot: the console sender sends nothing", () => {
  expect(thrownBy(() => loadConfig({ ...CONSOLE, RESEND_API_KEY: API_KEY }))).toBe(
    "Invalid config: RESEND_API_KEY is set with EMAIL_PROVIDER=console: the console sender sends nothing and verifies no webhook (set EMAIL_PROVIDER=resend, or unset it)",
  );
  expect(
    thrownBy(() =>
      loadConfig({ ...CONSOLE, RESEND_API_KEY: API_KEY, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET }),
    ),
  ).toBe(
    "Invalid config: RESEND_API_KEY and RESEND_WEBHOOK_SECRET are set with EMAIL_PROVIDER=console: the console sender sends nothing and verifies no webhook (set EMAIL_PROVIDER=resend, or unset them)",
  );
});

test("a webhook secret without the whsec_ prefix refuses to boot, and the value is never echoed", () => {
  for (const bad of ["cGxhY2Vob2xkZXI=", "whsec_", "whsec_not base64!", "WHSEC_cGxhY2Vob2xkZXI="]) {
    const message = thrownBy(() => loadConfig({ ...RESEND, RESEND_WEBHOOK_SECRET: bad }));
    expect(message, bad).toMatch(/^Invalid config: RESEND_WEBHOOK_SECRET /);
    expect(message, bad).not.toContain(bad);
  }
});

test("the provider name must be one of the two", () => {
  expect(thrownBy(() => loadConfig({ ...CONSOLE, EMAIL_PROVIDER: "smtp" }))).toMatch(
    /^Invalid config: EMAIL_PROVIDER /,
  );
});

test("the sender must be an address or a name and an address in angle brackets", () => {
  for (const bad of ["filings", "Novi Corpus filings@example.com", "Novi <filings>", "a@b c"])
    expect(
      thrownBy(() => loadConfig({ ...CONSOLE, EMAIL_FROM: bad })),
      bad,
    ).toMatch(/^Invalid config: EMAIL_FROM /);
  expect(loadConfig({ ...CONSOLE, EMAIL_FROM: "filings@example.com" }).email?.from).toBe(
    "filings@example.com",
  );
});

test("the reply-to must be a plain address", () => {
  expect(
    thrownBy(() => loadConfig({ ...CONSOLE, EMAIL_REPLY_TO: "Support <s@example.com>" })),
  ).toMatch(/^Invalid config: EMAIL_REPLY_TO /);
});

test("the postal address is one line", () => {
  for (const bad of ["1 Example Street\nDover", "1 Example Street\r\nDover"])
    expect(thrownBy(() => loadConfig({ ...CONSOLE, EMAIL_POSTAL_ADDRESS: bad }))).toMatch(
      /^Invalid config: EMAIL_POSTAL_ADDRESS /,
    );
});

test("the link base must be an http or https URL", () => {
  for (const bad of ["www.example.com", "ftp://www.example.com", "javascript:alert(1)"])
    expect(
      thrownBy(() => loadConfig({ ...CONSOLE, PUBLIC_APP_URL: bad })),
      bad,
    ).toMatch(/^Invalid config: PUBLIC_APP_URL /);
});

test("redact hides the key and the secret and keeps what an operator checks", () => {
  const shown = redact(
    loadConfig({ ...RESEND, RESEND_MARKETING_SEGMENT_ID: "seg_placeholder" }),
  ) as { email: Record<string, unknown> };
  expect(shown.email).toEqual({
    provider: "resend",
    publicAppUrl: "https://www.example.com",
    from: "Novi Corpus <filings@example.com>",
    postalAddress: "1 Example Street, Suite 100, Dover, DE 19901, USA",
    marketingSegmentId: "seg_placeholder",
    apiKey: "REDACTED",
    webhookSecret: "REDACTED",
  });
  const line = JSON.stringify(redact(loadConfig(RESEND)));
  expect(line).not.toContain(API_KEY);
  expect(line).not.toContain(WEBHOOK_SECRET);
  expect(redact(loadConfig(CONSOLE)).email).toEqual(loadConfig(CONSOLE).email);
  expect(redact(loadConfig(BASE)).email).toBeUndefined();
});
