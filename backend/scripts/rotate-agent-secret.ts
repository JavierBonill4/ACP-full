/**
 * One-off recovery: `sharedSecret` is shown once at registration and never
 * again (see services/agents.ts's createAgent doc comment), and there is no
 * `/agents/:id/rotate-secret` route to fetch a new one for an existing agent.
 * `POST /agents` also refuses to re-create an agent with a name you already
 * have ({walletAddress, name} is unique — see the "You already have an
 * agent called ..." check), so if a shared secret is lost, `npm run
 * register` can't recover it either — it fails on the FIRST duplicate name
 * it hits (T1's "Scriptorium") before it ever gets to T2's "Cartographer".
 *
 * This resets an existing agent's sharedSecret in place — same random
 * 32-byte hex generation createAgent uses, stored in plaintext (see
 * dispatch.ts: it's an HMAC key, not a password, there's nothing to hash).
 * Nothing on-chain is touched; this only affects the platform<->agent HMAC
 * handshake for whichever Agent row you point it at.
 *
 * Usage (from backend/):
 *   npx tsx --env-file=.env scripts/rotate-agent-secret.ts <agentName> <walletAddress>
 *
 * <walletAddress> is required, not inferred — {walletAddress, name} is what
 * makes the row unique, and guessing wrong would silently rotate the wrong
 * operator's agent if two people ever picked the same name.
 */
import { randomBytes } from "node:crypto";
import { prisma } from "../src/db.js";

const [name, walletAddress] = process.argv.slice(2);
if (!name || !walletAddress) {
  console.error("Usage: tsx scripts/rotate-agent-secret.ts <agentName> <walletAddress>");
  process.exit(1);
}

const agent = await prisma.agent.findFirst({ where: { name, walletAddress } });
if (!agent) {
  console.error(`No agent named "${name}" under wallet ${walletAddress}.`);
  process.exit(1);
}

const sharedSecret = randomBytes(32).toString("hex");
await prisma.agent.update({ where: { id: agent.id }, data: { sharedSecret } });

console.log(`\n  rotated secret for "${agent.name}" (${agent.id})\n`);
console.log(`  ACP_AGENT_ID=${agent.id}`);
console.log(`  ACP_SHARED_SECRET=${sharedSecret}`);
console.log(`  TIER=${agent.tier}`);
console.log(
  `\n  Paste these into .env.t${agent.tier} (overwriting whatever's there for those three keys).\n` +
    `  Anything still running against the old secret will start failing its HMAC check on\n` +
    `  its next request — restart that agent process after updating its .env file.\n`
);
process.exit(0);
