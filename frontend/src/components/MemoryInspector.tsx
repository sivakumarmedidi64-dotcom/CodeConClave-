/**
 * CodeConClave — PKG-23 Memory Inspector panel.
 * Bounded, filterable view of the persistent developer records:
 * preferences (EXPLICIT/INFERRED classification), learned patterns with
 * evidence/confidence/status, recurring-bug incidents, and memory links.
 * Honest: if the feature is gated OFF the panel says so (feature-disabled) and
 * reports UNAVAILABLE rather than faking data.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

export interface MemoryInspectorData {
  stats: Record<string, number>;
  preferences: Array<{ id: string; category: string; key: string; value: Record<string, unknown>; classification: string; confidence: number; source: string | null }>;
  patterns: Array<{ id: string; name: string; description: string; evidence_count: number; confirm_count: number; reject_count: number; confidence: number; status: string }>;
  bugs: Array<{ id: string; title: string; symptom_key: string; occurrences: number; status: string; diagnosis: string | null; fix_summary: string | null }>;
  links: Array<{ id: string; kind: string; from_ref: string; to_ref: string }>;
  summary: { activePatterns: number; openBugs: number; explicitPreferences: number; inferredPreferences: number };
}

type Category = 'all' | 'preferences' | 'patterns' | 'bugs' | 'links';

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

export function MemoryInspector({ projectId }: { projectId: string }) {
  const [insp, setInsp] = useState<MemoryInspectorData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [category, setCategory] = useState<Category>('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const caps = await api<{ featureGateEnabled: boolean }>('/api/v1/memorycoding/capabilities');
      if (!caps.featureGateEnabled) {
        setInsp(null);
        setState('disabled');
        return;
      }
      const data = await api<MemoryInspectorData>(
        `/api/v1/memorycoding/inspector?projectId=${encodeURIComponent(projectId)}&category=${category}&limit=50`,
      );
      setInsp(data);
      setState('ready');
    } catch (e) {
      setInsp(null);
      setState('error');
      setError(message(e, 'Memory inspector unavailable'));
    }
  }, [projectId, category]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid="memory-inspector" className="space-y-4">
      <h2 className="text-lg font-semibold">Memory Inspector</h2>

      {state === 'disabled' && (
        <p data-testid="mi-disabled" className="text-sm text-amber-700">
          Memory coding is feature-gated OFF (AIOS_P2_MEMORY_CODING). No records shown.
        </p>
      )}
      {state === 'loading' && <p data-testid="mi-loading">Loading inspector…</p>}
      {state === 'error' && <p data-testid="mi-error" className="text-sm text-red-600">{error ?? 'Memory inspector unavailable'}</p>}

      {state === 'ready' && insp && (
        <>
          <div className="flex gap-2 text-xs">
            {(['all', 'preferences', 'patterns', 'bugs', 'links'] as Category[]).map((c) => (
              <button
                key={c}
                data-testid={`mi-cat-${c}`}
                onClick={() => setCategory(c)}
                className={`rounded border px-2 py-0.5 ${category === c ? 'bg-blue-600 text-white' : ''}`}
              >
                {c}
              </button>
            ))}
          </div>

          <section data-testid="mi-summary" className="rounded border p-3 text-sm">
            <h3 className="text-sm font-medium">Summary</h3>
            <ul data-testid="mi-stats" className="mt-1 list-disc pl-4 text-xs text-gray-700">
              <li>Active patterns: {insp.summary.activePatterns}</li>
              <li>Open bug incidents: {insp.summary.openBugs}</li>
              <li>Preferences — explicit: {insp.summary.explicitPreferences} · inferred: {insp.summary.inferredPreferences}</li>
            </ul>
          </section>

          {(category === 'all' || category === 'preferences') && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Preferences</h3>
              {insp.preferences.length === 0 && <p data-testid="mi-prefs-empty" className="text-xs text-gray-500">No preferences recorded.</p>}
              <ul data-testid="mi-prefs" className="mt-1 space-y-1 text-xs">
                {insp.preferences.map((p) => (
                  <li key={p.id} data-testid="mi-pref">
                    <span className="font-medium">{p.category}/{p.key}</span>{' '}
                    <span className="text-gray-500">[{p.classification}] conf={p.confidence}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(category === 'all' || category === 'patterns') && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Learned patterns</h3>
              {insp.patterns.length === 0 && <p data-testid="mi-patterns-empty" className="text-xs text-gray-500">No active patterns.</p>}
              <ul data-testid="mi-patterns" className="mt-1 space-y-1 text-xs">
                {insp.patterns.map((p) => (
                  <li key={p.id} data-testid="mi-pattern">
                    <span className="font-medium">{p.name}</span>{' '}
                    <span className="text-gray-500">[{p.status}] evidence={p.evidence_count} confirm={p.confirm_count} reject={p.reject_count} conf={(p.confidence * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(category === 'all' || category === 'bugs') && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Recurring bug incidents</h3>
              {insp.bugs.length === 0 && <p data-testid="mi-bugs-empty" className="text-xs text-gray-500">No bug incidents.</p>}
              <ul data-testid="mi-bugs" className="mt-1 space-y-1 text-xs">
                {insp.bugs.map((b) => (
                  <li key={b.id} data-testid="mi-bug">
                    <span className="font-medium">{b.title}</span>{' '}
                    <span className="text-gray-500">[{b.status}] x{b.occurrences}</span>
                    {b.fix_summary && <p className="text-green-700">fix: {b.fix_summary}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(category === 'all' || category === 'links') && (
            <section className="rounded border p-3 text-sm">
              <h3 className="text-sm font-medium">Memory links</h3>
              {insp.links.length === 0 && <p data-testid="mi-links-empty" className="text-xs text-gray-500">No links recorded.</p>}
              <ul data-testid="mi-links" className="mt-1 space-y-1 text-xs">
                {insp.links.map((l) => (
                  <li key={l.id} data-testid="mi-link">
                    <span className="font-medium">{l.kind}</span> {l.from_ref} → {l.to_ref}
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
