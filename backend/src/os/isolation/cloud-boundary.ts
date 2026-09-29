/**
 * CodeConClave AI OS — cloud execution boundary (FAIL CLOSED).
 *
 * Rule: the MAIN application/API container must NEVER execute user programs —
 * real execution belongs to dedicated (local or worker) executors only. This
 * boundary exists so that accidental wiring (or a future shortcut) cannot make
 * the web tier run user code inside the shared deployment container.
 *
 * The main container declares itself as the host (`host: 'main'`) and the
 * isolation layer refuses every real run with `aios_isolation_unavailable`. A
 * registered worker/device declares `host: 'worker'` and goes through the
 * normal capability + min-mode gates.
 */
import { AppError } from '../../shared/errors.js';

export const CLOUD_BOUNDARY_ERROR_CODE = 'aios_isolation_unavailable';

export type CloudMainContainerError = ReturnType<typeof cloudMainContainerError>;

export function cloudMainContainerError(detail?: unknown): AppError {
  return AppError.unavailable(
    CLOUD_BOUNDARY_ERROR_CODE,
    'User-process execution is not enabled in the main application container. Route the run to a registered worker or execute on a local device.',
    detail,
  );
}

export function isMainContainerBoundaryError(err: unknown): boolean {
  return err instanceof AppError && err.errorCode === CLOUD_BOUNDARY_ERROR_CODE;
}