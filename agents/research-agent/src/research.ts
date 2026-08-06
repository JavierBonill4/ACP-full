import { STUB_MODE, config } from "./config.js";
import {
  PHASE_EXECUTION,
  PHASE_PLANNING,
  directMessages,
  gatewayMessages,
  reportUsage,
  type MessagesRequest,
  type MessagesResponse,
} from "./platform.js";
import { RATE_CARD, usdcForTokens } from "./ratecard.js";

/**
 * The one place tier actually changes behaviour, isolated so the research logic
 * below never has to think about it.
 *
 * T1: call the provider, then tell the platform what you burned. Nothing checks
 *     the claim. This function is where a dishonest agent would lie.
 * T2: call the gateway. It meters from the provider's response and records the
 *     usage itself before the result comes back, so there is nothing here to
 *     lie with.
 */
export async function callModel(
  jobId: string,
  phase: 0 | 1,
  request: MessagesRequest
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number; model: string } }> {
  if (STUB_MODE) {
    // Fabricated, and labelled as such everywhere it surfaces. Scaled off the
    // prompt so at least the shape of the numbers moves with the work.
    const promptChars = request.messages.reduce((n, m) => n + m.content.length, 0);
    const inputTokens = Math.ceil(promptChars / 4) + 400;
    const outputTokens = Math.ceil(request.max_tokens * 0.4);
    const usage = { inputTokens, outputTokens, model: `${request.model} (stub)` };

    await reportUsage(jobId, phase, {
      amountUsdc: usdcForTokens(request.model, inputTokens, outputTokens),
      model: usage.model,
      inputTokens,
      outputTokens,
    });

    return { text: "", usage };
  }

  let response: MessagesResponse;

  if (config.TIER === 2) {
    response = await gatewayMessages(jobId, phase, request);
  } else {
    response = await directMessages(request);
    // The honesty gap, in one call. The agent decides what to declare, and the
    // only thing standing between a false number and the employer's escrow is
    // the funded cap and a 7-day holdback.
    await reportUsage(jobId, phase, {
      amountUsdc: usdcForTokens(
        response.model,
        response.usage.input_tokens,
        response.usage.output_tokens
      ),
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
  }

  const text = response.content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");

  return {
    text,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: response.model,
    },
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface Plan {
  outline: string;
  planningFeeUsdc: number;
  fixedFeeUsdc: number;
  estTokenUsdcLow: number;
  estTokenUsdcHigh: number;
}

const PLAN_SYSTEM = `You are a research agent bidding for a job on a commerce protocol.

Produce a short plan for researching the requested topic and turning it into a
presentation. Be specific about what you will actually look into and what the
deck will contain. Do not pad it.

Structure:
- 2-3 sentences on your reading of the brief
- "Angles" — 4-6 bullets, the specific questions you will answer
- "Deck" — the slide list you intend to produce
- "Limits" — what you will NOT be able to establish, honestly

Under 350 words. No preamble, no sign-off.`;

export async function buildPlan(jobId: string, title: string, spec: string): Promise<Plan> {
  const estLow = 0.15;
  const estHigh = 0.9;

  if (STUB_MODE) {
    await callModel(jobId, PHASE_PLANNING, {
      model: config.RESEARCH_MODEL,
      max_tokens: 900,
      messages: [{ role: "user", content: spec }],
    });
    return {
      outline: stubPlan(title, spec),
      planningFeeUsdc: config.PLANNING_FEE_USDC,
      fixedFeeUsdc: config.FIXED_FEE_USDC,
      estTokenUsdcLow: estLow,
      estTokenUsdcHigh: estHigh,
    };
  }

  const { text } = await callModel(jobId, PHASE_PLANNING, {
    model: config.RESEARCH_MODEL,
    max_tokens: 900,
    system: PLAN_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Job title: ${title}\n\nBrief:\n${spec}\n\nTarget deck length: ${config.DECK_SLIDES} content slides.`,
      },
    ],
  });

  return {
    outline: text.trim(),
    planningFeeUsdc: config.PLANNING_FEE_USDC,
    fixedFeeUsdc: config.FIXED_FEE_USDC,
    estTokenUsdcLow: estLow,
    estTokenUsdcHigh: estHigh,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = `You are a research agent. Investigate the topic thoroughly and write dense,
structured notes for someone who will turn them into a presentation.

Requirements:
- Lead with what is actually established, and separate it from what is contested.
- Give concrete figures, dates, and named parties wherever you can.
- Where you are uncertain or working from memory that may be stale, say so inline.
  Do not present a guess as a finding.
- No introduction, no conclusion, no hedging boilerplate. Notes only.`;

const DECK_SYSTEM = `Turn the research notes into a presentation, as Markdown.

Format, exactly:
- Slides separated by a line containing only ---
- Each slide starts with "## " and a title
- 3-5 bullets per slide, each a complete thought, not a fragment
- After the bullets, a line "> " with one sentence of speaker notes

Rules:
- One idea per slide. If a slide needs two, split it.
- Use the specific figures from the notes. A deck of generalities is worthless.
- Where the notes flagged uncertainty, carry that through to the slide. Do not
  launder a caveat into a claim.
- No title slide and no sources slide — those are added separately.

Produce exactly the requested number of content slides.`;

export interface Deck {
  markdown: string;
  usage: { inputTokens: number; outputTokens: number; calls: number };
}

export async function research(
  jobId: string,
  title: string,
  spec: string,
  onProgress: (message: string) => Promise<void>
): Promise<Deck> {
  const totals = { inputTokens: 0, outputTokens: 0, calls: 0 };

  if (STUB_MODE) {
    const stub = await callModel(jobId, PHASE_EXECUTION, {
      model: config.WRITE_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: spec }],
    });
    totals.inputTokens += stub.usage.inputTokens;
    totals.outputTokens += stub.usage.outputTokens;
    totals.calls++;
    return { markdown: stubDeck(title, spec), usage: totals };
  }

  await onProgress("Researching");
  const notes = await callModel(jobId, PHASE_EXECUTION, {
    model: config.RESEARCH_MODEL,
    max_tokens: 4000,
    system: RESEARCH_SYSTEM,
    messages: [{ role: "user", content: `Topic: ${title}\n\nBrief:\n${spec}` }],
  });
  totals.inputTokens += notes.usage.inputTokens;
  totals.outputTokens += notes.usage.outputTokens;
  totals.calls++;

  await onProgress("Building the deck");
  const deck = await callModel(jobId, PHASE_EXECUTION, {
    model: config.WRITE_MODEL,
    max_tokens: 4000,
    system: DECK_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Produce ${config.DECK_SLIDES} content slides on "${title}".\n\nResearch notes:\n\n${notes.text}`,
      },
    ],
  });
  totals.inputTokens += deck.usage.inputTokens;
  totals.outputTokens += deck.usage.outputTokens;
  totals.calls++;

  return { markdown: deck.text.trim(), usage: totals };
}

// ---------------------------------------------------------------------------
// Stub output
// ---------------------------------------------------------------------------

function stubPlan(title: string, spec: string): string {
  return `**Running in stub mode — no model was called.** This plan is canned and the
token usage reported against it is fabricated. Set ANTHROPIC_API_KEY to get real work.

I read this as a request for a researched deck on "${title}".

**Angles**
- What is actually established versus contested
- Who the named parties are and what they each claim
- Relevant figures and their provenance
- What changed most recently
- Where the evidence is thin

**Deck**
${config.DECK_SLIDES} content slides, one idea each, with speaker notes, plus a
title slide and a sources slide.

**Limits**
No live web access in this build, so anything time-sensitive will be flagged
rather than asserted.

_Brief received: ${spec.slice(0, 160)}${spec.length > 160 ? "…" : ""}_`;
}

function stubDeck(title: string, spec: string): string {
  const slides = Array.from({ length: config.DECK_SLIDES }, (_, i) => {
    const n = i + 1;
    return `## Placeholder slide ${n}

- This deck was generated in stub mode with no model call
- The agent, HMAC signing, usage reporting and settlement path all ran for real
- Only the content is fake
- Set ANTHROPIC_API_KEY and restart to produce actual research

> Stub slide ${n} of ${config.DECK_SLIDES}.`;
  });

  return [
    `## ${title}`,
    "",
    "- Stub output — no research was performed",
    `- Brief: ${spec.slice(0, 120)}${spec.length > 120 ? "…" : ""}`,
    "",
    "> Stub mode. The lifecycle is real; the content is not.",
    "",
    ...slides.flatMap((s) => ["---", "", s, ""]),
  ].join("\n");
}

export { RATE_CARD };
