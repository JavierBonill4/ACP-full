# Agentic Commerce Protocol — Architecture v4

**Status:** implemented in this repo
**Target:** Solana devnet, SPL USDC
**Supersedes:** architecture v3

## Changes from v3

| v3 | v4 |
|---|---|
| Agent identity = `(code_hash, wallet)` | Agent identity = `(wallet, endpoint)`. Code is never hashed, committed, or inspected. |
| Two scores: CRS (code) + WRS (wallet), `ARS = sqrt(CRS × WRS)` | **One score: WRS.** Wallet reputation is the entire reputation system. |
| Skeletons (§9) | **Removed.** Reputation is not transferable, so there is nothing to inherit. |
| T3 ATTESTED tier, TEE attestation, attestation-gated key release | **Removed.** Attestation existed to make `code_hash` a fact; with no code identity there is nothing to attest. |
| Tiers gate code reputation | Tiers are a **trust label** gating job value cap, token holdback, and discovery rank. |
| Agents are code bundles the platform hashes | Agents are **endpoints the platform calls**, described by an operator-authored descriptor. |
| One undifferentiated agent list | **General-purpose** and **single-purpose** agents are distinct products with distinct hiring flows (§4). |

Everything else — cost-plus-fixed-fee economics, escrow funded at the top of
the range, the settlement matrix, claim bonds, TTLs, the 1% margin fee, zero
floor plus immutable lifetime counters — carries over unchanged.

---

## 1. Design principles

1. **Payment tracks cost, margin is fixed.** Agents are reimbursed for tokens
   at cost and earn a flat fee. No percentage-of-spend anywhere, so burning
   tokens never increases margin.
2. **The platform never sees agent code.** Operators host wherever they want
   and expose an HTTP endpoint. The platform knows a URL, a descriptor, and an
   outcome history — nothing about the implementation.
3. **Reputation is the wallet's, and only the wallet's.** One score, one
   subject, no laundering surface. A new wallet is a new reputation.
4. **Money is on-chain; content is not.** Escrow, bonds, settlement, and the
   reputation record live in a Solana program. Job specs, plans, deliverables,
   descriptors, and categories live in the backend database.
5. **The protocol is a trusted party in MVP, and says so.** A single
   platform-controlled oracle key writes usage to escrow. On-chain settlement
   buys finality, not trustlessness.
6. **Every lock has a timer.** No state can be held indefinitely by an
   unresponsive party.

---

## 2. Entities

| Entity | Identity | On-chain? | Notes |
|---|---|---|---|
| **Employer** | Wallet address | Address + profile PDA | Funds escrow, accepts/rejects, rates |
| **Agent** | Wallet address + endpoint | Wallet PDA on-chain; descriptor off-chain | §3 |
| **Platform / Oracle** | Whitelisted signer | Yes | Sole writer of usage data |
| **Escrow** | Per-job PDA + token account | Yes | Holds USDC, enforces payout |
| **Bond** | Per-job PDA + token account | Yes | Holds the claim bond |

An agent **is** its wallet. Two agents registered under one wallet share one
reputation — deliberately, since one operator stands behind both.

---

## 3. Agents: endpoint + descriptor

Registration takes:

```jsonc
{
  "wallet":       "<base58 pubkey>",           // reputation subject, payout destination
  "name":         "Sentinel Audit",
  "kind":         "SINGLE_PURPOSE",            // or "GENERAL"
  "categorySlug": "security-audit",            // required iff kind = SINGLE_PURPOSE
  "endpoint":     "https://agent.example.com/acp",
  "descriptor": {                              // operator-authored, free-form within a schema
    "summary":       "Solidity and Anchor program audits",
    "capabilities":  ["static-analysis", "invariant-review", "report-writing"],
    "inputSchema":   { "...": "JSON Schema the agent accepts" },
    "outputSchema":  { "...": "JSON Schema the agent returns" },
    "models":        ["claude-opus-5"],
    "avgCompletionMinutes": 90,
    "basePlanningFeeUsdc":  2.0,
    "baseFixedFeeUsdc":    25.0
  },
  "tier": 1                                    // 1 RECONCILED | 2 METERED
}
```

`descriptor` is the entire self-description. The platform validates it against
a JSON Schema, calls `GET {endpoint}/health` to confirm reachability, and
stores it. It is never hashed onto the chain.

### 3.1 Endpoint contract

The platform is the only caller. Four routes, all `POST`, all signed by the
platform with an `X-ACP-Signature` HMAC over the raw body:

| Route | Called when | Returns |
|---|---|---|
| `/health` (`GET`) | registration, and hourly | `{ ok, version }` |
| `/plan` | job assigned to the agent | `{ outline, planningFeeUsdc, fixedFeeUsdc, estTokenUsdcLow, estTokenUsdcHigh, proposedDeadline }` |
| `/execute` | employer accepted the plan | `202` + async callback, or `{ deliverable }` |
| `/cancel` | job expired or was cancelled | `{ ok }` |

Agents post results back to `POST /api/v1/jobs/:id/callback` with the same HMAC
in reverse, keyed on a per-agent shared secret issued at registration.

### 3.2 General-purpose vs single-purpose

These are the two products, and they map one-to-one onto the two windows in
the UI (§4).

|  | **General-purpose** | **Single-purpose** |
|---|---|---|
| Category | none | exactly one, required |
| Discovery | not browsed; agents come to the job | browsed by category |
| Hiring | employer writes a **custom job**, posts it OPEN, any qualified general agent claims it | employer picks a **specific agent** and hires it directly |
| Bond | required (agent chose the job) | none (employer chose the agent) |
| Job type produced | `OPEN` | `DIRECT` |

A general agent may not sit in a category window; a single-purpose agent may
not claim open custom jobs. This is enforced in `POST /api/v1/jobs` and again
in the claim path.

### 3.3 Categories

Seeded with three, and open-ended:

| Slug | Label |
|---|---|
| `security-audit` | Security Audit |
| `predictive-betting` | Predictive Betting |
| `teacher` | Teacher |

At agent creation the operator either selects an existing category or types a
new one. A new label is slugified, deduplicated case- and punctuation-
insensitively against existing slugs, and created in the same transaction as
the agent. Categories are never deleted; an empty category is hidden from the
window rather than removed, so agent history stays interpretable.

---

## 4. The two windows

The agents page renders exactly two panes, side by side on desktop and
stacked on mobile.

**General window** — one pane, no category structure. Contains the custom-job
composer (spec, `token_budget_cap`, `planning_token_cap`, `deadline`,
`min_tier`) and, below it, the roster of general-purpose agents with their
reputation and lifetime counters so the employer can see who is likely to
claim. Submitting the composer creates an `OPEN` job and funds escrow.

**Single-purpose window** — a category rail plus a grid. Selecting a category
filters the grid to that category's agents; "All" shows every single-purpose
agent grouped by category heading. Each card carries name, summary, tier,
WRS, lifetime counters, avg completion time, and indicative fees. "Hire"
opens a form pre-filled from the agent's descriptor and creates a `DIRECT`
job for that agent.

**Routing on creation is by `kind`, not by whether a category was supplied.**
`kind = GENERAL` → general window, category ignored and rejected if present.
`kind = SINGLE_PURPOSE` → single-purpose window under its category, and a
category is mandatory. This is the fix for agents landing in the wrong view.

---

## 5. Economic model

Unchanged from v3. All user-facing amounts are USDC, 6dp base units on-chain.

**Employer posts a job with:** `token_budget_cap`, `planning_token_cap`,
`deadline`, `min_tier`.

**Agent proposal contains:** outline, `planning_fee` (flat, may be 0),
`fixed_fee` (flat), and an informational token estimate — the cap binds.

**Escrow is funded at the top of the range:**

```
escrow_total = planning_fee + fixed_fee + planning_token_cap + token_budget_cap
```

For a `DIRECT` job the fees come from the agent's descriptor at hire time and
are pinned into the job; for an `OPEN` job escrow is funded with the caps at
post time and topped up with the fees when a claim's plan is accepted.

**Protocol fee — 1% of margin, never of gross:**

```
protocol_fee = 0.01 × (planning_fee + fixed_fee)
```

Token reimbursement is pass-through cost, not revenue.

### 5.1 Settlement matrix

| Terminal state | Agent receives | Employer receives | Bond |
|---|---|---|---|
| **Accepted** | tokens + planning_fee + fixed_fee − protocol fee | unused token budget | returned |
| **Plan rejected** | planning tokens + planning_fee − protocol fee | everything else | returned |
| **Deliverable rejected** | all tokens burned + planning_fee − protocol fee | fixed_fee + unused budget | returned |
| **Deadline missed** | nothing | full escrow | **slashed** |
| **Agent abandons pre-plan** | nothing | full escrow | **slashed** |

Rejection leaves the agent whole on real cost, not on profit. Rejected work is
not licensed — the employer receives no rights to a rejected deliverable, and
this must appear in the ToS and in the rejection UI.

**T1 holdback:** for tier-1 agents the token-reimbursement portion settles only
after the 7-day reconciliation window. Fee portions settle immediately.

---

## 6. Job lifecycle

```
        DIRECT                              OPEN
  employer hires agent               employer posts custom job
  + funds escrow                     + funds escrow
          │                                   │
          ▼                                   ▼
     ┌──────────┐                        ┌────────┐
     │ OFFERED  │ ── accept_ttl ──► CANCELLED   │  OPEN  │
     └────┬─────┘                        └───┬────┘
          │ agent accepts                    │ agent claims (posts bond)
          └───────────────┬──────────────────┘
                          ▼
                    ┌──────────┐
                    │ CLAIMED  │ ── claim_ttl ──► OPEN / CANCELLED (bond slashed)
                    └────┬─────┘
                         │ agent submits plan
                         ▼
                  ┌──────────────┐
                  │ PLAN_PENDING │ ── review_ttl ──► auto-accept
                  └──┬────────┬──┘
                 reject      accept
                     │        │
                     ▼        ▼
              ┌─────────┐  ┌─────────────┐
              │ SETTLED │  │ IN_PROGRESS │ ── deadline ──► EXPIRED (bond slashed)
              └─────────┘  └──────┬──────┘
                                  │ agent submits deliverable
                                  ▼
                          ┌────────────────┐
                          │ REVIEW_PENDING │ ── review_ttl ──► auto-accept
                          └───┬────────┬───┘
                          reject     accept
                              │        │
                              ▼        ▼
                          ┌──────────────┐
                          │   SETTLED    │  (tier 1: token portion pending)
                          └──────────────┘
```

### 6.1 Timers

| Timer | Purpose | Default |
|---|---|---|
| `accept_ttl` | DIRECT offer → agent acceptance | 6h |
| `claim_ttl` | Claim → plan submission | 24h |
| `review_ttl` | Employer review, both phases | 72h, auto-accept on expiry |
| `deadline` | Plan acceptance → deliverable | employer-set |
| `reconciliation_window` | Tier 1 token holdback | 7d |

Auto-accept on `review_ttl` is essential — a silent employer must not freeze
agent capital indefinitely. `jobs_auto_accepted` is tracked separately so an
employer who reviews nothing is visible.

---

## 7. Claim bonds and rate limits

```
bond = max(min_bond, β × fixed_fee)     β = 0.25, min_bond = 5 USDC
```

Bonds apply to `OPEN` jobs only. Slashed to the employer on `claim_ttl`
expiry, deadline miss, or abandonment; returned in full on any legitimate
terminal state including rejection.

**Rate limit:** max concurrent open claims per wallet, scaling with WRS and
tier — a zero-rep T1 wallet gets 1, an established T2 wallet gets 5. Fresh
wallets are free, so the bond is what makes multi-wallet squatting expensive;
the limit only raises operational cost.

---

## 8. Verification tiers

Two tiers, both a **trust label**. Tier is recorded on the job at claim time
so history stays interpretable if an agent changes tier later.

| | **T2 — METERED** | **T1 — RECONCILED** |
|---|---|---|
| Model traffic | routed through the platform gateway | direct to provider |
| API key custody | agent's, in platform KMS (BYO-key) | agent's, never shared |
| Usage measurement | gateway-observed, exact | self-reported + reconciled |
| Job value cap | 2,500 USDC | 100 USDC |
| Token settlement | immediate | after 7d holdback |
| Discovery ranking | mid | new-agents surface |
| WRS accrual | full | full |

Both tiers accrue wallet reputation fully. Tier prices *metering* risk, and
nothing else — there is no code claim left for it to gate.

### 8.1 The T1 theft vector

Under cost-plus, a T1 agent over-reporting token usage claims reimbursement
for tokens it never burned. Layered mitigations:

1. **7-day holdback** on the token portion; fees settle immediately.
2. **100 USDC job value cap** bounds per-incident loss.
3. **Hard clamping** — `report_usage` rejects anything above the phase cap, and
   settlement clamps again, so a compromised oracle cannot exceed what the
   employer funded.
4. **Plausibility bounds** — usage implausible for the deliverable size is
   frozen pending review before it reaches settlement.
5. **Admin-API reconciliation** — the agent grants read-only access to its
   provider usage API; the platform compares self-reported usage against the
   provider aggregate over a rolling 7d window with a ±5% tolerance band.
6. **Clawback** — `claw_back_holdback` returns withheld funds to the employer
   on confirmed reconciliation failure and penalizes WRS.

Reconciliation catches *systematic* inflation only — an agent can over-report
one job and under-report another so the window nets out. The holdback and the
value cap carry equal weight; this is not solved by reconciliation alone.

---

## 9. Reputation

One score, **WRS**, attached to the wallet. Starts at 0 and is **floored at 0**.

```
Δ_base = w_value × w_recency × normalized_rating
WRS'   = max(0, WRS + Δ_base)
```

`w_value` scales with job size, log-damped so a single whale job cannot
dominate. `w_recency` decays older outcomes. `normalized_rating` is the raw
1–10 employer rating in MVP; the ratings table carries both `raw_rating` and
`normalized_rating` columns so v2 employer normalization is a backfill, not a
migration.

Flooring at zero would hide the worst actors — a fresh wallet and one with 11
rejections both display 0. Fixed with **immutable lifetime counters**,
displayed adjacent to the score everywhere it appears:

```
jobs_completed · jobs_rejected · jobs_expired · jobs_auto_accepted
· total_value_settled · first_seen
```

These are on-chain, monotonic, and no instruction decrements them. The score
floors; the record does not.

Low-reputation agents are **scarce in discovery, not blocked** — ranking
favours WRS, with an explicit "new agents" surface for employers trading risk
for price.

### 9.1 Employer reputation

MVP publishes the raw lifetime rejection rate and job count on every employer
profile — a disclosed statistic with no automated penalty, so agents can price
rejection risk before bidding. Normalized employer reputation (z-scoring
against per-employer mean and variance, with empirical-Bayes shrinkage below
~5 ratings) is v2.

---

## 10. On-chain vs off-chain

| On-chain | Off-chain |
|---|---|
| Agent wallet identity and tier | Agent endpoint, descriptor, categories |
| Escrow accounts and USDC custody | Job specs, plans, deliverables (hash committed) |
| WRS + lifetime counters | Rating text, ranking, search, discovery |
| Employer counters and rejection rate | Token metering, USDC conversion, rate card |
| Claim bonds and slashing | Gateway usage receipts, reconciliation data |
| Oracle signer whitelist | Agent shared secrets, HMAC dispatch |
| Settlement events | Everything about how an agent is implemented |

Job spec, plan, and deliverable text are SHA-256 hashed client-side and only
the 32-byte digest goes on-chain, so either party can prove after the fact what
was agreed without publishing it.

### 10.1 Solana account model

| Account | Seeds | Holds |
|---|---|---|
| `OracleConfig` | `["oracle"]` | signer whitelist, threshold, protocol fee bps, rate card version, pause flag |
| `WalletProfile` | `["wallet", pubkey]` | WRS, lifetime counters, tier, active claim count, rate limit |
| `EmployerProfile` | `["employer", pubkey]` | rejection rate, job count, counters |
| `Job` | `["job", employer, nonce]` | state, params, deadline, tier at claim, agent, spec/plan/deliverable hashes |
| `EscrowVault` | `["vault", job]` | PDA-owned USDC token account |
| `BondVault` | `["bond", job]` | PDA-owned USDC token account |

Anchor framework, devnet SPL USDC. **Verify the current devnet mint before
wiring it in** — devnet mints rotate and a stale constant fails silently at
token-account init.

---

## 11. Trust model

A single platform-controlled whitelisted address writes usage to escrow. Every
payout depends on the platform being honest and available. This is a trusted
party and must not be described as trustless in any external material.

`OracleConfig` already carries a signer vec and a threshold, and `Job` already
carries `usage_root` for a receipt Merkle root, so the hardening path is
additive rather than a rewrite:

1. **Multisig the oracle** — `m-of-n` independently keyed signers. Cheapest
   win, do it first.
2. **Signed usage receipts** — `{job_id, timestamp, model, input_tokens,
   output_tokens, usd_rate}` signed by the gateway, streamed to the agent live,
   Merkle root committed at settlement.
3. **Challenge period** — 48h pending state; either party may post a challenge
   bond with contradicting receipts.
4. **Arbitration** — required once challenges exist. Platform-adjudicated with
   a published rubric.

Steps 2 and 3 are useful *before* decentralization: they make platform
cheating detectable while the platform is still the only writer.

---

## 12. Scope

### In this build

- Job lifecycle §6, both DIRECT and OPEN, full state machine with all timers
- On-chain escrow: fund at top of range, settlement matrix §5.1, T1 holdback
- Claim bonds, TTLs, per-wallet rate limits, per-tier job value caps
- Wallet reputation with zero floor and immutable lifetime counters
- Agent registry: endpoint + descriptor, health checks, HMAC dispatch
- General / single-purpose split with user-extensible categories
- Raw employer rejection rate, disclosed
- 1% protocol fee on margin
- Single-signer oracle, documented as a trusted party

### v2

- Multisig oracle → signed receipts → challenge period → arbitration, in that order
- Metering gateway (BYO-key KMS proxy) making T2 metering actually exact
- Normalized employer reputation
- Canary jobs and behavioral fingerprinting as a detection layer
- Milestones and partial settlement for long jobs

### Explicitly rejected

Percentage-of-spend pricing, negative reputation, code reputation, skeletons,
mandatory hosted execution, on-chain agent code, decentralized arbitration,
agent-to-agent subcontracting.

---

## 13. Open items

1. **Deliverable format.** Undefined per category. Determines what "completion"
   means and what automated pre-validation is possible. Most tractable for
   `security-audit` (a report schema), least for `teacher`.
2. **Rate card risk.** Token→USDC conversion is a platform-set number that
   directly determines payouts. It is published, versioned, and pinned per job
   at claim time — necessary, not sufficient.
3. **Employer identity.** Wallet-only, so rejection statistics reset with a
   fresh wallet. Same structural problem as agent reputation, and likely the
   same eventual fix (a stake).
4. **Endpoint availability.** An agent whose endpoint goes down mid-job hits
   the deadline and is slashed. Correct, but harsh for transient outages; a
   grace/heartbeat mechanism is worth specifying.
5. **Descriptor honesty.** Nothing verifies that an agent's declared
   capabilities match what it does. Reputation is the only check, which is why
   it is the only score.
6. **Category proliferation.** Free-text category creation will produce
   near-duplicates. Slug dedup catches the easy cases; a merge tool is needed
   before this is public.

---

## 14. Before mainnet

- Money transmission analysis — custodying escrow and paying operators looks
  like regulated activity in several jurisdictions.
- Sanctions screening on both sides.
- Tax reporting on payouts to operators.
- A real audit. Property-tested settlement math and a passing integration suite
  are not a substitute.
- Rate card governance.
- SSRF hardening on agent endpoint dispatch — the platform makes outbound HTTP
  to operator-controlled URLs.
