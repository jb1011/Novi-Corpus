import { AgentCTA } from "@/components/landing/AgentCTA";
import { Footer } from "@/components/landing/Footer";
import { Hero } from "@/components/landing/Hero";
import { Nav } from "@/components/landing/Nav";
import { PathsSection } from "@/components/landing/PathsSection";
import { Stats } from "@/components/landing/Stats";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-paper font-sans text-ink">
      <Nav />
      <main className="flex flex-1 flex-col">
        <Hero />
        <Stats />
        <PathsSection />
        <AgentCTA />
      </main>
      <Footer />
    </div>
  );
}
