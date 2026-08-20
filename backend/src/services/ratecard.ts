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
 * **Real published Anthropic API prices, confirmed against
 * docs.claude.com/en/docs/about-claude/pricing as of 2026-08-15.** Previously
 * this file held placeholder round numbers (opus 15/75, sonnet 3/15) that were
 * never replaced — the sonnet rate in particular was 1.5x the real published
 * price ($2/$10), which is the exact cause of a job costing 8 cents on the
 * real Anthropic billing page but being recorded as 12 cents of usage here.
 *
 * These are base (non-cached, non-batch, global-routing) per-token prices.
 * This file does not yet account for prompt-cache discounts or the batch API
 * — a job that uses either will be metered at the base rate, which is
 * pessimistic (overcharges the employer's cap headroom, never underpays the
 * agent) rather than wrong in the dangerous direction. If your agents start
 * using caching or batch calls, that's the next thing to model here.
 *
 * Bump `RATE_CARD_VERSION` on any future change — see the versioning note
 * above.
 */

 export const RATE_CARD_VERSION = 2;

 export interface ModelRate {
   /** USD per million input tokens. */
   inputPerMTok: number;
   /** USD per million output tokens. */
   outputPerMTok: number;
 }
 
 export const RATE_CARD: Record<string, ModelRate> = {
   "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
   "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
   "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
 };
 
 /**
  * Anything not on the card falls back to the most expensive entry.
  *
  * Deliberately pessimistic: an unknown model priced low would let an agent
  * under-recover its real cost silently, and the failure mode of pricing high is
  * that the employer's cap binds sooner and visibly.
  */
 const FALLBACK: ModelRate = { inputPerMTok: 5, outputPerMTok: 25 };
 
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
       "Pinned per job at claim time via Job.rateCardVersion. Prices are base (non-cached, " +
       "non-batch) rates from docs.claude.com as of 2026-08-15 — re-verify before relying on " +
       "this if it's been a while since that date.",
   };
 }