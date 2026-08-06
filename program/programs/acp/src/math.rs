//! Pure settlement and reputation arithmetic.
//!
//! Every function here is total, integer-only, and free of Solana types so it
//! can be unit-tested without a validator.
//!
//! `shared/economics/settlement.mjs` is an exact line-for-line mirror of this
//! file, and `shared/economics/test.mjs` property-tests it against the same
//! invariants. The backend and the frontend both import that mirror, so a
//! quote shown in the UI comes from this arithmetic. **If you change anything
//! here, change the mirror.**

use crate::state::*;

pub const BPS_DENOM: u64 = 10_000;

/// Fixed point for WRS. One reputation "point" is 1_000_000.
pub const WRS_SCALE: u64 = 1_000_000;
/// `w_recency`: existing score decays 1/32 per settlement, so old outcomes
/// stop dominating without ever going negative.
pub const DECAY_NUM: u64 = 31;
pub const DECAY_DEN: u64 = 32;
/// One rating point at value-weight 1 moves WRS by 0.1.
pub const RATING_STEP: i64 = (WRS_SCALE / 10) as i64;
/// Rating below which an accepted job still costs reputation.
pub const NEUTRAL_RATING: i64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Settlement {
    /// Paid to the agent now.
    pub agent_immediate: u64,
    /// Owed to the agent but held until `holdback_until` (tier 1 only).
    pub agent_holdback: u64,
    /// 1% of margin to the treasury.
    pub protocol_fee: u64,
    /// Everything else back to whoever funded escrow.
    pub employer_refund: u64,
}

impl Settlement {
    pub fn total(&self) -> u64 {
        self.agent_immediate
            .saturating_add(self.agent_holdback)
            .saturating_add(self.protocol_fee)
            .saturating_add(self.employer_refund)
    }
}

/// The settlement matrix, ARCHITECTURE.md §5.1.
///
/// `escrow_total` is what the employer funded. `planning_fee`/`fixed_fee` are
/// the agent's proposal, already validated <= their caps. Token figures are
/// oracle-reported and already clamped to their caps at write time; they are
/// clamped again here because a compromised oracle must not be able to pay out
/// more than the employer funded.
pub fn settle(
    outcome: Outcome,
    tier: u8,
    escrow_total: u64,
    planning_fee: u64,
    fixed_fee: u64,
    planning_token_cap: u64,
    token_budget_cap: u64,
    planning_tokens_used: u64,
    execution_tokens_used: u64,
    protocol_fee_bps: u16,
) -> Settlement {
    let planning_tokens = planning_tokens_used.min(planning_token_cap);
    let execution_tokens = execution_tokens_used.min(token_budget_cap);

    // Which fees are earned, and which tokens are reimbursed.
    //
    // Rejection leaves the agent whole on real cost, not on profit: every
    // token burned is recovered and the planning fee is kept; only the
    // completion fee is forfeited. The employer still pays real token cost, so
    // rejecting is cheaper than accepting but not free.
    let (fee_earned, tokens_earned) = match outcome {
        Outcome::Accepted => (
            planning_fee.saturating_add(fixed_fee),
            planning_tokens.saturating_add(execution_tokens),
        ),
        Outcome::PlanRejected => (planning_fee, planning_tokens),
        Outcome::DeliverableRejected => (
            planning_fee,
            planning_tokens.saturating_add(execution_tokens),
        ),
        // Deadline missed or abandoned: agent eats token cost and the bond.
        // This is what makes claiming a job non-free.
        Outcome::Expired => (0, 0),
    };

    // 1% of margin, never of gross. Token reimbursement is pass-through cost,
    // not revenue, so it is excluded from the fee base.
    let protocol_fee = mul_bps(fee_earned, protocol_fee_bps);
    let fee_net = fee_earned.saturating_sub(protocol_fee);

    let (agent_immediate, agent_holdback) = if tier_has_holdback(tier) {
        (fee_net, tokens_earned)
    } else {
        (fee_net.saturating_add(tokens_earned), 0)
    };

    let paid_out = agent_immediate
        .saturating_add(agent_holdback)
        .saturating_add(protocol_fee);
    let employer_refund = escrow_total.saturating_sub(paid_out);

    Settlement {
        agent_immediate,
        agent_holdback,
        protocol_fee,
        employer_refund,
    }
}

/// `bond = max(MIN_BOND, β × fixed_fee_cap)`, β = 0.25.
///
/// Scaling with the fee ceiling makes locking a high-value job proportionally
/// expensive. Open jobs only — a direct hire posts no bond because the
/// employer chose the agent.
pub fn required_bond(job_type: JobType, fixed_fee_cap: u64) -> u64 {
    match job_type {
        JobType::Direct => 0,
        JobType::Open => {
            let scaled = mul_bps_u64(fixed_fee_cap, BOND_BETA_BPS);
            scaled.max(MIN_BOND)
        }
    }
}

/// `w_value`, log2-damped so one whale job cannot capture the score.
/// Returns 1..=8 for values from 0 to ~128 USDC and beyond.
pub fn value_weight(value_base_units: u64) -> u64 {
    let usdc = value_base_units / ONE_USDC;
    let ilog = 64u64.saturating_sub((usdc.saturating_add(1)).leading_zeros() as u64);
    ilog.clamp(1, 8)
}

/// Rating 0..=10 with 5 neutral. Rejections and expiries carry a fixed
/// penalty rather than a rating, because there is no rating to give.
pub fn outcome_rating_delta(outcome: Outcome, rating: u8) -> i64 {
    match outcome {
        Outcome::Accepted => (rating.min(10) as i64) - NEUTRAL_RATING,
        Outcome::PlanRejected | Outcome::DeliverableRejected => -2,
        Outcome::Expired => -5,
    }
}

/// `Δ_base = w_value × w_recency × normalized_rating`, floored at zero.
///
/// The floor is why the lifetime counters in `WalletProfile` exist: without
/// them a fresh wallet and one with eleven rejections both display 0.
pub fn apply_wrs(current: u64, outcome: Outcome, rating: u8, job_value: u64) -> u64 {
    let decayed = (current as u128 * DECAY_NUM as u128 / DECAY_DEN as u128) as u64;
    let delta = outcome_rating_delta(outcome, rating)
        .saturating_mul(value_weight(job_value) as i64)
        .saturating_mul(RATING_STEP);

    if delta >= 0 {
        decayed.saturating_add(delta as u64)
    } else {
        decayed.saturating_sub(delta.unsigned_abs())
    }
}

/// Clawing back a holdback on confirmed reconciliation failure is a
/// reputational event as well as a financial one.
pub fn apply_clawback_penalty(current: u64, job_value: u64) -> u64 {
    let decayed = (current as u128 * DECAY_NUM as u128 / DECAY_DEN as u128) as u64;
    let penalty = (value_weight(job_value) as i64)
        .saturating_mul(RATING_STEP)
        .saturating_mul(8) as u64;
    decayed.saturating_sub(penalty)
}

/// Rejection rate in basis points, for display on the employer profile.
pub fn rejection_rate_bps(jobs_rejected: u64, jobs_posted: u64) -> u64 {
    if jobs_posted == 0 {
        return 0;
    }
    (jobs_rejected as u128 * BPS_DENOM as u128 / jobs_posted as u128) as u64
}

#[inline]
fn mul_bps(amount: u64, bps: u16) -> u64 {
    (amount as u128 * bps as u128 / BPS_DENOM as u128) as u64
}

#[inline]
fn mul_bps_u64(amount: u64, bps: u64) -> u64 {
    (amount as u128 * bps as u128 / BPS_DENOM as u128) as u64
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const FEE_BPS: u16 = DEFAULT_PROTOCOL_FEE_BPS;

    fn escrow(pfc: u64, ffc: u64, ptc: u64, tbc: u64) -> u64 {
        pfc + ffc + ptc + tbc
    }

    #[test]
    fn accepted_pays_tokens_plus_fees_minus_one_percent_of_margin() {
        let total = escrow(2_000_000, 20_000_000, 3_000_000, 50_000_000);
        let s = settle(
            Outcome::Accepted,
            TIER_METERED,
            total,
            2_000_000,
            20_000_000,
            3_000_000,
            50_000_000,
            1_500_000,
            30_000_000,
            FEE_BPS,
        );
        // fee base = 22 USDC, 1% = 0.22 USDC
        assert_eq!(s.protocol_fee, 220_000);
        assert_eq!(s.agent_immediate, 22_000_000 - 220_000 + 31_500_000);
        assert_eq!(s.agent_holdback, 0);
        // unused budget returns
        assert_eq!(s.employer_refund, 1_500_000 + 20_000_000);
        assert_eq!(s.total(), total);
    }

    #[test]
    fn protocol_fee_is_never_charged_on_token_reimbursement() {
        let total = escrow(0, 10_000_000, 0, 900_000_000);
        let s = settle(
            Outcome::Accepted,
            TIER_METERED,
            total,
            0,
            10_000_000,
            0,
            900_000_000,
            0,
            900_000_000,
            FEE_BPS,
        );
        assert_eq!(s.protocol_fee, 100_000); // 1% of 10 USDC, not of 910
    }

    #[test]
    fn plan_rejection_leaves_agent_whole_on_planning_cost() {
        let total = escrow(2_000_000, 20_000_000, 3_000_000, 50_000_000);
        let s = settle(
            Outcome::PlanRejected,
            TIER_METERED,
            total,
            2_000_000,
            20_000_000,
            3_000_000,
            50_000_000,
            2_500_000,
            0,
            FEE_BPS,
        );
        assert_eq!(s.protocol_fee, 20_000);
        assert_eq!(s.agent_immediate, 2_000_000 - 20_000 + 2_500_000);
        assert_eq!(s.total(), total);
    }

    #[test]
    fn deliverable_rejection_returns_every_token_burned() {
        let total = escrow(2_000_000, 20_000_000, 3_000_000, 50_000_000);
        let s = settle(
            Outcome::DeliverableRejected,
            TIER_METERED,
            total,
            2_000_000,
            20_000_000,
            3_000_000,
            50_000_000,
            3_000_000,
            48_000_000,
            FEE_BPS,
        );
        // planning fee kept, completion fee forfeited, all tokens recovered
        assert_eq!(s.agent_immediate, 2_000_000 - 20_000 + 51_000_000);
        // employer gets the completion fee back plus unused budget
        assert_eq!(s.employer_refund, 20_000_000 + 2_000_000);
        assert_eq!(s.total(), total);
    }

    #[test]
    fn expiry_pays_the_agent_nothing() {
        let total = escrow(2_000_000, 20_000_000, 3_000_000, 50_000_000);
        let s = settle(
            Outcome::Expired,
            TIER_METERED,
            total,
            2_000_000,
            20_000_000,
            3_000_000,
            50_000_000,
            3_000_000,
            50_000_000,
            FEE_BPS,
        );
        assert_eq!(s.agent_immediate, 0);
        assert_eq!(s.agent_holdback, 0);
        assert_eq!(s.protocol_fee, 0);
        assert_eq!(s.employer_refund, total);
    }

    #[test]
    fn tier1_holds_back_tokens_but_never_fees() {
        let total = escrow(1_000_000, 10_000_000, 2_000_000, 40_000_000);
        let s = settle(
            Outcome::Accepted,
            TIER_RECONCILED,
            total,
            1_000_000,
            10_000_000,
            2_000_000,
            40_000_000,
            2_000_000,
            18_000_000,
            FEE_BPS,
        );
        assert_eq!(s.agent_immediate, 11_000_000 - 110_000);
        assert_eq!(s.agent_holdback, 20_000_000);
        assert_eq!(s.total(), total);
    }

    #[test]
    fn oracle_cannot_pay_out_more_than_the_employer_funded() {
        let total = escrow(0, 10_000_000, 1_000_000, 10_000_000);
        let s = settle(
            Outcome::Accepted,
            TIER_METERED,
            total,
            0,
            10_000_000,
            1_000_000,
            10_000_000,
            u64::MAX, // lying oracle
            u64::MAX,
            FEE_BPS,
        );
        assert_eq!(s.total(), total);
        assert!(s.agent_immediate <= total);
    }

    #[test]
    fn bond_scales_with_the_fee_ceiling_and_has_a_floor() {
        assert_eq!(required_bond(JobType::Direct, 1_000_000_000), 0);
        assert_eq!(required_bond(JobType::Open, 0), MIN_BOND);
        assert_eq!(required_bond(JobType::Open, 4_000_000), MIN_BOND); // 1 < 5
        assert_eq!(required_bond(JobType::Open, 100_000_000), 25_000_000);
    }

    #[test]
    fn wrs_floors_at_zero() {
        let mut wrs = 0u64;
        for _ in 0..11 {
            wrs = apply_wrs(wrs, Outcome::DeliverableRejected, 0, 50_000_000);
        }
        assert_eq!(wrs, 0);
    }

    #[test]
    fn value_weight_is_log_damped() {
        assert_eq!(value_weight(0), 1);
        assert_eq!(value_weight(ONE_USDC), 2);
        assert_eq!(value_weight(100 * ONE_USDC), 7);
        assert_eq!(value_weight(1_000_000 * ONE_USDC), 8); // clamped
    }

    #[test]
    fn neutral_rating_moves_the_score_only_by_decay() {
        let wrs = 10 * WRS_SCALE;
        let after = apply_wrs(wrs, Outcome::Accepted, 5, 50 * ONE_USDC);
        assert_eq!(after, wrs * DECAY_NUM / DECAY_DEN);
    }

    #[test]
    fn conservation_holds_across_the_whole_matrix() {
        let outcomes = [
            Outcome::Accepted,
            Outcome::PlanRejected,
            Outcome::DeliverableRejected,
            Outcome::Expired,
        ];
        for tier in [TIER_RECONCILED, TIER_METERED] {
            for o in outcomes {
                for pt in [0u64, 500_000, 3_000_000] {
                    for et in [0u64, 25_000_000, 50_000_000] {
                        let total = escrow(2_000_000, 20_000_000, 3_000_000, 50_000_000);
                        let s = settle(
                            o, tier, total, 2_000_000, 20_000_000, 3_000_000, 50_000_000,
                            pt, et, FEE_BPS,
                        );
                        assert_eq!(s.total(), total, "conservation broke for {:?}", o);
                    }
                }
            }
        }
    }
}
