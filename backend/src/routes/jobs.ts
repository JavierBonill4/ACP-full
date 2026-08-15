import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { OUTCOME } from "@acp/economics";

import { optionalAuth, requireAuth } from "../auth.js";
import { prisma, serialize } from "../db.js";
import { explorerTx } from "../chain.js";
import { assertTxSucceeded } from "../services/chainVerify.js";
import {
  acceptOffer,
  acceptPlan,
  claimJob,
  createCustomJob,
  createDirectJob,
  dispatchDirectOffer,
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
    // long, and the browse feed does not need it. deliverableBase64 never
    // belongs in a list payload regardless of view — it's fetched by itself
    // from GET /:id/deliverable when actually needed.
    return serialize(
      jobs.map(({ specText, planText, deliverableText, deliverableBase64, ...rest }) => rest)
    );
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
    const canSeeDeliverable = isParty || job.state === "SETTLED";

    const { deliverableBase64, ...jobWithoutBlob } = job;

    return serialize({
      ...jobWithoutBlob,
      // The deliverable is the thing being paid for. Withholding it from
      // passers-by until settlement is the point of the commit-then-reveal
      // shape; the hash is public throughout so nothing can be swapped.
      // The file itself (deliverableBase64) is never inlined into this
      // payload even for a party who can see it — GET /:id/deliverable
      // serves it separately so this response stays a reasonable size.
      deliverableText: canSeeDeliverable ? job.deliverableText : null,
      deliverableFilename: canSeeDeliverable ? job.deliverableFilename : null,
      deliverableMimeType: canSeeDeliverable ? job.deliverableMimeType : null,
      specText: isParty || job.jobType === "OPEN" ? job.specText : null,
      viewerRole: me === job.employerAddress ? "employer" : me === job.agentAddress ? "agent" : "observer",
    });
  });

  /**
   * Serves the actual deliverable file. Split out from GET /:id so that
   * route's payload doesn't carry a base64 blob every time a job is loaded —
   * this is fetched only when someone actually wants to open/download it.
   *
   * Same visibility rule as deliverableText on GET /:id: employer, agent, or
   * anyone once the job has SETTLED.
   */
  app.get("/:id/deliverable", { preHandler: optionalAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = await prisma.job.findUnique({
      where: { id },
      select: {
        employerAddress: true,
        agentAddress: true,
        state: true,
        deliverableBase64: true,
        deliverableMimeType: true,
        deliverableFilename: true,
      },
    });
    if (!job) return reply.code(404).send({ error: "No such job" });

    const me = req.session?.address;
    const isParty = me === job.employerAddress || me === job.agentAddress;
    if (!isParty && job.state !== "SETTLED") {
      return reply.code(403).send({ error: "Not visible until the job settles" });
    }
    if (!job.deliverableBase64) return reply.code(404).send({ error: "No deliverable yet" });

    const bytes = Buffer.from(job.deliverableBase64, "base64");
    return reply
      .header("content-type", job.deliverableMimeType ?? "application/octet-stream")
      .header(
        "content-disposition",
        `attachment; filename="${(job.deliverableFilename ?? "deliverable").replace(/"/g, "")}"`
      )
      .send(bytes);
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
   *
   * Verified against `job.pda` (computed off-chain at creation, before this
   * transaction ever existed — see createCustomJob/createDirectJob) before
   * being trusted: without that check, any successful signature this wallet
   * ever produced would satisfy this route, not just the one that actually
   * funded this job's escrow.
   */
  app.post("/:id/confirm", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { signature } = confirmTxSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }

    await assertTxSucceeded(signature, job.pda ?? undefined);

    await prisma.jobEvent.create({
      data: { jobId: id, kind: "ESCROW_FUNDED", actor: req.session!.address, txSig: signature },
    });

    // Only now is the on-chain job account guaranteed to exist — safe to
    // tell a directly-hired agent about it. See dispatchDirectOffer's
    // comment in services/jobs.ts for why this can't happen at job-creation
    // time instead.
    void dispatchDirectOffer(id);

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
  //
  // Every route below now requires the SAME `signature` field `/confirm`
  // does: the employer signs the matching on-chain instruction
  // (accept_plan / reject_plan / accept_deliverable / cancel_job — see
  // frontend/lib/transactions.ts) in the browser first,
  // THEN calls here with the confirmed signature. `assertTxSucceeded`
  // verifies it actually happened and actually touched this job's `pda`
  // before any DB state changes or reputation is written — without that,
  // these routes would trust whatever the client claims, which is exactly
  // the gap PATCHES-5.md step 5 exists to close.

  app.post("/:id/accept-plan", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { signature } = confirmTxSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }

    await assertTxSucceeded(signature, job.pda ?? undefined);

    return serialize(await acceptPlan(req.session!.address, id, false, signature));
  });

  app.post("/:id/reject-plan", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { signature } = confirmTxSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }

    await assertTxSucceeded(signature, job.pda ?? undefined);

    return serialize(
      await finalizeJob(id, {
        outcome: OUTCOME.PLAN_REJECTED,
        actor: req.session!.address,
        txSig: signature,
      })
    );
  });

  app.post("/:id/accept", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rating, comment, tip } = rateSchema.parse(req.body);
    const { signature } = confirmTxSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }

    // This is the payout transaction — the strongest reason of any route
    // here to confirm the signature actually references this job's pda
    // before reputation and settlement get written off it. There is no
    // `/:id/reject` counterpart: once a deliverable is submitted, its fee +
    // token payout is unconditional (see accept_deliverable's doc comment
    // in lib.rs). The only decision left here is the optional tip, already
    // validated against MAX_TIP by rateSchema and re-enforced on-chain by
    // AcpError::TipTooHigh.
    await assertTxSucceeded(signature, job.pda ?? undefined);

    return serialize(
      await finalizeJob(id, {
        outcome: OUTCOME.ACCEPTED,
        rating,
        comment,
        tip,
        actor: req.session!.address,
        txSig: signature,
      })
    );
  });

  app.post("/:id/cancel", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { signature } = confirmTxSchema.parse(req.body);
    const job = await prisma.job.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "No such job" });
    if (job.employerAddress !== req.session!.address) {
      return reply.code(403).send({ error: "Not your job" });
    }
    if (!["OPEN", "OFFERED"].includes(job.state)) {
      return reply.code(400).send({ error: "A claimed job cannot be cancelled" });
    }

    await assertTxSucceeded(signature, job.pda ?? undefined);

    return serialize(
      await finalizeJob(id, {
        outcome: OUTCOME.EXPIRED,
        actor: req.session!.address,
        txSig: signature,
      })
    );
  });
};