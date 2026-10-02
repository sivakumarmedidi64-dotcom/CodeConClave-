/**
 * CodeConClave — PKG-25 24/7 Autonomous Cowork — configuration.
 *
 * The autonomy module is an ADDITIVE proof + hardening layer over the EXISTING
 * task engine. It never replaces the scheduler, queue, worker, watchdog, or
 * memory system — it drives and guards them.
 */
import { env } from '../../config/env.js';

export const parseBool = (v: string | boolean | undefined): boolean =>
  v === true || v === 'true' || v === '1';

/** Feature gate. When OFF the proof/run endpoints are feature_disabled; the
 * read-only truth report stays available. The underlying engine is always ON. */
export const autonomyEnabled = (): boolean => parseBool(env.AIOS_P2_AUTONOMY);

/** Deterministic harness concurrency/attempt bounds (metadata-control only). */
export const AUTONOMY_MAX_ATTEMPTS = 3;
export const AUTONOMY_HARNESS_TIMEOUT_MS = 60_000;
export const AUTONOMY_HARNESS_MODE_REAL = 'REAL_INFRASTRUCTURE';
export const AUTONOMY_HARNESS_MODE_SIM = 'LOGIC_SIMULATED';

/** 24/7 project provisioning defaults. */
export const AUTONOMY_CARETAKER_ROLE = 'ARCHITECT';
export const AUTONOMY_CARETAKER_TASK_TITLE = '24/7 autonomous upkeep';
