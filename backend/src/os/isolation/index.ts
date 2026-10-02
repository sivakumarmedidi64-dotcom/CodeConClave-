/**
 * CodeConClave AI OS — real isolation layer (barrel).
 *
 * Honest, fail-closed, additive. Never claims container/process isolation the
 * host does not provide; use `RealIsolationExecutor.report()` for the canonical
 * ISOLATION_MODE status.
 */
export {
  IsolationMode,
  satisfies,
  isRealIsolation,
  isIsolationMode,
} from './modes.js';
export type { IsolationMode as IsolationModeType } from './modes.js';
export { detectIsolationAbilities, defaultProbes } from './detect.js';
export type { IsolationProbes, IsolationSnapshot } from './detect.js';
export { ContainerExecutor, buildContainerArgs, CONTAINER_DOCKER_ARGS_PREFIX, DEFAULT_CONTAINER_USER } from './container-executor.js';
export type { ContainerRunOptions, ContainerRunResult, ContainerExecutorDeps } from './container-executor.js';
export { ProcessIsolationExecutor, UNSHARE_PREFIX } from './process-executor.js';
export type { ProcessIsolationOptions, ProcessIsolationResult, ProcessIsolationDeps } from './process-executor.js';
export { ProcessControls } from './process-controls.js';
export type { ProcessControlsOptions, ProcessControlsResult } from './process-controls.js';
export { RealIsolationExecutor } from './real-executor.js';
export type { RealIsolationRunOptions, RealIsolationResult, RealIsolationDeps } from './real-executor.js';
export {
  CLOUD_BOUNDARY_ERROR_CODE,
  cloudMainContainerError,
  isMainContainerBoundaryError,
} from './cloud-boundary.js';
export type { CloudMainContainerError } from './cloud-boundary.js';