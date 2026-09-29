/**
 * CodeConClave — Deployment Wizard (V4E) Barrel Exports.
 */
export { discoverDeployment } from './deploymentDiscovery.js';
export type {
  DeploymentProfile,
  DetectedComponent,
  ComponentType,
  PackageManager,
  Framework,
  EnvFileAnalysis,
  EnvVariable,
  DockerAnalysis,
  DeploymentConfigAnalysis,
  HealthCheckConfig,
  DiscoveryInput,
  FileEntry,
} from './deploymentDiscovery.js';

export { checkDeploymentReadiness } from './deploymentReadiness.js';
export type {
  DeploymentReadiness,
  ReadinessItem,
  ReadinessStatus,
  ReadinessInput,
} from './deploymentReadiness.js';

export { generateDeploymentPlan } from './deploymentPlan.js';
export type {
  DeploymentPlan,
  DeploymentStep,
  DeploymentStrategy,
  RollbackPlan,
  StepAction,
  SafetyLevel,
  PlanInput,
} from './deploymentPlan.js';

export {
  createSecretInventory,
  validateSecret,
  recordSecretEntry,
  maskSecret,
} from './secretHandling.js';
export type {
  SecretEntry,
  SecretInventory,
  SecretStatus,
  SecretEntryInput,
  SecretValidationResult,
} from './secretHandling.js';

export { runPreDeployChecks, checkRunners } from './preDeployCheck.js';
export type {
  PreDeployResult,
  PreDeployCheck,
  PreDeployInput,
  CheckStatus,
  CheckSeverity,
  CheckRunner,
} from './preDeployCheck.js';

export {
  compareStrategies,
  selectStrategy,
  getStrategyInfo,
  isStrategySupported,
} from './deploymentStrategy.js';
export type {
  StrategyConfig,
  StrategySelection,
  StrategyComparison,
  CanaryConfig,
} from './deploymentStrategy.js';

export {
  requestApproval,
  decideApproval,
  getApprovalStatus,
  listPendingApprovals,
  requiresApproval,
} from './humanApproval.js';
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalStatus,
  ApprovalType,
  ApprovalInput,
} from './humanApproval.js';

export { runPostDeployVerification } from './postDeployVerify.js';
export type {
  PostDeployResult,
  VerificationCheck,
  VerificationStatus,
  PostDeployInput,
} from './postDeployVerify.js';

export { prepareRollbackPlan } from './rollbackPlanner.js';
export type {
  RollbackInfo,
  RollbackStep,
  RollbackInput,
} from './rollbackPlanner.js';

export { generateDeploymentReport } from './deploymentReport.js';
export type {
  DeploymentReport,
  ReportInput,
} from './deploymentReport.js';

export { deploymentWizardRoutes } from './routes.js';
