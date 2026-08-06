import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { env } from "../env.js";

/**
 * The platform is the only thing that calls an agent. This module is that
 * call.
 *
 * Two properties matter and neither is optional:
 *
 * 1. **Authentication both ways.** The platform HMACs the raw request body
 *    with the agent's shared secret; the agent HMACs its callbacks the same
 *    way. Without this an agent cannot tell a real job from anyone who
 *    guessed its endpoint, and the platform cannot tell a real deliverable
 *    from a forged one.
 *
 * 2. **SSRF containment.** `endpoint` is operator-controlled and the platform
 *    makes outbound HTTP to it from inside its own network. An agent
 *    registered at `http://169.254.169.254/latest/meta-data/` would otherwise
 *    turn this service into a cloud-credential exfiltration proxy. Resolution
 *    is checked before the request and redirects are refused, because a
 *    public hostname can 302 to a private one.
 */

export interface DispatchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  error?: string;
  durationMs: number;
}

export function newSharedSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time, and tolerant of a missing or malformed header. */
export function verifySignature(secret: string, body: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(sign(secret, body), "utf8");
  const actual = Buffer.from(header, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local: cloud metadata lives here
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

function isPrivateAddress(addr: string): boolean {
  if (isIP(addr) === 6) {
    const a = addr.toLowerCase();
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80");
  }
  return PRIVATE_V4.some((re) => re.test(addr));
}

export class EndpointError extends Error {
  readonly statusCode = 400;
}

/**
 * Validate at registration time so a bad endpoint is a form error rather than
 * a job that silently never dispatches.
 */
export async function assertEndpointAllowed(endpoint: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointError("Endpoint must be an absolute URL");
  }

  if (url.protocol !== "https:" && !(url.protocol === "http:" && env.ALLOW_PRIVATE_AGENT_ENDPOINTS)) {
    throw new EndpointError("Endpoint must use https");
  }
  if (url.username || url.password) {
    throw new EndpointError("Endpoint must not embed credentials");
  }

  if (env.ALLOW_PRIVATE_AGENT_ENDPOINTS) return url;

  const host = url.hostname;
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new EndpointError(`Could not resolve ${host}`);
      });

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new EndpointError(
        "Endpoint resolves to a private or link-local address. Use a publicly reachable URL."
      );
    }
  }
  return url;
}

async function call<T>(
  endpoint: string,
  path: string,
  secret: string,
  payload: unknown,
  method: "GET" | "POST" = "POST"
): Promise<DispatchResult<T>> {
  const started = Date.now();
  const url = new URL(path.replace(/^\//, ""), endpoint.endsWith("/") ? endpoint : `${endpoint}/`);

  try {
    await assertEndpointAllowed(url.toString());
  } catch (e) {
    return { ok: false, status: 0, body: null, error: (e as Error).message, durationMs: 0 };
  }

  const body = method === "POST" ? JSON.stringify(payload ?? {}) : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AGENT_DISPATCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      // A public hostname can 302 to 169.254.169.254; following redirects
      // would undo the check above.
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "acp-platform/0.4",
        ...(body ? { "x-acp-signature": sign(secret, body) } : {}),
      },
      ...(body ? { body } : {}),
    });

    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        status: res.status,
        body: null,
        error: "Endpoint redirected; redirects are not followed",
        durationMs: Date.now() - started,
      };
    }

    const text = await res.text();
    let parsed: T | null = null;
    try {
      parsed = text ? (JSON.parse(text) as T) : null;
    } catch {
      return {
        ok: false,
        status: res.status,
        body: null,
        error: "Endpoint did not return JSON",
        durationMs: Date.now() - started,
      };
    }

    return {
      ok: res.ok,
      status: res.status,
      body: parsed,
      ...(res.ok ? {} : { error: `Endpoint returned ${res.status}` }),
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      status: 0,
      body: null,
      error: err.name === "AbortError" ? "Endpoint timed out" : err.message,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- the endpoint contract, ARCHITECTURE.md §3.1 ---------------------------

export interface HealthResponse {
  ok: boolean;
  version?: string;
}

export interface PlanResponse {
  outline: string;
  planningFeeUsdc: number;
  fixedFeeUsdc: number;
  estTokenUsdcLow?: number;
  estTokenUsdcHigh?: number;
}

export interface ExecuteResponse {
  deliverable?: string;
  accepted?: boolean;
}

export const dispatch = {
  health: (endpoint: string, secret: string) =>
    call<HealthResponse>(endpoint, "health", secret, null, "GET"),

  plan: (endpoint: string, secret: string, payload: unknown) =>
    call<PlanResponse>(endpoint, "plan", secret, payload),

  execute: (endpoint: string, secret: string, payload: unknown) =>
    call<ExecuteResponse>(endpoint, "execute", secret, payload),

  cancel: (endpoint: string, secret: string, payload: unknown) =>
    call<{ ok: boolean }>(endpoint, "cancel", secret, payload),
};
