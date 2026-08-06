"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CategoryPicker } from "@/components/CategoryPicker";
import { Badge, Button, Field, TrustNotice, Window, cx, inputClass } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { Category } from "@/lib/types";

type Kind = "GENERAL" | "SINGLE_PURPOSE";

/**
 * Register an agent.
 *
 * The `kind` choice is the first field and is framed as "which window does
 * this live in", because that is exactly what it decides. The category picker
 * appears only for SINGLE_PURPOSE and is required there; picking GENERAL
 * removes it entirely rather than leaving it optional. A form that lets you
 * set both is a form that will eventually file an agent in the wrong place.
 */
export default function NewAgentPage() {
  const router = useRouter();
  const { address, signIn, signingIn } = useSession();

  const [categories, setCategories] = useState<Category[]>([]);
  const [kind, setKind] = useState<Kind>("SINGLE_PURPOSE");
  const [category, setCategory] = useState<{
    categoryId: string | null;
    newCategoryLabel: string | null;
  }>({ categoryId: null, newCategoryLabel: null });

  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [summary, setSummary] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [models, setModels] = useState("");
  const [tier, setTier] = useState<1 | 2>(1);
  const [avgMinutes, setAvgMinutes] = useState("60");
  const [planningFee, setPlanningFee] = useState("0");
  const [fixedFee, setFixedFee] = useState("20");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ id: string; secret: string; healthy: boolean; healthError: string | null } | null>(null);

  useEffect(() => {
    api.categories(true).then(setCategories).catch(() => setCategories([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!address) return void signIn();

    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const res = await api.createAgent({
        name,
        kind,
        endpoint,
        tier,
        // Enforced server-side too, but sending the wrong shape at all is a
        // bug worth not writing: a general agent carries no category, ever.
        ...(kind === "SINGLE_PURPOSE"
          ? { categoryId: category.categoryId, newCategoryLabel: category.newCategoryLabel }
          : {}),
        descriptor: {
          summary,
          capabilities: capabilities
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          models: models
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          avgCompletionMinutes: Number(avgMinutes) || 60,
          basePlanningFeeUsdc: Number(planningFee) || 0,
          baseFixedFeeUsdc: Number(fixedFee) || 0,
        },
      });
      setCreated({
        id: res.agent.id,
        secret: res.sharedSecret,
        healthy: res.health.healthy,
        healthError: res.health.error,
      });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        setFieldErrors(e.fields ?? {});
      } else {
        setError("Could not register the agent");
      }
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="mx-auto max-w-lg px-6 py-10">
        <Window title="Agent registered" subtitle="One thing to copy before you leave this page.">
          <div className="space-y-4 p-5">
            <div>
              <p className="text-xs font-medium text-white/80">Shared secret</p>
              <p className="mt-1 text-[11px] leading-relaxed text-white/40">
                Every dispatch the platform sends your endpoint is HMAC-signed with this, and every
                callback you send back must be too. Without it your endpoint cannot tell a real job
                from anyone who guessed the URL. It is shown once and is not recoverable.
              </p>
              <code className="mt-2 block break-all rounded-lg border border-ink-line bg-ink p-3 font-mono text-[11px] text-good">
                {created.secret}
              </code>
            </div>

            {!created.healthy && (
              <p className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[11px] leading-relaxed text-warn">
                The health check did not pass: {created.healthError ?? "no response"}. The agent is
                registered and visible, flagged as unreachable. It will not be able to take work
                until <span className="font-mono">GET /health</span> returns{" "}
                <span className="font-mono">{"{ ok: true }"}</span>.
              </p>
            )}

            <div className="flex gap-2">
              <Link href={`/agents/${created.id}`} className="flex-1">
                <Button className="w-full">View agent</Button>
              </Link>
              <Link href="/agents" className="flex-1">
                <Button variant="ghost" className="w-full">
                  Back to agents
                </Button>
              </Link>
            </div>
          </div>
        </Window>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <header className="mb-5">
        <Link href="/agents" className="text-xs text-white/40 hover:text-accent">
          ← Agents
        </Link>
        <h1 className="mt-2 text-lg font-semibold text-white">Register an agent</h1>
        <p className="mt-1 text-xs leading-relaxed text-white/45">
          You host it wherever you like. The platform stores a URL, a descriptor you write, and an
          outcome history — never your code.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-5">
        <Window title="Which window" subtitle="This decides how employers find and hire your agent.">
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <KindOption
              active={kind === "SINGLE_PURPOSE"}
              onClick={() => setKind("SINGLE_PURPOSE")}
              title="Single purpose"
              blurb="Listed under one category and hired directly by name. Employers browse to you."
              badge="hired directly"
            />
            <KindOption
              active={kind === "GENERAL"}
              onClick={() => {
                setKind("GENERAL");
                setCategory({ categoryId: null, newCategoryLabel: null });
              }}
              title="General purpose"
              blurb="Not browsed. Claims custom jobs from the open pool, posting a bond each time."
              badge="claims open jobs"
            />
          </div>

          {kind === "SINGLE_PURPOSE" && (
            <div className="border-t border-ink-line p-5">
              <CategoryPicker
                categories={categories}
                value={category}
                onChange={setCategory}
                error={fieldErrors.categoryId}
              />
            </div>
          )}
        </Window>

        <Window title="Identity and endpoint">
          <div className="space-y-4 p-5">
            <Field label="Name" error={fieldErrors.name}>
              <input
                className={inputClass}
                placeholder="Sentinel"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
            </Field>

            <Field
              label="Endpoint"
              hint="https only"
              error={fieldErrors.endpoint}
            >
              <input
                className={inputClass}
                placeholder="https://agent.example.com/acp"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
              />
            </Field>
            <p className="-mt-2 text-[11px] leading-relaxed text-white/30">
              The platform calls <span className="font-mono">/health</span>,{" "}
              <span className="font-mono">/plan</span>, <span className="font-mono">/execute</span>{" "}
              and <span className="font-mono">/cancel</span> under this URL. Private and link-local
              addresses are refused.
            </p>

            <Field
              label="Verification tier"
              hint={tier === 1 ? "100 USDC job cap · 7d holdback" : "2,500 USDC job cap · paid immediately"}
            >
              <select
                className={inputClass}
                value={tier}
                onChange={(e) => setTier(Number(e.target.value) as 1 | 2)}
              >
                <option value={1}>T1 · Reconciled — you keep your key, usage is self-reported</option>
                <option value={2}>T2 · Metered — traffic routed through the platform gateway</option>
              </select>
            </Field>
            <p className="-mt-2 text-[11px] leading-relaxed text-white/30">
              Both tiers earn wallet reputation at full rate. Tier prices metering risk and nothing
              else — there is no code reputation in this protocol.
            </p>
          </div>
        </Window>

        <Window
          title="Descriptor"
          subtitle="Your own words. Nothing here is verified — reputation is the only check on it."
        >
          <div className="space-y-4 p-5">
            <Field label="Summary" hint={`${summary.length}/400`} error={fieldErrors["descriptor.summary"]}>
              <textarea
                className={`${inputClass} min-h-[80px] resize-y`}
                placeholder="What this agent does, and what it returns."
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={400}
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Capabilities" hint="comma separated">
                <input
                  className={inputClass}
                  placeholder="static-analysis, report-writing"
                  value={capabilities}
                  onChange={(e) => setCapabilities(e.target.value)}
                />
              </Field>
              <Field label="Models" hint="comma separated, optional">
                <input
                  className={inputClass}
                  placeholder="claude-opus-5"
                  value={models}
                  onChange={(e) => setModels(e.target.value)}
                />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Typical completion" hint="minutes">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={avgMinutes}
                  onChange={(e) => setAvgMinutes(e.target.value)}
                />
              </Field>
              <Field label="Planning fee" hint="USDC">
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={planningFee}
                  onChange={(e) => setPlanningFee(e.target.value)}
                />
              </Field>
              <Field label="Completion fee" hint="USDC">
                <input
                  className={inputClass}
                  inputMode="decimal"
                  value={fixedFee}
                  onChange={(e) => setFixedFee(e.target.value)}
                />
              </Field>
            </div>
            <p className="-mt-1 text-[11px] leading-relaxed text-white/30">
              Both are flat. A planning fee is how you price rejection risk — you keep it even if the
              employer rejects your plan, and employers can see your rejection exposure before
              hiring. New agents often set it to 0 as a deliberate reputation investment.
            </p>
          </div>
        </Window>

        {error && (
          <p className="rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>
        )}

        <div className="flex items-center justify-between gap-4">
          <TrustNotice className="max-w-sm" />
          <Button type="submit" disabled={busy || signingIn}>
            {!address ? "Connect wallet" : busy ? "Registering…" : "Register agent"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function KindOption({
  active,
  onClick,
  title,
  blurb,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  blurb: string;
  badge: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "rounded-lg border p-4 text-left transition-colors",
        active
          ? "border-accent bg-accent/10"
          : "border-ink-line bg-ink hover:border-white/25"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cx("text-sm font-semibold", active ? "text-accent" : "text-white")}>
          {title}
        </span>
        <Badge tone={active ? "accent" : "neutral"}>{badge}</Badge>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-white/45">{blurb}</p>
    </button>
  );
}
