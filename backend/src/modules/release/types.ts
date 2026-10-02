/**
 * CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence — types.
 * Immutable deployment records, release identity, verification evidence, provider
 * capability, controlled rollback, release diff, and failure correlation.
 * SECRET VALUES ARE NEVER CARRIED IN THESE TYPES.
 */

/** Deployment lifecycle. Only VERIFIED means all configured verification gates passed. */
export const DEPLOYMENT_STATUSES = [
  'PLANNED', 'STARTED', 'BUILDING', 'TESTING', 'DEPLOYING', 'VERIFYING',
  'VERIFIED', 'FAILED', 'PARTIAL', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'BLOCKED',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export type Environment = 'development' | 'staging' | 'production';

/** Deployment lifecycle stage (for evidence + failure correlation). */
export const DEPLOYMENT_STAGES = ['preflight', 'build', 'test', 'deploy', 'health', 'smoke'] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

/** Verification gate outcome. */
export type GateOutcome = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

export interface GateResult {
  id: string;
  stage: DeploymentStage | 'verification';
  name: string;
  outcome: GateOutcome;
  message: string;
  evidence?: string;
  responseTimeMs?: number;
}

/** Release identity. Commit SHA is NEVER fabricated. */
export interface GitIdentity {
  available: boolean;
  branch?: string;
  commitSha?: string;
  commitTimestamp?: string;
  author?: string;
}

export type ProviderId = 'railway' | 'render' | 'fly.io' | 'vercel' | 'cloudflare' | 'netlify' | 'kubernetes' | 'docker' | 'unknown';

/** Honest provider capability. Adapter existence ≠ integration. */
export type ProviderCapabilityState = 'SUPPORTED' | 'CONFIGURED' | 'UNCONFIGURED' | 'ENVIRONMENT_BLOCKED' | 'UNAVAILABLE' | 'UNSUPPORTED';

export interface ProviderCapability {
  provider: ProviderId;
  supportsRollback: boolean;
  state: ProviderCapabilityState;
  reason: string;
  /** True only when execution is actually possible on this deployment. */
  live: boolean;
}

export interface DeploymentRecord {
  id: string;
  projectId: string;
  workspaceId: string | null;
  environment: 'development' | 'staging' | 'production';
  provider: ProviderId;
  service: string;
  version: string;
  git: GitIdentity;
  status: DeploymentStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  buildResult: GateResult | null;
  testResult: GateResult | null;
  healthResult: GateResult | null;
  smokeResult: GateResult | null;
  verification: 'VERIFIED' | 'PARTIAL' | 'NOT_VERIFIED';
  deploymentUrl: string | null;
  providerDeploymentId: string | null;
  failureReason: string | null;
  predecessorId: string | null;
  rollbackSourceId: string | null;
  rollbackTargetId: string | null;
  profileId: string | null;
  planId: string | null;
  verifyId: string | null;
  rollbackAvailable: boolean;
  createdAt: string;
}

export interface RollbackSafetyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RollbackRun {
  id: string;
  projectId: string;
  workspaceId: string | null;
  environment: 'development' | 'staging' | 'production';
  currentDeploymentId: string;
  targetDeploymentId: string;
  status: 'REQUESTED' | 'PREFLIGHT' | 'EXECUTING' | 'VERIFYING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  safetyChecks: RollbackSafetyCheck[];
  databaseCompat: 'COMPATIBLE' | 'BLOCKED' | 'UNKNOWN';
  provider: ProviderId;
  providerCapability: ProviderCapabilityState;
  reason: string;
  result: 'ROLLED_BACK' | 'FAILED' | 'BLOCKED';
  createdAt: string;
  completedAt: string | null;
}

export interface ChangeItem {
  kind: 'file' | 'commit' | 'test' | 'finding';
  label: string;
  detail?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

/** Evidence-based release diff. NEVER invents impact metrics. */
export interface ReleaseDiff {
  deploymentId: string;
  vsDeploymentId: string | null;
  version: string;
  commit: string | null;
  changes: ChangeItem[];
  filesChanged: number;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  qualityFindings: number;
  securityFindings: number;
  testChanges: number;
  summary: string;
}

/** Deterministic failure correlation. NEVER invents root causes. */
export interface FailureCorrelation {
  deploymentId: string;
  failedStage: DeploymentStage | null;
  failed: GateResult | null;
  status: DeploymentStatus;
  likelyCause: string;
  affectedService: string;
  version: string;
  commit: string | null;
  recommendedNextAction: string;
  rollbackAvailable: boolean;
  evidence: string[];
}

export interface DeploymentCreateInput {
  projectId: string;
  workspaceId?: string | null;
  environment?: 'development' | 'staging' | 'production';
  provider?: ProviderId;
  service?: string;
  version: string;
  branch?: string;
  commitSha?: string;
  commitTimestamp?: string;
  author?: string;
  predecessorId?: string | null;
  profileId?: string | null;
  planId?: string | null;
  deploymentUrl?: string | null;
  providerDeploymentId?: string | null;
}
