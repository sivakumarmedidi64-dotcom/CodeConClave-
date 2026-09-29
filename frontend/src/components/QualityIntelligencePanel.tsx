/**
 * CodeConClave — PKG-14 Quality Intelligence panel.
 * Honest, server-authoritative static code-quality & correctness analysis
 * (Code Smell #6, Concurrency #7, Memory Leak #8, Type Safety #9, Invariant
 * #10). Findings are advisory heuristics with confidence + truthfulness state —
 * never auto-applied and never presented as proven bugs.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

type Kind = 'CODE_SMELL' | 'CONCURRENCY' | 'MEMORY_LEAK' | 'TYPE_SAFETY' | 'INVARIANT';

interface CapEntry {
  status: string;
  state: string;
  deterministic: boolean;
  needsProvider: boolean;
  description: string;
}
interface QualityCaps {
  capabilities: Record<Kind, CapEntry>;
  limitations: string[];
}

interface Finding {
  id: string;
  kind: Kind;
  filePath: string;
  line: number | null;
  rule: string;
  severity: string;
  title: string;
  description: string;
  confidence: number;
  state: string;
  evidence: string;
  suggestion: string;
}
interface AnalysisResult {
  id: string;
  projectId: string;
  kinds: Kind[];
  files: { fileId: string; path: string; analyzed: boolean; reason?: string }[];
  findings: Finding[];
  totals: Record<string, number>;
  byKind: Record<Kind, { findings: number; bySeverity: Record<string, number> }>;
  limitations?: string[];
}

const KIND_LABEL: Record<Kind, string> = {
  CODE_SMELL: 'Code Smell Agent',
  CONCURRENCY: 'Concurrent Bug Detector',
  MEMORY_LEAK: 'Memory Leak Hunter',
  TYPE_SAFETY: 'Type Safety Enhancer',
  INVARIANT: 'Invariant Keeper',
};

const STATE_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  HEURISTIC: 'heuristic only',
  PROVIDER_REQUIRED: 'provider required',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
  UNAVAILABLE: 'unavailable',
};

const ALL_KINDS: Kind[] = ['CODE_SMELL', 'CONCURRENCY', 'MEMORY_LEAK', 'TYPE_SAFETY', 'INVARIANT'];

export function QualityIntelligencePanel({ projectId, defaultKinds }: { projectId: string; defaultKinds?: Kind[] }) {
  const [caps, setCaps] = useState<QualityCaps | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selected, setSelected] = useState<Set<Kind>>(new Set(defaultKinds ?? ALL_KINDS));
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const c = await api<QualityCaps>('/api/v1/quality-intelligence/capabilities');
      setCaps(c);
      setCapsState('ready');
    } catch {
      setCaps(null);
      setCapsState('error');
    }
  }, []);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  const toggle = useCallback((kind: Kind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const analyze = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const kinds = [...selected];
      const body: Record<string, unknown> = { projectId };
      if (kinds.length < ALL_KINDS.length) body.kinds = kinds;
      const r = await api<AnalysisResult>('/api/v1/quality-intelligence/analyze', {
        method: 'POST',
        body,
      });
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setBusy(false);
    }
  }, [selected, projectId]);

  return (
    <div data-testid="quality-intelligence-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Quality Intelligence</h2>

      <section data-testid="qi-capabilities" className="rounded border p-3">
        <h3 className="text-sm font-medium">Analyzer capabilities</h3>
        {capsState === 'loading' && <p data-testid="qi-caps-loading">Loading capability status…</p>}
        {capsState === 'error' && <p data-testid="qi-caps-error">Could not load analyzer status.</p>}
        {capsState === 'ready' && caps && (
          <div className="mt-2 space-y-2 text-sm">
            {ALL_KINDS.map((kind) => {
              const cap = caps.capabilities[kind];
              return (
                <div key={kind} data-testid={`qi-cap-${kind.toLowerCase()}`} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid={`qi-toggle-${kind.toLowerCase()}`}
                    checked={selected.has(kind)}
                    onChange={() => toggle(kind)}
                  />
                  <div>
                    <strong>{KIND_LABEL[kind]}</strong>{' '}
                    <span className="text-xs text-gray-500">
                      [{cap?.status ?? 'unknown'} · {STATE_LABEL[cap?.state ?? ''] ?? cap?.state ?? 'unknown'}]
                    </span>
                    <p data-testid={`qi-desc-${kind.toLowerCase()}`} className="text-xs text-gray-600">
                      {cap?.description ?? ''}
                    </p>
                  </div>
                </div>
              );
            })}
            <p data-testid="qi-honest" className="text-xs text-amber-700">
              Static source-text heuristics only. Findings are advisory signals with confidence + truthfulness
              state — never proof and never auto-applied.
            </p>
          </div>
        )}
      </section>

      <section className="rounded border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <button
            data-testid="qi-analyze"
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            onClick={() => void analyze()}
            disabled={busy || selected.size === 0}
          >
            Analyze selected analyzers
          </button>
        </div>

        {error && <p data-testid="qi-error" className="mt-2 text-sm text-red-600">{error}</p>}

        {result && (
          <div data-testid="qi-result" className="mt-3 text-sm">
            <div className="flex gap-4">
              <span>
                Files analyzed:{' '}
                <strong>{result.files?.filter((f) => f.analyzed).length ?? 0}</strong> / {result.files?.length ?? 0}
              </span>
              <span>
                Findings: <strong data-testid="qi-findings-total">{result.findings?.length ?? 0}</strong>
              </span>
            </div>

            {result.byKind && (
              <div className="mt-2 flex flex-wrap gap-4 text-xs">
                {ALL_KINDS.map((k) => {
                  const bk = result.byKind[k];
                  if (!bk) return null;
                  return (
                    <span key={k} data-testid={`qi-kind-${k.toLowerCase()}`}>
                      {KIND_LABEL[k]}: {bk.findings}
                    </span>
                  );
                })}
              </div>
            )}

            {result.findings && result.findings.length > 0 && (
              <ul className="mt-3 max-h-80 space-y-1 overflow-auto">
                {result.findings.map((f) => (
                  <li key={f.id} data-testid="qi-finding" className="rounded border p-2">
                    <div>
                      <strong>[{f.severity}]</strong> {f.title}
                      <span className="ml-2 text-xs text-gray-500">
                        {f.filePath}
                        {f.line != null ? `:${f.line}` : ''}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600">
                      {f.description} — state {STATE_LABEL[f.state] ?? f.state}, confidence {f.confidence}
                    </p>
                    {f.evidence ? <p className="text-xs text-gray-400">Evidence: {f.evidence}</p> : null}
                  </li>
                ))}
              </ul>
            )}

            {caps?.limitations?.length ? (
              <p data-testid="qi-limitations" className="mt-2 text-xs text-amber-700">
                {caps.limitations.join(' ')}
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
