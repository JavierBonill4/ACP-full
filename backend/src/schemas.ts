import { z } from "zod";
import { TIER_RECONCILED, TIER_METERED, MAX_TIP } from "@acp/economics";

export const AGENT_KINDS = ["GENERAL", "SINGLE_PURPOSE"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const JOB_TYPES = ["OPEN", "DIRECT"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATES = [
  "OPEN",
  "OFFERED",
  "CLAIMED",
  "PLAN_PENDING",
  "IN_PROGRESS",
  "REVIEW_PENDING",
  "SETTLED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type JobState = (typeof JOB_STATES)[number];

const tier = z.union([z.literal(TIER_RECONCILED), z.literal(TIER_METERED)]);

/** USDC as a decimal string or number, converted to base units. */
const usdc = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be a non-negative amount" });
      return z.NEVER;
    }
    // Round at 6dp rather than truncating, so 0.1 + 0.2 style float error in
    // the browser does not quietly shave a base unit off every quote.
    return BigInt(Math.round(n * 1_000_000));
  });

/**
 * The operator's self-description. Free-form within this shape, stored as
 * JSON, and never hashed on-chain — nothing here is verified. Reputation is
 * the only check on whether an agent does what it says, which is why it is the
 * only score.
 */
export const descriptorSchema = z.object({
  summary: z.string().min(20, "Say what this agent actually does").max(400),
  capabilities: z.array(z.string().min(1).max(60)).min(1).max(12),
  inputSchema: z.record(z.unknown()).optional(),
  outputSchema: z.record(z.unknown()).optional(),
  models: z.array(z.string().min(1).max(80)).max(8).default([]),
  avgCompletionMinutes: z.number().int().min(1).max(60 * 24 * 30).default(60),
  basePlanningFeeUsdc: z.number().min(0).max(10_000).default(0),
  baseFixedFeeUsdc: z.number().min(0).max(10_000).default(0),
  contact: z.string().max(200).optional(),
  docsUrl: z.string().url().max(300).optional(),
});
export type Descriptor = z.infer<typeof descriptorSchema>;

/**
 * `kind` is the only thing that decides which window an agent appears in.
 *
 * The refinements below are the fix for agents landing in the wrong view: a
 * SINGLE_PURPOSE agent must resolve to exactly one category, and a GENERAL
 * agent must not carry one at all. Routing on "did they happen to supply a
 * category" is what let a general agent with a stray category id show up in a
 * category window, and a single-purpose agent with none show up nowhere.
 */
export const createAgentSchema = z
  .object({
    name: z.string().min(2).max(60),
    kind: z.enum(AGENT_KINDS),
    endpoint: z.string().url().max(300),
    descriptor: descriptorSchema,
    tier: tier.default(TIER_RECONCILED),
    categoryId: z.string().cuid().optional().nullable(),
    newCategoryLabel: z.string().min(2).max(48).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "SINGLE_PURPOSE" && !v.categoryId && !v.newCategoryLabel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryId"],
        message: "Single-purpose agents need a category — pick one or name a new one",
      });
    }
    if (v.kind === "GENERAL" && (v.categoryId || v.newCategoryLabel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["categoryId"],
        message:
          "General-purpose agents are not browsed by category. Register it as single-purpose instead.",
      });
    }
  });
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  endpoint: z.string().url().max(300).optional(),
  descriptor: descriptorSchema.optional(),
  tier: tier.optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

export const listAgentsQuery = z.object({
  kind: z.enum(AGENT_KINDS).optional(),
  category: z.string().optional(),
  wallet: z.string().optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(["reputation", "newest", "fee", "speed"]).default("reputation"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * A custom job written in the general window. No agent is named — it goes to
 * the OPEN pool and a general-purpose agent claims it with a bond.
 */
export const createCustomJobSchema = z.object({
  title: z.string().min(4).max(120),
  spec: z.string().min(20, "Describe the job in enough detail to be quoted").max(20_000),
  planningFeeCap: usdc,
  fixedFeeCap: usdc,
  planningTokenCap: usdc,
  tokenBudgetCap: usdc,
  minTier: tier.default(TIER_RECONCILED),
  deadline: z.coerce.date(),
});

/**
 * A direct hire from the single-purpose window. The agent is named; fees are
 * pre-filled from its descriptor and pinned into the job at post time.
 */
export const createDirectJobSchema = z.object({
  agentId: z.string().cuid(),
  title: z.string().min(4).max(120),
  spec: z.string().min(20).max(20_000),
  planningFeeCap: usdc,
  fixedFeeCap: usdc,
  planningTokenCap: usdc,
  tokenBudgetCap: usdc,
  deadline: z.coerce.date(),
});

export const submitPlanSchema = z.object({
  outline: z.string().min(20).max(20_000),
  planningFee: usdc,
  fixedFee: usdc,
});

export const submitDeliverableSchema = z.object({
  deliverable: z.object({
    filename: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(200),
    base64: z.string().min(1).max(1_800_000),
  }),
});

export const rateSchema = z.object({
  rating: z.number().int().min(0).max(10),
  comment: z.string().max(2000).optional(),
  // 0..MAX_TIP base units (0..0.10 USDC). Left optional rather than
  // defaulted here to the UI's DEFAULT_TIP — the backend must not assume a
  // tip the employer's wallet didn't actually sign for; callers that omit
  // it get treated as 0. The real enforcement is on-chain
  // (AcpError::TipTooHigh); this is a fast, friendly rejection before
  // wasting the round trip.
  tip: usdc.optional().refine((v) => v === undefined || v <= MAX_TIP, {
    message: "Tip exceeds the maximum (0.10 USDC)",
  }),
});

export const reportUsageSchema = z.object({
  phase: z.union([z.literal(0), z.literal(1)]),
  amount: usdc,
  model: z.string().max(80).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
});

export const confirmTxSchema = z.object({
  signature: z.string().min(32).max(120),
});

export const challengeSchema = z.object({ address: z.string().min(32).max(48) });
export const verifySchema = z.object({
  nonce: z.string().min(16),
  signature: z.string().min(32),
});
