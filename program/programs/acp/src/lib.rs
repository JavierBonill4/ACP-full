//! Agentic Commerce Protocol — on-chain escrow, settlement, and wallet
//! reputation. Architecture v4.
//!
//! What is on-chain: money and the reputation record.
//! What is not: agent code, agent endpoints, descriptors, categories, job
//! specs, plans, deliverables. Only 32-byte digests of the text artifacts are
//! committed, so either party can prove what was agreed without publishing it.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod errors;
pub mod math;
pub mod state;

use errors::AcpError;
use math::*;
use state::*;

declare_id!("FDBD4h5mZsYG8myfEE7NFFtmhuWqt5MJNHvgyfW57eYK");

#[program]
pub mod acp {
    use super::*;

    // -----------------------------------------------------------------
    // Oracle / config
    // -----------------------------------------------------------------

    pub fn initialize_oracle(
        ctx: Context<InitializeOracle>,
        protocol_fee_bps: u16,
        max_enabled_tier: u8,
        threshold: u8,
    ) -> Result<()> {
        require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, AcpError::FeeTooHigh);
        require!(max_enabled_tier <= MAX_TIER, AcpError::TierNotEnabled);

        let cfg = &mut ctx.accounts.oracle_config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.treasury = ctx.accounts.treasury.key();
        cfg.usdc_mint = ctx.accounts.usdc_mint.key();
        cfg.signers = vec![ctx.accounts.admin.key()];
        cfg.threshold = threshold.max(1);
        cfg.protocol_fee_bps = protocol_fee_bps;
        cfg.rate_card_version = 1;
        cfg.max_enabled_tier = max_enabled_tier;
        cfg.paused = false;
        cfg.bump = ctx.bumps.oracle_config;
        Ok(())
    }

    pub fn set_oracle_params(
        ctx: Context<AdminOnly>,
        protocol_fee_bps: u16,
        max_enabled_tier: u8,
        rate_card_version: u32,
        paused: bool,
    ) -> Result<()> {
        require!(protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS, AcpError::FeeTooHigh);
        require!(max_enabled_tier <= MAX_TIER, AcpError::TierNotEnabled);
        let cfg = &mut ctx.accounts.oracle_config;
        cfg.protocol_fee_bps = protocol_fee_bps;
        cfg.max_enabled_tier = max_enabled_tier;
        cfg.rate_card_version = rate_card_version;
        cfg.paused = paused;
        Ok(())
    }

    /// The v2 hardening path starts here: `threshold` > 1 turns the single
    /// platform key into an m-of-n multisig without an account migration.
    pub fn add_oracle_signer(ctx: Context<AdminOnly>, signer: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.oracle_config;
        require!(cfg.signers.len() < MAX_ORACLE_SIGNERS, AcpError::SignerListFull);
        if !cfg.is_signer(&signer) {
            cfg.signers.push(signer);
        }
        Ok(())
    }

    pub fn remove_oracle_signer(ctx: Context<AdminOnly>, signer: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.oracle_config;
        cfg.signers.retain(|s| *s != signer);
        Ok(())
    }

    // -----------------------------------------------------------------
    // Profiles
    //
    // Both registrations are their own instruction with a minimal context.
    // Folding `init_if_needed` into `post_job`/`claim_job` is what blew the
    // 4096-byte SBF stack limit in v3; keeping them separate is structural,
    // not stylistic.
    // -----------------------------------------------------------------

    /// Idempotent. Every agent operator calls this once before their first
    /// claim. `tier` is the verification tier they are declaring (§8).
    pub fn register_wallet(ctx: Context<RegisterWallet>, tier: u8) -> Result<()> {
        require!(tier >= TIER_RECONCILED && tier <= MAX_TIER, AcpError::TierNotEnabled);
        require!(
            tier <= ctx.accounts.oracle_config.max_enabled_tier,
            AcpError::TierNotEnabled
        );

        let now = Clock::get()?.unix_timestamp;
        let profile = &mut ctx.accounts.wallet_profile;

        if profile.first_seen == 0 {
            profile.wallet = ctx.accounts.wallet.key();
            profile.wrs = 0;
            profile.jobs_completed = 0;
            profile.jobs_rejected = 0;
            profile.jobs_expired = 0;
            profile.total_value_settled = 0;
            profile.first_seen = now;
            profile.active_claims = 0;
            profile.bump = ctx.bumps.wallet_profile;
        }
        // Tier changes take effect on the next claim. Nothing is retroactively
        // reweighted, because there is only one score and it accrues fully at
        // every tier.
        profile.tier = tier;
        Ok(())
    }

    /// Idempotent. Must be called once before an employer's first `post_job`.
    pub fn register_employer(ctx: Context<RegisterEmployer>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let profile = &mut ctx.accounts.employer_profile;
        if profile.first_seen == 0 {
            profile.employer = ctx.accounts.employer.key();
            profile.jobs_posted = 0;
            profile.jobs_rejected = 0;
            profile.jobs_auto_accepted = 0;
            profile.total_value_escrowed = 0;
            profile.first_seen = now;
            profile.next_nonce = 0;
            profile.bump = ctx.bumps.employer_profile;
        }
        Ok(())
    }

    // -----------------------------------------------------------------
    // Posting
    // -----------------------------------------------------------------

    /// Creates the job and moves the full escrow in one transaction.
    ///
    /// Escrow is funded at the top of the range — fee ceilings plus token caps
    /// — so the agent knows the money is already there and the employer knows
    /// their maximum exposure. Anything unspent returns at settlement.
    ///
    /// `job_type = Direct` sets `agent` and starts the `accept_ttl` clock.
    /// `job_type = Open` leaves `agent` empty and waits for a claim + bond.
    pub fn post_job(ctx: Context<PostJob>, args: PostJobArgs) -> Result<()> {
        let cfg = &ctx.accounts.oracle_config;
        require!(!cfg.paused, AcpError::Paused);
        require!(args.min_tier <= cfg.max_enabled_tier, AcpError::TierNotEnabled);

        let now = Clock::get()?.unix_timestamp;
        require!(
            args.deadline > now && args.deadline < now + MAX_DEADLINE_HORIZON,
            AcpError::BadDeadline
        );

        let escrow_total = args
            .planning_fee_cap
            .checked_add(args.fixed_fee_cap)
            .and_then(|v| v.checked_add(args.planning_token_cap))
            .and_then(|v| v.checked_add(args.token_budget_cap))
            .ok_or(AcpError::Overflow)?;
        require!(escrow_total > 0, AcpError::ZeroEscrow);

        // Checked here against the minimum tier the employer is willing to
        // accept, and again at claim/accept time against the tier the agent
        // actually holds. Posting a 2,000 USDC job with `min_tier = 1` is
        // rejected now rather than stranding escrow no T1 agent may touch.
        let cap_tier = args.min_tier.max(TIER_RECONCILED);
        require!(escrow_total <= tier_value_cap(cap_tier), AcpError::ValueCapExceeded);

        let employer_profile = &mut ctx.accounts.employer_profile;
        let job = &mut ctx.accounts.job;

        job.employer = ctx.accounts.employer.key();
        job.agent = args.agent.unwrap_or_default();
        job.nonce = args.nonce;
        job.job_type = args.job_type;
        job.min_tier = args.min_tier;
        job.claimed_tier = 0;

        job.planning_fee_cap = args.planning_fee_cap;
        job.fixed_fee_cap = args.fixed_fee_cap;
        job.planning_token_cap = args.planning_token_cap;
        job.token_budget_cap = args.token_budget_cap;
        job.planning_fee = 0;
        job.fixed_fee = 0;
        job.bond = 0;
        job.planning_tokens_used = 0;
        job.execution_tokens_used = 0;

        job.spec_hash = args.spec_hash;
        job.plan_hash = [0u8; 32];
        job.deliverable_hash = [0u8; 32];
        job.usage_root = [0u8; 32];

        job.created_at = now;
        job.deadline = args.deadline;
        job.review_expires_at = 0;
        job.holdback_until = 0;
        job.holdback_amount = 0;
        job.rating = 0;
        job.auto_accepted = false;
        job.rate_card_version = cfg.rate_card_version;

        if args.job_type == JobType::Direct as u8 {
            require!(args.agent.is_some(), AcpError::WrongAgent);
            job.state = JobState::Offered as u8;
            job.offer_expires_at = now + ACCEPT_TTL;
            job.claim_expires_at = 0;
        } else {
            job.state = JobState::Open as u8;
            job.offer_expires_at = 0;
            job.claim_expires_at = 0;
        }

        job.bump = ctx.bumps.job;
        job.vault_bump = ctx.bumps.vault;
        job.bond_bump = 0;

        employer_profile.jobs_posted = employer_profile.jobs_posted.saturating_add(1);
        employer_profile.total_value_escrowed = employer_profile
            .total_value_escrowed
            .saturating_add(escrow_total);
        employer_profile.next_nonce = employer_profile.next_nonce.max(args.nonce + 1);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.employer_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.employer.to_account_info(),
                },
            ),
            escrow_total,
        )?;

        emit!(JobPosted {
            job: job.key(),
            employer: job.employer,
            agent: job.agent,
            job_type: job.job_type,
            escrow_total,
            min_tier: job.min_tier,
            deadline: job.deadline,
        });
        Ok(())
    }

    /// Direct hire: the chosen agent accepts inside `accept_ttl`. No bond —
    /// the employer picked them, so there is no squatting to deter.
    pub fn accept_offer(ctx: Context<AcceptOffer>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let profile = &mut ctx.accounts.wallet_profile;
        let job = &mut ctx.accounts.job;

        require!(job.state == JobState::Offered as u8, AcpError::BadState);
        require!(job.agent == ctx.accounts.agent.key(), AcpError::WrongAgent);
        require!(now <= job.offer_expires_at, AcpError::AlreadyExpired);
        require!(profile.tier >= job.min_tier, AcpError::TierTooLow);
        require!(
            job.escrow_total() <= tier_value_cap(profile.tier),
            AcpError::ValueCapExceeded
        );
        require!(
            profile.active_claims < profile.claim_limit(),
            AcpError::ClaimLimitReached
        );

        job.state = JobState::Claimed as u8;
        job.claimed_tier = profile.tier;
        job.claim_expires_at = now + CLAIM_TTL;
        profile.active_claims = profile.active_claims.saturating_add(1);

        emit!(JobClaimed {
            job: job.key(),
            agent: job.agent,
            tier: job.claimed_tier,
            bond: 0,
        });
        Ok(())
    }

    /// Open job: first claim locks everyone else out and posts a bond.
    pub fn claim_job(ctx: Context<ClaimJob>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let profile = &mut ctx.accounts.wallet_profile;
        let job = &mut ctx.accounts.job;

        require!(job.state == JobState::Open as u8, AcpError::BadState);
        require!(now < job.deadline, AcpError::AlreadyExpired);
        require!(profile.tier >= job.min_tier, AcpError::TierTooLow);
        require!(
            job.escrow_total() <= tier_value_cap(profile.tier),
            AcpError::ValueCapExceeded
        );
        require!(
            profile.active_claims < profile.claim_limit(),
            AcpError::ClaimLimitReached
        );

        let bond = required_bond(JobType::Open, job.fixed_fee_cap);

        job.agent = ctx.accounts.agent.key();
        job.state = JobState::Claimed as u8;
        job.claimed_tier = profile.tier;
        job.claim_expires_at = now + CLAIM_TTL;
        job.bond = bond;
        job.bond_bump = ctx.bumps.bond_vault;
        profile.active_claims = profile.active_claims.saturating_add(1);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.agent_token.to_account_info(),
                    to: ctx.accounts.bond_vault.to_account_info(),
                    authority: ctx.accounts.agent.to_account_info(),
                },
            ),
            bond,
        )?;

        emit!(JobClaimed {
            job: job.key(),
            agent: job.agent,
            tier: job.claimed_tier,
            bond,
        });
        Ok(())
    }

    // -----------------------------------------------------------------
    // Plan phase
    // -----------------------------------------------------------------

    /// The agent's proposal. Fees are flat and must fit inside the ceilings
    /// the employer already funded — no renegotiation, no top-up transaction.
    pub fn submit_plan(
        ctx: Context<AgentAction>,
        plan_hash: [u8; 32],
        planning_fee: u64,
        fixed_fee: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &mut ctx.accounts.job;

        require!(job.state == JobState::Claimed as u8, AcpError::BadState);
        require!(job.agent == ctx.accounts.agent.key(), AcpError::NotAgent);
        require!(now <= job.claim_expires_at, AcpError::AlreadyExpired);
        require!(planning_fee <= job.planning_fee_cap, AcpError::FeeCapExceeded);
        require!(fixed_fee <= job.fixed_fee_cap, AcpError::FeeCapExceeded);

        job.plan_hash = plan_hash;
        job.planning_fee = planning_fee;
        job.fixed_fee = fixed_fee;
        job.state = JobState::PlanPending as u8;
        job.review_expires_at = now + REVIEW_TTL;

        emit!(PlanSubmitted {
            job: job.key(),
            planning_fee,
            fixed_fee,
            review_expires_at: job.review_expires_at,
        });
        Ok(())
    }

    /// Oracle-only. Hard-clamped at write time so a compromised oracle can
    /// never record more than the employer funded; settlement clamps again.
    pub fn report_usage(ctx: Context<ReportUsage>, phase: u8, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.oracle_config;
        require!(cfg.is_signer(&ctx.accounts.oracle_signer.key()), AcpError::NotOracleSigner);

        let job = &mut ctx.accounts.job;
        require!(!job.state().is_terminal(), AcpError::BadState);

        if phase == Phase::Planning as u8 {
            require!(amount <= job.planning_token_cap, AcpError::UsageCapExceeded);
            job.planning_tokens_used = amount;
        } else {
            require!(amount <= job.token_budget_cap, AcpError::UsageCapExceeded);
            job.execution_tokens_used = amount;
        }

        emit!(UsageReported {
            job: job.key(),
            phase,
            amount,
        });
        Ok(())
    }

    pub fn accept_plan(ctx: Context<EmployerAction>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::PlanPending as u8, AcpError::BadState);
        require!(job.employer == ctx.accounts.employer.key(), AcpError::NotEmployer);

        job.state = JobState::InProgress as u8;
        job.review_expires_at = 0;
        emit!(PlanAccepted { job: job.key(), deadline: job.deadline });
        Ok(())
    }

    pub fn submit_deliverable(
        ctx: Context<AgentAction>,
        deliverable_hash: [u8; 32],
        usage_root: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::InProgress as u8, AcpError::BadState);
        require!(job.agent == ctx.accounts.agent.key(), AcpError::NotAgent);
        require!(now <= job.deadline, AcpError::AlreadyExpired);

        job.deliverable_hash = deliverable_hash;
        job.usage_root = usage_root;
        job.state = JobState::ReviewPending as u8;
        job.review_expires_at = now + REVIEW_TTL;

        emit!(DeliverableSubmitted {
            job: job.key(),
            review_expires_at: job.review_expires_at,
        });
        Ok(())
    }

    // -----------------------------------------------------------------
    // Terminal transitions
    //
    // All five funnel into `finalize`, which is the only place money moves out
    // of the vault and the only place reputation is written.
    // -----------------------------------------------------------------

    pub fn reject_plan(ctx: Context<Finalize>) -> Result<()> {
        require!(
            ctx.accounts.job.state == JobState::PlanPending as u8,
            AcpError::BadState
        );
        require!(
            ctx.accounts.job.employer == ctx.accounts.actor.key(),
            AcpError::NotEmployer
        );
        finalize(ctx, Outcome::PlanRejected, 0, false)
    }

    pub fn accept_deliverable(ctx: Context<Finalize>, rating: u8) -> Result<()> {
        require!(rating <= 10, AcpError::BadRating);
        require!(
            ctx.accounts.job.state == JobState::ReviewPending as u8,
            AcpError::BadState
        );
        require!(
            ctx.accounts.job.employer == ctx.accounts.actor.key(),
            AcpError::NotEmployer
        );
        finalize(ctx, Outcome::Accepted, rating, false)
    }

    pub fn reject_deliverable(ctx: Context<Finalize>) -> Result<()> {
        require!(
            ctx.accounts.job.state == JobState::ReviewPending as u8,
            AcpError::BadState
        );
        require!(
            ctx.accounts.job.employer == ctx.accounts.actor.key(),
            AcpError::NotEmployer
        );
        finalize(ctx, Outcome::DeliverableRejected, 0, false)
    }

    /// Permissionless crank. A silent employer must not be able to freeze
    /// agent capital indefinitely, so review windows auto-accept at a neutral
    /// rating of 5. `jobs_auto_accepted` records it, because an employer who
    /// reviews nothing auto-accepts bad work too.
    pub fn auto_accept(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &ctx.accounts.job;
        require!(
            job.state == JobState::PlanPending as u8 || job.state == JobState::ReviewPending as u8,
            AcpError::BadState
        );
        require!(job.review_expires_at != 0 && now > job.review_expires_at, AcpError::NotExpired);

        if job.state == JobState::PlanPending as u8 {
            // Auto-accepting a plan is not a settlement; it just moves the job
            // forward. Handled by `auto_accept_plan` instead.
            return err!(AcpError::BadState);
        }
        finalize(ctx, Outcome::Accepted, 5, true)
    }

    /// Separate from `auto_accept` because accepting a *plan* is not a
    /// terminal state and must not touch the vault.
    pub fn auto_accept_plan(ctx: Context<EmployerCrank>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &mut ctx.accounts.job;
        require!(job.state == JobState::PlanPending as u8, AcpError::BadState);
        require!(job.review_expires_at != 0 && now > job.review_expires_at, AcpError::NotExpired);

        job.state = JobState::InProgress as u8;
        job.review_expires_at = 0;
        job.auto_accepted = true;
        ctx.accounts.employer_profile.jobs_auto_accepted = ctx
            .accounts
            .employer_profile
            .jobs_auto_accepted
            .saturating_add(1);
        emit!(PlanAccepted { job: job.key(), deadline: job.deadline });
        Ok(())
    }

    /// Permissionless crank for a blown timer: unaccepted offer, unclaimed
    /// plan window, or missed deadline. Agent gets nothing and the bond is
    /// slashed to the employer — this is what makes claiming a job non-free.
    pub fn expire_job(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &ctx.accounts.job;
        let blown = match job.state() {
            JobState::Offered => job.offer_expires_at != 0 && now > job.offer_expires_at,
            JobState::Claimed => job.claim_expires_at != 0 && now > job.claim_expires_at,
            JobState::InProgress | JobState::Open => now > job.deadline,
            _ => false,
        };
        require!(blown, AcpError::NotExpired);
        finalize(ctx, Outcome::Expired, 0, false)
    }

    /// Employer withdraws an unclaimed job. Full refund, nothing slashed.
    pub fn cancel_job(ctx: Context<Finalize>) -> Result<()> {
        let job = &ctx.accounts.job;
        require!(
            job.state == JobState::Open as u8 || job.state == JobState::Offered as u8,
            AcpError::BadState
        );
        require!(job.employer == ctx.accounts.actor.key(), AcpError::NotEmployer);
        finalize(ctx, Outcome::Expired, 0, false)
    }

    // -----------------------------------------------------------------
    // Tier-1 holdback
    // -----------------------------------------------------------------

    /// Releases the withheld token reimbursement once the reconciliation
    /// window closes. Permissionless — the agent should not need the platform
    /// to be responsive to get paid what was already adjudicated.
    pub fn release_holdback(ctx: Context<ReleaseHoldback>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let job = &mut ctx.accounts.job;
        require!(job.holdback_amount > 0, AcpError::NoHoldback);
        require!(now >= job.holdback_until, AcpError::HoldbackPending);

        let amount = job.holdback_amount;
        job.holdback_amount = 0;

        let employer = job.employer;
        let nonce = job.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[b"job", employer.as_ref(), nonce.as_ref(), &[job.bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.agent_token.to_account_info(),
                    authority: ctx.accounts.job.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(HoldbackReleased { job: ctx.accounts.job.key(), amount });
        Ok(())
    }

    /// Oracle-only, on confirmed reconciliation failure: the withheld tokens
    /// go back to the employer and the wallet takes a reputation hit.
    ///
    /// Reconciliation only catches *systematic* inflation — an agent can
    /// over-report one job and under-report another so a rolling window nets
    /// out. This is a backstop, not a solution.
    pub fn claw_back_holdback(ctx: Context<ClawBack>) -> Result<()> {
        require!(
            ctx.accounts.oracle_config.is_signer(&ctx.accounts.oracle_signer.key()),
            AcpError::NotOracleSigner
        );
        let job = &mut ctx.accounts.job;
        require!(job.holdback_amount > 0, AcpError::NoHoldback);

        let amount = job.holdback_amount;
        job.holdback_amount = 0;

        let profile = &mut ctx.accounts.wallet_profile;
        profile.wrs = apply_clawback_penalty(profile.wrs, job.escrow_total());

        let employer = job.employer;
        let nonce = job.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[b"job", employer.as_ref(), nonce.as_ref(), &[job.bump]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.employer_token.to_account_info(),
                    authority: ctx.accounts.job.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(HoldbackClawedBack { job: ctx.accounts.job.key(), amount });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Shared settlement path
// ---------------------------------------------------------------------------

/// The single place value leaves the vault. Every terminal transition routes
/// here so the settlement matrix and the reputation update can never drift
/// apart between code paths.
fn finalize(ctx: Context<Finalize>, outcome: Outcome, rating: u8, auto: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let fee_bps = ctx.accounts.oracle_config.protocol_fee_bps;

    let (escrow_total, tier, bond, had_agent) = {
        let job = &ctx.accounts.job;
        (
            job.escrow_total(),
            job.claimed_tier.max(TIER_RECONCILED),
            job.bond,
            job.agent != Pubkey::default() && job.claimed_tier != 0,
        )
    };

    let s = settle(
        outcome,
        tier,
        escrow_total,
        ctx.accounts.job.planning_fee,
        ctx.accounts.job.fixed_fee,
        ctx.accounts.job.planning_token_cap,
        ctx.accounts.job.token_budget_cap,
        ctx.accounts.job.planning_tokens_used,
        ctx.accounts.job.execution_tokens_used,
        fee_bps,
    );

    let employer = ctx.accounts.job.employer;
    let nonce = ctx.accounts.job.nonce.to_le_bytes();
    let job_bump = ctx.accounts.job.bump;
    let seeds: &[&[u8]] = &[b"job", employer.as_ref(), nonce.as_ref(), &[job_bump]];
    let signer = &[seeds];

    // 1. agent's immediate portion
    if s.agent_immediate > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.agent_token.to_account_info(),
                    authority: ctx.accounts.job.to_account_info(),
                },
                signer,
            ),
            s.agent_immediate,
        )?;
    }

    // 2. protocol fee — 1% of margin only
    if s.protocol_fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_token.to_account_info(),
                    authority: ctx.accounts.job.to_account_info(),
                },
                signer,
            ),
            s.protocol_fee,
        )?;
    }

    // 3. employer refund — everything not earned
    if s.employer_refund > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.employer_token.to_account_info(),
                    authority: ctx.accounts.job.to_account_info(),
                },
                signer,
            ),
            s.employer_refund,
        )?;
    }

    // 4. bond — slashed to the employer on expiry, returned in full on every
    //    legitimate terminal state, including rejection.
    if bond > 0 {
        let dest = if outcome == Outcome::Expired {
            ctx.accounts.employer_token.to_account_info()
        } else {
            ctx.accounts.agent_token.to_account_info()
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: dest,
                    authority: ctx.accounts.job.to_account_info(),
                },
                signer,
            ),
            bond,
        )?;
    }

    // 5. reputation and the immutable counters
    if had_agent {
        let profile = &mut ctx.accounts.wallet_profile;
        profile.wrs = apply_wrs(profile.wrs, outcome, rating, escrow_total);
        profile.active_claims = profile.active_claims.saturating_sub(1);
        match outcome {
            Outcome::Accepted => {
                profile.jobs_completed = profile.jobs_completed.saturating_add(1);
                profile.total_value_settled = profile
                    .total_value_settled
                    .saturating_add(s.agent_immediate.saturating_add(s.agent_holdback));
            }
            Outcome::PlanRejected | Outcome::DeliverableRejected => {
                profile.jobs_rejected = profile.jobs_rejected.saturating_add(1);
            }
            Outcome::Expired => {
                profile.jobs_expired = profile.jobs_expired.saturating_add(1);
            }
        }
    }

    let employer_profile = &mut ctx.accounts.employer_profile;
    if matches!(outcome, Outcome::PlanRejected | Outcome::DeliverableRejected) {
        employer_profile.jobs_rejected = employer_profile.jobs_rejected.saturating_add(1);
    }
    if auto {
        employer_profile.jobs_auto_accepted =
            employer_profile.jobs_auto_accepted.saturating_add(1);
    }

    let job = &mut ctx.accounts.job;
    job.rating = rating;
    job.auto_accepted = auto;
    job.bond = 0;
    job.holdback_amount = s.agent_holdback;
    job.holdback_until = if s.agent_holdback > 0 {
        now + RECONCILIATION_WINDOW
    } else {
        0
    };
    job.state = if outcome == Outcome::Expired {
        JobState::Expired as u8
    } else {
        JobState::Settled as u8
    };

    emit!(JobSettled {
        job: job.key(),
        outcome: outcome as u8,
        agent_immediate: s.agent_immediate,
        agent_holdback: s.agent_holdback,
        protocol_fee: s.protocol_fee,
        employer_refund: s.employer_refund,
        bond_slashed: outcome == Outcome::Expired && bond > 0,
        rating,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Instruction args
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PostJobArgs {
    pub nonce: u64,
    pub job_type: u8,
    /// Required for Direct, must be None for Open.
    pub agent: Option<Pubkey>,
    pub spec_hash: [u8; 32],
    pub planning_fee_cap: u64,
    pub fixed_fee_cap: u64,
    pub planning_token_cap: u64,
    pub token_budget_cap: u64,
    pub min_tier: u8,
    pub deadline: i64,
}

// ---------------------------------------------------------------------------
// Contexts
//
// Every non-trivial account is Boxed. Anchor puts account data on the stack by
// default and SBF caps a function frame at 4096 bytes; a Box leaves an 8-byte
// pointer instead. This is not premature optimisation — the unboxed version of
// `PostJob` needed 5200 bytes.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = OracleConfig::SPACE,
        seeds = [b"oracle"],
        bump
    )]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: treasury is an address only; its token account is validated at settlement.
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = admin.key() == oracle_config.admin @ AcpError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
}

#[derive(Accounts)]
pub struct RegisterWallet<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(
        init_if_needed,
        payer = wallet,
        space = WalletProfile::SPACE,
        seeds = [b"wallet", wallet.key().as_ref()],
        bump
    )]
    pub wallet_profile: Box<Account<'info, WalletProfile>>,
    #[account(seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterEmployer<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(
        init_if_needed,
        payer = employer,
        space = EmployerProfile::SPACE,
        seeds = [b"employer", employer.key().as_ref()],
        bump
    )]
    pub employer_profile: Box<Account<'info, EmployerProfile>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: PostJobArgs)]
pub struct PostJob<'info> {
    #[account(mut)]
    pub employer: Signer<'info>,
    #[account(seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    #[account(
        mut,
        seeds = [b"employer", employer.key().as_ref()],
        bump = employer_profile.bump
    )]
    pub employer_profile: Box<Account<'info, EmployerProfile>>,
    #[account(
        init,
        payer = employer,
        space = Job::SPACE,
        seeds = [b"job", employer.key().as_ref(), &args.nonce.to_le_bytes()],
        bump
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        init,
        payer = employer,
        seeds = [b"vault", job.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = job,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = employer_token.mint == oracle_config.usdc_mint @ AcpError::WrongMint,
        constraint = employer_token.owner == employer.key() @ AcpError::WrongTokenOwner
    )]
    pub employer_token: Box<Account<'info, TokenAccount>>,
    #[account(address = oracle_config.usdc_mint @ AcpError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    pub agent: Signer<'info>,
    #[account(mut)]
    pub job: Box<Account<'info, Job>>,
    #[account(
        mut,
        seeds = [b"wallet", agent.key().as_ref()],
        bump = wallet_profile.bump
    )]
    pub wallet_profile: Box<Account<'info, WalletProfile>>,
}

#[derive(Accounts)]
pub struct ClaimJob<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    #[account(seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    #[account(mut)]
    pub job: Box<Account<'info, Job>>,
    #[account(
        mut,
        seeds = [b"wallet", agent.key().as_ref()],
        bump = wallet_profile.bump
    )]
    pub wallet_profile: Box<Account<'info, WalletProfile>>,
    #[account(
        init,
        payer = agent,
        seeds = [b"bond", job.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = job,
    )]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = agent_token.mint == oracle_config.usdc_mint @ AcpError::WrongMint,
        constraint = agent_token.owner == agent.key() @ AcpError::WrongTokenOwner
    )]
    pub agent_token: Box<Account<'info, TokenAccount>>,
    #[account(address = oracle_config.usdc_mint @ AcpError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AgentAction<'info> {
    pub agent: Signer<'info>,
    #[account(mut)]
    pub job: Box<Account<'info, Job>>,
}

#[derive(Accounts)]
pub struct EmployerAction<'info> {
    pub employer: Signer<'info>,
    #[account(mut)]
    pub job: Box<Account<'info, Job>>,
}

#[derive(Accounts)]
pub struct EmployerCrank<'info> {
    pub cranker: Signer<'info>,
    #[account(mut)]
    pub job: Box<Account<'info, Job>>,
    #[account(
        mut,
        seeds = [b"employer", job.employer.as_ref()],
        bump = employer_profile.bump
    )]
    pub employer_profile: Box<Account<'info, EmployerProfile>>,
}

#[derive(Accounts)]
pub struct ReportUsage<'info> {
    pub oracle_signer: Signer<'info>,
    #[account(seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    #[account(mut)]
    pub job: Box<Account<'info, Job>>,
}

/// Used by every terminal transition. `actor` is the employer for the review
/// actions and anyone for the permissionless cranks; the employer-only checks
/// live in the instruction bodies rather than here because the same context
/// serves both.
#[derive(Accounts)]
pub struct Finalize<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    #[account(
        mut,
        seeds = [b"job", job.employer.as_ref(), &job.nonce.to_le_bytes()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        mut,
        seeds = [b"vault", job.key().as_ref()],
        bump = job.vault_bump
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: only touched when `job.bond > 0`; seeds are checked there.
    #[account(mut)]
    pub bond_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"employer", job.employer.as_ref()],
        bump = employer_profile.bump
    )]
    pub employer_profile: Box<Account<'info, EmployerProfile>>,
    #[account(mut)]
    pub wallet_profile: Box<Account<'info, WalletProfile>>,
    #[account(
        mut,
        constraint = employer_token.owner == job.employer @ AcpError::WrongTokenOwner,
        constraint = employer_token.mint == oracle_config.usdc_mint @ AcpError::WrongMint
    )]
    pub employer_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = agent_token.mint == oracle_config.usdc_mint @ AcpError::WrongMint
    )]
    pub agent_token: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = treasury_token.owner == oracle_config.treasury @ AcpError::WrongTokenOwner,
        constraint = treasury_token.mint == oracle_config.usdc_mint @ AcpError::WrongMint
    )]
    pub treasury_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ReleaseHoldback<'info> {
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job", job.employer.as_ref(), &job.nonce.to_le_bytes()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = agent_token.owner == job.agent @ AcpError::WrongTokenOwner)]
    pub agent_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClawBack<'info> {
    pub oracle_signer: Signer<'info>,
    #[account(seeds = [b"oracle"], bump = oracle_config.bump)]
    pub oracle_config: Box<Account<'info, OracleConfig>>,
    #[account(
        mut,
        seeds = [b"job", job.employer.as_ref(), &job.nonce.to_le_bytes()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(mut, seeds = [b"vault", job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [b"wallet", job.agent.as_ref()],
        bump = wallet_profile.bump
    )]
    pub wallet_profile: Box<Account<'info, WalletProfile>>,
    #[account(mut, constraint = employer_token.owner == job.employer @ AcpError::WrongTokenOwner)]
    pub employer_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct JobPosted {
    pub job: Pubkey,
    pub employer: Pubkey,
    pub agent: Pubkey,
    pub job_type: u8,
    pub escrow_total: u64,
    pub min_tier: u8,
    pub deadline: i64,
}

#[event]
pub struct JobClaimed {
    pub job: Pubkey,
    pub agent: Pubkey,
    pub tier: u8,
    pub bond: u64,
}

#[event]
pub struct PlanSubmitted {
    pub job: Pubkey,
    pub planning_fee: u64,
    pub fixed_fee: u64,
    pub review_expires_at: i64,
}

#[event]
pub struct PlanAccepted {
    pub job: Pubkey,
    pub deadline: i64,
}

#[event]
pub struct DeliverableSubmitted {
    pub job: Pubkey,
    pub review_expires_at: i64,
}

#[event]
pub struct UsageReported {
    pub job: Pubkey,
    pub phase: u8,
    pub amount: u64,
}

#[event]
pub struct JobSettled {
    pub job: Pubkey,
    pub outcome: u8,
    pub agent_immediate: u64,
    pub agent_holdback: u64,
    pub protocol_fee: u64,
    pub employer_refund: u64,
    pub bond_slashed: bool,
    pub rating: u8,
}

#[event]
pub struct HoldbackReleased {
    pub job: Pubkey,
    pub amount: u64,
}

#[event]
pub struct HoldbackClawedBack {
    pub job: Pubkey,
    pub amount: u64,
}
