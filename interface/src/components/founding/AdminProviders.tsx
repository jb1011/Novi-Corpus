"use client";

import type { ReactNode } from "react";
import { AuthProvider } from "@/components/onboarding/AuthProvider";
import { Web3Provider } from "@/components/providers/Web3Provider";

export function AdminProviders({ children }: { children: ReactNode }) {
  return (
    <Web3Provider>
      <AuthProvider>{children}</AuthProvider>
    </Web3Provider>
  );
}
