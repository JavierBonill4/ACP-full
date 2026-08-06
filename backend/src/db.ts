import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

/**
 * Amounts are BigInt everywhere — u64 base units exceed Number's safe integer
 * range and silent precision loss in money code is not acceptable even when
 * the current tier caps make it unreachable. JSON.stringify throws on BigInt,
 * so every response goes through this.
 *
 * Serialising as a decimal string rather than a number is deliberate: the
 * frontend parses it straight back to BigInt, so the value never passes
 * through a float.
 */
export function serialize<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialize(v);
    }
    return out;
  }
  return value;
}
