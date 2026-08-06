/**
 * Token → USDC conversion.
 *
 * This is a platform-set number that directly determines payouts, which makes
 * it one of the more dangerous things in the system: change it mid-flight and
 * work is silently repriced with no defence available to the agent. The
 * mitigations are that it is versioned, published (`GET /oracle/rate-card`),
 * and **pinned per job at claim time** — `Job.rateCardVersion` records which
 * version a job settles under, so a later revision cannot reach backwards.
 *
 * Publishing and pinning is necessary, not sufficient. Real governance over
 * who may bump a version, and on what notice, is an open item
 * (ARCHITECTURE.md §13.2).
 *
 * ---
 *
 * **The prices below are placeholders and are almost certainly wrong.**
 *
 * They are plausible round numbers chosen so the arithmetic is exercisable, not
 * quoted figures. Before this is pointed at anything real, replace them with
 * the current published prices for the models your agents actually call, and
 * bump `RATE_CARD_VERSION`. An agent reimbursed at a stale rate is either being
 * underpaid for real cost or overpaid from the employer's escrow, and neither
 * shows up as an error anywhere.
 */

export const RATE_CARD_VERSION = 1;

export interface ModelRate {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

export const RATE_CARD: Record<string, ModelRate> = {
  "claude-opus-5": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Anything not on the card falls back to the most expensive entry.
 *
 * Deliberately pessimistic: an unknown model priced low would let an agent
 * under-recover its real cost silently, and the failure mode of pricing high is
 * that the employer's cap binds sooner and visibly.
 */
const FALLBACK: ModelRate = { inputPerMTok: 15, outputPerMTok: 75 };

export function rateFor(model: string): ModelRate {
  return RATE_CARD[model] ?? FALLBACK;
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Converts a token count to USDC base units, rounded **up**.
 *
 * Rounding up means the agent is never left a base unit short on genuine cost.
 * The employer is protected by the cap, not by the rounding direction, so this
 * costs nothing and removes a class of off-by-one complaint.
 */
export function usageToBaseUnits(usage: TokenUsage): bigint {
  const rate = rateFor(usage.model);
  const usd =
    (usage.inputTokens / 1_000_000) * rate.inputPerMTok +
    (usage.outputTokens / 1_000_000) * rate.outputPerMTok;
  return BigInt(Math.ceil(usd * 1_000_000));
}

export function sumUsage(reports: TokenUsage[]): bigint {
  return reports.reduce((total, r) => total + usageToBaseUnits(r), 0n);
}

export function publishedRateCard() {
  return {
    version: RATE_CARD_VERSION,
    currency: "USDC",
    decimals: 6,
    models: RATE_CARD,
    fallback: FALLBACK,
    note:
      "Pinned per job at claim time via Job.rateCardVersion. These are placeholder " +
      "prices — verify against current published pricing before using this for anything real.",
  };
}
