import { z } from "zod";

const HANDLE = /^[a-z0-9_]{1,15}$/;

/** Strip one leading @ and lowercase. Empty means the applicant gave no handle. */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const stripped = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return stripped;
}

/**
 * Keep only real campaign parameters. Anything else on the body is dropped, so a caller cannot
 * store an arbitrary blob by calling it `utm`.
 */
export function readUtm(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^utm_[a-z0-9_]{1,32}$/i.test(key)) continue;
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().slice(0, 200);
    if (!trimmed) continue;
    out[key.toLowerCase()] = trimmed;
    if (Object.keys(out).length >= 10) break;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const applicationSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .max(200)
    .email("Enter a valid email")
    .transform((value) => value.toLowerCase()),
  xHandle: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      const handle = normalizeHandle(value ?? "");
      return handle === "" ? null : handle;
    })
    .pipe(z.union([z.null(), z.string().regex(HANDLE, "Enter an X handle, without the @")])),
  agentName: z.string().trim().min(1, "Agent name is required").max(80),
  description: z
    .string()
    .trim()
    .min(50, "Tell us a little more (at least 50 characters)")
    .max(600, "Keep it under 600 characters"),
  utm: z.unknown().optional().transform(readUtm),
});

export type ApplicationInput = z.infer<typeof applicationSchema>;

/** A non-empty honeypot means the body is dropped. Absent, null, and "" are a real submission. */
export function honeypotFilled(body: Record<string, unknown>): boolean {
  if (!("company_website" in body)) return false;
  const value = body.company_website;
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

export const reviewSchema = z.object({
  useCase: z.number().int().min(1).max(5),
  moneyFlow: z.number().int().min(1).max(5),
  builder: z.number().int().min(1).max(5),
  note: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((value) => value || null),
});

export const statusSchema = z.object({
  status: z.enum(["new", "shortlist", "winner", "rejected", "waitlist"]),
});
