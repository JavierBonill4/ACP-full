import Fastify from "fastify";
import { z } from "zod";

import { STUB_MODE, config, tierLabel } from "./config.js";
import {
  PlatformError,
  acceptOffer,
  postError,
  postProgress,
  submitDeliverable,
  submitPlan,
  verify,
} from "./platform.js";
import { buildPlan, research } from "./research.js";
import { syncRateCard } from "./ratecard.js";

/**
 * Reference ACP agent: researches a topic and returns a markdown deck.
 *
 * Implements the four routes in ARCHITECTURE.md §3.1. The platform is the only
 * caller and signs everything it sends, so every route below verifies the HMAC
 * before doing anything — an endpoint URL is not a secret, and without the
 * check anyone who found this host could make it burn tokens on their behalf.
 *
 * **Both work routes return 202 and report back via callback.** The platform's
 * dispatch timeout only has to cover an acknowledgement, so it can stay short
 * (15s) while the work itself runs against the job deadline, which is measured
 * in days. Holding an HTTP connection open for a multi-minute model call is a
 * good way to lose finished work to a proxy timeout.
 */

const app = Fastify({ logger: { level: "info" } });

/**
 * Raw body kept for signature verification. The HMAC is over the exact bytes
 * the platform sent; re-serialising the parsed object would not reproduce them.
 */
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  const raw = typeof body === "string" ? body : "";
  try {
    done(null, { raw, parsed: raw ? JSON.parse(raw) : {} });
  } catch {
    done(new SyntaxError("Body is not valid JSON"), undefined);
  }
});

interface Raw<T = Record<string, unknown>> {
  raw: string;
  parsed: T;
}

function authenticate(req: { body: unknown; headers: Record<string, unknown> }): boolean {
  const body = req.body as Raw | undefined;
  const sig = req.headers["x-acp-signature"];
  return verify(body?.raw ?? "", typeof sig === "string" ? sig : undefined);
}

const jobSchema = z.object({
  jobId: z.string(),
  title: z.string().default("Untitled job"),
  spec: z.string().default(""),
  plan: z.string().nullable().optional(),
  /** OPEN | OFFERED | CLAIMED | ... — decides whether the offer needs taking first. */
  state: z.string().default("CLAIMED"),
  jobType: z.enum(["OPEN", "DIRECT"]).default("OPEN"),
  deadline: z.string().optional(),
  caps: z
    .object({
      planningFeeUsdc: z.number().optional(),
      fixedFeeUsdc: z.number().optional(),
      planningTokenUsdc: z.number().optional(),
      tokenBudgetUsdc: z.number().optional(),
    })
    .optional(),
});

type Job = z.infer<typeof jobSchema>;

// ---------------------------------------------------------------------------

/** Unsigned by design — it carries no payload and reveals nothing sensitive. */
app.get("/health", async () => ({
  ok: true,
  version: "0.2.0",
  agent: "research-agent",
  tier: config.TIER,
  tierLabel,
  mode: STUB_MODE ? "stub" : "live",
}));

/**
 * Quote the job. Acknowledges immediately and submits the plan by callback.
 *
 * A direct hire arrives in OFFERED and has to be accepted before a plan is
 * valid — `submitPlan` requires CLAIMED. Doing it here rather than making the
 * platform dispatch a fifth route keeps the endpoint contract at four, and puts
 * the "do I want this job" decision in the agent, where it belongs.
 */
app.post("/plan", async (req, reply) => {
  if (!authenticate(req as never)) return reply.code(401).send({ error: "Bad signature" });

  const job = jobSchema.parse((req.body as Raw).parsed);
  app.log.info({ jobId: job.jobId, state: job.state }, "planning");

  void planAndSubmit(job);
  return reply.code(202).send({ accepted: true });
});

async function planAndSubmit(job: Job) {
  try {
    if (job.state === "OFFERED") {
      await acceptOffer(job.jobId);
      app.log.info({ jobId: job.jobId }, "offer accepted");
    }

    const plan = await buildPlan(job.jobId, job.title, job.spec);

    // Bid at the employer's ceiling rather than above it. The platform refuses
    // anything higher, and a job at a lower fee still earns reputation — which
    // is the scarcer thing when you have none.
    const ceiling = job.caps?.fixedFeeUsdc;
    if (ceiling !== undefined && plan.fixedFeeUsdc > ceiling) {
      app.log.warn(
        { asked: plan.fixedFeeUsdc, ceiling },
        "employer ceiling is below the asking fee; bidding at the ceiling"
      );
      plan.fixedFeeUsdc = ceiling;
    }
    const planCeiling = job.caps?.planningFeeUsdc;
    if (planCeiling !== undefined && plan.planningFeeUsdc > planCeiling) {
      plan.planningFeeUsdc = planCeiling;
    }

    await submitPlan(job.jobId, {
      outline: plan.outline,
      planningFeeUsdc: plan.planningFeeUsdc,
      fixedFeeUsdc: plan.fixedFeeUsdc,
    });
    app.log.info({ jobId: job.jobId }, "plan submitted");
  } catch (e) {
    const err = e as PlatformError;
    app.log.error({ err, jobId: job.jobId }, "planning failed");
    // Say so rather than going quiet. Silence means the job sits until
    // `claim_ttl` expires, the bond is slashed, and the employer learns nothing.
    await postError(job.jobId, `Planning failed: ${err.message}`).catch(() => {});
  }
}

/**
 * Do the work. Returns 202 immediately and delivers via callback, because
 * research takes minutes and the job deadline — not the HTTP request — is what
 * bounds it.
 */
app.post("/execute", async (req, reply) => {
  if (!authenticate(req as never)) return reply.code(401).send({ error: "Bad signature" });

  const job = jobSchema.parse((req.body as Raw).parsed);
  app.log.info({ jobId: job.jobId }, "executing");

  void researchAndDeliver(job);
  return reply.code(202).send({ accepted: true });
});

async function researchAndDeliver(job: Job) {
  try {
    const deck = await research(job.jobId, job.title, job.spec, async (m) => {
      // Progress is best-effort. A dropped heartbeat must not abort work the
      // agent has already paid for in tokens.
      await postProgress(job.jobId, m).catch(() => {});
    });

    const document = assemble(job.title, deck.markdown, {
      tier: config.TIER,
      stub: STUB_MODE,
      ...deck.usage,
    });

    await submitDeliverable(job.jobId, document);
    app.log.info({ jobId: job.jobId, calls: deck.usage.calls }, "delivered");
  } catch (e) {
    const err = e as PlatformError;
    app.log.error({ err, jobId: job.jobId }, "execution failed");
    await postError(job.jobId, err.message).catch(() => {});
  }
}

app.post("/cancel", async (req, reply) => {
  if (!authenticate(req as never)) return reply.code(401).send({ error: "Bad signature" });
  const job = jobSchema.parse((req.body as Raw).parsed);
  app.log.warn({ jobId: job.jobId }, "cancelled by platform");
  return { ok: true };
});

// ---------------------------------------------------------------------------

/**
 * Wraps the slides with a title slide and a provenance slide.
 *
 * The provenance slide is not decoration. It tells the employer which tier
 * produced the deck and therefore how the token bill they are about to pay was
 * arrived at — observed by the gateway, or asserted by this agent. That
 * distinction is the entire difference between the two tiers and it belongs in
 * the deliverable, not buried in a settings page.
 */
function assemble(
  title: string,
  slides: string,
  meta: { tier: number; stub: boolean; inputTokens: number; outputTokens: number; calls: number }
): string {
  const metering =
    meta.tier === 2
      ? "Token usage was measured by the platform gateway from the provider's own response. This agent never counted its own work."
      : "Token usage was self-reported by this agent. The platform bounded it against the employer's funded cap but did not verify it against the provider.";

  return [
    `# ${title}`,
    "",
    `> Researched and assembled by an ACP agent (tier ${meta.tier}).`,
    "",
    "---",
    "",
    slides,
    "",
    "---",
    "",
    "## Provenance",
    "",
    `- Produced by \`research-agent\` at tier ${meta.tier}`,
    `- ${meta.calls} model call${meta.calls === 1 ? "" : "s"}, ` +
      `${meta.inputTokens.toLocaleString()} in / ${meta.outputTokens.toLocaleString()} out`,
    `- ${metering}`,
    meta.stub
      ? "- **Stub mode: no model was called and the content above is placeholder text.**"
      : "- Content is model-generated and has not been independently verified",
    "",
    `> ${metering}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------

await syncRateCard(config.PLATFORM_API);

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(
    `research-agent on :${config.PORT} — ${tierLabel}${STUB_MODE ? " — STUB MODE" : ""}`
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}