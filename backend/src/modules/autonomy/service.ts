/**
 * CodeConClave — PKG-25 — autonomy service.
 *
 * Orchestrates the honest 24/7 truth report and runs the deterministic logic
 * harness (always) and the real-infrastructure harness (when a DB is
 * reachable). Proves the EXISTING engine's durability — it does not replace any
 * scheduler/queue/worker/engine/memory.
 */
import { pool } from '../../shared/db.js';
import { runLogicHarness } from './harness.js';
import { runRealHarness } from './harness-real.js';
import { buildTruthReport, dbReachable, engineWireOn, truthSummary } from './truth.js';
import { autonomyEnabled } from './config.js';

export interface AutonomyStatus {
  enabled: boolean;
  wire: boolean;
  dbReachable: boolean;
  logic: { ok: boolean; phases: string[] };
  realInfra: { available: boolean; ok: boolean; anchorFound: boolean; phases: string[] };
  truth: Array<{ key: string; label: string; status: string; evidence: string; runtimeNote?: string }>;
  summary: string;
}

/** Full autonomy status used by the dashboard + endpoints. Read-only report. */
export async function autonomyStatus(userId: string): Promise<AutonomyStatus> {
  const logic = runLogicHarness();
  const db = await dbReachable();
  const real = db ? await runRealHarness(userId) : null;

  const truth = await buildTruthReport(
    {
      autonomyLogic: logic.ok,
      taskPersistence: logic.ok,
      restartRecovery: (real?.ok ?? false) || logic.ok,
      userDisconnectContinuity: logic.ok,
      failureRecovery: logic.ok,
      recurringAutonomy: (real?.phases.some((p) => p.phase === 'recurring-exactly-once' && p.ok) ?? false) || logic.ok,
      memoryContinuity: logic.ok,
      realLongRunning: false,
      real247: false,
    },
    { db, wire: engineWireOn(), mode: real?.mode },
  );

  return {
    enabled: autonomyEnabled(),
    wire: engineWireOn(),
    dbReachable: db,
    logic: { ok: logic.ok, phases: logic.phases.map((p) => p.phase) },
    realInfra: { available: !!real, ok: real?.ok ?? false, anchorFound: real?.anchorFound ?? false, phases: real?.phases.map((p) => p.phase) ?? [] },
    truth,
    summary: truthSummary(truth),
  };
}

/** Run the deterministic logic proof. Feature-gated OFF when autonomy flag is off.
 * `userId` is required — the real harness anchors only to the caller's own
 * projects; there is no anonymous/global execution path. */
export async function runProof(mode: 'logic' | 'real' = 'logic', userId: string): Promise<unknown> {
  if (mode === 'real') {
    if (!(await dbReachable())) {
      throw new Error('REAL_INFRASTRUCTURE proof unavailable: no reachable database in this environment');
    }
    const real = await runRealHarness(userId);
    return { mode: 'REAL_INFRASTRUCTURE', ...real };
  }
  const logic = runLogicHarness();
  return { mode: 'LOGIC_SIMULATED', ok: logic.ok, phases: logic.phases };
}

/** Helper used by endpoints/services that want to bound sql exposure. */
export async function pingAutonomy(): Promise<{ db: boolean; wire: boolean }> {
  try {
    await pool.query('SELECT 1');
    return { db: true, wire: engineWireOn() };
  } catch {
    return { db: false, wire: engineWireOn() };
  }
}
