import { z } from "zod";

/**
 * One codebase, two agents. The only thing that differs between them is `TIER`,
 * and everything downstream of that follows automatically:
 *
 *   TIER=1  keeps its own provider key, calls Anthropic directly, and reports
 *           its own token usage to the platform.
 *   TIER=2  holds no key locally; the platform holds it and proxies every call,
 *           metering from the provider's response. The agent never reports
 *           usage because it is never trusted to count.
 *
 * Run them as `npm run t1` and `npm run t2` against `.env.t1` / `.env.t2`.
 */
const schema = z
  .object({
    PORT: z.coerce.number().default(5101),

    // --- platform ---------------------------------------------------------
    PLATFORM_API: z.string().url().default("http://localhost:4000/api/v1"),
    /** Issued once when the agent is registered. Signs every exchange, both ways. */
    ACP_AGENT_ID: z.string().min(1),
    ACP_SHARED_SECRET: z.string().min(32),

    TIER: z.coerce.number().int().min(1).max(2).default(1),

    // --- model ------------------------------------------------------------
    /**
     * T1 only. A T2 agent that sets this is misconfigured — it means the key is
     * sitting on the agent host *and* with the platform, which is the worst of
     * both arrangements.
     */
    ANTHROPIC_API_KEY: z.string().optional(),
    RESEARCH_MODEL: z.string().default("claude-sonnet-5"),
    WRITE_MODEL: z.string().default("claude-opus-5"),

    /** Slides in the returned deck, excluding title and sources. */
    DECK_SLIDES: z.coerce.number().int().min(3).max(20).default(8),

    // --- pricing ----------------------------------------------------------
    /** Flat fee charged for producing the plan, kept even if the plan is rejected. */
    PLANNING_FEE_USDC: z.coerce.number().min(0).default(1),
    /** Flat completion fee. */
    FIXED_FEE_USDC: z.coerce.number().min(0).default(15),
  })
  .superRefine((v, ctx) => {
    if (v.TIER === 1 && !v.ANTHROPIC_API_KEY) {
      // Not fatal — the agent falls back to a deterministic stub so the loop is
      // still demonstrable — but it must be loud, because the token counts it
      // reports in that mode are fabricated.
      console.warn(
        "\n  ANTHROPIC_API_KEY is not set. Running in STUB mode: the deck is canned and the\n" +
          "  usage figures reported to the platform are invented. Fine for exercising the\n" +
          "  lifecycle, useless as a metering demonstration.\n"
      );
    }
    if (v.TIER === 2 && v.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_API_KEY"],
        message:
          "A tier 2 agent must not hold a provider key locally — the platform holds it and " +
          "proxies calls. Remove ANTHROPIC_API_KEY, or set TIER=1.",
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error("\nInvalid agent configuration:\n");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".") || "_"}: ${issue.message}`);
  }
  console.error("\nCopy .env.example to .env.t1 / .env.t2 and fill them in.\n");
  process.exit(1);
}

export const config = parsed.data;

/** True when no real model call is possible and output is canned. */
export const STUB_MODE = config.TIER === 1 && !config.ANTHROPIC_API_KEY;

export const tierLabel = config.TIER === 2 ? "T2 · metered via gateway" : "T1 · self-reported";
