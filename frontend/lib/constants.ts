import { PublicKey } from "@solana/web3.js";

/**
 * On-chain config, read from NEXT_PUBLIC_* env vars (program/DEPLOY.md step
 * 5 lists where these values come from — the same program ID, mint, and
 * treasury the e2e script and backend already use).
 *
 * Deliberately NOT validated at import time. Most pages never touch the
 * chain, and a hard throw at module load would take down the whole app if
 * these are unset — instead each getter throws only when something actually
 * tries to build a transaction, with a message that says what to set and
 * where.
 */

const RAW = {
  programId: process.env.NEXT_PUBLIC_ACP_PROGRAM_ID,
  usdcMint: process.env.NEXT_PUBLIC_USDC_MINT,
  treasury: process.env.NEXT_PUBLIC_TREASURY_ADDRESS,
  rpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
};

export const SOLANA_RPC_URL = RAW.rpcUrl || "https://api.devnet.solana.com";

export const isChainConfigured = Boolean(RAW.programId && RAW.usdcMint && RAW.treasury);

function lazyPublicKey(envVar: string, value: string | undefined): () => PublicKey {
  let cached: PublicKey | null = null;
  return () => {
    if (cached) return cached;
    if (!value) {
      throw new Error(
        `${envVar} is not set. Copy the value from program/DEPLOY.md step 5 into ` +
          `frontend/.env.local, then restart the dev server — Next.js only reads ` +
          `NEXT_PUBLIC_* vars at boot, not on hot reload.`
      );
    }
    try {
      cached = new PublicKey(value);
    } catch {
      throw new Error(`${envVar} ("${value}") is not a valid base58 Solana address.`);
    }
    return cached;
  };
}

export const getProgramId = lazyPublicKey("NEXT_PUBLIC_ACP_PROGRAM_ID", RAW.programId);
export const getUsdcMint = lazyPublicKey("NEXT_PUBLIC_USDC_MINT", RAW.usdcMint);
export const getTreasury = lazyPublicKey("NEXT_PUBLIC_TREASURY_ADDRESS", RAW.treasury);