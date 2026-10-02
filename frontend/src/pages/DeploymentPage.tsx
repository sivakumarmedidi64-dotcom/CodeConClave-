/**
 * CodeConClave — Deployment Wizard (V4E).
 * Discovery, deployment planning, strategy selection and rollback/reporting.
 * All data is server-derived: no secrets are stored client-side.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';

type Tab = 'discovery' | 'plan' | 'rollback';

const TABS: { key: Tab; label: string }[] = [
  { key: 'discovery', label: 'Discovery' },
  { key: 'plan', label: 'Deployment Plan' },
  { key: 'rollback', label: 'Rollback' },
];

interface DiscoverResult {
  env: string;
  version: string;
  timestamp: string;
  resources: { name: string; kind: string; status: string }[];
}

interface ReadinessResult {
  ready: boolean;
  checks: { name: string; passed: boolean; message: string }[];
}

interface PlanResult {
  planId: string;
  steps: { order: number; action: string; target: string; risk: string }[];
  estimatedDuration: string;
}

interface StrategyResult {
  strategy: string;
  rolloutPercent: number;
  criteria: { metric: string; threshold: number }[];
  pauseOnFailure: boolean;
}

interface RollbackResult {
  triggered: boolean;
  rollbackId: string;
  previousVersion: string;
  message: string;
}

interface ReportResult {
  reportId: string;
  summary: string;
  deployments: { id: string; version: string; status: string; timestamp: string }[];
}

export function DeploymentPage() {
  const { toast } = useToast();

  const [projectId, setProjectId] = useState('default');
  const [tab, setTab] = useState<Tab>('discovery');
  const [busy, setBusy] = useState(false);

  const [discovery, setDiscovery] = useState<DiscoverResult | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [strategy, setStrategy] = useState<StrategyResult | null>(null);
  const [rollback, setRollback] = useState<RollbackResult | null>(null);
  const [report, setReport] = useState<ReportResult | null>(null);

  const pid = encodeURIComponent(projectId.trim() || 'default');

  const fetchDiscovery = useCallback(async () => {
    const [d, r] = await Promise.all([
      api<DiscoverResult>(`/api/v1/deployment-wizard/${pid}/discover`, { method: 'POST' }),
      api<ReadinessResult>(`/api/v1/deployment-wizard/${pid}/readiness`, { method: 'POST' }),
    ]);
    setDiscovery(d);
    setReadiness(r);
  }, [pid]);

  const fetchPlan = useCallback(async () => {
    const [p, s] = await Promise.all([
      api<PlanResult>(`/api/v1/deployment-wizard/${pid}/plan`, { method: 'POST' }),
      api<StrategyResult>(`/api/v1/deployment-wizard/${pid}/strategy`, { method: 'POST' }),
    ]);
    setPlan(p);
    setStrategy(s);
  }, [pid]);

  const fetchRollback = useCallback(async () => {
    const [rb, rp] = await Promise.all([
      api<RollbackResult>(`/api/v1/deployment-wizard/${pid}/rollback`, { method: 'POST' }),
      api<ReportResult>(`/api/v1/deployment-wizard/${pid}/report`, { method: 'POST' }),
    ]);
    setRollback(rb);
    setReport(rp);
  }, [pid]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      if (tab === 'discovery') await fetchDiscovery();
      else if (tab === 'plan') await fetchPlan();
      else await fetchRollback();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load deployment data', 'error');
    } finally {
      setBusy(false);
    }
  }, [tab, fetchDiscovery, fetchPlan, fetchRollback, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="cc-page">
      <h1>Deployment Wizard</h1>
      <p className="cc-hint">
        Discover project environment, generate a deployment plan with strategy selection and rollback / reporting.
        All values are server-derived.
      </p>

      <div className="cc-card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label className="cc-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Project ID
          <input
            className="cc-input"
            aria-label="Project ID"
            placeholder="default"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </label>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()} disabled={busy}>Reload</button>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }} role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`cc-btn cc-btn--sm${tab === t.key ? '' : ' cc-btn--ghost'}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {busy && <p className="cc-hint">Loading…</p>}

      {tab === 'discovery' && !busy && (
        <>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="deploy-discovery">
            <h3 style={{ margin: 0 }}>Environment discovery</h3>
            {discovery ? (
              <>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Version: <span className="cc-mono">{discovery.version}</span> · Env: <span className="cc-mono">{discovery.env}</span> · {new Date(discovery.timestamp).toLocaleString()}
                </p>
                {discovery.resources.length === 0 ? (
                  <p className="cc-hint" style={{ margin: 0 }}>No resources found.</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {discovery.resources.map((res, i) => (
                      <li key={i} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                        <span className="cc-pill" style={{ fontSize: 10 }}>{res.kind}</span>
                        <span>{res.name}</span>
                        <span className="cc-hint">{res.status}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No discovery data yet.</p>
            )}
          </div>

          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="deploy-readiness">
            <h3 style={{ margin: 0 }}>Readiness checks</h3>
            {readiness ? (
              <>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Overall: <span className="cc-pill" style={{ fontSize: 10, background: readiness.ready ? '#16a34a' : '#dc2626', color: '#fff' }}>{readiness.ready ? 'READY' : 'NOT READY'}</span>
                </p>
                {readiness.checks.length === 0 ? (
                  <p className="cc-hint" style={{ margin: 0 }}>No checks recorded.</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {readiness.checks.map((ck, i) => (
                      <li key={i} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                        <span className="cc-pill" style={{ fontSize: 10, background: ck.passed ? '#16a34a' : '#dc2626', color: '#fff' }}>{ck.passed ? 'PASS' : 'FAIL'}</span>
                        <span>{ck.name}</span>
                        <span className="cc-hint">{ck.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No readiness data yet.</p>
            )}
          </div>
        </>
      )}

      {tab === 'plan' && !busy && (
        <>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="deploy-plan">
            <h3 style={{ margin: 0 }}>Deployment plan</h3>
            {plan ? (
              <>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Plan <span className="cc-mono">{plan.planId}</span> · Est. duration: <span className="cc-mono">{plan.estimatedDuration}</span>
                </p>
                {plan.steps.length === 0 ? (
                  <p className="cc-hint" style={{ margin: 0 }}>No steps generated.</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {plan.steps.map((step) => (
                      <li key={step.order} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                        <span className="cc-pill" style={{ fontSize: 10 }}>{step.order}</span>
                        <span>{step.action}</span>
                        <span className="cc-hint">{step.target}</span>
                        <span className="cc-pill" style={{ fontSize: 10, background: step.risk === 'HIGH' || step.risk === 'CRITICAL' ? '#dc2626' : '#334155', color: '#fff' }}>{step.risk}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No plan generated yet.</p>
            )}
          </div>

          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="deploy-strategy">
            <h3 style={{ margin: 0 }}>Strategy</h3>
            {strategy ? (
              <>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Strategy: <span className="cc-mono">{strategy.strategy}</span> · Rollout: <span className="cc-mono">{strategy.rolloutPercent}%</span> · Pause on failure: <span className="cc-mono">{strategy.pauseOnFailure ? 'yes' : 'no'}</span>
                </p>
                {strategy.criteria.length === 0 ? (
                  <p className="cc-hint" style={{ margin: 0 }}>No success criteria defined.</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {strategy.criteria.map((c, i) => (
                      <li key={i} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                        <span>{c.metric}</span>
                        <span className="cc-pill" style={{ fontSize: 10 }}>≤ {c.threshold}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No strategy data yet.</p>
            )}
          </div>
        </>
      )}

      {tab === 'rollback' && !busy && (
        <>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="deploy-rollback">
            <h3 style={{ margin: 0 }}>Rollback</h3>
            {rollback ? (
              <p className="cc-hint" style={{ margin: 0 }}>
                <span className="cc-pill" style={{ fontSize: 10, background: rollback.triggered ? '#dc2626' : '#16a34a', color: '#fff' }}>{rollback.triggered ? 'TRIGGERED' : 'NOT TRIGGERED'}</span>
                <span className="cc-mono" style={{ marginLeft: 8 }}>{rollback.rollbackId}</span>
                <span style={{ marginLeft: 8 }}>Previous version: <span className="cc-mono">{rollback.previousVersion}</span></span>
                <span className="cc-hint" style={{ marginLeft: 8 }}>{rollback.message}</span>
              </p>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No rollback data yet.</p>
            )}
          </div>

          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="deploy-report">
            <h3 style={{ margin: 0 }}>Deployment report</h3>
            {report ? (
              <>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Report <span className="cc-mono">{report.reportId}</span>: {report.summary}
                </p>
                {report.deployments.length === 0 ? (
                  <p className="cc-hint" style={{ margin: 0 }}>No deployment history.</p>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {report.deployments.map((d) => (
                      <li key={d.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8 }}>
                        <span className="cc-pill" style={{ fontSize: 10 }}>{d.status}</span>
                        <span>{d.version}</span>
                        <span className="cc-hint">{new Date(d.timestamp).toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No report data yet.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
