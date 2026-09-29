/**
 * CodeConClave AI OS — execution device model (types).
 *
 * Every execution surface ("device") that the AI OS can use is modeled here so
 * that selection, capability gating, and availability stay uniform —
 * LOCAL_TERMINAL / LOCAL_FILESYSTEM / LOCAL_GIT on the local agent,
 * DOCKER_EXECUTOR for real container isolation, CLOUD_EXECUTOR for backend
 * execution, and FUTURE_REMOTE_WORKER for the distributed worker pool. Every
 * device operation is capability-gated by the DeviceRegistry.
 */

export const DeviceKind = {
  LOCAL_TERMINAL: 'local_terminal',
  LOCAL_FILESYSTEM: 'local_filesystem',
  LOCAL_GIT: 'local_git',
  DOCKER_EXECUTOR: 'docker_executor',
  CLOUD_EXECUTOR: 'cloud_executor',
  FUTURE_REMOTE_WORKER: 'future_remote_worker',
} as const;
export type DeviceKind = (typeof DeviceKind)[keyof typeof DeviceKind];

export interface Device {
  id: string;
  kind: DeviceKind;
  /** Host-verified availability (real isolation only when a runtime exists). */
  available: boolean;
  /** Capability kinds required before any operation reaches this device. */
  requiredCapabilities: string[];
  description: string;
}