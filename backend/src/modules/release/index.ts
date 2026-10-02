/**
 * CodeConClave — PKG-21 — Deployment History + Rollback + Release Evidence — barrel.
 */
export { createDeployment, listDeployments, getDeployment, getCurrentDeployment, getLatestVerified, updateDeployment } from './records.js';
export { providerCapability, listProviderCapabilities } from './provider.js';
export { resolveGitIdentity, gitVersionLabel } from './git.js';
export { computeVerification, deriveStatus, isRollbackEligible } from './verification.js';
export { buildReleaseDiff } from './diff.js';
export { correlateFailure, gateOutcome } from './failure.js';
export { createRollbackEngine, rollbackEngine, assessDatabaseCompat } from './rollback.js';
export type {
  DeploymentRecord,
  DeploymentStatus,
  DeploymentCreateInput,
  GateResult,
  GitIdentity,
  ProviderCapability,
  ProviderId,
  RollbackRun,
  RollbackSafetyCheck,
  ReleaseDiff,
  ChangeItem,
  FailureCorrelation,
} from './types.js';
export type { Environment } from './types.js';
export type { DeploymentQuery } from './records.js';
export type { RollbackInput, DbMigrationEvidence } from './rollback.js';
export { createReleaseService, releaseService } from './service.js';
export { releaseRoutes } from './routes.js';
