import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import { env } from "./env.js";

export const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
export const PROGRAM_ID = new PublicKey(env.ACP_PROGRAM_ID);
export const USDC_MINT = new PublicKey(env.USDC_MINT);
export const TREASURY = new PublicKey(env.TREASURY_ADDRESS);

/**
 * The single platform-controlled whitelisted address that writes usage to
 * escrow. Every payout depends on this key being honest and available — that
 * is the MVP trust model, stated plainly, and it must not be described as
 * trustless in any external material. OracleConfig already carries a signer
 * vec and a threshold so multisig is additive.
 */
export const oracleKeypair: Keypair | null = env.ORACLE_SECRET_KEY
  ? Keypair.fromSecretKey(bs58.decode(env.ORACLE_SECRET_KEY))
  : null;

export function requireOracle(): Keypair {
  if (!oracleKeypair) {
    throw new Error("ORACLE_SECRET_KEY is not configured; usage cannot be reported");
  }
  return oracleKeypair;
}

// --- PDAs ------------------------------------------------------------------
// Kept in one place and mirrored in frontend/lib/pdas.ts. If a seed changes
// here it changes there, or the frontend derives an address the program will
// reject with a constraint violation that reads like a bug in the wallet.

const enc = (s: string) => Buffer.from(s, "utf8");

export const oracleConfigPda = () =>
  PublicKey.findProgramAddressSync([enc("oracle")], PROGRAM_ID)[0];

export const walletProfilePda = (wallet: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("wallet"), wallet.toBuffer()], PROGRAM_ID)[0];

export const employerProfilePda = (employer: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("employer"), employer.toBuffer()], PROGRAM_ID)[0];

export const jobPda = (employer: PublicKey, nonce: number | bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync([enc("job"), employer.toBuffer(), buf], PROGRAM_ID)[0];
};

export const vaultPda = (job: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("vault"), job.toBuffer()], PROGRAM_ID)[0];

export const bondVaultPda = (job: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("bond"), job.toBuffer()], PROGRAM_ID)[0];

// --- commitments -----------------------------------------------------------

/**
 * Job specs, plans and deliverables are hashed and only the 32-byte digest
 * goes on-chain, so either party can prove after the fact what was agreed
 * without publishing it.
 *
 * The same function must be used in the browser before signing and here before
 * storing, or the stored text will not verify against the committed hash.
 * Normalising line endings and trimming is part of the commitment — a
 * deliverable that differs only in a trailing newline must still verify.
 */
export function commitmentHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function hashToBytes(hex: string): number[] {
  return Array.from(Buffer.from(hex, "hex"));
}

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export const explorerAddress = (address: string) =>
  `https://explorer.solana.com/address/${address}?cluster=devnet`;
