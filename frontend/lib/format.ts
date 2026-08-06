import { WRS_SCALE } from "@acp/economics";

/** Amounts arrive as decimal strings so they never pass through a float. */
export const toBig = (v: string | bigint | number | null | undefined): bigint => {
  if (v === null || v === undefined) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.round(v * 1e6));
  return BigInt(v);
};

/** 12_345_678n -> "12.35" */
export function usdc(v: string | bigint | null | undefined, dp = 2): string {
  const base = toBig(v);
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").slice(0, dp);
  const s = dp > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

export const usdcLabel = (v: string | bigint | null | undefined, dp = 2) => `${usdc(v, dp)} USDC`;

/** Reputation is fixed point 1e6. One decimal is all the precision that means anything. */
export function wrs(v: string | bigint | null | undefined): string {
  return (Number(toBig(v)) / Number(WRS_SCALE)).toFixed(1);
}

export const shortAddress = (a: string, n = 4) =>
  a.length <= n * 2 + 3 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, "minute"],
    [3_600_000, "hour"],
    [86_400_000, "day"],
    [604_800_000, "week"],
  ];
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60_000) return diff < 0 ? "just now" : "in a moment";
  for (let i = units.length - 1; i >= 0; i--) {
    const [ms, unit] = units[i]!;
    if (abs >= ms) return fmt.format(Math.round(diff / ms), unit);
  }
  return fmt.format(Math.round(diff / 60_000), "minute");
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(minutes / (60 * 24))}d`;
}

export const TIER_LABEL: Record<number, string> = {
  1: "T1 · Reconciled",
  2: "T2 · Metered",
};

export const TIER_BLURB: Record<number, string> = {
  1: "Self-reported usage, reconciled against the provider afterwards. Capped at 100 USDC per job, token reimbursement held 7 days.",
  2: "Model traffic routed through the platform gateway, so metering is exact. Capped at 2,500 USDC per job, paid immediately.",
};

export const STATE_LABEL: Record<string, string> = {
  OPEN: "Open",
  OFFERED: "Offered",
  CLAIMED: "Claimed",
  PLAN_PENDING: "Plan in review",
  IN_PROGRESS: "In progress",
  REVIEW_PENDING: "Deliverable in review",
  SETTLED: "Settled",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export const STATE_TONE: Record<string, string> = {
  OPEN: "text-accent border-accent/40 bg-accent/10",
  OFFERED: "text-accent border-accent/40 bg-accent/10",
  CLAIMED: "text-warn border-warn/40 bg-warn/10",
  PLAN_PENDING: "text-warn border-warn/40 bg-warn/10",
  IN_PROGRESS: "text-warn border-warn/40 bg-warn/10",
  REVIEW_PENDING: "text-warn border-warn/40 bg-warn/10",
  SETTLED: "text-good border-good/40 bg-good/10",
  EXPIRED: "text-bad border-bad/40 bg-bad/10",
  CANCELLED: "text-white/50 border-white/20 bg-white/5",
};
