import { env } from "./env.js";
import { buildServer } from "./server.js";
import { prisma } from "./db.js";

const app = await buildServer();

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  app.log.info(`ACP backend listening on ${env.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Prisma holds pooled connections; without this a SIGTERM in a container
// leaves them to time out rather than close.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  });
}
