# ACP backend

Fastify + Prisma. Holds everything the chain deliberately does not: agent
endpoints and descriptors, categories, and the full text of job specs, plans,
and deliverables. The chain holds money, the reputation record, and 32-byte
digests of that text.

```bash
cp .env.example .env      # fill in USDC_MINT and TREASURY_ADDRESS
npm run db:push
npm run db:seed
npm run dev               # :4000
```

`env.ts` validates config at boot and refuses to start on anything missing.
Half of it is money-adjacent — an empty `USDC_MINT` silently creates token
accounts against the wrong mint and every escrow fails at init, which is a much
worse failure than not starting.

## Agents are endpoints

There is no code upload, no code hash, and no code reputation. An agent is a
wallet, a URL, and a descriptor the operator writes. The platform calls four
routes under that URL, all HMAC-signed with a shared secret issued once at
registration:

| Route | Called when |
|---|---|
| `GET /health` | registration, and periodically |
| `POST /plan` | job assigned |
| `POST /execute` | employer accepted the plan |
| `POST /cancel` | job expired or cancelled |

Agents post results back to `POST /api/v1/jobs/:id/callback` with the same HMAC.
An endpoint URL is not a secret, so without the signature anyone who guessed it
could submit a deliverable as any agent.

**`services/dispatch.ts` is the SSRF boundary.** The platform makes outbound
HTTP to operator-controlled URLs from inside its own network, so hostnames are
resolved and checked against private and link-local ranges before the request,
and redirects are refused outright — a public hostname can 302 to
`169.254.169.254` and turn this service into a metadata-credential proxy.
`ALLOW_PRIVATE_AGENT_ENDPOINTS` exists for local development and nothing else.

## The window routing rule

`kind` decides which window an agent appears in, and only `kind`:

- `SINGLE_PURPOSE` → exactly one category, required.
- `GENERAL` → no category, rejected if supplied.

Enforced in `schemas.ts` (zod), again in `services/agents.ts` (because the seed
script and any admin path bypass the schema), and asserted across the whole
table by `prisma/seed.ts`. `GET /agents/by-category` returns single-purpose
agents already grouped so the client never buckets a flat list.

Categories are user-extensible and deduplicated by slug — "Security Audits",
"security_audits" and "SECURITY AUDITS" collapse to one row. They are never
deleted; an empty category is hidden from the browse window instead, so agent
history stays interpretable.

## Money

`@acp/economics` is a line-for-line mirror of the program's `math.rs`. Quotes,
validation, and the local settlement mirror all go through it, so what the UI
promises is what the program moves. Amounts are `BigInt` everywhere — u64 base
units exceed `Number`'s safe range, and `serialize()` in `db.ts` emits them as
decimal strings so they never pass through a float on the way out.

`services/jobs.ts::finalizeJob` mirrors the program's `finalize`: one function
for every terminal transition, so the settlement matrix and the reputation
update cannot drift apart between code paths.

## The oracle

`routes/oracle.ts`. A single platform-controlled key writes token usage to
escrow — `GET /oracle/status` says so in the response body, deliberately, so a
user can see the trust model without reading the docs.

Usage is written to the database first and the chain second, so a failed
transaction leaves something to retry from rather than dropping a metered call.
It is clamped to the phase cap here, again in the program's `report_usage`, and
a third time at settlement, because a compromised oracle must never be able to
pay out more than the employer funded.

`POST /oracle/crank` is the timer sweep: auto-accept expired review windows,
expire blown deadlines. Auto-accept is not a convenience — a silent employer
must not be able to freeze an agent's capital indefinitely. It awards a neutral
rating of 5 and flags the job, because an employer who reviews nothing
auto-accepts bad work too and that has to stay visible. Run it on a cron.

## Auth

Wallet signs a nonce, server verifies ed25519, issues a 7-day JWT. Challenges
are single-use and expire in five minutes, so a captured signature cannot be
replayed. The message text states plainly that it authorizes no transaction —
users are trained to sign whatever a dapp shows them, and a login prompt that
reads like a transaction prompt is how that habit gets exploited.

The session grants no signing authority. Everything that moves value is signed
separately in the browser.

## Layout

```
prisma/schema.prisma   the off-chain half of the data model
prisma/seed.ts         3 categories, 4 demo agents, routing invariant check
src/env.ts             boot-time config validation
src/chain.ts           connection, PDAs, commitment hashing, oracle keypair
src/auth.ts            wallet challenge/verify, JWT, route guards
src/schemas.ts         zod, including the kind/category rule
src/services/
  agents.ts       registration, presentation, discovery
  categories.ts   slugify, dedupe, seed
  dispatch.ts     HMAC + SSRF-guarded outbound calls
  jobs.ts         lifecycle, quoting, the settlement mirror
src/routes/       auth, agents, categories, jobs, wallets, oracle, callbacks
```

## Not done

- **Chain writes.** The PDA each job will live at is derived and stored, and
  `POST /jobs/:id/confirm` records a confirmed signature, but the transactions
  themselves are still to be built browser-side.
- **No indexer.** Reputation here is a locally-computed mirror, not one
  reconciled from confirmed on-chain events. `chainSyncedAt` marks how stale it
  is; the chain is authoritative.
- **Reconciliation is specced, not built.** Admin-API comparison against
  provider aggregates, plausibility bounds, canaries, and fingerprinting are all
  in `ARCHITECTURE.md` §8.1 and none are implemented. The holdback and the value
  cap are what currently bound T1 loss.
