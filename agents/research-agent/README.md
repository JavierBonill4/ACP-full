# research-agent

Reference ACP agent. Takes a topic, researches it, returns a presentation as a
markdown deck.

One codebase, two deployments. `TIER` is the only difference in configuration,
and it is the only difference that matters.

---

## The honest comparison

This is the reason to run both.

|  | **T1 — Scriptorium** | **T2 — Cartographer** |
|---|---|---|
| Provider key | agent's, never shared | registered with the platform, encrypted at rest |
| Who counts tokens | **the agent** | **the gateway**, from the provider's response |
| Can the count be inflated? | **yes** | no — the agent never supplies it |
| Job value cap | 100 USDC | 2,500 USDC |
| Token reimbursement | held 7 days | immediate |
| What the platform risks | nothing | holds key material |
| What the agent risks | nothing | its key is on someone else's infrastructure |

**Neither tier verifies that the agent did anything useful.** The gateway sees
traffic, not implementation. A T2 agent can burn 2,500 USDC of tokens producing
nonsense and be reimbursed for every one of them, because they were genuinely
spent. Tier prices *metering* risk. Reputation is the only thing that prices
quality, which is why it is the only score in the protocol.

### What actually constrains a lying T1 agent

Nothing detects the lie. Four things bound it:

1. **The funded cap.** Usage is clamped at the API, again in the program's
   `report_usage`, and a third time in `settle()`. An agent cannot bill more
   than the employer chose to escrow — the worst case is that it bills the
   whole budget.
2. **The tier value cap.** 100 USDC on T1, so a single incident is bounded.
3. **The 7-day holdback.** The token portion does not settle with the fees.
4. **`claw_back_holdback`.** Oracle-signed: returns the held tokens and applies
   a WRS penalty larger than a missed deadline.

`ARCHITECTURE.md` §8.1 specs a detection layer — admin-API reconciliation
against provider aggregates, plausibility bounds, canary jobs, behavioural
fingerprinting. **None of it is built.** The bounds above are the whole story
today.

If you want to see the gap rather than read about it: set `TIER=1` and multiply
the reported `amountUsdc` in `src/research.ts` by three. The job settles, the
employer pays, and nothing anywhere complains until the numbers exceed the cap.

---

## Setup

```bash
npm install

# Registers both agents under your Solana keypair and writes .env.t1 / .env.t2
npm run register
```

`register` signs the platform's login challenge with
`~/.config/solana/id.json` (override with `OPERATOR_KEYPAIR`). Both agents
register under the same wallet on purpose — reputation follows the operator,
and running a second agent does not get you a second clean record. Use two
keypairs if you want them independent.

Then:

```bash
npm run t1    # :5101
npm run t2    # :5102
```

### Give T1 a key

Edit `.env.t1` and set `ANTHROPIC_API_KEY`. Without it the agent runs in **stub
mode**: canned deck, fabricated token counts, and a warning on every boot. The
lifecycle is real, the content and the metering are not.

### Give T2 a key

T2 never holds one. The platform does:

```bash
curl -X POST http://localhost:4000/api/v1/gateway/agents/<AGENT_ID>/provider-key \
  -H "authorization: Bearer <YOUR_SESSION_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"apiKey":"sk-ant-..."}'
```

Get the session token from your browser's `sessionStorage` under `acp.session`
after signing in, or from the `register` script's sign-in step.

Use a key scoped to this agent. It is encrypted with AES-256-GCM under
`GATEWAY_KEY_SECRET`, which is **not a KMS** — anyone with the database and the
environment can recover it. That trade is the entire cost of T2, and it is why
T1 exists.

---

## The endpoint contract

Four routes, `ARCHITECTURE.md` §3.1. The platform is the only caller and signs
every request with the shared secret; each route verifies before doing anything.

| Route | |
|---|---|
| `GET /health` | Unsigned — no payload, nothing sensitive. Returns tier and mode. |
| `POST /plan` | Quote the job. Fees are clamped to the employer's funded ceiling rather than bidding above it and being refused. |
| `POST /execute` | Returns `202` immediately, delivers via callback. Research takes minutes; holding the connection open loses the result to a proxy timeout. |
| `POST /cancel` | Job expired or was cancelled. |

Results go back to `POST /api/v1/jobs/:id/callback` with the same HMAC in
reverse, plus `X-ACP-Agent` naming which agent is calling.

**Failures are reported, not swallowed.** If research throws, the agent posts
an error callback. Going quiet means the job sits until its deadline, the bond
is slashed, and the employer learns nothing — strictly worse for both sides.

---

## What it produces

A markdown deck: `---` between slides, `## ` titles, 3–5 bullets, a `> ` line
of speaker notes. Two model calls — one to research, one to shape the notes into
slides — because asking for both at once reliably produces a deck of
generalities.

Every deck ends with a **provenance slide** stating which tier produced it and
therefore how the token bill was arrived at: observed by the gateway, or
asserted by the agent. That belongs in the deliverable rather than a settings
page — it is the thing the employer is actually being asked to trust.

---

## Layout

```
src/config.ts     the tier switch, and the refusal to hold a key at T2
src/platform.ts   HMAC both ways, usage reporting, gateway and direct model calls
src/research.ts   plan and deck generation; callModel() is where tier bites
src/ratecard.ts   token→USDC, synced from the platform at boot
src/index.ts      the four routes, deck assembly
scripts/register.ts  signs in, registers both agents, writes the env files
```

`src/research.ts::callModel` is the file to read if you only read one. It is
four lines of branching and it is the entire difference between a metering
guarantee and a promise.
