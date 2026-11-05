import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminProviders } from "@/components/founding/AdminProviders";

export const metadata: Metadata = {
  title: "Founding 5 review — Novi Corpus",
};

export default function FoundingAdminLayout({ children }: { children: ReactNode }) {
  return <AdminProviders>{children}</AdminProviders>;
}
