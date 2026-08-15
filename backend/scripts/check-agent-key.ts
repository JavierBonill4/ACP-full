import { prisma } from "../src/db.js";

const id = process.argv[2];
if (!id) {
  console.error("Usage: tsx scripts/check-agent-key.ts <agentId>");
  process.exit(1);
}
const a = await prisma.agent.findUnique({
  where: { id },
  select: { name: true, providerKeySetAt: true, providerKeyHint: true },
});
console.log(a);
process.exit(0);