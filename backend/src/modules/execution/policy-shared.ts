/**
 * CodeConClave — execution module shared constants (frozen spec section 4.6/4.7).
 * NOT LLM-decided. TTLs and enum values are code-level constants.
 */

export const Timeouts = {
  APPROVAL_DEFAULT_TTL_MS: 10 * 60 * 1000,
  APPROVAL_MAX_TTL_MS: 30 * 60 * 1000,
  APPROVAL_REJECT_TIMEOUT_MS: 120 * 60 * 1000,
  FAST_TRACK_GRACE_SCALE: 0.5, // fast mode: half the default TTL
  APPROVAL_DEFAULT_EXPIRY_MS: 30 * 60 * 1000, // Phase 4C default window (spec: 30 minutes)
  APPROVAL_MAX_RESOURCES: 50, // max affected resources per approval
} as const;

export const ApprovalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  EXECUTED: 'EXECUTED',
} as const;

export const ApprovalExecutionState = {
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;

export type Risky = (typeof RiskLevel)[keyof typeof RiskLevel];

export const AuditAction = {
  TASK_APPROVAL_REQUESTED: 'task.approval.requested',
  APPROVAL_GRANTED: 'approval.granted',
  APPROVAL_REJECTED: 'approval.rejected',
  APPROVAL_CREATED: 'approval.created',
  APPROVAL_EXECUTION_STARTED: 'approval.execution_started',
  APPROVAL_EXECUTION_SUCCEEDED: 'approval.execution_succeeded',
  APPROVAL_EXECUTION_FAILED: 'approval.execution_failed',
  APPROVAL_EXPIRED: 'approval.expired',
  TASK_CREATED: 'task.created',
  TASK_RUN: 'task.run',
  TASK_COMPLETED: 'task.completed',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
  TASK_RETRIED: 'task.retried',
  TASK_RECOVERED: 'task.recovered',
  TASK_DEAD_LETTERED: 'task.dead_lettered',
  TASK_DEPENDENCY_ADDED: 'task.dependency_added',
  TASK_PLAN_CREATED: 'task.plan_created',
  COWORKER_RUN: 'coworker.run',
  COWORKER_HANDOFF: 'coworker.handoff',
  COWORKER_ARTIFACT: 'coworker.artifact',
  EXECUTION_TOOL_CALL: 'execution.tool_call',
  EXECUTION_TOOL_RESULT: 'execution.tool_result',
  EXECUTION_TOOL_DENIED: 'execution.tool_denied',
  EXECUTION_TOOL_TIMEOUT: 'execution.tool_timeout',
  EXECUTION_TOOL_ERROR: 'execution.tool_error',
  EXECUTION_TOOL_VERIFY: 'execution.tool_verify',
  EXECUTION_UNAUTHORIZED: 'execution.unauthorized',
  SECURITY_FUNDAMENTAL: 'security.fundamental',
  SECURITY_SCANNER: 'security.scanner',
  PAYMENT_STARTED: 'payment.started',
  PAYMENT_EVIDENCE: 'payment.evidence',
  PAYMENT_VERIFIED: 'payment.verified',
} as const;

export const PipelineStage = {
  CREATED: 'CREATED',
  PROSPECT: 'PROSPECT',
  ACTIVE: 'ACTIVE',
  CHANGED: 'CHANGED',
  PLANNED: 'PLANNED',
  TESTING: 'TESTING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  RUNNING: 'RUNNING',
  REVIEW: 'REVIEW',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;

export const SUB_STAGES = [
  'context-gathered',
  'plan-assembled',
  'code-generated',
  'code-reviewed',
  'test-generated',
  'tests-run',
  'verification-passed',
] as const;

export const ToolCallStatus = {
  PROPOSED: 'PROPOSED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  TIMED_OUT: 'TIMED_OUT',
  ERROR: 'ERROR',
  COMPLETED: 'COMPLETED',
} as const;

export const CoworkerType = {
  ORCHESTRATOR: 'ORCHESTRATOR',
  PLANNER: 'PLANNER',
  CODER: 'CODER',
  REVIEWER: 'REVIEWER',
  TESTER: 'TESTER',
  MEMORY_CURATOR: 'MEMORY_CURATOR',
  GIT_OPERATOR: 'GIT_OPERATOR',
  DOCUMENTER: 'DOCUMENTER',
  SECURITY_ANALYST: 'SECURITY_ANALYST',
} as const;

export const ArtifactType = {
  CODE_CHANGESET: 'code_changeset',
  PATCH: 'patch',
  PLAN: 'plan',
  DOCUMENTATION: 'documentation',
  TEST_REPORT: 'test_report',
  HANDBOOK_ENTRY: 'handbook_entry',
} as const;