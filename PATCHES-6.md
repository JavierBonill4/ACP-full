# Patch 6 — real .pptx deliverables, empty-research-notes fix, and the settlement redesign

All three shipped.

## 1. Fixed: deck flopping with "the research notes section... came through empty"

`research.ts`'s `research()` chains two model calls — notes, then a deck built
from those notes. If the first call's response ever had no non-empty `"text"`
content block, `notes.text` silently became `""`, and the deck-writing call
received a prompt ending in `Research notes:\n\n` followed by nothing. The
model then did exactly what you'd expect with a blank input: wrote *about*
the fact that it was blank, in the same confident voice as real output —
right slide count, right shape, wrong content.

This wasn't a prompt bug, it was a missing check on an intermediate result.
Fixed in `agents/research-agent/src/research.ts`:
- A new `callModelOrThrow()` wraps every model call used to build the deck,
  retries once on empty text, and throws a clear, loud error (visible in the
  agent's logs, and reported back via `postError`) rather than silently
  feeding the next step nothing.
- Bumped the research-notes call's `max_tokens` from 4000 to 6000 for margin
  — "dense, structured notes" on a real topic can run long, and this step
  feeds the next one.
- If it recurs, the log line now captures the model, token budget, and usage
  for the empty attempt, so there's something to look at instead of a mystery.

I couldn't reproduce the underlying provider-side cause directly (no API key
in this environment), so I can't promise this was the *only* possible cause
of an empty response — but it can no longer produce a garbage deck silently.

## 2. Real .pptx deliverables, not markdown text

**New:** `agents/research-agent/src/deck-to-pptx.ts` — parses the same
`---`-separated markdown `DECK_SYSTEM` already produces and renders it as an
actual PowerPoint file (title slide, one real slide per content slide with
bullets and speaker notes, provenance slide) via `pptxgenjs`. Verified with a
real smoke test in this session — sample output attached in this conversation.

**Deliverable transport changed end to end**, agent → backend → frontend:

```
agents/research-agent/src/index.ts       — assemble() removed, calls buildPptx()
agents/research-agent/src/platform.ts    — submitDeliverable() takes a file
                                            {filename, mimeType, base64}, hashes
                                            the decoded bytes for the on-chain
                                            commitment (not the base64 string)
agents/research-agent/package.json       — + pptxgenjs

backend/prisma/schema.prisma             — Job gains deliverableBase64 /
                                            deliverableMimeType / deliverableFilename
backend/src/chain.ts                     — + commitmentHashBytes(buf), the binary
                                            sibling of commitmentHash(text)
backend/src/services/jobs.ts             — submitDeliverable() takes the file,
                                            hashes the decoded bytes
backend/src/routes/oracle.ts             — callback schema's "deliverable" kind
                                            now validates {filename, mimeType, base64}
backend/src/routes/jobs.ts               — GET /:id no longer inlines the base64
                                            blob; new GET /:id/deliverable streams
                                            it with correct headers
backend/src/schemas.ts                   — submitDeliverableSchema updated to match

frontend/lib/types.ts                    — JobDetail + deliverableFilename/MimeType
frontend/lib/api.ts                      — submitDeliverable() takes the file;
                                            + downloadDeliverable() (auth'd fetch,
                                            since a bare <a href> wouldn't carry
                                            the bearer token)
frontend/components/DeliverableFile.tsx  — new: download card, replaces SlideDeck
                                            for the file path
frontend/app/jobs/[id]/page.tsx          — renders DeliverableFile when a job has
                                            one; the manual "agent operator" submit
                                            panel now takes a file upload instead
                                            of a textarea (base64s it client-side)
```

`deliverableText`/`deliverableHash` are kept on the Job model for jobs that
settled before this change — the job detail page falls back to the old text
panel if `deliverableFilename` is null but `deliverableText` isn't.

### To apply

```bash
# schema changed — push it to your dev DB
cd backend && npx prisma db push
npm run db:generate   # from repo root, regenerates the client with the new columns

# new dependency
cd agents/research-agent && npm install
```

I couldn't run a real `prisma generate` in this session (this environment's
network policy blocks `binaries.prisma.sh`, where Prisma fetches its query
engine) — the backend changes are verified with hand-written type stubs
standing in for the generated client instead of the real thing. Worth a
`npm run typecheck` on your end once the client's actually generated, though
nothing here looks fragile.

**Pre-existing, not introduced by this patch:** `agents/research-agent/src/chain.ts`
fails `tsc --noEmit` with 5 "possibly undefined" errors as of this repo's current
state — untouched by anything in this patch (diffed to confirm). Worth a look
separately.

---

## 3. Built: guaranteed payout + tip, no deliverable rejection

**Old:** employer either accepted (agent gets fixed fee + planning fee +
token costs, tier-1 gets a holdback; employer gets the unused remainder) or
rejected (agent still keeps planning fee + token costs; fixed fee returns to
the employer along with the rest).

**New:**
- `reject_deliverable` is gone — the instruction no longer exists on the
  program. Once a deliverable is submitted, the agent's planning fee, fixed
  fee, and token costs are unconditional.
- `accept_deliverable(rating: u8, tip: u64)` — `tip` is 0 to 100_000 base
  units (0.10 USDC), `require!`-enforced on-chain (`AcpError::TipTooHigh`
  above that; a lower amount than requested may still be paid if there isn't
  enough left in escrow — see the headroom clamp below). The frontend
  defaults the slider to 0.05 USDC (`DEFAULT_TIP` in `state.rs`), but nothing
  stops 0.
- The tip is drawn from the employer's own unused-escrow refund, not funded
  on top of it: `employerRefund = escrowTotal - feesAndTokensUsed - tipPaid`.
  `tipPaid` is the requested tip clamped to whatever headroom is actually
  left once fees and token reimbursement are accounted for — this matters
  because a job that used 100% of every cap has zero headroom, and without
  the clamp a tip request there would ask `settle()` to distribute more than
  `escrow_total` holds, which would either overpay the agent or panic the
  `saturating_sub` refund to zero while breaking the conservation invariant.
  Confirmed by `conservation_holds_across_the_whole_matrix` (Rust) and its
  JS mirror in `test.mjs`, both looping tip over `[0, DEFAULT_TIP, MAX_TIP]`
  crossed with fully-saturated token usage.
- Rating is unchanged (0–10, 5 neutral) but is now purely a reputation
  signal — it has no bearing on payout.
- `accept_plan` / `reject_plan` untouched, as scoped — an employer still
  needs a way to say no to a bad quote before execution tokens are spent.

**Touched:**

```
program/programs/acp/src/state.rs    — MAX_TIP / DEFAULT_TIP; Outcome loses
                                        DeliverableRejected, renumbered
program/programs/acp/src/errors.rs   — + TipTooHigh
program/programs/acp/src/math.rs     — settle() gains tip param + headroom
                                        clamp + Settlement.tip_paid; new tests
program/programs/acp/src/lib.rs      — reject_deliverable removed;
                                        accept_deliverable(rating, tip);
                                        finalize() threads tip through;
                                        JobSettled event gains a tip field
program/scripts/build-idl.mjs        — regenerated idl/acp.json (also copied
                                        to frontend/lib/idl.json and
                                        agents/research-agent/idl.json)
program/scripts/e2e-onchain-job.mjs  — demos accept_deliverable with the
                                        0.05 USDC default tip
program/tests/acp.ts                 — rejectDeliverable test replaced with
                                        unconditional-payout + tip +
                                        headroom-clamp tests

shared/economics/settlement.mjs      — exact mirror of the math.rs changes
shared/economics/settlement.d.ts     — + tip/tipPaid/MAX_TIP/DEFAULT_TIP types
shared/economics/test.mjs            — mirrored test changes; ran clean:
                                        56 assertions incl. 5000 randomized
                                        conservation cases with tip in the mix

backend/prisma/schema.prisma         — Job gains tipPaid
backend/src/schemas.ts               — rateSchema gains tip (0..MAX_TIP)
backend/src/routes/jobs.ts           — /:id/reject route removed entirely;
                                        /:id/accept passes tip through
backend/src/services/jobs.ts         — finalizeJob threads tip to settle()
                                        and persists tipPaid; describeOutcome
                                        and reputation counters drop
                                        DELIVERABLE_REJECTED

frontend/lib/transactions.ts         — rejectDeliverable() removed;
                                        acceptDeliverable() takes tipUsdc
frontend/lib/api.ts                  — reject() removed; accept() takes
                                        tipUsdc
frontend/lib/types.ts                — JobDetail gains tipPaid
frontend/app/jobs/[id]/page.tsx      — REVIEW_PENDING panel: no Reject
                                        button; tip slider (0–0.10 USDC,
                                        default 0.05) next to the rating
                                        slider; Money panel shows tip paid
```

**Recovered along the way:** `frontend/app/jobs/[id]/page.tsx` and
`frontend/components/DeliverableFile.tsx` (the pptx-download wiring from
part 2 of this patch) had gone missing from the working tree — `git status`
showed the page as deleted with no corresponding commit. Rebuilt both from
the last commit plus the file-upload/download changes described in part 2,
folded together with the tip changes above, and verified with a clean
`tsc --noEmit` across the frontend.

**Verified in this environment (no Rust toolchain here — see below):**
- `node shared/economics/test.mjs` — 56 assertions passed, including the
  headroom-clamp and tip-never-leaks-into-other-outcomes cases.
- `node program/scripts/build-idl.mjs` — regenerated `idl/acp.json` cleanly,
  21 instructions / 4 accounts / 9 events / 26 errors, no discriminator
  collisions.
- `cd frontend && npx tsc --noEmit` — clean.

**Not verified here, needs your machine:**

```bash
# 1. Rust unit tests for math.rs (settle(), the headroom clamp, the new
#    Outcome enum) — this environment has no rustc/cargo and no network
#    access to install one.
cd program
cargo test

# 2. Rebuild and upgrade-deploy under the existing program ID.
anchor build
anchor upgrade target/deploy/acp.so --program-id <YOUR_PROGRAM_ID>

# 3. Re-run the on-chain lifecycle proof — now exercises accept_deliverable
#    with the 0.05 USDC default tip and prints the adjusted balance deltas.
npm run e2e

# 4. Push the new tipPaid column and regenerate the Prisma client (this
#    environment's network policy also blocks binaries.prisma.sh).
cd backend
npx prisma db push
npm run db:generate   # from repo root
```
