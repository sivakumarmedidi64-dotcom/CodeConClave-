/**
 * CodeConClave — PKG-23 Project Continuity panel.
 * "Resume where you left off": honest restoration status (RESTORED /
 * PARTIALLY_RESTORED / UNAVAILABLE), open files, active file, branch, current
 * task, recent memories, decisions, unresolved evidence (failed tests / 500
 * endpoints), and recent deployments. Nothing is fabricated — if there is no
 * state it reports UNAVAILABLE.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

interface Continuity {
  status: 'RESTORED' | 'PARTIALLY_RESTORED' | 'UNAVAILABLE';
  projectId: string;
  lastActiveProject: string | null;
  branch: string | null;
  currentTaskId: string | null;
  recentSearches: string[];
  recentCommands: string[];
  activeFile: string | null;
  split: string | null;
  files: Array<{ path: string; active: boolean; unsaved?: boolean }>;
  memories: string[];
  decisions: Array<{ title: string; impact: string }>;
  evidence: { testFailures: string[]; timedOutCommands: string[]; serverErrors: string[]; openTrials: Array<{ id: string; title: string }>; failedTasks: string[] };
  deployments: Array<{ version: string | null; environment: string; status: string; verification: string | null }>;
  lastActivityAt: string | null;
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

export function ProjectContinuityPanel({ projectId }: { projectId: string }) {
  const [cont, setCont] = useState<Continuity | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const caps = await api<{ featureGateEnabled: boolean }>('/api/v1/memorycoding/capabilities');
      if (!caps.featureGateEnabled) {
        setCont(null);
        setState('disabled');
        return;
      }
      const r = await api<{ continuity: Continuity | null }>(`/api/v1/memorycoding/continuity?projectId=${encodeURIComponent(projectId)}`);
      setCont(r.continuity);
      setState('ready');
    } catch (e) {
      setCont(null);
      setState('error');
      setError(message(e, 'Project continuity unavailable'));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid="continuity-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Project Continuity</h2>

      {state === 'disabled' && (
        <p data-testid="cont-disabled" className="text-sm text-amber-700">
          Memory coding is feature-gated OFF (AIOS_P2_MEMORY_CODING).
        </p>
      )}
      {state === 'loading' && <p data-testid="cont-loading">Restoring context…</p>}
      {state === 'error' && <p data-testid="cont-error" className="text-sm text-red-600">{error ?? 'Project continuity unavailable'}</p>}

      {state === 'ready' && cont && (
        <>
          <section className="rounded border p-3 text-sm">
            <p data-testid="cont-status" className="font-medium">
              Restoration: {cont.status}
            </p>
            {cont.lastActiveProject && <p data-testid="cont-project">Last active project: {cont.lastActiveProject}</p>}
            {cont.activeFile && <p data-testid="cont-active-file">Active file: {cont.activeFile}</p>}
            {cont.branch && <p data-testid="cont-branch">Branch: {cont.branch}</p>}
            {cont.currentTaskId && <p data-testid="cont-task">Current task: {cont.currentTaskId}</p>}
          </section>

          <section className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">Open files</h3>
            {cont.files.length === 0 && <p data-testid="cont-files-empty" className="text-xs text-gray-500">No open files recorded.</p>}
            <ul data-testid="cont-files" className="mt-1 space-y-0.5 text-xs">
              {cont.files.map((f) => (
                <li key={f.path} data-testid="cont-file">
                  {f.active ? '● ' : ''}{f.path}{f.unsaved ? ' •' : ''}
                </li>
              ))}
            </ul>
          </section>

          {(cont.memories.length > 0 || cont.decisions.length > 0) && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Remembered context</h3>
              <ul data-testid="cont-memories" className="mt-1 list-disc pl-4 text-xs text-gray-700">
                {cont.memories.slice(0, 8).map((m, i) => <li key={i}>{m}</li>)}
              </ul>
              <ul data-testid="cont-decisions" className="mt-1 list-disc pl-4 text-xs">
                {cont.decisions.map((d) => <li key={d.title}><span className="text-gray-500">[{d.impact}]</span> {d.title}</li>)}
              </ul>
            </section>
          )}

          <section className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">Unresolved evidence</h3>
            {cont.evidence.testFailures.length === 0 && cont.evidence.serverErrors.length === 0 && cont.evidence.failedTasks.length === 0 && cont.evidence.timedOutCommands.length === 0 && cont.evidence.openTrials.length === 0 && (
              <p data-testid="cont-evidence-empty" className="text-xs text-gray-500">No unresolved evidence.</p>
            )}
            <ul data-testid="cont-evidence" className="mt-1 list-disc pl-4 text-xs">
              {cont.evidence.testFailures.map((t, i) => <li key={`t${i}`} data-testid="cont-ev-fail">failed test: {t}</li>)}
              {cont.evidence.timedOutCommands.map((c, i) => <li key={`c${i}`} data-testid="cont-ev-timeout">timed out: {c}</li>)}
              {cont.evidence.serverErrors.map((s, i) => <li key={`s${i}`} data-testid="cont-ev-500">server error: {s}</li>)}
              {cont.evidence.openTrials.map((b) => <li key={b.id} data-testid="cont-ev-bug">recurring: {b.title}</li>)}
            </ul>
          </section>

          {cont.deployments.length > 0 && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Recent deployments</h3>
              <ul data-testid="cont-deployments" className="mt-1 space-y-0.5 text-xs">
                {cont.deployments.map((d, i) => (
                  <li key={i} data-testid="cont-deployment">
                    {d.version ?? 'v?'} · {d.environment} · {d.status}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
