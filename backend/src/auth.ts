import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { SignJWT, jwtVerify } from "jose";
import nacl from "tweetnacl";
import type { FastifyReply, FastifyRequest } from "fastify";

import { env } from "./env.js";
import { prisma } from "./db.js";

const KEY = new TextEncoder().encode(env.JWT_SECRET);
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL = "7d";

export interface Session {
  address: string;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export function isValidAddress(address: string): boolean {
  try {
    // A base58 string of the right length is not enough — it also has to be a
    // point on the curve or a valid off-curve PDA, which the constructor
    // checks.
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Nothing is signed on the user's behalf here. The wallet proves control of
 * the address by signing a nonce, and that is all the session grants — every
 * transaction that moves money is still built server-side, returned
 * unsigned, and signed in the browser.
 */
export async function createChallenge(address: string) {
  const nonce = randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  const message = [
    "Sign in to Agentic Commerce Protocol",
    "",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    "",
    "This signature proves you control this wallet.",
    "It does not authorize any transaction, transfer, or approval.",
  ].join("\n");

  await prisma.wallet.upsert({
    where: { address },
    create: { address },
    update: {},
  });

  await prisma.authChallenge.create({
    data: { address, nonce, message, expiresAt },
  });

  return { nonce, message, expiresAt };
}

export async function verifyChallenge(nonce: string, signatureBase58: string) {
  const challenge = await prisma.authChallenge.findUnique({ where: { nonce } });
  if (!challenge) throw new AuthError("Unknown challenge");
  if (challenge.usedAt) throw new AuthError("Challenge already used");
  if (challenge.expiresAt < new Date()) throw new AuthError("Challenge expired");

  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(challenge.message),
    bs58.decode(signatureBase58),
    new PublicKey(challenge.address).toBytes()
  );
  if (!ok) throw new AuthError("Signature does not match the challenge");

  // Single use. Marking it consumed is what stops a captured signature from
  // being replayed inside the five-minute window.
  await prisma.authChallenge.update({
    where: { nonce },
    data: { usedAt: new Date() },
  });

  const token = await new SignJWT({ address: challenge.address })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setSubject(challenge.address)
    .setExpirationTime(SESSION_TTL)
    .sign(KEY);

  return { token, address: challenge.address };
}

export async function readSession(req: FastifyRequest): Promise<Session | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), KEY);
    if (typeof payload.sub !== "string") return null;
    return { address: payload.sub };
  } catch {
    return null;
  }
}

/** Fastify preHandler. Attaches the session or 401s. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const session = await readSession(req);
  if (!session) {
    return reply.code(401).send({ error: "Sign in with your wallet to do that" });
  }
  req.session = session;
}

/** Attaches a session when present but never rejects. */
export async function optionalAuth(req: FastifyRequest) {
  const session = await readSession(req);
  if (session) req.session = session;
}

export class AuthError extends Error {
  readonly statusCode = 401;
}

/** Expired and consumed challenges are dead weight; sweep them hourly. */
export async function pruneChallenges() {
  const cutoff = new Date(Date.now() - CHALLENGE_TTL_MS);
  await prisma.authChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } });
}
