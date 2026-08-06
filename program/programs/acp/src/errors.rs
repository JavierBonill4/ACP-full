use anchor_lang::prelude::*;

#[error_code]
pub enum AcpError {
    #[msg("Protocol is paused")]
    Paused,
    #[msg("Signer is not the oracle admin")]
    NotAdmin,
    #[msg("Signer is not a whitelisted oracle signer")]
    NotOracleSigner,
    #[msg("Oracle signer list is full")]
    SignerListFull,
    #[msg("Protocol fee exceeds the maximum")]
    FeeTooHigh,

    #[msg("Job is not in a state that allows this action")]
    BadState,
    #[msg("Caller is not the employer for this job")]
    NotEmployer,
    #[msg("Caller is not the agent for this job")]
    NotAgent,
    #[msg("This job was offered to a different agent")]
    WrongAgent,

    #[msg("Agent tier is below the job's minimum tier")]
    TierTooLow,
    #[msg("Tier is not enabled in this deployment")]
    TierNotEnabled,
    #[msg("Job value exceeds this tier's cap")]
    ValueCapExceeded,
    #[msg("Wallet has reached its concurrent claim limit")]
    ClaimLimitReached,

    #[msg("Deadline is in the past or beyond the maximum horizon")]
    BadDeadline,
    #[msg("Timer has not expired yet")]
    NotExpired,
    #[msg("Timer has already expired")]
    AlreadyExpired,
    #[msg("Holdback window has not closed")]
    HoldbackPending,
    #[msg("There is no holdback on this job")]
    NoHoldback,

    #[msg("Proposed fee exceeds the employer's funded ceiling")]
    FeeCapExceeded,
    #[msg("Reported usage exceeds the phase cap")]
    UsageCapExceeded,
    #[msg("Rating must be between 0 and 10")]
    BadRating,
    #[msg("Escrow amounts must be non-zero")]
    ZeroEscrow,
    #[msg("Token account mint does not match the configured USDC mint")]
    WrongMint,
    #[msg("Token account owner does not match the expected party")]
    WrongTokenOwner,
    #[msg("Arithmetic overflow")]
    Overflow,
}
