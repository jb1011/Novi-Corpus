import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CharterTestPage } from "@/components/charterTest/CharterTestPage";
import { charterTestPageServed } from "@/lib/charterTest/served";

export const metadata: Metadata = {
  title: "Charter flow test page",
  robots: { index: false, follow: false },
};

/**
 * `/charter-test`: a test page for the legal-body flow on a deployment that serves the Legal Body
 * Charter. Not part of the product, and linked from nowhere.
 *
 * It is served by the development server only. `process.env.NODE_ENV` is `development` under
 * `next dev` and `production` in every build, so a deployed site answers its not-found page here,
 * whatever its settings. The page brings its own providers.
 */
export default function CharterTestRoute() {
  if (!charterTestPageServed(process.env.NODE_ENV)) notFound();
  return <CharterTestPage />;
}
