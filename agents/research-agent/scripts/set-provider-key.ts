/**
 * Registers a tier-2 agent's provider key with the platform.
 *
 * POST /gateway/agents/:id/provider-key is wallet-session authenticated
 * (see backend/src/routes/gateway.ts) — the caller has to prove they own
 * the operator wallet the agent is registered under, the same way
 * register.ts's signIn() does. There's no way to do that in a single curl
 * line without hand-building a signed challenge, so this does the sign-in
 * and the key POST together.
 *
 * The key itself only ever exists in memory here and on the wire (HTTPS) —
 * it's encrypted at rest server-side (services/keyvault.ts) the instant it
 * lands, and there is no route that reads it back, only a 4-character hint.
 *
 * Usage (from agents/research-agent/):
 *   tsx --env-file=.env.t2 scripts/set-provider-key.ts <apiKey>
 *
 * Reads ACP_AGENT_ID from .env.t2 (or --env-file=.env, or whatever you
 * point it at) so you don't have to pass the id separately — it's the
 * same id that file already needs to run the agent.
 */
import { readFileSync, existsSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const PLATFORM_API = process.env.PLATFORM_API ?? "http://localhost:4000/api/v1";
const KEYPAIR_PATH =
  (process.env.OPERATOR_KEYPAIR ?? process.env.SOLANA_KEYPAIR_PATH ?? `${process.env.HOME}/.config/solana/id.json`)
    .replace(/^~/, process.env.HOME ?? "");
const AGENT_ID = process.env.ACP_AGENT_ID;
const apiKey = process.argv[2];

if (!AGENT_ID) {
  console.error(
    "\n  ACP_AGENT_ID is not set. Run this with the same --env-file as the agent it's for,\n" +
      "  e.g. `tsx --env-file=.env.t2 scripts/set-provider-key.ts <apiKey>`.\n"
  );
  process.exit(1);
}
if (!apiKey) {
  console.error("\n  Usage: tsx --env-file=.env.t2 scripts/set-provider-key.ts <apiKey>\n");
  process.exit(1);
}
if (!existsSync(KEYPAIR_PATH)) {
  console.error(`\n  No keypair at ${KEYPAIR_PATH}. Set OPERATOR_KEYPAIR if it's elsewhere.\n`);
  process.exit(1);
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${PLATFORM_API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(parsed?.error ?? `${path} returned ${res.status}`);
  }
  return parsed as T;
}

async function signIn(keypair: Keypair): Promise<string> {
  const address = keypair.publicKey.toBase58();
  const { nonce, message } = await post<{ nonce: string; message: string }>("/auth/challenge", { address });
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  const { token } = await post<{ token: string }>("/auth/verify", {
    nonce,
    signature: bs58.encode(signature),
  });
  return token;
}

async function main() {
  const secret = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[];
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));

  console.log(`\n  operator wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`  agent:           ${AGENT_ID}`);
  console.log(`  platform:        ${PLATFORM_API}\n`);

  const token = await signIn(keypair);
  console.log("  signed in");

  const result = await post<{ ok: boolean; hint: string; warning: string }>(
    `/gateway/agents/${AGENT_ID}/provider-key`,
    { apiKey },
    token
  );

  console.log(`  key stored — hint …${result.hint}`);
  console.log(`\n  ${result.warning}\n`);
}

main().catch((e) => {
  console.error(`\n  ${(e as Error).message}\n`);
  process.exit(1);
});
