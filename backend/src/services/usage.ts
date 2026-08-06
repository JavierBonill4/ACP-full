import { formatUsdc } from "@acp/economics";

import { prisma } from "../db.js";
import { event } from "./jobs.js";
import { RATE_CARD_VERSION, usageToBaseUnits, type TokenUsage } from "./ratecard.js";

/**
 * The single write path for token usage, whether it arrived self-reported from
 * a T1 agent or observed by the gateway for a T2 one.
 *
 * Both go through here so the clamping, the accumulation, and the audit trail
 * cannot differ between tiers — the tier changes *who is trusted to count*, not
 * what happens to the number afterwards.
 */

export class UsageError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

export const PHASE_PLANNING = 0;
export const PHASE_EXECUTION = 1;

export interface RecordUsageInput {
  jobId: string;
  phase: 0 | 1;
  /** USDC base units. Either self-declared or computed from observed tokens. */
  amount: bigint;
  source: "self-reported" | "gateway";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Usage is **cumulative per phase**, not incremental.
 *
 * The on-chain `report_usage` assigns rather than adds — `planning_tokens_used
 * = amount` — so the number written here has to be the running total for that
 * phase. A gateway that recorded each call as a delta would settle at the cost
 * of the last call only.
 */
export async function recordUsage(input: RecordUsageInput) {
  const job = await prisma.job.findUnique({ where: { id: input.jobId } });
  if (!job) throw new UsageError("No such job", 404);
  if (["SETTLED", "EXPIRED", "CANCELLED"].includes(job.state)) {
    throw new UsageError("That job has already settled");
  }

  const cap = input.phase === PHASE_PLANNING ? job.planningTokenCap : job.tokenBudgetCap;
  const already =
    input.phase === PHASE_PLANNING ? job.planningTokensUsed : job.executionTokensUsed;

  const proposed = already + input.amount;

  // Clamped here, again in the program's `report_usage`, and a third time in
  // `settle()`. The employer funded a ceiling and nothing may exceed it — not a
  // lying agent, not a compromised oracle, not a bug in this function.
  if (proposed > cap) {
    throw new UsageError(
      `This would put ${input.phase === PHASE_PLANNING ? "planning" : "execution"} usage at ` +
        `${formatUsdc(proposed)} USDC against a ${formatUsdc(cap)} cap. The employer never ` +
        `funded that much, so it cannot be paid.`
    );
  }

  const report = await prisma.usageReport.create({
    data: {
      jobId: job.id,
      phase: input.phase,
      amount: input.amount,
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      rateCardVersion: RATE_CARD_VERSION,
    },
  });

  const updated = await prisma.job.update({
    where: { id: job.id },
    data:
      input.phase === PHASE_PLANNING
        ? { planningTokensUsed: proposed }
        : { executionTokensUsed: proposed },
  });

  await event(
    job.id,
    "USAGE_REPORTED",
    null,
    `${input.phase === PHASE_PLANNING ? "Planning" : "Execution"} +${formatUsdc(input.amount)} ` +
      `→ ${formatUsdc(proposed)} USDC (${input.source}` +
      `${input.model ? `, ${input.model}` : ""})`
  );

  return {
    report,
    phaseTotal: proposed,
    cap,
    remaining: cap - proposed,
    job: updated,
  };
}

/** Convenience for the gateway: observed tokens straight to a recorded amount. */
export async function recordObservedTokens(
  jobId: string,
  phase: 0 | 1,
  usage: TokenUsage
) {
  return recordUsage({
    jobId,
    phase,
    amount: usageToBaseUnits(usage),
    source: "gateway",
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
}

/**
 * Everything recorded for a job, split by who counted it.
 *
 * Worth surfacing in the UI: a T2 job whose usage is all `self-reported` means
 * the agent bypassed the gateway, which is the whole thing T2 claims not to do.
 */
export async function usageBreakdown(jobId: string) {
  const reports = await prisma.usageReport.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
  });

  const totals = reports.reduce(
    (acc, r) => {
      acc.byPhase[r.phase] = (acc.byPhase[r.phase] ?? 0n) + r.amount;
      acc.inputTokens += r.inputTokens ?? 0;
      acc.outputTokens += r.outputTokens ?? 0;
      return acc;
    },
    { byPhase: {} as Record<number, bigint>, inputTokens: 0, outputTokens: 0 }
  );

  return { reports, ...totals };
}
