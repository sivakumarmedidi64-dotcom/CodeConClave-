/**
 * CodeConClave AI OS — shared domain types & const enums (P0).
 *
 * Additive, feature-flag-gated foundation. Mirrors the shared const-object
 * enum style so it runs under Node's native type stripping, tsc/tsx/vitest.
 * Nothing here modifies existing behavior.
 */

export const AiosEnabled = 'aios';
export type AiosEnabled = typeof AiosEnabled;

/** Canonical process lifecycle (unifies task/agent/runtime states). */
export const OsProcessState = {
  QUEUED: 'queued',
  STARTING: 'starting',
  RUNNING: 'running',
  PAUSED: 'paused',
  CANCELLING: 'cancelling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  KILLED: 'killed',
  RECOVERING: 'recovering',
} as const;
export type OsProcessState = (typeof OsProcessState)[keyof typeof OsProcessState];

export const RestartPolicy = {
  NONE: 'none',
  ON_FAILURE: 'on_failure',
  ALWAYS: 'always',
} as const;
export type RestartPolicy = (typeof RestartPolicy)[keyof typeof RestartPolicy];

/** Capability model: every process/agent holds only explicitly granted caps. */
export const CapabilityKind = {
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  FILE_DELETE: 'file.delete',
  TERMINAL_EXEC: 'terminal.exec',
  GIT_READ: 'git.read',
  GIT_WRITE: 'git.write',
  NETWORK_REQUEST: 'network.request',
  DATABASE_QUERY: 'database.query',
  PACKAGE_INSTALL: 'package.install',
  VOICE_CONTROL: 'voice.control',
} as const;
export type CapabilityKind = (typeof CapabilityKind)[keyof typeof CapabilityKind];

export interface Capability {
  kind: CapabilityKind | string;
  /** Scoping anchor, e.g. a project id or a sandboxed workspace root. */
  scope: string;
  /** Optional resource path/resource hint within the scope. */
  resource?: string;
  grantedAt: number;
}

/** Resource-budget control set enforced by the Resource Governor. */
export interface ResourceBudget {
  /** Max wall runtime ms. 0 = no cap. */
  maxRuntimeMs: number;
  /** Max concurrent child processes across the whole OS. 0 = no cap. */
  maxConcurrency: number;
  /** Cost budget USD. 0 = no cap. */
  maxCostUsd: number;
  /** Optional egress policy: allow-listed hosts. Empty = no network cap. */
  allowedNetworkHosts?: string[];
  /** Queue priority (higher = claimed first, mirrors existing task priority). */
  priority?: number;
}

/** Read-only snapshot of a process under the Supervisor. */
export interface OsProcess {
  id: string;
  parentId: string | null;
  state: OsProcessState;
  restartPolicy: RestartPolicy;
  capabilities: Capability[];
  pid: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
  errorCode: string | null;
  restarts: number;
}

/** Serialized, versioned OS state (state-persistence primitive). */
export interface OsStateBlock<T = unknown> {
  version: number;
  key: string;
  data: T;
  checksum: string;
  updatedAt: number;
}

export function isOsProcessState(v: string): v is OsProcessState {
  return Object.values(OsProcessState).includes(v as OsProcessState);
}
