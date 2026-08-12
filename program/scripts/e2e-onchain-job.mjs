// Proves the on-chain lifecycle end to end with real signed transactions, and
// prints the balance deltas so "the employer actually loses money" is
// something you can see rather than take on faith.
//
//     cd program
//     npm run e2e
//
// Why this exists rather than wiring the browser directly: settlement
// (`finalize` in lib.rs) reads its payout numbers — job.planning_fee,
// job.fixed_fee, job.claimed_tier, job.*_tokens_used — straight off the
// on-chain Job account. Only real claim_job/submit_plan/report_usage calls
// populate those. Fund escrow and settle without them and the transaction
// succeeds but pays out against zeros — almost a full refund, not a
// completion. This script runs the whole chain that makes settlement mean
// something, in one place, before any of it is wired into a UI you'd have to
// debug through a wallet popup.
//
// Every role defaults to the SAME local keypair (employer, agent, oracle
// admin) so a first run needs nothing beyond what you already have: a
// deployed program and a wallet with devnet SOL and USDC. Point the env vars
// at separate keypairs once you want to test with distinct parties.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";

const { AnchorProvider, Program } = anchor;

// --- env ---------------------------------------------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  Missing ${name}. Copy program/.env.example to program/.env and fill it in.\n`);
    process.exit(1);
  }
  return v;
}

/**
 * `process.env.X ?? fallback` does NOT fall back on an empty string — `.env`
 * commonly has blank placeholder lines like `AGENT_KEYPAIR_PATH=`, and those
 * are `""`, not `undefined`. Treat blank the same as unset everywhere below.
 */
function envOr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}

const RPC_URL = envOr("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const PROGRAM_ID = new PublicKey(requireEnv("ACP_PROGRAM_ID"));
const USDC_MINT = new PublicKey(requireEnv("USDC_MINT"));
const TREASURY = new PublicKey(requireEnv("TREASURY_ADDRESS"));

function expand(path) {
  return path.replace(/^~/, homedir());
}

function loadKeypair(envVar, fallback) {
  const path = resolve(expand(envOr(envVar, fallback)));
  const secret = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const DEFAULT_KEYPAIR = "~/.config/solana/id.json";
const employer = loadKeypair("EMPLOYER_KEYPAIR_PATH", DEFAULT_KEYPAIR);
// Defaults to the employer's key. This is the SAME wallet `npm run register`
// used as OPERATOR_KEYPAIR in the agent package — that is not a coincidence,
// it is required: register_wallet's seeds are ["wallet", wallet.pubkey], and
// that pubkey has to match Agent.walletAddress in the backend DB for the
// reputation record to mean anything once the UI is wired up later.
const agent = loadKeypair("AGENT_KEYPAIR_PATH", envOr("EMPLOYER_KEYPAIR_PATH", DEFAULT_KEYPAIR));
// Defaults to whoever deployed the program (auto-whitelisted as a signer at
// initialize_oracle). Point this at a different keypair only after calling
// add_oracle_signer for it.
const oracle = loadKeypair("ORACLE_KEYPAIR_PATH", envOr("EMPLOYER_KEYPAIR_PATH", DEFAULT_KEYPAIR));

// --- setup ---------------------------------------------------------------

const idlPath = resolve(new URL("../idl/acp.json", import.meta.url).pathname);
let idl;
try {
  idl = JSON.parse(readFileSync(idlPath, "utf8"));
} catch {
  console.error(
    `\n  Could not read ${idlPath}.\n` +
      `  Run \`node scripts/build-idl.mjs --address ${PROGRAM_ID.toBase58()}\` first.\n`
  );
  process.exit(1);
}
if (idl.instructions.length === 0) {
  console.error("\n  idl/acp.json is the empty placeholder. Regenerate it with build-idl.mjs.\n");
  process.exit(1);
}

const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
const provider = new AnchorProvider(connection, new anchor.Wallet(employer), {
  commitment: "confirmed",
});
anchor.setProvider(provider);

// Anchor's Program constructor changed shape across 0.29→0.30 minor releases
// — some read the address from idl.address with a 2-arg call, some still want
// it passed explicitly as a 3-arg call. idl/acp.json carries `address`
// either way (see build-idl.mjs), so try the modern form first and fall back
// rather than guessing which your installed version wants.
let program;
try {
  program = new Program(idl, provider);
} catch {
  program = new Program(idl, PROGRAM_ID, provider);
}

const enc = (s) => Buffer.from(s, "utf8");
const sha256Bytes = (s) => Array.from(createHash("sha256").update(s).digest());
const usdc = (n) => new BN(Math.round(n * 1_000_000));
const fmtUsdc = (base) => (Number(base.toString()) / 1_000_000).toFixed(6);

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const oracleConfigPda = pda([enc("oracle")]);
const walletProfilePda = (w) => pda([enc("wallet"), w.toBuffer()]);
const employerProfilePda = (e) => pda([enc("employer"), e.toBuffer()]);
const jobPda = (e, nonce) => pda([enc("job"), e.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
const vaultPda = (job) => pda([enc("vault"), job.toBuffer()]);
const bondVaultPda = (job) => pda([enc("bond"), job.toBuffer()]);

async function airdropIfLow(pubkey, label, minSol = 0.3) {
  const bal = await connection.getBalance(pubkey);
  if (bal < minSol * LAMPORTS_PER_SOL) {
    console.log(`  airdropping SOL to ${label} (${pubkey.toBase58()})`);
    const sig = await connection.requestAirdrop(pubkey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

async function balance(owner) {
  const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
  try {
    const acc = await getAccount(connection, ata);
    return acc.amount;
  } catch {
    return 0n;
  }
}

function step(label) {
  console.log(`\n→ ${label}`);
}

// --- run -------------------------------------------------------------------

async function main() {
  console.log(`  program   ${PROGRAM_ID.toBase58()}`);
  console.log(`  employer  ${employer.publicKey.toBase58()}`);
  console.log(`  agent     ${agent.publicKey.toBase58()}${agent.publicKey.equals(employer.publicKey) ? "  (same as employer)" : ""}`);
  console.log(`  oracle    ${oracle.publicKey.toBase58()}${oracle.publicKey.equals(employer.publicKey) ? "  (same as employer)" : ""}`);

  step("airdrop check");
  await airdropIfLow(employer.publicKey, "employer");
  if (!agent.publicKey.equals(employer.publicKey)) await airdropIfLow(agent.publicKey, "agent");
  if (!oracle.publicKey.equals(employer.publicKey)) await airdropIfLow(oracle.publicKey, "oracle", 0.05);

  step("resolve token accounts");
  const employerAta = await getAssociatedTokenAddress(USDC_MINT, employer.publicKey);
  const agentAta = await getAssociatedTokenAddress(USDC_MINT, agent.publicKey);
  const treasuryAta = await getAssociatedTokenAddress(USDC_MINT, TREASURY);

  // accept_deliverable's Finalize takes employerToken/agentToken/treasuryToken
  // as plain `mut` accounts, not `init_if_needed` — all three ATAs must
  // already exist before this script runs, or the on-chain call fails deep
  // inside settlement instead of here with a clear fix.
  const required = [
    { owner: employer.publicKey, ata: employerAta, label: "employer" },
    { owner: agent.publicKey, ata: agentAta, label: "agent" },
    { owner: TREASURY, ata: treasuryAta, label: "treasury" },
  ];
  const missing = [];
  for (const r of required) {
    try {
      await getAccount(connection, r.ata);
    } catch {
      missing.push(r);
    }
  }
  if (missing.length > 0) {
    console.error(`\n  Missing USDC token account(s) for mint ${USDC_MINT.toBase58()}:\n`);
    for (const m of missing) {
      console.error(`    ${m.label} (owner ${m.owner.toBase58()})`);
      console.error(`      spl-token create-account ${USDC_MINT.toBase58()} --owner ${m.owner.toBase58()}\n`);
    }
    process.exit(1);
  }

  const before = await balance(employer.publicKey);

  // -- oracle config, idempotent --------------------------------------------
  step("oracle config");
  const cfgInfo = await connection.getAccountInfo(oracleConfigPda);
  if (!cfgInfo) {
    await program.methods
      .initializeOracle(100, 2, 1) // 1% fee, T2 ceiling, threshold 1
      .accounts({
        admin: employer.publicKey,
        oracleConfig: oracleConfigPda,
        usdcMint: USDC_MINT,
        treasury: TREASURY,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  initialized (this wallet is now admin + the sole oracle signer)");
  } else {
    console.log("  already initialized");
  }

  // -- profiles, idempotent --------------------------------------------------
  step("register_employer");
  const employerProfile = employerProfilePda(employer.publicKey);
  await program.methods
    .registerEmployer()
    .accounts({ employer: employer.publicKey, employerProfile, systemProgram: SystemProgram.programId })
    .rpc();

  step("register_wallet (agent, tier 2)");
  const agentProfile = walletProfilePda(agent.publicKey);
  await program.methods
    .registerWallet(2)
    .accounts({
      wallet: agent.publicKey,
      walletProfile: agentProfile,
      oracleConfig: oracleConfigPda,
      systemProgram: SystemProgram.programId,
    })
    .signers(agent.publicKey.equals(employer.publicKey) ? [] : [agent])
    .rpc();

  // -- post + fund escrow ------------------------------------------------
  step("post_job (direct hire, funds escrow)");
  const empAcc = await program.account.employerProfile.fetch(employerProfile);
  const nonce = empAcc.nextNonce;
  const job = jobPda(employer.publicKey, nonce);
  const vault = vaultPda(job);

  const caps = {
    planningFeeCap: usdc(0.5),
    fixedFeeCap: usdc(5),
    planningTokenCap: usdc(1),
    tokenBudgetCap: usdc(10),
  };
  const escrowTotal = Object.values(caps).reduce((a, b) => a.add(b), new BN(0));

  await program.methods
    .postJob({
      nonce,
      jobType: 1, // Direct
      agent: agent.publicKey,
      specHash: sha256Bytes("e2e demo spec: research and summarize a topic"),
      ...caps,
      minTier: 2,
      deadline: new BN(Math.floor(Date.now() / 1000) + 86_400),
    })
    .accounts({
      employer: employer.publicKey,
      oracleConfig: oracleConfigPda,
      employerProfile,
      job,
      vault,
      employerToken: employerAta,
      usdcMint: USDC_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();
  console.log(`  job        ${job.toBase58()}`);
  console.log(`  escrowed   ${fmtUsdc(escrowTotal)} USDC (this left your wallet just now)`);

  // -- agent side: accept, plan, deliver --------------------------------
  step("accept_offer");
  await program.methods
    .acceptOffer()
    .accounts({ agent: agent.publicKey, job, walletProfile: agentProfile })
    .signers(agent.publicKey.equals(employer.publicKey) ? [] : [agent])
    .rpc();

  step("submit_plan");
  const planningFee = usdc(0.5);
  const fixedFee = usdc(5);
  await program.methods
    .submitPlan(sha256Bytes("e2e demo plan"), planningFee, fixedFee)
    .accounts({ agent: agent.publicKey, job })
    .signers(agent.publicKey.equals(employer.publicKey) ? [] : [agent])
    .rpc();

  step("report_usage (execution phase, 6 USDC of real token cost)");
  await program.methods
    .reportUsage(1, usdc(6))
    .accounts({ oracleSigner: oracle.publicKey, oracleConfig: oracleConfigPda, job })
    .signers(oracle.publicKey.equals(employer.publicKey) ? [] : [oracle])
    .rpc();

  step("accept_plan");
  await program.methods
    .acceptPlan()
    .accounts({ employer: employer.publicKey, job })
    .rpc();

  step("submit_deliverable");
  await program.methods
    .submitDeliverable(sha256Bytes("e2e demo deliverable"), new Array(32).fill(0))
    .accounts({ agent: agent.publicKey, job })
    .signers(agent.publicKey.equals(employer.publicKey) ? [] : [agent])
    .rpc();

  // -- settle --------------------------------------------------------------
  step("accept_deliverable (rating 9) — this is the payout");
  await program.methods
    .acceptDeliverable(9)
    .accounts({
      actor: employer.publicKey,
      oracleConfig: oracleConfigPda,
      job,
      vault,
      bondVault: bondVaultPda(job), // never initialized: direct hires post no bond, and
      // Finalize only touches this account when job.bond > 0, so an
      // uninitialized address here is fine — it's simply never read.
      employerProfile,
      walletProfile: agentProfile,
      employerToken: employerAta,
      agentToken: agentAta,
      treasuryToken: treasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // -- results ---------------------------------------------------------------
  const after = await balance(employer.publicKey);
  const agentBal = await balance(agent.publicKey);
  const treasuryBal = await balance(TREASURY);
  const jobAcc = await program.account.job.fetch(job);
  const profileAcc = await program.account.walletProfile.fetch(agentProfile);
  const sameWallet = agent.publicKey.equals(employer.publicKey);

  console.log("\n" + "─".repeat(60));
  console.log("  SETTLED");
  console.log("─".repeat(60));
  console.log(`  employer balance   ${fmtUsdc(before)} → ${fmtUsdc(after)} USDC  (${fmtUsdc(after - before)})`);
  console.log(`  agent balance      ${fmtUsdc(agentBal)} USDC`);
  console.log(`  treasury balance   ${fmtUsdc(treasuryBal)} USDC (the protocol fee cut, the only USDC that left this ecosystem)`);
  console.log(`  job state          ${["OPEN", "OFFERED", "CLAIMED", "PLAN_PENDING", "IN_PROGRESS", "REVIEW_PENDING", "SETTLED", "EXPIRED", "CANCELLED"][jobAcc.state]}`);
  console.log(`  rating recorded    ${jobAcc.rating}/10`);
  console.log(`  agent WRS          ${(Number(profileAcc.wrs.toString()) / 1_000_000).toFixed(2)}`);

  if (sameWallet) {
    // Employer and agent are the same keypair by default (see the header
    // comment). Both the agent's payout and the employer's unused-cap refund
    // land in that one wallet's own USDC account, so almost all of the 16.5
    // escrowed comes right back — only the treasury's cut ever actually
    // leaves. That's correct, not a shortfall: a *distinct* agent wallet
    // would instead see the ~11.445 payout land somewhere else, and the
    // employer would show the full ~11.5 loss.
    console.log(
      `\n  Expected (employer == agent here): escrow (16.5) minus employer's\n` +
        `  own payout (11.445) minus refund (5.0) leaves the treasury's 1%-of-\n` +
        `  fee cut (0.055) as the only USDC that actually left this wallet.\n` +
        `  Re-run with AGENT_KEYPAIR_PATH pointed at a separate keypair to see\n` +
        `  the full employer-loses-~11.5 / agent-gains-~11.445 split instead.\n` +
        `  If the numbers above line up, the mechanics are sound.\n`
    );
  } else {
    console.log(
      `\n  Expected: agent receives 6 tokens + 5.5 fees, minus 1% of the FEE\n` +
        `  portion only (0.055) — ~11.445 USDC. Employer funded 16.5, gets 5.0\n` +
        `  back (1 unused planning-token cap + 4 unused execution budget — both\n` +
        `  fees were bid at their full ceiling, so neither refunds), netting a\n` +
        `  real loss of 11.5 USDC. If those numbers line up, the mechanics are\n` +
        `  sound.\n`
    );
  }
}

main().catch((err) => {
  // `err.message ?? err` doesn't fall back on an empty string either — the
  // same trap fixed above in envOr(). Solana RPC errors in particular often
  // carry a populated `.toString()`/`.cause` but an empty top-level
  // `.message`, which is why this was printing "failed:" and nothing after.
  const detail =
    (err && err.message && err.message.length > 0 && err.message) ||
    (err && err.cause && String(err.cause)) ||
    (err && err.toString && err.toString()) ||
    String(err);
  console.error("\n  failed:", detail);
  if (err?.name) console.error("  name:", err.name);
  if (err?.code !== undefined) console.error("  code:", err.code);
  if (err?.logs) console.error("  logs:\n" + err.logs.join("\n"));
  if (err?.stack) console.error("\n" + err.stack);
  process.exit(1);
});