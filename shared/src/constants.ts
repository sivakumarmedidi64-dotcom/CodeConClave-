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
  QWEN: 'qwen',
  GEMMA: 'gemma',
  DEVIN: 'devin',
  OX_ALPHA: 'ox_alpha',
  MANUS: 'manus',
  Z_CODE_5_3: 'z_code_5_3',
  MUSE_SPARK: 'muse_spark',
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

/**
 * Canonical internal task-intent taxonomy (Model Routing 2026).
 * These are INTERNAL orchestration categories for model routing — they are
 * deliberately NOT exposed as cluttered UI options. They let the CodeConClave
 * router choose the right model/provider for a job instead of asking the user
 * to decide every time. The taxonomy is shared by Web, Desktop, AI Chat,
 * AI Coworkers, Autonomous Cowork, Coding Workspace, and background tasks.
 */
export const TaskType = {
  GENERAL_CHAT: 'GENERAL_CHAT',
  DEEP_REASONING: 'DEEP_REASONING',
  CODING: 'CODING',
  CODE_REVIEW: 'CODE_REVIEW',
  DEBUGGING: 'DEBUGGING',
  TEST_GENERATION: 'TEST_GENERATION',
  REFACTORING: 'REFACTORING',
  ARCHITECTURE: 'ARCHITECTURE',
  PLANNING: 'PLANNING',
  DOCUMENTATION: 'DOCUMENTATION',
  SUMMARIZATION: 'SUMMARIZATION',
  MEMORY_RECALL: 'MEMORY_RECALL',
  MEMORY_SYNTHESIS: 'MEMORY_SYNTHESIS',
  MULTIMODAL_ANALYSIS: 'MULTIMODAL_ANALYSIS',
  IMAGE_GENERATION: 'IMAGE_GENERATION',
  IMAGE_EDITING: 'IMAGE_EDITING',
  AUTONOMOUS_ENGINEERING: 'AUTONOMOUS_ENGINEERING',
  TOOL_USE: 'TOOL_USE',
  TERMINAL_EXECUTION: 'TERMINAL_EXECUTION',
  TASK_PLANNING: 'TASK_PLANNING',
  BACKGROUND_TASK: 'BACKGROUND_TASK',
  FAST_SIMPLE_QUERY: 'FAST_SIMPLE_QUERY',
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/**
 * Routing preference — a POLICY preference, not a separate AI system.
 * AUTO remains the recommended default; it uses the task-aware smart routing.
 * QUALITY/BALANCED/FAST/COST_SAVER are scoring knobs over the same router.
 */
export const RoutingPreference = {
  AUTO: 'AUTO',
  QUALITY: 'QUALITY',
  BALANCED: 'BALANCED',
  FAST: 'FAST',
  COST_SAVER: 'COST_SAVER',
} as const;
export type RoutingPreference = (typeof RoutingPreference)[keyof typeof RoutingPreference];

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
  STRIPE: 'stripe',
  TWILIO: 'twilio',
  PAGERDUTY: 'pagerduty',
  ASANA: 'asana',
  GITLAB: 'gitlab',
  HUBSPOT: 'hubspot',
  PIPEDRIVE: 'pipedrive',
  CLICKUP: 'clickup',
  MONDAY: 'monday',
  CODA: 'coda',
  TRELLO: 'trello',
  KLAVIYO: 'klaviyo',
  DATABRICKS: 'databricks',
  ZENDESK: 'zendesk',
  DATADOG: 'datadog',
  MAILGUN: 'mailgun',
  CONFLUENCE: 'confluence',
  SERVICENOW: 'servicenow',
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

export const BrowserCapability = {
  OPEN: 'browser.open',
  NAVIGATE: 'browser.navigate',
  READ: 'browser.read',
  INSPECT: 'browser.inspect',
  CLICK: 'browser.click',
  TYPE: 'browser.type',
  SUBMIT: 'browser.submit',
  DOWNLOAD: 'browser.download',
  UPLOAD: 'browser.upload',
} as const;
export type BrowserCapability = (typeof BrowserCapability)[keyof typeof BrowserCapability];

/** Every browser instruction action op the managed session can perform. */
export const BrowserActionOp = {
  OPEN: 'open',
  NAVIGATE: 'navigate',
  BACK: 'back',
  FORWARD: 'forward',
  RELOAD: 'reload',
  READ: 'read',
  INSPECT: 'inspect',
  SEARCH: 'search',
  EXTRACT: 'extract',
  SCROLL: 'scroll',
  CLICK: 'click',
  TYPE: 'type',
  SELECT: 'select',
  SUBMIT: 'submit',
  SCREENSHOT: 'screenshot',
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
} as const;
export type BrowserActionOp = (typeof BrowserActionOp)[keyof typeof BrowserActionOp];

/**
 * Desktop-control capabilities (P2). A deliberately minimal, safe surface:
 * enumerate/inspect windows, launch an explicitly allow-listed application,
 * and focus an already-open window. There is intentionally NO free-form
 * "run anything on the desktop" capability.
 */
export const DesktopCapability = {
  INSPECT: 'desktop.inspect',
  OPEN_APP: 'desktop.open_app',
  FOCUS_WINDOW: 'desktop.focus_window',
} as const;
export type DesktopCapability = (typeof DesktopCapability)[keyof typeof DesktopCapability];

/** Every desktop instruction action op the local agent can perform. */
export const DesktopActionOp = {
  LIST_WINDOWS: 'list_windows',
  OPEN_APP: 'open_app',
  FOCUS_WINDOW: 'focus_window',
} as const;
export type DesktopActionOp = (typeof DesktopActionOp)[keyof typeof DesktopActionOp];

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
  AUTH_OTP_REQUESTED: 'auth.otp_requested',
  AUTH_OTP_VERIFIED: 'auth.otp_verified',
  AUTH_OTP_FAILED: 'auth.otp_failed',
  // D1/D5 identity (handle + keyword) and optional security-key 2FA.
  AUTH_IDENTITY_ENROLLED: 'auth.identity_enrolled',
  AUTH_KEYWORD_CHANGED: 'auth.keyword_changed',
  AUTH_SECURITY_KEY_ENABLED: 'auth.security_key_enabled',
  AUTH_SECURITY_KEY_DISABLED: 'auth.security_key_disabled',
  AUTH_SECURITY_KEY_ROTATED: 'auth.security_key_rotated',
  AUTH_SECURITY_KEY_STOLEN: 'auth.security_key_reported_stolen',
  AUTH_RECOVERY_STARTED: 'auth.recovery_started',
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
  LOCAL_TASK_ASSIGNED: 'local.task_assigned',
  LOCAL_TASK_CLAIMED: 'local.task_claimed',
  LOCAL_TASK_HEARTBEAT: 'local.task_heartbeat',
  LOCAL_TASK_PROGRESS: 'local.task_progress',
  LOCAL_TASK_ARTIFACT: 'local.task_artifact',
  LOCAL_TASK_COMPLETED: 'local.task_completed',
  LOCAL_TASK_FAILED: 'local.task_failed',
  LOCAL_TASK_CANCELLED: 'local.task_cancelled',
  LOCAL_TASK_EXPIRED: 'local.task_expired',
  LOCAL_TASK_RECOVERED: 'local.task_recovered',
  BROWSER_PERMISSION_REQUESTED: 'browser.permission_requested',
  BROWSER_PERMISSION_GRANTED: 'browser.permission_granted',
  BROWSER_PERMISSION_DENIED: 'browser.permission_denied',
  BROWSER_PERMISSION_REVOKED: 'browser.permission_revoked',
  BROWSER_SESSION_STARTED: 'browser.session_started',
  BROWSER_SESSION_DISCONNECTED: 'browser.session_disconnected',
  BROWSER_ACTION_REQUESTED: 'browser.action_requested',
  BROWSER_ACTION_STARTED: 'browser.action_started',
  BROWSER_ACTION_SUCCEEDED: 'browser.action_succeeded',
  BROWSER_ACTION_FAILED: 'browser.action_failed',
  BROWSER_ACTION_CANCELLED: 'browser.action_cancelled',
  BROWSER_EVIDENCE_CAPTURED: 'browser.evidence_captured',
  DESKTOP_ACTION_REQUESTED: 'desktop.action_requested',
  DESKTOP_ACTION_STARTED: 'desktop.action_started',
  DESKTOP_ACTION_SUCCEEDED: 'desktop.action_succeeded',
  DESKTOP_ACTION_FAILED: 'desktop.action_failed',
  DESKTOP_ACTION_CANCELLED: 'desktop.action_cancelled',
  UNIFIED_ACTION_ROUTED: 'action.routed',
  UNIFIED_ACTION_STOP_ALL: 'action.stop_all',
  LOCAL_FILE_READ: 'local.file_read',
  LOCAL_FILE_WRITTEN: 'local.file_written',
  LOCAL_COMMAND_EXECUTED: 'local.command_executed',
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
  API_SECURITY_SCAN_COMPLETED: 'api_security_scan.completed',
  SECRET_ROTATED: 'secret.rotated',
  SECRET_POLICY_UPDATED: 'secret.policy_updated',
  SECURITY_SCAN_COMPLETED: 'security_scan.completed',
  SECURITY_POSTURE_ASSESSED: 'security_posture.assessed',
  SUPPLY_CHAIN_SCAN_COMPLETED: 'supply_chain_scan.completed',
  // ---- B1 cowork safety review loop ----
  COWORK_REVIEW_CREATED: 'cowork_review.created',
  COWORK_REVIEW_HUNK_ACCEPTED: 'cowork_review.hunk_accepted',
  COWORK_REVIEW_HUNK_REJECTED: 'cowork_review.hunk_rejected',
  COWORK_REVIEW_ACCEPTS_ALL: 'cowork_review.accepts_all',
  COWORK_REVIEW_REJECTS_ALL: 'cowork_review.rejects_all',
  COWORK_REVIEW_APPLIED: 'cowork_review.applied',
  COWORK_REVIEW_APPLY_FAILED: 'cowork_review.apply_failed',
  COWORK_REVIEW_STALE: 'cowork_review.stale',
  COWORK_REVIEW_TEST_STARTED: 'cowork_review.test_started',
  COWORK_REVIEW_TEST_PASSED: 'cowork_review.test_passed',
  COWORK_REVIEW_TEST_FAILED: 'cowork_review.test_failed',
  COWORK_REVIEW_UNDO_REQUESTED: 'cowork_review.undo_requested',
  COWORK_REVIEW_UNDO_APPLIED: 'cowork_review.undo_applied',
  COWORK_REVIEW_UNDO_REFUSED: 'cowork_review.undo_refused',
  COWORK_REVIEW_UNDO_FAILED: 'cowork_review.undo_failed',
  COWORK_REVIEW_COMMITTED: 'cowork_review.committed',
  COWORK_REVIEW_CANCELLED: 'cowork_review.cancelled',
  COWORK_REVIEW_FAILED: 'cowork_review.failed',
  // ---- Stage 79: Superpowers (Proof-of-Run, Echo Memory, Warden, Spec Linter, Checkpoints) ----
  PROOF_CLAIM_REGISTERED: 'proof_claim.registered',
  PROOF_EVIDENCE_ATTACHED: 'proof_claim.evidence_attached',
  PROOF_CLAIM_VERDICT_ANNOTATED: 'proof_claim.verdict_annotated',
  ECHO_LESSON_RECORDED: 'echo.lesson_recorded',
  ECHO_LESSON_RETRIEVED: 'echo.lesson_retrieved',
  ECHO_LESSON_APPLIED: 'echo.lesson_applied',
  WARDEN_POLICY_CREATED: 'warden.policy_created',
  WARDEN_POLICY_UPDATED: 'warden.policy_updated',
  WARDEN_POLICY_DELETED: 'warden.policy_deleted',
  WARDEN_CHANGE_CHECKED: 'warden.change_checked',
  SPEC_ENTRY_CREATED: 'spec.entry_created',
  SPEC_CHECK_RUN: 'spec.check_run',
  CHECKPOINT_CREATED: 'checkpoint.created',
  CHECKPOINT_FORKED: 'checkpoint.forked',
  CHECKPOINT_RESTORED: 'checkpoint.restored',
  AGENT_EVENT_APPENDED: 'agent_event.appended',
  AGENT_DIFF_COMMENTED: 'agent_diff.commented',
  FIX_TICKET_CREATED: 'fix_ticket.created',
  FIX_TICKET_STARTED: 'fix_ticket.started',
  FIX_TICKET_PROPOSED: 'fix_ticket.proposed',
  FIX_TICKET_RESOLVED: 'fix_ticket.resolved',
  INTENT_DRAFT_GENERATED: 'intent_draft.generated',
  INTENT_DRAFT_APPLIED: 'intent_draft.applied',
  FRESH_EYES_REVIEWED: 'fresh_eyes.reviewed',
  FRESH_EYES_CLOSED: 'fresh_eyes.closed',
  REPLAY_SESSION_CREATED: 'replay_session.created',
  REPLAY_SESSION_FORKED: 'replay_session.forked',
  REPLAY_SESSION_ARCHIVED: 'replay_session.archived',
  RISK_SCORE_COMPUTED: 'risk_score.computed',
  RISK_SCORE_REMOVED: 'risk_score.removed',
  ANOMALY_SCAN_COMPLETED: 'anomaly_scan.completed',
  ANOMALY_SCAN_CLOSED: 'anomaly_scan.closed',
  STANDUP_REPORT_GENERATED: 'standup_report.generated',
  STANDUP_REPORT_PUBLISHED: 'standup_report.published',
  HEALTH_SIGNAL_REFRESHED: 'health_signal.refreshed',
  PERF_FINDING_CREATED: 'perf_finding.created',
  PERF_FINDING_FIXED: 'perf_finding.fixed',
  DECISION_RECONSIDERED: 'decision.reconsidered',
  PATTERN_LEARNED: 'pattern.learned',
  PATTERN_APPLIED: 'pattern.applied',
  PATTERN_ACCEPTED: 'pattern.accepted',
  PATTERN_DECLINED: 'pattern.declined',
  WHY_LINK_CREATED: 'why_link.created',
  WHY_LINK_DETACHED: 'why_link.detached',
  PACKAGE_EVALUATED: 'package.evaluated',
  PII_FOUND: 'pii.found',
  PII_REMEDIATED: 'pii.remediated',
  SECRET_INCIDENT: 'secret.incident',
  INJECTION_DETECTED: 'injection.detected',
  INJECTION_NEUTRALIZED: 'injection.neutralized',
  MEMORY_ARCHIVED: 'memory.archived',
  MEMORY_RETRIEVED: 'memory.retrieved',
  ONTOLOGY_TERM_REGISTERED: 'ontology.term_registered',
  ONTOLOGY_DIVERGENCE_SCANNED: 'ontology.divergence_scanned',
  ONTOLOGY_VIOLATION_RESOLVED: 'ontology.violation_resolved',
  ONTOLOGY_TERM_UNIFIED: 'ontology.term_unified',
  CODEBASE_ASKED: 'codebase.asked',
  ARCHAEOLOGY_RECORDED: 'memory.archaeology.recorded',
  ARCHAEOLOGY_DUG: 'memory.archaeology.dug',
  SKILL_SIGNAL_RECORDED: 'skill.signal_recorded',
  SKILL_REVIEW_ROUTED: 'skill.review_routed',
  RED_CELL_SCANNED: 'security.red_cell_scanned',
  RED_CELL_CONFIRMED: 'security.red_cell_finding_confirmed',
  RED_CELL_CLEARED: 'security.red_cell_finding_cleared',
  COVERAGE_SCANNED: 'quality.coverage_scan',
  HOLLOW_TEST_REJECTED: 'quality.hollow_test_rejected',
  DEPENDENCY_MONITORED: 'deps.monitored',
  DEP_UPGRADE_SURFACED: 'deps.upgrade_surfaced',
  DEP_UPGRADE_ROLLED_BACK: 'deps.upgrade_rolled_back',
  CONTRACT_PUBLISHED: 'contract.published',
  CONTRACT_VERIFIED: 'contract.verified',
  CONTRACT_BREAKING: 'contract.breaking',
  DEPENDENCY_ASSESSED: 'deps.cartography',
  ADVERSARIAL_RUN: 'quality.adversarial_run',
  MUTATION_SWEEP: 'quality.mutation_sweep',
  MUTATION_HOLLOW_REJECTED: 'quality.mutation_hollow_rejected',
  SHADOW_RUN: 'deploy.shadow_run',
  SHADOW_MISMATCH: 'deploy.shadow_mismatch',
  PRIVILEGE_FLAGGED: 'security.privilege_flagged',
  PRIVILEGE_SHRUNK: 'security.privilege_shrunk',
  SANDBOX_ENFORCED: 'security.sandbox_enforced',
  SANDBOX_BLOCKED: 'security.sandbox_blocked',
  SANDBOX_POLICY_REGISTERED: 'security.sandbox_policy_registered',
  // ---- Stage 88: Superpowers (Team & Organization Scale) ----
  BUS_FACTOR_SCANNED: 'team.bus_factor_scanned',
  BUS_FACTOR_ALARM_RAISED: 'team.bus_factor_alarm_raised',
  BUS_FACTOR_CLEARED: 'team.bus_factor_cleared',
  REVIEW_ROUTED: 'team.review_routed',
  PAIRING_SCHEDULED: 'team.pairing_scheduled',
  PAIRING_ACCEPTED: 'team.pairing_accepted',
  PAIRING_COMPLETED: 'team.pairing_completed',
  ONBOARDING_ROADMAP_GENERATED: 'team.onboarding_roadmap_generated',
  DECISION_PROPOSED: 'team.decision_proposed',
  DECISION_VOTE_CAST: 'team.decision_vote_cast',
  DECISION_DISSENT_LOGGED: 'team.decision_dissent_logged',
  DECISION_RESOLVED: 'team.decision_resolved',
  DECISION_CLOSED: 'team.decision_closed',
  // ---- Stage 89: Superpowers (Team & Organization Scale 2) ----
  KNOWLEDGE_EXPORT_GENERATED: 'team.knowledge_export_generated',
  REVIEW_LOAD_BALANCED: 'team.review_load_balanced',
  PERFORMANCE_DIGEST_GENERATED: 'team.performance_digest_generated',
  COST_ATTRIBUTED: 'team.cost_attributed',
  EQUITY_METRICS_COMPUTED: 'team.equity_metrics_computed',
  // ---- Stage 90: Superpowers (Autonomous Execution) ----
  AUTOPILOT_RUN_EXECUTED: 'autonomy.autopilot_run_executed',
  PHOENIX_RECOVERY_STEP: 'autonomy.phoenix_recovery_step',
  RELEASE_PLANNED: 'autonomy.release_planned',
  RELEASE_DEPLOYED: 'autonomy.release_deployed',
  RELEASE_ROLLED_BACK: 'autonomy.release_rolled_back',
  INCIDENT_AUTOPSY_DRAFTED: 'autonomy.incident_autopsy_drafted',
  CI_HEAL_PREEMPTED: 'autonomy.ci_heal_preempted',

  // ---- Stage 91: Superpowers (Swarm, Zero-Inbox, Night Shift, Release Commander, Firewall Drill) ----
  SWARM_LAUNCHED: 'autonomy.swarm_launched',
  SWARM_COMPLETED: 'autonomy.swarm_completed',
  INBOX_TRIAGED: 'autonomy.inbox_triaged',
  INBOX_DIGEST_CREATED: 'autonomy.inbox_digest_created',
  NIGHT_SHIFT_COMPLETED: 'autonomy.night_shift_completed',
  RELEASE_FEATURES_FROZEN: 'autonomy.release_features_frozen',
  RELEASE_BRANCH_CREATED: 'autonomy.release_branch_created',
  RELEASE_CHERRY_PICKED: 'autonomy.release_cherry_picked',
  RELEASE_HOTFIX_LANED: 'autonomy.release_hotfix_laned',
  RELEASE_ROLLBACK_DRILLED: 'autonomy.release_rollback_drilled',
  FIREWALL_DRILL_COMPLETED: 'autonomy.firewall_drill_completed',
  DIVERGENCE_HINT_RAISED: 'autonomy.divergence_hint_raised',
  DIVERGENCE_HINT_ACCEPTED: 'autonomy.divergence_hint_accepted',
  DIVERGENCE_HINT_DISMISSED: 'autonomy.divergence_hint_dismissed',
  MIRROR_WORLD_RUN: 'autonomy.mirror_world_run',
  TRIBUNAL_CONVENED: 'autonomy.tribunal_convened',
  TRIBUNAL_RESOLVED: 'autonomy.tribunal_resolved',
  TRIBUNAL_LESSON_LOGGED: 'autonomy.tribunal_lesson_logged',
  CAUSAL_TRACE_COMPLETED: 'autonomy.causal_trace_completed',
  CAUSAL_TRACE_RESOLVED: 'autonomy.causal_trace_resolved',
  GHOST_WRITTEN: 'autonomy.ghost_written',
  GHOST_BENCHMARKED: 'autonomy.ghost_benchmarked',
  GHOST_SHIPPED: 'autonomy.ghost_shipped',
  TIME_TRAVEL_RECONSTRUCTED: 'autonomy.time_travel_reconstructed',
  COURT_HELD: 'autonomy.court_held',
  COURT_RULED: 'autonomy.court_ruled',
  SILENCE_BREAK_DIAGNOSED: 'autonomy.silence_break_diagnosed',
  SILENCE_BREAK_RESOLVED: 'autonomy.silence_break_resolved',
  TRANSFER_EXPORTED: 'autonomy.transfer_exported',
  TRANSFER_PACKAGED: 'autonomy.transfer_packaged',
  CONTEXT_COMPRESSED: 'autonomy.context_compressed',
  CONCEPT_GAP_FOUND: 'autonomy.concept_gap_found',
  CONCEPT_UNIFICATION_STARTED: 'autonomy.concept_unification_started',
  CONCEPT_GAP_RESOLVED: 'autonomy.concept_gap_resolved',
  NEGOTIATION_DRAFTED: 'autonomy.negotiation_drafted',
  NEGOTIATION_RESOLVED: 'autonomy.negotiation_resolved',
  MEMORY_EXPORTED: 'autonomy.memory_exported',
  REGRESSION_TIMELINE_OPENED: 'autonomy.regression_timeline_opened',
  REGRESSION_ADDED: 'autonomy.regression_added',
  KNOWLEDGE_SEEDED: 'autonomy.knowledge_seeded',
  KNOWLEDGE_DIFFUSED: 'autonomy.knowledge_diffused',
  KNOWLEDGE_RETRIEVED: 'autonomy.knowledge_retrieved',
  FUSION_SCORED: 'autonomy.fusion_scored',
  DUCK_SESSION_STARTED: 'autonomy.duck_session_started',
  DUCK_SESSION_FOUND: 'autonomy.duck_session_found',
  CODE_TRANSLATED: 'autonomy.code_translated',
  FOCUS_SESSION_OPENED: 'autonomy.focus_session_opened',
  FOCUS_SESSION_SILENCED: 'autonomy.focus_session_silenced',
  FOCUS_SESSION_BREACHED: 'autonomy.focus_session_breached',
  FOCUS_SESSION_DIGESTED: 'autonomy.focus_session_digested',
  CLONE_REGISTERED: 'autonomy.clone_registered',
  CLONE_MATCHED: 'autonomy.clone_matched',
  CLONE_ABSTRACTION_PROPOSED: 'autonomy.clone_abstraction_proposed',
  ERROR_TRANSLATED: 'autonomy.error_translated',
  PAIR_HINT_GIVEN: 'autonomy.pair_hint_given',
  PAIR_HINT_ACKNOWLEDGED: 'autonomy.pair_hint_acknowledged',
  MEETING_EXTRACTED: 'autonomy.meeting_extracted',
  FOCUS_GUARD_STARTED: 'autonomy.focus_guard_started',
  FOCUS_QUESTION_HELD: 'autonomy.focus_question_held',
  FOCUS_QUESTION_BROKE_THROUGH: 'autonomy.focus_question_broke_through',
  FOCUS_GUARD_SURFACED: 'autonomy.focus_guard_surfaced',
  VOICE_TASK_QUEUED: 'autonomy.voice_task_queued',
  VOICE_TASK_STARTED: 'autonomy.voice_task_started',
  REQUIREMENT_XRAYED: 'autonomy.requirement_xrayed',
  SCOPE_OPENED: 'autonomy.scope_opened',
  SCOPE_CREEP_FLAGGED: 'autonomy.scope_creep_flagged',
  SCOPE_BOUNCE_SETTLED: 'autonomy.scope_bounce_settled',
  STORY_FORGED: 'autonomy.story_forged',
  IMPACT_REPORTED: 'autonomy.impact_reported',
  CHURN_EVENT_RECORDED: 'autonomy.churn_event_recorded',
  CHURN_FIX_DRAFTED: 'autonomy.churn_fix_drafted',
  ONBOARDING_SIM_STARTED: 'autonomy.onboarding_sim_started',
  ONBOARDING_SIM_COMPLETED: 'autonomy.onboarding_sim_completed',
  ZERO_TO_PROD_STARTED: 'autonomy.zero_to_prod_started',
  PROD_STAGE_APPROVED: 'autonomy.prod_stage_approved',
  ZERO_TO_PROD_SHIPPED: 'autonomy.zero_to_prod_shipped',
  POLICY_WRITTEN: 'autonomy.policy_written',
  POLICY_ACTIVATED: 'autonomy.policy_activated',
  POLICY_SUSPENDED: 'autonomy.policy_suspended',
  CHALLENGE_STARTED: 'autonomy.challenge_started',
  CHALLENGE_TRACK_REALIZED: 'autonomy.challenge_track_realized',
  CHALLENGE_DEFENSE_HELD: 'autonomy.challenge_defense_held',
  CHALLENGE_COMPLETED: 'autonomy.challenge_completed',
  CODEBASE_SHARE_CREATED: 'autonomy.codebase_share_created',
  CODEBASE_QUESTION_ANSWERED: 'autonomy.codebase_question_answered',
  CODEBASE_SHARE_EXPIRED: 'autonomy.codebase_share_expired',
  COST_BADGE_GENERATED: 'autonomy.cost_badge_generated',
  COST_THERMOMETER_READING: 'autonomy.cost_thermometer_reading',
  DRIFT_STATE_DIFFED: 'autonomy.drift_state_diffed',
  DRIFT_RECONCILED: 'autonomy.drift_reconciled',
  DRIFT_FIX_FILED: 'autonomy.drift_fix_filed',
  CAPACITY_FORECAST_ISSUED: 'autonomy.capacity_forecast_issued',
  ENV_CLONE_STARTED: 'autonomy.env_clone_started',
  ENV_CLONE_ANONYMIZED: 'autonomy.env_clone_anonymized',
  ENV_CLONE_READY: 'autonomy.env_clone_ready',
  RUNBOOK_EXECUTED: 'autonomy.runbook_executed',
  RUNBOOK_STEP_RUN: 'autonomy.runbook_step_run',
  RUNBOOK_ESCALATED: 'autonomy.runbook_escalated',
  RUNBOOK_RESOLVED: 'autonomy.runbook_resolved',
  BACKUP_CHECK_SCHEDULED: 'autonomy.backup_check_scheduled',
  BACKUP_CHECK_PERFORMED: 'autonomy.backup_check_performed',
  BACKUP_BROKEN: 'autonomy.backup_broken',
  BACKUP_VERIFIED: 'autonomy.backup_verified',
  SERVICE_CALL_RECORDED: 'autonomy.service_call_recorded',
  BLAST_RADIUS_COMPUTED: 'autonomy.blast_radius_computed',
  INFRA_PLAN_CREATED: 'autonomy.infra_plan_created',
  INFRA_PLAN_VALIDATED: 'autonomy.infra_plan_validated',
  INFRA_PLAN_APPLIED: 'autonomy.infra_plan_applied',
  REGRESSION_RADAR_LOGGED: 'autonomy.regression_radar_logged',
  REGRESSION_FIX_CONFIRMED: 'autonomy.regression_fix_confirmed',
  INCIDENT_ORCH_TRIGGERED: 'autonomy.incident_orch_triggered',
  INCIDENT_POSTMORTEM_DRAFTED: 'autonomy.incident_postmortem_drafted',
  INCIDENT_FIX_PROPOSED: 'autonomy.incident_fix_proposed',
  NETWORK_POLICY_CREATED: 'autonomy.network_policy_created',
  NETWORK_CALL_AUDITED: 'autonomy.network_call_audited',
  BRIDGE_PLANNED: 'autonomy.bridge_planned',
  BRIDGE_STEP_APPLIED: 'autonomy.bridge_step_applied',
  BRIDGE_VERIFIED: 'autonomy.bridge_verified',
  FERRY_PLANNED: 'autonomy.ferry_planned',
  FERRY_RUN_VERIFIED: 'autonomy.ferry_run_verified',
  SURGEON_CUT_PLANNED: 'autonomy.surgeon_cut_planned',
  SURGEON_SERVICE_EXTRACTED: 'autonomy.surgeon_service_extracted',
  DB_SURGEON_CYCLE_PLANNED: 'autonomy.db_surgeon_cycle_planned',
  DB_SURGEON_DUAL_WRITE_STARTED: 'autonomy.db_surgeon_dual_write_started',
  DB_SURGEON_CONTRACTED: 'autonomy.db_surgeon_contracted',
  TEST_CONVERT_PLANNED: 'autonomy.test_convert_planned',
  TEST_CONVERT_VERIFIED: 'autonomy.test_convert_verified',
  LEGACY_WRAPPER_CREATED: 'autonomy.legacy_wrapper_created',
  DEPENDENCY_BRIDGE_PLANNED: 'autonomy.dependency_bridge_planned',
  DEPENDENCY_BRIDGE_VERIFIED: 'autonomy.dependency_bridge_verified',
  PERF_MIGRATION_PLANNED: 'autonomy.perf_migration_planned',
  PERF_MIGRATION_REPORTED: 'autonomy.perf_migration_reported',
  SCHEMA_MIGRATION_CREATED: 'autonomy.schema_migration_created',
  SCHEMA_MIGRATION_ROLLED_BACK: 'autonomy.schema_migration_rolled_back',
  API_BRIDGE_CREATED: 'autonomy.api_bridge_created',
  API_VERSION_DEPRECATED: 'autonomy.api_version_deprecated',
  DATA_MIGRATION_SCHEDULED: 'autonomy.data_migration_scheduled',
  DATA_MIGRATION_VERIFIED: 'autonomy.data_migration_verified',
  CONFIG_MIGRATION_STARTED: 'autonomy.config_migration_started',
  CONFIG_MIGRATION_COMPLETED: 'autonomy.config_migration_completed',
  DESIGN_VIOLATION_FLAGGED: 'autonomy.design_violation_flagged',
  DESIGN_VIOLATION_FIXED: 'autonomy.design_violation_fixed',
  STATE_MATRIX_RUN_STARTED: 'autonomy.state_matrix_run_started',
  STATE_MATRIX_RUN_COMPLETED: 'autonomy.state_matrix_run_completed',
  PIXEL_DIFF_JUDGED: 'autonomy.pixel_diff_judged',
  MOTION_AUDITED: 'autonomy.motion_audited',
  MOTION_ISSUE_FLAGGED: 'autonomy.motion_issue_flagged',
  A11Y_NAVIGATED: 'autonomy.a11y_navigated',
  A11Y_ISSUE_FILED: 'autonomy.a11y_issue_filed',
  LOCALIZATION_SCAN_STARTED: 'autonomy.localization_scan_started',
  LOCALIZATION_ISSUE_FLAGGED: 'autonomy.localization_issue_flagged',
  DEAD_COMPONENT_FOUND: 'autonomy.dead_component_found',
  DEAD_COMPONENT_REMOVED: 'autonomy.dead_component_removed',
  RESPONSIVE_FORGE_GENERATED: 'autonomy.responsive_forge_generated',
  INTERACTION_SPEC_DEFINED: 'autonomy.interaction_spec_defined',
  FORM_BUILD_GENERATED: 'autonomy.form_build_generated',
  THEME_VIOLATION_FLAGGED: 'autonomy.theme_violation_flagged',
  THEME_VIOLATION_FIXED: 'autonomy.theme_violation_fixed',
  CATALOGUE_PARSED: 'autonomy.catalogue_parsed',
  CATALOGUE_PUBLISHED: 'autonomy.catalogue_published',
  QUERY_EXPLAINED: 'autonomy.query_explained',
  QUERY_REWRITTEN: 'autonomy.query_rewritten',
  DATA_DOCTOR_SCAN_RUN: 'autonomy.data_doctor_scan_run',
  DATA_ISSUE_FLAGGED: 'autonomy.data_issue_flagged',
  SCHEMA_SNAPSHOT_CAPTURED: 'autonomy.schema_snapshot_captured',
  SCHEMA_POINT_RESTORED: 'autonomy.schema_point_restored',
  PIPELINE_ANOMALY_DETECTED: 'autonomy.pipeline_anomaly_detected',
  PIPELINE_SLA_FLAGGED: 'autonomy.pipeline_sla_flagged',
  FEATURE_DRIFT_DETECTED: 'autonomy.feature_drift_detected',
  MODEL_RETRAIN_DRAFTED: 'autonomy.model_retrain_drafted',
  DENORMALIZATION_SUGGESTED: 'autonomy.denormalization_suggested',
  RELATIONSHIP_MAP_RENDERED: 'autonomy.relationship_map_rendered',
  ANOMALY_DETECTED: 'autonomy.anomaly_detected',
  ANOMALY_ALERTED: 'autonomy.anomaly_alerted',
  COMPLIANCE_VIOLATION_FLAGGED: 'autonomy.compliance_violation_flagged',
  QUERY_OPTIMIZED: 'autonomy.query_optimized',
  QUERY_EQUIVALENCE_PROVEN: 'autonomy.query_equivalence_proven',
  CONTRACT_BREACH_FLAGGED: 'autonomy.contract_breach_flagged',
  ORG_HEALTH_COMPUTED: 'autonomy.org_health_computed',
  RETENTION_SIGNAL_FLAGGED: 'autonomy.retention_signal_flagged',
  HIRING_EVALUATION_SCORED: 'autonomy.hiring_evaluation_scored',
  SPECULATION_LANE_OPENED: 'autonomy.speculation_lane_opened',
  SPECULATION_LANE_MEASURED: 'autonomy.speculation_lane_measured',
  TOOLCHAIN_LESSON_ADOPTED: 'autonomy.toolchain_lesson_adopted',
  ORG_SIMULATION_RUN: 'autonomy.org_simulation_run',
  PHYSICS_SIMULATION_RUN: 'autonomy.physics_simulation_run',
  DEBT_PRICED: 'autonomy.debt_priced',
  DEBT_FIX_SCHEDULED: 'autonomy.debt_fix_scheduled',
  AMBIENT_ANSWER_GIVEN: 'autonomy.ambient_answer_given',
  INTENT_PUBLISHED: 'autonomy.intent_published',
  INTENT_BID_SELECTED: 'autonomy.intent_bid_selected',
  HANDOFF_CONTINUED: 'autonomy.handoff_continued',
  SELF_PLAY_ISSUE_FOUND: 'autonomy.self_play_issue_found',
  NUTRITION_LABEL_GENERATED: 'autonomy.nutrition_label_generated',
  REPRODUCTION_ATTEMPTED: 'autonomy.reproduction_attempted',
  REPRODUCTION_CONFIRMED: 'autonomy.reproduction_confirmed',
  REFACTOR_PROPOSED: 'autonomy.refactor_proposed',
  REFACTOR_QUEUED: 'autonomy.refactor_queued',
  DOGFOOD_TASK_FILED: 'autonomy.dogfood_task_filed',
  DEMO_LINK_CREATED: 'autonomy.demo_link_created',
  DEMO_LINK_EXPIRED: 'autonomy.demo_link_expired',
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
  OTP_CODE_TTL_MS: 10 * 60 * 1000,
  OTP_RESEND_MIN_INTERVAL_MS: 60 * 1000,
  OTP_MAX_SENDS_PER_HOUR: 3,
  OTP_MAX_ATTEMPTS: 5,
  OTP_IP_MAX_PER_HOUR: 10,
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
 * STORAGE covers the local disk adapter. POSTGRES_PERSISTENT covers blobs in
 * the existing PostgreSQL database (durable, no new infrastructure).
 */
export const StorageProviderStatus = {
  LOCAL_STORAGE: 'LOCAL_STORAGE',
  S3_COMPATIBLE: 'S3_COMPATIBLE',
  R2_NOT_CONFIGURED: 'R2_NOT_CONFIGURED',
  POSTGRES_PERSISTENT: 'POSTGRES_PERSISTENT',
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

/** Onboarding "role" choices (minimal profile completeness). */
export const OnboardingRole = {
  DEVELOPER: 'Developer',
  FOUNDER: 'Founder',
  STUDENT: 'Student',
  DESIGNER: 'Designer',
  PRODUCT: 'Product',
  OTHER: 'Other',
} as const;
export type OnboardingRole = (typeof OnboardingRole)[keyof typeof OnboardingRole];
export const ONBOARDING_ROLES: readonly string[] = Object.values(OnboardingRole);

/** Onboarding "primary use case" choices (minimal profile completeness). */
export const OnboardingUseCase = {
  BUILD_SOFTWARE: 'Build software',
  DEBUG_CODE: 'Debug/code',
  AI_COWORK: 'AI cowork',
  AUTOMATION: 'Automation',
  RESEARCH: 'Research',
  LEARNING: 'Learning',
  OTHER: 'Other',
} as const;
export type OnboardingUseCase = (typeof OnboardingUseCase)[keyof typeof OnboardingUseCase];
export const ONBOARDING_USE_CASES: readonly string[] = Object.values(OnboardingUseCase);

/** Trash retention for recoverable items (Phase 13): 30 days, like files. */
export const IdeaRetention = {
  TRASH_RETENTION_DAYS: 30,
} as const;