/**
 * CodeConClave — shared domain models (database-facing types).
 * These mirror the DATABASE CONTRACT (docs/DATABASE_CONTRACT.md).
 */
import type {
  AgentRole,
  AgentRunState,
  ApprovalStatus,
  CoworkerRunState,
  CoworkerType,
  DnaConflictState,
  DnaKind,
  DnaScope,
  EntitlementState,
  MemoryConfidence,
  MemoryContradictionState,
  MemoryEmbeddingStatus,
  MemoryScope,
  MemorySource,
  MemoryType,
  MemoryVerificationState,
  PaymentMode,
  PaymentState,
  PlanId,
  PluginState,
  PluginType,
  PreviewState,
  ProviderId,
  ProviderState,
  RiskLevel,
  SessionState,
  TaskStatus,
} from '../constants.js';

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  passwordHash: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  googleSub: string | null;
  role: string | null;
  primaryUseCase: string | null;
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
  recoveryCodesHash: string | null;
  rbacRole: 'owner' | 'admin' | 'member' | 'viewer';
  planId: PlanId;
  entitlementState: EntitlementState;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  state: SessionState;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  pairingCodeHash: string | null;
  state: 'PENDING_PAIRING' | 'PAIRED' | 'REVOKED';
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface Team {
  id: string;
  ownerId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  ownerId: string;
  teamId: string | null;
  name: string;
  description: string | null;
  repoUrl: string | null;
  workspaceRoot: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  projectId: string | null;
  ownerId: string;
  title: string;
  mode: 'CHAT' | 'COWORK';
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  /** Monotonic per-conversation order (server identity sequence). Sync/continuity
   *  uses it for incremental pull (messages after a known seq). */
  seq: number;
  /** Client-generated idempotency key (USER messages only; null for AI/system). */
  clientId: string | null;
  sender: 'USER' | 'AI' | 'SYSTEM' | 'COWORKER';
  coworkerType: CoworkerType | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelId: string | null;
  providerId: ProviderId | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  status: 'PENDING' | 'STREAMING' | 'COMPLETED' | 'FAILED';
  errorCode: string | null;
  editedAt: Date | null;
  editCount: number;
  threadId: string | null;
  createdAt: Date;
  /**
   * Generated/attached image artifact (IMAGE_GENERATION). The file is stored
   * server-side (files gateway); only the file id + mime travel in the
   * contract so secrets/large blobs never reach the client contract.
   */
  imageFileId?: string | null;
  imageMime?: string | null;
}

export interface Memory {
  id: string;
  projectId: string | null;
  teamId: string | null;
  ownerId: string;
  type: MemoryType;
  source: MemorySource;
  content: string;
  structured: Record<string, unknown> | null;
  confidence: MemoryConfidence;
  provenance: string | null;
  contradictionState: MemoryContradictionState;
  supersededById: string | null;
  embeddingStatus?: MemoryEmbeddingStatus;
  embeddingModel?: string | null;
  verificationState?: MemoryVerificationState;
  scope?: MemoryScope;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DnaBlock {
  id: string;
  projectId: string;
  ownerId: string;
  kind: DnaKind;
  scope: DnaScope;
  title: string;
  content: string;
  version: number;
  parentVersionId: string | null;
  conflictState: DnaConflictState;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileRecord {
  id: string;
  projectId: string;
  ownerId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string | null;
  storageProvider: 'memory' | 's3' | 'r2' | null;
  mimeType: string | null;
  isDirectory: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Task {
  id: string;
  projectId: string;
  conversationId: string | null;
  ownerId: string;
  title: string;
  description: string | null;
  plan: string | null;
  status: TaskStatus;
  riskLevel: RiskLevel;
  requiredApproval: boolean;
  approvalId: string | null;
  coworkerPipeline: CoworkerType[] | null;
  executionMode: 'CLOUD' | 'LOCAL' | 'HYBRID';
  timeoutMs: number;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  errorCode: string | null;
  errorDetail: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastHeartbeatAt: Date | null;
  watchdogCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  attemptNumber: number;
  startedAt: Date;
  finishedAt: Date | null;
  result: 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'CANCELLED' | null;
  errorCode: string | null;
  outputSummary: string | null;
}

export interface Approval {
  id: string;
  taskId: string | null;
  ownerId: string;
  detail: Record<string, unknown>;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  decision: 'APPROVE' | 'REJECT' | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CoworkerRun {
  id: string;
  taskId: string;
  coworkerType: CoworkerType;
  orderIndex: number;
  state: CoworkerRunState;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  verificationResult: 'PASS' | 'FAIL' | 'SKIPPED' | null;
  errorCode: string | null;
  timeoutMs: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiModelDescriptor {
  modelId: string;
  providerId: ProviderId;
  displayName: string;
  tier: 'PREMIUM' | 'CAPABLE' | 'EFFICIENT';
  computeClass: 'A' | 'B' | 'C';
  contextWindow: number;
  supportsVision: boolean;
  supportsTools: boolean;
  supportsFunctionCalling: boolean;
  inputCostPerM: number;
  outputCostPerM: number;
  entitlement: 'FREE' | 'PRO';
  privacyClass: 'PUBLIC' | 'STANDARD' | 'STRICT';
  targetLatencyMs: number;
  health: ProviderState;
  priority: number;
  fallbackList: string[];
  enabled: boolean;
  effectiveDate: string;
  deprecationDate: string | null;
  /** Coding-optimized model (registry 0042); preferred for code workloads. */
  codingOptimized: boolean;
  /**
   * Image generation / editing capability (Provider Integration 2026).
   * Canonical yet explicit — a model is image-generation/editing-capable ONLY
   * when its registry row says so (registry columns image_generation /
   * image_editing). Absent fields are treated as false; they are never derived
   * from provider id or vision heuristics. This keeps the registry honest for
   * text-only, multimodal, and dedicated image-generation models alike.
   */
  imageGeneration?: boolean;
  imageEditing?: boolean;
  /**
   * Capability category (Provider Expansion 2026): distinguishes model-style
   * text/code/multimodal providers from external autonomous-agent resources.
   * MODEL = chat/completion adapter; EXTERNAL_AGENT = out-of-band job lifecycle
   * (e.g. Devin). Both enter the same CodeConClave orchestration system; only
   * the adapter capability layer differs.
   */
  capabilityCategory: 'MODEL' | 'EXTERNAL_AGENT';
}

/**
 * Canonical capability class (Provider Experience 2026) — the web/desktop
 * consumer-facing abstraction derived from the registry descriptor. One
 * truthful label per model:
 *  - NORMAL_MODEL        text/code chat model (no image in/out)
 *  - MULTIMODAL_MODEL    accepts IMAGE_INPUT (VISION) for analysis
 *  - IMAGE_GENERATOR     produces images (IMAGE_GENERATION / IMAGE_EDITING)
 *  - EXTERNAL_AGENT      out-of-band autonomous-agent lifecycle (e.g. Devin/Manus)
 * Derived server-side (capabilityClassOf), never client-invented.
 */
export type CapabilityClass = 'NORMAL_MODEL' | 'MULTIMODAL_MODEL' | 'IMAGE_GENERATOR' | 'EXTERNAL_AGENT';

/**
 * Structured model capability matrix (Model Routing 2026).
 * Each field declares ONLY capabilities that are actually SUPPORTED — derived
 * honestly from registry metadata (supports_vision/supports_tools/
 * supports_function_calling) and verified provider facts. Never invented.
 * Separate concepts: SUPPORTED vs CONFIGURED vs AVAILABLE vs HEALTHY vs
 * VERIFIED are distinct states tracked by the router/provider-health system.
 */
export interface ModelCapabilities {
  text: boolean;
  reasoning: boolean;
  coding: boolean;
  vision: boolean;
  imageGeneration: boolean;
  imageEditing: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  toolCalling: boolean;
  autonomousAgent: boolean;
}

export interface ModelUsageLog {
  id: string;
  userId: string;
  taskId: string | null;
  sessionId: string;
  conversationId: string | null;
  providerId: ProviderId;
  modelId: string;
  planId: PlanId;
  computeClass: 'A' | 'B' | 'C';
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  durationMs: number;
  usedFallback: boolean;
  createdAt: Date;
}

export interface PaymentSession {
  id: string;
  userId: string;
  planId: PlanId;
  amountInr: number;
  currency: 'INR';
  mode: PaymentMode;
  state: PaymentState;
  reference: string | null;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  verificationEvidence: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Entitlement {
  id: string;
  userId: string;
  planId: PlanId;
  state: EntitlementState;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  paymentSessionId: string | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PluginConnection {
  id: string;
  ownerId: string;
  pluginType: PluginType;
  name: string;
  state: PluginState;
  scopes: string[];
  credentialRef: string | null;
  lastHealthCheckAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Multi-agent workspace agent configuration (Stage 25.5). */
export interface AiAgent {
  id: string;
  ownerId: string;
  name: string;
  role: AgentRole;
  objective: string | null;
  capabilities: string[];
  modelProvider: string | null;
  modelId: string | null;
  maxTasksPerRun: number;
  maxRetries: number;
  status: string;
  currentRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One bounded agent run. Driven by the existing task engine (planner→graph→approval→execution→audit→memory). */
export interface AiAgentRun {
  id: string;
  agentId: string;
  ownerId: string;
  projectId: string | null;
  status: AgentRunState;
  objective: string | null;
  currentTaskId: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  retriesUsed: number;
  budgetUsd: number;
  spentUsd: number;
  deadlineAt: Date | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}

/** Main-workspace live preview session (Stage 25.5). */
export interface PreviewSession {
  id: string;
  ownerId: string;
  projectId: string;
  state: PreviewState;
  buildLog: string[];
  error: string | null;
  taskId: string | null;
  version: number;
  updatedAt: Date;
  createdAt: Date;
}

export interface TeamDna {
  id: string;
  teamId: string;
  branchName: string;
  content: Record<string, unknown>;
  baseVersionId: string | null;
  conflictState: DnaConflictState;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  actorUserId: string | null;
  tenantScope: 'USER' | 'TEAM' | 'SYSTEM';
  tenantId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}

export interface OutboxEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface UsageCounter {
  id: string;
  ownerId: string;
  name: string;
  bucket: string;
  value: number;
  updatedAt: Date;
}

export interface WorkspaceStateEntry {
  id: string;
  ownerId: string;
  key: string;
  value: Record<string, unknown>;
  updatedAt: Date;
}