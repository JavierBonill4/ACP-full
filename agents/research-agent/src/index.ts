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
import { buildPptx, slugify } from "./deck-to-pptx.js";
import { syncRateCard } from "./ratecard.js";
import { chainEnabled, claimJob as chainClaimJob, registerWalletIfNeeded } from "./chain.js";

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
  /** On-chain job address, base58. Absent for jobs posted before the
   *  platform's on-chain wiring wrote this through — chain calls are simply
   *  skipped for those, same as when this agent has no keypair configured. */
  pda: z.string().optional(),
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
      await acceptOffer(job.jobId, job.pda);
      app.log.info({ jobId: job.jobId }, "offer accepted");
    } else if (job.jobType === "OPEN" && job.pda && chainEnabled) {
      // Open-marketplace path — claim_job instead of accept_offer. Not
      // exercised by the e2e script; if this throws, it's the first place
      // to check the on-chain ClaimJob accounts against chain.ts.
      await chainClaimJob(job.pda);
      app.log.info({ jobId: job.jobId }, "job claimed on-chain");
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

    await submitPlan(
      job.jobId,
      {
        outline: plan.outline,
        planningFeeUsdc: plan.planningFeeUsdc,
        fixedFeeUsdc: plan.fixedFeeUsdc,
      },
      job.pda
    );
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

    // The deliverable is a real .pptx now, not markdown wrapped in more
    // markdown — assemble() used to build a text wrapper the frontend's
    // SlideDeck component rendered; buildPptx renders title/content/
    // provenance as actual slides in a file someone can open in PowerPoint,
    // Keynote, or Google Slides.
    const pptxBuffer = await buildPptx(job.title, deck.markdown, {
      tier: config.TIER,
      stub: STUB_MODE,
      ...deck.usage,
    });

    await submitDeliverable(
      job.jobId,
      {
        filename: `${slugify(job.title)}.pptx`,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        base64: pptxBuffer.toString("base64"),
      },
      job.pda
    );
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
// The title-slide/provenance-slide wrapping this used to do as markdown text
// (`assemble()`) now happens as real slides in deck-to-pptx.ts's buildPptx.
// ---------------------------------------------------------------------------

await syncRateCard(config.PLATFORM_API);

if (chainEnabled) {
  // Idempotent (init_if_needed on-chain) — safe to run on every boot rather
  // than tracking whether a previous run already did it.
  await registerWalletIfNeeded(config.TIER as 1 | 2);
  app.log.info("on-chain wallet registered (or already was)");
} else {
  app.log.warn(
    "SOLANA_KEYPAIR_PATH / ACP_PROGRAM_ID not set — this agent will report job actions to " +
      "the platform's off-chain state only, and will not sign any on-chain transaction."
  );
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(
    `research-agent on :${config.PORT} — ${tierLabel}${STUB_MODE ? " — STUB MODE" : ""}${chainEnabled ? " — on-chain signing enabled" : ""}`
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