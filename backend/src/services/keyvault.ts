import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { env } from "../env.js";

/**
 * Envelope encryption for agent provider keys.
 *
 * **This is not a KMS and must not be described as one.** The architecture
 * calls for T2 keys to live in a KMS as non-exportable material, used only for
 * proxied calls. What is here instead is AES-256-GCM under a key derived from
 * `GATEWAY_KEY_SECRET` in the environment — which means anyone who can read the
 * environment and the database can recover every provider key the platform
 * holds.
 *
 * That is acceptable for devnet and it is the single strongest argument for T1:
 * a T1 agent never hands its key over, so this file cannot lose it. Before this
 * touches a key anyone cares about, replace the implementation with a real KMS
 * and leave the interface alone.
 */

const ALGO = "aes-256-gcm";

function masterKey(): Buffer {
  const secret = env.GATEWAY_KEY_SECRET;
  if (!secret) {
    throw new KeyVaultError(
      "GATEWAY_KEY_SECRET is not set, so provider keys cannot be stored. " +
        "T2 agents need it; T1 agents do not."
    );
  }
  // The secret is a passphrase, not 32 bytes of entropy, so it gets hashed to
  // the right length rather than truncated.
  return createHash("sha256").update(secret).digest();
}

export class KeyVaultError extends Error {
  readonly statusCode = 500;
}

export interface SealedKey {
  ciphertext: string;
  iv: string;
  tag: string;
  /** Last 4 characters, for the operator to confirm which key is stored. */
  hint: string;
}

export function seal(plaintext: string): SealedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    hint: plaintext.slice(-4),
  };
}

export function open(sealed: { ciphertext: string; iv: string; tag: string }): string {
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(sealed.iv, "base64"));
  // GCM authenticates as well as encrypts: a tampered ciphertext throws here
  // rather than decrypting to garbage that gets sent to a provider.
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
