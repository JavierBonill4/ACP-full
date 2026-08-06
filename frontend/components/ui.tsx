"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { TIER_BLURB, TIER_LABEL, shortAddress, usdc, wrs } from "@/lib/format";
import type { Reputation } from "@/lib/types";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

// --- window chrome ---------------------------------------------------------

/**
 * A "window" is a titled panel. The agents page is two of them and nothing
 * else, so the chrome is defined once here and neither side can drift into
 * looking like a different kind of surface.
 */
export function Window({
  title,
  subtitle,
  accessory,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  accessory?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ink-line bg-ink-soft",
        className
      )}
    >
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-ink-line px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-white">{title}</h2>
          {subtitle && <p className="mt-1 max-w-prose text-xs leading-relaxed text-white/45">{subtitle}</p>}
        </div>
        {accessory}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm text-white/70">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-white/40">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// --- badges ----------------------------------------------------------------

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "accent";
  title?: string;
}) {
  const tones = {
    neutral: "border-white/15 bg-white/5 text-white/60",
    good: "border-good/40 bg-good/10 text-good",
    warn: "border-warn/40 bg-warn/10 text-warn",
    bad: "border-bad/40 bg-bad/10 text-bad",
    accent: "border-accent/40 bg-accent/10 text-accent",
  } as const;
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}

export function TierBadge({ tier }: { tier: number }) {
  return (
    <Badge tone={tier === 2 ? "accent" : "neutral"} title={TIER_BLURB[tier]}>
      {TIER_LABEL[tier] ?? `T${tier}`}
    </Badge>
  );
}

/**
 * Score and record, always together.
 *
 * WRS floors at zero, so `0.0` on its own is ambiguous between "brand new" and
 * "burned through fourteen jobs and lost eleven". The lifetime counters are
 * the only thing that separates those, and they are monotonic on-chain
 * precisely so this component can be trusted. Rendering the score without them
 * is lying by omission — do not add a variant that does.
 */
export function ReputationBadge({ rep, size = "sm" }: { rep: Reputation; size?: "sm" | "lg" }) {
  const big = size === "lg";

  if (rep.isNew) {
    return (
      <div className={cx("flex items-baseline gap-2", big && "text-base")}>
        <span className={cx("font-mono text-white/40", big ? "text-2xl" : "text-sm")}>0.0</span>
        <Badge tone="neutral" title="No settled jobs yet. This is an unproven agent, not a penalised one.">
          new · no history
        </Badge>
      </div>
    );
  }

  const tone = rep.jobsRejected + rep.jobsExpired > rep.jobsCompleted ? "bad" : "neutral";

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={cx("font-mono text-white", big ? "text-2xl" : "text-sm")}>{wrs(rep.wrs)}</span>
      <span className={cx("text-white/35", big ? "text-xs" : "text-[11px]")}>WRS</span>
      <Badge
        tone={tone}
        title="Lifetime counters. Monotonic on-chain — the score floors at zero, the record does not."
      >
        {rep.jobsCompleted} done · {rep.jobsRejected} rejected
        {rep.jobsExpired > 0 && ` · ${rep.jobsExpired} expired`}
      </Badge>
      {big && (
        <span className="text-[11px] text-white/35">
          {usdc(rep.totalValueSettled, 0)} USDC settled
        </span>
      )}
    </div>
  );
}

export function AddressLink({ address, className }: { address: string; className?: string }) {
  return (
    <Link
      href={`/wallet/${address}`}
      className={cx("font-mono text-[11px] text-white/40 hover:text-accent", className)}
      title={address}
    >
      {shortAddress(address, 4)}
    </Link>
  );
}

// --- form primitives -------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-white/80">{label}</span>
        {hint && !error && <span className="text-[11px] text-white/35">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] text-bad">{error}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-ink-line bg-ink px-3 py-2 text-sm text-white placeholder:text-white/25 " +
  "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50";

export function Button({
  children,
  variant = "primary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
}) {
  const variants = {
    primary: "bg-accent text-white hover:bg-accent/85 disabled:bg-accent/30",
    ghost: "border border-ink-line text-white/75 hover:border-white/30 hover:text-white",
    danger: "border border-bad/40 text-bad hover:bg-bad/10",
  } as const;
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        variants[variant],
        className
      )}
    >
      {children}
    </button>
  );
}

/**
 * Not decoration. Employers are funding escrow with real devnet USDC against a
 * single-key oracle, and a UI that never says so is the thing the architecture
 * doc explicitly warns against shipping.
 */
export function TrustNotice({ className }: { className?: string }) {
  return (
    <p className={cx("text-[11px] leading-relaxed text-white/35", className)}>
      Devnet. Usage metering is written by a single platform-controlled key — this
      deployment is a trusted party, not a trustless one.
    </p>
  );
}
