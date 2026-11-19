import type { Metadata } from "next";
import { StartFlow } from "@/components/start/StartFlow";
import { START_COPY } from "@/lib/start/copy";

export const metadata: Metadata = {
  title: START_COPY.page.title,
};

/** `/start`: the one way in. The flow brings its own providers. */
export default function StartPage() {
  return <StartFlow />;
}
