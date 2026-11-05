import type { Metadata } from "next";
import { FoundingLanding } from "@/components/founding/FoundingLanding";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/Nav";

export const metadata: Metadata = {
  title: "Arc mainnet beta, Novi Corpus",
  description:
    "Apply for the invite only Arc mainnet beta. About ten Wyoming companies. The first 2 to 5 formations are free. No filing date is promised.",
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
