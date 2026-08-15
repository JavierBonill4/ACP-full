use anchor_lang::prelude::*;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// USDC base units. Every amount in this program is 6dp.
pub const USDC_DECIMALS: u8 = 6;
pub const ONE_USDC: u64 = 1_000_000;

/// 1% of margin. Never of gross — token reimbursement is pass-through cost.
pub const DEFAULT_PROTOCOL_FEE_BPS: u16 = 100;
pub const MAX_PROTOCOL_FEE_BPS: u16 = 500;

/// bond = max(MIN_BOND, BOND_BETA_BPS * fixed_fee_cap)
pub const BOND_BETA_BPS: u64 = 2_500;
pub const MIN_BOND: u64 = 5 * ONE_USDC;

/// Timers, seconds.
pub const ACCEPT_TTL: i64 = 6 * 60 * 60;
pub const CLAIM_TTL: i64 = 24 * 60 * 60;
pub const REVIEW_TTL: i64 = 72 * 60 * 60;
pub const RECONCILIATION_WINDOW: i64 = 7 * 24 * 60 * 60;
pub const MAX_DEADLINE_HORIZON: i64 = 90 * 24 * 60 * 60;

/// Verification tiers. v4 has no attested tier — there is no code identity
/// left for attestation to make factual.
pub const TIER_RECONCILED: u8 = 1;
pub const TIER_METERED: u8 = 2;
pub const MAX_TIER: u8 = 2;

/// Per-tier job value caps, in USDC base units. Bounds per-incident loss from
/// a lying T1 agent (see ARCHITECTURE.md §8.1).
pub const TIER1_VALUE_CAP: u64 = 100 * ONE_USDC;
pub const TIER2_VALUE_CAP: u64 = 2_500 * ONE_USDC;

/// Concurrent open claims per wallet, by tier and reputation.
pub const BASE_CLAIM_LIMIT: u16 = 1;
pub const MAX_CLAIM_LIMIT: u16 = 5;

/// Employer-chosen bonus on `accept_deliverable`, paid on top of the fees the
/// agent already unconditionally earned and taken out of the employer's own
/// refund of unused escrow — not a top-up. Deliberately small and flat
/// rather than scaled to job value: this is a "thank you," not a second fee
/// schedule. `DEFAULT_TIP` is UI guidance only; only `MAX_TIP` is enforced
/// on-chain (see `accept_deliverable`).
pub const MAX_TIP: u64 = 100_000; // 0.10 USDC
pub const DEFAULT_TIP: u64 = 50_000; // 0.05 USDC

pub const MAX_ORACLE_SIGNERS: usize = 5;

pub fn tier_value_cap(tier: u8) -> u64 {
    match tier {
        TIER_METERED => TIER2_VALUE_CAP,
        _ => TIER1_VALUE_CAP,
    }
}

/// T1 token reimbursement is held back; T2 settles immediately.
pub fn tier_has_holdback(tier: u8) -> bool {
    tier == TIER_RECONCILED
}

// ---------------------------------------------------------------------------
// Enums (stored as u8 so adding variants never shifts account layout)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum JobType {
    /// Employer wrote a custom job and left it open. Any qualified
    /// general-purpose agent may claim it. Bond required.
    Open = 0,
    /// Employer picked a specific single-purpose agent. That agent must accept
    /// within `accept_ttl`. No bond — the employer chose them.
    Direct = 1,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum JobState {
    Open = 0,
    Offered = 1,
    Claimed = 2,
    PlanPending = 3,
    InProgress = 4,
    ReviewPending = 5,
    Settled = 6,
    Expired = 7,
    Cancelled = 8,
}

impl JobState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobState::Settled | JobState::Expired | JobState::Cancelled)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Phase {
    Planning = 0,
    Execution = 1,
}

/// Which row of the settlement matrix applies. See ARCHITECTURE.md §5.1.
///
/// `DeliverableRejected` was removed: once a deliverable is submitted, the
/// agent's fee + token payout is unconditional (see `accept_deliverable`'s
/// doc comment in lib.rs). Renumbered rather than leaving a gap — `Outcome`
/// is never persisted in an account, only passed as a transient argument and
/// emitted on `JobSettled`, so there is no stored-layout reason to preserve
/// old discriminants.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Outcome {
    Accepted = 0,
    PlanRejected = 1,
    Expired = 2,
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// Seeds: ["oracle"]
///
/// The single platform-controlled writer of usage data. `signers` and
/// `threshold` are carried now so the v2 multisig hardening (ARCHITECTURE.md
/// §11) is additive rather than a migration — in MVP `threshold` is 1.
#[account]
pub struct OracleConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub usdc_mint: Pubkey,
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub protocol_fee_bps: u16,
    pub rate_card_version: u32,
    pub max_enabled_tier: u8,
    pub paused: bool,
    pub bump: u8,
}

impl OracleConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + (4 + 32 * MAX_ORACLE_SIGNERS) + 1 + 2 + 4 + 1 + 1 + 1;

    pub fn is_signer(&self, key: &Pubkey) -> bool {
        self.signers.iter().any(|s| s == key)
    }
}

/// Seeds: ["wallet", wallet]
///
/// The entire reputation system. v3 carried a second score keyed on
/// `code_hash`; v4 removed it along with code identity, so this is the only
/// score and the wallet is its only subject.
#[account]
pub struct WalletProfile {
    pub wallet: Pubkey,
    /// Wallet Reputation Score, fixed point 1e6, floored at zero.
    pub wrs: u64,
    // Immutable lifetime counters. Monotonic — no instruction decrements them.
    // The score floors; the record does not.
    pub jobs_completed: u64,
    pub jobs_rejected: u64,
    pub jobs_expired: u64,
    pub total_value_settled: u64,
    pub first_seen: i64,
    pub tier: u8,
    pub active_claims: u16,
    pub bump: u8,
}

impl WalletProfile {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 2 + 1;

    pub fn lifetime_jobs(&self) -> u64 {
        self.jobs_completed
            .saturating_add(self.jobs_rejected)
            .saturating_add(self.jobs_expired)
    }

    /// Concurrent claim limit scales with reputation and tier. Fresh wallets
    /// are free, so the *bond* is what makes multi-wallet squatting expensive
    /// — this only raises operational cost.
    pub fn claim_limit(&self) -> u16 {
        let mut limit = BASE_CLAIM_LIMIT;
        if self.tier >= TIER_METERED {
            limit += 1;
        }
        // +1 per 10 reputation points, capped.
        limit += ((self.wrs / (10 * ONE_USDC)) as u16).min(3);
        limit.min(MAX_CLAIM_LIMIT)
    }
}

/// Seeds: ["employer", employer]
///
/// `jobs_rejected / jobs_posted` is published so agents can price rejection
/// risk before bidding. Disclosed statistic, no automated penalty.
#[account]
pub struct EmployerProfile {
    pub employer: Pubkey,
    pub jobs_posted: u64,
    pub jobs_rejected: u64,
    /// An employer who reviews nothing auto-accepts everything, including bad
    /// work. Tracked so that is at least visible.
    pub jobs_auto_accepted: u64,
    pub total_value_escrowed: u64,
    pub first_seen: i64,
    /// Monotonic, seeds the next Job PDA.
    pub next_nonce: u64,
    pub bump: u8,
}

impl EmployerProfile {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 1;
}

/// Seeds: ["job", employer, nonce_le]
#[account]
pub struct Job {
    pub employer: Pubkey,
    /// Pubkey::default() until claimed/offered.
    pub agent: Pubkey,
    pub nonce: u64,

    pub job_type: u8,
    pub state: u8,
    pub min_tier: u8,
    /// Tier recorded at claim time, so history stays interpretable if the
    /// agent changes tier later.
    pub claimed_tier: u8,

    // Employer-funded ceilings. Escrow is funded at the top of the range:
    // planning_fee_cap + fixed_fee_cap + planning_token_cap + token_budget_cap
    pub planning_fee_cap: u64,
    pub fixed_fee_cap: u64,
    pub planning_token_cap: u64,
    pub token_budget_cap: u64,

    // Agent's proposal, set at submit_plan, must be <= the caps above.
    pub planning_fee: u64,
    pub fixed_fee: u64,

    pub bond: u64,
    /// Oracle-reported, hard-clamped to the caps at write time.
    pub planning_tokens_used: u64,
    pub execution_tokens_used: u64,

    // Only 32-byte digests go on-chain. Full text lives in the backend.
    pub spec_hash: [u8; 32],
    pub plan_hash: [u8; 32],
    pub deliverable_hash: [u8; 32],
    /// Merkle root of signed usage receipts. Written but unverified in MVP —
    /// carried so the v2 challenge path is additive.
    pub usage_root: [u8; 32],

    pub created_at: i64,
    /// DIRECT only: agent must accept before this.
    pub offer_expires_at: i64,
    /// Claim -> plan submission.
    pub claim_expires_at: i64,
    /// Employer review window, both phases. Auto-accept on expiry.
    pub review_expires_at: i64,
    pub deadline: i64,
    pub holdback_until: i64,

    pub rate_card_version: u32,
    pub rating: u8,
    pub auto_accepted: bool,
    pub holdback_amount: u64,

    pub bump: u8,
    pub vault_bump: u8,
    pub bond_bump: u8,
}

impl Job {
    pub const SPACE: usize = 8
        + 32 + 32 + 8            // employer, agent, nonce
        + 1 + 1 + 1 + 1          // job_type, state, min_tier, claimed_tier
        + 8 * 4                  // caps
        + 8 * 2                  // fees
        + 8                      // bond
        + 8 * 2                  // tokens used
        + 32 * 4                 // hashes
        + 8 * 6                  // timestamps
        + 4 + 1 + 1 + 8          // rate_card_version, rating, auto_accepted, holdback_amount
        + 1 + 1 + 1;             // bumps

    /// The full amount the employer transfers into the vault at post time.
    pub fn escrow_total(&self) -> u64 {
        self.planning_fee_cap
            .saturating_add(self.fixed_fee_cap)
            .saturating_add(self.planning_token_cap)
            .saturating_add(self.token_budget_cap)
    }

    /// What the tier value cap is measured against.
    pub fn job_value(&self) -> u64 {
        self.escrow_total()
    }

    pub fn state(&self) -> JobState {
        match self.state {
            0 => JobState::Open,
            1 => JobState::Offered,
            2 => JobState::Claimed,
            3 => JobState::PlanPending,
            4 => JobState::InProgress,
            5 => JobState::ReviewPending,
            6 => JobState::Settled,
            7 => JobState::Expired,
            _ => JobState::Cancelled,
        }
    }

    pub fn is_open_type(&self) -> bool {
        self.job_type == JobType::Open as u8
    }
}
