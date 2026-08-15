// Economic invariant tests. Needs nothing but node — run this first, before
// touching the Solana toolchain:
//
//     npm run test:economics
//
// These mirror the #[cfg(test)] units in programs/acp/src/math.rs. If the two
// ever disagree, the Rust is authoritative and the mirror is the bug.

import {
  OUTCOME,
  JOB_TYPE,
  ONE_USDC,
  WRS_SCALE,
  DEFAULT_PROTOCOL_FEE_BPS,
  MIN_BOND,
  MAX_TIP,
  DEFAULT_TIP,
  TIER_RECONCILED,
  TIER_METERED,
  TIER1_VALUE_CAP,
  TIER2_VALUE_CAP,
  settle,
  settlementTotal,
  requiredBond,
  valueWeight,
  applyWrs,
  applyClawbackPenalty,
  rejectionRateBps,
  tierValueCap,
  formatUsdc,
  formatWrs,
} from "./settlement.mjs";

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
  }
}

function eq(actual, expected, label) {
  const good = actual === expected;
  if (!good) failures.push(`${label}\n    expected ${expected}\n    actual   ${actual}`);
  good ? passed++ : failed++;
}

const usdc = (n) => BigInt(Math.round(n * 1_000_000));

function job({
  pfc = usdc(2),
  ffc = usdc(20),
  ptc = usdc(3),
  tbc = usdc(50),
  pf = usdc(2),
  ff = usdc(20),
  pt = 0n,
  et = 0n,
  tier = TIER_METERED,
  outcome = OUTCOME.ACCEPTED,
  bps = DEFAULT_PROTOCOL_FEE_BPS,
  tip = 0n,
} = {}) {
  const total = pfc + ffc + ptc + tbc;
  return {
    total,
    result: settle({
      outcome,
      tier,
      escrowTotal: total,
      planningFee: pf,
      fixedFee: ff,
      planningTokenCap: ptc,
      tokenBudgetCap: tbc,
      planningTokensUsed: pt,
      executionTokensUsed: et,
      protocolFeeBps: bps,
      tip,
    }),
  };
}

// ---------------------------------------------------------------------------
console.log("\n--- settlement matrix ---");

{
  const { total, result: s } = job({ pt: usdc(1.5), et: usdc(30) });
  eq(s.protocolFee, usdc(0.22), "accepted: fee is 1% of 22 USDC margin");
  eq(s.agentImmediate, usdc(22) - usdc(0.22) + usdc(31.5), "accepted: agent gets tokens + fees - fee");
  eq(s.agentHoldback, 0n, "accepted at T2: nothing held back");
  eq(s.employerRefund, usdc(1.5) + usdc(20), "accepted: unused budget returns");
  eq(settlementTotal(s), total, "accepted: conservation");
}

{
  const { result: s } = job({ pfc: 0n, ffc: usdc(10), ptc: 0n, tbc: usdc(900), pf: 0n, ff: usdc(10), et: usdc(900) });
  eq(s.protocolFee, usdc(0.1), "fee base excludes token reimbursement entirely");
}

{
  const { total, result: s } = job({ outcome: OUTCOME.PLAN_REJECTED, pt: usdc(2.5) });
  eq(s.protocolFee, usdc(0.02), "plan rejected: fee only on planning fee");
  eq(s.agentImmediate, usdc(2) - usdc(0.02) + usdc(2.5), "plan rejected: agent whole on planning cost");
  eq(settlementTotal(s), total, "plan rejected: conservation");
}

{
  // There is no DELIVERABLE_REJECTED row anymore — a submitted deliverable's
  // fee + token payout is unconditional. Instead, accepted-with-a-tip: the
  // tip comes out of the employer's refund, on top of the agent's already-
  // unconditional fee + token payout.
  const { total, result: without } = job({ pt: usdc(1.5), et: usdc(30) });
  const { result: withTip } = job({ pt: usdc(1.5), et: usdc(30), tip: MAX_TIP });
  eq(withTip.agentImmediate, without.agentImmediate + MAX_TIP, "tip adds to the agent's payout");
  eq(withTip.employerRefund, without.employerRefund - MAX_TIP, "tip comes out of the employer's refund");
  eq(withTip.protocolFee, without.protocolFee, "tip is the employer's own money — no protocol cut");
  eq(withTip.tipPaid, MAX_TIP, "tipPaid reports the full requested tip when headroom allows it");
  eq(settlementTotal(withTip), total, "accepted with tip: conservation");
}

{
  // Tip is ignored on every outcome but ACCEPTED, even if a caller bug
  // passes a nonzero value in.
  for (const outcome of [OUTCOME.PLAN_REJECTED, OUTCOME.EXPIRED]) {
    const { result: without } = job({ outcome, pt: usdc(2.5), tip: 0n });
    const { result: withTipArg } = job({ outcome, pt: usdc(2.5), tip: MAX_TIP });
    eq(JSON.stringify(withTipArg, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      JSON.stringify(without, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      `tip must not leak into outcome ${outcome}`);
  }
}

{
  // No headroom left once fees + full token reimbursement exhaust escrow —
  // the clamped tip must be 0, not the raw request, and conservation must
  // still hold rather than overpay the agent.
  const { total, result: s } = job({ pt: usdc(3), et: usdc(50), tip: MAX_TIP });
  eq(s.tipPaid, 0n, "no headroom left, so the clamped tip is 0");
  eq(settlementTotal(s), total, "fully-saturated job with a tip request still conserves");
}

{
  const { total, result: s } = job({ outcome: OUTCOME.EXPIRED, pt: usdc(3), et: usdc(50) });
  eq(s.agentImmediate, 0n, "expired: agent gets nothing");
  eq(s.agentHoldback, 0n, "expired: no holdback");
  eq(s.protocolFee, 0n, "expired: no protocol fee");
  eq(s.employerRefund, total, "expired: employer gets everything");
}

{
  const { total, result: s } = job({
    tier: TIER_RECONCILED,
    pfc: usdc(1), ffc: usdc(10), ptc: usdc(2), tbc: usdc(40),
    pf: usdc(1), ff: usdc(10),
    pt: usdc(2), et: usdc(18),
  });
  eq(s.agentImmediate, usdc(11) - usdc(0.11), "T1: fees settle immediately");
  eq(s.agentHoldback, usdc(20), "T1: token portion held back");
  eq(settlementTotal(s), total, "T1: conservation");
}

{
  // A tip is a same-transaction employer decision, not something requiring
  // reconciliation like token usage — it must never be held back, even T1.
  const { total, result: s } = job({
    tier: TIER_RECONCILED,
    pfc: usdc(1), ffc: usdc(10), ptc: usdc(2), tbc: usdc(40),
    pf: usdc(1), ff: usdc(10),
    pt: usdc(2), et: usdc(18),
    tip: MAX_TIP,
  });
  eq(s.agentImmediate, usdc(11) - usdc(0.11) + MAX_TIP, "T1: tip settles immediately alongside fees");
  eq(s.agentHoldback, usdc(20), "T1: only the token portion is held back, never the tip");
  eq(settlementTotal(s), total, "T1 with tip: conservation");
}

// ---------------------------------------------------------------------------
console.log("--- oracle cannot exceed what was funded ---");

{
  const total = usdc(21);
  const s = settle({
    outcome: OUTCOME.ACCEPTED,
    tier: TIER_METERED,
    escrowTotal: total,
    planningFee: 0n,
    fixedFee: usdc(10),
    planningTokenCap: usdc(1),
    tokenBudgetCap: usdc(10),
    planningTokensUsed: 2n ** 63n,
    executionTokensUsed: 2n ** 63n,
    protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,
  });
  eq(settlementTotal(s), total, "lying oracle: conservation still holds");
  ok(s.agentImmediate <= total, "lying oracle: agent cannot be paid more than escrow");
}

// ---------------------------------------------------------------------------
console.log("--- bonds ---");

eq(requiredBond(JOB_TYPE.DIRECT, usdc(1000)), 0n, "direct hire posts no bond");
eq(requiredBond(JOB_TYPE.OPEN, 0n), MIN_BOND, "open job floors at 5 USDC");
eq(requiredBond(JOB_TYPE.OPEN, usdc(4)), MIN_BOND, "small fee still floors at 5 USDC");
eq(requiredBond(JOB_TYPE.OPEN, usdc(100)), usdc(25), "bond scales at 25% of the fee ceiling");

// ---------------------------------------------------------------------------
console.log("--- tier caps ---");

eq(tierValueCap(TIER_RECONCILED), TIER1_VALUE_CAP, "T1 cap is 100 USDC");
eq(tierValueCap(TIER_METERED), TIER2_VALUE_CAP, "T2 cap is 2500 USDC");
ok(TIER1_VALUE_CAP < TIER2_VALUE_CAP, "T1 is capped tighter than T2");

// ---------------------------------------------------------------------------
console.log("--- reputation ---");

eq(valueWeight(0n), 1n, "value weight floors at 1");
eq(valueWeight(ONE_USDC), 2n, "1 USDC job weighs 2");
eq(valueWeight(100n * ONE_USDC), 7n, "100 USDC job weighs 7");
eq(valueWeight(1_000_000n * ONE_USDC), 8n, "value weight clamps at 8");

{
  let wrs = 0n;
  for (let i = 0; i < 11; i++) {
    wrs = applyWrs(wrs, OUTCOME.PLAN_REJECTED, 0, usdc(50));
  }
  eq(wrs, 0n, "WRS floors at zero after 11 rejections");
}

{
  const start = 10n * WRS_SCALE;
  eq(applyWrs(start, OUTCOME.ACCEPTED, 5, usdc(50)), (start * 31n) / 32n,
    "a neutral rating moves the score only by recency decay");
}

{
  const start = 10n * WRS_SCALE;
  ok(applyWrs(start, OUTCOME.ACCEPTED, 10, usdc(50)) > start, "a 10/10 raises the score");
  ok(applyWrs(start, OUTCOME.ACCEPTED, 0, usdc(50)) < start, "a 0/10 lowers the score");
  ok(applyWrs(start, OUTCOME.EXPIRED, 0, usdc(50)) < applyWrs(start, OUTCOME.PLAN_REJECTED, 0, usdc(50)),
    "expiry costs more than rejection");
}

{
  // A whale job must not be worth more than several ordinary ones.
  const whale = applyWrs(0n, OUTCOME.ACCEPTED, 10, usdc(2500));
  let steady = 0n;
  for (let i = 0; i < 3; i++) steady = applyWrs(steady, OUTCOME.ACCEPTED, 10, usdc(20));
  ok(whale < steady * 3n, "log damping stops a single whale job from capturing the score");
}

{
  const start = 20n * WRS_SCALE;
  ok(applyClawbackPenalty(start, usdc(100)) < applyWrs(start, OUTCOME.EXPIRED, 0, usdc(100)),
    "a confirmed clawback costs more than a missed deadline");
}

eq(rejectionRateBps(0n, 0n), 0n, "no jobs means no rejection rate");
eq(rejectionRateBps(3n, 12n), 2500n, "3 of 12 rejected is 25%");

// ---------------------------------------------------------------------------
console.log("--- randomized conservation (5000 cases) ---");

let mulberry = 0x9e3779b9;
function rnd() {
  mulberry |= 0;
  mulberry = (mulberry + 0x6d2b79f5) | 0;
  let t = Math.imul(mulberry ^ (mulberry >>> 15), 1 | mulberry);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

let conservationFailures = 0;
let overpayFailures = 0;
let feeOnGrossFailures = 0;

for (let i = 0; i < 5000; i++) {
  const pfc = usdc(rnd() * 10);
  const ffc = usdc(rnd() * 200);
  const ptc = usdc(rnd() * 20);
  const tbc = usdc(rnd() * 1000);
  const total = pfc + ffc + ptc + tbc;

  // Proposal must fit inside the funded ceilings — the program enforces this.
  const pf = (pfc * BigInt(Math.floor(rnd() * 101))) / 100n;
  const ff = (ffc * BigInt(Math.floor(rnd() * 101))) / 100n;

  // Oracle reports are clamped at write time, but throw over-cap values in
  // anyway to prove settlement clamps independently.
  const pt = (ptc * BigInt(Math.floor(rnd() * 140))) / 100n;
  const et = (tbc * BigInt(Math.floor(rnd() * 140))) / 100n;

  const outcome = pick([
    OUTCOME.ACCEPTED,
    OUTCOME.PLAN_REJECTED,
    OUTCOME.EXPIRED,
  ]);
  const tier = pick([TIER_RECONCILED, TIER_METERED]);
  // Occasionally request more tip than could possibly fit, to exercise the
  // headroom clamp under random saturation, not just at the caps.
  const tip = pick([0n, DEFAULT_TIP, MAX_TIP, MAX_TIP * 3n]);

  const s = settle({
    outcome,
    tier,
    escrowTotal: total,
    planningFee: pf,
    fixedFee: ff,
    planningTokenCap: ptc,
    tokenBudgetCap: tbc,
    planningTokensUsed: pt,
    executionTokensUsed: et,
    protocolFeeBps: DEFAULT_PROTOCOL_FEE_BPS,
    tip,
  });

  if (settlementTotal(s) !== total) conservationFailures++;
  if (s.agentImmediate + s.agentHoldback > total) overpayFailures++;
  // Fee must never exceed 1% of the fee ceilings — i.e. never touch tokens.
  if (s.protocolFee > (pfc + ffc) / 100n) feeOnGrossFailures++;
}

eq(conservationFailures, 0, "5000 random settlements all conserve value");
eq(overpayFailures, 0, "5000 random settlements never overpay the agent");
eq(feeOnGrossFailures, 0, "protocol fee never touches token reimbursement");

// ---------------------------------------------------------------------------
console.log("--- formatting ---");

eq(formatUsdc(12_345_678n), "12.345678", "usdc formatting");
eq(formatUsdc(5_000_000n), "5.0", "usdc formatting strips trailing zeros");
eq(formatWrs(3_400_000n), "3.4", "wrs formatting");

// ---------------------------------------------------------------------------

console.log("");
if (failed === 0) {
  console.log(`  ${passed} assertions passed`);
  process.exit(0);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED\n`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
