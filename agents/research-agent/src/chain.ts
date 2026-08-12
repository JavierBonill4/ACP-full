import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { config } from "./config.js";

/**
 * The agent's own on-chain signing — accept_offer / claim_job / submit_plan /
 * submit_deliverable, signed with THIS agent's Solana keypair. Separate from
 * the HMAC-signed HTTP calls in platform.ts, which report the same events to
 * the backend's off-chain job-state DB. Both happen for each step: the chain
 * call is what actually moves job/escrow state on-chain; the HTTP callback
 * is what the backend/UI reads to know it happened.
 *
 * PROVEN — exercised end-to-end by program/scripts/e2e-onchain-job.mjs
 * against a real deployed program:
 *   registerWalletIfNeeded, acceptOffer, submitPlan, submitDeliverable
 *
 * NOT exercised — no open-marketplace ("general") job has been run through
 * the full lifecycle yet, only direct hires:
 *   claimJob
 */

const { AnchorProvider, Program } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const chainEnabled = Boolean(config.SOLANA_KEYPAIR_PATH && config.ACP_PROGRAM_ID);

function expand(path: string): string {
  return path.replace(/^~/, homedir());
}

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(resolve(expand(path)), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const enc = (s: string) => Buffer.from(s, "utf8");

interface ChainCtx {
  wallet: Keypair;
  program: anchor.Program;
  connection: anchor.web3.Connection;
}

let cached: ChainCtx | null = null;

function chain(): ChainCtx {
  if (!chainEnabled) {
    throw new Error(
      "On-chain signing is not configured for this agent. Set SOLANA_KEYPAIR_PATH and " +
        "ACP_PROGRAM_ID in .env — see PATCHES-5.md."
    );
  }
  if (cached) return cached;

  const wallet = loadKeypair(config.SOLANA_KEYPAIR_PATH!);
  const connection = new anchor.web3.Connection(
    config.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const provider = new AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync(resolve(__dirname, "../idl.json"), "utf8"));
  const programId = new PublicKey(config.ACP_PROGRAM_ID!);

  // Same Anchor 0.29→0.30 Program-constructor fallback as the e2e script and
  // frontend/lib/anchor.ts — proven at runtime, not statically typeable
  // across both constructor shapes at once.
  let program: anchor.Program;
  try {
    program = new Program(idl, provider);
  } catch {
    program = new (Program as any)(idl, programId, provider);
  }

  cached = { wallet, program, connection };
  return cached;
}

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, chain().program.programId)[0];
}

const walletProfilePda = (w: PublicKey) => pda([enc("wallet"), w.toBuffer()]);
const oracleConfigPda = () => pda([enc("oracle")]);

export function agentPublicKey(): PublicKey {
  return chain().wallet.publicKey;
}

/**
 * Idempotent — register_wallet uses init_if_needed on-chain, so calling this
 * unconditionally every time (rather than fetching first to check) is
 * deliberate: it's a cheap no-op once the WalletProfile PDA already exists,
 * and it means a freshly rotated or newly deployed agent never has to think
 * about registration order.
 */
export async function registerWalletIfNeeded(tier: 1 | 2): Promise<void> {
  const { wallet, program } = chain();
  await program.methods
    .registerWallet(tier)
    .accounts({
      wallet: wallet.publicKey,
      walletProfile: walletProfilePda(wallet.publicKey),
      oracleConfig: oracleConfigPda(),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Direct hire: take the offer. Must happen inside the 6h accept_ttl. */
export async function acceptOffer(jobAddress: string): Promise<{ signature: string }> {
  const { wallet, program } = chain();
  const job = new PublicKey(jobAddress);
  const signature = await program.methods
    .acceptOffer()
    .accounts({ agent: wallet.publicKey, job, walletProfile: walletProfilePda(wallet.publicKey) })
    .rpc();
  return { signature };
}

/**
 * Open-marketplace jobs only — a direct hire uses acceptOffer instead. Not
 * exercised by the e2e script (which only tests the direct-hire path); if
 * this throws an account-resolution error, check lib.rs's ClaimJob accounts
 * struct against what's built here.
 */
export async function claimJob(jobAddress: string): Promise<{ signature: string }> {
  const { wallet, program } = chain();
  const job = new PublicKey(jobAddress);
  const signature = await program.methods
    .claimJob()
    .accounts({ agent: wallet.publicKey, job, walletProfile: walletProfilePda(wallet.publicKey) })
    .rpc();
  return { signature };
}

export async function submitPlan(
  jobAddress: string,
  args: { planHash: number[]; planningFeeUsdc: number; fixedFeeUsdc: number }
): Promise<{ signature: string }> {
  const { wallet, program } = chain();
  const job = new PublicKey(jobAddress);
  const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
  const signature = await program.methods
    .submitPlan(args.planHash, usdc(args.planningFeeUsdc), usdc(args.fixedFeeUsdc))
    .accounts({ agent: wallet.publicKey, job })
    .rpc();
  return { signature };
}

/**
 * The e2e script passes a second 32-byte zero-filled array alongside the
 * deliverable hash — proven to work, but its exact purpose (reserved field?
 * a content-encryption-key hash? unused today?) isn't documented in anything
 * available this session, so it's passed through unchanged here. Flag it if
 * lib.rs's submit_deliverable signature says it means something specific.
 */
export async function submitDeliverable(
  jobAddress: string,
  deliverableHash: number[]
): Promise<{ signature: string }> {
  const { wallet, program } = chain();
  const job = new PublicKey(jobAddress);
  const signature = await program.methods
    .submitDeliverable(deliverableHash, new Array(32).fill(0))
    .accounts({ agent: wallet.publicKey, job })
    .rpc();
  return { signature };
}