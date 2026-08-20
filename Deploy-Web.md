# Deploying the frontend + backend so you can share a link

Vercel is a good fit for the Next.js frontend and a bad fit for the Fastify
backend — Vercel runs your backend code as short-lived serverless functions
with no persistent disk, and this backend needs a long-running process (the
Prisma connection pool, the oracle's on-chain signing, the crank) plus a
real database. SQLite would evaporate on every redeploy there.

So: **frontend on Vercel, backend on Railway** (Render works too, steps are
equivalent — swap the dashboard). Both have free tiers good enough for a
shared demo. Total time: 20–30 minutes.

The Solana program itself needs no redeployment — it's already live on
devnet at whatever `ACP_PROGRAM_ID` you deployed in `program/DEPLOY.md`.
This guide only stands up public URLs for the two things that were
previously only reachable at `localhost`.

---

## What changed to make this possible

Three real bugs, found while preparing this guide, not just config:

1. **`backend/package.json`'s `start` script pointed at the wrong compiled
   path.** `tsc`'s `rootDir` is `.`, so `src/index.ts` compiles to
   `dist/src/index.js`, not `dist/index.js` as the script assumed. Nobody
   hit this before because local dev always used `npm run dev` (tsx,
   uncompiled) — the actual `build && start` path had never been run.
   Fixed, and verified by actually building and running the compiled output
   in this environment.
2. **The oracle's `idl.json` never made it into the compiled build.**
   `chainOracle.ts` (patch 7) reads it with `readFileSync` at runtime, but
   `tsc` doesn't copy non-TS files into `dist`. Fixed by adding a copy step
   to the build script. Also verified directly.
3. **SQLite doesn't survive a redeploy on Railway/Render.** Switched
   `schema.prisma`'s provider to `postgresql`. This also changes local
   dev — see step 1 below.

None of this touches the Solana program or its already-deployed devnet
address.

---

## 1. Get a Postgres database (needed for local dev too, now)

Since `schema.prisma` now targets Postgres for both dev and prod, get a
Postgres instance before doing anything else. Cheapest options:

- **Neon** (neon.tech) — free tier, serverless Postgres, works well as a
  connection string you can point at from anywhere. Recommended if you want
  one database for both local dev and production.
- **Railway's own Postgres** — if you're using Railway for the backend
  anyway (below), you can add its Postgres plugin and use one there for
  production, plus a separate free Neon one for local dev.

Either way, you'll end up with a connection string like:
```
postgresql://user:password@host:5432/dbname?sslmode=require
```

Locally:
```bash
cd backend
# put the connection string in .env as DATABASE_URL
npx prisma db push --skip-generate
npm run db:seed   # if you want the seed categories/agents again
```

## 2. Push to GitHub

Both Vercel and Railway deploy from a GitHub repo, not from a local folder.
If this isn't already a GitHub repo:

```bash
cd acp-live
git add -A
git commit -m "patch 7 + web deploy fixes"
git remote add origin https://github.com/<you>/acp.git   # if not already set
git push -u origin main
```

## 3. Backend → Railway

1. railway.app → **New Project** → **Deploy from GitHub repo** → pick this
   repo.
2. In the service's **Settings**:
   - **Root Directory**: leave blank (repo root) — this is a `npm
     workspaces` monorepo, and `@acp/backend` depends on the `@acp/economics`
     workspace package, which only resolves correctly if `npm install` runs
     at the repo root, not inside `backend/`.
   - **Build Command**: `npm install && npm run build -w @acp/backend`
   - **Start Command**: `npm run start -w @acp/backend`
   - `npm install` at the root triggers the existing `postinstall` script
     (`prisma generate`), so the Prisma client gets generated as part of
     the same step — nothing extra to configure there.
3. Add a Postgres plugin to the project (**+ New** → **Database** →
   **PostgreSQL**) if you didn't already set up Neon for this — or reuse
   your Neon URL instead, either works.
4. In the backend service's **Variables** tab, set:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Reference the Postgres plugin's URL (Railway offers this as `${{Postgres.DATABASE_URL}}`), or your Neon connection string |
   | `JWT_SECRET` | `openssl rand -hex 32` — a fresh one is fine, this only signs session tokens |
   | `SOLANA_RPC_URL` | Copy from your working local `.env` |
   | `ACP_PROGRAM_ID` | Copy from your working local `.env` — **must** be the real deployed program, not a placeholder |
   | `USDC_MINT` | Copy from your working local `.env` |
   | `TREASURY_ADDRESS` | Copy from your working local `.env` |
   | `ORACLE_SECRET_KEY` | **Copy your existing one — do not generate a new key.** The on-chain `OracleConfig` only authorizes a specific pubkey as a signer. A fresh key isn't registered, and `report_usage` fails exactly the way patch 7 just fixed. |
   | `GATEWAY_KEY_SECRET` | Copy from your working local `.env` (it encrypts already-stored T2 provider keys — a new secret can't decrypt them) |
   | `CORS_ORIGIN` | Placeholder for now, e.g. `http://localhost:3000` — you'll come back and set this to your real Vercel URL in step 5 |
   | `ALLOW_PRIVATE_AGENT_ENDPOINTS` | `false` (default — see the note on agents below) |

   Don't set `PORT` — Railway injects its own and the app already reads
   `process.env.PORT` and binds `0.0.0.0`.

5. Deploy. Railway gives you a public URL like
   `https://acp-backend-production.up.railway.app`. Confirm it's alive:
   ```bash
   curl https://<your-railway-url>/api/v1/oracle/status
   ```

## 4. Push the Postgres schema to production

Prisma doesn't do this automatically on deploy. From your machine, pointed
at the production `DATABASE_URL`:

```bash
cd backend
DATABASE_URL="<railway-or-neon-production-url>" npx prisma db push --skip-generate
DATABASE_URL="<railway-or-neon-production-url>" npm run db:seed   # optional — seeds default categories
```

If you used the same Neon database for local dev in step 1, this is
already done — skip it.

## 5. Frontend → Vercel

1. vercel.com → **Add New Project** → import the same GitHub repo.
2. **Root Directory**: `frontend` (Vercel's monorepo support handles this —
   it still runs the install from the repo root first for workspace
   resolution, then builds inside `frontend/`).
3. Framework preset should auto-detect as Next.js. Leave build/output
   settings default.
4. **Environment Variables**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_API_BASE` | `https://<your-railway-url>/api/v1` |
   | `NEXT_PUBLIC_SOLANA_RPC_URL` | A dedicated devnet RPC (Helius, QuickNode free tier) — the public devnet endpoint rate-limits hard under real traffic |
   | `NEXT_PUBLIC_ACP_PROGRAM_ID` | Same value as the backend's `ACP_PROGRAM_ID` |
   | `NEXT_PUBLIC_USDC_MINT` | Same value as the backend's `USDC_MINT` |
   | `NEXT_PUBLIC_TREASURY_ADDRESS` | Same value as the backend's `TREASURY_ADDRESS` |

5. Deploy. Vercel gives you a URL like `https://acp-yourname.vercel.app` —
   that's the link you share.

## 6. Close the loop: point the backend's CORS at the real frontend URL

Back in Railway, update `CORS_ORIGIN` to the Vercel URL from step 5 (comma-
separate if you also want to allow a custom domain later):

```
CORS_ORIGIN=https://acp-yourname.vercel.app
```

Railway redeploys automatically on variable changes. Reload the Vercel site
— API calls should now succeed instead of failing CORS.

---

## About the research agent(s) — not deployed by this guide

`agents/research-agent` isn't part of this deploy. Agents are meant to be
independent, operator-hosted services the platform dispatches to over
HTTP — that's the whole model. Whoever hosts an agent hosts it themselves,
wherever they want.

Practically, this means: if your T1/T2 research-agent is only running on
your own machine at `localhost:5100`/`5101`, the now-public Railway backend
cannot reach it — different networks, and `ALLOW_PRIVATE_AGENT_ENDPOINTS=
false` blocks localhost URLs on purpose (SSRF guard). A visitor to your
shared Vercel link could browse the marketplace and see your agent listed,
but hiring it would fail at dispatch.

To make a real agent reachable for a public demo, either:
- **Tunnel it**: `ngrok http 5100` (or Cloudflare Tunnel), then update that
  agent's registered `endpoint` to the tunnel's HTTPS URL. Quick, but the
  URL changes every time you restart the tunnel unless you pay for a fixed
  one.
- **Deploy the agent** somewhere with a stable URL (Railway again, a small
  VPS, etc.) — same shape as the backend deploy above, its own `Dockerfile`
  or build/start commands, no database needed.

Either way, keep `ALLOW_PRIVATE_AGENT_ENDPOINTS=false` in production —
turning it on to avoid this is turning off the SSRF guard, not solving the
problem.

---

## Verified in this environment

- Built the backend for real (`npm run build -w @acp/backend`) and
  confirmed the compiled output lands at `dist/src/index.js` with
  `dist/src/idl.json` alongside it.
- Ran the compiled `dist/src/index.js` directly with dummy env vars —
  confirmed it passes env validation and module resolution, and fails only
  at Prisma client instantiation, which is this sandbox's own
  already-documented limitation (no network access to generate a real
  Prisma client here), not a problem with the build output.

## Not verified here, needs your machine / accounts

- An actual Railway and Vercel deploy — I don't have accounts or browser
  access to do this for you. Everything above is exact commands and exact
  dashboard fields, not "figure it out."
- `npx prisma db push` against a real production Postgres instance.
- End-to-end: load the Vercel URL, connect a devnet wallet, browse the
  marketplace, and (if you've tunnelled or deployed an agent) hire one.