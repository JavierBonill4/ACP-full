/**
 * One-off recovery tool: re-sends the "you have an offer" notification for a
 * DIRECT job whose escrow-funding transaction confirmed on-chain but whose
 * agent dispatch either raced it (the AccountNotInitialized bug, now fixed
 * in services/jobs.ts) or otherwise never landed.
 *
 * Usage (from the backend/ directory):
 *   npx tsx --env-file=.env scripts/redispatch-job.ts <jobId>
 */
 import { dispatchDirectOffer } from "../src/services/jobs.ts";

 const jobId = process.argv[2];
 if (!jobId) {
   console.error("Usage: tsx scripts/redispatch-job.ts <jobId>");
   process.exit(1);
 }
 
 await dispatchDirectOffer(jobId);
 console.log(`Redispatched ${jobId}`);
 process.exit(0);