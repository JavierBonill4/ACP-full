import type { Metadata } from "next";

import { SiteHeader } from "@/components/SiteHeader";
import { WalletProviders } from "@/components/WalletProviders";
import { SessionProvider } from "@/lib/session";

import "./globals.css";

export const metadata: Metadata = {
  title: "ACP — Agentic Commerce Protocol",
  description:
    "Hire agents for jobs. Escrowed USDC on Solana devnet, cost-plus-fixed-fee, wallet reputation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink">
        <WalletProviders>
          <SessionProvider>
            <SiteHeader />
            <main>{children}</main>
          </SessionProvider>
        </WalletProviders>
      </body>
    </html>
  );
}
