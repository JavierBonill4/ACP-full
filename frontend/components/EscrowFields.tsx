"use client";

import { TIER1_VALUE_CAP, TIER2_VALUE_CAP, MIN_BOND } from "@acp/economics";


import { usdc } from "@/lib/format";
import { Field, inputClass, cx } from "./ui";

export interface Caps {
  planningFeeCap: string;
  fixedFeeCap: string;
  planningTokenCap: string;
  tokenBudgetCap: string;
}

export const EMPTY_CAPS: Caps = {
  planningFeeCap: "0",
  fixedFeeCap: "",
  planningTokenCap: "1",
  tokenBudgetCap: "",
};

const toBase = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? BigInt(Math.round(n * 1e6)) : 0n;
};

export function capsToBase(caps: Caps) {
  return {
    planningFeeCap: toBase(caps.planningFeeCap),
    fixedFeeCap: toBase(caps.fixedFeeCap),
    planningTokenCap: toBase(caps.planningTokenCap),
    tokenBudgetCap: toBase(caps.tokenBudgetCap),
  };
}

/**
 * The four numbers the employer funds.
 *
 * They are **ceilings, not prices**. Escrow is funded at the top of the range
 * so the agent knows the money is there before it starts work and the employer
 * knows their maximum exposure before it signs — and everything unspent comes
 * back at settlement. Saying "ceiling" in the labels rather than "fee" is the
 * difference between a user thinking they are being charged this and knowing
 * they are reserving it.
 */
export function EscrowFields({
  caps,
  onChange,
  tier,
  jobType,
  fieldErrors,
}: {
  caps: Caps;
  onChange: (next: Caps) => void;
  tier: 1 | 2;
  jobType: "OPEN" | "DIRECT";
  fieldErrors?: Record<string, string>;
}) {
  const set = (key: keyof Caps) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...caps, [key]: e.target.value });

  const base = capsToBase(caps);
  const total = base.planningFeeCap + base.fixedFeeCap + base.planningTokenCap + base.tokenBudgetCap;
  const valueCap = tier === 2 ? TIER2_VALUE_CAP : TIER1_VALUE_CAP;
  const overCap = total > valueCap;

  // Local mirror of requiredBond(). Shown to the employer because the bond is
  // what makes an open claim non-free, and an employer choosing a fee ceiling
  // should see what commitment it demands from the agent.
  const bond =
    jobType === "DIRECT"
      ? 0n
      : (base.fixedFeeCap * 2500n) / 10_000n > MIN_BOND
        ? (base.fixedFeeCap * 2500n) / 10_000n
        : MIN_BOND;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Completion fee ceiling"
          hint="USDC"
          error={fieldErrors?.fixedFeeCap}
        >
          <input
            className={inputClass}
            inputMode="decimal"
            placeholder="25"
            value={caps.fixedFeeCap}
            onChange={set("fixedFeeCap")}
          />
        </Field>
        <Field label="Token budget ceiling" hint="USDC" error={fieldErrors?.tokenBudgetCap}>
          <input
            className={inputClass}
            inputMode="decimal"
            placeholder="50"
            value={caps.tokenBudgetCap}
            onChange={set("tokenBudgetCap")}
          />
        </Field>
        <Field label="Planning fee ceiling" hint="USDC" error={fieldErrors?.planningFeeCap}>
          <input
            className={inputClass}
            inputMode="decimal"
            placeholder="0"
            value={caps.planningFeeCap}
            onChange={set("planningFeeCap")}
          />
        </Field>
        <Field label="Planning token ceiling" hint="USDC" error={fieldErrors?.planningTokenCap}>
          <input
            className={inputClass}
            inputMode="decimal"
            placeholder="2"
            value={caps.planningTokenCap}
            onChange={set("planningTokenCap")}
          />
        </Field>
      </div>

      <div
        className={cx(
          "rounded-lg border px-3 py-2.5 text-xs",
          overCap ? "border-bad/40 bg-bad/5" : "border-ink-line bg-ink"
        )}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-white/60">Escrow to fund now</span>
          <span className="font-mono text-sm text-white">{usdc(total)} USDC</span>
        </div>
        <p className="mt-1.5 leading-relaxed text-white/35">
          Funded at the top of the range. Unused budget and unused fee ceiling both return
          to you at settlement — this is your maximum exposure, not the expected cost.
        </p>
        {jobType === "OPEN" && (
          <p className="mt-1.5 leading-relaxed text-white/35">
            The claiming agent posts a{" "}
            <span className="font-mono text-white/60">{usdc(bond)} USDC</span> bond, slashed to
            you if it misses the deadline or walks away.
          </p>
        )}
        {overCap && (
          <p className="mt-2 leading-relaxed text-bad">
            Over the tier {tier} job cap of {usdc(valueCap, 0)} USDC.{" "}
            {tier === 1
              ? "Raise the minimum tier to T2, or lower the ceilings."
              : "Lower the ceilings."}{" "}
            The cap bounds what a single mis-metered job can cost you.
          </p>
        )}
      </div>
    </div>
  );
}
