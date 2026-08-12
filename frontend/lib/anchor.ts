"use client";

import { useMemo } from "react";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";

import { getProgramId, isChainConfigured } from "./constants";
import idl from "./idl.json";

/**
 * `idl.json` is NOT checked in as a placeholder — copy your real deployed
 * IDL over it: `cp program/idl/acp.json frontend/lib/idl.json` (see
 * PATCHES-5.md). It has to be the one generated with your real program ID
 * (`node scripts/build-idl.mjs --address <id>`, per DEPLOY.md step 4) or
 * every account/instruction here resolves against the wrong address.
 */

export interface AcpCtx {
  program: Program;
  provider: AnchorProvider;
  publicKey: import("@solana/web3.js").PublicKey;
}

/**
 * Returns null (not a throw) when no wallet is connected or on-chain config
 * is missing, so a component can render a "connect your wallet" state
 * instead of crashing. `useAnchorWallet()`, not `useWallet()` — Anchor's
 * Program needs the signer-shaped wallet object, and this one already
 * updates automatically when the connected wallet changes.
 */
export function useAcpProgram(): AcpCtx | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet || !isChainConfigured) return null;

    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });

    // Same Anchor 0.29→0.30 Program-constructor ambiguity handled the same
    // way in the e2e script — try the modern 2-arg form, fall back to 3-arg.
    // The `as any` on the fallback is a version-compat shim, not a type hole
    // in this file: which overload exists depends on the installed
    // @coral-xyz/anchor minor version, so TS can't check both branches at
    // once — the e2e script's identical runtime fallback is what's proven,
    // not this file's static types.
    let program: Program;
    try {
      program = new Program(idl as Idl, provider);
    } catch {
      program = new (Program as any)(idl as Idl, getProgramId(), provider);
    }

    return { program, provider, publicKey: wallet.publicKey };
  }, [connection, wallet]);
}