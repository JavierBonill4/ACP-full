"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo, type ReactNode } from "react";

import "@solana/wallet-adapter-react-ui/styles.css";

// Same var lib/constants.ts reads (as SOLANA_RPC_URL there) — previously this
// file read NEXT_PUBLIC_RPC_URL, a different, undocumented name, so setting
// only the documented NEXT_PUBLIC_SOLANA_RPC_URL silently left the wallet
// connection on the public devnet endpoint regardless.
export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

/**
 * Wallet detection goes through the Wallet Standard directly — note
 * `wallets={[]}`.
 *
 * Every modern Solana wallet (Phantom, Solflare, Backpack) registers itself
 * via the Wallet Standard, so an explicit adapter list is redundant. Passing
 * one means pulling in `@solana/wallet-adapter-wallets`, which drags along
 * WalletConnect/Reown and with it viem, pino, and the full EVM chain list —
 * that single package accounted for most of the install size, the npm audit
 * findings, and the dev-server compile time in the previous version of this
 * app.
 *
 * If you ever need WalletConnect for a mobile wallet that is not yet Wallet
 * Standard compliant, add the package back and pass its adapters here.
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(() => RPC_URL, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
