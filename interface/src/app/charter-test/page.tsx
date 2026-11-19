import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CharterTestPage } from "@/components/charterTest/CharterTestPage";
import { charterTestPageServed } from "@/lib/charterTest/served";

export function generateMetadata(): Metadata {
  if (!charterTestPageServed(process.env.NODE_ENV)) notFound();
  return { title: "Charter flow test page", robots: { index: false, follow: false } };
}

/**
 * `/charter-test`: a test page for the legal-body flow on a deployment that serves the Legal Body
 * Charter. Not part of the product, and linked from nowhere.
 *
 * It is served by the development server only. A build writes `production` for
 * `process.env.NODE_ENV`, whatever the environment says, so a deployed site answers its
 * not-found page here. Only Next's debug builds write `development` (`next build
 * --debug-prerender`, or `experimental.allowDevelopmentBuild`). The page brings its own providers.
 */
export default function CharterTestRoute() {
  if (!charterTestPageServed(process.env.NODE_ENV)) notFound();
  return <CharterTestPage />;
}
