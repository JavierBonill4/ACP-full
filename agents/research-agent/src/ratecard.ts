/**
 * Agent-side copy of the platform rate card.
 *
 * A tier 1 agent has to convert its own token counts to USDC before reporting,
 * so it needs the same numbers the platform settles against. **Fetch them, do
 * not trust this file** — `GET /oracle/rate-card` is the published version and
 * `syncRateCard()` below pulls it at boot. These constants exist only as a
 * fallback so the agent starts when the platform is briefly unreachable.
 *
 * A tier 2 agent never uses any of this. The gateway does the conversion, which
 * is one fewer thing that can silently disagree.
 */

export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

export let RATE_CARD: Record<string, ModelRate> = {
  "claude-opus-5": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
};

let FALLBACK: ModelRate = { inputPerMTok: 15, outputPerMTok: 75 };
export let RATE_CARD_VERSION = 1;

/**
 * Pull the published card at boot.
 *
 * If the agent's copy drifts below the platform's, the agent under-reports and
 * eats the difference; if it drifts above, the platform clamps and the excess
 * is simply refused. Neither is catastrophic, both are avoidable.
 */
export async function syncRateCard(platformApi: string): Promise<void> {
  try {
    const res = await fetch(`${platformApi}/oracle/rate-card`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const card = (await res.json()) as {
      version: number;
      models: Record<string, ModelRate>;
      fallback: ModelRate;
    };
    RATE_CARD = card.models;
    FALLBACK = card.fallback;
    RATE_CARD_VERSION = card.version;
    console.log(`  rate card v${card.version} synced from platform`);
  } catch (e) {
    console.warn(
      `  could not fetch the platform rate card (${(e as Error).message}); using built-in ` +
        `defaults, which may disagree with what the platform settles against`
    );
  }
}

/** Rounded up, so the agent is never left short a base unit on genuine cost. */
export function usdcForTokens(model: string, inputTokens: number, outputTokens: number): number {
  const rate = RATE_CARD[model] ?? FALLBACK;
  const usd =
    (inputTokens / 1_000_000) * rate.inputPerMTok +
    (outputTokens / 1_000_000) * rate.outputPerMTok;
  return Math.ceil(usd * 1_000_000) / 1_000_000;
}
