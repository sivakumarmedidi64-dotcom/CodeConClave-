/**
 * CodeConClave — PKG-15 Security Operations Intelligence panel.
 * Honest, server-authoritative Security & Compliance Operational Intelligence:
 * Security Incident Response (#21), API Rate Limit Awareness (#22), Network
 * Resilience Checker (#23), Workspace Compliance Checker (#24). All reports are
 * advisory heuristics/aggregations with truthfulness state — never auto-applied
 * and never presented as proof.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

type Kind = 'SECURITY_INCIDENT' | 'RATE_LIMIT_AWARENESS' | 'NETWORK_RESILIENCE' | 'COMPLIANCE';

interface CapEntry {
  status: string;
  state: string;
  deterministic: boolean;
  needsProvider: boolean;
  description: string;
}
interface SecOpsCaps {
  capabilities: Record<Kind, CapEntry>;
  limitations: string[];
}

interface IncidentView {
  id: string;
  title: string;
  severity: string;
  status: string;
  responseAction: string;
  source: string | null;
  summary: string | null;
  createdAt: string;
}

interface RateLimitReport {
  id: string;
  projectId: string;
  generatedAt: string;
  totalEndpoints: number;
  rateLimitedEndpoints: number;
  uncoveredEndpoints: number;
  coveragePercent: number;
  failClosedEndpoints: number;
  failOpenEndpoints: number;
  overall: string;
  endpoints: { method: string; path: string; rateLimited: boolean; strategy: string; failClosed: boolean; state: string }[];
}

interface ResilienceReport {
  id: string;
  projectId: string;
  generatedAt: string;
  filesScanned: number;
  filesSkipped: number;
  score: number;
  findings: { facet: string; status: string; state: string; confidence: number; title: string; evidence: string }[];
}

interface ComplianceReport {
  id: string;
  projectId: string;
  generatedAt: string;
  overallScore: number;
  overallStatus: string;
  categories: { category: string; score: number; status: string; items: number; failing: number }[];
  items: { id: string; category: string; status: string; title: string; severity: string; remediation: string }[];
  postureLevel: string;
}

const KIND_LABEL: Record<Kind, string> = {
  SECURITY_INCIDENT: 'Security Incident Response',
  RATE_LIMIT_AWARENESS: 'API Rate Limit Awareness',
  NETWORK_RESILIENCE: 'Network Resilience Checker',
  COMPLIANCE: 'Workspace Compliance Checker',
};

const STATE_LABEL: Record<string, string> = {
  VERIFIED: 'verified',
  HEURISTIC: 'heuristic only',
  PROVIDER_REQUIRED: 'provider required',
  ENVIRONMENT_BLOCKED: 'environment-blocked',
  UNAVAILABLE: 'unavailable',
};

const ALL_KINDS: Kind[] = ['SECURITY_INCIDENT', 'RATE_LIMIT_AWARENESS', 'NETWORK_RESILIENCE', 'COMPLIANCE'];

export function SecurityOperationsPanel({ projectId }: { projectId: string }) {
  const [caps, setCaps] = useState<SecOpsCaps | null>(null);
  const [capsState, setCapsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [incidents, setIncidents] = useState<IncidentView[] | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitReport | null>(null);
  const [resilience, setResilience] = useState<ResilienceReport | null>(null);
  const [compliance, setCompliance] = useState<ComplianceReport | null>(null);

  const loadCaps = useCallback(async () => {
    setCapsState('loading');
    try {
      const c = await api<SecOpsCaps>('/api/v1/security-operations/capabilities');
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

  const run = useCallback(
    async (kind: Kind) => {
      setBusy(true);
      setError(null);
      try {
        if (kind === 'SECURITY_INCIDENT') {
          const list = await api<IncidentView[]>('/api/v1/security-operations/incidents?projectId=' + encodeURIComponent(projectId));
          setIncidents(list);
        } else if (kind === 'RATE_LIMIT_AWARENESS') {
          const rep = await api<RateLimitReport>('/api/v1/security-operations/rate-limit-awareness', {
            method: 'POST',
            body: { projectId },
          });
          setRateLimit(rep);
        } else if (kind === 'NETWORK_RESILIENCE') {
          const rep = await api<ResilienceReport>('/api/v1/security-operations/network-resilience', {
            method: 'POST',
            body: { projectId },
          });
          setResilience(rep);
        } else {
          const rep = await api<ComplianceReport>('/api/v1/security-operations/compliance', {
            method: 'POST',
            body: { projectId },
          });
          setCompliance(rep);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Assessment failed');
      } finally {
        setBusy(false);
      }
    },
    [projectId],
  );

  return (
    <div data-testid="secops-panel" className="space-y-4">
      <h2 className="text-lg font-semibold">Security & Compliance Operations</h2>

      <section data-testid="secops-capabilities" className="rounded border p-3">
        <h3 className="text-sm font-medium">Operational intelligence capabilities</h3>
        {capsState === 'loading' && <p data-testid="secops-caps-loading">Loading capability status…</p>}
        {capsState === 'error' && <p data-testid="secops-caps-error">Could not load capability status.</p>}
        {capsState === 'ready' && caps && (
          <div className="mt-2 space-y-2 text-sm">
            {ALL_KINDS.map((kind) => {
              const cap = caps.capabilities[kind];
              return (
                <div key={kind} data-testid={`secops-cap-${kind.toLowerCase()}`} className="flex items-start gap-2">
                  <button
                    data-testid={`secops-run-${kind.toLowerCase()}`}
                    className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void run(kind)}
                  >
                    {KIND_LABEL[kind]}
                  </button>
                  <div>
                    <div>
                      <span className="text-xs text-gray-500">
                        [{cap?.status ?? 'unknown'} · {STATE_LABEL[cap?.state ?? ''] ?? cap?.state ?? 'unknown'}]
                      </span>
                    </div>
                    <p data-testid={`secops-desc-${kind.toLowerCase()}`} className="text-xs text-gray-600">
                      {cap?.description ?? ''}
                    </p>
                  </div>
                </div>
              );
            })}
            <p data-testid="secops-honest" className="text-xs text-amber-700">
              Deterministic assessments and aggregations. Findings are advisory signals with truthfulness state —
              never proof and never auto-applied.
            </p>
          </div>
        )}
      </section>

      {error && <p data-testid="secops-error" className="text-sm text-red-600">{error}</p>}

      {incidents && (
        <section data-testid="secops-incidents" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">Incidents ({incidents.length})</h3>
          {incidents.length === 0 && <p className="text-xs text-gray-500">No incidents recorded for this project.</p>}
          <ul className="mt-2 space-y-1">
            {incidents.map((i) => (
              <li key={i.id} data-testid="secops-incident" className="rounded border p-2">
                <strong>[{i.severity}]</strong> {i.title}
                <span className="ml-2 text-xs text-gray-500">
                  {i.status} · {i.responseAction}
                  {i.source ? ` · ${i.source}` : ''}
                </span>
                {i.summary ? <p className="text-xs text-gray-600">Summary: {i.summary}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rateLimit && (
        <section data-testid="secops-rate-limit" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">
            API Rate Limit Awareness — {rateLimit.coveragePercent}% covered ({rateLimit.overall})
          </h3>
          <p className="text-xs text-gray-600">
            {rateLimit.rateLimitedEndpoints}/{rateLimit.totalEndpoints} endpoints rate limited ·{' '}
            {rateLimit.uncoveredEndpoints} uncovered · fail-closed {rateLimit.failClosedEndpoints}, fail-open{' '}
            {rateLimit.failOpenEndpoints}
          </p>
          {rateLimit.endpoints.length > 0 && (
            <ul className="mt-2 max-h-60 space-y-1 overflow-auto">
              {rateLimit.endpoints.map((e, idx) => (
                <li key={idx} data-testid="secops-endpoint" className="rounded border p-1 text-xs">
                  {e.method} {e.path} — {e.rateLimited ? `limited (${e.strategy})` : 'uncovered'} ·{' '}
                  {e.state === 'VERIFIED' ? 'verified' : 'heuristic'}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {resilience && (
        <section data-testid="secops-resilience" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">Network Resilience — score {resilience.score}/100</h3>
          <p className="text-xs text-gray-600">
            {resilience.filesScanned} files scanned · {resilience.filesSkipped} skipped
          </p>
          <ul className="mt-2 space-y-1">
            {resilience.findings.map((f) => (
              <li key={f.facet} data-testid="secops-facet" className="rounded border p-1 text-xs">
                <strong>[{f.status}]</strong> {f.facet} — {f.title}. {f.evidence} (
                {STATE_LABEL[f.state] ?? f.state}, {f.confidence})
              </li>
            ))}
          </ul>
        </section>
      )}

      {compliance && (
        <section data-testid="secops-compliance" className="rounded border p-3 text-sm">
          <h3 className="text-sm font-medium">
            Compliance — {compliance.overallStatus} ({compliance.overallScore}/100, posture {compliance.postureLevel})
          </h3>
          <div className="mt-1 flex flex-wrap gap-3 text-xs">
            {compliance.categories.map((c) => (
              <span key={c.category} data-testid={`secops-cat-${c.category.toLowerCase()}`}>
                {c.category}: {c.score} [{c.status}]
              </span>
            ))}
          </div>
          {compliance.items.length > 0 && (
            <ul className="mt-2 max-h-60 space-y-1 overflow-auto">
              {compliance.items.map((item) => (
                <li key={item.id} data-testid="secops-compliance-item" className="rounded border p-1 text-xs">
                  <strong>[{item.severity}]</strong> {item.title} ({item.category} — {item.status})
                  {item.remediation ? <p className="text-gray-600">Remediation: {item.remediation}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {caps?.limitations?.length ? (
        <p data-testid="secops-limitations" className="text-xs text-amber-700">
          {caps.limitations.join(' ')}
        </p>
      ) : null}
    </div>
  );
}