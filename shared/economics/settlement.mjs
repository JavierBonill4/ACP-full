// Exact JS mirror of programs/acp/src/math.rs.
//
// Every function here must produce the same value as its Rust counterpart for
// every input. BigInt throughout, because u64 amounts exceed Number's safe
// integer range once you get past ~9 trillion base units and silent precision
// loss in money code is not acceptable even when the current caps make it
// unreachable.
//
// The backend imports this module directly (see backend/src/services/
// settlement.ts) so quoted amounts in the UI come from the same arithmetic
// that settles on-chain.

export const BPS_DENOM = 10_000n;
export const ONE_USDC = 1_000_000n;

export const DEFAULT_PROTOCOL_FEE_BPS = 100n;
export const MAX_PROTOCOL_FEE_BPS = 500n;

export const BOND_BETA_BPS = 2_500n;
export const MIN_BOND = 5n * ONE_USDC;

export const ACCEPT_TTL = 6 * 60 * 60;
export const CLAIM_TTL = 24 * 60 * 60;
export const REVIEW_TTL = 72 * 60 * 60;
export const RECONCILIATION_WINDOW = 7 * 24 * 60 * 60;

export const TIER_RECONCILED = 1;
export const TIER_METERED = 2;
export const MAX_TIER = 2;

export const TIER1_VALUE_CAP = 100n * ONE_USDC;
export const TIER2_VALUE_CAP = 2_500n * ONE_USDC;

export const WRS_SCALE = 1_000_000n;
export const DECAY_NUM = 31n;
export const DECAY_DEN = 32n;
export const RATING_STEP = WRS_SCALE / 10n;
export const NEUTRAL_RATING = 5n;

export const OUTCOME = {
  ACCEPTED: 0,
  PLAN_REJECTED: 1,
  DELIVERABLE_REJECTED: 2,
  EXPIRED: 3,
};

export const JOB_TYPE = { OPEN: 0, DIRECT: 1 };

export const JOB_STATE = {
  OPEN: 0,
  OFFERED: 1,
  CLAIMED: 2,
  PLAN_PENDING: 3,
  IN_PROGRESS: 4,
  REVIEW_PENDING: 5,
  SETTLED: 6,
  EXPIRED: 7,
  CANCELLED: 8,
};

export function tierValueCap(tier) {
  return tier === TIER_METERED ? TIER2_VALUE_CAP : TIER1_VALUE_CAP;
}

export function tierHasHoldback(tier) {
  return tier === TIER_RECONCILED;
}

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const clampLow = (v) => (v < 0n ? 0n : v);
const mulBps = (amount, bps) => (amount * bps) / BPS_DENOM;

export function escrowTotal({
  planningFeeCap,
  fixedFeeCap,
  planningTokenCap,
  tokenBudgetCap,
}) {
  return planningFeeCap + fixedFeeCap + planningTokenCap + tokenBudgetCap;
}

/**
 * The settlement matrix, ARCHITECTURE.md §5.1.
 *
 * Token figures are clamped here as well as at oracle write time, because a
 * compromised oracle must not be able to pay out more than the employer
 * funded. Belt and braces on the only path where value leaves the vault.
 */
export function settle({
  outcome,
  tier,
  escrowTotal: total,
  planningFee,
  fixedFee,
  planningTokenCap,
  tokenBudgetCap,
  planningTokensUsed,
  executionTokensUsed,
  protocolFeeBps = DEFAULT_PROTOCOL_FEE_BPS,
}) {
  const planningTokens = min(planningTokensUsed, planningTokenCap);
  const executionTokens = min(executionTokensUsed, tokenBudgetCap);

  let feeEarned;
  let tokensEarned;
  switch (outcome) {
    case OUTCOME.ACCEPTED:
      feeEarned = planningFee + fixedFee;
      tokensEarned = planningTokens + executionTokens;
      break;
    case OUTCOME.PLAN_REJECTED:
      // Agent recovers planning tokens and keeps the planning fee. The
      // employer still pays real token cost, so rejecting is not free.
      feeEarned = planningFee;
      tokensEarned = planningTokens;
      break;
    case OUTCOME.DELIVERABLE_REJECTED:
      // Every token burned is recovered; only the completion fee is forfeited.
      feeEarned = planningFee;
      tokensEarned = planningTokens + executionTokens;
      break;
    case OUTCOME.EXPIRED:
      // Agent eats token cost and the bond. This is what makes claiming a job
      // non-free.
      feeEarned = 0n;
      tokensEarned = 0n;
      break;
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }

  // 1% of margin, never of gross — token reimbursement is pass-through cost.
  const protocolFee = mulBps(feeEarned, protocolFeeBps);
  const feeNet = feeEarned - protocolFee;

  const agentImmediate = tierHasHoldback(tier) ? feeNet : feeNet + tokensEarned;
  const agentHoldback = tierHasHoldback(tier) ? tokensEarned : 0n;

  const paidOut = agentImmediate + agentHoldback + protocolFee;
  const employerRefund = clampLow(total - paidOut);

  return { agentImmediate, agentHoldback, protocolFee, employerRefund };
}

export function settlementTotal(s) {
  return s.agentImmediate + s.agentHoldback + s.protocolFee + s.employerRefund;
}

/** bond = max(MIN_BOND, 0.25 x fixed_fee_cap). Open jobs only. */
export function requiredBond(jobType, fixedFeeCap) {
  if (jobType === JOB_TYPE.DIRECT) return 0n;
  return max(mulBps(fixedFeeCap, BOND_BETA_BPS), MIN_BOND);
}

/** log2-damped, 1..=8, so a single whale job cannot capture the score. */
export function valueWeight(valueBaseUnits) {
  const usdc = valueBaseUnits / ONE_USDC;
  const ilog = BigInt((usdc + 1n).toString(2).length);
  return ilog < 1n ? 1n : ilog > 8n ? 8n : ilog;
}

export function outcomeRatingDelta(outcome, rating) {
  switch (outcome) {
    case OUTCOME.ACCEPTED:
      return BigInt(Math.min(rating, 10)) - NEUTRAL_RATING;
    case OUTCOME.PLAN_REJECTED:
    case OUTCOME.DELIVERABLE_REJECTED:
      return -2n;
    case OUTCOME.EXPIRED:
      return -5n;
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }
}

/**
 * WRS' = max(0, WRS x decay + w_value x normalized_rating)
 *
 * The zero floor is why WalletProfile carries immutable lifetime counters:
 * without them a fresh wallet and one with eleven rejections both display 0.
 */
export function applyWrs(current, outcome, rating, jobValue) {
  const decayed = (current * DECAY_NUM) / DECAY_DEN;
  const delta = outcomeRatingDelta(outcome, rating) * valueWeight(jobValue) * RATING_STEP;
  return clampLow(decayed + delta);
}

export function applyClawbackPenalty(current, jobValue) {
  const decayed = (current * DECAY_NUM) / DECAY_DEN;
  return clampLow(decayed - valueWeight(jobValue) * RATING_STEP * 8n);
}

export function rejectionRateBps(jobsRejected, jobsPosted) {
  if (jobsPosted === 0n) return 0n;
  return (jobsRejected * BPS_DENOM) / jobsPosted;
}

/** Display helper: 12_345_678n -> "12.345678" */
export function formatUsdc(baseUnits) {
  const neg = baseUnits < 0n;
  const v = neg ? -baseUnits : baseUnits;
  const whole = v / ONE_USDC;
  const frac = (v % ONE_USDC).toString().padStart(6, "0").replace(/0+$/, "") || "0";
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Display helper: WRS fixed point -> "3.4" */
export function formatWrs(wrs) {
  return (Number(wrs) / Number(WRS_SCALE)).toFixed(1);
}
