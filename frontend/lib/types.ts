// Shapes the API returns. BigInt amounts arrive as decimal strings — see
// backend/src/db.ts for why they are not numbers.

export type AgentKind = "GENERAL" | "SINGLE_PURPOSE";
export type Tier = 1 | 2;

export interface Category {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  isSeed: boolean;
  agentCount: number;
}

/**
 * Reputation is never returned as a bare number, and must never be rendered as
 * one. The score floors at zero, so `wrs: "0"` alone cannot tell a brand-new
 * wallet from one with eleven rejections — the counters are what make those
 * distinguishable, and every component that shows the score shows them too.
 */
export interface Reputation {
  wrs: string;
  jobsCompleted: number;
  jobsRejected: number;
  jobsExpired: number;
  totalValueSettled: string;
  firstSeen: string | null;
  lifetimeJobs: number;
  isNew: boolean;
}

export interface Descriptor {
  summary: string;
  capabilities: string[];
  models?: string[];
  avgCompletionMinutes: number;
  basePlanningFeeUsdc: number;
  baseFixedFeeUsdc: number;
  contact?: string;
  docsUrl?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface Agent {
  id: string;
  name: string;
  summary: string;
  kind: AgentKind;
  category: { id: string; slug: string; label: string } | null;
  wallet: string;
  tier: Tier;
  status: "ACTIVE" | "UNREACHABLE" | "SUSPENDED";
  endpointHost: string;
  lastHealthyAt: string | null;
  descriptor: Descriptor;
  basePlanningFee: string;
  baseFixedFee: string;
  avgCompletionMinutes: number;
  reputation: Reputation;
  createdAt: string;
}

export interface CategoryGroup {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  isSeed: boolean;
  agentCount: number;
  agents: Agent[];
}

export type JobState =
  | "OPEN"
  | "OFFERED"
  | "CLAIMED"
  | "PLAN_PENDING"
  | "IN_PROGRESS"
  | "REVIEW_PENDING"
  | "SETTLED"
  | "EXPIRED"
  | "CANCELLED";

export interface JobSummary {
  id: string;
  pda: string | null;
  /**
   * Assigned off-chain at creation time (services/jobs.ts's nextNonce()),
   * before any on-chain transaction exists — see transactions.ts's postJob.
   * This is the value that must be signed on-chain, not one re-derived from
   * EmployerProfile.nextNonce, since the two can drift.
   */
  nonce: number;
  title: string;
  state: JobState;
  jobType: "OPEN" | "DIRECT";
  employerAddress: string;
  agentAddress: string | null;
  agent: { id: string; name: string; kind: AgentKind } | null;
  category: { slug: string; label: string } | null;
  planningFeeCap: string;
  fixedFeeCap: string;
  planningTokenCap: string;
  tokenBudgetCap: string;
  planningFee: string;
  fixedFee: string;
  bond: string;
  minTier: Tier;
  claimedTier: Tier | null;
  deadline: string;
  reviewExpiresAt: string | null;
  offerExpiresAt: string | null;
  rating: number | null;
  autoAccepted: boolean;
  createdAt: string;
}

export interface JobDetail extends JobSummary {
  specText: string | null;
  planText: string | null;
  deliverableText: string | null;
  specHash: string;
  planHash: string | null;
  deliverableHash: string | null;
  planningTokensUsed: string;
  executionTokensUsed: string;
  holdbackAmount: string;
  holdbackUntil: string | null;
  viewerRole: "employer" | "agent" | "observer";
  events: { id: string; kind: string; actor: string | null; detail: string | null; txSig: string | null; createdAt: string }[];
  usageReports: { id: string; phase: number; amount: string; model: string | null; createdAt: string }[];
}

export interface Quote {
  escrowTotal: string;
  bond: string;
  valueCap: string;
  withinCap: boolean;
  hasHoldback: boolean;
  maxAgentPayout: string;
  maxProtocolFee: string;
  minEmployerRefund: string;
}

export interface WalletProfile {
  address: string;
  exists: boolean;
  profilePda: string;
  explorer: string;
  tier?: Tier;
  reputation: Reputation;
  asEmployer: { jobsPosted: number; jobsRejected: number; rejectionRateBps: string };
  agents: Agent[];
}