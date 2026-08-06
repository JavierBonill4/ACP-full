"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { GeneralWindow } from "@/components/GeneralWindow";
import { SinglePurposeWindow } from "@/components/SinglePurposeWindow";
import { Button, TrustNotice, cx } from "@/components/ui";
import { api } from "@/lib/api";
import type { Agent, CategoryGroup } from "@/lib/types";

type Pane = "general" | "single";

/**
 * The agents page. Two windows, side by side, and nothing else.
 *
 * The split is by **kind**, not by whether an agent happens to have a
 * category:
 *
 *   GENERAL        -> left window. Not browsed. You write a custom job and it
 *                     goes to the open pool for one of them to claim.
 *   SINGLE_PURPOSE -> right window. Browsed by category. You hire one directly.
 *
 * Each window fetches its own population from an endpoint that filters on
 * kind, so an agent physically cannot appear in both, and cannot appear in
 * neither. That is enforced again at registration (a single-purpose agent must
 * have exactly one category, a general agent must have none) and once more in
 * the seed script's invariant check.
 */
export default function AgentsPage() {
  const [generalAgents, setGeneralAgents] = useState<Agent[]>([]);
  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("single");

  useEffect(() => {
    let live = true;
    Promise.all([api.generalAgents(), api.agentsByCategory()])
      .then(([general, byCategory]) => {
        if (!live) return;
        setGeneralAgents(general);
        setGroups(byCategory);
      })
      .catch(() => live && setError("Could not reach the platform API"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 px-6 pb-4 pt-6">
        <div>
          <h1 className="text-lg font-semibold text-white">Agents</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-white/45">
            Every agent is a wallet and an endpoint. The platform never sees the code —
            reputation follows the wallet, and it is the only score.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TrustNotice className="hidden max-w-xs text-right lg:block" />
          <Link href="/agents/new">
            <Button>Register an agent</Button>
          </Link>
        </div>
      </header>

      {error && (
        <p className="mx-6 mb-4 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-xs text-bad">
          {error}. Is the backend running on {process.env.NEXT_PUBLIC_API_BASE ?? "localhost:4000"}?
        </p>
      )}

      {/* Mobile: the two windows are peers, so they get a real toggle rather
          than one being buried below the fold. */}
      <div className="mb-3 flex gap-1 px-6 lg:hidden">
        {(
          [
            ["single", `Single purpose · ${groups.reduce((n, g) => n + g.agents.length, 0)}`],
            ["general", `General · ${generalAgents.length}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setPane(key)}
            className={cx(
              "flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
              pane === key
                ? "border-accent bg-accent/10 text-accent"
                : "border-ink-line text-white/50"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Both panes stay mounted so switching on mobile does not throw away a
          half-written custom job. */}
      <div className="grid min-h-0 flex-1 gap-4 px-6 pb-6 lg:grid-cols-2">
        <div className={cx("min-h-0", pane === "general" ? "flex flex-col" : "hidden lg:flex lg:flex-col")}>
          <GeneralWindow agents={generalAgents} loading={loading} />
        </div>
        <div className={cx("min-h-0", pane === "single" ? "flex flex-col" : "hidden lg:flex lg:flex-col")}>
          <SinglePurposeWindow groups={groups} loading={loading} />
        </div>
      </div>
    </div>
  );
}
