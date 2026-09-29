/**
 * CodeConClave — PKG-13 Visual Intelligence panel.
 * Honest, capability-aware visual analysis. Shows the real provider status
 * (vision/OCR/pixel-comparison — often environment-blocked on self-hosted
 * deployments) and never implies real vision where none exists. Image intake is
 * by an already-uploaded file id (the standard /api/v1/files upload keeps full
 * security/isolation); analysis is advisory-only and code proposals always
 * require B1 cowork review.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

interface ProviderCapabilities {
  vision: string;
  ocr: string;
  multimodal: string;
  pixelComparison: string;
  screenshotUnderstanding: string;
  visualDebugging: string;
  uiToCode: string;
  uiAnalysis: string;
  limitations: string[];
  details: { realProvider: boolean };
}

interface AnalysisResult {
  id: string;
  type: string;
  state: string;
  provider: string;
  confidence: number;
  limitations: string[];
  findings: { id: string; type: string; severity: string; title: string; description: string; confidence: number; evidence: string }[];
  metadata: { format: string; width: number | null; height: number | null; fileSizeBytes: number } | null;
}

const CAP_LABEL: Record<string, string> = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
  NOT_IMPLEMENTED: 'not implemented',
};

const STATE_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  HEURISTIC: 'heuristic only',
  PROVIDER_REQUIRED: 'provider required',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
  UNAVAILABLE: 'unavailable',
};

export function VisualIntelligencePanel({ projectId, defaultFileId = '' }: { projectId: string; defaultFileId?: string }) {
  const [caps, setCaps] = useState<ProviderCapabilities | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [fileId, setFileId] = useState<string>(defaultFileId);
  const [analysisType, setAnalysisType] = useState('SCREENSHOT');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [proposal, setProposal] = useState<{ code: string; riskLevel: string; reviewRequired: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const c = await api<ProviderCapabilities>('/api/v1/visual-intelligence/capabilities');
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

  const analyze = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProposal(null);
    try {
      const r = await api<AnalysisResult>('/api/v1/visual-intelligence/analyze', {
        method: 'POST',
        body: { imageFileId: fileId, projectId, analysisType },
      });
      setResult(r);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setBusy(false);
    }
  }, [fileId, projectId, analysisType]);

  const makeProposal = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ code: string; riskLevel: string; reviewRequired: boolean; evidence: string[]; assumptions: string[] }>(
        '/api/v1/visual-intelligence/code-proposal',
        { method: 'POST', body: { imageFileId: fileId, projectId, analysisType } },
      );
      setProposal(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Proposal generation failed');
    } finally {
      setBusy(false);
    }
  }, [fileId, projectId, analysisType]);

  return (
    <div data-testid="visual-intelligence-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Visual Intelligence</h2>

      <section data-testid="vi-capabilities" className="rounded border p-3">
        <h3 className="text-sm font-medium">Provider capabilities</h3>
        {capsState === 'loading' && <p data-testid="vi-caps-loading">Loading capability status…</p>}
        {capsState === 'error' && <p data-testid="vi-caps-error">Could not load provider status.</p>}
        {capsState === 'ready' && caps && (
          <ul className="mt-2 space-y-1 text-sm">
            <li data-testid="vi-cap-vision">
              Vision: <strong>{CAP_LABEL[caps.vision] ?? caps.vision}</strong>
            </li>
            <li data-testid="vi-cap-ocr">
              OCR: <strong>{CAP_LABEL[caps.ocr] ?? caps.ocr}</strong>
            </li>
            <li data-testid="vi-cap-multimodal">
              Multimodal: <strong>{CAP_LABEL[caps.multimodal] ?? caps.multimodal}</strong>
            </li>
            <li data-testid="vi-cap-pixels">
              Pixel comparison: <strong>{CAP_LABEL[caps.pixelComparison] ?? caps.pixelComparison}</strong>
            </li>
            {!caps.details?.realProvider && (
              <li data-testid="vi-honest" className="text-amber-700">
                No real vision provider is configured on this server. Screenshot/visual-debugging results are
                environment-blocked and never fabricated.
              </li>
            )}
            {caps.limitations?.slice(0, 2).map((l, i) => (
              <li key={i} className="text-xs text-gray-500">
                {l}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm">
            Image file id
            <input
              data-testid="vi-file-id"
              className="mt-1 rounded border px-2 py-1"
              value={fileId}
              onChange={(e) => setFileId(e.target.value)}
              placeholder="fil_..."
            />
          </label>
          <label className="flex flex-col text-sm">
            Analysis type
            <select
              data-testid="vi-analysis-type"
              className="mt-1 rounded border px-2 py-1"
              value={analysisType}
              onChange={(e) => setAnalysisType(e.target.value)}
            >
              <option value="SCREENSHOT">Screenshot</option>
              <option value="UI">UI</option>
              <option value="METADATA">Metadata</option>
            </select>
          </label>
          <button
            data-testid="vi-analyze"
            className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            onClick={() => void analyze()}
            disabled={busy || !fileId}
          >
            Analyze
          </button>
          <button
            data-testid="vi-proposal"
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
            onClick={() => void makeProposal()}
            disabled={busy || !fileId}
          >
            Code proposal (B1 review)
          </button>
        </div>

        {error && <p data-testid="vi-error" className="mt-2 text-sm text-red-600">{error}</p>}

        {result && (
          <div data-testid="vi-result" className="mt-3 text-sm">
            <div className="flex gap-4">
              <span>
                State: <strong data-testid="vi-state">{STATE_LABEL[result.state] ?? result.state}</strong>
              </span>
              <span>
                Provider: <strong>{result.provider}</strong>
              </span>
              <span>Confidence: {result.confidence}</span>
            </div>
            {result.metadata && (
              <p className="mt-1 text-xs text-gray-500">
                {result.metadata.width ?? '?'}x{result.metadata.height ?? '?'} {result.metadata.format} (
                {result.metadata.fileSizeBytes} bytes)
              </p>
            )}
            {result.findings?.length > 0 && (
              <ul className="mt-2 space-y-1">
                {result.findings.map((f) => (
                  <li key={f.id} data-testid="vi-finding">
                    <strong>[{f.severity}]</strong> {f.title} — {f.description}
                    {f.evidence ? <span className="text-xs text-gray-500"> ({f.evidence})</span> : null}
                  </li>
                ))}
              </ul>
            )}
            {result.limitations?.length > 0 && (
              <p data-testid="vi-limitations" className="mt-2 text-xs text-amber-700">
                {result.limitations.join(' ')}
              </p>
            )}
          </div>
        )}

        {proposal && (
          <div data-testid="vi-proposal-result" className="mt-3 text-sm">
            <p>
              <strong>Advisory proposal</strong> — risk {proposal.riskLevel}; review required:{' '}
              {String(proposal.reviewRequired)}. Never auto-applied.
            </p>
            <pre data-testid="vi-proposal-code" className="mt-2 overflow-auto rounded bg-slate-100 p-2 text-xs">
              {proposal.code}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
