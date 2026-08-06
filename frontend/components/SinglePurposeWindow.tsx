"use client";

import { useMemo, useState } from "react";

import type { Agent, CategoryGroup } from "@/lib/types";
import { AgentCard } from "./AgentCard";
import { HireDialog } from "./HireDialog";
import { Badge, Empty, Window, cx, inputClass } from "./ui";

const ALL = "__all__";

/**
 * The single-purpose window.
 *
 * Agents here are browsed **by category** and hired **individually**. Both
 * halves matter: the category rail is the navigation, and the action on a card
 * is "hire this one", not "post a job and hope".
 *
 * The grouping arrives from the API already bucketed
 * (`GET /agents/by-category`). Deliberately not a flat list this component
 * buckets itself — doing the grouping in two places is how an agent ends up in
 * the wrong window, which is the bug this rebuild exists to fix.
 */
export function SinglePurposeWindow({
  groups,
  loading,
}: {
  groups: CategoryGroup[];
  loading: boolean;
}) {
  const [selected, setSelected] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [hiring, setHiring] = useState<Agent | null>(null);

  const totalAgents = groups.reduce((n, g) => n + g.agents.length, 0);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups
      .filter((g) => selected === ALL || g.slug === selected)
      .map((g) => ({
        ...g,
        agents: q
          ? g.agents.filter(
              (a) =>
                a.name.toLowerCase().includes(q) ||
                a.summary.toLowerCase().includes(q) ||
                a.descriptor.capabilities?.some((c) => c.toLowerCase().includes(q))
            )
          : g.agents,
      }))
      .filter((g) => g.agents.length > 0);
  }, [groups, selected, query]);

  return (
    <>
      <Window
        title="Single purpose"
        subtitle="Agents built for one job, sorted by category. Pick one and hire it directly."
        accessory={<Badge tone="neutral">{totalAgents} agents</Badge>}
      >
        <div className="sticky top-0 z-10 space-y-3 border-b border-ink-line bg-ink-soft/95 px-5 py-3 backdrop-blur">
          <input
            className={inputClass}
            placeholder="Search agents and capabilities"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {/* The category rail. "All" keeps the headings so the grouping stays
              legible when nothing is filtered. */}
          <div className="flex flex-wrap gap-1.5">
            <CategoryChip
              label="All"
              count={totalAgents}
              active={selected === ALL}
              onClick={() => setSelected(ALL)}
            />
            {groups.map((g) => (
              <CategoryChip
                key={g.id}
                label={g.label}
                count={g.agents.length}
                title={g.description ?? undefined}
                active={selected === g.slug}
                onClick={() => setSelected(g.slug)}
              />
            ))}
          </div>
        </div>

        <div className="p-5">
          {loading ? (
            <SkeletonGrid />
          ) : visible.length === 0 ? (
            <Empty
              title={query ? "Nothing matches that search" : "No single-purpose agents yet"}
              hint={
                query
                  ? "Try a broader term, or clear the category filter."
                  : "Register one and pick a category — security audit, predictive betting, teacher, or your own."
              }
            />
          ) : (
            <div className="space-y-7">
              {visible.map((group) => (
                <section key={group.id}>
                  <div className="mb-3 flex items-baseline gap-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-white/45">
                      {group.label}
                    </h3>
                    <span className="text-[11px] text-white/25">{group.agents.length}</span>
                    {group.description && selected !== ALL && (
                      <p className="ml-2 truncate text-[11px] text-white/30">{group.description}</p>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {group.agents.map((agent) => (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        variant="hire"
                        onHire={setHiring}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </Window>

      {hiring && <HireDialog agent={hiring} onClose={() => setHiring(null)} />}
    </>
  );
}

function CategoryChip({
  label,
  count,
  active,
  title,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-ink-line text-white/50 hover:border-white/25 hover:text-white/80"
      )}
    >
      {label}
      <span className={cx("ml-1.5", active ? "text-accent/60" : "text-white/25")}>{count}</span>
    </button>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-44 animate-pulse rounded-lg border border-ink-line bg-ink" />
      ))}
    </div>
  );
}
