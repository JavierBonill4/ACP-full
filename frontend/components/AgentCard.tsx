"use client";

import Link from "next/link";

import { duration, usdc } from "@/lib/format";
import type { Agent } from "@/lib/types";
import { AddressLink, Badge, Button, ReputationBadge, TierBadge, cx } from "./ui";

/**
 * One agent, in either window.
 *
 * `variant` changes the call to action, not the identity of the card:
 * - "hire" (single-purpose window) hires this specific agent.
 * - "roster" (general window) is informational — general agents are not hired
 *   directly, they claim custom jobs from the open pool.
 *
 * The card never renders a category chip in the single-purpose window, because
 * the window already groups by category and repeating it is noise.
 */
export function AgentCard({
  agent,
  variant,
  onHire,
  showCategory = false,
}: {
  agent: Agent;
  variant: "hire" | "roster";
  onHire?: (agent: Agent) => void;
  showCategory?: boolean;
}) {
  const unreachable = agent.status === "UNREACHABLE";

  return (
    <article
      className={cx(
        "group flex flex-col gap-3 rounded-lg border border-ink-line bg-ink p-4",
        "transition-colors hover:border-white/20"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/agents/${agent.id}`}
              className="truncate text-sm font-semibold text-white hover:text-accent"
            >
              {agent.name}
            </Link>
            <TierBadge tier={agent.tier} />
            {showCategory && agent.category && (
              <Badge tone="neutral">{agent.category.label}</Badge>
            )}
            {unreachable && (
              <Badge tone="bad" title={`Last health check failed. ${agent.endpointHost} did not respond.`}>
                endpoint down
              </Badge>
            )}
          </div>
          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-white/50">{agent.summary}</p>
        </div>
      </div>

      <ReputationBadge rep={agent.reputation} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/40">
        <span title="Flat completion fee the operator advertises. The employer funds this as a ceiling; the agent's proposal must fit inside it.">
          fee <span className="font-mono text-white/70">{usdc(agent.baseFixedFee)}</span> USDC
        </span>
        {agent.basePlanningFee !== "0" && (
          <span title="Charged for the planning phase whether or not the plan is accepted. This is how an agent prices rejection risk.">
            planning <span className="font-mono text-white/70">{usdc(agent.basePlanningFee)}</span>
          </span>
        )}
        <span title="Operator's own estimate. Not verified, not enforced — the deadline is.">
          ~{duration(agent.avgCompletionMinutes)}
        </span>
        <AddressLink address={agent.wallet} />
      </div>

      {agent.descriptor.capabilities?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.descriptor.capabilities.slice(0, 4).map((c) => (
            <span
              key={c}
              className="rounded border border-ink-line px-1.5 py-0.5 font-mono text-[10px] text-white/40"
            >
              {c}
            </span>
          ))}
        </div>
      )}

      {variant === "hire" ? (
        <Button onClick={() => onHire?.(agent)} disabled={agent.status === "SUSPENDED"} className="mt-1">
          Hire {agent.name}
        </Button>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-white/30">
          Claims custom jobs from the open pool. Post one above and this agent can pick it up.
        </p>
      )}
    </article>
  );
}
