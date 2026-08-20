import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { formatUsdc } from "@acp/economics";

import { requireAuth } from "../auth.js";
import { prisma, serialize } from "../db.js";
import { env } from "../env.js";
import { registerRawJsonParser, type RawBody } from "../rawBody.js";
import { assertAgentOwnsJob, requireAgent } from "../services/agentAuth.js";
import { open, seal } from "../services/keyvault.js";
import { publishedRateCard, usageToBaseUnits } from "../services/ratecard.js";
import {
  PHASE_EXECUTION,
  PHASE_PLANNING,
  UsageError,
  recordObservedTokens,
} from "../services/usage.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * The T2 metering gateway.
 *
 * This is what makes tier 2 mean anything. A T2 agent does not call the model
 * provider directly and does not report its own usage — it calls here, the
 * gateway forwards the request using the agent's registered key, and the token
 * counts are read out of the **provider's own response**. The agent never
 * touches the number that determines its reimbursement.
 *
 * What this does and does not buy:
 *
 * - Metering becomes exact. An agent cannot inflate token counts, because it
 *   does not supply them.
 * - Code stays unverified. The gateway sees traffic, not implementation, so a
 *   T2 agent can still do nothing useful and bill for the tokens it burned
 *   doing it. That is what reputation is for.
 * - The platform holds key material. This is the only tier where that is true,
 *   and it is precisely why T1 exists.
 *
 * An agent that has a key registered but calls the provider directly anyway
 * simply produces a job with no gateway-observed usage — visible in the usage
 * breakdown, and worth flagging in review.
 */
export const gatewayRoutes: FastifyPluginAsync = async (app) => {
  registerRawJsonParser(app);

  app.get("/rate-card", async () => publishedRateCard());

  /**
   * Register a provider key. Wallet-authenticated: only the operator who owns
   * the agent may set it, and it is write-only — there is no route that returns
   * it, only the last four characters so you can confirm which key is stored.
   */
  app.post("/agents/:id/provider-key", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = (req.body as RawBody<{ apiKey?: string }>).parsed;
    const { apiKey } = z.object({ apiKey: z.string().min(20).max(400) }).parse(body);

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: "No such agent" });
    if (agent.walletAddress !== req.session!.address) {
      return reply.code(403).send({ error: "That is not your agent" });
    }
    if (agent.tier !== 2) {
      return reply.code(400).send({
        error:
          "Only tier 2 agents register a key with the platform. A tier 1 agent keeps its key " +
          "and reports its own usage — that is the entire difference between the tiers.",
      });
    }

    const sealed = seal(apiKey);
    await prisma.agent.update({
      where: { id },
      data: {
        providerKeyCiphertext: sealed.ciphertext,
        providerKeyIv: sealed.iv,
        providerKeyTag: sealed.tag,
        providerKeyHint: sealed.hint,
        providerKeySetAt: new Date(),
      },
    });

    return {
      ok: true,
      hint: `…${sealed.hint}`,
      warning:
        "Stored encrypted at rest under a server-held secret. This is not a KMS — anyone with " +
        "the database and the environment can recover it. Use a key scoped to this agent.",
    };
  });

  app.delete("/agents/:id/provider-key", { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: "No such agent" });
    if (agent.walletAddress !== req.session!.address) {
      return reply.code(403).send({ error: "That is not your agent" });
    }
    await prisma.agent.update({
      where: { id },
      data: {
        providerKeyCiphertext: null,
        providerKeyIv: null,
        providerKeyTag: null,
        providerKeyHint: null,
        providerKeySetAt: null,
      },
    });
    return { ok: true };
  });

  /**
   * The proxy. Agent-HMAC authenticated, scoped to a job the agent holds.
   *
   * The request body is passed through essentially untouched — this is not a
   * wrapper API with its own opinions, it is a metering tap. Adding parameters
   * here would mean the agent cannot use provider features the gateway has not
   * heard of, which is a good way to make T2 unusable.
   */
  app.post("/messages", { preHandler: requireAgent }, async (req, reply) => {
    const agent = req.agent!;
    const body = (req.body as RawBody<Record<string, unknown>>).parsed;

    const meta = z
      .object({
        jobId: z.string(),
        phase: z.union([z.literal(0), z.literal(1)]).default(PHASE_EXECUTION),
      })
      .parse({
        jobId: req.headers["x-acp-job"],
        phase: req.headers["x-acp-phase"] ? Number(req.headers["x-acp-phase"]) : undefined,
      });

    await assertAgentOwnsJob(agent, meta.jobId);

    if (agent.tier !== 2) {
      return reply.code(403).send({
        error:
          "The gateway is for tier 2 agents. A tier 1 agent calls its provider directly and " +
          "self-reports through POST /oracle/jobs/:id/usage.",
      });
    }

    const record = await prisma.agent.findUnique({
      where: { id: agent.id },
      select: {
        providerKeyCiphertext: true,
        providerKeyIv: true,
        providerKeyTag: true,
      },
    });

    if (!record?.providerKeyCiphertext || !record.providerKeyIv || !record.providerKeyTag) {
      return reply.code(400).send({
        error:
          "No provider key registered. POST it to /gateway/agents/:id/provider-key first — a " +
          "tier 2 agent cannot call the provider directly, that is what its tier promises.",
      });
    }

    let apiKey: string;
    try {
      apiKey = open({
        ciphertext: record.providerKeyCiphertext,
        iv: record.providerKeyIv,
        tag: record.providerKeyTag,
      });
    } catch {
      return reply.code(500).send({
        error:
          "Stored provider key could not be decrypted. GATEWAY_KEY_SECRET has probably changed " +
          "since it was saved — re-register the key.",
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.GATEWAY_TIMEOUT_MS);

    let upstream: Response;
    let payload: Record<string, unknown>;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
      payload = (await upstream.json()) as Record<string, unknown>;
    } catch (e) {
      const err = e as Error;
      return reply.code(502).send({
        error: err.name === "AbortError" ? "Provider timed out" : `Provider call failed: ${err.message}`,
      });
    } finally {
      clearTimeout(timer);
    }

    // Meter only what the provider says it billed. A failed call bills nothing,
    // so recording usage on an error response would charge the employer for the
    // agent's bad request.
    const usage = payload.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;

    if (!upstream.ok || !usage) {
      return reply.code(upstream.ok ? 502 : upstream.status).send(payload);
    }

    const observed = {
      model: typeof payload.model === "string" ? payload.model : String(body.model ?? "unknown"),
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    };

    let metered;
    try {
      metered = await recordObservedTokens(meta.jobId, meta.phase as 0 | 1, observed);
    } catch (e) {
      // The call already happened and the agent already owes its provider for
      // it. Returning the response while refusing to meter would hand the agent
      // free work; refusing the response after the provider billed would hand
      // it a loss. Surfacing the failure is the honest option in both cases
      // below — the difference is what the agent should do about it.
      const capBreach = e instanceof UsageError && e.statusCode === 400;
      return reply.code(capBreach ? 402 : 502).send({
        error: (e as Error).message,
        hint: capBreach
          ? "This would exceed the employer's funded cap so it cannot be reimbursed. Stop and " +
            "submit what you have."
          : "The usage was recorded off-chain but failed to confirm on the chain — this is a " +
            "platform-side problem, not something wrong with your call. Retry the request; if " +
            "it keeps failing, the job's on-chain token totals need scripts/replay-usage.ts run " +
            "before it settles.",
        response: payload,
      });
    }

    reply.header("x-acp-metered-usdc", formatUsdc(usageToBaseUnits(observed)));
    reply.header("x-acp-phase-total-usdc", formatUsdc(metered.phaseTotal));
    reply.header("x-acp-remaining-usdc", formatUsdc(metered.remaining));
    return payload;
  });

  /**
   * What the gateway observed for a job, so an employer can see whether a T2
   * agent actually used it.
   */
  app.get("/jobs/:id/usage", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const reports = await prisma.usageReport.findMany({
      where: { jobId: id },
      orderBy: { createdAt: "asc" },
    });
    return serialize({
      reports,
      inputTokens: reports.reduce((n, r) => n + (r.inputTokens ?? 0), 0),
      outputTokens: reports.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
      total: reports.reduce((n, r) => n + r.amount, 0n),
    });
  });
};

export { PHASE_EXECUTION, PHASE_PLANNING };