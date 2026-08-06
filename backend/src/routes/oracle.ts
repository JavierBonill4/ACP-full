import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { OUTCOME, REVIEW_TTL, formatUsdc } from "@acp/economics";

import { prisma, serialize } from "../db.js";
import { oracleKeypair } from "../chain.js";
import { registerRawJsonParser, type RawBody } from "../rawBody.js";
import { assertAgentOwnsJob, requireAgent } from "../services/agentAuth.js";
import { verifySignature } from "../services/dispatch.js";
import { acceptPlan, event, finalizeJob, submitDeliverable } from "../services/jobs.js";
import { publishedRateCard } from "../services/ratecard.js";
import { PHASE_EXECUTION, PHASE_PLANNING, recordUsage, usageBreakdown } from "../services/usage.js";

/**
 * Usage reporting and the timer cranks.
 *
 * The oracle is a single platform-controlled key. Every payout depends on it
 * being honest and available — that is the MVP trust model and it should be
 * stated plainly rather than papered over. See ARCHITECTURE.md §11 for the
 * hardening order: multisig, then signed receipts, then a challenge period,
 * then arbitration.
 */
export const oracleRoutes: FastifyPluginAsync = async (app) => {
  registerRawJsonParser(app);

  app.get("/status", async () => ({
    // Deliberately visible in the UI. A user should be able to see that a
    // single key controls usage reporting without reading the docs.
    oracleConfigured: Boolean(oracleKeypair),
    oracleAddress: oracleKeypair?.publicKey.toBase58() ?? null,
    signerCount: oracleKeypair ? 1 : 0,
    threshold: 1,
    trustModel:
      "Single platform-controlled signer. Usage reporting is a trusted party in this deployment.",
    detection:
      "None. Self-reported usage is bounded by the funded cap, the tier value cap and the " +
      "7-day tier-1 holdback — it is not checked against the provider. Reconciliation, " +
      "plausibility bounds, canaries and fingerprinting are specced (ARCHITECTURE.md §8.1) " +
      "and not built.",
  }));

  app.get("/rate-card", async () => publishedRateCard());

  /**
   * Self-reported usage. **Tier 1 only.**
   *
   * Authenticated with the agent's shared secret over the raw body, and scoped
   * to a job that agent actually holds. This endpoint moves money — an
   * unauthenticated version lets anyone who learns a job id drain that job's
   * escrow up to its cap, and an authenticated-but-unscoped one lets any
   * registered agent do it to any job.
   *
   * A tier 2 agent is refused here on purpose. T2's entire claim is that its
   * traffic is observed rather than declared; letting it also self-report would
   * make the tier a label with no mechanism behind it.
   */
  app.post("/jobs/:id/usage", { preHandler: requireAgent }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const agent = req.agent!;

    await assertAgentOwnsJob(agent, id);

    if (agent.tier === 2) {
      return reply.code(403).send({
        error:
          "Tier 2 agents do not self-report. Route your model calls through " +
          "POST /gateway/messages and the platform will meter them from the provider's response.",
      });
    }

    const body = (req.body as RawBody).parsed;
    const input = z
      .object({
        phase: z.union([z.literal(0), z.literal(1)]),
        // USDC, decimal. Converted to base units here so the agent never has to
        // reason about 6dp.
        amountUsdc: z.number().min(0).max(100_000),
        model: z.string().max(80).optional(),
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
      })
      .parse(body);

    const result = await recordUsage({
      jobId: id,
      phase: input.phase,
      amount: BigInt(Math.ceil(input.amountUsdc * 1_000_000)),
      source: "self-reported",
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });

    return serialize({
      ok: true,
      phaseTotal: result.phaseTotal,
      cap: result.cap,
      remaining: result.remaining,
      holdback:
        "Tier 1 token reimbursement settles 7 days after the job does. Fees settle immediately.",
    });
  });

  /** What was recorded, and who counted it. Public — employers should see this. */
  app.get("/jobs/:id/usage", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    return serialize(await usageBreakdown(id));
  });

  /**
   * Permissionless crank. Auto-accept on `review_ttl` is not a convenience —
   * a silent employer must not be able to freeze agent capital indefinitely.
   *
   * Auto-accepted work is rated a neutral 5 and flagged, because an employer
   * who reviews nothing auto-accepts bad work too and that has to stay
   * visible in the quality signal.
   *
   * Left open deliberately: anyone may advance a blown timer, and doing so can
   * only move a job to the state its own deadlines already dictate.
   */
  app.post("/crank", async () => {
    const now = new Date();
    const results = { autoAcceptedPlans: 0, autoAcceptedDeliverables: 0, expired: 0 };

    const stalePlans = await prisma.job.findMany({
      where: { state: "PLAN_PENDING", reviewExpiresAt: { lt: now } },
      take: 50,
    });
    for (const job of stalePlans) {
      await acceptPlan(job.employerAddress, job.id, true);
      results.autoAcceptedPlans++;
    }

    const staleReviews = await prisma.job.findMany({
      where: { state: "REVIEW_PENDING", reviewExpiresAt: { lt: now } },
      take: 50,
    });
    for (const job of staleReviews) {
      await finalizeJob(job.id, { outcome: OUTCOME.ACCEPTED, rating: 5, auto: true });
      results.autoAcceptedDeliverables++;
    }

    // Blown timers: unaccepted offer, unclaimed plan window, missed deadline.
    // The agent gets nothing and any bond is slashed — this is what makes
    // claiming a job non-free.
    const blown = await prisma.job.findMany({
      where: {
        OR: [
          { state: "OFFERED", offerExpiresAt: { lt: now } },
          { state: "CLAIMED", claimExpiresAt: { lt: now } },
          { state: { in: ["OPEN", "IN_PROGRESS"] }, deadline: { lt: now } },
        ],
      },
      take: 50,
    });
    for (const job of blown) {
      await finalizeJob(job.id, { outcome: OUTCOME.EXPIRED });
      results.expired++;
    }

    return { ...results, reviewTtlSeconds: REVIEW_TTL, ranAt: now.toISOString() };
  });
};

/**
 * Agent-initiated callbacks. Same HMAC as everything else an agent sends.
 */
export const callbackRoutes: FastifyPluginAsync = async (app) => {
  registerRawJsonParser(app);

  app.post("/jobs/:id/callback", { preHandler: requireAgent }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const agent = req.agent!;
    await assertAgentOwnsJob(agent, id);

    const body = z
      .object({
        kind: z.enum(["deliverable", "progress", "error"]),
        deliverable: z.string().max(200_000).optional(),
        message: z.string().max(2000).optional(),
      })
      .parse((req.body as RawBody).parsed);

    if (body.kind === "deliverable") {
      if (!body.deliverable) return reply.code(400).send({ error: "Missing deliverable" });
      return serialize(await submitDeliverable(agent.walletAddress, id, body.deliverable));
    }

    await event(
      id,
      body.kind === "error" ? "AGENT_ERROR" : "AGENT_PROGRESS",
      agent.walletAddress,
      body.message ?? null
    );
    return { ok: true };
  });
};

export { PHASE_EXECUTION, PHASE_PLANNING, verifySignature, formatUsdc };
