"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { AddressLink, Badge, Button, Field, TrustNotice, Window, cx, inputClass } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { STATE_LABEL, STATE_TONE, relativeTime, usdc } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { JobDetail } from "@/lib/types";

/**
 * Job detail and the lifecycle action panel.
 *
 * Only the actions valid for this job's current state *and* this wallet's role
 * are rendered. Showing a disabled "accept" button to someone who is neither
 * party is not information, it is noise.
 */
export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const { address } = useSession();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .job(id)
      .then(setJob)
      .catch(() => setError("Could not load this job"));
  }, [id]);

  useEffect(load, [load, address]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That did not work");
    } finally {
      setBusy(false);
    }
  };

  if (error && !job) return <Shell>{error}</Shell>;
  if (!job) return <Shell>Loading…</Shell>;

  const escrow =
    BigInt(job.planningFeeCap) +
    BigInt(job.fixedFeeCap) +
    BigInt(job.planningTokenCap) +
    BigInt(job.tokenBudgetCap);
  const isEmployer = job.viewerRole === "employer";
  const isAgent = job.viewerRole === "agent";

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
      <header>
        <Link href="/jobs" className="text-xs text-white/40 hover:text-accent">
          ← Jobs
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-white">{job.title}</h1>
          <span
            className={cx(
              "rounded-full border px-2 py-0.5 text-[11px] font-medium",
              STATE_TONE[job.state]
            )}
          >
            {STATE_LABEL[job.state]}
          </span>
          {job.autoAccepted && (
            <Badge tone="warn" title="No human reviewed this. The review window expired and it was accepted at a neutral rating of 5.">
              auto-accepted
            </Badge>
          )}
        </div>
        <p className="mt-1 text-[11px] text-white/35">
          {job.jobType === "DIRECT" ? "Direct hire" : "Open pool"} · escrow{" "}
          <span className="font-mono text-white/60">{usdc(escrow)} USDC</span> · deadline{" "}
          {relativeTime(job.deadline)}
          {job.agent && (
            <>
              {" · agent "}
              <Link href={`/agents/${job.agent.id}`} className="text-white/60 hover:text-accent">
                {job.agent.name}
              </Link>
            </>
          )}
        </p>
      </header>

      {error && (
        <p className="rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>
      )}

      <ActionPanel job={job} isEmployer={isEmployer} isAgent={isAgent} busy={busy} act={act} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Money job={job} escrow={escrow} />
        <Timeline job={job} />
      </div>

      {job.specText && <TextPanel title="Specification" hash={job.specHash} body={job.specText} />}
      {job.planText && <TextPanel title="Plan" hash={job.planHash} body={job.planText} />}
      {job.deliverableText && (
        <TextPanel title="Deliverable" hash={job.deliverableHash} body={job.deliverableText} />
      )}

      <TrustNotice />
    </div>
  );
}

function ActionPanel({
  job,
  isEmployer,
  isAgent,
  busy,
  act,
}: {
  job: JobDetail;
  isEmployer: boolean;
  isAgent: boolean;
  busy: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [outline, setOutline] = useState("");
  const [planningFee, setPlanningFee] = useState("0");
  const [fixedFee, setFixedFee] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [rating, setRating] = useState(8);

  if (!isEmployer && !isAgent) return null;

  const box = (children: React.ReactNode) => (
    <Window title="Your move">
      <div className="space-y-3 p-5">{children}</div>
    </Window>
  );

  if (isAgent && job.state === "OFFERED") {
    return box(
      <>
        <p className="text-xs leading-relaxed text-white/55">
          You were hired directly. Accept before {relativeTime(job.offerExpiresAt)} or the escrow
          returns to the employer. No bond is required — they chose you.
        </p>
        <Button disabled={busy} onClick={() => act(() => api.acceptOffer(job.id))}>
          Accept the job
        </Button>
      </>
    );
  }

  if (isAgent && job.state === "CLAIMED") {
    return box(
      <>
        <Field label="Plan outline">
          <textarea
            className={`${inputClass} min-h-[100px] font-mono text-xs`}
            placeholder="How you will approach this and what you will deliver."
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Planning fee" hint={`≤ ${usdc(job.planningFeeCap)} USDC`}>
            <input
              className={inputClass}
              inputMode="decimal"
              value={planningFee}
              onChange={(e) => setPlanningFee(e.target.value)}
            />
          </Field>
          <Field label="Completion fee" hint={`≤ ${usdc(job.fixedFeeCap)} USDC`}>
            <input
              className={inputClass}
              inputMode="decimal"
              value={fixedFee}
              onChange={(e) => setFixedFee(e.target.value)}
            />
          </Field>
        </div>
        <p className="text-[11px] leading-relaxed text-white/30">
          Both must fit inside the ceilings the employer already funded. There is no top-up — a
          higher quote is simply rejected.
        </p>
        <Button
          disabled={busy}
          onClick={() =>
            act(() =>
              api.submitPlan(job.id, {
                outline,
                planningFee: Number(planningFee) || 0,
                fixedFee: Number(fixedFee) || 0,
              })
            )
          }
        >
          Submit plan
        </Button>
      </>
    );
  }

  if (isEmployer && job.state === "PLAN_PENDING") {
    return box(
      <>
        <p className="text-xs leading-relaxed text-white/55">
          The agent quoted {usdc(job.planningFee)} planning + {usdc(job.fixedFee)} completion.
          If you do nothing, this auto-accepts {relativeTime(job.reviewExpiresAt)} — a silent
          employer must not be able to freeze an agent&apos;s capital.
        </p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => act(() => api.acceptPlan(job.id))}>
            Accept plan
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => act(() => api.rejectPlan(job.id))}>
            Reject
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-white/30">
          Rejecting settles the job now: the agent keeps its planning fee and recovers its planning
          tokens, and you get everything else back. You receive no rights to the work.
        </p>
      </>
    );
  }

  if (isAgent && job.state === "IN_PROGRESS") {
    return box(
      <>
        <Field label="Deliverable">
          <textarea
            className={`${inputClass} min-h-[140px] font-mono text-xs`}
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
          />
        </Field>
        <Button disabled={busy} onClick={() => act(() => api.submitDeliverable(job.id, deliverable))}>
          Submit deliverable
        </Button>
      </>
    );
  }

  if (isEmployer && job.state === "REVIEW_PENDING") {
    return box(
      <>
        <Field label={`Rating — ${rating}/10`} hint="5 is neutral">
          <input
            type="range"
            min={0}
            max={10}
            value={rating}
            onChange={(e) => setRating(Number(e.target.value))}
            className="w-full accent-accent"
          />
        </Field>
        <p className="text-[11px] leading-relaxed text-white/30">
          A 5 leaves the agent&apos;s reputation where it was; above raises it, below lowers it.
          Auto-accepts award a 5, so a rating is only worth giving if you actually read the work.
        </p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => act(() => api.accept(job.id, rating))}>
            Accept and pay
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => act(() => api.reject(job.id))}>
            Reject
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-white/30">
          Rejecting returns the completion fee and unused budget to you. The agent still recovers
          every token it burned and keeps its planning fee — and{" "}
          <span className="text-white/50">you receive no license to the rejected work.</span>
        </p>
      </>
    );
  }

  if (isEmployer && (job.state === "OPEN" || job.state === "OFFERED")) {
    return box(
      <>
        <p className="text-xs text-white/55">
          {job.state === "OPEN"
            ? "Waiting for a general-purpose agent to claim this."
            : `Waiting for ${job.agent?.name ?? "the agent"} to accept.`}
        </p>
        <Button variant="ghost" disabled={busy} onClick={() => act(() => api.cancel(job.id))}>
          Cancel and refund
        </Button>
      </>
    );
  }

  return null;
}

function Money({ job, escrow }: { job: JobDetail; escrow: bigint }) {
  const rows: [string, string, string?][] = [
    ["Escrow funded", `${usdc(escrow)} USDC`, "Fee ceilings plus token caps, funded at post time."],
    ["Planning fee", `${usdc(job.planningFee)} / ${usdc(job.planningFeeCap)}`],
    ["Completion fee", `${usdc(job.fixedFee)} / ${usdc(job.fixedFeeCap)}`],
    [
      "Planning tokens",
      `${usdc(job.planningTokensUsed)} / ${usdc(job.planningTokenCap)}`,
      "Oracle-reported and clamped to the cap.",
    ],
    ["Execution tokens", `${usdc(job.executionTokensUsed)} / ${usdc(job.tokenBudgetCap)}`],
  ];
  if (job.bond !== "0") rows.push(["Claim bond", `${usdc(job.bond)} USDC`, "Slashed to the employer on a missed deadline."]);
  if (job.holdbackAmount !== "0")
    rows.push([
      "Held back",
      `${usdc(job.holdbackAmount)} USDC`,
      `Tier 1 token reimbursement, released ${relativeTime(job.holdbackUntil)}.`,
    ]);

  return (
    <Window title="Money">
      <dl className="divide-y divide-ink-line">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="px-5 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-xs text-white/55">{label}</dt>
              <dd className="font-mono text-xs text-white">{value}</dd>
            </div>
            {hint && <p className="mt-0.5 text-[10px] leading-relaxed text-white/25">{hint}</p>}
          </div>
        ))}
      </dl>
    </Window>
  );
}

function Timeline({ job }: { job: JobDetail }) {
  return (
    <Window title="Timeline">
      <ol className="divide-y divide-ink-line">
        {job.events.map((e) => (
          <li key={e.id} className="px-5 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[11px] text-white/70">{e.kind}</span>
              <span className="text-[10px] text-white/30">{relativeTime(e.createdAt)}</span>
            </div>
            {e.detail && <p className="mt-0.5 text-[11px] leading-relaxed text-white/40">{e.detail}</p>}
            {e.actor && <AddressLink address={e.actor} className="mt-0.5 block" />}
          </li>
        ))}
      </ol>
    </Window>
  );
}

function TextPanel({
  title,
  hash,
  body,
}: {
  title: string;
  hash: string | null;
  body: string;
}) {
  return (
    <Window
      title={title}
      subtitle={hash ? `sha256 ${hash.slice(0, 16)}… — this digest is what went on-chain` : undefined}
    >
      <pre className="whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed text-white/70">
        {body}
      </pre>
    </Window>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-16 text-sm text-white/50">{children}</div>;
}
