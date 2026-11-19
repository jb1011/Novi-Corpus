/**
 * A failed call as the test page shows it: the status, the code and the sentence the API served,
 * and its details, with nothing reworded. A failure that is not an answer of the API (a wallet
 * that did not sign, a network that did not answer) is shown as what it is, with no code.
 */
import { ApiError } from "@/lib/api/types";

export type RefusalView = {
  /** Whether the API answered it. */
  api: boolean;
  status: number | null;
  code: string | null;
  message: string;
  /** The answer's `details`, as served, or null. */
  details: unknown;
};

/** What `e` says, as served. Never throws. */
export function refusalView(e: unknown): RefusalView {
  if (e instanceof ApiError)
    return {
      api: true,
      status: e.status,
      code: e.code,
      message: e.message,
      details: e.details === undefined ? null : e.details,
    };
  const message =
    e instanceof Error && e.message !== ""
      ? e.message
      : typeof e === "string" && e !== ""
        ? e
        : "No message.";
  return { api: false, status: null, code: null, message, details: null };
}

export type FieldProblem = { field: string; problem: string };

/** The `{ field, problem }` rows of a refusal's details, in their order. Anything else in the
 *  details is left out here and still shown whole by the page. */
export function fieldProblems(details: unknown): FieldProblem[] {
  if (!Array.isArray(details)) return [];
  const rows: FieldProblem[] = [];
  for (const row of details) {
    if (typeof row !== "object" || row === null) continue;
    const { field, problem } = row as { field?: unknown; problem?: unknown };
    if (typeof field === "string" && typeof problem === "string") rows.push({ field, problem });
  }
  return rows;
}

/** The problems of exactly this field. */
export function problemsAt(problems: readonly FieldProblem[], field: string): string[] {
  return problems.filter((p) => p.field === field).map((p) => p.problem);
}

/**
 * A short name for the call a failure came from, read from its query or mutation key: the key's
 * first two elements when they are text, joined by a dot. Every key of this site holds its
 * session token, when it holds one, from the third element on, so a name never shows a token. A
 * call with no key is `call`.
 */
export function callLabel(key: unknown): string {
  if (!Array.isArray(key)) return "call";
  const names = key.slice(0, 2).filter((part): part is string => typeof part === "string");
  return names.length > 0 ? names.join(".") : "call";
}
