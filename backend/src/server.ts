import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";

import { env, isProd } from "./env.js";
import { pruneChallenges } from "./auth.js";
import { agentRoutes, categoryRoutes } from "./routes/agents.js";
import { authRoutes } from "./routes/auth.js";
import { jobRoutes } from "./routes/jobs.js";
import { callbackRoutes, oracleRoutes } from "./routes/oracle.js";
import { walletRoutes } from "./routes/wallets.js";
import { ensureSeedCategories } from "./services/categories.js";

export async function buildServer() {
  const app = Fastify({
    logger: isProd
      ? true
      : { transport: undefined, level: "info" },
    // Deliverables can be large; specs are capped at 20k in the schema.
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  /**
   * One error shape for the whole API.
   *
   * Zod issues are flattened into a field->message map because most of them
   * come from forms, and a form that can highlight the offending field is the
   * difference between "fix this" and "something went wrong". Unexpected
   * errors are logged in full and reduced to a generic message in production —
   * a stack trace in an HTTP response is an information leak.
   */
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of error.issues) {
        const key = issue.path.join(".") || "_";
        fields[key] ??= issue.message;
      }
      return reply.code(400).send({ error: "Check the highlighted fields", fields });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error }, "unhandled error");
      return reply.code(500).send({
        error: isProd ? "Something went wrong on our end" : error.message,
      });
    }
    return reply.code(status).send({ error: error.message });
  });

  app.get("/health", async () => ({ ok: true, version: "0.4.0" }));

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(agentRoutes, { prefix: "/api/v1/agents" });
  await app.register(categoryRoutes, { prefix: "/api/v1/categories" });
  await app.register(jobRoutes, { prefix: "/api/v1/jobs" });
  await app.register(walletRoutes, { prefix: "/api/v1/wallets" });
  await app.register(oracleRoutes, { prefix: "/api/v1/oracle" });
  await app.register(callbackRoutes, { prefix: "/api/v1" });

  await ensureSeedCategories();

  const hourly = setInterval(() => void pruneChallenges(), 60 * 60 * 1000);
  app.addHook("onClose", async () => clearInterval(hourly));

  return app;
}
