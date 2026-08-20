// One-off: converts a Solana CLI JSON keypair file (a byte array, what
// `solana-keygen new` writes and what SOLANA_KEYPAIR_PATH/EMPLOYER_KEYPAIR_PATH
// etc. point at everywhere else in this repo) to the base58 string
// backend/.env's ORACLE_SECRET_KEY expects (chain.ts:
// `Keypair.fromSecretKey(bs58.decode(env.ORACLE_SECRET_KEY))`).
//
// Usage:
//   node scripts/export-secret-key.mjs ~/.config/solana/id.json
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/export-secret-key.mjs <path-to-keypair.json>");
  process.exit(1);
}

const secret = JSON.parse(readFileSync(resolve(path.replace(/^~/, homedir())), "utf8"));
const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
const base58 = anchor.utils.bytes.bs58.encode(keypair.secretKey);

console.log(`pubkey: ${keypair.publicKey.toBase58()}`);
console.log(`base58 secret (put this in ORACLE_SECRET_KEY): ${base58}`);