import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { requireAuth } from "../auth.js";
import { prisma, serialize } from "../db.js";
import {
  checkHealth,
  createAgent,
  listAgents,
  listByCategory,
  presentAgent,
} from "../services/agents.js";
import { listCategories } from "../services/categories.js";
import { createAgentSchema, listAgentsQuery, updateAgentSchema } from "../schemas.js";

export const agentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Flat list. `kind` filters to one window's population.
   *
   * The frontend's general window calls this with `kind=GENERAL`; the
   * single-purpose window uses /by-category below instead of bucketing a flat
   * list client-side, because doing the grouping in two places is how the two
   * views drift.
   */
  app.get("/", async (req) => {
    const q = listAgentsQuery.parse(req.query);
    return serialize(await listAgents(q));
  });

  /** The single-purpose window, pre-grouped. Empty categories are omitted. */
  app.get("/by-category", async () => {
    return serialize(await listByCategory());
  });

  app.get("/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const agent = await prisma.agent.findUnique({
      where: { id },
      include: { category: true, wallet: true },
    });
    if (!agent) return reply.code(404).send({ error: "No such agent" });

    const recent = await prisma.job.findMany({
      where: { agentId: id, state: { in: ["SETTLED", "EXPIRED"] } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: {
        id: true, title: true, state: true, rating: true,
        updatedAt: true, autoAccepted: true,
      },
    });

    return serialize({ ...presentAgent(agent), recentJobs: recent });
  });

  /**
   * Register an agent.
   *
   * `kind` decides the window; the schema enforces that SINGLE_PURPOSE carries
   * exactly one category and GENERAL carries none. The response includes the
   * shared secret exactly once — it is not retrievable afterwards.
   */
  app.post("/", { preHandler: requireAuth }, async (req, reply) => {
    const input = createAgentSchema.parse(req.body);
    const result = await createAgent(req.session!.address, input);
    return reply.code(201).send(serialize(result));
  });

  app.patch("/:id", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const input = updateAgentSchema.parse(req.body);

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: "No such agent" });
    if (agent.walletAddress !== req.session!.address) {
      return reply.code(403).send({ error: "That is not your agent" });
    }

    const updated = await prisma.agent.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.endpoint ? { endpoint: input.endpoint } : {}),
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.descriptor
          ? {
              descriptor: JSON.stringify(input.descriptor),
              summary: input.descriptor.summary,
              basePlanningFee: BigInt(Math.round(input.descriptor.basePlanningFeeUsdc * 1e6)),
              baseFixedFee: BigInt(Math.round(input.descriptor.baseFixedFeeUsdc * 1e6)),
              avgCompletionMinutes: input.descriptor.avgCompletionMinutes,
            }
          : {}),
      },
      include: { category: true, wallet: true },
    });

    // Category is deliberately not editable. Moving an agent between windows
    // after it has a history would make its reputation read as if it were
    // earned doing something else.
    return serialize(presentAgent(updated));
  });

  app.post("/:id/health", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: "No such agent" });
    if (agent.walletAddress !== req.session!.address) {
      return reply.code(403).send({ error: "That is not your agent" });
    }
    return checkHealth(id);
  });
};

export const categoryRoutes: FastifyPluginAsync = async (app) => {
  /**
   * `includeEmpty=true` for the agent-creation form, where the point is to put
   * the first agent in a category. False for the browse window, where an empty
   * category is dead weight.
   */
  app.get("/", async (req) => {
    const { includeEmpty } = z
      .object({ includeEmpty: z.enum(["true", "false"]).default("false") })
      .parse(req.query);
    return listCategories({ includeEmpty: includeEmpty === "true" });
  });
};
