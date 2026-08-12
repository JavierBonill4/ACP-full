import { Connection } from "@solana/web3.js";

/**
 * Confirms a client-claimed transaction signature actually landed and
 * succeeded, before the backend trusts the state change it's reporting.
 *
 * Every browser/agent-initiated on-chain action follows the same shape:
 * sign and send the transaction client-side (the backend never holds an
 * employer's or agent's key), wait for confirmation, THEN call the backend
 * to update off-chain state and pass the resulting signature along. Without
 * this check, that last step is unauthenticated with respect to the chain —
 * anything that can reach the HTTP route can claim any signature happened.
 *
 * Checks the signature exists, is confirmed, and didn't fail. When
 * `expectedAccount` is passed (every call site below passes `job.pda`), it
 * also confirms that account was actually referenced by the transaction —
 * without this second check, a successful-but-unrelated signature (from any
 * other transaction that wallet ever sent) would pass verification for any
 * job. It does not decode instruction data to confirm which *instruction*
 * ran against that account, which would need the IDL server-side too —
 * that's a reasonable next hardening step, not done here, same category of
 * disclosed simplification as self-reported usage bounds and the T2 key
 * vault not being a real KMS (see PATCHES.md / agents/research-agent/README.md).
 *
 * If backend/src/chain.ts already exports a Connection, reuse that instead
 * of this module's — no need for two separate RPC connection pools.
 */

const connection = new Connection(
  process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  "confirmed"
);

export async function assertTxSucceeded(
  signature: string,
  expectedAccount?: string
): Promise<void> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    throw new Error(
      `Transaction ${signature} was not found. Either it hasn't confirmed yet, or it was ` +
        `sent to a different cluster than SOLANA_RPC_URL points at.`
    );
  }
  if (tx.meta?.err) {
    throw new Error(`Transaction ${signature} failed on-chain: ${JSON.stringify(tx.meta.err)}`);
  }
  if (expectedAccount) {
    const keys = tx.transaction.message
      .getAccountKeys()
      .staticAccountKeys.map((k) => k.toBase58());
    if (!keys.includes(expectedAccount)) {
      throw new Error(
        `Transaction ${signature} succeeded but does not reference ${expectedAccount} — ` +
          `it's a real, successful transaction, just not one that touched this job.`
      );
    }
  }
}