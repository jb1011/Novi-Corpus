import type { Metadata } from "next";
import { FoundingLanding } from "@/components/founding/FoundingLanding";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/Nav";

export const metadata: Metadata = {
  title: "Founding 5 — Novi Corpus",
  description:
    "Apply to the Founding 5. Five builders get a Novi Corpus company for their agent, free for the first year once filings are open.",
};

export default function FoundingFivePage() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <FoundingLanding />
      <Footer />
    </div>
  );
}
