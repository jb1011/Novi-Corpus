const HANDLE = /^[a-z0-9_]{1,15}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ApplyFields = {
  email: string;
  xHandle: string;
  agentName: string;
  description: string;
};

export type ApplyErrors = Partial<Record<keyof ApplyFields, string>>;

export type ApplyPayload = {
  email: string;
  xHandle: string | null;
  agentName: string;
  description: string;
  utm?: Record<string, string>;
  company_website?: string;
};

/** Strip one leading @ and lowercase. */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

/** Campaign parameters only. Anything else on the query string is dropped. */
export function utmFromSearch(search: string): Record<string, string> | undefined {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!/^utm_[a-z0-9_]{1,32}$/i.test(key)) continue;
    const trimmed = value.trim().slice(0, 200);
    if (!trimmed) continue;
    out[key.toLowerCase()] = trimmed;
    if (Object.keys(out).length >= 10) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function validateApplication(
  input: ApplyFields,
): { ok: true; value: Omit<ApplyPayload, "utm" | "company_website"> } | { ok: false; errors: ApplyErrors } {
  const errors: ApplyErrors = {};

  const email = input.email.trim().toLowerCase();
  if (!email) errors.email = "Email is required";
  else if (email.length > 200 || !EMAIL.test(email)) errors.email = "Enter a valid email";

  const handle = normalizeHandle(input.xHandle);
  if (handle !== "" && !HANDLE.test(handle)) errors.xHandle = "Enter an X handle, without the @";

  const agentName = input.agentName.trim();
  if (!agentName) errors.agentName = "Agent name is required";
  else if (agentName.length > 80) errors.agentName = "Keep the agent name under 80 characters";

  const description = input.description.trim();
  if (description.length < 50) errors.description = "Tell us a little more (at least 50 characters)";
  else if (description.length > 600) errors.description = "Keep it under 600 characters";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      email,
      xHandle: handle === "" ? null : handle,
      agentName,
      description,
    },
  };
}

export function shareOnX(pageUrl: string): string {
  const url = new URL("https://x.com/intent/post");
  url.searchParams.set(
    "text",
    "I applied for the Novi Corpus Arc mainnet beta. Agents with a Novi legal body, invite only.",
  );
  url.searchParams.set("url", pageUrl);
  return url.toString();
}
