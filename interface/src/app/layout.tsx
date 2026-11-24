import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import { type ReactNode } from "react";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://novicorpus.xyz";

const title = "Novi Corpus: a legal body for your agent";
const description =
  "Agents with a legal body: a Wyoming DAO LLC linked to the agent's on-chain identity, a verified human accountable for it, and a public record anyone can check.";

export const metadata: Metadata = {
  title,
  description,
  metadataBase: new URL(siteUrl),
  openGraph: {
    title,
    description,
    type: "website",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/logo/apple-touch-icon-180.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className={`${archivo.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-paper text-ink font-sans">
        {children}
      </body>
    </html>
  );
}
