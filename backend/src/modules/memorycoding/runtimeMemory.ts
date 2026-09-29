/**
 * CodeConClave — PKG-23 Test / Runtime Memory.
 *
 * Connects relevant HISTORICAL execution data to current work, reading the
 * existing runtime/execution tables (runtime_executions, runtime_background_tasks,
 * runtime_network_events, runtime_smoke_results). Reports only facts actually
 * stored: failed tests, timed-out commands, 500 endpoints, smoke failures.
 * Returns evidence-backed strings that can feed context/agent prompts or the
 * continuity panel.
 */
import { withTenant } from '../../shared/db.js';

export interface RuntimeMemoryEvidence {
  label: string;
  detail: string;
  confidence: number;
  ref: string | null;
}

export async function runtimeMemory(
  userId: string,
  projectId: string,
  limit = 8,
): Promise<RuntimeMemoryEvidence[]> {
  const out: RuntimeMemoryEvidence[] = [];

  const executions = await withTenant<{ command: string; kind: string; status: string; output: string; error: string; id: string }[]>(userId, async (q) =>
    (await q.query<{ command: string; kind: string; status: string; output: string; error: string; id: string }>(
      `SELECT id, command, kind, status, output, error FROM runtime_executions
       WHERE project_id = $1 AND status IN ('FAILED','TIMED_OUT') ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit],
    )).rows,
  );
  for (const e of executions) {
    const timedOut = e.status === 'TIMED_OUT';
    out.push({
      label: timedOut ? `Command timed out (${e.kind}): ${e.command.slice(0, 80)}` : `Command failed (${e.kind}): ${e.command.slice(0, 80)}`,
      detail: (timedOut ? e.error : e.output ?? e.error)?.slice(0, 300) ?? '',
      confidence: 0.85,
      ref: `runtime://${e.id}`,
    });
  }

  const network = await withTenant<{ method: string; url_path: string; status: number; id: string }[]>(userId, async (q) =>
    (await q.query<{ method: string; url_path: string; status: number; id: string }>(
      `SELECT id, method, url_path, status FROM runtime_network_events
       WHERE project_id = $1 AND status >= 500 ORDER BY ts DESC LIMIT $2`,
      [projectId, limit],
    )).rows,
  );
  for (const n of network) {
    out.push({
      label: `Endpoint returned ${n.status}: ${n.method} ${n.url_path}`,
      detail: `HTTP ${n.status} on ${n.method} ${n.url_path}`,
      confidence: 0.8,
      ref: `runtime://${n.id}`,
    });
  }

  const smoke = await withTenant<{ name: string; failure_reason: string; status: string; id: string }[]>(userId, async (q) =>
    (await q.query<{ name: string; failure_reason: string; status: string; id: string }>(
      `SELECT id, name, status, failure_reason FROM runtime_smoke_results
       WHERE project_id = $1 AND status = 'FAIL' ORDER BY started_at DESC LIMIT $2`,
      [projectId, limit],
    )).rows,
  );
  for (const s of smoke) {
    out.push({
      label: `Smoke check failed: ${s.name}`,
      detail: s.failure_reason ?? 'no reason recorded',
      confidence: 0.8,
      ref: `runtime://${s.id}`,
    });
  }

  return out.slice(0, limit);
}
