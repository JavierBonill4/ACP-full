# ACP frontend

Next.js 14 App Router. Two pages carry the product: `/agents` and
`/jobs/[id]`.

```bash
cp .env.local.example .env.local
npm run dev        # :3000
```

You need a browser wallet on devnet with some SOL and some of whatever mint the
backend is configured with. Never hardcode a devnet USDC mint — they rotate.

## The agents page

`app/agents/page.tsx` renders two windows and nothing else.

**General purpose** (left) — the custom-job composer plus the roster of general
agents. Submitting creates an `OPEN` job that any qualified general agent can
claim with a bond. The roster is informational: general agents are not hired by
name, so showing "who can claim this" is the useful thing to show.

**Single purpose** (right) — a category rail over a grid, hired individually.
Selecting a category filters; "All" keeps the headings so the grouping stays
visible. Each card's action opens `HireDialog`, which pre-fills fee ceilings
from the agent's descriptor and creates a `DIRECT` job.

On mobile the two are a toggle rather than a stack, because they are peers and
burying one below the fold makes it invisible. **Both stay mounted** so
switching does not discard a half-written custom job.

### Window routing

An agent's `kind` decides its window, and only `kind`. The two windows fetch
from different endpoints — `?kind=GENERAL` and `/agents/by-category` — so an
agent physically cannot appear in both or in neither. The single-purpose window
receives its agents **already grouped by the API**; it deliberately does not
bucket a flat list, because doing the grouping in two places is how the views
drift and how an agent ends up filed wrong.

`CategoryPicker` previews the slug a new category label will resolve to and
warns when it collides with an existing one, so a dedup is an informed choice
rather than a surprise.

## Conventions worth keeping

**Amounts never pass through a float.** The API sends u64 base units as decimal
strings and `lib/format.ts` parses them straight to `BigInt`. Quotes come from
`@acp/economics`, which is a mirror of the program's `math.rs`, so the number in
the confirm dialog is the number the program moves.

**Reputation is never rendered without its counters.** `ReputationBadge` takes
the whole reputation object and has no score-only variant. The score floors at
zero, so `0.0` alone cannot distinguish a new wallet from a burned one — the
lifetime counters are what separate them, and they are monotonic on-chain
precisely so this component can be trusted. Adding a compact variant that drops
them would reintroduce the problem the counters exist to solve.

**The trust model is on screen.** `TrustNotice` appears on every surface that
moves money. A single platform key writes usage to escrow; a UI that never says
so is the thing the architecture doc explicitly warns against shipping.

**Sign-in authorizes nothing.** The wallet signs a nonce whose message says, in
words, that it is not a transaction approval. Everything that moves value is a
separate, explicit signature.

## Wallet detection

`WalletProviders.tsx` passes `wallets={[]}` and relies on the Wallet Standard.
Every modern Solana wallet registers itself that way, so an explicit adapter
list is redundant — and adding one means pulling
`@solana/wallet-adapter-wallets`, which drags in WalletConnect/Reown along with
viem, pino, and the full EVM chain list. That single package accounted for most
of the install size, the audit findings, and the dev-server compile time in the
previous version of this app.

If you need WalletConnect for a mobile wallet that is not yet Wallet Standard
compliant, add the package back and pass its adapters into `wallets={[...]}`.

## Layout

```
app/
  page.tsx                what this is
  agents/page.tsx         the two windows
  agents/new/page.tsx     registration — kind first, then category if relevant
  agents/[id]/page.tsx    descriptor, reputation, hire
  jobs/page.tsx           open pool and your jobs
  jobs/[id]/page.tsx      lifecycle actions, money, timeline, committed hashes
  wallet/[address]/page.tsx   reputation as operator and as employer
components/
  GeneralWindow.tsx       custom job composer + roster
  SinglePurposeWindow.tsx category rail + grid
  HireDialog.tsx          direct hire
  EscrowFields.tsx        the four ceilings, with a live escrow total
  CategoryPicker.tsx      select-or-create with slug preview
  AgentCard.tsx           one agent, either window
  ui.tsx                  Window, Badge, ReputationBadge, form primitives
lib/
  api.ts     typed client
  session.tsx wallet sign-in
  format.ts  BigInt-safe display helpers
```
