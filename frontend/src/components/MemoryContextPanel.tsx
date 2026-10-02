/**
 * CodeConClave — PKG-23 Memory-Aware Coding Context panel.
 * Shows the bounded, memory-aware context CodeConClave surfaces for the current
 * task. Every item is TAGGED so the user can distinguish:
 *   - CURRENT_CODE_EVIDENCE (read from live repo/runtime records),
 *   - MEMORY (persisted memory), and
 *   - INFERENCE (suggested pattern — never presented as certain).
 * Memory is advisory here and never overrides current repository evidence.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

export interface ContextItem {
  kind: 'CURRENT_CODE_EVIDENCE' | 'MEMORY' | 'INFERENCE';
  source: string;
  label: string;
  detail: string;
  confidence: number;
  ref?: string | null;
}

const KIND_LABEL: Record<ContextItem['kind'], string> = {
  CURRENT_CODE_EVIDENCE: 'EVIDENCE',
  MEMORY: 'MEMORY',
  INFERENCE: 'INFERENCE',
};

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback;
}

export function MemoryContextPanel({ projectId, file }: { projectId: string; file?: string | null }) {
  const [items, setItems] = useState<ContextItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const caps = await api<{ featureGateEnabled: boolean }>('/api/v1/memorycoding/capabilities');
      if (!caps.featureGateEnabled) {
        setItems([]);
        setState('disabled');
        return;
      }
      const params = new URLSearchParams({ projectId });
      if (file) params.set('file', file);
      const r = await api<{ items: ContextItem[] }>(`/api/v1/memorycoding/context?${params.toString()}`);
      setItems(r.items ?? []);
      setState('ready');
    } catch (e) {
      setItems([]);
      setState('error');
      setError(message(e, 'Memory context unavailable'));
    }
  }, [projectId, file]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div data-testid="memory-context-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Memory-Aware Context</h2>

      {state === 'disabled' && (
        <p data-testid="mc-disabled" className="text-sm text-amber-700">
          Memory coding is feature-gated OFF (AIOS_P2_MEMORY_CODING).
        </p>
      )}
      {state === 'loading' && <p data-testid="mc-loading">Building context…</p>}
      {state === 'error' && <p data-testid="mc-error" className="text-sm text-red-600">{error ?? 'Memory context unavailable'}</p>}

      {state === 'ready' && (
        <section className="rounded border p-3 text-sm">
          {items.length === 0 && <p data-testid="mc-empty" className="text-xs text-gray-500">No relevant context (bounded retrieval returned nothing).</p>}
          <ul data-testid="mc-items" className="space-y-2">
            {items.map((it, i) => (
              <li key={i} data-testid="mc-item" className="rounded border p-2 text-xs">
                <span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  it.kind === 'CURRENT_CODE_EVIDENCE' ? 'bg-green-100 text-green-800' : it.kind === 'MEMORY' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'
                }`} data-testid="mc-item-kind">
                  {KIND_LABEL[it.kind]}
                </span>
                <span className="font-medium">{it.label}</span>{' '}
                <span className="text-gray-400">(conf={(it.confidence * 100).toFixed(0)}%)</span>
                <p className="mt-0.5 text-gray-700">{it.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
