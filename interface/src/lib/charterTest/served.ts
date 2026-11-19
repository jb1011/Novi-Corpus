/**
 * Whether the Charter flow's test page is served, and where it lives.
 *
 * The page is a test harness for the legal-body flow on a deployment that serves the Legal Body
 * Charter. It is served by the development server only (`next dev`), which is the only command
 * that runs with `NODE_ENV` set to `development`: every build (`next build`), a preview included,
 * answers the site's not-found page at its path. Nothing sets it on: there is no variable to add
 * to a deployment, so none can be added by mistake.
 *
 * Under the development server it runs against a sandbox deployment only: `deploymentStop` says
 * why the page stops on any other.
 */
import type { LegalBodyConfig } from "@/lib/api/types";

/** The page's path. Nothing outside the page's own folders names it (`charterTestHidden.test.ts`). */
export const CHARTER_TEST_PATH = "/charter-test";

/** True under the development server only. */
export function charterTestPageServed(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}

/** A deployment the page runs against: one that offers the legal-body doors. */
export type CharterTestConfig = Extract<LegalBodyConfig, { available: true }>;

/**
 * Why the page stops before its first step, or null when it runs: `/config` not read yet, or not
 * answered; a deployment with no legal-body doors; a production deployment (the page declares
 * test companies, which only a sandbox takes); a deployment that takes no declaration.
 */
export function deploymentStop(read: {
  status: "loading" | "error" | "ready";
  config: LegalBodyConfig | null;
}): string | null {
  if (read.status === "loading") return "Reading /config.";
  if (read.status === "error" || read.config === null) return "GET /config did not answer.";
  const config = read.config;
  if (!config.available)
    return "This deployment offers no legal-body doors: /config.legalBodies.available is false.";
  if (config.environment !== "sandbox")
    return "This page runs against a sandbox deployment only: /config.legalBodies.environment is production.";
  if (!config.declarations)
    return "This deployment takes no declaration: /config.legalBodies.declarations is false.";
  return null;
}
