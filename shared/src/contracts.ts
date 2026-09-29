/**
 * CodeConClave — API contracts (zod). Server validates with these;
 * client types derive from them.
 */
import { z } from 'zod';
import {
  AgentRole,
  ApprovalActionType,
  BrainstormGrouping,
  CleanupRecommendationStatus,
  CoworkerType,
  IdeaPriority,
  IdeaStatus,
  MemoryContradictionState,
  MemoryRelation,
  MemorySearchMode,
  MemorySource,
  MemoryType,
  MemoryVerificationState,
  PluginCategory,
  PluginHealthStatus,
  PluginIntegrationStatus,
  ProjectStatus,
  RiskLevel,
  TaskStatus,
  TerminalShell,
  TrashItemType,
  UsageKind,
  UsageUnit,
  PluginPermission,
  PluginType,
  Timeouts,
  MAX_PROJECT_TAGS,
  MAX_TAG_LENGTH,
} from './constants.js';

export const newId = (prefix: string): string => `${prefix}_${randomId()}`;

import { customAlphabet } from 'nanoid';
const randomId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 20);

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a digit');

// ---------------------------------------------------------------- auth

/**
 * Handle + keyword are the D1 primary credentials. `handle` is the public login
 * identifier; `keyword` is the secret phrase. Both are optional at the schema
 * level only so that an account can still be created by a legacy client and
 * enrol later via POST /api/v1/auth/identity/enroll — the service refuses a
 * half-pair (one without the other) and treats the unique handle index in
 * user_auth_identities as authoritative.
 *
 * These rules MUST stay identical to backend/src/modules/auth/identity-policy.ts
 * (validateHandle/validateKeyword). The backend is authoritative, but a client
 * that disagrees with it either blocks a legal handle or lets the user type a
 * value the server will reject — both are support tickets.
 *
 * Known deliberate asymmetry: the RESERVED_HANDLES list (admin, support,
 * codeconclave, …) lives only in the backend, because it is a product
 * inventory that changes. A reserved handle fails at submit time with
 * invalid_handle, not at field-blur time.
 */
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Handle must be at least 3 characters')
  .max(20, 'Handle must be at most 20 characters')
  .regex(/^[a-z0-9][a-z0-9_]*$/, 'Handle must use only a-z, 0-9 and _ and start with a letter or number')
  .refine((v) => !v.endsWith('_'), { message: 'Handle cannot end with an underscore' });

export const keywordSchema = z
  .string()
  .min(12, 'Keyword must be at least 12 characters')
  .max(128, 'Keyword must be at most 128 characters')
  .regex(/[a-z]/, 'Keyword must include a lowercase letter')
  .regex(/[A-Z]/, 'Keyword must include an uppercase letter')
  .regex(/[0-9]/, 'Keyword must include a digit');

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    handle: handleSchema.optional(),
    keyword: keywordSchema.optional(),
    displayName: z.string().trim().min(1).max(80).optional(),
    role: z.string().trim().max(40).optional(),
    primaryUseCase: z.string().trim().max(80).optional(),
  })
  .refine((v) => (v.handle === undefined) === (v.keyword === undefined), {
    message: 'handle and keyword must be provided together',
    path: ['handle'],
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

export const mfaVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'TOTP code must be 6 digits'),
  rememberDevice: z.boolean().optional(),
});

export const mfaSetupResponseSchema = z.object({
  secretOtpAuthUrl: z.string(),
  secretBase32: z.string(),
});

export const recoveryCodesResponseSchema = z.object({
  recoveryCodes: z.array(z.string().length(10)),
});

export const googleCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const otpRequestSchema = z.object({
  email: emailSchema,
});

export const otpVerifySchema = z.object({
  email: emailSchema,
  code: z.string().regex(/^\d{6}$/, 'Code must be 6 digits'),
});

// ---------------------------------------------------------------- projects

const projectTagsSchema = z
  .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_PROJECT_TAGS);

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  repoUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  deadline: z.string().datetime().optional().nullable(),
  tags: projectTagsSchema.optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  repoUrl: z.string().url().optional().nullable().or(z.literal('')),
  status: z.enum(Object.values(ProjectStatus) as [string, ...string[]]).optional(),
  deadline: z.string().datetime().optional().nullable(),
  favorite: z.boolean().optional(),
  tags: projectTagsSchema.optional(),
});

// ---------------------------------------------------------------- conversations

export const conversationUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
  favorite: z.boolean().optional(),
  tags: z
    .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
    .max(MAX_PROJECT_TAGS)
    .optional(),
});

export const messageEditSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
});

export const threadCreateSchema = z.object({
  parentMessageId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
});

export const mentionCreateSchema = z.object({
  userId: z.string().min(1),
});

// ---------------------------------------------------------------- workspace / preferences

export const workspaceUpdateSchema = z.object({
  value: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().positive().optional(),
});

/** Deterministic conflict reconciliation for a single workspace key (Phase 12). */
export const workspaceReconcileSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().positive().optional(),
});
export type WorkspaceReconcileInput = z.infer<typeof workspaceReconcileSchema>;

/** Bulk restore of a workspace snapshot (multi-device restore). */
export const workspaceRestoreEntrySchema = z.object({
  key: z.string().min(1).max(80),
  value: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().positive().optional(),
});
export const workspaceRestoreSchema = z.object({
  entries: z.array(workspaceRestoreEntrySchema).min(1).max(50),
});
export type WorkspaceRestoreInput = z.infer<typeof workspaceRestoreSchema>;

/** Return-to-work ("While You Were Away") configuration (Phase 12). */
export const returnToWorkConfigSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'off']).optional(),
  thresholdHours: z.number().int().min(1).max(24 * 7).optional(),
  projectScope: z.string().min(1).max(120).nullable().optional(),
});
export type ReturnToWorkConfigInput = z.infer<typeof returnToWorkConfigSchema>;

export const preferencesUpdateSchema = z.object({
  prefs: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------- notifications

export const quietHoursSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(80).optional(),
});

export const notificationPreferencesSchema = z.object({
  in_app: z.boolean().optional(),
  push: z.boolean().optional(),
  email: z.boolean().optional(),
  daily_digest: z.boolean().optional(),
  weekly_digest: z.boolean().optional(),
  dnd: z.boolean().optional(),
  quiet_hours: quietHoursSchema.optional(),
  timezone: z.string().max(80).optional(),
});

export const notificationListQuerySchema = z.object({
  unread: z.union([z.literal('1'), z.literal('true')]).optional(),
  type: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------- operations / provider status

export const providerCapabilitySchema = z.object({
  id: z.string().max(60),
  available: z.boolean(),
});

export const providerStatusEntrySchema = z.object({
  id: z.string().max(60),
  name: z.string().max(120),
  category: z.enum(['payments', 'email', 'auth', 'storage', 'ai', 'observability', 'integration']),
  status: z.enum([
    'AVAILABLE',
    'LIMITED',
    'NOT_CONFIGURED',
    'REQUIRES_REAUTH',
    'DEGRADED',
    'FAILED',
  ]),
  reason: z.string().max(300).nullable().optional(),
  capabilities: z.array(providerCapabilitySchema).optional(),
  lastCheckedAt: z.string().nullable().optional(),
  lastKnownState: z.string().max(60).nullable().optional(),
  connectionId: z.string().max(120).nullable().optional(),
});

export const providerStatusResponseSchema = z.object({
  providers: z.array(providerStatusEntrySchema),
  generatedAt: z.string(),
});

// ---------------------------------------------------------------- digests

export const digestDeliverySchema = z.object({
  id: z.string(),
  frequency: z.enum(['daily', 'weekly']),
  periodKey: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  summaryText: z.string(),
  aiGenerated: z.boolean(),
  deliveredAt: z.string(),
});

export const digestStatusSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'none']),
  timezone: z.string().nullable().optional(),
  dnd: z.boolean(),
  quietHours: quietHoursSchema.nullable().optional(),
  lastDelivery: digestDeliverySchema.nullable().optional(),
});

// ---------------------------------------------------------------- usage

export const recordUsageSchema = z.object({
  kind: z.enum(Object.values(UsageKind) as [string, ...string[]]),
  quantity: z.number().finite().positive(),
  measured: z.boolean().default(true),
  unit: z.enum(Object.values(UsageUnit) as [string, ...string[]]).default('count'),
  meta: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------- chat

export const chatMessageSchema = z.object({
  conversationId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  content: z.string().trim().min(1).max(100_000),
  attachments: z
    .array(
      z.object({
        fileId: z.string().min(1),
        name: z.string().min(1),
      }),
    )
    .max(16)
    .optional(),
  modelId: z.string().min(1).optional(),
  mode: z.enum(['CHAT', 'COWORK', 'AGENT']).default('CHAT'),
  /**
   * IMAGE_GENERATION request: route the prompt through the canonical
   * gateway image op and persist the produced image onto the assistant
   * message (see ChatStreamEvents.onImage). NEVER selected silently — the
   * composer's Image mode sets this explicitly.
   */
  imageRequest: z.boolean().optional(),
  // PKG-10 Voice: optional response-tone preference honored via the system prompt
  // (additive; only applied when provided; not a separate response engine).
  tone: z.enum(['NEUTRAL', 'CONCISE', 'DETAILED', 'FRIENDLY']).default('NEUTRAL'),
  /**
   * Continuity: client-generated idempotency key for the USER message. A
   * retried send with the same (conversationId, clientId) returns the SAME
   * persisted message instead of inserting a duplicate — exactly-once chat
   * across flaky networks / reconnect / offline retry.
   */
  clientId: z.string().min(1).max(128).optional(),
});

// ---------------------------------------------------------------- continuity sync

/** One pending local USER message replayed to the server for reconciliation. */
export const syncMessageSchema = z.object({
  clientId: z.string().min(1).max(128),
  content: z.string().trim().min(1).max(100_000),
});

/**
 * Conversation sync (server-authoritative reconciliation). `pending` pushes
 * client-composed USER messages exactly once (deduped by clientId); `afterSeq`
 * pulls every server message with seq > afterSeq (deleted ids reported as
 * tombstones) so the local cache can merge without a full re-download.
 */
export const conversationSyncSchema = z.object({
  afterSeq: z.number().int().min(0).max(9_000_000_000).optional(),
  pending: z.array(syncMessageSchema).max(50).optional(),
});

// ---------------------------------------------------------------- decisions

export const DECISION_STATUSES = ['ACTIVE', 'TENTATIVE', 'SUPERSEDED', 'REJECTED', 'ARCHIVED'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Manual lifecycle change (the extractor never sets these itself; REPLACE
 *  flows manage SUPERSEDED; this route cannot resurrect one). */
export const decisionStatusSchema = z.object({
  status: z.enum(DECISION_STATUSES).refine((s) => s !== 'SUPERSEDED', {
    message: 'Use a replacement decision to supersede',
  }),
});

// ---------------------------------------------------------------- tasks

export const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).optional(),
  executionMode: z.enum(['CLOUD', 'LOCAL', 'HYBRID']).default('CLOUD'),
  coworkerPipeline: z
    .array(z.enum(Object.values(CoworkerType) as [string, ...string[]]))
    .max(9)
    .optional(),
  requestedRiskLevel: z.enum(Object.values(RiskLevel) as [string, ...string[]]).optional(),
  startWhenApproved: z.boolean().default(true),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------- memory / dna

export const createMemorySchema = z.object({
  projectId: z.string().min(1).optional(),
  type: z.enum(Object.values(MemoryType) as [string, ...string[]]),
  source: z.enum(Object.values(MemorySource) as [string, ...string[]]).default('USER_STATED'),
  content: z.string().trim().min(1).max(20_000),
  confidence: z.number().min(0).max(1).optional(),
});

export const saveDnaSchema = z.object({
  projectId: z.string().min(1),
  kind: z.string().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(50_000),
  scope: z.enum(['MAIN', 'BRANCH']).default('MAIN'),
  auto: z.boolean().default(false),
});

export const restoreDnaSchema = z.object({
  projectId: z.string().min(1),
  dnaId: z.string().min(1),
});

// ---------------------------------------------------------------- memory search / correction / relationships

export const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(Object.values(MemorySearchMode) as [string, ...string[]]).default('HYBRID'),
  projectId: z.string().min(1).optional(),
  searchAll: z.boolean().default(false),
  type: z.enum(Object.values(MemoryType) as [string, ...string[]]).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  verification: z.enum(Object.values(MemoryVerificationState) as [string, ...string[]]).optional(),
  contradiction: z.enum(Object.values(MemoryContradictionState) as [string, ...string[]]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const memoryCorrectionSchema = z.object({
  memoryId: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
});

export const memoryMergeSchema = z.object({
  targetId: z.string().min(1),
  intoId: z.string().min(1),
  note: z.string().max(2000).optional(),
});

export const memoryRelationshipSchema = z.object({
  sourceMemoryId: z.string().min(1),
  targetMemoryId: z.string().min(1),
  relation: z.enum(Object.values(MemoryRelation) as [string, ...string[]]).default('supports'),
  weight: z.number().min(0).max(1).default(0.5),
});

export const teamDnaSchema = z.object({
  teamId: z.string().min(1),
  kind: z.string().min(1).max(60),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(50_000),
  scope: z.enum(['MAIN', 'BRANCH']).default('MAIN'),
});

// ---------------------------------------------------------------- files

export const requestFileChangeSchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1).max(2000),
  content: z.string().max(5_000_000),
  operation: z.enum(['WRITE', 'CREATE']),
  reason: z.string().max(2000).optional(),
});

export const requestFileDeleteSchema = z.object({
  projectId: z.string().min(1),
  path: z.string().min(1).max(2000),
  reason: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------- payments

export const createPaymentSessionSchema = z.object({
  planId: z.literal('pro'),
});

// ---------------------------------------------------------------- local agent / terminal / remote

export const pairingCodeSchema = z
  .string()
  .regex(/^\d{6}$/, 'Pairing code must be 6 digits');

export const terminalCreateSchema = z.object({
  deviceId: z.string().min(1),
  shell: z.enum(Object.values(TerminalShell) as [string, ...string[]]).default('bash'),
  cwd: z.string().max(2000).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(Timeouts.TERMINAL_TIMEOUT_MIN_MS)
    .max(Timeouts.TERMINAL_TIMEOUT_MAX_MS)
    .optional(),
});

export const terminalInputSchema = z.object({
  input: z.string().trim().min(1).max(100_000),
});

export const terminalListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const terminalSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const remoteSessionCreateSchema = z.object({
  deviceId: z.string().min(1),
});

// ---------------------------------------------------------------- phase 4c — approval center

/** One resource affected by a proposed action (file path, device, URL, command target…). */
export const approvalResourceSchema = z.object({
  type: z.string().min(1).max(40),
  ref: z.string().min(1).max(2000),
  detail: z.string().max(2000).optional(),
});
export type ApprovalResource = z.infer<typeof approvalResourceSchema>;

export const approvalProposeSchema = z.object({
  taskId: z.string().min(1).optional(),
  actionType: z.enum(Object.values(ApprovalActionType) as [string, ...string[]]),
  riskLevel: z.enum(Object.values(RiskLevel) as [string, ...string[]]).optional(),
  coworker: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  justification: z.string().trim().min(1).max(2000),
  affectedResources: z
    .array(approvalResourceSchema)
    .min(1)
    .max(Timeouts.APPROVAL_MAX_RESOURCES),
  proposedAction: z.record(z.string(), z.unknown()).default({}),
  expiresInMs: z.number().int().min(60_000).max(Timeouts.APPROVAL_DEFAULT_EXPIRY_MS).optional(),
});
export type ApprovalProposeInput = z.infer<typeof approvalProposeSchema>;

/** Human-gate execution: the exact tool call to run against an APPROVED approval. */
export const approvalExecuteSchema = z.object({
  tool: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).default({}),
  deviceId: z.string().min(1).optional(),
});
export type ApprovalExecuteInput = z.infer<typeof approvalExecuteSchema>;

// ---------------------------------------------------------------- phase 10 — plugins

/** Typed plugin action request. The action must exist on the adapter's typed schema. */
export const pluginActionSchema = z.object({
  connectionId: z.string().min(1).max(120),
  action: z.string().min(1).max(80),
  input: z.record(z.string(), z.unknown()).default({}),
  approvalId: z.string().min(1).max(120).optional(),
  justification: z.string().trim().min(1).max(2000).optional(),
  taskId: z.string().min(1).max(120).optional(),
  runId: z.string().min(1).max(120).optional(),
  recordAsMemory: z.boolean().optional(),
});
export type PluginActionInput = z.infer<typeof pluginActionSchema>;

/** Grant/revoke plugin permission scopes (server-authoritative, audited). */
export const pluginScopesUpdateSchema = z.object({
  scopes: z.array(z.enum(Object.values(PluginPermission) as [string, ...string[]])).max(10),
});
export type PluginScopesUpdateInput = z.infer<typeof pluginScopesUpdateSchema>;

/** Connect a plugin. `credential` is a one-time server-side value (never echoed). */
export const pluginConnectSchema = z.object({
  pluginType: z.enum(Object.values(PluginType) as [string, ...string[]]),
  name: z.string().trim().max(80).optional(),
  credential: z
    .object({
      kind: z.string().min(1).max(40),
      value: z.string().min(1).max(8000),
    })
    .optional(),
});
export type PluginConnectInput = z.infer<typeof pluginConnectSchema>;

// ---------------------------------------------------------------- stage 25.5 — agents + preview + plugin center

/** Create or update a multi-agent workspace agent. Model is validated server-side against the registry. */
export const agentUpsertSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(Object.values(AgentRole) as [string, ...string[]]),
  objective: z.string().trim().max(4000).optional(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  modelProvider: z.string().min(1).max(40).optional(),
  modelId: z.string().min(1).max(120).optional(),
  maxTasksPerRun: z.coerce.number().int().min(1).max(20).default(10),
  maxRetries: z.coerce.number().int().min(0).max(5).default(2),
});
export type AgentUpsertInput = z.infer<typeof agentUpsertSchema>;

/** Start a bounded agent run for an objective. */
export const agentRunStartSchema = z.object({
  projectId: z.string().min(1).max(120).optional(),
  objective: z.string().trim().min(1).max(4000),
  budgetUsd: z.coerce.number().min(0.01).max(50).default(5),
  deadlineHours: z.coerce.number().min(0.5).max(72).default(24),
});
export type AgentRunStartInput = z.infer<typeof agentRunStartSchema>;

export const previewBuildSchema = z.object({
  taskId: z.string().min(1).max(120).optional(),
});
export type PreviewBuildInput = z.infer<typeof previewBuildSchema>;

/** Marketplace search: instant fuzzy match over name/description/category/capability/provider. */
export const pluginSearchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.enum(Object.values(PluginCategory) as [string, ...string[]]).optional(),
  capability: z.string().trim().max(60).optional(),
  state: z.string().trim().max(40).optional(),
  status: z.enum(Object.values(PluginHealthStatus) as [string, ...string[]]).optional(),
  integration: z.enum(Object.values(PluginIntegrationStatus) as [string, ...string[]]).optional(),
  popular: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PluginSearchInput = z.infer<typeof pluginSearchSchema>;

// ---------------------------------------------------------------- misc

export const idParamsSchema = z.object({
  id: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ConversationUpdateInput = z.infer<typeof conversationUpdateSchema>;
export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateSchema>;
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;
export type RecordUsageInput = z.infer<typeof recordUsageSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;
export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type SaveDnaInput = z.infer<typeof saveDnaSchema>;
export type RequestFileChangeInput = z.infer<typeof requestFileChangeSchema>;
export type TerminalCreateInput = z.infer<typeof terminalCreateSchema>;
export type TerminalInputInput = z.infer<typeof terminalInputSchema>;
export type RemoteSessionCreateInput = z.infer<typeof remoteSessionCreateSchema>;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export type Pagination = z.infer<typeof paginationSchema>;

// ---------------------------------------------------------------- Phase 13: ideas + brainstorming + trash + history

const ideaTagsSchema = z
  .array(z.string().trim().min(1).max(MAX_TAG_LENGTH))
  .max(MAX_PROJECT_TAGS);

const ideaReferenceSchema = z.object({
  type: z.enum(['memory', 'dna']),
  id: z.string().min(1),
  label: z.string().max(200).optional(),
});

export const ideaCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  tags: ideaTagsSchema.optional(),
  category: z.string().trim().max(80).optional(),
  priority: z.enum(Object.values(IdeaPriority) as [string, ...string[]]).default('MEDIUM'),
  status: z.enum(Object.values(IdeaStatus) as [string, ...string[]]).optional(),
  projectId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  references: z.array(ideaReferenceSchema).max(20).optional(),
});
export type CreateIdeaInput = z.infer<typeof ideaCreateSchema>;

export const ideaUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  tags: ideaTagsSchema.optional(),
  category: z.string().trim().max(80).optional().nullable(),
  priority: z.enum(Object.values(IdeaPriority) as [string, ...string[]]).optional(),
  status: z.enum(Object.values(IdeaStatus) as [string, ...string[]]).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
});
export type UpdateIdeaInput = z.infer<typeof ideaUpdateSchema>;

export const ideaVoteSchema = z.object({
  on: z.boolean(),
});

export const ideaArchiveSchema = z.object({
  archived: z.boolean(),
});

export const ideaCommentCreateSchema = z.object({
  content: z.string().trim().min(1).max(2000),
  parentId: z.string().min(1).optional(),
});
export type CreateIdeaCommentInput = z.infer<typeof ideaCommentCreateSchema>;

export const brainstormCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  grouping: z.enum(Object.values(BrainstormGrouping) as [string, ...string[]]).default('NONE'),
});
export type CreateBrainstormInput = z.infer<typeof brainstormCreateSchema>;

export const brainstormParticipantAddSchema = z.object({
  userId: z.string().min(1),
});

export const brainstormCaptureSchema = z.object({
  proposal: z.string().trim().min(1).max(5000),
  grouping: z.string().trim().max(80).optional(),
});
export type BrainstormCaptureInput = z.infer<typeof brainstormCaptureSchema>;

export const brainstormGenerateSchema = z.object({
  topic: z.string().trim().min(1).max(500),
  count: z.number().int().min(1).max(8).default(4),
});
export type BrainstormGenerateInput = z.infer<typeof brainstormGenerateSchema>;

export const trashItemSchema = z.object({
  type: z.enum(Object.values(TrashItemType) as [string, ...string[]]),
  id: z.string().min(1),
});
export type TrashItemInput = z.infer<typeof trashItemSchema>;

export const trashBulkActionSchema = z.object({
  items: z.array(trashItemSchema).min(1).max(50),
});
export type TrashBulkActionInput = z.infer<typeof trashBulkActionSchema>;

export const cleanupResolveSchema = z.object({
  status: z.enum(['RESOLVED', 'DISMISSED']),
});
export type CleanupResolveInput = z.infer<typeof cleanupResolveSchema>;

export const historyListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  source: z.string().max(40).optional(),
  action: z.string().max(80).optional(),
  resourceType: z.string().max(80).optional(),
  projectId: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  starred: z.union([z.literal('1'), z.literal('true')]).optional(),
  sort: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type HistoryListQuery = z.infer<typeof historyListQuerySchema>;

export const activityListQuerySchema = z.object({
  scope: z.enum(['home', 'project', 'team']).default('home'),
  projectId: z.string().min(1).optional(),
  teamId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;