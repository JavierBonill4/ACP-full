import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { connection, oracleConfigPda, oracleKeypair, PROGRAM_ID } from "./chain.js";

/**
 * The oracle's own on-chain signing — `report_usage` only. Every other
 * on-chain action in this app is signed client-side by whoever holds the
 * relevant wallet (chainVerify.ts's header explains why); the oracle is the
 * one exception, because "the platform meters and reports token usage" is
 * the entire point of the T2 trust model, and that requires the platform to
 * hold a key and actually sign something with it.
 *
 * This did not previously exist. `oracleKeypair` was loaded in chain.ts and
 * exported, but nothing ever called `.rpc()` with it — every route in
 * routes/oracle.ts and services/usage.ts only ever wrote to Postgres. That
 * meant the on-chain Job account's `planning_tokens_used` /
 * `execution_tokens_used` sat at 0 forever, so `settle()` always computed
 * `tokens_earned = 0` for the agent and refunded that money to the employer
 * instead — the exact bug this file fixes.
 */

const { AnchorProvider, Program } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const oracleChainEnabled = Boolean(oracleKeypair);

let cachedProgram: anchor.Program | null = null;

function program(): anchor.Program {
  if (!oracleKeypair) {
    throw new Error(
      "ORACLE_SECRET_KEY is not configured; usage cannot be reported on-chain."
    );
  }
  if (cachedProgram) return cachedProgram;

  const provider = new AnchorProvider(connection, new anchor.Wallet(oracleKeypair), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(readFileSync(resolve(__dirname, "./idl.json"), "utf8"));

  // Same Anchor 0.29→0.30 Program-constructor fallback used everywhere else
  // this IDL gets loaded (research-agent/src/chain.ts, frontend/lib/anchor.ts,
  // program/scripts/e2e-onchain-job.mjs) — proven at runtime, not statically
  // typeable across both constructor shapes at once.
  let p: anchor.Program;
  try {
    p = new Program(idl, provider);
  } catch {
    p = new (Program as any)(idl, PROGRAM_ID, provider);
  }
  cachedProgram = p;
  return p;
}

/**
 * Reports the phase's running cumulative total, exactly as
 * `services/usage.ts`'s `recordUsage` computed it. `report_usage` assigns
 * (`job.planning_tokens_used = amount`), it does not add — passing anything
 * other than the new running total would desync the on-chain figure from
 * the off-chain one this is supposed to mirror.
 */
export async function reportUsageOnChain(
  jobPda: string,
  phase: 0 | 1,
  amount: bigint
): Promise<{ signature: string }> {
  const p = program();
  // `p.methods` is only known at runtime from the loaded IDL — an untyped
  // `Idl` gives it an index signature, and `noUncheckedIndexedAccess`
  // (backend/tsconfig.json) correctly-but-unhelpfully treats every property
  // on that as possibly undefined. `as any` here is the same escape hatch
  // research-agent/src/chain.ts uses for the identical situation — this one
  // isn't cosmetic, though: left as `p.methods.reportUsage`, tsc exits 2 and
  // Railway's build fails outright (confirmed — this is what broke it).
  const methods = p.methods as any;
  const signature = await methods
    .reportUsage(phase, new anchor.BN(amount.toString()))
    .accounts({
      oracleSigner: oracleKeypair!.publicKey,
      oracleConfig: oracleConfigPda(),
      job: new PublicKey(jobPda),
    })
    .rpc();
  return { signature };
}