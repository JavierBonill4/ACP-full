// Emits idl/acp.json.
//
// Anchor's own IDL autogeneration runs as a separate subprocess through the
// *system* Rust rather than the SBF-bundled one, and the two compilers have
// contradictory requirements in this toolchain (see README, "Why the toolchain
// is pinned"). v3 solved that with a hand-edited JSON file that went stale
// silently every time an instruction signature changed.
//
// This script is the replacement: the shape is declared once, in one place,
// and the discriminators are computed with Anchor's own algorithm
//
//     instruction: sha256("global:<snake_case_name>")[..8]
//     account:     sha256("account:<PascalCaseStruct>")[..8]
//
// so regenerating is `node scripts/build-idl.mjs` rather than a manual edit.
// It still does not read lib.rs, so it can still drift — but drift is now a
// one-line diff in this file instead of eight magic bytes.
//
//     node scripts/build-idl.mjs [--address <program-id>]

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const argv = process.argv.slice(2);
const addrFlag = argv.indexOf("--address");
const PROGRAM_ID =
  addrFlag !== -1 ? argv[addrFlag + 1] : "ACPv4Wa11etRep11111111111111111111111111111";

const disc = (prefix, name) =>
  Array.from(createHash("sha256").update(`${prefix}:${name}`).digest().subarray(0, 8));

// --- account shorthand -----------------------------------------------------
// s = signer, w = writable, sw = both, "" = read-only
const acc = (name, mode = "") => ({
  name,
  ...(mode.includes("w") ? { writable: true } : {}),
  ...(mode.includes("s") ? { signer: true } : {}),
});

const TOKEN_PROGRAM = { name: "token_program", address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" };
const SYSTEM_PROGRAM = { name: "system_program", address: "11111111111111111111111111111111" };
const RENT = { name: "rent", address: "SysvarRent111111111111111111111111111111111" };

const arg = (name, type) => ({ name, type });
const HASH32 = { array: ["u8", 32] };

// --- instructions ----------------------------------------------------------

const instructions = [
  {
    name: "initialize_oracle",
    accounts: [acc("admin", "sw"), acc("oracle_config", "w"), acc("usdc_mint"), acc("treasury"), SYSTEM_PROGRAM],
    args: [arg("protocol_fee_bps", "u16"), arg("max_enabled_tier", "u8"), arg("threshold", "u8")],
  },
  {
    name: "set_oracle_params",
    accounts: [acc("admin", "s"), acc("oracle_config", "w")],
    args: [
      arg("protocol_fee_bps", "u16"),
      arg("max_enabled_tier", "u8"),
      arg("rate_card_version", "u32"),
      arg("paused", "bool"),
    ],
  },
  {
    name: "add_oracle_signer",
    accounts: [acc("admin", "s"), acc("oracle_config", "w")],
    args: [arg("signer", "pubkey")],
  },
  {
    name: "remove_oracle_signer",
    accounts: [acc("admin", "s"), acc("oracle_config", "w")],
    args: [arg("signer", "pubkey")],
  },
  {
    name: "register_wallet",
    accounts: [acc("wallet", "sw"), acc("wallet_profile", "w"), acc("oracle_config"), SYSTEM_PROGRAM],
    args: [arg("tier", "u8")],
  },
  {
    name: "register_employer",
    accounts: [acc("employer", "sw"), acc("employer_profile", "w"), SYSTEM_PROGRAM],
    args: [],
  },
  {
    name: "post_job",
    accounts: [
      acc("employer", "sw"),
      acc("oracle_config"),
      acc("employer_profile", "w"),
      acc("job", "w"),
      acc("vault", "w"),
      acc("employer_token", "w"),
      acc("usdc_mint"),
      TOKEN_PROGRAM,
      SYSTEM_PROGRAM,
      RENT,
    ],
    args: [{ name: "args", type: { defined: { name: "PostJobArgs" } } }],
  },
  {
    name: "accept_offer",
    accounts: [acc("agent", "s"), acc("job", "w"), acc("wallet_profile", "w")],
    args: [],
  },
  {
    name: "claim_job",
    accounts: [
      acc("agent", "sw"),
      acc("oracle_config"),
      acc("job", "w"),
      acc("wallet_profile", "w"),
      acc("bond_vault", "w"),
      acc("agent_token", "w"),
      acc("usdc_mint"),
      TOKEN_PROGRAM,
      SYSTEM_PROGRAM,
      RENT,
    ],
    args: [],
  },
  {
    name: "submit_plan",
    accounts: [acc("agent", "s"), acc("job", "w")],
    args: [arg("plan_hash", HASH32), arg("planning_fee", "u64"), arg("fixed_fee", "u64")],
  },
  {
    name: "report_usage",
    accounts: [acc("oracle_signer", "s"), acc("oracle_config"), acc("job", "w")],
    args: [arg("phase", "u8"), arg("amount", "u64")],
  },
  {
    name: "accept_plan",
    accounts: [acc("employer", "s"), acc("job", "w")],
    args: [],
  },
  {
    name: "auto_accept_plan",
    accounts: [acc("cranker", "s"), acc("job", "w"), acc("employer_profile", "w")],
    args: [],
  },
  {
    name: "submit_deliverable",
    accounts: [acc("agent", "s"), acc("job", "w")],
    args: [arg("deliverable_hash", HASH32), arg("usage_root", HASH32)],
  },
  // Every terminal transition shares the Finalize context.
  { name: "reject_plan", finalize: true, args: [] },
  { name: "accept_deliverable", finalize: true, args: [arg("rating", "u8")] },
  { name: "reject_deliverable", finalize: true, args: [] },
  { name: "auto_accept", finalize: true, args: [] },
  { name: "expire_job", finalize: true, args: [] },
  { name: "cancel_job", finalize: true, args: [] },
  {
    name: "release_holdback",
    accounts: [acc("cranker", "s"), acc("job", "w"), acc("vault", "w"), acc("agent_token", "w"), TOKEN_PROGRAM],
    args: [],
  },
  {
    name: "claw_back_holdback",
    accounts: [
      acc("oracle_signer", "s"),
      acc("oracle_config"),
      acc("job", "w"),
      acc("vault", "w"),
      acc("wallet_profile", "w"),
      acc("employer_token", "w"),
      TOKEN_PROGRAM,
    ],
    args: [],
  },
];

const FINALIZE_ACCOUNTS = [
  acc("actor", "s"),
  acc("oracle_config"),
  acc("job", "w"),
  acc("vault", "w"),
  acc("bond_vault", "w"),
  acc("employer_profile", "w"),
  acc("wallet_profile", "w"),
  acc("employer_token", "w"),
  acc("agent_token", "w"),
  acc("treasury_token", "w"),
  TOKEN_PROGRAM,
];

// --- account structs -------------------------------------------------------

const field = (name, type) => ({ name, type });

const accountTypes = {
  OracleConfig: [
    field("admin", "pubkey"),
    field("treasury", "pubkey"),
    field("usdc_mint", "pubkey"),
    field("signers", { vec: "pubkey" }),
    field("threshold", "u8"),
    field("protocol_fee_bps", "u16"),
    field("rate_card_version", "u32"),
    field("max_enabled_tier", "u8"),
    field("paused", "bool"),
    field("bump", "u8"),
  ],
  WalletProfile: [
    field("wallet", "pubkey"),
    field("wrs", "u64"),
    field("jobs_completed", "u64"),
    field("jobs_rejected", "u64"),
    field("jobs_expired", "u64"),
    field("total_value_settled", "u64"),
    field("first_seen", "i64"),
    field("tier", "u8"),
    field("active_claims", "u16"),
    field("bump", "u8"),
  ],
  EmployerProfile: [
    field("employer", "pubkey"),
    field("jobs_posted", "u64"),
    field("jobs_rejected", "u64"),
    field("jobs_auto_accepted", "u64"),
    field("total_value_escrowed", "u64"),
    field("first_seen", "i64"),
    field("next_nonce", "u64"),
    field("bump", "u8"),
  ],
  Job: [
    field("employer", "pubkey"),
    field("agent", "pubkey"),
    field("nonce", "u64"),
    field("job_type", "u8"),
    field("state", "u8"),
    field("min_tier", "u8"),
    field("claimed_tier", "u8"),
    field("planning_fee_cap", "u64"),
    field("fixed_fee_cap", "u64"),
    field("planning_token_cap", "u64"),
    field("token_budget_cap", "u64"),
    field("planning_fee", "u64"),
    field("fixed_fee", "u64"),
    field("bond", "u64"),
    field("planning_tokens_used", "u64"),
    field("execution_tokens_used", "u64"),
    field("spec_hash", HASH32),
    field("plan_hash", HASH32),
    field("deliverable_hash", HASH32),
    field("usage_root", HASH32),
    field("created_at", "i64"),
    field("offer_expires_at", "i64"),
    field("claim_expires_at", "i64"),
    field("review_expires_at", "i64"),
    field("deadline", "i64"),
    field("holdback_until", "i64"),
    field("rate_card_version", "u32"),
    field("rating", "u8"),
    field("auto_accepted", "bool"),
    field("holdback_amount", "u64"),
    field("bump", "u8"),
    field("vault_bump", "u8"),
    field("bond_bump", "u8"),
  ],
};

const events = {
  JobPosted: [
    field("job", "pubkey"),
    field("employer", "pubkey"),
    field("agent", "pubkey"),
    field("job_type", "u8"),
    field("escrow_total", "u64"),
    field("min_tier", "u8"),
    field("deadline", "i64"),
  ],
  JobClaimed: [field("job", "pubkey"), field("agent", "pubkey"), field("tier", "u8"), field("bond", "u64")],
  PlanSubmitted: [
    field("job", "pubkey"),
    field("planning_fee", "u64"),
    field("fixed_fee", "u64"),
    field("review_expires_at", "i64"),
  ],
  PlanAccepted: [field("job", "pubkey"), field("deadline", "i64")],
  DeliverableSubmitted: [field("job", "pubkey"), field("review_expires_at", "i64")],
  UsageReported: [field("job", "pubkey"), field("phase", "u8"), field("amount", "u64")],
  JobSettled: [
    field("job", "pubkey"),
    field("outcome", "u8"),
    field("agent_immediate", "u64"),
    field("agent_holdback", "u64"),
    field("protocol_fee", "u64"),
    field("employer_refund", "u64"),
    field("bond_slashed", "bool"),
    field("rating", "u8"),
  ],
  HoldbackReleased: [field("job", "pubkey"), field("amount", "u64")],
  HoldbackClawedBack: [field("job", "pubkey"), field("amount", "u64")],
};

const PostJobArgs = [
  field("nonce", "u64"),
  field("job_type", "u8"),
  field("agent", { option: "pubkey" }),
  field("spec_hash", HASH32),
  field("planning_fee_cap", "u64"),
  field("fixed_fee_cap", "u64"),
  field("planning_token_cap", "u64"),
  field("token_budget_cap", "u64"),
  field("min_tier", "u8"),
  field("deadline", "i64"),
];

// Order must match errors.rs exactly — Anchor numbers them from 6000 by
// declaration order, so inserting a variant anywhere but the end renumbers
// every error after it.
const ERRORS = [
  ["Paused", "Protocol is paused"],
  ["NotAdmin", "Signer is not the oracle admin"],
  ["NotOracleSigner", "Signer is not a whitelisted oracle signer"],
  ["SignerListFull", "Oracle signer list is full"],
  ["FeeTooHigh", "Protocol fee exceeds the maximum"],
  ["BadState", "Job is not in a state that allows this action"],
  ["NotEmployer", "Caller is not the employer for this job"],
  ["NotAgent", "Caller is not the agent for this job"],
  ["WrongAgent", "This job was offered to a different agent"],
  ["TierTooLow", "Agent tier is below the job's minimum tier"],
  ["TierNotEnabled", "Tier is not enabled in this deployment"],
  ["ValueCapExceeded", "Job value exceeds this tier's cap"],
  ["ClaimLimitReached", "Wallet has reached its concurrent claim limit"],
  ["BadDeadline", "Deadline is in the past or beyond the maximum horizon"],
  ["NotExpired", "Timer has not expired yet"],
  ["AlreadyExpired", "Timer has already expired"],
  ["HoldbackPending", "Holdback window has not closed"],
  ["NoHoldback", "There is no holdback on this job"],
  ["FeeCapExceeded", "Proposed fee exceeds the employer's funded ceiling"],
  ["UsageCapExceeded", "Reported usage exceeds the phase cap"],
  ["BadRating", "Rating must be between 0 and 10"],
  ["ZeroEscrow", "Escrow amounts must be non-zero"],
  ["WrongMint", "Token account mint does not match the configured USDC mint"],
  ["WrongTokenOwner", "Token account owner does not match the expected party"],
  ["Overflow", "Arithmetic overflow"],
];

// --- assemble --------------------------------------------------------------

const idl = {
  address: PROGRAM_ID,
  metadata: { name: "acp", version: "0.4.0", spec: "0.1.0", description: "Agentic Commerce Protocol v4" },
  instructions: instructions.map((ix) => ({
    name: ix.name,
    discriminator: disc("global", ix.name),
    accounts: ix.finalize ? FINALIZE_ACCOUNTS : ix.accounts,
    args: ix.args,
  })),
  accounts: Object.keys(accountTypes).map((name) => ({ name, discriminator: disc("account", name) })),
  events: Object.keys(events).map((name) => ({ name, discriminator: disc("event", name) })),
  errors: ERRORS.map(([name, msg], i) => ({ code: 6000 + i, name, msg })),
  types: [
    ...Object.entries(accountTypes).map(([name, fields]) => ({
      name,
      type: { kind: "struct", fields },
    })),
    ...Object.entries(events).map(([name, fields]) => ({
      name,
      type: { kind: "struct", fields },
    })),
    { name: "PostJobArgs", type: { kind: "struct", fields: PostJobArgs } },
  ],
};

// --- sanity checks ---------------------------------------------------------

const seen = new Map();
let collisions = 0;
for (const ix of idl.instructions) {
  const key = ix.discriminator.join(",");
  if (seen.has(key)) {
    console.error(`  discriminator collision: ${ix.name} vs ${seen.get(key)}`);
    collisions++;
  }
  seen.set(key, ix.name);
}
for (const a of [...idl.accounts, ...idl.events]) {
  const key = a.discriminator.join(",");
  if (seen.has(key)) {
    console.error(`  discriminator collision: ${a.name} vs ${seen.get(key)}`);
    collisions++;
  }
  seen.set(key, a.name);
}
if (collisions > 0) process.exit(1);

const declaredTypes = new Set(idl.types.map((t) => t.name));
for (const ix of idl.instructions) {
  for (const a of ix.args) {
    const d = a.type?.defined?.name;
    if (d && !declaredTypes.has(d)) {
      console.error(`  ${ix.name} references undeclared type ${d}`);
      process.exit(1);
    }
  }
}

mkdirSync(resolve(ROOT, "idl"), { recursive: true });
const out = resolve(ROOT, "idl", "acp.json");
writeFileSync(out, JSON.stringify(idl, null, 2) + "\n");

console.log(`  wrote ${out}`);
console.log(`  address           ${PROGRAM_ID}`);
console.log(`  instructions      ${idl.instructions.length}`);
console.log(`  accounts          ${idl.accounts.length}`);
console.log(`  events            ${idl.events.length}`);
console.log(`  errors            ${idl.errors.length}`);
console.log(`  no discriminator collisions`);
