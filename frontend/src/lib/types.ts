/**
 * CodeConClave — domain types mirrored from the backend API contract
 * (backend module route files + shared/contracts.ts).
 */

export type PlanId = 'free' | 'pro' | 'team' | 'api' | 'enterprise';
export type EntitlementState =
  | 'FREE'
  | 'PRO_PENDING'
  | 'PRO_VERIFIED'
  | 'PRO_EXPIRED'
  | 'PRO_REFUNDED'
  | 'REVOKED';

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  role?: string | null;
  primaryUseCase?: string | null;
  mfaEnabled: boolean;
  rbacRole: 'owner' | 'admin' | 'member' | 'viewer';
  planId: PlanId;
  entitlementState: EntitlementState;
}

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'COMPLETED' | 'ON_HOLD';
export type ProjectMemberRole = 'owner' | 'admin' | 'editor' | 'member' | 'viewer';

export interface Project {
  id: string;
  owner_id: string;
  team_id: string | null;
  name: string;
  description: string | null;
  repo_url: string | null;
  workspace_root: string | null;
  status: ProjectStatus;
  deadline: string | null;
  is_favorite: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProjectMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: ProjectMemberRole;
  addedAt: string;
}

export interface ProjectActivity {
  id: string;
  projectId: string;
  action: string;
  actorUserId: string | null;
  metadata: unknown | null;
  createdAt: string;
}

export type ConversationMode = 'CHAT' | 'COWORK' | 'AGENT';

/** Cowork share-links: modes + server response shape (backend sharing.ts). */
export type ShareMode = 'WATCH' | 'COMMENT' | 'CO_CONTROL';

export interface ShareLinkView {
  conversationId: string;
  token: string;
  mode: ShareMode;
  createdAt: number;
  expiresAt: number | null;
  oneTime: boolean;
  revokedAt?: number;
  redeemedBy?: string | null;
  redeemedAt?: number | null;
  url: string;
}

/** A file attached to the pending chat message (uploaded into the project). */
export interface PendingAttachment {
  fileId: string;
  name: string;
  sizeBytes?: number;
  uploading?: boolean;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  title: string;
  mode: ConversationMode;
  archived: boolean;
  favorite: boolean;
  tags: string[];
  sharing: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  sender: 'USER' | 'ASSISTANT' | 'COWORKER';
  coworkerType: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelId: string | null;
  providerId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  status: string;
  errorCode: string | null;
  editedAt: string | null;
  editCount: number;
  threadId: string | null;
  createdAt: string;
  imageFileId: string | null;
  imageMime: string | null;
}

export interface Thread {
  id: string;
  conversationId: string;
  parentMessageId: string;
  title: string;
  createdBy: string;
  deletedAt: string | null;
  createdAt: string;
}

export interface Mention {
  id: string;
  conversationId: string;
  messageId: string;
  conversationTitle?: string;
  createdAt: string;
}

export interface WorkspaceStateEntry {
  key: string;
  value: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

export type MemoryType =
  | 'EPISODIC'
  | 'SEMANTIC'
  | 'PROCEDURAL'
  | 'PROJECT'
  | 'TEAM';

export type MemorySource =
  | 'OBSERVED'
  | 'USER_STATED'
  | 'AI_INFERRED'
  | 'RECOMMENDATION';

export type Confidence = 'low' | 'medium' | 'high' | 'verified';

export interface Memory {
  id: string;
  projectId: string | null;
  type: MemoryType;
  source: MemorySource;
  content: string;
  confidence: Confidence;
  structured: unknown | null;
  flagged: boolean;
  provenance?: string | null;
  verificationState?: string | null;
  supersededById?: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export type DnaScope = 'MAIN' | 'BRANCH';
export type DnaKind =
  | 'DECISION'
  | 'UNRESOLVED_WORK'
  | 'NEXT_ACTIONS'
  | 'DISCOVERY'
  | 'BLOCKER'
  | 'PROJECT_CONTEXT'
  | 'RELEVANT_FILES'
  | 'ENVIRONMENT_STATE'
  | 'VERIFICATION_RESULT';

export interface DnaBlock {
  id: string;
  projectId: string;
  kind: DnaKind;
  title: string;
  content: string;
  scope: DnaScope;
  auto: boolean;
  branchOf: string | null;
  deletedAt: string | null;
  createdAt: string;
  version: number;
}

export interface DnaVersion {
  version: number;
  created: string;
  title: string;
  content: string;
}

export type PreviewKind = 'MARKDOWN' | 'CODE' | 'TEXT' | 'UNKNOWN';

/** File row as returned by the files API (snake_case, real DB shape). */
export interface FileRef {
  id: string;
  project_id: string;
  owner_id: string;
  path: string;
  size_bytes: number;
  sha256: string;
  storage_key: string | null;
  storage_provider: string | null;
  mime_type: string | null;
  is_directory: boolean;
  tags: string[];
  category: string | null;
  description: string | null;
  is_favorite: boolean;
  preview_kind: PreviewKind | null;
  preview_status: 'AVAILABLE' | 'UNAVAILABLE';
  ocr_status: string;
  encrypted: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Display name derived from the real path (files table stores paths only). */
export function displayNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'folder' | 'file';
  children?: FileTreeNode[];
  file?: FileRef;
}

export interface FileVersionInfo {
  id: string;
  file_id: string;
  version: number;
  sha256: string;
  size_bytes: number;
  reason: string;
  created_by: string | null;
  parent_version: number | null;
  rollback_reference: string | null;
  created_at: string;
}

export interface FileReference {
  id: string;
  ref_type: string;
  ref_id: string | null;
  created_at: string;
}

export interface FileActivityItem {
  id: string;
  action: string;
  file_id: string | null;
  actor_user_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export type SearchEntityType = 'file' | 'project' | 'conversation' | 'memory' | 'task' | 'artifact' | 'idea';

export interface SearchResult {
  entity: SearchEntityType;
  id: string;
  label: string;
  summary: string | null;
  projectId: string | null;
  createdAt: string | null;
  meta: Record<string, unknown>;
}

export interface ArtifactInfo {
  id: string;
  source: 'task' | 'coworker';
  taskId: string;
  taskTitle: string | null;
  runId: string | null;
  coworkerType: string | null;
  name: string;
  kind: string;
  verification: string | null;
  attemptId: string | null;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface DataCentreReport {
  provider: {
    mode: string;
    encryptionAtRest: boolean;
    healthy: boolean;
    lastHealthCheckAt: string | null;
  };
  quota: {
    plan: string;
    limitBytes: number;
    usedBytes: number;
    usedMb: number;
    limitMb: number;
    percent: number;
    overLimit: boolean;
  };
  storage: {
    fileCount: number;
    trashedCount: number;
    versionCount: number;
    folderCount: number;
    totalBytes: number;
    encryptionEnabled: boolean;
  };
  projectAllocation: Array<{ id: string; name: string; files: number; bytes: number }>;
  memories: { count: number };
  tasks: { count: number };
  artifacts: { count: number; bytes: number };
  activity: Array<{
    id: string;
    action: string;
    fileId: string | null;
    fileName: string | null;
    actorUserId: string | null;
    createdAt: string;
  }>;
  cleanupCandidates: Array<{
    id: string;
    path: string;
    sizeBytes: number;
    deletedAt: string;
    projectId: string;
  }>;
  retentionDays: number;
}

export type TaskStatus =
  | 'CREATED'
  | 'PLANNED'
  | 'WAITING_APPROVAL'
  | 'RUNNING'
  | 'TESTING'
  | 'VERIFIED'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'WAITING_FOR_LOCAL_AGENT'
  | 'REQUIRES_REVIEW';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  executionMode: 'CLOUD' | 'LOCAL' | 'HYBRID';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  coworkerPipeline: string[];
  conversationId: string | null;
  createdAt: string;
}

export interface ApprovalResource {
  type: string;
  ref: string;
  detail?: string;
}

export interface Approval {
  id: string;
  taskId: string | null;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'REVOKED' | 'EXECUTED' | 'CANCELLED';
  decision: 'APPROVE' | 'REJECT' | null;
  expiresAt: string;
  createdAt: string;
  taskTitle?: string;
  actionType?: string;
  coworker?: string | null;
  model?: string | null;
  justification?: string | null;
  affectedResources?: ApprovalResource[];
  proposedAction?: Record<string, unknown>;
  executionStatus?: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null;
  executionStartedAt?: string | null;
  executionCompletedAt?: string | null;
  executionResult?: Record<string, unknown> | null;
  auditReference?: string | null;
  batchGroup?: string | null;
}

/** Convert a raw snake_case approvals row into the camelCase Approval shape. */
export function mapApproval(row: Record<string, unknown>): Approval {
  return {
    id: String(row.id ?? ''),
    taskId: row.task_id ? String(row.task_id) : null,
    riskLevel: (row.risk_level as Approval['riskLevel']) ?? 'MEDIUM',
    status: (row.status as Approval['status']) ?? 'PENDING',
    decision: row.decision === 'APPROVE' || row.decision === 'REJECT' ? row.decision : null,
    expiresAt: String(row.expires_at ?? ''),
    createdAt: String(row.created_at ?? ''),
    actionType: row.action_type ? String(row.action_type) : undefined,
    coworker: row.coworker ? String(row.coworker) : null,
    model: row.model ? String(row.model) : null,
    justification: row.justification ? String(row.justification) : null,
    affectedResources: Array.isArray(row.affected_resources)
      ? (row.affected_resources as ApprovalResource[])
      : undefined,
    proposedAction: row.proposed_action ? (row.proposed_action as Record<string, unknown>) : undefined,
    executionStatus: row.execution_status ? (row.execution_status as Approval['executionStatus']) : null,
    executionStartedAt: row.execution_started_at ? String(row.execution_started_at) : null,
    executionCompletedAt: row.execution_completed_at ? String(row.execution_completed_at) : null,
    executionResult: row.execution_result ? (row.execution_result as Record<string, unknown>) : null,
    auditReference: row.audit_reference ? String(row.audit_reference) : null,
    batchGroup: row.batch_group ? String(row.batch_group) : null,
  };
}

export interface CoworkerType {
  type: string;
  name?: string;
  role: string;
  description: string;
  capabilities?: string[];
  constraints?: string[];
  modelPolicy?: { computeClass: 'A' | 'B' | 'C'; maxTokens: number };
  permissionScope?: string;
  taskLifecycle?: string;
  artifactSchema?: string[];
  failureBehavior?: string;
  memoryAccess?: string;
  auditBehavior?: string;
}

export interface CoworkerRun {
  id: string;
  taskId: string;
  coworkerType: string;
  state: string;
  input: string | null;
  output: string | null;
  handoffTo: string | null;
  error: string | null;
  createdAt: string;
}

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer' | 'guest';
export type TeamMemberStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type InvitationState = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface Team {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole | string;
  status: TeamMemberStatus | string;
  invited_by: string | null;
  joined_at: string;
  email: string;
  display_name: string | null;
}

export interface TeamInvitation {
  id: string;
  team_id: string;
  invited_by: string;
  invitee_user_id: string;
  invitee_email: string;
  role: string;
  state: InvitationState | string;
  expires_at: string;
  accepted_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface TeamActivityItem {
  id: string;
  team_id: string;
  actor_user_id: string;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  display_name: string | null;
}

export interface TeamStats {
  members: number;
  projects: number;
  pendingInvitations: number;
  activities: number;
}

export type PluginType =
  | 'github'
  | 'google'
  | 'resend'
  | 'slack'
  | 'teams'
  | 'discord'
  | 'notion'
  | 'linear'
  | 'jira'
  | 'figma'
  | 'sentry'
  | 'cloudflare'
  | 'supabase'
  | 'vercel'
  | 'render'
  | 'vscode'
  | 'webhook'
  | 'stripe'
  | 'twilio'
  | 'pagerduty'
  | 'asana'
  | 'gitlab'
  | 'hubspot'
  | 'pipedrive'
  | 'clickup'
  | 'monday'
  | 'coda'
  | 'trello'
  | 'klaviyo'
  | 'databricks'
  | 'zendesk'
  | 'webex'
  | 'onedrive'
  | 'sharepoint'
  | 'box'
  | 'dropbox'
  | 'egnyte'
  | 'outlook'
  | 'outlook_calendar'
  | 'confluence'
  | 'guru'
  | 'basecamp'
  | 'apollo'
  | 'outreach'
  | 'bitbucket'
  | 'snowflake'
  | 'bigquery'
  | 'powerbi'
  | 'amplitude'
  | 'hex'
  | 'workday'
  | 'servicenow'
  | 'canva'
  | 'ahrefs'
  | 'similarweb'
  | 'sap'
  | 'docusign'
  | 'quickbooks'
  | 'datadog'
  | 'mailgun'
  | 'zoom'
  | 'salesforce';

export type PluginIntegrationStatus = 'LIVE' | 'CONFIGURED' | 'NOT_CONFIGURED' | 'BLOCKED' | 'UNSUPPORTED';
export type PluginHealthStatus = 'HEALTHY' | 'DEGRADED' | 'REAUTH_REQUIRED' | 'UNAVAILABLE' | 'NOT_CONNECTED' | 'NOT_CONFIGURED';

export interface PluginCatalogueEntry {
  plugin_type: PluginType;
  name: string;
  description: string | null;
  capabilities: string[];
  enabled: boolean;
  category: string | null;
  popular: boolean;
  required_permissions: string[];
  state: string;
  status: PluginHealthStatus;
  adapterAvailable: boolean;
  serverConfigured: boolean;
  integration: PluginIntegrationStatus;
}

export interface PluginConnection {
  id: string;
  owner_id: string;
  plugin_type: PluginType;
  name: string;
  state: string;
  scopes: string[];
  credential_ref: string | null;
  last_health_check_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PluginScopeRow {
  id: string;
  connection_id: string;
  scope: string;
  granted_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface PluginEventRow {
  id: string;
  connection_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  state: string;
  created_at: string;
}

export interface HealthHistoryRow {
  checked_at: string;
  ok: boolean;
  latency_ms: number;
  consecutive_failures: number;
  last_error: string | null;
  detail: Record<string, unknown> | null;
}

export const PLUGIN_PERMISSIONS = ['read', 'write', 'send', 'publish', 'create', 'update', 'delete', 'admin'] as const;

export const PLUGIN_STATES = [
  'CONNECTED',
  'DEGRADED',
  'FAILED',
  'DISCONNECTED',
  'REAUTH_REQUIRED',
  'CONNECTING',
  'ERROR',
  'REVOKED',
] as const;

export interface EvidenceProviderStatus {
  enabled: boolean;
  reason: string | null;
}

export interface EvidenceProviders {
  link: EvidenceProviderStatus;
  api: EvidenceProviderStatus;
  webhook: EvidenceProviderStatus;
}

export interface PaymentCapability {
  api: boolean;
  webhook: boolean;
  link: boolean;
  mode: 'PAYMENT_LINK' | 'API' | 'WEBHOOK';
  unlockMode?: string;
  plans: Record<string, number>;
  evidence: EvidenceProviders;
  razorpayConfigured: boolean;
  razorpayMode: string | null;
  currency: string;
}

export interface PaymentIntent {
  id: string;
  planId: string;
  amountInr: number;
  currency: string;
  reference: string;
  paymentLink: string;
  status: string;
  purchaseType: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PaymentClaim {
  id: string;
  planId: string;
  purchaseType: string;
  amountInr: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  razorpayPaymentId: string;
  source: string;
  rejectionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  intentId: string;
  reference: string | null;
}

export interface PaymentSession {
  id: string;
  planId: PlanId;
  state: string;
  razorpayRef: string | null;
  amount: number;
  createdAt: string;
  mode?: 'PAYMENT_LINK' | 'API' | 'WEBHOOK';
}

export interface Entitlement {
  id: string;
  planId: PlanId;
  state: EntitlementState;
  activatedAt: string | null;
  expiresAt?: string | null;
  reason?: string | null;
  sessionId?: string | null;
}

export interface PaymentStatusPlan {
  planId: PlanId;
  intentStatus: string | null;
  confidence: number | null;
  entitlementState: string | null;
  activatedAt: string | null;
}

export interface PaymentStatusView {
  effectivePlan: string;
  accountEmail: string | null;
  plans: PaymentStatusPlan[];
}

export type WorkspaceReason = 'NO_ENTITLEMENT' | 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'API_ONLY';

/** Mirror of backend GET /api/v1/access — server-authoritative workspace gate. */
export interface WorkspaceAccess {
  unlocked: boolean;
  effectivePlan: 'free' | 'pro' | 'team';
  planId: string;
  entitlementState: string;
  reason: WorkspaceReason;
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  readAt: string | null;
  metadata: Record<string, unknown>;
  resourceType: string | null;
  resourceId: string | null;
  expiresAt: string | null;
  createdAt: string;
  deletedAt: string | null;
}

export interface QuietHours {
  start: string;
  end: string;
  timezone?: string;
}

export interface NotificationPreferences {
  in_app?: boolean;
  push?: boolean;
  email?: boolean;
  daily_digest?: boolean;
  weekly_digest?: boolean;
  dnd?: boolean;
  quiet_hours?: QuietHours;
  timezone?: string;
}

export interface UsageOverview {
  plan: PlanId;
  measured: {
    messagesToday: number;
    storageBytes: number;
    aiInputTokens: number;
    aiOutputTokens: number;
    tasksToday: number;
  };
  estimated: {
    computeCostUsd: number;
    sources: number;
  };
  limits: {
    dailyMessages: number;
    maxProjects: number;
    storageGb: number;
  };
  resetDate: string;
  rolling: {
    used: number;
    limit: number;
    windowHours: number;
    windowStart: string | null;
    resetsAt: string | null;
    remaining: number;
  };
}

export interface AuditEvent {
  id: string;
  action: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown | null;
  createdAt: string;
}

export interface UsageRow {
  today: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    calls: number;
  };
  plan: PlanId;
  premiumBudgetRemainingUsd: number | null;
  resetDate: string;
}

export type ModelTier = 'EFFICIENT' | 'CAPABLE' | 'PREMIUM';
export type ModelHealth = 'UNKNOWN' | 'UP' | 'HEALTHY' | 'DEGRADED' | 'DOWN';

export interface AiModel {
  id: string;
  providerId: string;
  label: string;
  description: string | null;
  tier: ModelTier;
  computeClass: 'A' | 'B' | 'C';
  health: ModelHealth;
  locked: boolean;
  available: boolean;
  /** MODEL = chat/completion; EXTERNAL_AGENT = out-of-band job lifecycle (e.g. Devin). */
  capabilityCategory?: 'MODEL' | 'EXTERNAL_AGENT';
  /** Client-side echo of the server class: normal / multimodal / image generator / external agent. */
  capabilityClass?: 'NORMAL_MODEL' | 'MULTIMODAL_MODEL' | 'IMAGE_GENERATOR' | 'EXTERNAL_AGENT';
  /** Explicit image-generation / image-editing capability (backend registry). */
  imageGeneration?: boolean;
  imageEditing?: boolean;
}

export interface WorkspaceFlags {
  [key: string]: unknown;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface UserApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  key?: string;
}

export interface ApiKeyAccess {
  planId: string;
  entitled: boolean;
  state: string | null;
}

export type DevicePresence = 'ONLINE' | 'STALE' | 'OFFLINE';

export interface DeviceInfo {
  id: string;
  name: string;
  state: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  capabilities: string[];
  presence: DevicePresence;
  remoteCapable: boolean;
}

export type TerminalState =
  | 'PLANNED'
  | 'STARTING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'KILLED'
  | 'TIMED_OUT';

export interface TerminalSessionInfo {
  id: string;
  deviceId: string;
  deviceName: string;
  shell: string;
  cwd: string | null;
  timeoutMs: number | null;
  status: TerminalState;
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string | null;
}

export interface TerminalHistoryLine {
  id: string;
  sessionId: string;
  channel: string;
  text: string;
  seq: number;
  createdAt: string;
}

export type RemoteSessionState = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface RemoteSessionInfo {
  id: string;
  deviceId: string;
  deviceName: string;
  state: RemoteSessionState;
  startedAt: string | null;
  expiresAt: string | null;
  lastActiveAt: string | null;
  screenshotAuthorized: boolean;
  screenshotAuthExpiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/* ---------------------------------------------------------------- phase 11 */

/** Server-authoritative context indicator (GET /api/v1/workspace/context). */
export interface WorkspaceContext {
  memoryLoaded: boolean;
  memoryCount: number;
  memorySourceRefs: number;
  dnaCount: number;
  dnaVersion: number;
  project: { projectId: string; projectName?: string } | null;
  relevantFiles: number;
}

/** Full task timeline (GET /api/v1/execution/tasks/:id). */
export interface TaskAttempt {
  id: string;
  task_id: string;
  attempt_number: number;
  started_at: string;
  finished_at: string | null;
  result: string | null;
  error_code: string | null;
  output_summary: string | null;
}

export interface TaskStep {
  id: string;
  task_id: string;
  attempt_id: string | null;
  kind: string;
  title: string;
  status: string;
  detail: Record<string, unknown> | null;
  output: string | null;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskToolCall {
  id: string;
  task_id: string;
  step_id: string | null;
  tool: string;
  input: Record<string, unknown> | null;
  decision: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
}

export interface TaskTimeline {
  task: Task | null;
  attempts: TaskAttempt[];
  steps: TaskStep[];
  toolCalls: TaskToolCall[];
  coworkerRuns: CoworkerRun[];
  artifacts: ArtifactInfo[];
  plan: { entries: { coworker: string; goal?: string | null }[] } | null;
  dependencies: unknown[];
  failureInfo: unknown | null;
  dlq: Record<string, unknown> | null;
}

/** DNA version comparison (GET /api/v1/dna/:id/compare). */
export interface DnaCompare {
  from: DnaVersion;
  to: DnaVersion;
  added: { title: string; content: string }[];
  removed: { title: string; content: string }[];
  changed: { title: string; before: string; after: string }[];
}

/* ---------------------------------------------------------------- phase 12 — continuity */

export type ReturnToWorkFrequency = 'daily' | 'weekly' | 'off';

export interface ReturnToWorkConfig {
  frequency: ReturnToWorkFrequency;
  thresholdHours: number;
  projectScope: string | null;
}

export interface RecommendedAction {
  type: string;
  label: string;
  target: string;
}

/** Evidence-based "While You Were Away" summary (GET /api/v1/workspace/return-to-work). */
export interface ReturnToWorkSummary {
  id: string;
  generatedAt: string;
  absenceStart: string;
  absenceEnd: string;
  projectScope: string | null;
  frequency: string;
  counts: {
    completed: number;
    failed: number;
    pendingApprovals: number;
    modifiedFiles: number;
    discoveries: number;
    memoryUpdates: number;
    dnaUpdates: number;
    projectActivity: number;
    unreadNotifications: number;
  };
  evidence: Record<string, unknown>;
  recommendedActions: RecommendedAction[];
  summaryText: string;
  aiGenerated: boolean;
  read: boolean;
  dismissed: boolean;
}

export interface ReturnToWorkResponse {
  summary: ReturnToWorkSummary | null;
  eligibility: { eligible: boolean; reason: string };
}

/* ---------------------------------------------------------------- phase 13 — ideas, history, trash, activity */

export type IdeaStatus =
  | 'PROPOSED'
  | 'IN_PROGRESS'
  | 'ACCEPTED'
  | 'PLANNED'
  | 'REJECTED'
  | 'DEFERRED'
  | 'DEPRECATED';

export type IdeaPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

export interface IdeaReference {
  type: 'memory' | 'dna';
  id: string;
  label?: string;
}

export interface Idea {
  id: string;
  ownerId: string;
  teamId: string | null;
  projectId: string | null;
  title: string;
  description: string | null;
  tags: string[];
  category: string | null;
  priority: IdeaPriority;
  status: IdeaStatus;
  assigneeId: string | null;
  archived: boolean;
  deletedAt: string | null;
  voteCount: number;
  commentCount: number;
  aiGenerated: boolean;
  provenance: string | null;
  references: IdeaReference[];
  createdAt: string;
  updatedAt: string;
}

export interface IdeaComment {
  id: string;
  ideaId: string;
  authorId: string;
  content: string;
  editedAt: string | null;
  createdAt: string;
}

export type BrainstormSessionStatus = 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
export type BrainstormGrouping = 'NONE' | 'THEME' | 'CUSTOM';
export type BrainstormParticipantRole = 'HOST' | 'PARTICIPANT';

export interface BrainstormSession {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  status: BrainstormSessionStatus;
  grouping: BrainstormGrouping;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrainstormParticipant {
  id: string;
  sessionId: string;
  userId: string;
  role: BrainstormParticipantRole;
  joinedAt: string;
}

export interface BrainstormIdea {
  id: string;
  sessionId: string;
  ideaId: string | null;
  createdBy: string;
  proposal: string;
  grouping: string | null;
  aiGenerated: boolean;
  createdAt: string;
}

export interface BrainstormSessionDetail {
  session: BrainstormSession;
  participants: BrainstormParticipant[];
  ideas: BrainstormIdea[];
}

export type HistorySource = 'audit' | 'project_activity' | 'file_activity' | 'team_activity';

export interface HistoryEvent {
  id: string;
  eventId: string;
  source: HistorySource;
  action: string;
  actorUserId: string | null;
  projectId: string | null;
  teamId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  starred: boolean;
}

export type TrashItemType = 'file' | 'project' | 'conversation' | 'memory' | 'dna' | 'idea';

export interface TrashItem {
  type: TrashItemType;
  id: string;
  name: string;
  deletedAt: string;
  expiresAt: string;
  deletedBy: string | null;
  projectId: string | null;
  projectName: string | null;
  teamId: string | null;
  teamName: string | null;
  sizeBytes: number | null;
}

export interface TrashBulkResult {
  type: TrashItemType;
  id: string;
  ok: boolean;
  errorCode?: string | null;
}

export type ActivityScope = 'home' | 'project' | 'team';

export interface ActivityEvent {
  id: string;
  source: string;
  action: string;
  actorUserId: string | null;
  projectId: string | null;
  teamId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  summary: string;
  createdAt: string;
}

export type CleanupCandidateType =
  | 'expired_files'
  | 'duplicate_files'
  | 'stale_conversations'
  | 'superseded_memories'
  | 'conflicted_dna'
  | 'stale_ideas'
  | 'expired_notifications'
  | 'obsolete_artifacts'
  | 'orphaned_versions';

export interface CleanupRecommendation {
  id: string;
  candidateType: CleanupCandidateType;
  reason: string;
  storageImpactBytes: number;
  affected: Array<{ id: string; name: string }>;
  reversible: boolean;
  authorizationLevel: string;
  status: 'ACTIVE' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
  resolvedAt: string | null;
}

/** Extended Data Centre report (Phase 13). */
export interface DataCentreReportV2 extends DataCentreReport {
  counts: {
    conversations: number;
    messages: number;
    memories: number;
    dna: number;
    dnaVersions: number;
    tasks: number;
    artifacts: number;
    projects: number;
    teams: number;
    notifications: number;
    auditEvents: number;
    ideas: number;
    brainstormSessions: number;
  };
  retention: {
    trashDays: number;
    ideaRetentionDays: number;
    notificationDays: number;
  };
  recommendations: CleanupRecommendation[];
  recommendationsByStatus: { active: number; resolved: number; dismissed: number };
  backup: { available: boolean; note: string };
}

/* ---------------------------------------------------------------- phase 14 — providers, digests, browser notifications */

export type ProviderStatus =
  | 'AVAILABLE'
  | 'LIMITED'
  | 'NOT_CONFIGURED'
  | 'REQUIRES_REAUTH'
  | 'DEGRADED'
  | 'FAILED';

export type ProviderCategory =
  | 'payments'
  | 'email'
  | 'auth'
  | 'storage'
  | 'ai'
  | 'observability'
  | 'integration';

export interface ProviderCapability {
  id: string;
  available: boolean;
}

/** One provider entry from GET /api/v1/operations/providers (server-derived, honest). */
export interface ProviderStatusEntry {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  reason?: string | null;
  capabilities?: ProviderCapability[];
  lastCheckedAt?: string | null;
  lastKnownState?: string | null;
  connectionId?: string | null;
}

export interface ProviderStatusReport {
  providers: ProviderStatusEntry[];
  generatedAt: string;
}

export type DigestFrequency = 'daily' | 'weekly';

/** One delivered digest (GET /api/v1/digests/latest). */
export interface DigestDelivery {
  id: string;
  frequency: DigestFrequency;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  evidence: Record<string, unknown>;
  summaryText: string;
  aiGenerated: boolean;
  deliveredAt: string;
}

/** Digest status for the current user (GET /api/v1/digests/status). */
export interface DigestStatus {
  frequency: DigestFrequency | 'none';
  timezone?: string | null;
  dnd: boolean;
  lastDelivery?: DigestDelivery | null;
}

/* ---------------------------------------------------------------- stage 25.5 — multi-agent workspace, live preview */

export type AgentRole =
  | 'ARCHITECT'
  | 'CODER'
  | 'DEBUGGER'
  | 'RESEARCHER'
  | 'REVIEWER'
  | 'TESTER'
  | 'SECURITY'
  | 'DEVOPS'
  | 'UI_UX'
  | 'DOCUMENTATION';

export type AgentRunState =
  | 'IDLE'
  | 'THINKING'
  | 'RUNNING'
  | 'WAITING_FOR_APPROVAL'
  | 'WAITING_FOR_DEPENDENCY'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED';

export interface AgentRoleEntry {
  role: AgentRole;
  label: string;
  description: string;
  computeClass: string;
  coding: boolean;
}

export interface Agent {
  id: string;
  owner_id: string;
  name: string;
  role: string;
  objective: string | null;
  capabilities: string[];
  model_provider: string | null;
  model_id: string | null;
  max_tasks_per_run: number;
  max_retries: number;
  status: string;
  current_run_id: string | null;
  trust_level?: string;
  effective_trust_level?: string;
  created_at: string;
  updated_at: string;
  run_status?: string | null;
  run_objective?: string | null;
  completed_tasks?: number;
  total_tasks?: number;
  failed_tasks?: number;
  spent_usd?: number;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  owner_id: string;
  project_id: string | null;
  status: AgentRunState;
  objective: string | null;
  current_task_id: string | null;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  retries_used: number;
  budget_usd: number;
  spent_usd: number;
  deadline_at: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface AgentRunTask {
  id: string;
  status: string;
  title: string;
  attempted: boolean;
}

export type PreviewState = 'BUILDING' | 'UPDATING' | 'READY' | 'ERROR' | 'OFFLINE' | 'NOT_CONFIGURED';

export interface PreviewSession {
  id: string;
  owner_id: string;
  project_id: string;
  state: PreviewState;
  build_log: string[];
  error: string | null;
  task_id: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

export interface PreviewEvent {
  state: PreviewState;
  version: number;
  taskId: string | null;
  error: string | null;
}

// ---------------------------------------------------------------- Stage 26G

export type KillSwitchScope = 'GLOBAL' | 'AGENTS' | 'TASKS' | 'SCHEDULES' | 'AUTONOMY';

export interface KillSwitchRow {
  id: string;
  owner_id: string;
  scope: KillSwitchScope;
  active: boolean;
  reason: string | null;
  created_at: string;
  updated_at: string;
  suspended: boolean;
}

export type PolicyScope = 'task' | 'plugin' | 'schedule' | 'automation' | 'agent' | 'global';
export type PolicyRequirement = 'require_approval' | 'block';

export interface ControlPolicyRow {
  id: string;
  owner_id: string;
  scope: PolicyScope;
  action: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  requirement: PolicyRequirement;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface UndoLogRow {
  id: string;
  owner_id: string;
  action_type: string;
  description: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'APPLIED' | 'FAILED';
  result: string | null;
  created_at: string;
  updated_at: string;
}

export interface SecretGuardFinding {
  kind: string;
  location: string;
  confidence: number;
  preview: string;
}

export interface SecretGuardScanRow {
  id: string;
  owner_id: string;
  target_type: string;
  target_ref: string | null;
  result: 'FINDINGS' | 'CLEAN';
  findings: SecretGuardFinding[] | string;
  scanned_at: string;
}

export interface UsageFeatureCost {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RoiRow extends UsageFeatureCost {
  tasksCompleted: number;
  valueUsd: number;
  roi: number;
}

export interface RoiEstimate {
  rows: RoiRow[];
  label: string;
}

export interface UsageRollupRow {
  id: string;
  owner_id: string;
  bucket: string;
  feature: string;
  task_id: string | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface TransparencyCall {
  providerId: string;
  modelId: string;
  agent: string | null;
  taskId: string | null;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  usedFallback: boolean;
  fallbackReason: string | null;
  outcome: string;
}

export interface HeatmapCell {
  date: string;
  changes: number;
}

export interface ProofOfWorkReport {
  taskId: string;
  projectId: string;
  request: { title: string; description: string | null };
  plan: { status: string; entries: Array<{ order: number; title: string; status: string }> } | null;
  files: Array<{ path: string; sizeBytes: number }>;
  tests: Array<{ step: string; output: string | null }>;
  evidence: {
    attempts: number;
    errors: Array<{ error_code: string | null; error_detail: string | null }>;
    artifacts: Array<{ kind: string; title: string }>;
  };
  preview: { state: string; version: number } | null;
  approvals: Array<{ status: string; risk_level: string; decision: string | null }>;
  time: { created_at: string; completed_at: string | null; durationMs: number | null };
  ai: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  cost: { totalUsd: number; aiUsd: number };
  generatedAt: string;
}

export interface ProofOfWorkRow {
  id: string;
  owner_id: string;
  task_id: string;
  project_id: string;
  report: ProofOfWorkReport;
  created_at: string;
  updated_at: string;
}

export interface SandboxRunRow {
  id: string;
  owner_id: string;
  plugin_type: string;
  action: string;
  status: 'SUCCESS' | 'FAILED' | 'UNKNOWN_ACTION';
  output: Record<string, unknown> | null;
  error: string | null;
  simulated: boolean;
  created_at: string;
}

export interface PreviewCommentRow {
  id: string;
  owner_id: string;
  project_id: string;
  preview_version: number;
  selector: string;
  comment: string;
  task_id: string | null;
  status: 'OPEN' | 'RESOLVED';
  created_at: string;
  updated_at: string;
}

export interface PreviewSnapshotRow {
  id: string;
  owner_id: string;
  project_id: string;
  version: number;
  state: string;
  build_log: string[] | null;
  created_at: string;
}

export interface VisualDiff {
  projectId: string;
  before: PreviewSnapshotRow | null;
  after: PreviewSnapshotRow | null;
  available: boolean;
}

// ---------------------------------------------------------------------------
// Stage 26I: agent debates + marketplace

export type DebateState =
  | 'PENDING'
  | 'IN_DEBATE'
  | 'JUDGING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'WAITING_FOR_APPROVAL'
  | 'APPROVED'
  | 'REJECTED';

export interface DebateProposalRow {
  id: string;
  debate_id: string;
  owner_id: string;
  agent_id: string;
  agent_name: string;
  role: string;
  model_id: string | null;
  provider_id: string | null;
  round: number;
  proposal: string | null;
  evidence: string | null;
  risks: string | null;
  tradeoffs: string | null;
  status: 'PROPOSED' | 'FAILED';
  error: string | null;
  cost_usd: number;
  duration_ms: number;
  created_at: string;
}

export interface DebateRow {
  id: string;
  owner_id: string;
  prompt: string;
  status: DebateState;
  proposer_agent_ids: string[];
  judge_agent_id: string;
  winner_agent_id: string | null;
  rationale: string | null;
  max_rounds: number;
  round_count: number;
  budget_usd: number;
  spent_usd: number;
  deadline_at: string;
  require_approval: boolean;
  run_id: string | null;
  user_decision: string | null;
  error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CataloguePackageRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  role: AgentRole;
  capabilities: string[];
  declared_permissions: string[];
  min_trust_level: number;
  min_plan: string;
  version: string;
  enabled: boolean;
}

export interface InstalledAgentPackageRow {
  id: string;
  owner_id: string;
  catalogue_id: string;
  catalogue_slug: string;
  agent_id: string;
  version: string;
  status: 'INSTALLED' | 'DISABLED' | 'REMOVED';
  agent: Pick<Agent, 'id' | 'name' | 'role' | 'status' | 'trust_level'> | null;
  package: Pick<
    CataloguePackageRow,
    'name' | 'description' | 'capabilities' | 'declared_permissions' | 'min_trust_level' | 'min_plan' | 'version'
  > | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Stage 26I: memory explorer (decisions / conflicts / continuity)

export type DecisionImpact = 'LOW' | 'MEDIUM' | 'HIGH';

export type DecisionStatus = 'ACTIVE' | 'TENTATIVE' | 'SUPERSEDED' | 'REJECTED' | 'ARCHIVED';

export type DecisionScope = 'PERSONAL' | 'PROJECT' | 'TEAM';

export interface DecisionRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  decision: string;
  context: string | null;
  alternatives: string[];
  rationale: string | null;
  consequences: string[];
  source_conversation_id: string | null;
  source_task_id: string | null;
  evidence_ref: string | null;
  impact: DecisionImpact;
  status: DecisionStatus;
  source_message_ids: string[];
  scope: DecisionScope;
  superseded_by_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionReplayResult {
  outcome: 'FOUND' | 'HISTORICAL_EVIDENCE_NOT_FOUND';
  decision?: DecisionRow;
}

export interface ConflictRow {
  id: string;
  owner_id: string;
  decision_id: string;
  request_text: string;
  status: 'OPEN' | 'RESOLVED';
  resolution: string | null;
  note: string | null;
  new_decision_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface DetectedConflict {
  conflictId: string;
  affectedDecision: DecisionRow;
  contradiction: string;
  consequence: string[];
}

export interface PatternRow {
  id: string;
  owner_id: string;
  source_project_id: string;
  name: string;
  pattern: string;
  tag: string | null;
  proven: boolean;
  applied_count: number;
  created_at: string;
}

export interface HandoffRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  content: string;
  created_at: string;
}

export interface TimelineItem {
  type: string;
  id: string;
  title: string;
  detail: string | null;
  at: string;
}

// ---------------------------------------------------------------------------
// Stage 26I: automation (schedules / goals / escalations)

export type ScheduleRecurrence = 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CRON';
export type ScheduleMode = 'CLOUD' | 'LOCAL_ONLY' | 'HYBRID';
export type MissedRunPolicy = 'RUN_ON_RECOVERY' | 'SKIP_STALE' | 'RUN_ONCE';

export interface ScheduleRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  agent_id: string;
  title: string;
  description: string | null;
  recurrence: ScheduleRecurrence;
  cron_expression: string | null;
  timezone: string;
  run_at: string;
  run_on_days: string[];
  enabled: boolean;
  execution_mode: ScheduleMode;
  missed_run_policy: MissedRunPolicy;
  next_run_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  run_count: number;
  require_approval: boolean;
  timeout_ms: number;
  max_attempts: number;
  notify_on_completion: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  owner_id: string;
  scheduled_for: string;
  status: string;
  task_id: string | null;
  agent_run_id: string | null;
  reason: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export type GoalStatus =
  | 'DRAFT'
  | 'PLANNING'
  | 'PLAN_READY'
  | 'WAITING_FOR_APPROVAL'
  | 'RUNNING'
  | 'PAUSED'
  | 'BLOCKED'
  | 'WAITING_FOR_HUMAN_DECISION'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type EntryStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';

export interface GoalPlanEntry {
  id: string;
  title: string;
  description: string | null;
  role: string | null;
  agentId: string | null;
  dependsOn: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  status: EntryStatus;
  runId: string | null;
  taskIds: string[];
  attempts: number;
  error: string | null;
}

export interface GoalRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  title: string;
  objective: string;
  success_criteria: string[];
  constraints: string[];
  status: GoalStatus;
  plan: GoalPlanEntry[];
  progress: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  blockers: Record<string, unknown>[];
  budget_usd: number;
  spent_usd: number;
  deadline_at: string | null;
  estimated_cost_usd: number | null;
  require_approval: boolean;
  approval_id: string | null;
  approved_at: string | null;
  error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type EscalationStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';

export interface EscalationRow {
  id: string;
  owner_id: string;
  goal_id: string | null;
  schedule_id: string | null;
  issue: string;
  evidence: Record<string, unknown>[];
  attempted_actions: string[];
  options: string[];
  recommendation: string | null;
  risk: string;
  status: EscalationStatus;
  user_decision: string | null;
  decision_note: string | null;
  resolved_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Stage 26I: recovery (autopsy / time travel)

export interface AutopsyRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  owner_id: string;
  status: string;
  root_cause_code: string;
  root_cause: string | null;
  confidence: number;
  timeline: unknown;
  attempts: unknown;
  errors: unknown;
  dependency_state: unknown;
  recovery_attempts: unknown;
  successful_fix: unknown;
  prevention: unknown;
  evidence: unknown;
  memory_id: string | null;
  created_at: string;
}

export interface CheckpointRow {
  id: string;
  task_id: string;
  attempt_id: string | null;
  owner_id: string;
  label: string | null;
  reason: string | null;
  stage_index: number;
  task_state: Record<string, unknown>;
  plan_state: Record<string, unknown> | null;
  execution_metadata: Record<string, unknown>;
  approval_state: Record<string, unknown> | null;
  created_at: string;
}

export interface RecoveryHistoryEntry {
  id: string;
  task_id: string;
  owner_id: string;
  event: string;
  detail: unknown;
  actor: string | null;
  created_at: string;
}

export interface IrreversibleActionRow {
  id: string;
  task_id: string;
  action_type: string;
  description: string;
  created_at: string;
}

export interface BranchResultRow {
  branchTask: Task;
  branchId: string;
}

// ---------------------------------------------------------------------------
// Cowork safety review loop (B1) — shared with backend modules/reviews.
// ---------------------------------------------------------------------------

export type ReviewStatus =
  | 'DRAFT'
  | 'READY_FOR_REVIEW'
  | 'PARTIALLY_REVIEWED'
  | 'APPLIED'
  | 'TESTING'
  | 'TEST_PASSED'
  | 'TEST_FAILED'
  | 'COMMITTED'
  | 'UNDONE'
  | 'FAILED'
  | 'CANCELLED';

export type HunkStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'APPLIED' | 'FAILED' | 'INVALIDATED';
export type ReviewTestStatus = 'NOT_RUN' | 'RUNNING' | 'PASSED' | 'FAILED' | 'BLOCKED';
export type ReviewCommitStatus = 'NOT_COMMITTED' | 'COMMITTED' | 'FAILED';

export interface ReviewHunkView {
  id: string;
  reviewId: string;
  fileId: string;
  path: string;
  hunkOrder: number;
  status: HunkStatus;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  originalSha: string;
  proposedSha: string;
  additions: number;
  deletions: number;
  context: { before: string[]; after: string[] };
  diffText: string;
  decidedAt: string | null;
}

export interface ReviewFileView {
  id: string;
  reviewId: string;
  path: string;
  baseSha256: string;
  proposedSha256: string;
  appliedSha256: string | null;
  status: string;
  fileOrder: number;
  appliedAt: string | null;
}

export interface ReviewView {
  id: string;
  taskId: string;
  runId: string | null;
  projectId: string;
  ownerId: string;
  title: string | null;
  status: ReviewStatus;
  testStatus: ReviewTestStatus;
  commitStatus: ReviewCommitStatus;
  diffText: string | null;
  filesChanged: number;
  additions: number;
  deletions: number;
  testCommand: string | null;
  testExitCode: number | null;
  testDurationMs: number | null;
  testOutput: string | null;
  testCorrelationId: string | null;
  commitMessage: string | null;
  commitHash: string | null;
  branch: string | null;
  applyError: string | null;
  createdAt: string;
  updatedAt: string;
  files: ReviewFileView[];
  hunks: ReviewHunkView[];
}

export interface ReviewListEntry {
  review: ReviewView;
  totalHunks: number;
  acceptedHunks: number;
  rejectedHunks: number;
}

export function mapHunkView(row: Record<string, unknown>): ReviewHunkView {
  return {
    id: String(row.id ?? row.hunk_id ?? ''),
    reviewId: String(row.review_id ?? row.reviewId ?? ''),
    fileId: String(row.file_id ?? row.fileId ?? ''),
    path: String(row.path ?? ''),
    hunkOrder: Number(row.hunk_order ?? row.hunkOrder ?? 0),
    status: (row.status as HunkStatus) ?? 'PENDING',
    oldStart: Number(row.old_start ?? row.oldStart ?? 0),
    oldLines: Number(row.old_lines ?? row.oldLines ?? 0),
    newStart: Number(row.new_start ?? row.newStart ?? 0),
    newLines: Number(row.new_lines ?? row.newLines ?? 0),
    originalSha: String(row.original_sha ?? row.originalSha ?? ''),
    proposedSha: String(row.proposed_sha ?? row.proposedSha ?? ''),
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    context: (row.context_lines ?? row.context ?? {}) as { before: string[]; after: string[] },
    diffText: String(row.diff_text ?? row.diffText ?? ''),
    decidedAt: row.decided_at ?? row.decidedAt ? String(row.decided_at ?? row.decidedAt) : null,
  };
}

export function mapReview(row: Record<string, unknown>): ReviewView {
  return {
    id: String(row.review_id ?? row.id ?? ''),
    taskId: String(row.task_id ?? ''),
    runId: row.run_id ? String(row.run_id) : null,
    projectId: String(row.project_id ?? ''),
    ownerId: String(row.owner_id ?? ''),
    title: row.title ? String(row.title) : null,
    status: (row.status as ReviewStatus) ?? 'DRAFT',
    testStatus: (row.test_status as ReviewTestStatus) ?? 'NOT_RUN',
    commitStatus: (row.commit_status as ReviewCommitStatus) ?? 'NOT_COMMITTED',
    diffText: row.diff_text ? String(row.diff_text) : null,
    filesChanged: Number(row.files_changed ?? 0),
    additions: Number(row.additions ?? 0),
    deletions: Number(row.deletions ?? 0),
    testCommand: row.test_command ? String(row.test_command) : null,
    testExitCode: row.test_exit_code === null || row.test_exit_code === undefined ? null : Number(row.test_exit_code),
    testDurationMs: row.test_duration_ms === null || row.test_duration_ms === undefined ? null : Number(row.test_duration_ms),
    testOutput: row.test_output ? String(row.test_output) : null,
    testCorrelationId: row.test_correlation_id ? String(row.test_correlation_id) : null,
    commitMessage: row.commit_message ? String(row.commit_message) : null,
    commitHash: row.commit_hash ? String(row.commit_hash) : null,
    branch: row.branch ? String(row.branch) : null,
    applyError: row.apply_error ? String(row.apply_error) : null,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    files: Array.isArray(row.files) ? (row.files as ReviewFileView[]) : [],
    hunks: Array.isArray(row.hunks) ? row.hunks.map((h) => mapHunkView(h as Record<string, unknown>)) : [],
  };
}
