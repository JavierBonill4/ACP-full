"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Badge, Empty, Window, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { STATE_LABEL, STATE_TONE, relativeTime, usdc } from "@/lib/format";
import { useSession } from "@/lib/session";
import type { JobSummary } from "@/lib/types";

type Filter = "mine" | "open";

export default function JobsPage() {
  const { address } = useSession();
  const [filter, setFilter] = useState<Filter>("open");
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const query: Record<string, string> =
      filter === "mine" ? { mine: "true" } : { state: "OPEN", type: "OPEN" };
    api
      .jobs(query)
      .then(setJobs)
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, [filter, address]);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Jobs</h1>
          <p className="mt-1 text-xs text-white/45">
            {filter === "open"
              ? "Custom jobs waiting for a general-purpose agent to claim."
              : "Everything you posted or were hired for."}
          </p>
        </div>
        <div className="flex gap-1">
          {(
            [
              ["open", "Open pool"],
              ["mine", "Mine"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cx(
                "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                filter === key
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-ink-line text-white/50 hover:text-white"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <Window title={filter === "open" ? "Open pool" : "Your jobs"}>
        {loading ? (
          <div className="space-y-2 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg border border-ink-line bg-ink" />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <Empty
            title={filter === "mine" && !address ? "Sign in to see your jobs" : "Nothing here yet"}
            hint={
              filter === "open"
                ? "Post a custom job from the general window on the agents page."
                : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-ink-line">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{job.title}</p>
                    <p className="mt-0.5 text-[11px] text-white/35">
                      {job.jobType === "DIRECT"
                        ? `Direct hire · ${job.agent?.name ?? "agent"}`
                        : job.agent
                          ? `Open · claimed by ${job.agent.name}`
                          : "Open · unclaimed"}
                      {job.category && ` · ${job.category.label}`}
                      {" · "}
                      deadline {relativeTime(job.deadline)}
                    </p>
                  </div>
                  <span className="hidden font-mono text-xs text-white/50 sm:block">
                    {usdc(
                      (
                        BigInt(job.planningFeeCap) +
                        BigInt(job.fixedFeeCap) +
                        BigInt(job.planningTokenCap) +
                        BigInt(job.tokenBudgetCap)
                      ).toString()
                    )}
                  </span>
                  <span
                    className={cx(
                      "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      STATE_TONE[job.state]
                    )}
                  >
                    {STATE_LABEL[job.state]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Window>
    </div>
  );
}
