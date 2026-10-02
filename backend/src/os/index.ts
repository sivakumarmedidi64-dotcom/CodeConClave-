/**
 * CodeConClave AI OS — public barrel.
 * Additive, feature-flag-gated foundation. Import { createAios } for the OS
 * API. All primitives fall back to existing behavior when AIOS is disabled.
 */
export { Aios, createAios } from './os-api.js';
export type { AiosContext } from './os-api.js';
export { Supervisor } from './supervisor.js';
export type { SuperviseOptions, SuperviseOutcome, SuperviseContext, LifecycleEvent } from './supervisor.js';
export { MemoryStateStore, PostgresStateStore, createStateStore } from './state.js';
export type { StateStore } from './state.js';
export { ResourceGovernor } from './resource-governor.js';
export type { ConcurrencySlot } from './resource-governor.js';
export { CapabilitySet, CapabilityLedger } from './capabilities.js';
export { FilesystemOsLayer } from './fs-layer.js';
export type { FsChange, SnapshotRef } from './fs-layer.js';
export { diffLines, applyReverseDiff } from './diff.js';
export type { DiffOp, DiffResult } from './diff.js';
export { EventBus } from './event-bus.js';
export type { OsEvent } from './event-bus.js';
export { PolicySandboxExecutor } from './sandbox.js';
export type { SandboxOptions, SandboxResult } from './sandbox.js';
export { IpcBus, MemoryIpcStore, OutboxIpcStore } from './ipc.js';
export type { IpcEvent, IpcStore, DurableConsumer, PublishOptions } from './ipc.js';
export { DagExecutor } from './dag.js';
export type { DagNode, DagNodeContext, DagNodeState, DagResult, DagDependencies } from './dag.js';
export { Trace, sanitizeFields } from './observability.js';
export type { Span, SpanContext, SpanKind } from './observability.js';
export { GitEngine } from './git.js';
export type { GitExecution } from './git.js';
export { ProcessTree, gracefulShutdown, propagateFailure } from './lifecycle.js';
export type { ShutdownResult } from './lifecycle.js';
export {
  RealIsolationExecutor,
  ContainerExecutor,
  ProcessIsolationExecutor,
  ProcessControls,
  detectIsolationAbilities,
  buildContainerArgs,
  IsolationMode,
  satisfies,
  isRealIsolation,
  isIsolationMode,
} from './isolation/index.js';
export type {
  IsolationSnapshot,
  IsolationProbes,
  ContainerRunOptions,
  ContainerRunResult,
  ContainerExecutorDeps,
  ProcessIsolationOptions,
  ProcessIsolationResult,
  ProcessIsolationDeps,
  ProcessControlsOptions,
  ProcessControlsResult,
  RealIsolationRunOptions,
  RealIsolationResult,
  RealIsolationDeps,
} from './isolation/index.js';
export { DeviceRegistry, defaultDeviceCatalog, DeviceKind } from './devices/index.js';
export type { Device } from './devices/index.js';
export { ExecutionCoordinator, CoordinatorEventType } from './dist-exec/index.js';
export type {
  CoordinatorOptions,
  TaskRunState,
  WorkerId,
  TaskId,
  WorkerResource,
  WorkerRegistration,
  TaskExecutionRequest,
  Lease,
  TaskAssignment,
  CoordinatorEvent,
} from './dist-exec/index.js';
export {
  AiosEnabled,
  OsProcessState,
  RestartPolicy,
  CapabilityKind,
  isOsProcessState,
} from './types.js';
export type { OsProcess, Capability, ResourceBudget, OsStateBlock } from './types.js';
