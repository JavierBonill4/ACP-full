import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { rejectionRateBps } from "@acp/economics";

import { prisma, serialize } from "../db.js";
import { explorerAddress, walletProfilePda } from "../chain.js";
import { PublicKey } from "@solana/web3.js";
import { presentAgent } from "../services/agents.js";

export const walletRoutes: FastifyPluginAsync = async (app) => {
  /**
   * The reputation view. There is one score and it belongs to the wallet.
   *
   * Everything here is returned together on purpose: the score floors at
   * zero, so it is meaningless without the lifetime counters beside it.
   * `(rep 0, 0 jobs)` and `(rep 0, 14 jobs, 11 rejected)` have to be trivially
   * distinguishable, and a client that fetches only the score cannot do that.
   */
  app.get("/:address", async (req, reply) => {
    const { address } = z.object({ address: z.string() }).parse(req.params);

    let profilePda: string;
    try {
      profilePda = walletProfilePda(new PublicKey(address)).toBase58();
    } catch {
      return reply.code(400).send({ error: "That is not a valid Solana address" });
    }

    const wallet = await prisma.wallet.findUnique({
      where: { address },
      include: {
        agents: { include: { category: true, wallet: true } },
      },
    });

    if (!wallet) {
      return serialize({
        address,
        exists: false,
        profilePda,
        explorer: explorerAddress(address),
        reputation: {
          wrs: 0n,
          jobsCompleted: 0, jobsRejected: 0, jobsExpired: 0,
          totalValueSettled: 0n, lifetimeJobs: 0, isNew: true,
        },
        asEmployer: { jobsPosted: 0, jobsRejected: 0, rejectionRateBps: 0n },
        agents: [],
      });
    }

    const [jobsPosted, employerRejections] = await Promise.all([
      prisma.job.count({ where: { employerAddress: address } }),
      prisma.job.count({
        where: { employerAddress: address, state: "SETTLED", rating: null },
      }),
    ]);

    const lifetime = wallet.jobsCompleted + wallet.jobsRejected + wallet.jobsExpired;

    return serialize({
      address,
      exists: true,
      profilePda,
      explorer: explorerAddress(address),
      tier: wallet.tier,
      reputation: {
        wrs: wallet.cachedWrs,
        jobsCompleted: wallet.jobsCompleted,
        jobsRejected: wallet.jobsRejected,
        jobsExpired: wallet.jobsExpired,
        totalValueSettled: wallet.totalValueSettled,
        firstSeen: wallet.chainFirstSeen ?? wallet.createdAt,
        lifetimeJobs: lifetime,
        isNew: lifetime === 0,
        syncedAt: wallet.chainSyncedAt,
      },
      /**
       * Published so agents can price rejection risk before bidding. It is a
       * disclosed statistic with no automated penalty — the protocol prices
       * rejection abuse rather than policing it.
       */
      asEmployer: {
        jobsPosted,
        jobsRejected: employerRejections,
        rejectionRateBps: rejectionRateBps(BigInt(employerRejections), BigInt(jobsPosted)),
      },
      agents: wallet.agents.map((a) => presentAgent({ ...a, wallet })),
    });
  });
};
