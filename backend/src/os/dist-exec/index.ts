/**
 * CodeConClave AI OS — distributed execution prep (barrel).
 * Architecture preparation only; nothing is wired to production yet.
 */
export {
  ExecutionCoordinator,
} from './coordinator.js';
export type { CoordinatorOptions, TaskRunState } from './coordinator.js';
export {
  CoordinatorEventType,
  WorkerExecutionClass,
} from './types.js';
export type {
  WorkerId,
  TaskId,
  WorkerResource,
  WorkerRegistration,
  TaskExecutionRequest,
  Lease,
  TaskAssignment,
  CoordinatorEvent,
} from './types.js';
export { SupervisedWorkerExecutor } from './worker-executor.js';
export type {
  SupervisedWorkerExecutorOptions,
  SupervisedWorkerOutcome,
} from './worker-executor.js';