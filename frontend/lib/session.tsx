"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, loadToken, setToken } from "./api";

interface SessionState {
  address: string | null;
  connected: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage, disconnect, connected } = useWallet();
  const [address, setAddress] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore an existing session on mount so a refresh does not force another
  // wallet prompt.
  useEffect(() => {
    if (!loadToken()) return;
    api
      .me()
      .then((me) => setAddress(me.address))
      .catch(() => setToken(null));
  }, []);

  /**
   * Proves control of the wallet and nothing else. The message text says so
   * explicitly — users are trained to approve whatever a dapp puts in front of
   * them, and a sign-in prompt that reads like a transaction prompt is exactly
   * how that habit gets exploited.
   */
  const signIn = useCallback(async () => {
    if (!publicKey || !signMessage) {
      setError("Connect a wallet that can sign messages");
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      const { nonce, message } = await api.challenge(publicKey.toBase58());
      const signature = await signMessage(new TextEncoder().encode(message));
      const { token, address: verified } = await api.verify(nonce, bs58.encode(signature));
      setToken(token);
      setAddress(verified);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in");
    } finally {
      setSigningIn(false);
    }
  }, [publicKey, signMessage]);

  const signOut = useCallback(() => {
    setToken(null);
    setAddress(null);
    void disconnect();
  }, [disconnect]);

  // A wallet switch invalidates the session — the token is bound to the old
  // address and every write would 403 in a way that looks like a bug.
  useEffect(() => {
    if (address && publicKey && publicKey.toBase58() !== address) {
      setToken(null);
      setAddress(null);
    }
  }, [publicKey, address]);

  const value = useMemo<SessionState>(
    () => ({ address, connected, signingIn, error, signIn, signOut }),
    [address, connected, signingIn, error, signIn, signOut]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
