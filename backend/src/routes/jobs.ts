import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { OUTCOME } from "@acp/economics";

import { optionalAuth, requireAuth } from "../auth.js";
import { prisma, serialize } from "../db.js";
import { explorerTx } from "../chain.js";
import {
  acceptOffer,
  acceptPlan,
  claimJob,
  createCustomJob,
  createDirectJob,
  finalizeJob,
  quote,
  submitDeliverable,
  submitPlan,
} from "../services/jobs.js";
import {
  confirmTxSchema,
  createCustomJobSchema,
  createDirectJobSchema,
  rateSchema,
  submitDeliverableSchema,
  submitPlanSchema,
} from "../schemas.js";

const idParam = z.object({ id: z.string() });

export const jobRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Price a job before the employer commits. Same arithmetic as settlement,
   * so the confirm dialog and the program agree.
   */
  app.post("/quote", async (req) => {
    const body = z
      .object({
        planningFeeCap: z.coerce.bigint(),
        fixedFeeCap: z.coerce.bigint(),
        planningTokenCap: z.coerce.bigint(),
        tokenBudgetCap: z.coerce.bigint(),
        tier: z.coerce.number().int().min(1).max(2),
        jobType: z.enum(["OPEN", "DIRECT"]),
      })
      .parse(req.body);
    return serialize(quote(body, body.tier, body.jobType));
  });

  app.get("/", { preHandler: optionalAuth }, async (req) => {
    const q = z
      .object({
        state: z.string().optional(),
        type: z.enum(["OPEN", "DIRECT"]).optional(),
        employer: z.string().optional(),
        agent: z.string().optional(),
        mine: z.enum(["true", "false"]).default("false"),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(req.query);

    const me = req.session?.address;
    const jobs = await prisma.job.findMany({
      where: {
        ...(q.state ? { state: { in: q.state.split(",") } } : {}),
        ...(q.type ? { jobType: q.type } : {}),
        ...(q.employer ? { employerAddress: q.employer } : {}),
        ...(q.agent ? { agentId: q.agent } : {}),
        ...(q.mine === "true" && me
          ? { OR: [{ employerAddress: me }, { agentAddress: me }] }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: {
        agent: { select: { id: true, name: true, kind: true } },
        category: { select: { slug: true, label: true } },
      },
    });

    // Spec text is not returned in list views. It is the employer's, it can be
    // long, and the browse feed does not need it.
    return serialize(jobs.map(({ specText, planText, deliverableText, ...rest }) => rest));
  });

  app.get("/:id", { preHandler: optionalAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await prisma.job.findUnique({
      where: { id },
      include: {
        agent: { select: { id: true, name: true, kind: true, tier: true, walletAddress: true } },
        category: { select: { slug: true, label: true } },
        events: { orderBy: { createdAt: "asc" } },
        usageReports: { orderBy: { createdAt: "asc" } },
        ratings: true,
      },
    });
    if (!job) return reply.code(404).send({ error: "No such job" });

    const me = req.session?.address;
    const isParty = me === job.employerAddress || me === job.agentAddress;

    return serialize({
      ...job,
      // The deliverable is the thing being paid for. Withholding it from
      // passers-by until settlement is the point of the commit-then-reveal
      // shape; the hash is public throughout so nothing can be swapped.
      deliverableText: isParty || job.state === "SETTLED" ? job.deliverableText : null,
      specText: isParty || job.jobType === "OPEN" ? job.specText : null,
      viewerRole: me === job.employerAddress ? "employer" : me === job.agentAddress ? "agent" : "observer",
    });
  });

  // --- creation ------------------------------------------------------------

  /** General window: a custom job, open to any general-purpose agent. */
  app.post("/custom", { preHandler: requireAuth }, async (req, reply) => {
    const input = createCustomJobSchema.parse(req.body);
    const job = await createCustomJob(req.session!.address, input);
    return reply.code(201).send(serialize(job));
  });

  /** Single-purpose window: hire one named agent. */
  app.post("/direct", { preHandler: requireAuth }, async (req, reply) => {
    const input = createDirectJobSchema.parse(req.body);
    const job = await createDirectJob(req.session!.address, input);
    return reply.code(201).send(serialize(job));
  });

  /**
   * The employer signs `post_job` in the browser; this records the confirmed
   * signature. Until it lands the row exists but no money has moved, which is
   * why `state` is not advanced anywhere except here for creation.
   */
  app.post("/:id/confirm", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { signature } = confirmTxSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }
    await prisma.jobEvent.create({
      data: { jobId: id, kind: "ESCROW_FUNDED", actor: req.session!.address, txSig: signature },
    });
    return { ok: true, explorer: explorerTx(signature) };
  });

  // --- agent side ----------------------------------------------------------

  app.post("/:id/claim", { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { agentId } = z.object({ agentId: z.string() }).parse(req.body);
    return serialize(await claimJob(req.session!.address, id, agentId));
  });

  app.post("/:id/accept-offer", { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    return serialize(await acceptOffer(req.session!.address, id));
  });

  app.post("/:id/plan", { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const input = submitPlanSchema.parse(req.body);
    return serialize(await submitPlan(req.session!.address, id, input));
  });

  app.post("/:id/deliverable", { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { deliverable } = submitDeliverableSchema.parse(req.body);
    return serialize(await submitDeliverable(req.session!.address, id, deliverable));
  });

  // --- employer side -------------------------------------------------------

  app.post("/:id/accept-plan", { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    return serialize(await acceptPlan(req.session!.address, id));
  });

  app.post("/:id/reject-plan", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }
    return serialize(
      await finalizeJob(id, { outcome: OUTCOME.PLAN_REJECTED, actor: req.session!.address })
    );
  });

  app.post("/:id/accept", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rating, comment } = rateSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }
    return serialize(
      await finalizeJob(id, {
        outcome: OUTCOME.ACCEPTED,
        rating,
        comment,
        actor: req.session!.address,
      })
    );
  });

  app.post("/:id/reject", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }
    // Rejected work is not licensed. The employer receives no rights to it —
    // this has to be in the ToS and in the rejection UI, not just here.
    return serialize(
      await finalizeJob(id, {
        outcome: OUTCOME.DELIVERABLE_REJECTED,
        actor: req.session!.address,
      })
    );
  });

  app.post("/:id/cancel", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }
    if (!["OPEN", "OFFERED"].includes(job.state)) {
      return reply.code(400).send({ error: "A claimed job cannot be cancelled" });
    }
    return serialize(
      await finalizeJob(id, { outcome: OUTCOME.EXPIRED, actor: req.session!.address })
    );
  });
};
