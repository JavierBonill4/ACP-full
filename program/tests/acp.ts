// Integration tests against a local validator.
//
//     anchor build --no-idl
//     anchor test --skip-build
//
// Note the import style: namespace import from @coral-xyz/anchor and BN
// straight from bn.js. Node's native TypeScript type-stripping intercepts .ts
// imports through its own ESM loader and bypasses ts-mocha's CommonJS
// transform, which breaks named-export interop with @coral-xyz/anchor (a
// CommonJS package). `import { Program, BN } from "@coral-xyz/anchor"` fails
// at runtime under Node 22+; this form does not.
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { assert } from "chai";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { createHash } from "crypto";

const { Program, AnchorProvider, web3 } = anchor;
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
const sha = (s: string) => Array.from(createHash("sha256").update(s).digest());

const TIER_RECONCILED = 1;
const TIER_METERED = 2;
const JOB_TYPE_OPEN = 0;
const JOB_TYPE_DIRECT = 1;

const STATE = {
  OPEN: 0, OFFERED: 1, CLAIMED: 2, PLAN_PENDING: 3, IN_PROGRESS: 4,
  REVIEW_PENDING: 5, SETTLED: 6, EXPIRED: 7, CANCELLED: 8,
};

describe("acp v4", () => {
  const provider = AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Acp;
  const conn = provider.connection;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const employer = Keypair.generate();
  const agent = Keypair.generate();
  const treasury = Keypair.generate();

  let mint: PublicKey;
  let employerAta: PublicKey;
  let agentAta: PublicKey;
  let treasuryAta: PublicKey;

  let oracleConfig: PublicKey;
  let employerProfile: PublicKey;
  let walletProfile: PublicKey;

  let nonce = 0;

  const jobPda = (n: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("job"), employer.publicKey.toBuffer(), new BN(n).toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const vaultPda = (job: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("vault"), job.toBuffer()], program.programId)[0];
  const bondPda = (job: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("bond"), job.toBuffer()], program.programId)[0];

  before(async () => {
    for (const kp of [employer, agent, treasury]) {
      const sig = await conn.requestAirdrop(kp.publicKey, 5 * web3.LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig);
    }

    // Never hardcode a devnet USDC mint — devnet mints rotate and a stale
    // constant fails silently at token-account init. Tests make their own.
    mint = await createMint(conn, admin, admin.publicKey, null, 6);
    employerAta = await createAssociatedTokenAccount(conn, employer, mint, employer.publicKey);
    agentAta = await createAssociatedTokenAccount(conn, agent, mint, agent.publicKey);
    treasuryAta = await createAssociatedTokenAccount(conn, treasury, mint, treasury.publicKey);
    await mintTo(conn, admin, mint, employerAta, admin, 100_000_000_000);
    await mintTo(conn, admin, mint, agentAta, admin, 100_000_000_000);

    [oracleConfig] = PublicKey.findProgramAddressSync([Buffer.from("oracle")], program.programId);
    [employerProfile] = PublicKey.findProgramAddressSync(
      [Buffer.from("employer"), employer.publicKey.toBuffer()], program.programId);
    [walletProfile] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), agent.publicKey.toBuffer()], program.programId);
  });

  const finalizeAccounts = (job: PublicKey, actor: PublicKey) => ({
    actor,
    oracleConfig,
    job,
    vault: vaultPda(job),
    bondVault: bondPda(job),
    employerProfile,
    walletProfile,
    employerToken: employerAta,
    agentToken: agentAta,
    treasuryToken: treasuryAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  async function postJob(opts: {
    type: number;
    agent?: PublicKey;
    pfc?: BN; ffc?: BN; ptc?: BN; tbc?: BN;
    minTier?: number;
    deadlineSecs?: number;
  }) {
    const n = nonce++;
    const job = jobPda(n);
    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .postJob({
        nonce: new BN(n),
        jobType: opts.type,
        agent: opts.agent ?? null,
        specHash: sha(`spec-${n}`),
        planningFeeCap: opts.pfc ?? USDC(2),
        fixedFeeCap: opts.ffc ?? USDC(20),
        planningTokenCap: opts.ptc ?? USDC(3),
        tokenBudgetCap: opts.tbc ?? USDC(50),
        minTier: opts.minTier ?? TIER_RECONCILED,
        deadline: new BN(now + (opts.deadlineSecs ?? 86_400)),
      })
      .accounts({
        employer: employer.publicKey,
        oracleConfig,
        employerProfile,
        job,
        vault: vaultPda(job),
        employerToken: employerAta,
        usdcMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([employer])
      .rpc();
    return job;
  }

  // -------------------------------------------------------------------------

  it("initializes the oracle with T2 as the ceiling", async () => {
    await program.methods
      .initializeOracle(100, TIER_METERED, 1)
      .accounts({
        admin: admin.publicKey,
        oracleConfig,
        usdcMint: mint,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.oracleConfig.fetch(oracleConfig);
    assert.equal(cfg.protocolFeeBps, 100);
    assert.equal(cfg.maxEnabledTier, TIER_METERED);
    assert.isFalse(cfg.paused);
  });

  it("registers profiles idempotently", async () => {
    await program.methods.registerEmployer()
      .accounts({ employer: employer.publicKey, employerProfile, systemProgram: SystemProgram.programId })
      .signers([employer]).rpc();
    // Calling twice must be a no-op, not a failure — the frontend calls this
    // unconditionally before every first post.
    await program.methods.registerEmployer()
      .accounts({ employer: employer.publicKey, employerProfile, systemProgram: SystemProgram.programId })
      .signers([employer]).rpc();

    await program.methods.registerWallet(TIER_METERED)
      .accounts({ wallet: agent.publicKey, walletProfile, oracleConfig, systemProgram: SystemProgram.programId })
      .signers([agent]).rpc();

    const wp = await program.account.walletProfile.fetch(walletProfile);
    assert.equal(wp.wrs.toNumber(), 0, "reputation starts at zero");
    assert.equal(wp.jobsCompleted.toNumber(), 0);
    assert.equal(wp.tier, TIER_METERED);
    assert.isAbove(wp.firstSeen.toNumber(), 0);
  });

  it("rejects a tier the deployment has not enabled", async () => {
    const bad = Keypair.generate();
    const sig = await conn.requestAirdrop(bad.publicKey, web3.LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig);
    const [bp] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), bad.publicKey.toBuffer()], program.programId);
    try {
      await program.methods.registerWallet(3)
        .accounts({ wallet: bad.publicKey, walletProfile: bp, oracleConfig, systemProgram: SystemProgram.programId })
        .signers([bad]).rpc();
      assert.fail("should have rejected tier 3");
    } catch (e: any) {
      assert.include(e.toString(), "TierNotEnabled");
    }
  });

  // -------------------------------------------------------------------------

  it("funds escrow at the top of the range on post", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    const vault = await getAccount(conn, vaultPda(job));
    // 2 + 20 + 3 + 50
    assert.equal(vault.amount.toString(), "75000000");

    const j = await program.account.job.fetch(job);
    assert.equal(j.state, STATE.OPEN);
    assert.equal(j.bond.toNumber(), 0, "no bond until claimed");
  });

  it("takes a bond on an open claim and returns it on acceptance", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    const before = (await getAccount(conn, agentAta)).amount;

    await program.methods.claimJob()
      .accounts({
        agent: agent.publicKey, oracleConfig, job, walletProfile,
        bondVault: bondPda(job), agentToken: agentAta, usdcMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([agent]).rpc();

    const j = await program.account.job.fetch(job);
    // max(5, 0.25 x 20) = 5
    assert.equal(j.bond.toNumber(), 5_000_000);
    assert.equal(j.claimedTier, TIER_METERED, "tier is pinned at claim time");
    const bond = await getAccount(conn, bondPda(job));
    assert.equal(bond.amount.toString(), "5000000");
    assert.isBelow(Number((await getAccount(conn, agentAta)).amount), Number(before));
  });

  it("runs the happy path and pays 1% of margin only", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    await program.methods.claimJob().accounts({
      agent: agent.publicKey, oracleConfig, job, walletProfile,
      bondVault: bondPda(job), agentToken: agentAta, usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).signers([agent]).rpc();

    await program.methods.submitPlan(sha("plan"), USDC(2), USDC(20))
      .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();

    await program.methods.reportUsage(0, USDC(1.5))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();

    await program.methods.acceptPlan()
      .accounts({ employer: employer.publicKey, job }).signers([employer]).rpc();

    await program.methods.reportUsage(1, USDC(30))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();

    await program.methods.submitDeliverable(sha("deliverable"), sha("usage-root"))
      .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();

    const treasuryBefore = (await getAccount(conn, treasuryAta)).amount;
    await program.methods.acceptDeliverable(9, new BN(0))
      .accounts(finalizeAccounts(job, employer.publicKey)).signers([employer]).rpc();

    const treasuryAfter = (await getAccount(conn, treasuryAta)).amount;
    // 1% of (2 + 20), not of (22 + 31.5)
    assert.equal((treasuryAfter - treasuryBefore).toString(), "220000");

    const j = await program.account.job.fetch(job);
    assert.equal(j.state, STATE.SETTLED);
    assert.equal(j.rating, 9);
    assert.equal(j.holdbackAmount.toNumber(), 0, "T2 settles tokens immediately");

    const vault = await getAccount(conn, vaultPda(job));
    assert.equal(vault.amount.toString(), "0", "vault fully drained");

    const wp = await program.account.walletProfile.fetch(walletProfile);
    assert.isAbove(wp.jobsCompleted.toNumber(), 0);
    assert.isAbove(wp.wrs.toNumber(), 0, "a 9/10 raises reputation above neutral");
  });

  it("refuses a proposal above the funded fee ceiling", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    await program.methods.claimJob().accounts({
      agent: agent.publicKey, oracleConfig, job, walletProfile,
      bondVault: bondPda(job), agentToken: agentAta, usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).signers([agent]).rpc();

    try {
      await program.methods.submitPlan(sha("greedy"), USDC(2), USDC(500))
        .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();
      assert.fail("should have rejected a fee above the ceiling");
    } catch (e: any) {
      assert.include(e.toString(), "FeeCapExceeded");
    }
  });

  it("refuses oracle usage above the phase cap", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    try {
      await program.methods.reportUsage(1, USDC(9999))
        .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
      assert.fail("should have clamped");
    } catch (e: any) {
      assert.include(e.toString(), "UsageCapExceeded");
    }
  });

  it("refuses usage from an address that is not a whitelisted signer", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    try {
      await program.methods.reportUsage(1, USDC(1))
        .accounts({ oracleSigner: employer.publicKey, oracleConfig, job })
        .signers([employer]).rpc();
      assert.fail("should have rejected a non-signer");
    } catch (e: any) {
      assert.include(e.toString(), "NotOracleSigner");
    }
  });

  it("has no reject_deliverable — a submitted deliverable's payout is unconditional", async () => {
    // There is no reject_deliverable instruction left on the program at
    // all; calling it must fail at the client layer before ever reaching
    // the validator, since the IDL no longer declares it.
    assert.isUndefined(
      (program.methods as any).rejectDeliverable,
      "reject_deliverable must not exist on the program"
    );
  });

  it("pays the agent in full plus a tip, drawn from the employer's own refund", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    await program.methods.claimJob().accounts({
      agent: agent.publicKey, oracleConfig, job, walletProfile,
      bondVault: bondPda(job), agentToken: agentAta, usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).signers([agent]).rpc();
    await program.methods.submitPlan(sha("plan"), USDC(2), USDC(20))
      .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();
    await program.methods.reportUsage(0, USDC(3))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
    await program.methods.acceptPlan()
      .accounts({ employer: employer.publicKey, job }).signers([employer]).rpc();
    await program.methods.reportUsage(1, USDC(48))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
    await program.methods.submitDeliverable(sha("d"), sha("u"))
      .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();

    const before = (await getAccount(conn, agentAta)).amount;
    const tip = USDC(0.05); // the UI's DEFAULT_TIP
    await program.methods.acceptDeliverable(9, tip)
      .accounts(finalizeAccounts(job, employer.publicKey)).signers([employer]).rpc();
    const after = (await getAccount(conn, agentAta)).amount;

    // planning fee (2) + fixed fee (20), less 1% of that 22 margin, + all 51
    // tokens + the 0.05 tip + bond returned (5)
    const expected = (22_000_000 - 220_000) + 51_000_000 + 50_000 + 5_000_000;
    assert.equal((after - before).toString(), expected.toString());

    const j = await program.account.job.fetch(job);
    assert.equal(j.state, STATE.SETTLED);
  });

  it("clamps the tip to whatever headroom is left once fees and tokens exhaust escrow", async () => {
    // A job sized so planning+fixed fee and full token usage leave almost
    // nothing over — MAX_TIP (0.10) requested against ~0 headroom must not
    // push the agent's payout past what escrow actually holds.
    const job = await postJob({ type: JOB_TYPE_OPEN, pfc: USDC(1), ffc: USDC(1), ptc: USDC(1), tbc: USDC(1) });
    await program.methods.claimJob().accounts({
      agent: agent.publicKey, oracleConfig, job, walletProfile,
      bondVault: bondPda(job), agentToken: agentAta, usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).signers([agent]).rpc();
    await program.methods.submitPlan(sha("plan"), USDC(1), USDC(1))
      .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();
    await program.methods.reportUsage(0, USDC(1))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
    await program.methods.acceptPlan()
      .accounts({ employer: employer.publicKey, job }).signers([employer]).rpc();
    await program.methods.reportUsage(1, USDC(1))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
    await program.methods.submitDeliverable(sha("d"), sha("u"))
      .accounts({ agent: agent.publicKey, job }).signers([agent]).rpc();

    await program.methods.acceptDeliverable(9, USDC(0.1)) // MAX_TIP requested
      .accounts(finalizeAccounts(job, employer.publicKey)).signers([employer]).rpc();

    const vault = await getAccount(conn, vaultPda(job));
    assert.equal(vault.amount.toString(), "0", "vault fully drained, never overdrawn");
  });

  it("holds back the token portion at T1 and never the fees", async () => {
    const t1 = Keypair.generate();
    const sig = await conn.requestAirdrop(t1.publicKey, 5 * web3.LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig);
    const t1Ata = await createAssociatedTokenAccount(conn, t1, mint, t1.publicKey);
    await mintTo(conn, admin, mint, t1Ata, admin, 50_000_000_000);
    const [t1Profile] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), t1.publicKey.toBuffer()], program.programId);
    await program.methods.registerWallet(TIER_RECONCILED)
      .accounts({ wallet: t1.publicKey, walletProfile: t1Profile, oracleConfig, systemProgram: SystemProgram.programId })
      .signers([t1]).rpc();

    // T1's value cap is 100 USDC, so keep the job small.
    const job = await postJob({ type: JOB_TYPE_OPEN, pfc: USDC(1), ffc: USDC(10), ptc: USDC(2), tbc: USDC(40) });
    await program.methods.claimJob().accounts({
      agent: t1.publicKey, oracleConfig, job, walletProfile: t1Profile,
      bondVault: bondPda(job), agentToken: t1Ata, usdcMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).signers([t1]).rpc();
    await program.methods.submitPlan(sha("plan"), USDC(1), USDC(10))
      .accounts({ agent: t1.publicKey, job }).signers([t1]).rpc();
    await program.methods.reportUsage(0, USDC(2))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
    await program.methods.acceptPlan()
      .accounts({ employer: employer.publicKey, job }).signers([employer]).rpc();
    await program.methods.reportUsage(1, USDC(18))
      .accounts({ oracleSigner: admin.publicKey, oracleConfig, job }).rpc();
    await program.methods.submitDeliverable(sha("d"), sha("u"))
      .accounts({ agent: t1.publicKey, job }).signers([t1]).rpc();

    await program.methods.acceptDeliverable(8, new BN(0)).accounts({
      ...finalizeAccounts(job, employer.publicKey),
      walletProfile: t1Profile,
      agentToken: t1Ata,
    }).signers([employer]).rpc();

    const j = await program.account.job.fetch(job);
    assert.equal(j.holdbackAmount.toNumber(), 20_000_000, "20 USDC of tokens held");
    assert.isAbove(j.holdbackUntil.toNumber(), 0);
    const vault = await getAccount(conn, vaultPda(job));
    assert.equal(vault.amount.toString(), "20000000", "only the holdback remains");

    // The window has not closed, so release must fail.
    try {
      await program.methods.releaseHoldback().accounts({
        cranker: admin.publicKey, job, vault: vaultPda(job),
        agentToken: t1Ata, tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();
      assert.fail("should not release before the window closes");
    } catch (e: any) {
      assert.include(e.toString(), "HoldbackPending");
    }
  });

  it("caps a T1 job at 100 USDC", async () => {
    try {
      await postJob({ type: JOB_TYPE_OPEN, ffc: USDC(500), minTier: TIER_RECONCILED });
      assert.fail("should have rejected a job above the T1 cap");
    } catch (e: any) {
      assert.include(e.toString(), "ValueCapExceeded");
    }
  });

  it("offers a direct hire with no bond", async () => {
    const job = await postJob({ type: JOB_TYPE_DIRECT, agent: agent.publicKey });
    let j = await program.account.job.fetch(job);
    assert.equal(j.state, STATE.OFFERED);
    assert.isAbove(j.offerExpiresAt.toNumber(), 0);

    await program.methods.acceptOffer()
      .accounts({ agent: agent.publicKey, job, walletProfile }).signers([agent]).rpc();

    j = await program.account.job.fetch(job);
    assert.equal(j.state, STATE.CLAIMED);
    assert.equal(j.bond.toNumber(), 0, "the employer chose them, so no squatting to deter");
  });

  it("refuses a direct offer taken by the wrong wallet", async () => {
    const job = await postJob({ type: JOB_TYPE_DIRECT, agent: agent.publicKey });
    const other = Keypair.generate();
    const sig = await conn.requestAirdrop(other.publicKey, web3.LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig);
    const [op] = PublicKey.findProgramAddressSync(
      [Buffer.from("wallet"), other.publicKey.toBuffer()], program.programId);
    await program.methods.registerWallet(TIER_METERED)
      .accounts({ wallet: other.publicKey, walletProfile: op, oracleConfig, systemProgram: SystemProgram.programId })
      .signers([other]).rpc();
    try {
      await program.methods.acceptOffer()
        .accounts({ agent: other.publicKey, job, walletProfile: op }).signers([other]).rpc();
      assert.fail("should have rejected the wrong agent");
    } catch (e: any) {
      assert.include(e.toString(), "WrongAgent");
    }
  });

  it("refunds the employer in full when an unclaimed job is cancelled", async () => {
    const job = await postJob({ type: JOB_TYPE_OPEN });
    const before = (await getAccount(conn, employerAta)).amount;
    await program.methods.cancelJob()
      .accounts(finalizeAccounts(job, employer.publicKey)).signers([employer]).rpc();
    const after = (await getAccount(conn, employerAta)).amount;
    assert.equal((after - before).toString(), "75000000");
  });

  it("keeps the lifetime counters monotonic across every outcome", async () => {
    const wp = await program.account.walletProfile.fetch(walletProfile);
    const lifetime =
      wp.jobsCompleted.toNumber() + wp.jobsRejected.toNumber() + wp.jobsExpired.toNumber();
    assert.isAbove(lifetime, 0);
    // The score floors at zero; the record must not. A wallet with a bad run
    // has to stay distinguishable from a fresh one.
    assert.isAbove(wp.firstSeen.toNumber(), 0);
    assert.isAtLeast(wp.wrs.toNumber(), 0);
  });
});
