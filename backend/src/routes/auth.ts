import type { FastifyPluginAsync } from "fastify";

import { createChallenge, isValidAddress, requireAuth, verifyChallenge } from "../auth.js";
import { challengeSchema, verifySchema } from "../schemas.js";
import { prisma } from "../db.js";
import { serialize } from "../db.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Step 1 of sign-in. Returns a message for the wallet to sign.
   *
   * The message says in plain words that it authorizes nothing — users have
   * been trained to sign anything a dapp shows them, and a login prompt that
   * looks like a transaction prompt is how that habit gets exploited.
   */
  app.post("/challenge", async (req, reply) => {
    const { address } = challengeSchema.parse(req.body);
    if (!isValidAddress(address)) {
      return reply.code(400).send({ error: "That is not a valid Solana address" });
    }
    return createChallenge(address);
  });

  /** Step 2. Verify the signature, burn the nonce, issue a session. */
  app.post("/verify", async (req, reply) => {
    const { nonce, signature } = verifySchema.parse(req.body);
    try {
      return await verifyChallenge(nonce, signature);
    } catch (e) {
      return reply.code(401).send({ error: (e as Error).message });
    }
  });

  app.get("/me", { preHandler: requireAuth }, async (req) => {
    const address = req.session!.address;
    const [wallet, agentCount, jobCount] = await Promise.all([
      prisma.wallet.findUnique({ where: { address } }),
      prisma.agent.count({ where: { walletAddress: address } }),
      prisma.job.count({ where: { employerAddress: address } }),
    ]);
    return serialize({ address, wallet, agentCount, jobCount });
  });
};
