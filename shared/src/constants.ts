/**
 * CodeConClave — shared domain constants.
 *
 * These are const-object enums (not TypeScript `enum`) so the emitted code
 * runs under Node's native type stripping as well as under tsc/tsx/vitest.
 */

export const TaskStatus = {
  CREATED: 'CREATED',
  PLANNED: 'PLANNED',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  RUNNING: 'RUNNING',
  TESTING: 'TESTING',
  VERIFIED: 'VERIFIED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
  WAITING_FOR_LOCAL_AGENT: 'WAITING_FOR_LOCAL_AGENT',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Task recovery status (Phase 7): how the engine is handling a failed or
 * timed-out task. NONE = not recovered yet; RETRYING = rescheduled with
 * exponential backoff; DEAD_LETTERED = moved to the dead-letter queue after
 * exhausting retries; RECOVERED = manually retried out of the DLQ.
 */
export const TaskRecoveryStatus = {
  NONE: 'NONE',
  RETRYING: 'RETRYING',
  DEAD_LETTERED: 'DEAD_LETTERED',
  RECOVERED: 'RECOVERED',
} as const;
export type TaskRecoveryStatus = (typeof TaskRecoveryStatus)[keyof typeof TaskRecoveryStatus];

/** Structured, persisted Planner output (Phase 7). Never executed free-form. */
export const PlanStatus = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  ABANDONED: 'ABANDONED',
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

/** Dependency kinds between tasks (Phase 7). */
export const TaskDependencyKind = {
  FINISH: 'finish',
} as const;
export type TaskDependencyKind = (typeof TaskDependencyKind)[keyof typeof TaskDependencyKind];

/** Retry policy (Phase 7): exponential backoff, capped. Code-level constants. */
export const RetryPolicy = {
  BASE_BACKOFF_MS: 60_000,
  MAX_BACKOFF_MS: 15 * 60 * 1000,
  DEFAULT_MAX_ATTEMPTS: 3,
} as const;

/** Task priority levels (Phase 7): higher claims sooner. */
export const TaskPriorityLevel = {
  NORMAL: 0,
  URGENT: 5,
  CRITICAL: 10,
} as const;
export type TaskPriorityLevel = (typeof TaskPriorityLevel)[keyof typeof TaskPriorityLevel];

export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const ApprovalStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  EXECUTED: 'EXECUTED',
  CANCELLED: 'CANCELLED',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

/** Server-classified action types for the Approval Center (Phase 4C). */
export const ApprovalActionType = {
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  FILE_CREATE: 'file_create',
  FILE_DELETE: 'file_delete',
  TERMINAL_EXEC: 'terminal_exec',
  NETWORK_REQUEST: 'network_request',
  PLUGIN_ACTION: 'plugin_action',
  PUBLISH: 'publish',
  DEPLOY: 'deploy',
  PRODUCTION_OP: 'production_op',
  SECRET_ACCESS: 'secret_access',
  POLICY_OVERRIDE: 'policy_override',
  PAYMENT_OP: 'payment_op',
  REMOTE_EXEC: 'remote_exec',
  BATCH: 'batch',
} as const;
export type ApprovalActionType = (typeof ApprovalActionType)[keyof typeof ApprovalActionType];

export const ApprovalExecutionState = {
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;
export type ApprovalExecutionState = (typeof ApprovalExecutionState)[keyof typeof ApprovalExecutionState];

export const MemoryType = {
  EPISODIC: 'EPISODIC',
  SEMANTIC: 'SEMANTIC',
  PROCEDURAL: 'PROCEDURAL',
  PROJECT: 'PROJECT',
  TEAM: 'TEAM',
} as const;
export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

export const MemorySource = {
  OBSERVED: 'OBSERVED',
  USER_STATED: 'USER_STATED',
  AI_INFERRED: 'AI_INFERRED',
  RECOMMENDATION: 'RECOMMENDATION',
} as const;
export type MemorySource = (typeof MemorySource)[keyof typeof MemorySource];

export const MemoryConfidence = {
  LOW: 0.33,
  MEDIUM: 0.66,
  HIGH: 0.99,
} as const;
export type MemoryConfidence = (typeof MemoryConfidence)[keyof typeof MemoryConfidence];

export const MemoryContradictionState = {
  NONE: 'NONE',
  CANDIDATE: 'CANDIDATE',
  CONFIRMED: 'CONFIRMED',
  RESOLVED: 'RESOLVED',
} as const;
export type MemoryContradictionState =
  (typeof MemoryContradictionState)[keyof typeof MemoryContradictionState];

export const MemoryEmbeddingStatus = {
  NONE: 'NONE',
  QUEUED: 'QUEUED',
  FAILED: 'FAILED',
  READY: 'READY',
} as const;
export type MemoryEmbeddingStatus = (typeof MemoryEmbeddingStatus)[keyof typeof MemoryEmbeddingStatus];

export const MemoryVerificationState = {
  UNVERIFIED: 'UNVERIFIED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
} as const;
export type MemoryVerificationState = (typeof MemoryVerificationState)[keyof typeof MemoryVerificationState];

export const MemoryScope = {
  PERSONAL: 'PERSONAL',
  PROJECT: 'PROJECT',
  TEAM: 'TEAM',
} as const;
export type MemoryScope = (typeof MemoryScope)[keyof typeof MemoryScope];

export const MemoryRelation = {
  SUPPORTS: 'supports',
  CONTRADICTS: 'contradicts',
  DERIVED_FROM: 'derived_from',
  SUPERSEDES: 'supersedes',
  SOURCE_OF: 'source_of',
} as const;
export type MemoryRelation = (typeof MemoryRelation)[keyof typeof MemoryRelation];

export const MemorySearchMode = {
  VECTOR: 'VECTOR',
  FULL_TEXT: 'FULL_TEXT',
  HYBRID: 'HYBRID',
} as const;
export type MemorySearchMode = (typeof MemorySearchMode)[keyof typeof MemorySearchMode];

export const TeamDnaStatus = {
  ACTIVE: 'ACTIVE',
  MERGED: 'MERGED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type TeamDnaStatus = (typeof TeamDnaStatus)[keyof typeof TeamDnaStatus];

export const TeamDnaConflictState = {
  NONE: 'NONE',
  CONFLICT: 'CONFLICT',
  RESOLVED: 'RESOLVED',
} as const;
export type TeamDnaConflictState = (typeof TeamDnaConflictState)[keyof typeof TeamDnaConflictState];

export const DnaKind = {
  DECISION: 'DECISION',
  UNRESOLVED_WORK: 'UNRESOLVED_WORK',
  NEXT_ACTIONS: 'NEXT_ACTIONS',
  DISCOVERY: 'DISCOVERY',
  BLOCKER: 'BLOCKER',
  PROJECT_CONTEXT: 'PROJECT_CONTEXT',
  RELEVANT_FILES: 'RELEVANT_FILES',
  ENVIRONMENT_STATE: 'ENVIRONMENT_STATE',
  VERIFICATION_RESULT: 'VERIFICATION_RESULT',
} as const;
export type DnaKind = (typeof DnaKind)[keyof typeof DnaKind];

export const DnaScope = {
  MAIN: 'MAIN',
  BRANCH: 'BRANCH',
} as const;
export type DnaScope = (typeof DnaScope)[keyof typeof DnaScope];

export const DnaConflictState = {
  NONE: 'NONE',
  CONFLICT: 'CONFLICT',
  RESOLVED: 'RESOLVED',
} as const;
export type DnaConflictState = (typeof DnaConflictState)[keyof typeof DnaConflictState];

export const PaymentMode = {
  PAYMENT_LINK: 'PAYMENT_LINK',
  API: 'API',
  WEBHOOK: 'WEBHOOK',
} as const;
export type PaymentMode = (typeof PaymentMode)[keyof typeof PaymentMode];

/** Payment state machine — VERIFIED requires independent provider evidence. */
export const PaymentState = {
  PENDING: 'PENDING',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  REFUNDED: 'REFUNDED',
  CANCELLED: 'CANCELLED',
} as const;
export type PaymentState = (typeof PaymentState)[keyof typeof PaymentState];

export const EntitlementState = {
  FREE: 'FREE',
  PRO_PENDING: 'PRO_PENDING',
  PRO_VERIFIED: 'PRO_VERIFIED',
  PRO_EXPIRED: 'PRO_EXPIRED',
  PRO_REFUNDED: 'PRO_REFUNDED',
} as const;
export type EntitlementState = (typeof EntitlementState)[keyof typeof EntitlementState];

export const PlanId = {
  FREE: 'free',
  PRO: 'pro',
  TEAM: 'team',
  ENTERPRISE: 'enterprise',
} as const;
export type PlanId = (typeof PlanId)[keyof typeof PlanId];

export const NotificationType = {
  TASK_COMPLETED: 'task.completed',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',
  TASK_FAILED: 'task.failed',
  TEAM_MESSAGE: 'team.message',
  TEAM_INVITATION: 'team.invitation',
  TEAM_MEMBER_JOINED: 'team.member_joined',
  TEAM_MEMBER_REMOVED: 'team.member_removed',
  TEAM_ROLE_CHANGED: 'team.role_changed',
  TEAM_PROJECT_UPDATED: 'team.project_updated',
  TEAM_TASK_ASSIGNED: 'team.task_assigned',
  TEAM_TASK_COMPLETED: 'team.task_completed',
  TEAM_APPROVAL_REQUESTED: 'team.approval_requested',
  PAYMENT_STATUS: 'payment.status',
  PAYMENT_REVIEW_REQUIRED: 'payment.review_required',
  PLUGIN_DEGRADED: 'plugin.degraded',
  PLUGIN_FAILED: 'plugin.failed',
  PLUGIN_REAUTH_REQUIRED: 'plugin.reauth_required',
  PLUGIN_RECOVERED: 'plugin.recovered',
  RESEARCH_COMPLETED: 'research.completed',
  REMINDER: 'reminder',
  MILESTONE: 'milestone',
  MENTION: 'mention',
  SYSTEM: 'system',
  IDEA_ASSIGNED: 'idea.assigned',
  BRAINSTORM_INVITE: 'brainstorm.invite',
  DIGEST_DAILY: 'digest.daily',
  DIGEST_WEEKLY: 'digest.weekly',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_BLOCKED: 'agent.blocked',
  AGENT_FAILED: 'agent.failed',
  AGENT_APPROVAL_REQUIRED: 'agent.approval_required',
  SCHEDULE_RUN_COMPLETED: 'schedule.run_completed',
  SCHEDULE_RUN_FAILED: 'schedule.run_failed',
  GOAL_COMPLETED: 'goal.completed',
  GOAL_BLOCKED: 'goal.blocked',
  GOAL_ESCALATION_NEEDS_DECISION: 'goal.escalation_needs_decision',
  PREVIEW_READY: 'preview.ready',
  PREVIEW_FAILED: 'preview.failed',
  DEPLOYMENT_READY: 'deployment.ready',
  AUTOMATION_RUN_COMPLETED: 'automation.run_completed',
  AUTOMATION_RUN_FAILED: 'automation.run_failed',
  AUTOMATION_ESCALATION_NEEDS_DECISION: 'automation.escalation_needs_decision',
  AUTOMATION_PAUSED: 'automation.paused',
  PR_REVIEW_COMPLETED: 'pr_review.completed',
  UPGRADE_APPROVAL_REQUIRED: 'upgrade.approval_required',
  CI_FIX_APPROVAL_REQUIRED: 'ci.fix_approval_required',
  CI_FIX_APPLIED: 'ci.fix_applied',
  FLAKE_INVESTIGATION_CREATED: 'flake.investigation_created',
  PREVIEW_COMMENT_TASK_CREATED: 'preview.comment_task_created',
  KILL_SWITCH_ACTIVATED: 'control.kill_switch_activated',
  SECRET_GUARD_ALERT: 'secret_guard.alert',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const NotificationPreferenceKey = {
  IN_APP: 'in_app',
  PUSH: 'push',
  EMAIL: 'email',
  DAILY_DIGEST: 'daily_digest',
  WEEKLY_DIGEST: 'weekly_digest',
  DND: 'dnd',
  QUIET_HOURS: 'quiet_hours',
  TIMEZONE: 'timezone',
} as const;
export type NotificationPreferenceKey = (typeof NotificationPreferenceKey)[keyof typeof NotificationPreferenceKey];

export const UsageKind = {
  MESSAGES: 'messages',
  STORAGE: 'storage',
  AI_TOKENS: 'ai_tokens',
  COMPUTE: 'compute',
  TASKS: 'tasks',
  MODEL_USAGE: 'model_usage',
} as const;
export type UsageKind = (typeof UsageKind)[keyof typeof UsageKind];

export const UsageUnit = {
  COUNT: 'count',
  BYTES: 'bytes',
  TOKENS: 'tokens',
  USD: 'usd',
} as const;
export type UsageUnit = (typeof UsageUnit)[keyof typeof UsageUnit];

export const ModelTier = {
  PREMIUM: 'PREMIUM',
  CAPABLE: 'CAPABLE',
  EFFICIENT: 'EFFICIENT',
} as const;
export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

/** Cost-survival compute classes: A = cheap, B = standard, C = premium. */
export const ComputeClass = {
  A: 'A',
  B: 'B',
  C: 'C',
} as const;
export type ComputeClass = (typeof ComputeClass)[keyof typeof ComputeClass];

export const PrivacyClass = {
  PUBLIC: 'PUBLIC',
  STANDARD: 'STANDARD',
  STRICT: 'STRICT',
} as const;
export type PrivacyClass = (typeof PrivacyClass)[keyof typeof PrivacyClass];

export const ProviderId = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  GOOGLE: 'google',
  MISTRAL: 'mistral',
  GROK: 'grok',
  DEEPSEEK: 'deepseek',
  KIMI: 'kimi',
  NEMOTRON: 'nemotron',
  NORTH: 'north',
} as const;
export type ProviderId = (typeof ProviderId)[keyof typeof ProviderId];

export const ProviderState = {
  UNKNOWN: 'UNKNOWN',
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
} as const;
export type ProviderState = (typeof ProviderState)[keyof typeof ProviderState];

/** Agent trust levels (Stage 26) — server-authoritative autonomy policy.
 * Stored intent is clamped by the user's plan at enforcement time; effective
 * trust is never set by the agent itself and every change is audited. */
export const AgentTrustLevel = {
  L0: 'L0',
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  L4: 'L4',
} as const;
export type AgentTrustLevel = (typeof AgentTrustLevel)[keyof typeof AgentTrustLevel];

export const AGENT_TRUST_LABELS: Record<AgentTrustLevel, string> = {
  L0: 'Unmanaged — every task requires approval',
  L1: 'Supervised — approval gates honored',
  L2: 'Standard — default autonomy',
  L3: 'Trusted — high autonomy',
  L4: 'Full — reserved for enterprise',
};

/**
 * Gateway fallback/error taxonomy (Phase 5). Every fallback hop and every
 * provider failure carries a machine-readable reason; nothing is silent.
 */
export const AiFallbackReason = {
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  CAPABILITY_MISMATCH: 'capability_mismatch',
  ENTITLEMENT_MISMATCH: 'entitlement_mismatch',
  INVALID_CREDENTIALS: 'invalid_credentials',
  BILLING: 'billing',
  STREAM_INTERRUPTED: 'stream_interrupted',
  UNSUPPORTED_FEATURE: 'unsupported_feature',
  PREMIUM_COMPUTE_DENIED: 'premium_compute_denied',
  PROVIDER_NOT_CONFIGURED: 'provider_not_configured',
} as const;
export type AiFallbackReason = (typeof AiFallbackReason)[keyof typeof AiFallbackReason];

export const CoworkerType = {
  ARCHITECT: 'ARCHITECT',
  CODER: 'CODER',
  SECURITY: 'SECURITY',
  TESTER: 'TESTER',
  PERFORMANCE: 'PERFORMANCE',
  RESEARCH: 'RESEARCH',
  DOCS: 'DOCS',
  REVIEWER: 'REVIEWER',
  PLANNER: 'PLANNER',
} as const;
export type CoworkerType = (typeof CoworkerType)[keyof typeof CoworkerType];

export const CoworkerRunState = {
  QUEUED: 'QUEUED',
  PLANNING: 'PLANNING',
  RUNNING: 'RUNNING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
} as const;
export type CoworkerRunState = (typeof CoworkerRunState)[keyof typeof CoworkerRunState];

/** Multi-agent workspace roles (Stage 25.5). One agent per role per workspace. */
export const AgentRole = {
  ARCHITECT: 'ARCHITECT',
  CODER: 'CODER',
  DEBUGGER: 'DEBUGGER',
  RESEARCHER: 'RESEARCHER',
  REVIEWER: 'REVIEWER',
  TESTER: 'TESTER',
  SECURITY: 'SECURITY',
  DEVOPS: 'DEVOPS',
  UI_UX: 'UI_UX',
  DOCUMENTATION: 'DOCUMENTATION',
} as const;
export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

/** Agent run state machine (server-authoritative; driven by the task engine). */
export const AgentRunState = {
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  RUNNING: 'RUNNING',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  WAITING_FOR_DEPENDENCY: 'WAITING_FOR_DEPENDENCY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
} as const;
export type AgentRunState = (typeof AgentRunState)[keyof typeof AgentRunState];

/** Main-workspace live preview states (never claim READY without a real build). */
export const PreviewState = {
  BUILDING: 'BUILDING',
  UPDATING: 'UPDATING',
  READY: 'READY',
  ERROR: 'ERROR',
  OFFLINE: 'OFFLINE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
} as const;
export type PreviewState = (typeof PreviewState)[keyof typeof PreviewState];

/** Kill-switch scopes (Stage 26G control plane). GLOBAL overrides all scopes. */
export const KillSwitchScope = {
  GLOBAL: 'GLOBAL',
  AGENTS: 'AGENTS',
  TASKS: 'TASKS',
  SCHEDULES: 'SCHEDULES',
  AUTONOMY: 'AUTONOMY',
} as const;
export type KillSwitchScope = (typeof KillSwitchScope)[keyof typeof KillSwitchScope];

/** Control-policy requirement values (Stage 26G risk-based policies). */
export const ControlPolicyRequirement = {
  REQUIRE_APPROVAL: 'require_approval',
  BLOCK: 'block',
} as const;
export type ControlPolicyRequirement = (typeof ControlPolicyRequirement)[keyof typeof ControlPolicyRequirement];

/** Undo-log lifecycle (Stage 26G — only genuinely reversible ops are recorded). */
export const UndoStatus = {
  AVAILABLE: 'AVAILABLE',
  UNDONE: 'UNDONE',
  EXPIRED: 'EXPIRED',
} as const;
export type UndoStatus = (typeof UndoStatus)[keyof typeof UndoStatus];

/** Secret-guard scan targets (Stage 26G). */
export const SecretGuardTarget = {
  AGENT_OUTPUT: 'agent_output',
  FILE: 'file',
  COMMIT: 'commit',
  MEMORY: 'memory',
  TASK_PAYLOAD: 'task_payload',
} as const;
export type SecretGuardTarget = (typeof SecretGuardTarget)[keyof typeof SecretGuardTarget];

/** Usage/cost features for cost-per-feature + ROI analytics (Stage 26G). */
export const UsageFeature = {
  CHAT: 'chat',
  TASKS: 'tasks',
  AGENTS: 'agents',
  PREVIEW: 'preview',
  PLUGINS: 'plugins',
  ENGINEERING: 'engineering',
  SCHEDULING: 'scheduling',
  AUTOMATION: 'automation',
  BRAINSTORMING: 'brainstorming',
  DIGESTS: 'digests',
  GENERAL: 'general',
} as const;
export type UsageFeature = (typeof UsageFeature)[keyof typeof UsageFeature];

/** Server-derived plugin health states (Stage 25.5 marketplace). */
export const PluginHealthStatus = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_CONNECTED: 'NOT_CONNECTED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
} as const;
export type PluginHealthStatus = (typeof PluginHealthStatus)[keyof typeof PluginHealthStatus];

export const FileOperation = {
  READ: 'READ',
  WRITE: 'WRITE',
  CREATE: 'CREATE',
  RENAME: 'RENAME',
  DELETE: 'DELETE',
  LIST: 'LIST',
  STAT: 'STAT',
} as const;
export type FileOperation = (typeof FileOperation)[keyof typeof FileOperation];

export const PluginType = {
  GITHUB: 'github',
  GOOGLE: 'google',
  RESEND: 'resend',
  SLACK: 'slack',
  TEAMS: 'teams',
  DISCORD: 'discord',
  NOTION: 'notion',
  LINEAR: 'linear',
  JIRA: 'jira',
  FIGMA: 'figma',
  SENTRY: 'sentry',
  CLOUDFLARE: 'cloudflare',
  SUPABASE: 'supabase',
  VERCEL: 'vercel',
  RENDER: 'render',
  VSCODE: 'vscode',
  WEBHOOK: 'webhook',
} as const;
export type PluginType = (typeof PluginType)[keyof typeof PluginType];

export const PluginState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  ERROR: 'ERROR',
  REVOKED: 'REVOKED',
} as const;
export type PluginState = (typeof PluginState)[keyof typeof PluginState];

/**
 * Scoped plugin permissions (Phase 10). Server-authoritative, tenant-scoped,
 * revocable, auditable. A plugin never acts outside its granted scope.
 */
export const PluginPermission = {
  READ: 'read',
  WRITE: 'write',
  SEND: 'send',
  PUBLISH: 'publish',
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  ADMIN: 'admin',
} as const;
export type PluginPermission = (typeof PluginPermission)[keyof typeof PluginPermission];

/** Provider capabilities an adapter genuinely implements (never invented). */
export const PluginCapability = {
  REPOSITORIES: 'repositories',
  CONTENTS: 'contents',
  BRANCHES: 'branches',
  ISSUES: 'issues',
  PULL_REQUESTS: 'pull_requests',
  CHECKS: 'checks',
  GMAIL: 'gmail',
  DRIVE: 'drive',
  SHEETS: 'sheets',
  CALENDAR: 'calendar',
  EMAIL: 'email',
  WEBHOOK: 'webhook',
  MESSAGES: 'messages',
  CHANNELS: 'channels',
  PROJECTS: 'projects',
  DOCUMENTS: 'documents',
  DESIGN: 'design',
  DEPLOYMENTS: 'deployments',
  DATABASE: 'database',
  OBSERVABILITY: 'observability',
  MONITORING: 'monitoring',
  VECTOR_SEARCH: 'vector_search',
} as const;
export type PluginCapability = (typeof PluginCapability)[keyof typeof PluginCapability];

/**
 * Server-derived integration classification for the plugin center (Stage 25.5).
 * Honest capability classification — never claims a connector is implemented
 * when it is not:
 *  - UNSUPPORTED:      no adapter is registered in this build (cannot connect)
 *  - LIVE:             a connection exists and is usable right now
 *  - BLOCKED:          a connection exists but is unusable (failed/revoked/reauth)
 *  - CONFIGURED:       adapter exists and this deployment can connect (server
 *                      credentials present or user-supplied token accepted)
 *  - NOT_CONFIGURED:   adapter exists but required server configuration is
 *                      missing on this deployment
 */
export const PluginIntegrationStatus = {
  LIVE: 'LIVE',
  CONFIGURED: 'CONFIGURED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  BLOCKED: 'BLOCKED',
  UNSUPPORTED: 'UNSUPPORTED',
} as const;
export type PluginIntegrationStatus = (typeof PluginIntegrationStatus)[keyof typeof PluginIntegrationStatus];

/** Marketplace categories shown in the plugin center (Stage 25.5). */
export const PluginCategory = {
  DEVELOPMENT: 'development',
  PRODUCTIVITY: 'productivity',
  COMMUNICATION: 'communication',
  PROJECT_MANAGEMENT: 'project_management',
  DESIGN: 'design',
  CLOUD: 'cloud',
  DATA: 'data',
  MONITORING: 'monitoring',
} as const;
export type PluginCategory = (typeof PluginCategory)[keyof typeof PluginCategory];

export const SessionState = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;
export type SessionState = (typeof SessionState)[keyof typeof SessionState];

export const DeviceState = {
  PENDING_PAIRING: 'PENDING_PAIRING',
  PAIRED: 'PAIRED',
  REVOKED: 'REVOKED',
} as const;
export type DeviceState = (typeof DeviceState)[keyof typeof DeviceState];

export const MoonState = {
  HIDDEN: 'HIDDEN',
  THINKING: 'THINKING',
  FREE_LIMIT: 'FREE_LIMIT',
} as const;
export type MoonState = (typeof MoonState)[keyof typeof MoonState];

/** Real terminal process state machine (agent-reported; never cloud-invented). */
export const TerminalState = {
  PLANNED: 'PLANNED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  KILLED: 'KILLED',
  TIMED_OUT: 'TIMED_OUT',
} as const;
export type TerminalState = (typeof TerminalState)[keyof typeof TerminalState];

export const TerminalShell = {
  BASH: 'bash',
  ZSH: 'zsh',
  NODE: 'node',
  PYTHON: 'python',
  POWERSHELL: 'powershell',
} as const;
export type TerminalShell = (typeof TerminalShell)[keyof typeof TerminalShell];

/** Remote-control sessions: explicit, expiring authorization for a paired device. */
export const RemoteSessionState = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
} as const;
export type RemoteSessionState = (typeof RemoteSessionState)[keyof typeof RemoteSessionState];

/** Derived device presence — ONLINE is only ever true on a live agent socket. */
export const DevicePresence = {
  ONLINE: 'ONLINE',
  STALE: 'STALE',
  OFFLINE: 'OFFLINE',
} as const;
export type DevicePresence = (typeof DevicePresence)[keyof typeof DevicePresence];

export const UsageCounterName = {
  DAILY_MESSAGES: 'daily_messages',
  DAILY_AI_INPUT_TOKENS: 'daily_ai_input_tokens',
  DAILY_AI_OUTPUT_TOKENS: 'daily_ai_output_tokens',
  DAILY_ESTIMATED_COST_USD: 'daily_estimated_cost_usd',
  STORAGE_BYTES_USED: 'storage_bytes_used',
} as const;
export type UsageCounterName = (typeof UsageCounterName)[keyof typeof UsageCounterName];

export const WorkspaceStateKey = {
  LAST_ACTIVE_PROJECT: 'last_active_project',
  CURRENT_PROJECT: 'current_project',
  CURRENT_CONVERSATION: 'current_conversation',
  CONVERSATION_SCROLL: 'conversation_scroll',
  CURRENT_MODE: 'current_mode',
  CURRENT_MODEL: 'current_model',
  TERMINAL_TABS: 'terminal_tabs',
  ACTIVE_TASK: 'active_task',
  LOADED_DNA_VERSION: 'loaded_dna_version',
  MEMORY_CONTEXT_REFS: 'memory_context_refs',
  SIDEBAR_STATE: 'sidebar_state',
  RETURN_TO_WORK: 'return_to_work',
  LAST_ACTIVE: 'last_active',
  FREE_LIMIT_MOON: 'free_limit_moon',
} as const;

export const ProjectStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
  COMPLETED: 'COMPLETED',
  ON_HOLD: 'ON_HOLD',
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const ProjectMemberRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  EDITOR: 'editor',
  MEMBER: 'member',
  VIEWER: 'viewer',
} as const;

/**
 * Phase 9 — team collaboration roles. Strictly ordered (owner > admin >
 * editor > viewer > guest) and authoritative on the server only.
 */
export const TeamRole = {
  OWNER: 'owner',
  ADMIN: 'admin',
  EDITOR: 'editor',
  VIEWER: 'viewer',
  GUEST: 'guest',
} as const;
export type TeamRole = (typeof TeamRole)[keyof typeof TeamRole];

export const TEAM_ROLE_RANK: Record<TeamRole, number> = {
  owner: 5,
  admin: 4,
  editor: 3,
  viewer: 2,
  guest: 1,
} as const;

export const TeamMemberStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
} as const;
export type TeamMemberStatus = (typeof TeamMemberStatus)[keyof typeof TeamMemberStatus];

export const InvitationState = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type InvitationState = (typeof InvitationState)[keyof typeof InvitationState];

/** Invitation validity window (7 days) unless overridden by team settings. */
export const TEAM_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_TEAM_NAME_LENGTH = 120;
export const MAX_TEAM_DESCRIPTION_LENGTH = 2000;

export const MAX_PROJECT_TAGS = 10;
export const MAX_TAG_LENGTH = 40;

export const AuditAction = {
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_MFA_ENABLED: 'auth.mfa_enabled',
  AUTH_MFA_DISABLED: 'auth.mfa_disabled',
  AUTH_MFA_RECOVERY_ROTATED: 'auth.recovery_rotated',
  AUTH_RECOVERY_USED: 'auth.recovery_used',
  AUTH_SUSPICIOUS_LOGIN: 'auth.suspicious_login',
  AUTH_GOOGLE_LOGIN: 'auth.google_login',
  AUTH_EMAIL_VERIFICATION_SENT: 'auth.verification_sent',
  AUTH_EMAIL_VERIFIED: 'auth.email_verified',
  AUTH_EMAIL_VERIFICATION_FAILED: 'auth.verification_failed',
  SESSION_REVOKED: 'session.revoked',
  MESSAGE_CREATED: 'message.created',
  MEMORY_CREATED: 'memory.created',
  MEMORY_UPDATED: 'memory.updated',
  MEMORY_DELETED: 'memory.deleted',
  MEMORY_CORRECTED: 'memory.corrected',
  MEMORY_MERGED: 'memory.merged',
  MEMORY_RELATIONSHIP_ADDED: 'memory.relationship_added',
  MEMORY_SEARCHED: 'memory.searched',
  MEMORY_VERIFIED: 'memory.verified',
  MEMORY_REJECTED: 'memory.rejected',
  MEMORY_EMBEDDED: 'memory.embedded',
  DNA_CREATED: 'dna.created',
  DNA_RESTORED: 'dna.restored',
  DNA_TEAM_CREATED: 'dna.team_created',
  DNA_TEAM_BRANCH_CREATED: 'dna.team_branch_created',
  DNA_TEAM_MERGED: 'dna.team_merged',
  DNA_TEAM_CONFLICT_RESOLVED: 'dna.team_conflict_resolved',
  FILE_READ: 'file.read',
  FILE_WRITTEN: 'file.written',
  FILE_DELETED: 'file.deleted',
  TASK_CREATED: 'task.created',
  TASK_APPROVAL_REQUESTED: 'task.approval_requested',
  TASK_EXECUTED: 'task.executed',
  APPROVAL_GRANTED: 'approval.granted',
  APPROVAL_REJECTED: 'approval.rejected',
  PAYMENT_SESSION_CREATED: 'payment.session_created',
  PAYMENT_VERIFIED: 'payment.verified',
  PAYMENT_STATE_CHANGE: 'payment.state_change',
  ENTITLEMENT_CHANGED: 'entitlement.changed',
  PAYMENT_INTENT_CREATED: 'payment.intent_created',
  PAYMENT_MATCHED: 'payment.matched',
  PAYMENT_ACTIVATED: 'payment.activated',
  PAYMENT_REVIEW_REQUIRED: 'payment.review_required',
  PAYMENT_FRAUD_FLAGGED: 'payment.fraud_flagged',
  PAYMENT_EXPIRED: 'payment.expired',
  PAYMENT_REFUNDED: 'payment.refunded',
  PAYMENT_REVOKED: 'payment.revoked',
  PAYMENT_CHARGEBACK: 'payment.chargeback',
  PAYMENT_RECEIPT_SENT: 'payment.receipt_sent',
  PAYMENT_RECONCILED: 'payment.reconciled',
  PAYMENT_DIGEST_GENERATED: 'payment.digest_generated',
  PLUGIN_CONNECTED: 'plugin.connected',
  PLUGIN_REVOKED: 'plugin.revoked',
  PLUGIN_DISCONNECTED: 'plugin.disconnected',
  PLUGIN_REAUTHED: 'plugin.reauthed',
  PLUGIN_SCOPE_CHANGED: 'plugin.scope_changed',
  PLUGIN_HEALTH_CHANGED: 'plugin.health_changed',
  PLUGIN_ACTION_PERFORMED: 'plugin.action_performed',
  PLUGIN_CREDENTIAL_STORED: 'plugin.credential_stored',
  COWORKER_RUN_STARTED: 'coworker.run_started',
  DEVICE_PAIRED: 'device.paired',
  DEVICE_REVOKED: 'device.revoked',
  AGENT_CONNECTED: 'agent.connected',
  AGENT_DISCONNECTED: 'agent.disconnected',
  LOCAL_EDIT: 'local.edit',
  TASK_SCHEDULED: 'task.scheduled',
  POLICY_DENIED: 'policy.denied',
  SECURITY_VIOLATION: 'security.violation',
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_STATUS_CHANGED: 'project.status_changed',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_RESTORED: 'project.restored',
  PROJECT_DELETED: 'project.deleted',
  PROJECT_FAVORITED: 'project.favorited',
  PROJECT_MEMBER_ADDED: 'project.member_added',
  PROJECT_MEMBER_REMOVED: 'project.member_removed',
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_RENAMED: 'conversation.renamed',
  CONVERSATION_ARCHIVED: 'conversation.archived',
  CONVERSATION_RESTORED: 'conversation.restored',
  CONVERSATION_DELETED: 'conversation.deleted',
  CONVERSATION_FAVORITED: 'conversation.favorited',
  MESSAGE_EDITED: 'message.edited',
  THREAD_CREATED: 'thread.created',
  MENTION_CREATED: 'mention.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  PREFERENCES_UPDATED: 'preferences.updated',
  NOTIFICATION_CREATED: 'notification.created',
  NOTIFICATION_READ: 'notification.read',
  NOTIFICATION_ALL_READ: 'notification.all_read',
  NOTIFICATION_DELETED: 'notification.deleted',
  NOTIFICATION_PREFERENCE_UPDATED: 'notification_preference.updated',
  USAGE_EVENT_RECORDED: 'usage.event_recorded',
  TERMINAL_SESSION_CREATED: 'terminal.session_created',
  TERMINAL_SESSION_KILLED: 'terminal.session_killed',
  REMOTE_SESSION_CREATED: 'remote.session_created',
  REMOTE_SESSION_REVOKED: 'remote.session_revoked',
  REMOTE_SCREENSHOT_AUTHORIZED: 'remote.screenshot_authorized',
  APPROVAL_CREATED: 'approval.created',
  APPROVAL_EXECUTION_STARTED: 'approval.execution_started',
  APPROVAL_EXECUTION_SUCCEEDED: 'approval.execution_succeeded',
  APPROVAL_EXECUTION_FAILED: 'approval.execution_failed',
  APPROVAL_EXPIRED: 'approval.expired',
  FILE_UPLOADED: 'file.uploaded',
  FILE_VERSION_RESTORED: 'file.version_restored',
  FILE_TRASHED: 'file.trashed',
  FILE_RESTORED: 'file.restored',
  FILE_FAVORITED: 'file.favorited',
  FILE_TAGS_UPDATED: 'file.tags_updated',
  FILE_CATEGORY_UPDATED: 'file.category_updated',
  FILE_DELETED_PERMANENT: 'file.deleted_permanent',
  FILE_DOWNLOADED: 'file.downloaded',
  FILE_REFERENCE_ADDED: 'file.reference_added',
  FILE_PERMISSION_GRANTED: 'file.permission_granted',
  FILE_PERMISSION_REVOKED: 'file.permission_revoked',
  SEARCH_PERFORMED: 'search.performed',
  ARTIFACT_CREATED: 'artifact.created',
  ARTIFACT_DOWNLOADED: 'artifact.downloaded',
  DATA_CENTRE_VIEWED: 'datacentre.viewed',
  TRASH_PURGED: 'trash.purged',
  TEAM_CREATED: 'team.created',
  TEAM_RENAMED: 'team.renamed',
  TEAM_ARCHIVED: 'team.archived',
  TEAM_RESTORED: 'team.restored',
  TEAM_DESCRIPTION_UPDATED: 'team.description_updated',
  TEAM_SETTINGS_UPDATED: 'team.settings_updated',
  TEAM_MEMBER_INVITED: 'team.member_invited',
  TEAM_INVITATION_ACCEPTED: 'team.invitation_accepted',
  TEAM_INVITATION_REJECTED: 'team.invitation_rejected',
  TEAM_INVITATION_CANCELLED: 'team.invitation_cancelled',
  TEAM_INVITATION_EXPIRED: 'team.invitation_expired',
  TEAM_MEMBER_ADDED: 'team.member_added',
  TEAM_MEMBER_REMOVED: 'team.member_removed',
  TEAM_MEMBER_ROLE_CHANGED: 'team.member_role_changed',
  TEAM_MEMBER_SUSPENDED: 'team.member_suspended',
  TEAM_MEMBER_REVOKED: 'team.member_revoked',
  TEAM_PROJECT_SHARED: 'team.project_shared',
  TEAM_PROJECT_UNSHARED: 'team.project_unshared',
  TEAM_CONVERSATION_SHARED: 'team.conversation_shared',
  TEAM_CONVERSATION_UNSHARED: 'team.conversation_unshared',
  TEAM_MEMORY_ADDED: 'team.memory_added',
  TEAM_PERMISSION_CHANGED: 'team.permission_changed',
  IDEA_CREATED: 'idea.created',
  IDEA_UPDATED: 'idea.updated',
  IDEA_ARCHIVED: 'idea.archived',
  IDEA_RESTORED: 'idea.restored',
  IDEA_TRASHED: 'idea.trashed',
  IDEA_VOTED: 'idea.voted',
  IDEA_COMMENTED: 'idea.commented',
  IDEA_ASSIGNED: 'idea.assigned',
  BRAINSTORM_CREATED: 'brainstorm.created',
  BRAINSTORM_IDEA_CAPTURED: 'brainstorm.idea_captured',
  BRAINSTORM_COMPLETED: 'brainstorm.completed',
  BRAINSTORM_ARCHIVED: 'brainstorm.archived',
  CLEANUP_RECOMMENDED: 'cleanup.recommended',
  CLEANUP_RESOLVED: 'cleanup.resolved',
  TRASH_RESTORED: 'trash.restored',
  HISTORY_STARRED: 'history.starred',
  HISTORY_UNSTARRED: 'history.unstarred',
  EMAIL_DELIVERY_FAILED: 'email.delivery_failed',
  DIGEST_DELIVERED: 'digest.delivered',
  PLAN_CANCELLATION_REQUESTED: 'plan.cancellation_requested',
  AGENT_CREATED: 'agent.created',
  AGENT_UPDATED: 'agent.updated',
  AGENT_DELETED: 'agent.deleted',
  AGENT_TRUST_CHANGED: 'agent.trust_changed',
  AGENT_MODEL_ASSIGNED: 'agent.model_assigned',
  AGENT_RUN_STARTED: 'agent.run_started',
  AGENT_RUN_COMPLETED: 'agent.run_completed',
  AGENT_RUN_FAILED: 'agent.run_failed',
  AGENT_RUN_BLOCKED: 'agent.run_blocked',
  AGENT_RUN_CANCELLED: 'agent.run_cancelled',
  AGENT_RUN_BUDGET_HIT: 'agent.run_budget_hit',
  AGENT_RUN_DEADLINE_HIT: 'agent.run_deadline_hit',
  PREVIEW_BUILD_STARTED: 'preview.build_started',
  PREVIEW_BUILD_SUCCEEDED: 'preview.build_succeeded',
  PREVIEW_BUILD_FAILED: 'preview.build_failed',
  PREVIEW_OPENED: 'preview.opened',
  DEBATE_CREATED: 'agent.debate_created',
  DEBATE_COMPLETED: 'agent.debate_completed',
  DEBATE_FAILED: 'agent.debate_failed',
  DEBATE_CANCELLED: 'agent.debate_cancelled',
  DEBATE_APPROVED: 'agent.debate_approved',
  DEBATE_REJECTED: 'agent.debate_rejected',
  MARKETPLACE_INSTALLED: 'marketplace.installed',
  MARKETPLACE_UNINSTALLED: 'marketplace.uninstalled',
  MARKETPLACE_DISABLED: 'marketplace.disabled',
  MARKETPLACE_ENABLED: 'marketplace.enabled',
  MARKETPLACE_UPDATED: 'marketplace.updated',
  DECISION_RECORDED: 'decision.recorded',
  DECISION_REPLAYED: 'decision.replayed',
  DECISION_CONFLICT_RESOLVED: 'decision.conflict_resolved',
  CROSS_PROJECT_SUGGESTED: 'memory.cross_project_suggested',
  CROSS_PROJECT_OPT_IN_CHANGED: 'memory.cross_project_opt_in_changed',
  HANDOFF_SAVED: 'handoff.saved',
  HANDOFF_EXPORTED: 'handoff.exported',
  SCHEDULE_CREATED: 'schedule.created',
  SCHEDULE_UPDATED: 'schedule.updated',
  SCHEDULE_PAUSED: 'schedule.paused',
  SCHEDULE_RESUMED: 'schedule.resumed',
  SCHEDULE_DELETED: 'schedule.deleted',
  SCHEDULE_EXECUTED: 'schedule.executed',
  SCHEDULE_MISSED: 'schedule.missed',
  SCHEDULE_RECOVERED: 'schedule.recovered',
  SCHEDULE_SKIPPED: 'schedule.skipped',
  SCHEDULE_RUN_NOW: 'schedule.run_now',
  GOAL_CREATED: 'goal.created',
  GOAL_UPDATED: 'goal.updated',
  GOAL_PLAN_GENERATED: 'goal.plan_generated',
  GOAL_STARTED: 'goal.started',
  GOAL_PAUSED: 'goal.paused',
  GOAL_RESUMED: 'goal.resumed',
  GOAL_COMPLETED: 'goal.completed',
  GOAL_FAILED: 'goal.failed',
  GOAL_BLOCKED: 'goal.blocked',
  GOAL_ESCALATED: 'goal.escalated',
  GOAL_ESCALATION_DECIDED: 'goal.escalation_decided',
  GOAL_CANCELLED: 'goal.cancelled',
  GOAL_MEMORY_FED: 'goal.memory_fed',
  AUTOMATION_CREATED: 'automation.created',
  AUTOMATION_UPDATED: 'automation.updated',
  AUTOMATION_DELETED: 'automation.deleted',
  AUTOMATION_ENABLED: 'automation.enabled',
  AUTOMATION_PAUSED: 'automation.paused',
  AUTOMATION_DISABLED: 'automation.disabled',
  AUTOMATION_RULE_RAN: 'automation.rule_ran',
  AUTOMATION_RULE_SKIPPED: 'automation.rule_skipped',
  AUTOMATION_RULE_FAILED: 'automation.rule_failed',
  AUTOMATION_LOOP_GUARD: 'automation.loop_guard',
  AUTOMATION_RUN_APPROVED: 'automation.run_approved',
  AUTOMATION_RUN_REJECTED: 'automation.run_rejected',
  AUTOMATION_ESCALATED: 'automation.escalated',
  AUTOMATION_ESCALATION_DECIDED: 'automation.escalation_decided',
  EVENT_RECEIVED: 'event.received',
  EVENT_REJECTED: 'event.rejected',
  EVENT_DEDUPLICATED: 'event.deduplicated',
  WORKFLOW_RECIPE_INSTANTIATED: 'workflow.recipe_instantiated',
  WORKFLOW_RECIPE_DELETED: 'workflow.recipe_deleted',
  WEBHOOK_VERIFIED: 'webhook.verified',
  WEBHOOK_SIGNATURE_INVALID: 'webhook.signature_invalid',
  WEBHOOK_SECRET_CREATED: 'webhook.secret_created',
  WEBHOOK_SECRET_DELETED: 'webhook.secret_deleted',
  TASK_PAUSED: 'task.paused',
  TASK_RESUMED: 'task.resumed',
  TASK_CHECKPOINTED: 'task.checkpointed',
  TASK_REWOUND: 'task.rewound',
  TASK_BRANCHED: 'task.branched',
  TASK_AUTOPSIED: 'task.autopsied',
  TASK_REMEDIATED: 'task.remediated',
  TASK_IRREVERSIBLE_ACTION: 'task.irreversible_action',
  TASK_PLAN_MODIFIED: 'task.plan_modified',
  PR_REVIEW_STARTED: 'pr_review.started',
  PR_REVIEW_ROLE_FAILED: 'pr_review.role_failed',
  PR_REVIEW_COMPLETED: 'pr_review.completed',
  FINDING_ACCEPTED: 'finding.accepted',
  FINDING_DISMISSED: 'finding.dismissed',
  UPGRADE_STARTED: 'upgrade.started',
  UPGRADE_STEP: 'upgrade.step',
  UPGRADE_ACCEPTED: 'upgrade.accepted',
  UPGRADE_ROLLED_BACK: 'upgrade.rolled_back',
  UPGRADE_FAILED: 'upgrade.failed',
  FLAKE_RECORDED: 'flake.recorded',
  FLAKE_INVESTIGATION_CREATED: 'flake.investigation_created',
  FLAKE_RESOLVED: 'flake.resolved',
  CI_FAILURE_RECORDED: 'ci.failure_recorded',
  CI_FIX_PROPOSED: 'ci.fix_proposed',
  CI_FIX_APPROVAL_REQUESTED: 'ci.fix_approval_requested',
  CI_FIX_APPROVED: 'ci.fix_approved',
  CI_FIX_REJECTED: 'ci.fix_rejected',
  CI_FIX_APPLIED: 'ci.fix_applied',
  CI_RETEST_RECORDED: 'ci.retest_recorded',
  CI_MERGE_REJECTED: 'ci.merge_rejected',
  PREVIEW_COMMENT_CREATED: 'preview.comment_created',
  PREVIEW_COMMENT_RESOLVED: 'preview.comment_resolved',
  PREVIEW_SNAPSHOT_CAPTURED: 'preview.snapshot_captured',
  PREVIEW_DIFF_VIEWED: 'preview.diff_viewed',
  PROOF_OF_WORK_GENERATED: 'proof_of_work.generated',
  PLUGIN_SANDBOX_RUN: 'plugin.sandbox_run',
  CONTROL_POLICY_UPSERTED: 'control.policy_upserted',
  CONTROL_POLICY_DELETED: 'control.policy_deleted',
  KILL_SWITCH_TOGGLED: 'control.kill_switch_toggled',
  UNDO_RECORDED: 'control.undo_recorded',
  UNDO_PERFORMED: 'control.undo_performed',
  SECRET_GUARD_SCANNED: 'secret_guard.scanned',
  SECRET_GUARD_FINDINGS: 'secret_guard.findings',
  USAGE_ROLLUP_GENERATED: 'usage.rollup_generated',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Append-only recovery events written to recovery_history (Stage 26E). */
export const RecoveryEventType = {
  PAUSED: 'PAUSED',
  RESUMED: 'RESUMED',
  CHECKPOINTED: 'CHECKPOINTED',
  MODIFIED: 'MODIFIED',
  REWOUND: 'REWOUND',
  BRANCHED: 'BRANCHED',
  AUTOPSIED: 'AUTOPSIED',
  REMEDIATED: 'REMEDIATED',
  IRREVERSIBLE_ACTION: 'IRREVERSIBLE_ACTION',
  RETRIED: 'RETRIED',
  RECOVERED: 'RECOVERED',
  DEAD_LETTERED: 'DEAD_LETTERED',
} as const;
export type RecoveryEventType = (typeof RecoveryEventType)[keyof typeof RecoveryEventType];

/** Root cause codes for failure autopsies. CAUSE_UNKNOWN = insufficient evidence. */
export const RootCauseCode = {
  CAUSE_UNKNOWN: 'CAUSE_UNKNOWN',
  DEPENDENCY_FAILURE: 'dependency_failure',
  PLUGIN_UNAVAILABLE: 'plugin_unavailable',
  BLOCKED_PERMISSION: 'blocked_permission',
  APPROVAL_REJECTED: 'approval_rejected',
  TASK_TIMEOUT: 'task_timeout',
  MAX_RETRIES_EXCEEDED: 'max_retries_exceeded',
  RESOURCE_EXHAUSTED: 'resource_exhausted',
  AUTH_FAILURE: 'auth_failure',
} as const;
export type RootCauseCode = (typeof RootCauseCode)[keyof typeof RootCauseCode];

/** Unified provider capability status (Phase 14 operations view + Stage 26 AI transparency).
 * Derived honestly from configuration + live probe history + classified failures —
 * never assumed. RATE_LIMITED / QUOTA_EXHAUSTED / OFFLINE / BLOCKED are added by
 * the Stage 26 AI gateway transparency layer. */
export const ProviderStatus = {
  AVAILABLE: 'AVAILABLE',
  LIMITED: 'LIMITED',
  CONFIGURED: 'CONFIGURED',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  REQUIRES_REAUTH: 'REQUIRES_REAUTH',
  DEGRADED: 'DEGRADED',
  FAILED: 'FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  OFFLINE: 'OFFLINE',
  BLOCKED: 'BLOCKED',
} as const;
export type ProviderStatus = (typeof ProviderStatus)[keyof typeof ProviderStatus];

export const Timeouts = {
  TASK_DEFAULT_MS: 10 * 60 * 1000,
  TASK_MAX_MS: 24 * 60 * 60 * 1000,
  TASK_HEARTBEAT_MS: 30 * 1000,
  APPROVAL_DEFAULT_TTL_MS: 24 * 60 * 60 * 1000,
  APPROVAL_HIGH_TTL_MS: 12 * 60 * 60 * 1000,
  COWORKER_RUN_DEFAULT_MS: 30 * 60 * 1000,
  PAYMENT_SESSION_TTL_DAYS: 7,
  PAIRING_CODE_TTL_MS: 10 * 60 * 1000,
  MAX_PAIRED_DEVICES: 3,
  MAX_TERMINAL_TABS: 8,
  TERMINAL_TIMEOUT_MIN_MS: 1000,
  TERMINAL_TIMEOUT_MAX_MS: 24 * 60 * 60 * 1000,
  AGENT_HEARTBEAT_INTERVAL_MS: 30 * 1000,
  AGENT_PRESENCE_STALE_MS: 90 * 1000,
  REMOTE_SESSION_TTL_MS: 8 * 60 * 60 * 1000,
  REMOTE_SCREENSHOT_AUTH_TTL_MS: 15 * 60 * 1000,
  APPROVAL_DEFAULT_EXPIRY_MS: 30 * 60 * 1000,
  APPROVAL_MAX_RESOURCES: 50,
} as const;

export const FreeLimits = {
  DAILY_MESSAGES: 20,
  MAX_PROJECTS: 1,
  STORAGE_GB: 2,
  MODEL_TIER: 'EFFICIENT',
} as const;

export const ProPlan = {
  PRICE_INR: 999,
  CURRENCY: 'INR',
  PAYMENT_LINK: 'https://rzp.io/rzp/sAgHIpxS',
  STORAGE_GB: 100,
} as const;

// ---------------------------------------------------------------- Phase 8: files + storage + search + artifacts

/**
 * File lifecycle (Phase 8). The source of truth is `files.deleted_at`:
 * ACTIVE = deleted_at IS NULL; TRASHED = deleted_at IS NOT NULL (30-day
 * recovery window); RESTORED = the transition back to ACTIVE.
 */
export const FileLifecycle = {
  ACTIVE: 'ACTIVE',
  TRASHED: 'TRASHED',
  RESTORED: 'RESTORED',
} as const;
export type FileLifecycle = (typeof FileLifecycle)[keyof typeof FileLifecycle];

/** Preview classification for a stored file (metadata only; never faked OCR). */
export const PreviewKind = {
  TEXT: 'TEXT',
  CODE: 'CODE',
  JSON: 'JSON',
  MARKDOWN: 'MARKDOWN',
  IMAGE: 'IMAGE',
  PDF: 'PDF',
  UNKNOWN: 'UNKNOWN',
} as const;
export type PreviewKind = (typeof PreviewKind)[keyof typeof PreviewKind];

export const PreviewStatus = {
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type PreviewStatus = (typeof PreviewStatus)[keyof typeof PreviewStatus];

/**
 * OCR status. No OCR provider/infrastructure exists in this environment, so
 * the only honest state is UNAVAILABLE — the file is preserved, never claimed
 * to be OCR'd.
 */
export const OcrStatus = {
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type OcrStatus = (typeof OcrStatus)[keyof typeof OcrStatus];

/**
 * Honest storage provider mode (Phase 8). R2 requires billing-activated
 * credentials that do not exist here, so R2_NOT_CONFIGURED is reported
 * instead of pretending R2 is active. S3_COMPATIBLE covers MinIO/S3. LOCAL
 * STORAGE covers the local disk adapter.
 */
export const StorageProviderStatus = {
  LOCAL_STORAGE: 'LOCAL_STORAGE',
  S3_COMPATIBLE: 'S3_COMPATIBLE',
  R2_NOT_CONFIGURED: 'R2_NOT_CONFIGURED',
} as const;
export type StorageProviderStatus = (typeof StorageProviderStatus)[keyof typeof StorageProviderStatus];

/** Entities covered by global search (Phase 8). */
export const SearchEntity = {
  FILE: 'file',
  PROJECT: 'project',
  CONVERSATION: 'conversation',
  MEMORY: 'memory',
  TASK: 'task',
  ARTIFACT: 'artifact',
  IDEA: 'idea',
} as const;
export type SearchEntity = (typeof SearchEntity)[keyof typeof SearchEntity];

/** File retention policy (Phase 8): trash is recoverable for 30 days. */
export const FileRetention = {
  TRASH_RETENTION_DAYS: 30,
} as const;

/** Artifact kinds for the Artifact Center (Phase 8). Screenshots only when real capture exists. */
export const ArtifactKind = {
  DIFF: 'diff',
  TEST_REPORT: 'test_report',
  LOG: 'log',
  RESEARCH: 'research',
  VERIFICATION_REPORT: 'verification_report',
  SCREENSHOT: 'screenshot',
  DEPLOYMENT_OUTPUT: 'deployment_output',
  FILE: 'file',
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

export const FileStorageKeys = {
  PROJECT: 'project',
  TAG: 'tag',
  CATEGORY: 'category',
} as const;

// ---------------------------------------------------------------- Phase 13: ideas + brainstorming + history + trash

/** Idea lifecycle statuses (Phase 13). */
export const IdeaStatus = {
  PROPOSED: 'PROPOSED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  IMPLEMENTED: 'IMPLEMENTED',
} as const;
export type IdeaStatus = (typeof IdeaStatus)[keyof typeof IdeaStatus];

/** Idea priority levels (Phase 13). */
export const IdeaPriority = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type IdeaPriority = (typeof IdeaPriority)[keyof typeof IdeaPriority];

/** Brainstorming session lifecycle (Phase 13). */
export const BrainstormSessionStatus = {
  ACTIVE: 'ACTIVE',
  COMPLETED: 'COMPLETED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type BrainstormSessionStatus = (typeof BrainstormSessionStatus)[keyof typeof BrainstormSessionStatus];

/** How brainstorm ideas are grouped when surfaced (Phase 13). */
export const BrainstormGrouping = {
  NONE: 'NONE',
  THEME: 'THEME',
  TOPIC: 'TOPIC',
} as const;
export type BrainstormGrouping = (typeof BrainstormGrouping)[keyof typeof BrainstormGrouping];

/** Participant roles inside a brainstorming session (Phase 13). */
export const BrainstormParticipantRole = {
  HOST: 'HOST',
  PARTICIPANT: 'PARTICIPANT',
} as const;
export type BrainstormParticipantRole =
  (typeof BrainstormParticipantRole)[keyof typeof BrainstormParticipantRole];

/** Cleanup recommendation lifecycle (Phase 13). */
export const CleanupRecommendationStatus = {
  ACTIVE: 'ACTIVE',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
} as const;
export type CleanupRecommendationStatus =
  (typeof CleanupRecommendationStatus)[keyof typeof CleanupRecommendationStatus];

/** Cleanup candidate classes the recommendation engine genuinely derives (Phase 13). */
export const CleanupCandidateType = {
  EXPIRED_TRASH: 'expired_trash',
  DUPLICATE_FILES: 'duplicate_files',
  OLD_ARTIFACTS: 'old_artifacts',
  STALE_VERSIONS: 'stale_versions',
  EXPIRED_NOTIFICATIONS: 'expired_notifications',
} as const;
export type CleanupCandidateType = (typeof CleanupCandidateType)[keyof typeof CleanupCandidateType];

/** Resource types the unified trash can recover or purge (Phase 13). */
export const TrashItemType = {
  FILE: 'file',
  PROJECT: 'project',
  CONVERSATION: 'conversation',
  MEMORY: 'memory',
  DNA: 'dna',
  IDEA: 'idea',
} as const;
export type TrashItemType = (typeof TrashItemType)[keyof typeof TrashItemType];

/** Sources aggregated by the unified History workspace (Phase 13). */
export const HistorySource = {
  AUDIT: 'audit',
  PROJECT_ACTIVITY: 'project_activity',
  FILE_ACTIVITY: 'file_activity',
  TEAM_ACTIVITY: 'team_activity',
} as const;
export type HistorySource = (typeof HistorySource)[keyof typeof HistorySource];

/** Activity feed scopes (Phase 13): home aggregates the caller's own world. */
export const ActivityScope = {
  HOME: 'home',
  PROJECT: 'project',
  TEAM: 'team',
} as const;
export type ActivityScope = (typeof ActivityScope)[keyof typeof ActivityScope];

/** Trash retention for recoverable items (Phase 13): 30 days, like files. */
export const IdeaRetention = {
  TRASH_RETENTION_DAYS: 30,
} as const;