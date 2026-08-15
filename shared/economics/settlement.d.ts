// Types for settlement.mjs. The .mjs stays plain JavaScript on purpose: it is
// a line-for-line mirror of programs/acp/src/math.rs and a reader comparing
// the two should not have to filter out type annotations. The types live here
// so the backend and the frontend still get checked.

export declare const BPS_DENOM: bigint;
export declare const ONE_USDC: bigint;
export declare const DEFAULT_PROTOCOL_FEE_BPS: bigint;
export declare const MAX_PROTOCOL_FEE_BPS: bigint;
export declare const BOND_BETA_BPS: bigint;
export declare const MIN_BOND: bigint;

export declare const ACCEPT_TTL: number;
export declare const CLAIM_TTL: number;
export declare const REVIEW_TTL: number;
export declare const RECONCILIATION_WINDOW: number;

export declare const TIER_RECONCILED: 1;
export declare const TIER_METERED: 2;
export declare const MAX_TIER: 2;
export declare const TIER1_VALUE_CAP: bigint;
export declare const TIER2_VALUE_CAP: bigint;

export declare const MAX_TIP: bigint;
export declare const DEFAULT_TIP: bigint;

export declare const WRS_SCALE: bigint;
export declare const DECAY_NUM: bigint;
export declare const DECAY_DEN: bigint;
export declare const RATING_STEP: bigint;
export declare const NEUTRAL_RATING: bigint;

export type OutcomeCode = 0 | 1 | 2;
export declare const OUTCOME: {
  readonly ACCEPTED: 0;
  readonly PLAN_REJECTED: 1;
  readonly EXPIRED: 2;
};

export type JobTypeCode = 0 | 1;
export declare const JOB_TYPE: { readonly OPEN: 0; readonly DIRECT: 1 };

export declare const JOB_STATE: {
  readonly OPEN: 0;
  readonly OFFERED: 1;
  readonly CLAIMED: 2;
  readonly PLAN_PENDING: 3;
  readonly IN_PROGRESS: 4;
  readonly REVIEW_PENDING: 5;
  readonly SETTLED: 6;
  readonly EXPIRED: 7;
  readonly CANCELLED: 8;
};

export interface Settlement {
  agentImmediate: bigint;
  agentHoldback: bigint;
  protocolFee: bigint;
  employerRefund: bigint;
  /** The tip actually paid, after outcome-gating and headroom clamping. */
  tipPaid: bigint;
}

export interface SettleInput {
  outcome: OutcomeCode;
  tier: number;
  escrowTotal: bigint;
  planningFee: bigint;
  fixedFee: bigint;
  planningTokenCap: bigint;
  tokenBudgetCap: bigint;
  planningTokensUsed: bigint;
  executionTokensUsed: bigint;
  protocolFeeBps?: bigint;
  /** 0..MAX_TIP base units. Ignored (forced to 0) unless outcome is ACCEPTED. */
  tip?: bigint;
}

export interface EscrowCaps {
  planningFeeCap: bigint;
  fixedFeeCap: bigint;
  planningTokenCap: bigint;
  tokenBudgetCap: bigint;
}

export declare function tierValueCap(tier: number): bigint;
export declare function tierHasHoldback(tier: number): boolean;
export declare function escrowTotal(caps: EscrowCaps): bigint;
export declare function settle(input: SettleInput): Settlement;
export declare function settlementTotal(s: Settlement): bigint;
export declare function requiredBond(jobType: JobTypeCode, fixedFeeCap: bigint): bigint;
export declare function valueWeight(valueBaseUnits: bigint): bigint;
export declare function outcomeRatingDelta(outcome: OutcomeCode, rating: number): bigint;
export declare function applyWrs(
  current: bigint,
  outcome: OutcomeCode,
  rating: number,
  jobValue: bigint
): bigint;
export declare function applyClawbackPenalty(current: bigint, jobValue: bigint): bigint;
export declare function rejectionRateBps(jobsRejected: bigint, jobsPosted: bigint): bigint;
export declare function formatUsdc(baseUnits: bigint): string;
export declare function formatWrs(wrs: bigint): string;
