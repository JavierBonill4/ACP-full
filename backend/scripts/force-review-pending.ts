/**
 * One-off recovery: a job whose deliverable was submitted on-chain (so it
 * counts against the agent's concurrent-claim limit) but whose DB row never
 * advanced past IN_PROGRESS, because the callback that would have done that
 * was rejected before it reached submitDeliverable (an old schema on the
 * backend, since fixed).
 *
 * This does NOT send any on-chain transaction and does NOT claim to know
 * what the real deliverable was — it only flips the DB's state to
 * REVIEW_PENDING so the frontend renders the Accept/Reject buttons. The
 * actual fix is the real on-chain accept_deliverable your browser wallet
 * sends afterward: Anchor checks the on-chain job account, not this row, so
 * it succeeds or fails on its own merits regardless of what's patched here.
 *
 * Usage (from backend/):
 *   npx tsx --env-file=.env scripts/force-review-pending.ts <jobId>
 */
import { prisma } from "../src/db.js";

const jobId = process.argv[2];
if (!jobId) {
  console.error("Usage: tsx scripts/force-review-pending.ts <jobId>");
  process.exit(1);
}

const job = await prisma.job.findUnique({ where: { id: jobId } });
if (!job) {
  console.error(`No such job: ${jobId}`);
  process.exit(1);
}
if (job.state !== "IN_PROGRESS") {
  console.error(`Job is in state ${job.state}, not IN_PROGRESS — this script is only for that stuck case.`);
  process.exit(1);
}

// 71h, just under the real REVIEW_TTL — long enough to act, short enough
// that if you forget about it, the crank's own auto-accept sweep (off-chain
// only, doesn't touch the chain) doesn't fire before you do.
const reviewExpiresAt = new Date(Date.now() + 71 * 60 * 60 * 1000);

await prisma.job.update({
  where: { id: jobId },
  data: { state: "REVIEW_PENDING", reviewExpiresAt },
});

await prisma.jobEvent.create({
  data: {
    jobId,
    kind: "RECOVERED",
    detail:
      "Manually moved to REVIEW_PENDING after a failed deliverable callback left this job " +
      "desynced from its on-chain state (submit_deliverable had already succeeded on-chain).",
  },
});

console.log(`${jobId} -> REVIEW_PENDING. Open it in the frontend and Accept (or Reject) for real.`);
process.exit(0);
