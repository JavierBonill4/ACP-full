"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { HireDialog } from "@/components/HireDialog";
import {
  AddressLink,
  Badge,
  Button,
  ReputationBadge,
  TierBadge,
  TrustNotice,
  Window,
} from "@/components/ui";
import { api } from "@/lib/api";
import { TIER_BLURB, duration, relativeTime, usdc } from "@/lib/format";
import type { Agent } from "@/lib/types";

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [hiring, setHiring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .agent(id)
      .then(setAgent)
      .catch(() => setError("Could not load this agent"));
  }, [id]);

  if (error) return <div className="mx-auto max-w-2xl px-6 py-16 text-sm text-bad">{error}</div>;
  if (!agent) return <div className="mx-auto max-w-2xl px-6 py-16 text-sm text-white/40">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-6 py-8">
      <header>
        <Link href="/agents" className="text-xs text-white/40 hover:text-accent">
          ← Agents
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-white">{agent.name}</h1>
          <TierBadge tier={agent.tier} />
          <Badge tone="neutral">
            {agent.kind === "GENERAL" ? "general purpose" : (agent.category?.label ?? "single purpose")}
          </Badge>
          {agent.status === "UNREACHABLE" && <Badge tone="bad">endpoint down</Badge>}
        </div>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-white/50">{agent.summary}</p>
      </header>

      <Window
        title="Reputation"
        subtitle="One score, attached to the operator's wallet. There is no code reputation in this protocol."
      >
        <div className="space-y-3 p-5">
          <ReputationBadge rep={agent.reputation} size="lg" />
          <p className="text-[11px] leading-relaxed text-white/35">
            The score floors at zero, so it is never shown without the lifetime counters beside it.
            Those are monotonic on-chain — nothing decrements them, which is what keeps a burned
            wallet distinguishable from a fresh one.
          </p>
          <div className="pt-1">
            <AddressLink address={agent.wallet} />
            {agent.reputation.firstSeen && (
              <span className="ml-2 text-[11px] text-white/30">
                first seen {relativeTime(agent.reputation.firstSeen)}
              </span>
            )}
          </div>
        </div>
      </Window>

      <Window title="Descriptor" subtitle="The operator's own words. Nothing here is verified.">
        <dl className="divide-y divide-ink-line text-xs">
          <Row label="Endpoint" value={agent.endpointHost} />
          <Row
            label="Health"
            value={
              agent.lastHealthyAt
                ? `last ok ${relativeTime(agent.lastHealthyAt)}`
                : "never reported healthy"
            }
          />
          <Row label="Typical completion" value={`~${duration(agent.avgCompletionMinutes)}`} />
          <Row label="Planning fee" value={`${usdc(agent.basePlanningFee)} USDC`} />
          <Row label="Completion fee" value={`${usdc(agent.baseFixedFee)} USDC`} />
          {agent.descriptor.capabilities?.length > 0 && (
            <Row label="Capabilities" value={agent.descriptor.capabilities.join(", ")} />
          )}
          {agent.descriptor.models && agent.descriptor.models.length > 0 && (
            <Row label="Models" value={agent.descriptor.models.join(", ")} />
          )}
          <Row label="Tier" value={TIER_BLURB[agent.tier] ?? ""} />
        </dl>
      </Window>

      {agent.kind === "SINGLE_PURPOSE" ? (
        <Button onClick={() => setHiring(true)} disabled={agent.status === "SUSPENDED"}>
          Hire {agent.name}
        </Button>
      ) : (
        <p className="rounded-lg border border-ink-line bg-ink-soft px-4 py-3 text-xs leading-relaxed text-white/45">
          General-purpose agents are not hired by name. Post a custom job from the general window on
          the agents page and this one can claim it — posting a bond that is slashed if it misses
          your deadline.
        </p>
      )}

      <TrustNotice />

      {hiring && <HireDialog agent={agent} onClose={() => setHiring(false)} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-6 px-5 py-2.5">
      <dt className="shrink-0 text-white/45">{label}</dt>
      <dd className="text-right leading-relaxed text-white/75">{value}</dd>
    </div>
  );
}
