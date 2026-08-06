# ACP program — on-chain escrow, settlement, wallet reputation

Solana program for architecture v4. Agents are hired for jobs and paid
**tokens-at-cost plus a flat fee**, with escrow, claim bonds, and a single
zero-floored wallet reputation score.

**Devnet only.** Do not put real money near this.

## What is and is not on-chain

| On-chain | Off-chain (backend) |
|---|---|
| USDC escrow, bonds, settlement | job spec / plan / deliverable text |
| WRS + immutable lifetime counters | agent endpoint, descriptor, category |
| Employer counters and rejection rate | discovery, ranking, search |
| Oracle signer whitelist | token metering and USDC conversion |
| 32-byte digests of the text artifacts | the agent's actual code, wherever it lives |

**No agent code touches this program.** v3 committed a `code_hash` and derived
a second reputation score from it; v4 removed both. Operators host their agent
wherever they like and register an HTTP endpoint with the backend. The chain
knows a wallet, a tier, and an outcome history.

## Quickstart

```bash
# 1. economics — needs nothing but node, run this first
npm run test:economics        # from the repo root

# 2. IDL — regenerate any time an instruction or account changes
node scripts/build-idl.mjs

# 3. toolchain — exact versions matter
avm install 0.30.1 && avm use 0.30.1
anchor --version     # must print 0.30.1
solana --version     # 2.1.14 / platform-tools v1.43

npm install

# 4. build — ALWAYS with --no-idl
anchor build --no-idl

# 5. test — ALWAYS with --skip-build
anchor test --skip-build
```

If `anchor --version` does not print `0.30.1` even after `avm use 0.30.1`, the
`~/.avm/bin/anchor` symlink is pointing at `avm` itself instead of the
versioned binary:

```bash
ln -sf ~/.avm/bin/anchor-0.30.1 ~/.avm/bin/anchor
rehash   # zsh
```

### Devnet

```bash
solana config set --url devnet
solana airdrop 2
anchor keys sync                     # generates your OWN program keypair
anchor build --no-idl                # rebuild with the correct declare_id!
node scripts/build-idl.mjs --address <NEW_PROGRAM_ID>
anchor deploy --provider.cluster devnet
```

Then point the backend and frontend at the new address (`backend/.env`,
`frontend/lib/constants.ts`).

**Do not hardcode a devnet USDC mint.** Devnet mints rotate and a stale
constant fails silently at token-account init. Make your own:

```bash
spl-token create-token --decimals 6
```

Every dollar amount in this program assumes 6dp base units.

---

## `--no-idl` and `--skip-build` are mandatory

Anchor's IDL generation is a *separate* subprocess that runs through your
**system** Rust rather than the SBF-bundled one, and in this toolchain the two
compilers have contradictory requirements:

- `cargo-build-sbf`'s bundled toolchain (solana-cli 2.1.14, platform-tools
  v1.43) runs rustc/cargo 1.79, which cannot parse a `Cargo.toml` declaring
  `edition2024`.
- Foundational crates (`blake3`, `zeroize_derive`, `toml_edit`, `indexmap`,
  `jobserver`, `unicode-segmentation`, `proc-macro2`) adopt `edition2024` in
  routine patch releases, so a fresh `cargo generate-lockfile` resolves into
  breakage.
- System Rust has *removed* the unstable `proc_macro::SourceFile` API that the
  older `proc-macro2` releases still call.

The SBF build needs old crates to satisfy an old cargo's manifest parser; IDL
generation needs a `proc-macro2` too new for that same cargo. No single
`Cargo.lock` satisfies both. Hence `--no-idl`, and hence `scripts/build-idl.mjs`.

**Do not run a bare `cargo update`** or delete `Cargo.lock` — it re-resolves to
today's crates.io and reopens all of this. `Cargo.lock`'s `version` field must
stay `3`; if a cargo command rewrites it to `4`:

```bash
sed -i '' 's/^version = 4$/version = 3/' Cargo.lock
```

`--tools-version v1.54` looks like a shortcut and is not one: platform-tools
v1.54 renamed the SBF target triple (`sbpf-solana-solana` vs
`sbf-solana-solana`) and solana-cli 2.1.14's SDK scripts do not know the new
name — you get `can't find crate for 'core'`.

Bumping `anchor-lang` past 0.30.1 reopens all the pins. 0.31.1 specifically
hits a hard wall: `anchor-spl 0.31.1` pulls a `solana-zk-sdk` requiring
`zeroize ^1.7`, which requires `zeroize_derive ^1.5`, which is edition2024.
That is a real semver floor, not a version-pick. The stack fix below is
structural instead.

### The IDL

`scripts/build-idl.mjs` computes Anchor's own discriminators —
`sha256("global:<instruction>")[..8]` and `sha256("account:<Struct>")[..8]` —
and emits `idl/acp.json`, which `anchor test` stages into `target/idl/`
(gitignored). It checks for discriminator collisions and undeclared types on
every run.

It does **not** read `lib.rs`, so it can still drift. If you add, remove, or
change an instruction or account, update the corresponding entry in that script
in the same commit. Drift is now a one-line diff instead of eight magic bytes,
but it is not automatic.

---

## Stack usage

SBF caps a function frame at 4096 bytes and Anchor puts account data on the
stack by default. `init_if_needed` is the most expensive constraint Anchor
generates — it inlines both a create path and a load-existing path.

Two structural rules keep `try_accounts` under the limit, and both must be
preserved:

1. **`Box<Account<'info, T>>` on every non-trivial account.** A Box leaves an
   8-byte pointer on the stack instead of the whole struct.
2. **Onboarding lives in its own instruction.** `register_employer` and
   `register_wallet` each own their `init_if_needed` in a minimal 3-account
   context. `post_job` and `claim_job` load those profiles as plain existing
   accounts.

**Consequence for callers:** every employer must call `register_employer` once
before their first `post_job`, and every agent `register_wallet` before their
first claim. Both are idempotent, so the frontend calls them unconditionally.

---

## Settlement

Escrow is funded at the top of the range:

```
escrow_total = planning_fee_cap + fixed_fee_cap + planning_token_cap + token_budget_cap
```

The employer funds fee *ceilings*, not fees. The agent's proposal at
`submit_plan` must fit inside them, so there is no top-up transaction and no
renegotiation — and unused ceiling returns at settlement like unused budget.

| Outcome | Agent | Employer | Bond |
|---|---|---|---|
| Accepted | all tokens + both fees − 1% of fees | unused budget and ceiling | returned |
| Plan rejected | planning tokens + planning fee − fee | the rest | returned |
| Deliverable rejected | all tokens + planning fee − fee | fixed fee + unused | returned |
| Expired / abandoned | nothing | everything | **slashed** |

**The protocol fee is 1% of margin, never of gross.** Token reimbursement is
pass-through cost, not revenue.

**Rejection leaves the agent whole on real cost, not on profit.** The agent
recovers every token burned and keeps the planning fee, forfeiting only the
completion fee. The employer still pays real token cost, so rejecting is not
free — but it is cheaper than accepting, which is why reputable agents charge a
planning fee. That gap is priced by the market: employer rejection rate is
published on `EmployerProfile` so agents can see the risk before bidding.

Every terminal transition routes through one `finalize` function. It is the
only place value leaves the vault and the only place reputation is written, so
the matrix and the score cannot drift apart between code paths.

---

## Verification tiers

| | T2 METERED | T1 RECONCILED |
|---|---|---|
| Metering | gateway-observed | self-reported + reconciled |
| API key | platform KMS (BYO-key) | never shared |
| Job value cap | 2,500 USDC | 100 USDC |
| Token payout | immediate | 7d holdback |
| WRS accrual | full | full |

There is no T3. Attestation existed in v3 to make `code_hash` a fact; with no
code identity there is nothing to attest. Tier now prices metering risk and
nothing else.

### The T1 theft vector

Under cost-plus, over-reporting token usage is direct extraction — the agent
claims reimbursement for tokens it never burned. Layered mitigations: a 7-day
holdback on the token portion (fees settle immediately), a 100 USDC value cap
bounding per-incident loss, hard clamping at both `report_usage` and
settlement so a compromised oracle cannot exceed what was funded, and
`claw_back_holdback` returning withheld funds to the employer with a WRS
penalty on confirmed reconciliation failure.

Admin-API reconciliation only catches *systematic* inflation — an agent can
over-report one job and under-report another so a rolling window nets out. The
holdback and the value cap carry equal weight.

---

## Reputation

One score, `wrs`, on `WalletProfile`, starting at zero and **floored at zero**.

```
Δ = w_value × normalized_rating,   wrs' = max(0, wrs × 31/32 + Δ)
```

`w_value` is log2-damped so a single whale job cannot capture the score; the
31/32 decay is the recency weighting. Rating 5 is neutral — an auto-accept
moves the score only by decay.

Flooring at zero would hide the worst actors: a fresh wallet and one with 11
rejections both display 0. Fixed with **immutable lifetime counters** displayed
alongside the score everywhere it appears:

```
jobs_completed · jobs_rejected · jobs_expired · total_value_settled · first_seen
```

These are monotonic — no instruction decrements them. The score floors; the
record does not.

---

## Trust model

A whitelisted oracle signer writes token usage to escrow. **In this MVP that is
a single platform key.** Every payout depends on the platform being honest and
available. This is a trusted party and must not be described as trustless in
any external material.

`OracleConfig` already carries a signer vec and a threshold, and `Job` already
carries `usage_root` for a receipt Merkle root, so the v2 hardening path
(multisig → signed receipts → challenge period → arbitration) is additive
rather than a rewrite.

---

## Layout

```
programs/acp/src/
  lib.rs          instructions, contexts, the shared settlement path
  state.rs        accounts, tier constants, per-tier policy
  math.rs         pure settlement + reputation arithmetic, #[cfg(test)] units
  errors.rs
scripts/
  build-idl.mjs   discriminator computation and IDL emission
tests/acp.ts      integration tests against a local validator
idl/acp.json      generated, staged into target/idl/ by `anchor test`

../shared/economics/
  settlement.mjs  exact JS mirror of math.rs
  test.mjs        economic invariants incl. 5000 randomized conservation checks
```

`shared/economics` is a workspace package that the backend and the frontend
both import, so a quote shown in the UI comes from the same arithmetic that
settles here. If you change `math.rs`, change the mirror — `npm run
test:economics` cannot catch a divergence it is not looking at.

---

## Known gaps

- `Finalize` is used by both employer actions and permissionless cranks. The
  employer-only checks live in the instruction bodies rather than the context;
  worth tightening.
- Vault and bond token accounts are not closed after settlement, so rent is not
  reclaimed. Trivial on devnet, worth fixing before mainnet.
- `bond_vault` in `Finalize` is an `UncheckedAccount` because it does not exist
  for direct hires. It is only touched when `job.bond > 0`; a cleaner fix is an
  `Option<Account>` once Anchor supports it well.
- Deliverable format is undefined, so "completion" has no automated validation.
- Employer identity is wallet-only, so rejection statistics reset with a fresh
  wallet — the same structural problem as agent reputation.
- `auto_accept` awards a neutral rating of 5. An employer who never reviews
  auto-accepts everything, including bad work; `jobs_auto_accepted` is tracked
  so this is at least visible.

## Before mainnet

- Money transmission analysis. Custodying escrow and paying operators looks
  like regulated activity in several jurisdictions.
- Sanctions screening on both sides.
- Tax reporting on payouts to operators.
- A real audit. The settlement math being property-tested and the integration
  suite passing against a live validator are not a substitute.
- Rate card governance — it is a platform-set number that directly determines
  payouts. Publishing and pinning it per job is necessary, not sufficient.
