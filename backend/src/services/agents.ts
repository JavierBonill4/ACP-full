import type { Agent, Category, Wallet } from "@prisma/client";

import { prisma } from "../db.js";
import { resolveCategory } from "./categories.js";
import { assertEndpointAllowed, dispatch, newSharedSecret } from "./dispatch.js";
import type { CreateAgentInput } from "../schemas.js";

export class AgentError extends Error {
  readonly statusCode = 400;
}

type AgentWithRelations = Agent & { category: Category | null; wallet: Wallet };

/**
 * The shape the agents page renders from. Reputation is always accompanied by
 * the lifetime counters — the score floors at zero, so `wrs: 0` alone cannot
 * distinguish a brand-new wallet from one with eleven rejections. Any view
 * that shows the score without the record is lying by omission.
 */
export function presentAgent(a: AgentWithRelations) {
  const descriptor = JSON.parse(a.descriptor) as Record<string, unknown>;
  const lifetime = a.wallet.jobsCompleted + a.wallet.jobsRejected + a.wallet.jobsExpired;

  return {
    id: a.id,
    name: a.name,
    summary: a.summary,
    kind: a.kind,
    category: a.category
      ? { id: a.category.id, slug: a.category.slug, label: a.category.label }
      : null,
    wallet: a.walletAddress,
    tier: a.tier,
    status: a.status,
    endpointHost: safeHost(a.endpoint),
    lastHealthyAt: a.lastHealthyAt,
    descriptor,
    basePlanningFee: a.basePlanningFee,
    baseFixedFee: a.baseFixedFee,
    avgCompletionMinutes: a.avgCompletionMinutes,
    reputation: {
      wrs: a.wallet.cachedWrs,
      jobsCompleted: a.wallet.jobsCompleted,
      jobsRejected: a.wallet.jobsRejected,
      jobsExpired: a.wallet.jobsExpired,
      totalValueSettled: a.wallet.totalValueSettled,
      firstSeen: a.wallet.chainFirstSeen,
      lifetimeJobs: lifetime,
      /// True for a wallet with no history at all, so the UI can label it
      /// "new" rather than implying it earned a zero.
      isNew: lifetime === 0,
    },
    createdAt: a.createdAt,
  };
}

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid";
  }
}

/**
 * Register an agent.
 *
 * The category rules are enforced here as well as in the zod schema, because
 * this is the function the seed script and any future admin path go through
 * too, and "which window does this agent appear in" must have exactly one
 * answer derived from exactly one field.
 */
export async function createAgent(walletAddress: string, input: CreateAgentInput) {
  await assertEndpointAllowed(input.endpoint);

  let categoryId: string | null = null;
  if (input.kind === "SINGLE_PURPOSE") {
    categoryId = await resolveCategory(
      { categoryId: input.categoryId, newCategoryLabel: input.newCategoryLabel },
      walletAddress
    );
  } else if (input.categoryId || input.newCategoryLabel) {
    throw new AgentError(
      "General-purpose agents are not browsed by category. Register it as single-purpose instead."
    );
  }

  const duplicate = await prisma.agent.findFirst({
    where: { walletAddress, name: input.name },
  });
  if (duplicate) {
    throw new AgentError(`You already have an agent called "${input.name}"`);
  }

  const sharedSecret = newSharedSecret();
  const d = input.descriptor;

  await prisma.wallet.upsert({
    where: { address: walletAddress },
    create: { address: walletAddress, tier: input.tier },
    update: { tier: input.tier },
  });

  const agent = await prisma.agent.create({
    data: {
      walletAddress,
      name: input.name,
      summary: d.summary,
      kind: input.kind,
      categoryId,
      endpoint: input.endpoint,
      sharedSecret,
      descriptor: JSON.stringify(d),
      basePlanningFee: BigInt(Math.round(d.basePlanningFeeUsdc * 1_000_000)),
      baseFixedFee: BigInt(Math.round(d.baseFixedFeeUsdc * 1_000_000)),
      avgCompletionMinutes: d.avgCompletionMinutes,
      tier: input.tier,
      // Optimistic. The health check below flips it if the endpoint is not
      // answering — a registration should not fail outright because the
      // operator has not deployed yet.
      status: "ACTIVE",
    },
    include: { category: true, wallet: true },
  });

  const health = await checkHealth(agent.id);

  return {
    agent: presentAgent({ ...agent, status: health.status }),
    // Shown once and never again. It is the only thing that lets the agent
    // tell a real dispatch from anyone who guessed its endpoint.
    sharedSecret,
    health,
  };
}

export async function checkHealth(agentId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw new AgentError("No such agent");

  const res = await dispatch.health(agent.endpoint, agent.sharedSecret);
  const healthy = res.ok && res.body?.ok === true;

  await prisma.agent.update({
    where: { id: agentId },
    data: {
      status: healthy ? "ACTIVE" : agent.status === "SUSPENDED" ? "SUSPENDED" : "UNREACHABLE",
      lastHealthyAt: healthy ? new Date() : agent.lastHealthyAt,
      lastHealthError: healthy ? null : (res.error ?? "Endpoint did not report ok"),
    },
  });

  return {
    healthy,
    status: healthy ? "ACTIVE" : "UNREACHABLE",
    error: res.error ?? null,
    latencyMs: res.durationMs,
    version: res.body?.version ?? null,
  };
}

export interface ListAgentsOptions {
  kind?: "GENERAL" | "SINGLE_PURPOSE";
  category?: string;
  wallet?: string;
  q?: string;
  sort?: "reputation" | "newest" | "fee" | "speed";
  limit?: number;
}

/**
 * Discovery. Low-reputation agents are **scarce, not blocked** — the default
 * sort favours WRS, but nothing filters a new agent out, and the frontend
 * surfaces them separately for employers trading risk for price.
 */
export async function listAgents(opts: ListAgentsOptions) {
  const agents = await prisma.agent.findMany({
    where: {
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.wallet ? { walletAddress: opts.wallet } : {}),
      ...(opts.category
        ? { category: { OR: [{ id: opts.category }, { slug: opts.category }] } }
        : {}),
      ...(opts.q
        ? {
            OR: [
              { name: { contains: opts.q } },
              { summary: { contains: opts.q } },
            ],
          }
        : {}),
      status: { not: "SUSPENDED" },
    },
    include: { category: true, wallet: true },
    take: opts.limit ?? 50,
  });

  const presented = agents.map(presentAgent);

  switch (opts.sort ?? "reputation") {
    case "newest":
      presented.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      break;
    case "fee":
      presented.sort((a, b) => Number(a.baseFixedFee - b.baseFixedFee));
      break;
    case "speed":
      presented.sort((a, b) => a.avgCompletionMinutes - b.avgCompletionMinutes);
      break;
    default:
      presented.sort((a, b) => {
        const byScore = Number(b.reputation.wrs - a.reputation.wrs);
        if (byScore !== 0) return byScore;
        // Tie-break on completed work, so among a wall of zero-rep agents the
        // one that has actually finished something ranks first.
        return b.reputation.jobsCompleted - a.reputation.jobsCompleted;
      });
  }

  return presented;
}

/**
 * The single-purpose window's data shape: every non-empty category with its
 * agents already grouped, so the client does not have to bucket a flat list
 * and cannot get the buckets wrong.
 */
export async function listByCategory(limitPerCategory = 24) {
  const categories = await prisma.category.findMany({
    orderBy: [{ isSeed: "desc" }, { label: "asc" }],
    include: {
      agents: {
        where: { kind: "SINGLE_PURPOSE", status: { not: "SUSPENDED" } },
        include: { category: true, wallet: true },
        take: limitPerCategory,
      },
    },
  });

  return categories
    .filter((c) => c.agents.length > 0)
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      label: c.label,
      description: c.description,
      isSeed: c.isSeed,
      agentCount: c.agents.length,
      agents: c.agents
        .map(presentAgent)
        .sort((a, b) => Number(b.reputation.wrs - a.reputation.wrs)),
    }));
}
