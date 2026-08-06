import {
  ACCEPT_TTL,
  CLAIM_TTL,
  REVIEW_TTL,
  RECONCILIATION_WINDOW,
  JOB_TYPE,
  OUTCOME,
  applyWrs,
  escrowTotal,
  requiredBond,
  settle,
  tierHasHoldback,
  tierValueCap,
  type OutcomeCode,
} from "@acp/economics";
import type { Agent, Job } from "@prisma/client";

import { prisma } from "../db.js";
import { commitmentHash, jobPda } from "../chain.js";
import { PublicKey } from "@solana/web3.js";
import { dispatch } from "./dispatch.js";
import type {
  createCustomJobSchema,
  createDirectJobSchema,
  submitPlanSchema,
} from "../schemas.js";
import type { z } from "zod";

export class JobError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const secs = (n: number) => n * 1000;

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface EscrowCapsInput {
  planningFeeCap: bigint;
  fixedFeeCap: bigint;
  planningTokenCap: bigint;
  tokenBudgetCap: bigint;
}

/**
 * What the employer is about to be asked to fund, and what they get back in
 * each outcome. Computed with the same arithmetic that settles on-chain
 * (@acp/economics is a mirror of math.rs), so the number in the confirm dialog
 * is the number the program will move.
 */
export function quote(caps: EscrowCapsInput, tier: number, jobType: "OPEN" | "DIRECT") {
  const total = escrowTotal(caps);
  const bond = requiredBond(jobType === "OPEN" ? JOB_TYPE.OPEN : JOB_TYPE.DIRECT, caps.fixedFeeCap);

  // Worst case for the employer: the agent bills every cap and the job is
  // accepted. Best case: nothing is used and the job expires.
  const worst = settle({
    outcome: OUTCOME.ACCEPTED,
    tier,
    escrowTotal: total,
    planningFee: caps.planningFeeCap,
    fixedFee: caps.fixedFeeCap,
    planningTokenCap: caps.planningTokenCap,
    tokenBudgetCap: caps.tokenBudgetCap,
    planningTokensUsed: caps.planningTokenCap,
    executionTokensUsed: caps.tokenBudgetCap,
  });

  return {
    escrowTotal: total,
    bond,
    valueCap: tierValueCap(tier),
    withinCap: total <= tierValueCap(tier),
    hasHoldback: tierHasHoldback(tier),
    maxAgentPayout: worst.agentImmediate + worst.agentHoldback,
    maxProtocolFee: worst.protocolFee,
    /// Everything unspent comes back, so this is a ceiling on exposure and not
    /// an expected cost.
    minEmployerRefund: worst.employerRefund,
  };
}

export function validateCaps(caps: EscrowCapsInput, tier: number) {
  const total = escrowTotal(caps);
  if (total <= 0n) throw new JobError("Escrow must be greater than zero");
  if (total > tierValueCap(tier)) {
    throw new JobError(
      `A tier ${tier} job is capped at ${tierValueCap(tier) / 1_000_000n} USDC; this one totals ` +
        `${total / 1_000_000n} USDC. Raise the minimum tier or lower the caps.`
    );
  }
}

function validateDeadline(deadline: Date) {
  const now = Date.now();
  if (deadline.getTime() <= now + secs(60)) {
    throw new JobError("Deadline must be at least a minute out");
  }
  if (deadline.getTime() > now + secs(90 * 24 * 60 * 60)) {
    throw new JobError("Deadline cannot be more than 90 days out");
  }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

async function nextNonce(employerAddress: string): Promise<number> {
  const last = await prisma.job.findFirst({
    where: { employerAddress },
    orderBy: { nonce: "desc" },
    select: { nonce: true },
  });
  return (last?.nonce ?? -1) + 1;
}

/**
 * The general window's action: a custom job, posted OPEN, claimed by whichever
 * general-purpose agent wants it. No agent is named at creation.
 */
export async function createCustomJob(
  employerAddress: string,
  input: z.infer<typeof createCustomJobSchema>
) {
  validateDeadline(input.deadline);
  validateCaps(input, input.minTier);

  const nonce = await nextNonce(employerAddress);
  const pda = jobPda(new PublicKey(employerAddress), nonce).toBase58();

  await prisma.wallet.upsert({
    where: { address: employerAddress },
    create: { address: employerAddress },
    update: {},
  });

  const job = await prisma.job.create({
    data: {
      nonce,
      pda,
      employerAddress,
      jobType: "OPEN",
      state: "OPEN",
      title: input.title,
      specText: input.spec,
      specHash: commitmentHash(input.spec),
      planningFeeCap: input.planningFeeCap,
      fixedFeeCap: input.fixedFeeCap,
      planningTokenCap: input.planningTokenCap,
      tokenBudgetCap: input.tokenBudgetCap,
      minTier: input.minTier,
      deadline: input.deadline,
    },
  });

  await event(job.id, "POSTED", employerAddress, "Custom job posted to the open pool");
  return job;
}

/**
 * The single-purpose window's action: hire one named agent. Fees default to
 * the agent's descriptor and are pinned into the job, so the ceilings the
 * employer funds are the numbers the agent advertised.
 */
export async function createDirectJob(
  employerAddress: string,
  input: z.infer<typeof createDirectJobSchema>
) {
  validateDeadline(input.deadline);

  const agent = await prisma.agent.findUnique({
    where: { id: input.agentId },
    include: { wallet: true },
  });
  if (!agent) throw new JobError("No such agent", 404);
  if (agent.status === "SUSPENDED") throw new JobError("That agent is suspended");
  if (agent.kind !== "SINGLE_PURPOSE") {
    throw new JobError(
      "General-purpose agents are not hired directly. Post a custom job in the general window instead."
    );
  }
  if (agent.walletAddress === employerAddress) {
    throw new JobError("You cannot hire your own agent");
  }

  validateCaps(input, agent.tier);

  const nonce = await nextNonce(employerAddress);
  const pda = jobPda(new PublicKey(employerAddress), nonce).toBase58();

  await prisma.wallet.upsert({
    where: { address: employerAddress },
    create: { address: employerAddress },
    update: {},
  });

  const job = await prisma.job.create({
    data: {
      nonce,
      pda,
      employerAddress,
      agentId: agent.id,
      agentAddress: agent.walletAddress,
      categoryId: agent.categoryId,
      jobType: "DIRECT",
      state: "OFFERED",
      title: input.title,
      specText: input.spec,
      specHash: commitmentHash(input.spec),
      planningFeeCap: input.planningFeeCap,
      fixedFeeCap: input.fixedFeeCap,
      planningTokenCap: input.planningTokenCap,
      tokenBudgetCap: input.tokenBudgetCap,
      minTier: agent.tier,
      // The offer clock starts now. If the agent does not accept, the employer
      // gets everything back — no bond was posted because the employer chose
      // them.
      offerExpiresAt: new Date(Date.now() + secs(ACCEPT_TTL)),
      deadline: input.deadline,
    },
  });

  await event(job.id, "OFFERED", employerAddress, `Offered directly to ${agent.name}`);
  void notifyAgent(agent, job, "plan");
  return job;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Open pool only. First claim locks everyone else out. */
export async function claimJob(agentWallet: string, jobId: string, agentId: string) {
  const [job, agent] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    prisma.agent.findUnique({ where: { id: agentId }, include: { wallet: true } }),
  ]);
  if (!job) throw new JobError("No such job", 404);
  if (!agent) throw new JobError("No such agent", 404);
  if (agent.walletAddress !== agentWallet) throw new JobError("That is not your agent", 403);
  if (job.state !== "OPEN") throw new JobError("That job is no longer open");
  if (job.employerAddress === agentWallet) throw new JobError("You cannot claim your own job");

  if (agent.kind !== "GENERAL") {
    throw new JobError(
      "Only general-purpose agents claim open custom jobs. Single-purpose agents are hired directly."
    );
  }
  if (agent.tier < job.minTier) {
    throw new JobError(`This job requires tier ${job.minTier}; your agent is tier ${agent.tier}`);
  }

  const total = escrowTotal(job);
  if (total > tierValueCap(agent.tier)) {
    throw new JobError(`This job exceeds the tier ${agent.tier} value cap`);
  }

  const bond = requiredBond(JOB_TYPE.OPEN, job.fixedFeeCap);

  const updated = await prisma.job.update({
    where: { id: jobId, state: "OPEN" },
    data: {
      state: "CLAIMED",
      agentId: agent.id,
      agentAddress: agent.walletAddress,
      claimedTier: agent.tier,
      bond,
      claimExpiresAt: new Date(Date.now() + secs(CLAIM_TTL)),
    },
  });

  await event(jobId, "CLAIMED", agentWallet, `Claimed by ${agent.name}, ${bond} bond posted`);
  void notifyAgent(agent, updated, "plan");
  return updated;
}

/** Direct hire only. */
export async function acceptOffer(agentWallet: string, jobId: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId }, include: { agent: true } });
  if (!job) throw new JobError("No such job", 404);
  if (job.state !== "OFFERED") throw new JobError("That offer is no longer open");
  if (job.agentAddress !== agentWallet) throw new JobError("That offer is not yours", 403);
  if (job.offerExpiresAt && job.offerExpiresAt < new Date()) {
    throw new JobError("The acceptance window has closed");
  }

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      state: "CLAIMED",
      claimedTier: job.agent?.tier ?? job.minTier,
      claimExpiresAt: new Date(Date.now() + secs(CLAIM_TTL)),
    },
  });
  await event(jobId, "ACCEPTED_OFFER", agentWallet, "Agent accepted the direct offer");
  return updated;
}

export async function submitPlan(
  agentWallet: string,
  jobId: string,
  input: z.infer<typeof submitPlanSchema>
) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new JobError("No such job", 404);
  if (job.agentAddress !== agentWallet) throw new JobError("Not your job", 403);
  if (job.state !== "CLAIMED") throw new JobError("A plan is not expected right now");

  // The employer funded ceilings, not fees. A proposal above them would need a
  // top-up transaction the employer never agreed to.
  if (input.planningFee > job.planningFeeCap) {
    throw new JobError("Planning fee is above the ceiling the employer funded");
  }
  if (input.fixedFee > job.fixedFeeCap) {
    throw new JobError("Completion fee is above the ceiling the employer funded");
  }

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      state: "PLAN_PENDING",
      planText: input.outline,
      planHash: commitmentHash(input.outline),
      planningFee: input.planningFee,
      fixedFee: input.fixedFee,
      reviewExpiresAt: new Date(Date.now() + secs(REVIEW_TTL)),
    },
  });
  await event(jobId, "PLAN_SUBMITTED", agentWallet, "Plan submitted for review");
  return updated;
}

export async function acceptPlan(employerAddress: string, jobId: string, auto = false) {
  const job = await requireEmployerJob(employerAddress, jobId, auto);
  if (job.state !== "PLAN_PENDING") throw new JobError("There is no plan awaiting review");

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: { state: "IN_PROGRESS", reviewExpiresAt: null, autoAccepted: auto },
  });
  await event(jobId, "PLAN_ACCEPTED", auto ? null : employerAddress,
    auto ? "Review window expired; plan auto-accepted" : "Employer accepted the plan");

  const agent = job.agentId ? await prisma.agent.findUnique({ where: { id: job.agentId } }) : null;
  if (agent) void notifyAgent(agent, updated, "execute");
  return updated;
}

export async function submitDeliverable(agentWallet: string, jobId: string, deliverable: string) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new JobError("No such job", 404);
  if (job.agentAddress !== agentWallet) throw new JobError("Not your job", 403);
  if (job.state !== "IN_PROGRESS") throw new JobError("A deliverable is not expected right now");
  if (job.deadline < new Date()) throw new JobError("The deadline has passed");

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      state: "REVIEW_PENDING",
      deliverableText: deliverable,
      deliverableHash: commitmentHash(deliverable),
      reviewExpiresAt: new Date(Date.now() + secs(REVIEW_TTL)),
    },
  });
  await event(jobId, "DELIVERABLE_SUBMITTED", agentWallet, "Deliverable submitted for review");
  return updated;
}

// ---------------------------------------------------------------------------
// Terminal transitions
// ---------------------------------------------------------------------------

export interface FinalizeOptions {
  outcome: OutcomeCode;
  rating?: number;
  comment?: string;
  auto?: boolean;
  actor?: string;
}

/**
 * Mirrors the program's `finalize`. The chain is authoritative — this writes
 * the local view of the same transition so the UI does not have to wait for an
 * indexer round-trip, and `settleTx` reconciles it once the signature confirms.
 */
export async function finalizeJob(jobId: string, opts: FinalizeOptions) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new JobError("No such job", 404);
  if (["SETTLED", "EXPIRED", "CANCELLED"].includes(job.state)) {
    throw new JobError("That job has already settled");
  }

  const tier = job.claimedTier ?? job.minTier;
  const total = escrowTotal(job);
  const rating = opts.rating ?? 5;

  const result = settle({
    outcome: opts.outcome,
    tier,
    escrowTotal: total,
    planningFee: job.planningFee,
    fixedFee: job.fixedFee,
    planningTokenCap: job.planningTokenCap,
    tokenBudgetCap: job.tokenBudgetCap,
    planningTokensUsed: job.planningTokensUsed,
    executionTokensUsed: job.executionTokensUsed,
  });

  const updated = await prisma.job.update({
    where: { id: jobId },
    data: {
      state: opts.outcome === OUTCOME.EXPIRED ? "EXPIRED" : "SETTLED",
      rating: opts.outcome === OUTCOME.ACCEPTED ? rating : null,
      autoAccepted: opts.auto ?? false,
      holdbackAmount: result.agentHoldback,
      holdbackUntil:
        result.agentHoldback > 0n ? new Date(Date.now() + secs(RECONCILIATION_WINDOW)) : null,
    },
  });

  if (job.agentAddress) {
    await updateWalletReputation(job.agentAddress, opts.outcome, rating, total, result);

    if (opts.outcome === OUTCOME.ACCEPTED) {
      await prisma.rating.upsert({
        where: { jobId },
        create: {
          jobId,
          raterAddress: job.employerAddress,
          rateeAddress: job.agentAddress,
          rawRating: rating,
          // MVP stores them equal. v2 z-scores against the employer's own
          // mean and variance; having both columns from day one makes that a
          // backfill rather than a migration.
          normalizedRating: rating,
          comment: opts.comment ?? null,
          auto: opts.auto ?? false,
        },
        update: {},
      });
    }
  }

  const isRejection =
    opts.outcome === OUTCOME.PLAN_REJECTED || opts.outcome === OUTCOME.DELIVERABLE_REJECTED;
  if (isRejection) {
    await prisma.wallet.update({
      where: { address: job.employerAddress },
      data: { jobsRejected: { increment: 1 } },
    });
  }

  await event(
    jobId,
    opts.outcome === OUTCOME.EXPIRED ? "EXPIRED" : "SETTLED",
    opts.actor ?? null,
    describeOutcome(opts.outcome, opts.auto ?? false)
  );

  if (job.agentId) {
    const agent = await prisma.agent.findUnique({ where: { id: job.agentId } });
    if (agent && opts.outcome === OUTCOME.EXPIRED) void notifyAgent(agent, updated, "cancel");
  }

  return { job: updated, settlement: result };
}

function describeOutcome(outcome: OutcomeCode, auto: boolean): string {
  switch (outcome) {
    case OUTCOME.ACCEPTED:
      return auto
        ? "Review window expired; deliverable auto-accepted at a neutral rating of 5"
        : "Employer accepted the deliverable";
    case OUTCOME.PLAN_REJECTED:
      return "Employer rejected the plan. The agent keeps its planning fee and token cost; no rights to the work transfer.";
    case OUTCOME.DELIVERABLE_REJECTED:
      return "Employer rejected the deliverable. The agent recovers token cost and the planning fee; rejected work is not licensed.";
    case OUTCOME.EXPIRED:
      return "Timer expired. Escrow returned to the employer; any bond was slashed.";
  }
}

/**
 * Local mirror of the on-chain reputation write, so list views do not need an
 * RPC call per card. The chain is authoritative; `chainSyncedAt` marks how
 * stale this is.
 */
async function updateWalletReputation(
  address: string,
  outcome: OutcomeCode,
  rating: number,
  jobValue: bigint,
  settlement: { agentImmediate: bigint; agentHoldback: bigint }
) {
  const wallet = await prisma.wallet.findUnique({ where: { address } });
  if (!wallet) return;

  const wrs = applyWrs(wallet.cachedWrs, outcome, rating, jobValue);

  await prisma.wallet.update({
    where: { address },
    data: {
      cachedWrs: wrs,
      // Monotonic. Nothing in this codebase decrements them — the score
      // floors at zero, and without an undecrementable record a burned wallet
      // is indistinguishable from a fresh one.
      ...(outcome === OUTCOME.ACCEPTED
        ? {
            jobsCompleted: { increment: 1 },
            totalValueSettled: wallet.totalValueSettled + settlement.agentImmediate + settlement.agentHoldback,
          }
        : {}),
      ...(outcome === OUTCOME.PLAN_REJECTED || outcome === OUTCOME.DELIVERABLE_REJECTED
        ? { jobsRejected: { increment: 1 } }
        : {}),
      ...(outcome === OUTCOME.EXPIRED ? { jobsExpired: { increment: 1 } } : {}),
      chainSyncedAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------

async function requireEmployerJob(employerAddress: string, jobId: string, allowAnyone = false) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) throw new JobError("No such job", 404);
  if (!allowAnyone && job.employerAddress !== employerAddress) {
    throw new JobError("Not your job", 403);
  }
  return job;
}

export async function event(
  jobId: string,
  kind: string,
  actor?: string | null,
  detail?: string | null
) {
  await prisma.jobEvent.create({
    data: { jobId, kind, actor: actor ?? null, detail: detail ?? null },
  });
}

/**
 * Fire-and-forget notification to the agent's endpoint. Failures are recorded
 * and never block the state transition — an agent whose endpoint is down still
 * owns the job and still hits its deadline. That is harsh for a transient
 * outage and is called out as an open item in ARCHITECTURE.md §13.
 */
async function notifyAgent(agent: Agent, job: Job, route: "plan" | "execute" | "cancel") {
  const payload = {
    jobId: job.id,
    pda: job.pda,
    title: job.title,
    spec: job.specText,
    specHash: job.specHash,
    plan: job.planText,
    deadline: job.deadline.toISOString(),
    caps: {
      planningFeeUsdc: Number(job.planningFeeCap) / 1e6,
      fixedFeeUsdc: Number(job.fixedFeeCap) / 1e6,
      planningTokenUsdc: Number(job.planningTokenCap) / 1e6,
      tokenBudgetUsdc: Number(job.tokenBudgetCap) / 1e6,
    },
    callbackUrl: `/api/v1/jobs/${job.id}/callback`,
  };

  const res = await dispatch[route](agent.endpoint, agent.sharedSecret, payload);
  if (!res.ok) {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: "UNREACHABLE", lastHealthError: res.error ?? "dispatch failed" },
    });
    await event(job.id, "DISPATCH_FAILED", null, `${route}: ${res.error ?? "unknown error"}`);
  }
}
