/**
 * Registers both research agents and writes their .env files.
 *
 *     tsx --env-file=.env scripts/register.ts
 *
 * Needs a Solana keypair to sign the platform's login challenge — the same
 * wallet the agents' reputation will accrue to. Both agents register under one
 * wallet deliberately: it makes the point that reputation follows the operator,
 * not the listing, and that running a second agent does not get you a second
 * clean record.
 *
 * If you want them to have independent reputations, run this twice with
 * different keypairs.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const PLATFORM_API = process.env.PLATFORM_API ?? "http://localhost:4000/api/v1";
const KEYPAIR_PATH =
  process.env.OPERATOR_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`;
const T1_PORT = Number(process.env.T1_PORT ?? 5101);
const T2_PORT = Number(process.env.T2_PORT ?? 5102);
const T1_URL = process.env.T1_URL ?? `http://localhost:${T1_PORT}`;
const T2_URL = process.env.T2_URL ?? `http://localhost:${T2_PORT}`;

function loadKeypair(): Keypair {
  if (!existsSync(KEYPAIR_PATH)) {
    console.error(
      `\nNo keypair at ${KEYPAIR_PATH}.\n` +
        `Create one with \`solana-keygen new\`, or set OPERATOR_KEYPAIR.\n`
    );
    process.exit(1);
  }
  const secret = JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
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
    throw new Error(
      parsed?.error ??
        `${path} returned ${res.status}` +
          (parsed?.fields ? `\n  ${JSON.stringify(parsed.fields, null, 2)}` : "")
    );
  }
  return parsed as T;
}

/**
 * Wallet sign-in. The challenge message says in plain words that it authorizes
 * no transaction — worth reading once, because the habit of approving whatever
 * a dapp shows you is exactly what gets exploited elsewhere.
 */
async function signIn(keypair: Keypair): Promise<string> {
  const address = keypair.publicKey.toBase58();
  const { nonce, message } = await post<{ nonce: string; message: string }>(
    "/auth/challenge",
    { address }
  );
  const signature = nacl.sign.detached(new TextEncoder().encode(message), keypair.secretKey);
  const { token } = await post<{ token: string }>("/auth/verify", {
    nonce,
    signature: bs58.encode(signature),
  });
  return token;
}

interface RegisterResult {
  agent: { id: string; name: string; tier: number; kind: string };
  sharedSecret: string;
  health: { healthy: boolean; error: string | null };
}

async function register(token: string, tier: 1 | 2, endpoint: string) {
  const name = tier === 1 ? "Scriptorium" : "Cartographer";

  return post<RegisterResult>(
    "/agents",
    {
      name,
      kind: "SINGLE_PURPOSE",
      endpoint,
      tier,
      // Both land in the same category, which is the useful comparison: an
      // employer browsing "Research" sees the two tiers side by side with the
      // same job to do and different metering guarantees.
      newCategoryLabel: "Research",
      descriptor: {
        summary:
          tier === 1
            ? "Deep-dives a topic and returns a presentation. Holds its own provider key and self-reports token usage, which the platform bounds but does not verify."
            : "Deep-dives a topic and returns a presentation. Routes every model call through the platform gateway, so token usage is measured rather than claimed.",
        capabilities: ["research", "synthesis", "presentation-writing"],
        models: ["claude-sonnet-5", "claude-opus-5"],
        avgCompletionMinutes: 12,
        basePlanningFeeUsdc: 1,
        baseFixedFeeUsdc: 15,
      },
    },
    token
  );
}

function writeEnv(file: string, lines: string[]) {
  const path = resolve(ROOT, file);
  if (existsSync(path)) {
    console.log(`  ${file} already exists — not overwriting. Values printed above.`);
    return;
  }
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`  wrote ${file}`);
}

async function main() {
  const keypair = loadKeypair();
  console.log(`\n  operator wallet: ${keypair.publicKey.toBase58()}`);
  console.log(`  platform:        ${PLATFORM_API}\n`);

  const token = await signIn(keypair);
  console.log("  signed in\n");

  const t1 = await register(token, 1, T1_URL);
  const t2 = await register(token, 2, T2_URL);

  for (const [label, r] of [
    ["T1", t1],
    ["T2", t2],
  ] as const) {
    console.log(`  ${label}  ${r.agent.name}`);
    console.log(`      id      ${r.agent.id}`);
    console.log(`      secret  ${r.sharedSecret}`);
    if (!r.health.healthy) {
      console.log(`      health  not reachable yet (${r.health.error ?? "no response"})`);
    }
    console.log("");
  }

  console.log(
    "  The shared secrets are shown once and are not retrievable. They are written\n" +
      "  into the .env files below; keep them out of version control.\n"
  );

  writeEnv(".env.t1", [
    "# Tier 1 — keeps its own key, self-reports usage.",
    `PORT=${T1_PORT}`,
    `PLATFORM_API=${PLATFORM_API}`,
    `ACP_AGENT_ID=${t1.agent.id}`,
    `ACP_SHARED_SECRET=${t1.sharedSecret}`,
    "TIER=1",
    "",
    "# Set this to do real research. Without it the agent runs in stub mode and",
    "# the usage it reports is fabricated.",
    "ANTHROPIC_API_KEY=",
    "",
    "RESEARCH_MODEL=claude-sonnet-5",
    "WRITE_MODEL=claude-opus-5",
    "DECK_SLIDES=8",
    "PLANNING_FEE_USDC=1",
    "FIXED_FEE_USDC=15",
  ]);

  writeEnv(".env.t2", [
    "# Tier 2 — holds no key. The platform holds it and meters every call.",
    "# Register the key once:",
    "#   curl -X POST $PLATFORM_API/gateway/agents/<id>/provider-key \\",
    "#     -H 'authorization: Bearer <token>' -H 'content-type: application/json' \\",
    "#     -d '{\"apiKey\":\"sk-ant-...\"}'",
    `PORT=${T2_PORT}`,
    `PLATFORM_API=${PLATFORM_API}`,
    `ACP_AGENT_ID=${t2.agent.id}`,
    `ACP_SHARED_SECRET=${t2.sharedSecret}`,
    "TIER=2",
    "",
    "# Deliberately absent. A tier 2 agent holding a local key is misconfigured,",
    "# and the agent refuses to start if this is set.",
    "",
    "RESEARCH_MODEL=claude-sonnet-5",
    "WRITE_MODEL=claude-opus-5",
    "DECK_SLIDES=8",
    "PLANNING_FEE_USDC=1",
    "FIXED_FEE_USDC=15",
  ]);

  console.log("\n  next:");
  console.log("    npm run t1     # terminal one");
  console.log("    npm run t2     # terminal two");
  console.log(`    register the T2 provider key (see .env.t2 for the curl)\n`);
}

main().catch((e) => {
  console.error(`\n  ${(e as Error).message}\n`);
  process.exit(1);
});
