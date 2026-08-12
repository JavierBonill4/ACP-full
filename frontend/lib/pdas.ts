import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import { getProgramId } from "./constants";

/**
 * PDA derivation, byte-for-byte identical to program/scripts/e2e-onchain-job.mjs
 * (proven correct against the deployed program — see program/DEPLOY.md step 6).
 * If any seed here ever drifts from that script, keep both in sync — same
 * warning as shared/economics/settlement.mjs vs math.rs.
 */

const enc = (s: string) => Buffer.from(s, "utf8");

function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, getProgramId())[0];
}

export const oracleConfigPda = () => pda([enc("oracle")]);
export const walletProfilePda = (wallet: PublicKey) => pda([enc("wallet"), wallet.toBuffer()]);
export const employerProfilePda = (employer: PublicKey) => pda([enc("employer"), employer.toBuffer()]);
export const jobPda = (employer: PublicKey, nonce: BN) =>
  pda([enc("job"), employer.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
export const vaultPda = (job: PublicKey) => pda([enc("vault"), job.toBuffer()]);
export const bondVaultPda = (job: PublicKey) => pda([enc("bond"), job.toBuffer()]);