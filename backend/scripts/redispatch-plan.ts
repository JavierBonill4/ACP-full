/**
 * One-off recovery: re-sends the "plan" webhook for a job that's already
 * past accept_offer (state CLAIMED) but whose agent never got as far as
 * submitting a plan — e.g. buildPlan failed on something transient (a
 * missing gateway key, a dropped connection) *after* accept_offer already
 * succeeded on-chain and in the DB.
 *
 * `redispatch-job.ts` only helps a job still stuck at OFFERED — its guard
 * (`job.state !== "OFFERED"`) no-ops silently for anything past that, which
 * is exactly the "prints success, changes nothing" you get running it
 * against a CLAIMED job. Re-sending the *original* offer notification here
 * would also be actively wrong: the agent's /plan handler calls
 * accept_offer on-chain whenever the payload says state "OFFERED", and the
 * program would reject a second accept_offer against a job that's already
 * CLAIMED.
 *
 * This is safe specifically because notifyAgent's payload always carries the
 * job's *current* real state (see notifyAgent in services/jobs.ts) — sent as
 * "CLAIMED", the agent's planAndSubmit (research-agent/src/index.ts) skips
 * the accept_offer branch entirely and goes straight to buildPlan/submitPlan.
 *
 * Usage (from the backend/ directory):
 *   npx tsx --env-file=.env scripts/redispatch-plan.ts <jobId>
 */
import { prisma } from "../src/db.js";
import { notifyAgent } from "../src/services/jobs.js";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: tsx scripts/redispatch-plan.ts <jobId>");
  process.exit(1);
}

const job = await prisma.job.findUnique({ where: { id: jobId } });
if (!job) {
  console.error(`No such job: ${jobId}`);
  process.exit(1);
}
if (!["OFFERED", "CLAIMED"].includes(job.state)) {
  console.error(
    `Job is in state ${job.state}, not OFFERED/CLAIMED — this script is only for a job stuck ` +
      `after accept_offer succeeded but before a plan was submitted.`
  );
  process.exit(1);
}
if (!job.agentId) {
  console.error(`Job ${jobId} has no agentId — nothing to notify.`);
  process.exit(1);
}
const agent = await prisma.agent.findUnique({ where: { id: job.agentId } });
if (!agent) {
  console.error(`No agent found for job ${jobId} (agentId ${job.agentId}).`);
  process.exit(1);
}

// Awaited, unlike the fire-and-forget `void notifyAgent(...)` this mirrors
// inside the running server (deliberate there, so an API response doesn't
// block on a webhook — not deliberate here, where this is the entire point
// of running the script).
await notifyAgent(agent, job, "plan");

console.log(`Sent /plan to ${agent.name} (${agent.endpoint}) for ${jobId}, state=${job.state}.`);
console.log(`Check that agent's terminal for the result — the request itself always returns 202.`);
process.exit(0);
