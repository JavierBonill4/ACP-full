# Patches to apply to your existing repo

New files drop straight in. These five existing files need edits.

**New files:**

```
backend/src/rawBody.ts
backend/src/services/agentAuth.ts
backend/src/services/keyvault.ts
backend/src/services/ratecard.ts
backend/src/services/usage.ts
backend/src/routes/gateway.ts
backend/src/routes/oracle.ts      <- replaces the existing file wholesale
agents/research-agent/**          <- new workspace package
```

---

## 1. `backend/prisma/schema.prisma`

Add the provider-key fields to `model Agent`, directly after `sharedSecret`:

```prisma
  /// HMAC key for dispatch in both directions. Shown to the operator once at
  /// registration and never again.
  sharedSecret String

  // --- T2 only: provider key held for gateway-proxied calls ---
  //
  // Tier 2 is the only tier where the platform touches key material, which is
  // exactly why tier 1 exists. AES-256-GCM under a server-held secret — see
  // services/keyvault.ts, and note that this is not a KMS and must not be
  // described as one. A tier 1 agent leaves all of these null, permanently.
  providerKeyCiphertext String?
  providerKeyIv         String?
  providerKeyTag        String?
  /// Last 4 characters only, so the operator can confirm which key is stored.
  providerKeyHint       String?
  providerKeySetAt      DateTime?
```

Then:

```bash
npm run db:push -w @acp/backend
npm run db:generate          # the root script you added earlier
```

Additive and nullable, so no data is lost and no migration is needed.

---

## 2. `backend/src/env.ts`

Add three keys to the schema object:

```ts
  AGENT_DISPATCH_TIMEOUT_MS: z.coerce.number().default(30_000),

  // --- gateway (T2) -------------------------------------------------------
  // Encrypts agent provider keys at rest. Without it, T2 agents cannot
  // register a key and the gateway refuses to run — which is the correct
  // failure, since the alternative is storing provider keys in plaintext.
  GATEWAY_KEY_SECRET: z.string().min(32).optional(),
  GATEWAY_TIMEOUT_MS: z.coerce.number().default(120_000),
```

`GATEWAY_TIMEOUT_MS` is deliberately generous — a research call with a large
`max_tokens` genuinely takes over a minute, and a gateway that times out after
30s while the provider keeps generating bills the agent for tokens nobody
receives.

---

## 3. `backend/.env.example`

```bash
# --- gateway (T2 metering) -------------------------------------------------
# Encrypts agent provider keys at rest. 32+ characters.
# NOT a KMS: anyone with the database and this value can recover every key.
# Leave empty if you only run tier 1 agents.
GATEWAY_KEY_SECRET=
GATEWAY_TIMEOUT_MS=120000
```

---

## 4. `backend/src/server.ts`

Import and register the gateway routes:

```ts
import { gatewayRoutes } from "./routes/gateway.js";
```

```ts
  await app.register(jobRoutes, { prefix: "/api/v1/jobs" });
  await app.register(walletRoutes, { prefix: "/api/v1/wallets" });
  await app.register(oracleRoutes, { prefix: "/api/v1/oracle" });
  await app.register(gatewayRoutes, { prefix: "/api/v1/gateway" });   // <- add
  await app.register(callbackRoutes, { prefix: "/api/v1" });
```

---

## 5. Root `package.json`

Add the agent to the workspace list:

```json
"workspaces": ["shared/*", "backend", "frontend", "program", "agents/*"],
```

Then `npm install` from the root.

---

## What changed, and why

### The usage endpoint is no longer open

`POST /oracle/jobs/:id/usage` previously took anyone's word for it. Anybody who
learned a job id could write usage against it and drain that job's escrow up to
its cap. It now requires an `X-ACP-Agent` header and an HMAC over the raw body,
verified against that agent's shared secret, **and** checks the agent actually
holds the job — authentication alone would still let any registered agent bill
against any job.

Same treatment for `POST /jobs/:id/callback`, which previously verified the
signature but derived the agent from the job rather than from the caller.

`POST /oracle/crank` stays open on purpose. It can only advance a job to the
state its own expired timers already dictate, and making it permissionless is
what stops a silent employer freezing an agent's capital.

### T2 now means something

There was no gateway. Tier 2 claimed exact metering, granted a 25× higher value
cap and immediate payout, and measured nothing — the least honest configuration
in the system, and my fault for shipping the label without the mechanism.

`POST /gateway/messages` is the mechanism. A T2 agent registers a provider key,
calls the gateway instead of the provider, and the gateway reads token counts
out of the provider's response and records them before returning. The agent
never supplies the number that determines its own reimbursement.

Consequences worth knowing:

- **T2 agents are now refused at the self-report endpoint.** Allowing both
  would put the label back to meaning nothing.
- **The platform holds key material.** Encrypted, but under a server secret,
  not a KMS. This is the real cost of T2 and it is the strongest argument for
  T1.
- **A 402 from the gateway means the call happened and the cap was breached.**
  The provider billed the agent; the platform will not reimburse past what the
  employer funded. The agent should stop and submit, not retry.

### Usage is cumulative, and clamped in one place

Both tiers now write through `services/usage.ts::recordUsage`. Reports
accumulate per phase and are clamped against the funded cap there, in the
program's `report_usage`, and again in `settle()`.

This fixed a real bug in the old code: the endpoint **assigned** rather than
added, matching the on-chain instruction, so a gateway recording each call
separately would have settled at the cost of the last call only.

### Still not built

`GET /oracle/status` now says so in its response body. Reconciliation against
provider aggregates, plausibility bounds, canary jobs, and behavioural
fingerprinting are all specced in `ARCHITECTURE.md` §8.1 and none exist. T1
usage is bounded, not checked.
