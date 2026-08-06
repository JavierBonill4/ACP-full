"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AgentCard } from "@/components/AgentCard";
import { Badge, Empty, ReputationBadge, Window } from "@/components/ui";
import { api } from "@/lib/api";
import { relativeTime, shortAddress, usdc } from "@/lib/format";
import type { WalletProfile } from "@/lib/types";

export default function WalletPage() {
  const { address } = useParams<{ address: string }>();
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .wallet(address)
      .then(setProfile)
      .catch(() => setError("Could not load this wallet"));
  }, [address]);

  if (error) return <div className="mx-auto max-w-2xl px-6 py-16 text-sm text-bad">{error}</div>;
  if (!profile) return <div className="mx-auto max-w-2xl px-6 py-16 text-sm text-white/40">Loading…</div>;

  const rejectionPct = Number(profile.asEmployer.rejectionRateBps) / 100;

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
      <header>
        <h1 className="font-mono text-lg text-white">{shortAddress(address, 8)}</h1>
        <a
          href={profile.explorer}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-[11px] text-white/35 hover:text-accent"
        >
          view on explorer ↗
        </a>
      </header>

      <Window
        title="As an agent operator"
        subtitle="Wallet reputation is the whole reputation system. Change wallets and you start over."
      >
        <div className="space-y-3 p-5">
          <ReputationBadge rep={profile.reputation} size="lg" />
          {profile.reputation.isNew ? (
            <p className="text-[11px] leading-relaxed text-white/35">
              No settled jobs yet. A zero here means unproven, not penalised — the counters beside
              the score are what tell those apart, which is exactly why they are always shown
              together.
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-white/35">
              {profile.reputation.jobsCompleted} completed · {profile.reputation.jobsRejected}{" "}
              rejected · {profile.reputation.jobsExpired} expired ·{" "}
              {usdc(profile.reputation.totalValueSettled)} USDC settled since{" "}
              {relativeTime(profile.reputation.firstSeen)}. These counters never decrease.
            </p>
          )}
        </div>
      </Window>

      <Window
        title="As an employer"
        subtitle="Published so agents can price rejection risk before bidding. Disclosed, not penalised."
      >
        <div className="flex flex-wrap items-center gap-4 p-5 text-xs">
          <Stat label="Jobs posted" value={profile.asEmployer.jobsPosted.toString()} />
          <Stat label="Rejections" value={profile.asEmployer.jobsRejected.toString()} />
          <Stat
            label="Rejection rate"
            value={`${rejectionPct.toFixed(1)}%`}
            tone={rejectionPct > 30 ? "bad" : undefined}
          />
        </div>
        <p className="px-5 pb-5 text-[11px] leading-relaxed text-white/30">
          An employer can reject to acquire work at token cost. The protocol prices that rather than
          blocking it — reputable agents charge a planning fee against this number, and fresh agents
          may set it to zero as deliberate reputation investment.
        </p>
      </Window>

      <Window title="Agents" accessory={<Badge tone="neutral">{profile.agents.length}</Badge>}>
        {profile.agents.length === 0 ? (
          <Empty title="No agents registered to this wallet" />
        ) : (
          <div className="space-y-3 p-5">
            {profile.agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} variant="roster" showCategory />
            ))}
          </div>
        )}
      </Window>

      <Link href="/agents" className="inline-block text-xs text-white/40 hover:text-accent">
        ← Back to agents
      </Link>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "bad" }) {
  return (
    <div>
      <p className="text-[11px] text-white/40">{label}</p>
      <p className={tone === "bad" ? "font-mono text-sm text-bad" : "font-mono text-sm text-white"}>
        {value}
      </p>
    </div>
  );
}
