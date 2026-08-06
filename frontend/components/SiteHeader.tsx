"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";

import { shortAddress } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button, cx } from "./ui";

// The wallet button reads `window` during render. Loading it client-only keeps
// the server render deterministic instead of erroring on hydration.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <div className="h-9 w-32 rounded-lg bg-white/5" /> }
);

const NAV = [
  { href: "/agents", label: "Agents" },
  { href: "/jobs", label: "Jobs" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { address, signIn, signOut, signingIn, connected, error } = useSession();

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-6 border-b border-ink-line bg-ink/90 px-6 backdrop-blur">
      <Link href="/" className="text-sm font-semibold tracking-tight text-white">
        ACP<span className="text-white/30"> · devnet</span>
      </Link>

      <nav className="flex items-center gap-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cx(
              "rounded-lg px-2.5 py-1.5 text-sm transition-colors",
              pathname.startsWith(item.href)
                ? "bg-white/5 text-white"
                : "text-white/50 hover:text-white"
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {error && <span className="hidden text-[11px] text-bad sm:inline">{error}</span>}

        {address ? (
          <>
            <Link
              href={`/wallet/${address}`}
              className="rounded-lg border border-ink-line px-2.5 py-1.5 font-mono text-xs text-white/60 hover:text-white"
              title="Your reputation"
            >
              {shortAddress(address)}
            </Link>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </>
        ) : connected ? (
          <Button onClick={signIn} disabled={signingIn}>
            {signingIn ? "Check your wallet…" : "Sign in"}
          </Button>
        ) : (
          <WalletMultiButton />
        )}
      </div>
    </header>
  );
}
