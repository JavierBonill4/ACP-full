"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";

import { ApiError, api } from "@/lib/api";
import { duration, usdc } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useAcpProgram } from "@/lib/anchor";
import { postJob, sha256Bytes } from "@/lib/transactions";
import type { Agent } from "@/lib/types";
import { EscrowFields, capsToBase, type Caps } from "./EscrowFields";
import { Button, Field, ReputationBadge, TierBadge, inputClass } from "./ui";

/**
 * Hiring a specific agent — the single-purpose window's action.
 *
 * Ceilings are pre-filled from the agent's own descriptor, so the default is
 * exactly what the operator advertised. They stay editable: the descriptor is
 * an unverified claim, and an employer who wants to fund less than the asking
 * price should be able to, and be turned down.
 *
 * This creates a DIRECT job: the agent is named, no bond is posted (the
 * employer chose them), and it must accept inside the 6h offer window or the
 * escrow comes back.
 *
 * Two steps, in this order — backend/src/services/jobs.ts assigns
 * nonce/pda when the DB row is created, so that has to happen BEFORE the
 * on-chain post_job transaction can use them:
 *   1. api.createDirectJob(...)   — DB row created, nonce/pda assigned
 *   2. postJob(ctx, { nonce, expectedPda, ... })  — wallet signs, escrow funds
 *      then api.confirmJob(...)   — records the confirmed signature
 * If step 2 fails, the DB row from step 1 already exists — this does not
 * retry automatically (that would risk a duplicate job on a second click),
 * it surfaces the job so the employer can find it and fund it from there.
 */
export function HireDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const router = useRouter();
  const { address, signIn, signingIn } = useSession();
  const ctx = useAcpProgram();

  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [days, setDays] = useState("7");
  const [caps, setCaps] = useState<Caps>({
    planningFeeCap: (Number(agent.basePlanningFee) / 1e6).toString(),
    fixedFeeCap: (Number(agent.baseFixedFee) / 1e6).toString(),
    planningTokenCap: "2",
    tokenBudgetCap: "25",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [createdJobId, setCreatedJobId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return void signIn();
    if (!ctx) {
      setError("Connect a wallet that can sign transactions to fund escrow on-chain.");
      return;
    }

    setBusy(true);
    setError(null);
    setFieldErrors({});
    setCreatedJobId(null);
    const base = capsToBase(caps);
    const deadline = new Date(Date.now() + Number(days) * 86_400_000);

    // Step 1: create the DB row. This is what assigns nonce/pda.
    let job: Awaited<ReturnType<typeof api.createDirectJob>>;
    try {
      job = await api.createDirectJob({
        agentId: agent.id,
        title,
        spec,
        planningFeeCap: Number(base.planningFeeCap) / 1e6,
        fixedFeeCap: Number(base.fixedFeeCap) / 1e6,
        planningTokenCap: Number(base.planningTokenCap) / 1e6,
        tokenBudgetCap: Number(base.tokenBudgetCap) / 1e6,
        deadline: deadline.toISOString(),
      });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fields ?? {});
      } else {
        setError("Could not create the job");
      }
      setBusy(false);
      return;
    }

    // Step 2: sign post_job with the nonce the backend just assigned, and
    // record the confirmed signature. A mismatch between `job.nonce` and
    // what postJob derives throws here, before any transaction is sent —
    // see transactions.ts's expectedPda check.
    try {
      const specHash = await sha256Bytes(spec);
      const { signature } = await postJob(ctx, {
        jobType: "direct",
        agent: new PublicKey(agent.wallet),
        specHash,
        planningFeeCapUsdc: Number(base.planningFeeCap) / 1e6,
        fixedFeeCapUsdc: Number(base.fixedFeeCap) / 1e6,
        planningTokenCapUsdc: Number(base.planningTokenCap) / 1e6,
        tokenBudgetCapUsdc: Number(base.tokenBudgetCap) / 1e6,
        minTier: agent.tier,
        deadline,
        nonce: job.nonce,
        expectedPda: new PublicKey(job.pda!),
      });
      await api.confirmJob(job.id, { signature });
    } catch (e) {
      setCreatedJobId(job.id);
      setError(
        `The job was created, but funding escrow failed: ${
          e instanceof Error ? e.message : "unknown error"
        }. Open the job below to try again.`
      );
      setBusy(false);
      return;
    }

    router.push(`/jobs/${job.id}`);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-8"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-lg space-y-4 rounded-xl border border-ink-line bg-ink-soft p-5 shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-white/35">
              Hire · {agent.category?.label ?? "single purpose"}
            </p>
            <h2 className="mt-0.5 flex items-center gap-2 text-base font-semibold text-white">
              {agent.name}
              <TierBadge tier={agent.tier} />
            </h2>
            <div className="mt-2">
              <ReputationBadge rep={agent.reputation} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-white/40 hover:bg-white/5 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <p className="rounded-lg border border-ink-line bg-ink px-3 py-2 text-xs leading-relaxed text-white/50">
          {agent.summary}
          <span className="mt-1.5 block text-white/30">
            Typically finishes in ~{duration(agent.avgCompletionMinutes)}. Advertised fee{" "}
            {usdc(agent.baseFixedFee)} USDC. Neither is verified — reputation is the only check
            on whether an agent does what it says.
          </span>
        </p>

        <Field label="Job title" error={fieldErrors.title}>
          <input
            className={inputClass}
            placeholder={`${agent.name} engagement`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </Field>

        <Field label="What you need" hint={`${spec.length}/20000`} error={fieldErrors.spec}>
          <textarea
            className={`${inputClass} min-h-[110px] resize-y font-mono text-xs leading-relaxed`}
            placeholder="Describe the work and what counts as done."
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            maxLength={20_000}
          />
        </Field>

        <Field label="Deadline" hint="days from now" error={fieldErrors.deadline}>
          <input
            className={inputClass}
            inputMode="numeric"
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </Field>

        <EscrowFields
          caps={caps}
          onChange={setCaps}
          tier={agent.tier}
          jobType="DIRECT"
          fieldErrors={fieldErrors}
        />

        <p className="text-[11px] leading-relaxed text-white/30">
          No bond is posted — you chose this agent, so there is no job-squatting to deter. It has
          6 hours to accept; if it does not, your escrow returns in full.
        </p>

        {!ctx && (
          <p className="text-[11px] leading-relaxed text-warn">
            No wallet capable of signing transactions is connected — hiring needs to fund escrow
            on-chain, not just create the listing.
          </p>
        )}

        {error && (
          <p className="text-xs text-bad">
            {error}
            {createdJobId && (
              <>
                {" "}
                <a
                  href={`/jobs/${createdJobId}`}
                  className="underline hover:text-white"
                >
                  Open job
                </a>
              </>
            )}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || signingIn}>
            {!address ? "Connect to hire" : busy ? "Creating…" : `Hire ${agent.name}`}
          </Button>
        </div>
      </form>
    </div>
  );
}
