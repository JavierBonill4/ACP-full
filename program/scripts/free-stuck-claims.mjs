// Finds every on-chain job claimed by an agent wallet and, for the ones whose
// timer has genuinely blown, sends the real `expire_job` (or `auto_accept`
// for a stale review window) transaction that frees the claim slot.
//
//     cd program
//     node scripts/free-stuck-claims.mjs [--agent <pubkey>] [--dry-run]
//
// Why this exists: `WalletProfile.active_claims` only ever decrements inside
// `finalize` (lib.rs), which every terminal transition routes through.
// `expire_job` and `auto_accept` are both permissionless — the design intent
// is a crank calls them automatically once a timer blows. Nothing in this
// repo's off-chain crank actually does that (see PATCHES-6.md's note on the
// gap), so an abandoned job just sits there holding a claim slot forever.
// Since `npm run t1`/`npm run t2` share one operator wallet by design
// (register.ts), testing both tiers against the same wallet burns through
// `claim_limit()` fast. This is the manual version of the crank step that's
// missing — nothing it does isn't already permitted by the program itself.
//
// Defaults to your own wallet (same default as e2e-onchain-job.mjs). Pass
// --dry-run to see what it would do without sending anything.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";

const { AnchorProvider, Program, BN } = anchor;

function envOr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  Missing ${name}. Copy program/.env.example to program/.env and fill it in.\n`);
    process.exit(1);
  }
  return v;
}
function expand(p) {
  return p.replace(/^~/, homedir());
}
function loadKeypair(envVar, fallback) {
  const path = resolve(expand(envOr(envVar, fallback)));
  const secret = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const agentFlag = argv.indexOf("--agent");

const RPC_URL = envOr("SOLANA_RPC_URL", "https://api.devnet.solana.com");
const PROGRAM_ID = new PublicKey(requireEnv("ACP_PROGRAM_ID"));
const USDC_MINT = new PublicKey(requireEnv("USDC_MINT"));
const TREASURY = new PublicKey(requireEnv("TREASURY_ADDRESS"));

const employer = loadKeypair("EMPLOYER_KEYPAIR_PATH", "~/.config/solana/id.json");
const agentPubkey =
  agentFlag !== -1 ? new PublicKey(argv[agentFlag + 1]) : employer.publicKey;

const idlPath = resolve(new URL("../idl/acp.json", import.meta.url).pathname);
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
const provider = new AnchorProvider(connection, new anchor.Wallet(employer), { commitment: "confirmed" });
anchor.setProvider(provider);

let program;
try {
  program = new Program(idl, provider);
} catch {
  program = new Program(idl, PROGRAM_ID, provider);
}

const enc = (s) => Buffer.from(s, "utf8");
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const oracleConfigPda = pda([enc("oracle")]);
const walletProfilePda = (w) => pda([enc("wallet"), w.toBuffer()]);
const employerProfilePda = (e) => pda([enc("employer"), e.toBuffer()]);
const vaultPda = (job) => pda([enc("vault"), job.toBuffer()]);
const bondVaultPda = (job) => pda([enc("bond"), job.toBuffer()]);

const STATE_NAME = ["OPEN", "OFFERED", "CLAIMED", "PLAN_PENDING", "IN_PROGRESS", "REVIEW_PENDING", "SETTLED", "EXPIRED", "CANCELLED"];

/** Mirrors expire_job's own `blown` match in lib.rs exactly. */
function expireBlown(job, nowSec) {
  switch (job.state) {
    case 1: // OFFERED
      return job.offerExpiresAt.toNumber() !== 0 && nowSec > job.offerExpiresAt.toNumber();
    case 2: // CLAIMED
      return job.claimExpiresAt.toNumber() !== 0 && nowSec > job.claimExpiresAt.toNumber();
    case 4: // IN_PROGRESS
    case 0: // OPEN
      return nowSec > job.deadline.toNumber();
    default:
      return false;
  }
}
/** auto_accept only fires from REVIEW_PENDING once its window has closed. */
function autoAcceptBlown(job, nowSec) {
  return job.state === 5 && job.reviewExpiresAt.toNumber() !== 0 && nowSec > job.reviewExpiresAt.toNumber();
}

async function finalizeAccountsFor(job, jobPubkey) {
  const employerToken = await getAssociatedTokenAddress(USDC_MINT, job.employer);
  const agentToken = await getAssociatedTokenAddress(USDC_MINT, job.agent);
  const treasuryToken = await getAssociatedTokenAddress(USDC_MINT, TREASURY);
  return {
    actor: employer.publicKey,
    oracleConfig: oracleConfigPda,
    job: jobPubkey,
    vault: vaultPda(jobPubkey),
    bondVault: bondVaultPda(jobPubkey),
    employerProfile: employerProfilePda(job.employer),
    walletProfile: walletProfilePda(job.agent),
    employerToken,
    agentToken,
    treasuryToken,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

async function main() {
  console.log(`  program   ${PROGRAM_ID.toBase58()}`);
  console.log(`  agent     ${agentPubkey.toBase58()}`);
  console.log(`  actor     ${employer.publicKey.toBase58()}  (sends the recovery transactions)`);
  if (DRY_RUN) console.log(`  mode      DRY RUN — nothing will be sent\n`);
  else console.log("");

  // Job.agent sits right after the 8-byte discriminator + 32-byte employer.
  const AGENT_FIELD_OFFSET = 8 + 32;
  const jobs = await program.account.job.all([
    { memcmp: { offset: AGENT_FIELD_OFFSET, bytes: agentPubkey.toBase58() } },
  ]);

  const nowSec = Math.floor(Date.now() / 1000);
  const stuck = jobs.filter(({ account }) => account.state < 6); // < SETTLED

  console.log(`  found ${jobs.length} job(s) for this agent, ${stuck.length} not yet terminal\n`);

  if (stuck.length === 0) {
    console.log("  Nothing to free. If AcceptOffer is still hitting ClaimLimitReached, the stuck");
    console.log("  job(s) may belong to a *different* wallet than the one you passed — pass");
    console.log("  --agent <pubkey> to check another, or the wallet's claim_limit() may simply");
    console.log("  be lower than you expect (see claim_limit() in state.rs).\n");
    return;
  }

  for (const { publicKey: jobPubkey, account: job } of stuck) {
    const state = STATE_NAME[job.state] ?? `?(${job.state})`;
    const canExpire = expireBlown(job, nowSec);
    const canAutoAccept = autoAcceptBlown(job, nowSec);

    console.log(`  ${jobPubkey.toBase58()}  ${state}`);

    if (!canExpire && !canAutoAccept) {
      console.log(`    not yet eligible — its timer hasn't blown yet. Leaving it alone.\n`);
      continue;
    }

    const accounts = await finalizeAccountsFor(job, jobPubkey);
    const action = canExpire ? "expire_job" : "auto_accept";
    console.log(`    timer blown — sending ${action}${DRY_RUN ? " (dry run, not actually sending)" : ""}`);

    if (DRY_RUN) {
      console.log("");
      continue;
    }

    try {
      const sig = await program.methods[canExpire ? "expireJob" : "autoAccept"]()
        .accounts(accounts)
        .rpc();
      console.log(`    done — ${sig}\n`);
    } catch (e) {
      console.log(`    failed: ${e.message ?? e}\n`);
    }
  }
}

main().catch((e) => {
  console.error(`\n  ${e.message ?? e}\n`);
  process.exit(1);
});
