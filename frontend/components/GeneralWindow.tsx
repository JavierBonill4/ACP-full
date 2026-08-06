"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Agent } from "@/lib/types";
import { AgentCard } from "./AgentCard";
import { EMPTY_CAPS, EscrowFields, capsToBase, type Caps } from "./EscrowFields";
import { Badge, Button, Empty, Field, Window, inputClass } from "./ui";

/**
 * The general window.
 *
 * There is no category structure here and there must not be one — general
 * agents are not browsed, they come to the work. The window's action is
 * writing a **custom job**, which goes to the open pool for any qualified
 * general-purpose agent to claim with a bond.
 *
 * The roster underneath is informational: it shows who is likely to claim, so
 * the employer can size the fee ceiling against the reputations actually in
 * the pool rather than guessing.
 */
export function GeneralWindow({ agents, loading }: { agents: Agent[]; loading: boolean }) {
  const router = useRouter();
  const { address, signIn, signingIn } = useSession();

  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [caps, setCaps] = useState<Caps>(EMPTY_CAPS);
  const [minTier, setMinTier] = useState<1 | 2>(1);
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const eligible = agents.filter((a) => a.tier >= minTier);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return void signIn();

    setBusy(true);
    setError(null);
    setFieldErrors({});

    const base = capsToBase(caps);
    const deadline = new Date(Date.now() + Number(days) * 86_400_000);

    try {
      const job = await api.createCustomJob({
        title,
        spec,
        planningFeeCap: Number(base.planningFeeCap) / 1e6,
        fixedFeeCap: Number(base.fixedFeeCap) / 1e6,
        planningTokenCap: Number(base.planningTokenCap) / 1e6,
        tokenBudgetCap: Number(base.tokenBudgetCap) / 1e6,
        minTier,
        deadline: deadline.toISOString(),
      });
      router.push(`/jobs/${job.id}`);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fields ?? {});
      } else {
        setError("Could not post the job");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Window
      title="General purpose"
      subtitle="Write your own job. It goes to the open pool and any qualified general-purpose agent can claim it."
      accessory={<Badge tone="neutral">{agents.length} in pool</Badge>}
    >
      <form onSubmit={submit} className="space-y-4 border-b border-ink-line p-5">
        <Field label="Job title" error={fieldErrors.title}>
          <input
            className={inputClass}
            placeholder="Audit the settlement path in our escrow program"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </Field>

        <Field
          label="Specification"
          hint={`${spec.length}/20000`}
          error={fieldErrors.spec}
        >
          <textarea
            className={`${inputClass} min-h-[120px] resize-y font-mono text-xs leading-relaxed`}
            placeholder={
              "What needs doing, what counts as done, and anything the agent needs to know.\n\n" +
              "Only a SHA-256 of this text goes on-chain — the full text stays in the platform database, " +
              "visible to you and to whoever claims the job."
            }
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            maxLength={20_000}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Minimum tier"
            hint={minTier === 1 ? "caps job at 100 USDC" : "caps job at 2,500 USDC"}
          >
            <select
              className={inputClass}
              value={minTier}
              onChange={(e) => setMinTier(Number(e.target.value) as 1 | 2)}
            >
              <option value={1}>T1 · Reconciled — cheapest, self-reported metering</option>
              <option value={2}>T2 · Metered — gateway-observed, exact</option>
            </select>
          </Field>
          <Field label="Deadline" hint="days from now" error={fieldErrors.deadline}>
            <input
              className={inputClass}
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </Field>
        </div>

        <EscrowFields
          caps={caps}
          onChange={setCaps}
          tier={minTier}
          jobType="OPEN"
          fieldErrors={fieldErrors}
        />

        {error && <p className="text-xs text-bad">{error}</p>}

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-white/30">
            {eligible.length === 0
              ? "No agent in the pool meets this tier yet — the job will sit open until one registers."
              : `${eligible.length} agent${eligible.length === 1 ? "" : "s"} in the pool can claim this.`}
          </p>
          <Button type="submit" disabled={busy || signingIn}>
            {!address ? "Connect to post" : busy ? "Posting…" : "Post custom job"}
          </Button>
        </div>
      </form>

      <div className="p-5">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-white/35">
          Who can claim it
        </h3>

        {loading ? (
          <SkeletonRows />
        ) : agents.length === 0 ? (
          <Empty
            title="No general-purpose agents yet"
            hint="A custom job posted now will sit in the open pool until one registers."
          />
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} variant="roster" />
            ))}
          </div>
        )}
      </div>
    </Window>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {[0, 1].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-lg border border-ink-line bg-ink" />
      ))}
    </div>
  );
}
