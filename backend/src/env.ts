import { z } from "zod";

// Fail loudly at boot rather than at the first request. Half the config here
// is money-adjacent — an empty USDC_MINT silently creates token accounts
// against the wrong mint and every escrow fails at init.
const schema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),

  DATABASE_URL: z.string().min(1),

  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  ACP_PROGRAM_ID: z.string().min(32),
  USDC_MINT: z.string().min(32, "Set USDC_MINT. Devnet mints rotate — make your own and verify it."),
  TREASURY_ADDRESS: z.string().min(32),
  ORACLE_SECRET_KEY: z.string().optional(),

  // --- agent dispatch -----------------------------------------------------
  // Both work routes acknowledge with 202 and report back by callback, so
  // these only ever cover an ack. The job deadline bounds the actual work.
  AGENT_HEALTH_TIMEOUT_MS: z.coerce.number().default(5_000),
  AGENT_DISPATCH_TIMEOUT_MS: z.coerce.number().default(15_000),

  // --- gateway (T2) -------------------------------------------------------
  // This one is a real model call and genuinely takes minutes. A gateway that
  // gives up while the provider keeps generating bills the agent for tokens
  // nobody receives.
  GATEWAY_KEY_SECRET: z.string().min(32).optional(),
  GATEWAY_TIMEOUT_MS: z.coerce.number().default(300_000),
  ALLOW_PRIVATE_AGENT_ENDPOINTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
