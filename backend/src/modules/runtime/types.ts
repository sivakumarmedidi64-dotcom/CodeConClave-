/**
 * CodeConClave — PKG-19 Browser + Runtime Development — shared types.
 * Anchored to F34 (Terminal), F90 (Local Terminal Execution), F38 (Preview),
 * F49 (WebSocket Hub). Types used by the runtime module's honesty-explicit
 * execution, task, capture, verification, smoke and correlation surfaces.
 */

export const RUNTIME_EXECUTION_KINDS = [
  'RUN',
  'BUILD',
  'TEST',
  'LINT',
  'TYPECHECK',
  'DEV_SERVER',
  'CUSTOM',
] as const;
export type RuntimeExecutionKind = (typeof RUNTIME_EXECUTION_KINDS)[number];

export const RUNTIME_EXECUTION_STATUSES = [
  'STARTED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'STOPPED',
  'BLOCKED',
] as const;
export type RuntimeExecutionStatus = (typeof RUNTIME_EXECUTION_STATUSES)[number];

export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'uncaught'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const NETWORK_STATES = [
  'PENDING',
  'SUCCESS',
  'CLIENT_ERROR',
  'SERVER_ERROR',
  'TIMED_OUT',
  'NETWORK_ERROR',
  'BLOCKED',
] as const;
export type NetworkState = (typeof NETWORK_STATES)[number];

export const VERIFY_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'UNAVAILABLE'] as const;
export type VerifyStatus = (typeof VERIFY_STATUSES)[number];

export const SMOKE_STATUSES = ['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'UNAVAILABLE'] as const;
export type SmokeStatus = (typeof SMOKE_STATUSES)[number];

/** A runtime execution record (server-side controlled command run). */
export interface RuntimeExecution {
  id: string;
  projectId: string;
  kind: RuntimeExecutionKind;
  command: string;
  status: RuntimeExecutionStatus;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  blocked: boolean;
  output: string;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
  endedAt: string | null;
  // PKG-20: environment + working-directory context recorded with execution history.
  environment?: string | null;
  cwd?: string | null;
}

export interface CreateExecutionInput {
  projectId: string;
  kind?: RuntimeExecutionKind;
  command: string;
  timeoutMs?: number;
  // PKG-20: optional environment + working-directory metadata persisted to history.
  environment?: string;
  cwd?: string;
}

/** A background development task (build/test/lint/typecheck/dev-server/watch). */
export interface BackgroundTask {
  id: string;
  projectId: string;
  label: string;
  kind: string;
  command: string;
  status: RuntimeExecutionStatus;
  pid: number | null;
  exitCode: number | null;
  latestOutput: string;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface CreateBackgroundInput {
  projectId: string;
  label: string;
  kind?: string;
  command: string;
  timeoutMs?: number;
}

/** Captured browser console event (evidence-only, honest boundary). */
export interface ConsoleEvent {
  id: string;
  projectId: string;
  level: ConsoleLevel;
  message: string;
  stack: string | null;
  sourceUrl: string | null;
  ts: string;
}

/** Captured network request metadata (redacted; never sensitive bodies). */
export interface NetworkEvent {
  id: string;
  projectId: string;
  method: string;
  urlPath: string;
  status: number | null;
  durationMs: number | null;
  ok: boolean | null;
  state: NetworkState;
  requestId: string | null;
  ts: string;
}

/** Runtime verification run (RUNTIME_VERIFY_RUN), honest statuses. */
export interface VerificationResult {
  id: string;
  projectId: string;
  label: string;
  status: VerifyStatus;
  detail: string;
  durationMs: number | null;
  ranAt: string;
}

/** Smoke-test run + individual result. */
export interface SmokeConfig {
  name: string;
  method: string;
  url: string;
  expectedStatus?: number;
  timeoutMs?: number;
}

export interface SmokeRunSummary {
  id: string;
  projectId: string;
  name: string;
  status: 'RUNNING' | 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'PARTIAL';
  total: number;
  passed: number;
  failed: number;
  unavailable: number;
}

export interface SmokeResult {
  id: string;
  name: string;
  method: string;
  url: string;
  expectedStatus: number | null;
  status: SmokeStatus;
  durationMs: number | null;
  evidence: string;
  failureReason: string | null;
}

/** Frontend↔backend runtime correlation (advisory, evidence-gated). */
export interface CorrelationFinding {
  requestId: string | null;
  urlPath: string;
  method: string;
  frontendState: NetworkState | null;
  httpStatus: number | null;
  backendError: string | null;
  likelySource: string | null;
  relatedChange: string | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  state: 'HEURISTIC' | 'UNAVAILABLE';
}

export interface RuntimeCapabilities {
  executionEnabled: boolean;
  backgroundEnabled: boolean;
  consoleCapture: 'VERIFIED_READY' | 'UNAVAILABLE' | 'ENVIRONMENT_BLOCKED';
  networkCapture: 'VERIFIED_READY' | 'UNAVAILABLE' | 'ENVIRONMENT_BLOCKED';
  verificationEnabled: boolean;
  smokeEnabled: boolean;
  browserRuntime: 'NONE' | 'PREVIEW_IFRAME';
}
