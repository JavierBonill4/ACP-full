import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { config } from "./config.js";
import * as chain from "./chain.js";

const sha256Bytes = (s: string) => Array.from(createHash("sha256").update(s).digest());

/**
 * Everything this agent says to the platform, and the check on everything the
 * platform says to it.
 *
 * The signature is over the exact bytes sent. Sign the serialised string, send
 * that same string — never re-serialise between signing and sending, or the
 * bytes drift and the HMAC fails for reasons that look like a key problem.
 */

export function sign(body: string): string {
  return createHmac("sha256", config.ACP_SHARED_SECRET).update(body).digest("hex");
}

/** Constant-time, and tolerant of a missing or malformed header. */
export function verify(body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(sign(body), "utf8");
  const actual = Buffer.from(header, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function call<T>(
  path: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const body = JSON.stringify(payload ?? {});
  const res = await fetch(`${config.PLATFORM_API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acp-agent": config.ACP_AGENT_ID,
      "x-acp-signature": sign(body),
      ...extraHeaders,
    },
    body,
  });

  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new PlatformError(parsed?.error ?? `Platform returned ${res.status}`, res.status, parsed);
  }
  return parsed as T;
}

export class PlatformError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export const PHASE_PLANNING = 0 as const;
export const PHASE_EXECUTION = 1 as const;

// ---------------------------------------------------------------------------
// Job actions
//
// All of these go through POST /jobs/:id/callback, which is the only
// agent-facing way to advance a job. Every other route that moves a job is
// wallet-authenticated and meant for a human in a browser; an agent holds an
// HMAC secret and no wallet session.
// ---------------------------------------------------------------------------

/**
 * Take a direct hire. Must happen inside the 6h `accept_ttl` or the employer's
 * escrow returns in full and the offer is gone.
 *
 * `jobPda` is the on-chain job address (from the dispatch payload's `pda`
 * field — populated once the platform's own on-chain wiring writes it after
 * `post_job`; older jobs posted before that landed won't have one). When
 * present and this agent has chain signing configured, the real
 * accept_offer instruction is sent and confirmed BEFORE the HMAC callback —
 * the callback is a record of what happened on-chain, not a substitute for it.
 */
export async function acceptOffer(jobId: string, jobPda?: string) {
  if (jobPda && chain.chainEnabled) {
    await chain.acceptOffer(jobPda);
  }
  return call(`/jobs/${jobId}/callback`, { kind: "accept-offer" });
}

/**
 * Submit the proposal. Fees are decimal USDC and must fit inside the ceilings
 * the employer funded — the platform refuses anything above them rather than
 * negotiating, so quoting high is a wasted round trip.
 *
 * This starts the employer's 72h review clock. If they say nothing it
 * auto-accepts, so a silent employer cannot strand the agent's capital.
 *
 * The on-chain submit_plan call takes a hash of the outline, not the outline
 * text itself — same reasoning as everywhere else in this program that a
 * commitment hash goes on-chain and the content stays off it.
 */
export async function submitPlan(
  jobId: string,
  plan: { outline: string; planningFeeUsdc: number; fixedFeeUsdc: number },
  jobPda?: string
) {
  if (jobPda && chain.chainEnabled) {
    await chain.submitPlan(jobPda, {
      planHash: sha256Bytes(plan.outline),
      planningFeeUsdc: plan.planningFeeUsdc,
      fixedFeeUsdc: plan.fixedFeeUsdc,
    });
  }
  return call(`/jobs/${jobId}/callback`, { kind: "plan", ...plan });
}

export interface DeliverableFile {
  filename: string;
  mimeType: string;
  /** Base64-encoded file bytes — this agent's deliverable is a real .pptx, not text. */
  base64: string;
}

/**
 * Hand back the finished work. Moves the job to REVIEW_PENDING and starts the
 * second 72h review window.
 *
 * The on-chain commitment hashes the actual file bytes (decoded from
 * `base64`), not the base64 string itself and not any markdown that went
 * into producing it — that's what the employer is actually being asked to
 * pay for, and what the backend's own hash of the same bytes has to match.
 */
export async function submitDeliverable(jobId: string, deliverable: DeliverableFile, jobPda?: string) {
  if (jobPda && chain.chainEnabled) {
    const fileBytes = Buffer.from(deliverable.base64, "base64");
    const digest = Array.from(createHash("sha256").update(fileBytes).digest());
    await chain.submitDeliverable(jobPda, digest);
  }
  return call(`/jobs/${jobId}/callback`, { kind: "deliverable", deliverable });
}

export async function postProgress(jobId: string, message: string) {
  return call(`/jobs/${jobId}/callback`, { kind: "progress", message });
}

export async function postError(jobId: string, message: string) {
  return call(`/jobs/${jobId}/callback`, { kind: "error", message });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Self-report token usage. **Tier 1 only** — the platform rejects this from a
 * tier 2 agent, because T2's whole claim is that it does not count its own work.
 *
 * Reports are additive per phase and the platform clamps against the employer's
 * funded cap, so a report that would exceed it is refused rather than truncated.
 * Treat that refusal as a signal to stop working and submit what you have.
 */
export async function reportUsage(
  jobId: string,
  phase: 0 | 1,
  usage: { amountUsdc: number; model?: string; inputTokens?: number; outputTokens?: number }
) {
  return call<{
    ok: boolean;
    phaseTotal: string;
    cap: string;
    remaining: string;
  }>(`/oracle/jobs/${jobId}/usage`, { phase, ...usage });
}

// ---------------------------------------------------------------------------
// Model access
// ---------------------------------------------------------------------------

export interface MessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  /**
   * Explicitly disabled by every call site in research.ts. Claude Sonnet 5
   * runs adaptive thinking at "high" effort by default when this is omitted
   * — on a note-taking/deck-writing task that's pure overhead, and at a
   * modest max_tokens it can consume the entire budget on hidden reasoning
   * and leave zero room for the actual text block the rest of this pipeline
   * depends on (see research.ts's callModelOrThrow). Not needed for a task
   * this direct; not worth the token cost or the failure mode.
   */
  thinking?: { type: "disabled" };
}

export interface MessagesResponse {
  content: { type: string; text?: string }[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Calls the platform gateway. **Tier 2 only.**
 *
 * The agent supplies no token counts and receives none it could tamper with —
 * the platform reads them out of the provider's response and records them
 * before returning. Metering is exact by construction rather than by trust.
 *
 * A 402 means the call happened and the provider billed for it, but recording
 * it would breach the employer's cap. The agent has genuinely lost that money;
 * the correct response is to stop and submit, not to retry.
 */
export async function gatewayMessages(
  jobId: string,
  phase: 0 | 1,
  request: MessagesRequest
): Promise<MessagesResponse> {
  return call<MessagesResponse>("/gateway/messages", request, {
    "x-acp-job": jobId,
    "x-acp-phase": String(phase),
  });
}

/**
 * Calls Anthropic directly. **Tier 1 only.** The agent then has to tell the
 * platform what it burned, and nothing checks that claim against the provider.
 */
export async function directMessages(request: MessagesRequest): Promise<MessagesResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(request),
  });

  const parsed = (await res.json()) as MessagesResponse & { error?: { message?: string } };
  if (!res.ok) {
    throw new PlatformError(parsed.error?.message ?? `Provider returned ${res.status}`, res.status);
  }
  return parsed;
}