import type {
  Agent,
  Category,
  CategoryGroup,
  JobDetail,
  JobSummary,
  Quote,
  WalletProfile,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4000/api/v1";

const TOKEN_KEY = "acp.session";

/**
 * In-memory session, mirrored into sessionStorage so a page refresh does not
 * force a re-signature. sessionStorage rather than localStorage: the token is
 * a bearer credential and should not outlive the tab.
 */
let token: string | null = null;

export function setToken(next: string | null) {
  token = next;
  if (typeof window === "undefined") return;
  if (next) window.sessionStorage.setItem(TOKEN_KEY, next);
  else window.sessionStorage.removeItem(TOKEN_KEY);
}

export function loadToken(): string | null {
  if (token) return token;
  if (typeof window === "undefined") return null;
  token = window.sessionStorage.getItem(TOKEN_KEY);
  return token;
}

/**
 * Errors carry the API's per-field messages when it sent them, so forms can
 * highlight the offending input instead of showing a banner that makes the
 * user guess which of nine fields is wrong.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields?: Record<string, string>
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };

  const t = loadToken();
  if (init.auth !== false && t) headers.authorization = `Bearer ${t}`;

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, body?.fields);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  // --- auth ---------------------------------------------------------------
  challenge: (address: string) =>
    post<{ nonce: string; message: string; expiresAt: string }>("/auth/challenge", { address }),
  verify: (nonce: string, signature: string) =>
    post<{ token: string; address: string }>("/auth/verify", { nonce, signature }),
  me: () => request<{ address: string; agentCount: number; jobCount: number }>("/auth/me"),

  // --- discovery ----------------------------------------------------------
  categories: (includeEmpty = false) =>
    request<Category[]>(`/categories?includeEmpty=${includeEmpty}`, { auth: false }),

  /** The general window's roster. */
  generalAgents: (sort = "reputation") =>
    request<Agent[]>(`/agents?kind=GENERAL&sort=${sort}`, { auth: false }),

  /**
   * The single-purpose window, already grouped by category server-side.
   *
   * Deliberately not a flat list the client buckets itself: doing the grouping
   * in two places is how the two views drift apart, and getting an agent into
   * the wrong bucket is the exact bug this rebuild is fixing.
   */
  agentsByCategory: () =>
    request<CategoryGroup[]>("/agents/by-category", { auth: false }),

  agent: (id: string) => request<Agent & { recentJobs: unknown[] }>(`/agents/${id}`, { auth: false }),

  createAgent: (input: unknown) =>
    post<{ agent: Agent; sharedSecret: string; health: { healthy: boolean; error: string | null } }>(
      "/agents",
      input
    ),

  checkHealth: (id: string) =>
    post<{ healthy: boolean; error: string | null; latencyMs: number }>(`/agents/${id}/health`),

  // --- jobs ---------------------------------------------------------------
  jobs: (query: Record<string, string> = {}) =>
    request<JobSummary[]>(`/jobs?${new URLSearchParams(query)}`),
  job: (id: string) => request<JobDetail>(`/jobs/${id}`),

  quote: (input: {
    planningFeeCap: string;
    fixedFeeCap: string;
    planningTokenCap: string;
    tokenBudgetCap: string;
    tier: number;
    jobType: "OPEN" | "DIRECT";
  }) => post<Quote>("/jobs/quote", input),

  /** General window: a custom job open to any general-purpose agent. */
  createCustomJob: (input: unknown) => post<JobSummary>("/jobs/custom", input),
  /** Single-purpose window: hire one named agent. */
  createDirectJob: (input: unknown) => post<JobSummary>("/jobs/direct", input),

  claim: (id: string, agentId: string) => post<JobSummary>(`/jobs/${id}/claim`, { agentId }),
  acceptOffer: (id: string) => post<JobSummary>(`/jobs/${id}/accept-offer`),
  submitPlan: (id: string, input: unknown) => post<JobSummary>(`/jobs/${id}/plan`, input),
  submitDeliverable: (id: string, deliverable: string) =>
    post<JobSummary>(`/jobs/${id}/deliverable`, { deliverable }),
  acceptPlan: (id: string) => post<JobSummary>(`/jobs/${id}/accept-plan`),
  rejectPlan: (id: string) => post<unknown>(`/jobs/${id}/reject-plan`),
  accept: (id: string, rating: number, comment?: string) =>
    post<unknown>(`/jobs/${id}/accept`, { rating, comment }),
  reject: (id: string) => post<unknown>(`/jobs/${id}/reject`),
  cancel: (id: string) => post<unknown>(`/jobs/${id}/cancel`),

  // --- reputation & oracle -------------------------------------------------
  wallet: (address: string) => request<WalletProfile>(`/wallets/${address}`, { auth: false }),
  oracleStatus: () =>
    request<{
      oracleConfigured: boolean;
      oracleAddress: string | null;
      threshold: number;
      trustModel: string;
    }>("/oracle/status", { auth: false }),
};
