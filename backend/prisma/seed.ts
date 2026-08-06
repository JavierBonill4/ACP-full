/**
 * Seeds the three starting categories and a handful of demo agents so the two
 * windows have something in them on first run.
 *
 * The demo agents point at example.com and will fail their health check —
 * that is intentional. They exist to exercise the layout, not to be hired, and
 * an "unreachable" badge is a more honest empty state than pretending a
 * fictional endpoint is live.
 *
 *     npm run db:push && npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";

import { SEED_CATEGORIES } from "../src/services/categories.js";

const prisma = new PrismaClient();

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

// Deterministic placeholders. Not real keypairs — nothing signs with these.
const DEMO_WALLETS = {
  sentinel: "8xSentine1Aud1tDem0Wa11etAddre55P1aceh01d",
  oracle: "7xPredictiveBettingDem0Wa11etAddre55P1ace",
  tutor: "6xTeacherAgentDem0Wa11etAddre55P1aceh01de",
  generalist: "5xGenera1PurposeDem0Wa11etAddre55P1aceh0",
};

async function main() {
  for (const c of SEED_CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      create: { ...c, isSeed: true },
      update: { label: c.label, description: c.description, isSeed: true },
    });
  }
  console.log(`  seeded ${SEED_CATEGORIES.length} categories`);

  const categories = Object.fromEntries(
    (await prisma.category.findMany()).map((c) => [c.slug, c.id])
  );

  const demos = [
    {
      wallet: DEMO_WALLETS.sentinel,
      name: "Sentinel",
      kind: "SINGLE_PURPOSE",
      categorySlug: "security-audit",
      tier: 2,
      descriptor: {
        summary:
          "Reviews Anchor and Solidity programs against known attack classes and writes up findings with severity, reproduction, and a suggested fix.",
        capabilities: ["static-analysis", "invariant-review", "report-writing"],
        models: ["claude-opus-5"],
        avgCompletionMinutes: 180,
        basePlanningFeeUsdc: 3,
        baseFixedFeeUsdc: 45,
      },
      // A history that makes the counters worth rendering: strong but not
      // spotless, which is the interesting case for the UI.
      stats: { wrs: 8_400_000n, completed: 23, rejected: 2, expired: 0, settled: usdc(1840) },
    },
    {
      wallet: DEMO_WALLETS.oracle,
      name: "Delphi",
      kind: "SINGLE_PURPOSE",
      categorySlug: "predictive-betting",
      tier: 1,
      descriptor: {
        summary:
          "Produces calibrated probability estimates on resolvable events with an explicit methodology and a stated confidence interval.",
        capabilities: ["base-rate-research", "calibration", "market-comparison"],
        models: ["claude-sonnet-5"],
        avgCompletionMinutes: 45,
        basePlanningFeeUsdc: 1,
        baseFixedFeeUsdc: 12,
      },
      // Tier 1, no history. This is the "new agent" state the discovery
      // surface has to handle without implying the agent earned a zero.
      stats: { wrs: 0n, completed: 0, rejected: 0, expired: 0, settled: 0n },
    },
    {
      wallet: DEMO_WALLETS.tutor,
      name: "Socratic",
      kind: "SINGLE_PURPOSE",
      categorySlug: "teacher",
      tier: 2,
      descriptor: {
        summary:
          "Builds a lesson plan and worked examples for a requested topic at a requested level, then answers follow-ups against the same material.",
        capabilities: ["curriculum-design", "worked-examples", "assessment"],
        models: ["claude-sonnet-5"],
        avgCompletionMinutes: 60,
        basePlanningFeeUsdc: 0,
        baseFixedFeeUsdc: 8,
      },
      stats: { wrs: 2_100_000n, completed: 6, rejected: 4, expired: 1, settled: usdc(74) },
    },
    {
      wallet: DEMO_WALLETS.generalist,
      name: "Atlas",
      kind: "GENERAL",
      categorySlug: null,
      tier: 2,
      descriptor: {
        summary:
          "Takes arbitrary custom jobs from the open pool. Scopes the work, quotes a flat fee, and delivers against the spec as written.",
        capabilities: ["research", "writing", "data-analysis", "code"],
        models: ["claude-opus-5", "claude-sonnet-5"],
        avgCompletionMinutes: 240,
        basePlanningFeeUsdc: 2,
        baseFixedFeeUsdc: 30,
      },
      stats: { wrs: 5_600_000n, completed: 14, rejected: 1, expired: 1, settled: usdc(620) },
    },
  ] as const;

  for (const d of demos) {
    await prisma.wallet.upsert({
      where: { address: d.wallet },
      create: {
        address: d.wallet,
        tier: d.tier,
        cachedWrs: d.stats.wrs,
        jobsCompleted: d.stats.completed,
        jobsRejected: d.stats.rejected,
        jobsExpired: d.stats.expired,
        totalValueSettled: d.stats.settled,
        chainFirstSeen: new Date(Date.now() - 60 * 86_400_000),
      },
      update: {},
    });

    const existing = await prisma.agent.findFirst({
      where: { walletAddress: d.wallet, name: d.name },
    });
    if (existing) continue;

    await prisma.agent.create({
      data: {
        walletAddress: d.wallet,
        name: d.name,
        summary: d.descriptor.summary,
        kind: d.kind,
        // The routing rule, restated in the seed because it is the one thing
        // that must never be violated: a category iff SINGLE_PURPOSE.
        categoryId: d.kind === "SINGLE_PURPOSE" ? categories[d.categorySlug!]! : null,
        endpoint: `https://example.com/agents/${d.name.toLowerCase()}`,
        sharedSecret: randomBytes(32).toString("hex"),
        descriptor: JSON.stringify(d.descriptor),
        basePlanningFee: usdc(d.descriptor.basePlanningFeeUsdc),
        baseFixedFee: usdc(d.descriptor.baseFixedFeeUsdc),
        avgCompletionMinutes: d.descriptor.avgCompletionMinutes,
        tier: d.tier,
        status: "UNREACHABLE",
        lastHealthError: "Demo agent — example.com is not a real endpoint",
      },
    });
  }

  const [general, single] = await Promise.all([
    prisma.agent.count({ where: { kind: "GENERAL" } }),
    prisma.agent.count({ where: { kind: "SINGLE_PURPOSE" } }),
  ]);
  console.log(`  seeded ${general} general-purpose and ${single} single-purpose agents`);

  // The invariant the whole agents page depends on. If this ever fails, an
  // agent is about to render in the wrong window or in none at all.
  const misrouted = await prisma.agent.count({
    where: {
      OR: [
        { kind: "GENERAL", NOT: { categoryId: null } },
        { kind: "SINGLE_PURPOSE", categoryId: null },
      ],
    },
  });
  if (misrouted > 0) {
    throw new Error(`${misrouted} agents have a kind/category mismatch`);
  }
  console.log("  routing invariant holds: every agent lands in exactly one window");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
