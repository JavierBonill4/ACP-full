import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";

import type { AcpCtx } from "./anchor";
import { getTreasury, getUsdcMint } from "./constants";
import {
  bondVaultPda,
  employerProfilePda,
  jobPda,
  oracleConfigPda,
  vaultPda,
  walletProfilePda,
} from "./pdas";

/**
 * Employer-side on-chain actions, called from the browser with a connected
 * wallet as signer.
 *
 * PROVEN — exercised end-to-end by program/scripts/e2e-onchain-job.mjs
 * against a real deployed program, with matching balance deltas:
 *   postJob, acceptPlan, acceptDeliverable
 *
 * BEST-EFFORT, NOT YET EXERCISED — built by inferring account shape from the
 * proven instructions above (Finalize's account set is shared across every
 * terminal outcome per lib.rs's design) and from instruction naming. These
 * are the first thing to check against a real error if one of these calls
 * fails with an Anchor account-resolution or arg-count error:
 *   rejectPlan, rejectDeliverable, cancelJob
 * If lib.rs's account struct or instruction args differ from what's built
 * here, Anchor will throw a specific, readable error naming the mismatch —
 * paste it back and this gets corrected precisely rather than re-guessed.
 */

const usdc = (n: number) => new BN(Math.round(n * 1_000_000));

export async function sha256Bytes(text: string): Promise<number[]> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest));
}

/**
 * `program.account.<name>` is only statically typed when the Program is
 * constructed from a codegenned IDL type — this file works against the raw
 * IDL (see anchor.ts), so account access is necessarily dynamic. Real,
 * proven at runtime against the deployed program; just not something the
 * placeholder-IDL typecheck here can verify ahead of time.
 */
type DynamicAccounts = Record<string, { fetch: (pda: PublicKey) => Promise<unknown>; fetchNullable: (pda: PublicKey) => Promise<unknown> }>;

async function resolveEmployerProfile(ctx: AcpCtx) {
  const employerProfile = employerProfilePda(ctx.publicKey);
  const accounts = ctx.program.account as unknown as DynamicAccounts;
  const existing = await accounts.employerProfile.fetchNullable(employerProfile).catch(() => null);
  return {
    employerProfile,
    nonce: existing ? (existing as { nextNonce: BN }).nextNonce : new BN(0),
    needsRegistration: !existing,
  };
}

interface JobContext {
  jobAccount: { employer: PublicKey; agent: PublicKey };
  vault: PublicKey;
  bondVault: PublicKey;
  employerProfile: PublicKey;
  walletProfile: PublicKey;
  employerToken: PublicKey;
  agentToken: PublicKey;
  treasuryToken: PublicKey;
}

async function loadJobContext(ctx: AcpCtx, job: PublicKey): Promise<JobContext> {
  const accounts = ctx.program.account as unknown as DynamicAccounts;
  const jobAccount = (await accounts.job.fetch(job)) as {
    employer: PublicKey;
    agent: PublicKey;
  };
  const usdcMint = getUsdcMint();
  const [employerToken, agentToken, treasuryToken] = await Promise.all([
    getAssociatedTokenAddress(usdcMint, jobAccount.employer),
    getAssociatedTokenAddress(usdcMint, jobAccount.agent),
    getAssociatedTokenAddress(usdcMint, getTreasury()),
  ]);
  return {
    jobAccount,
    vault: vaultPda(job),
    bondVault: bondVaultPda(job),
    employerProfile: employerProfilePda(jobAccount.employer),
    walletProfile: walletProfilePda(jobAccount.agent),
    employerToken,
    agentToken,
    treasuryToken,
  };
}

// ---------------------------------------------------------------------------
// PROVEN
// ---------------------------------------------------------------------------

export interface PostJobArgs {
  /** "general" = open marketplace (any registered agent may claim_job it).
   *  "direct" = a specific agent hire, must be paired with `agent`. */
  jobType: "general" | "direct";
  agent?: PublicKey;
  /** 32 bytes — use sha256Bytes(specText) above. */
  specHash: number[];
  planningFeeCapUsdc: number;
  fixedFeeCapUsdc: number;
  planningTokenCapUsdc: number;
  tokenBudgetCapUsdc: number;
  minTier: number;
  deadline: Date;
}

/**
 * Funds escrow at the TOP of each cap (see math.rs / ARCHITECTURE.md §on
 * fee ceilings) — this is the transaction that actually moves USDC out of
 * the employer's wallet.
 *
 * First-time employers are registered (register_employer) as a
 * preInstruction in the SAME transaction, so posting a first job is still
 * one wallet approval, not two.
 *
 * The `jobType: "general"` / `agent: undefined` path (open marketplace, no
 * specific hire) has never been exercised end-to-end — only "direct" has,
 * via the e2e script. If postJob throws on a general job specifically,
 * that's the first thing to check: lib.rs's PostJobArgs.agent may be typed
 * `Option<Pubkey>` (expects `null` here, not `undefined`) rather than what's
 * sent below.
 */
export async function postJob(
  ctx: AcpCtx,
  args: PostJobArgs
): Promise<{ job: PublicKey; signature: string }> {
  const { program, publicKey: employer } = ctx;
  const { employerProfile, nonce, needsRegistration } = await resolveEmployerProfile(ctx);
  const job = jobPda(employer, nonce);
  const vault = vaultPda(job);
  const usdcMint = getUsdcMint();
  const employerToken = await getAssociatedTokenAddress(usdcMint, employer);

  const builder = program.methods
    .postJob({
      nonce,
      jobType: args.jobType === "direct" ? 1 : 0,
      agent: args.jobType === "direct" ? args.agent ?? null : null,
      specHash: args.specHash,
      planningFeeCap: usdc(args.planningFeeCapUsdc),
      fixedFeeCap: usdc(args.fixedFeeCapUsdc),
      planningTokenCap: usdc(args.planningTokenCapUsdc),
      tokenBudgetCap: usdc(args.tokenBudgetCapUsdc),
      minTier: args.minTier,
      deadline: new BN(Math.floor(args.deadline.getTime() / 1000)),
    })
    .accounts({
      employer,
      oracleConfig: oracleConfigPda(),
      employerProfile,
      job,
      vault,
      employerToken,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    });

  if (needsRegistration) {
    const registerIx = await program.methods
      .registerEmployer()
      .accounts({ employer, employerProfile, systemProgram: SystemProgram.programId })
      .instruction();
    builder.preInstructions([registerIx]);
  }

  const signature = await builder.rpc();
  return { job, signature };
}

/** Employer approves the agent's submitted plan — moves the job to funded execution. */
export async function acceptPlan(ctx: AcpCtx, job: PublicKey): Promise<{ signature: string }> {
  const signature = await ctx.program.methods
    .acceptPlan()
    .accounts({ employer: ctx.publicKey, job })
    .rpc();
  return { signature };
}

/** Employer approves the delivered work — this is the payout transaction. */
export async function acceptDeliverable(
  ctx: AcpCtx,
  job: PublicKey,
  rating: number
): Promise<{ signature: string }> {
  const c = await loadJobContext(ctx, job);
  const signature = await ctx.program.methods
    .acceptDeliverable(rating)
    .accounts({
      actor: ctx.publicKey,
      oracleConfig: oracleConfigPda(),
      job,
      vault: c.vault,
      // Only read by Finalize when job.bond > 0 — fine uninitialized for an
      // unbonded direct hire, same as the e2e script.
      bondVault: c.bondVault,
      employerProfile: c.employerProfile,
      walletProfile: c.walletProfile,
      employerToken: c.employerToken,
      agentToken: c.agentToken,
      treasuryToken: c.treasuryToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { signature };
}

// ---------------------------------------------------------------------------
// BEST-EFFORT — see file header
// ---------------------------------------------------------------------------

/** Employer rejects the plan, sending the agent back to re-propose (or the job to expire on claim_ttl). */
export async function rejectPlan(
  ctx: AcpCtx,
  job: PublicKey,
  reason = ""
): Promise<{ signature: string }> {
  const signature = await ctx.program.methods
    .rejectPlan(reason)
    .accounts({ employer: ctx.publicKey, job })
    .rpc();
  return { signature };
}

/** Employer rejects the delivered work. Assumed to route through the same shared Finalize as acceptDeliverable. */
export async function rejectDeliverable(
  ctx: AcpCtx,
  job: PublicKey,
  reason = ""
): Promise<{ signature: string }> {
  const c = await loadJobContext(ctx, job);
  const signature = await ctx.program.methods
    .rejectDeliverable(reason)
    .accounts({
      actor: ctx.publicKey,
      oracleConfig: oracleConfigPda(),
      job,
      vault: c.vault,
      bondVault: c.bondVault,
      employerProfile: c.employerProfile,
      walletProfile: c.walletProfile,
      employerToken: c.employerToken,
      agentToken: c.agentToken,
      treasuryToken: c.treasuryToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { signature };
}

/** Employer cancels before completion. Assumed to route through the same shared Finalize. */
export async function cancelJob(ctx: AcpCtx, job: PublicKey): Promise<{ signature: string }> {
  const c = await loadJobContext(ctx, job);
  const signature = await ctx.program.methods
    .cancelJob()
    .accounts({
      actor: ctx.publicKey,
      oracleConfig: oracleConfigPda(),
      job,
      vault: c.vault,
      bondVault: c.bondVault,
      employerProfile: c.employerProfile,
      walletProfile: c.walletProfile,
      employerToken: c.employerToken,
      agentToken: c.agentToken,
      treasuryToken: c.treasuryToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  return { signature };
}