import type { FastifyReply, FastifyRequest } from "fastify";

import { prisma } from "../db.js";
import type { RawBody } from "../rawBody.js";
import { verifySignature } from "./dispatch.js";

/**
 * Authenticates a request *from* an agent.
 *
 * The platform already HMACs everything it sends an agent with that agent's
 * shared secret; this is the same contract in reverse. It is used by the usage
 * endpoint, the gateway, and the job callback — all three are ways an agent can
 * move money or influence a payout, and none of them may be open.
 *
 * `X-ACP-Agent` names the agent, `X-ACP-Signature` is the HMAC over the raw
 * body. The agent id is not a secret and is not treated as one: it only selects
 * which secret to verify against.
 */
export interface AgentIdentity {
  id: string;
  walletAddress: string;
  tier: number;
  sharedSecret: string;
}

export class AgentAuthError extends Error {
  constructor(message: string, readonly statusCode = 401) {
    super(message);
  }
}

export async function authenticateAgent(req: FastifyRequest): Promise<AgentIdentity> {
  const agentId = req.headers["x-acp-agent"];
  if (typeof agentId !== "string" || !agentId) {
    throw new AgentAuthError("Missing X-ACP-Agent header");
  }

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, walletAddress: true, tier: true, sharedSecret: true, status: true },
  });
  if (!agent) throw new AgentAuthError("Unknown agent");
  if (agent.status === "SUSPENDED") throw new AgentAuthError("Agent is suspended", 403);

  const body = req.body as RawBody | undefined;
  const raw = body?.raw ?? "";
  const signature = req.headers["x-acp-signature"];

  if (!verifySignature(agent.sharedSecret, raw, typeof signature === "string" ? signature : undefined)) {
    throw new AgentAuthError("Bad signature");
  }

  return {
    id: agent.id,
    walletAddress: agent.walletAddress,
    tier: agent.tier,
    sharedSecret: agent.sharedSecret,
  };
}

/**
 * An agent may only touch a job it actually holds. Without this an
 * authenticated agent could report usage against someone else's job and drain
 * a stranger's escrow up to its cap.
 */
export async function assertAgentOwnsJob(agent: AgentIdentity, jobId: string) {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, agentId: true, state: true },
  });
  if (!job) throw new AgentAuthError("No such job", 404);
  if (job.agentId !== agent.id) throw new AgentAuthError("That job is not yours", 403);
  return job;
}

/** Fastify preHandler wrapper. */
export async function requireAgent(req: FastifyRequest, reply: FastifyReply) {
  try {
    (req as FastifyRequest & { agent?: AgentIdentity }).agent = await authenticateAgent(req);
  } catch (e) {
    const err = e as AgentAuthError;
    return reply.code(err.statusCode ?? 401).send({ error: err.message });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    agent?: AgentIdentity;
  }
}
