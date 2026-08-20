/**
 * Retries any UsageReport row that was written to Postgres but never
 * confirmed on-chain — the recovery path for the failure branch in
 * services/usage.ts's recordUsage (network hiccup, RPC timeout, the oracle
 * key not being configured at the time, etc.).
 *
 * Safe to run repeatedly: report_usage assigns the phase's running total
 * rather than adding, so re-sending the same (job, phase) pair with its
 * current total is a no-op if it already confirmed and a fix if it didn't.
 * Skips anything whose job has since settled (state is terminal) or has no
 * on-chain pda — nothing to report against in either case.
 *
 * Usage (from the backend/ directory):
 *   npx tsx --env-file=.env scripts/replay-usage.ts [jobId]
 *
 * With no jobId, scans every unconfirmed report across all jobs.
 */
 import { prisma } from "../src/db.js";
 import { oracleChainEnabled, reportUsageOnChain } from "../src/chainOracle.js";
 import { event } from "../src/services/jobs.js";
 
 const TERMINAL = new Set(["SETTLED", "EXPIRED", "CANCELLED"]);
 
 if (!oracleChainEnabled) {
   console.error("ORACLE_SECRET_KEY is not configured — nothing to sign with.");
   process.exit(1);
 }
 
 const jobIdArg = process.argv[2];
 
 const unconfirmed = await prisma.usageReport.findMany({
   where: { confirmed: false, ...(jobIdArg ? { jobId: jobIdArg } : {}) },
   orderBy: { createdAt: "asc" },
   include: { job: true },
 });
 
 if (unconfirmed.length === 0) {
   console.log("Nothing to replay.");
   process.exit(0);
 }
 
 // One report per (job, phase) isn't what we want to resend — we want the
 // CURRENT running total per (job, phase), which is what's already sitting
 // on job.planningTokensUsed / job.executionTokensUsed. Resending each row
 // individually in order would work too (each assigns), but would send more
 // transactions than necessary; de-dupe to the latest state per phase.
 const byJobPhase = new Map<string, { jobId: string; phase: 0 | 1; pda: string }>();
 for (const r of unconfirmed) {
   if (!r.job.pda) {
     console.log(`Skipping ${r.id} — job ${r.jobId} has no on-chain pda.`);
     continue;
   }
   if (TERMINAL.has(r.job.state)) {
     console.log(`Skipping ${r.id} — job ${r.jobId} is already ${r.job.state}.`);
     continue;
   }
   byJobPhase.set(`${r.jobId}:${r.phase}`, {
     jobId: r.jobId,
     phase: r.phase as 0 | 1,
     pda: r.job.pda,
   });
 }
 
 for (const { jobId, phase, pda } of byJobPhase.values()) {
   const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
   const amount = phase === 0 ? job.planningTokensUsed : job.executionTokensUsed;
   try {
     const { signature } = await reportUsageOnChain(pda, phase, amount);
     await prisma.usageReport.updateMany({
       where: { jobId, phase, confirmed: false },
       data: { txSig: signature, confirmed: true },
     });
     await event(jobId, "USAGE_REPORTED_ONCHAIN", null, `${signature} (replayed)`);
     console.log(`${jobId} phase ${phase}: confirmed ${signature}`);
   } catch (e) {
     console.error(`${jobId} phase ${phase}: still failing — ${(e as Error).message}`);
   }
 }
 
 process.exit(0);