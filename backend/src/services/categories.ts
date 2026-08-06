import { prisma } from "../db.js";

/**
 * Categories exist for the single-purpose window. They are user-extensible:
 * at agent creation the operator either picks an existing one or types a new
 * label.
 *
 * Free-text creation will produce near-duplicates ("Security Audit",
 * "security audits", "Security-Auditing"). Slugging catches the easy cases;
 * the hard ones need a merge tool, which is not built. See ARCHITECTURE.md §13.
 */

export const SEED_CATEGORIES = [
  {
    slug: "security-audit",
    label: "Security Audit",
    description: "Code, contract, and infrastructure review against known attack classes.",
  },
  {
    slug: "predictive-betting",
    label: "Predictive Betting",
    description: "Forecasts and odds on resolvable events, with a stated methodology.",
  },
  {
    slug: "teacher",
    label: "Teacher",
    description: "Explanation, tutoring, and curriculum on a requested topic.",
  },
] as const;

/**
 * "Security Audits!" -> "security-audits"
 *
 * Diacritics are folded before stripping so "Prédictive" and "Predictive"
 * collapse together rather than producing "prdictive".
 */
export function slugify(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export class CategoryError extends Error {
  readonly statusCode = 400;
}

/**
 * Resolve a category reference to an id, creating it if the operator typed a
 * new label.
 *
 * Called inside the same transaction as agent creation so a failed agent
 * insert cannot leave an orphan category behind.
 */
export async function resolveCategory(
  input: { categoryId?: string | null; newCategoryLabel?: string | null },
  createdBy?: string
): Promise<string> {
  if (input.categoryId) {
    const existing = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!existing) throw new CategoryError("That category no longer exists");
    return existing.id;
  }

  const label = input.newCategoryLabel?.trim();
  if (!label) {
    throw new CategoryError("Pick a category or name a new one");
  }

  const slug = slugify(label);
  if (!slug) {
    throw new CategoryError("That category name has no usable characters in it");
  }

  // The unique constraint on slug is the real dedup; this read just lets us
  // reuse the row instead of racing into a constraint error, and the upsert
  // below closes the window between the two.
  const existing = await prisma.category.findUnique({ where: { slug } });
  if (existing) return existing.id;

  const created = await prisma.category.upsert({
    where: { slug },
    create: { slug, label, createdBy: createdBy ?? null },
    update: {},
  });
  return created.id;
}

export async function ensureSeedCategories() {
  for (const c of SEED_CATEGORIES) {
    await prisma.category.upsert({
      where: { slug: c.slug },
      create: { ...c, isSeed: true },
      update: { label: c.label, description: c.description, isSeed: true },
    });
  }
}

/**
 * Categories for the single-purpose window, with live agent counts.
 *
 * `includeEmpty` is false for the window itself — an empty category is dead
 * weight in a browse UI — and true for the agent-creation form, where the
 * whole point is to put the first agent in one.
 */
export async function listCategories({ includeEmpty = false } = {}) {
  const categories = await prisma.category.findMany({
    orderBy: [{ isSeed: "desc" }, { label: "asc" }],
    include: {
      _count: {
        select: {
          agents: { where: { kind: "SINGLE_PURPOSE", status: "ACTIVE" } },
        },
      },
    },
  });

  return categories
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      label: c.label,
      description: c.description,
      isSeed: c.isSeed,
      agentCount: c._count.agents,
    }))
    .filter((c) => includeEmpty || c.agentCount > 0);
}
