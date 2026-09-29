/**
 * CodeConClave — Production Intelligence (V4D).
 * Log analysis, correlation chains, monitoring, runbooks, cost tracking,
 * and budgets. Every value is server-derived; no client-side secrets.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';

type Tab = 'logs' | 'monitoring' | 'cost';

interface LogAnalysis {
  id: string;
  pattern: string;
  severity: string;
  source: string;
  message: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

interface CorrelationChain {
  correlationId: string;
  chain: Array<{ type: string; name: string; status: string; timestamp: string }>;
  userImpact: {
    severity: string;
    description: string;
    affectedUsers: string[];
    estimatedUsersAffected: number;
  };
  timeline: Array<{ timestamp: string; description: string }>;
}

interface Runbook {
  id: string;
  name: string;
  trigger: string;
  steps: string[];
  enabled: boolean;
  last_run: string | null;
}

interface MonitoringConfig {
  id: string;
  metric: string;
  threshold: number;
  window_seconds: number;
  action: string;
  enabled: boolean;
}

interface CostRecord {
  id: string;
  resource: string;
  cost_usd: number;
  period: string;
  recorded_at: string;
}

interface Budget {
  id: string;
  name: string;
  limit_usd: number;
  spent_usd: number;
  period: string;
  starts_at: string;
  ends_at: string;
}

export function ProductionPage() {
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('logs');
  const [projectId, setProjectId] = useState('default');
  const [projectInput, setProjectInput] = useState('default');

  const [logAnalyses, setLogAnalyses] = useState<LogAnalysis[]>([]);
  const [correlations, setCorrelations] = useState<CorrelationChain[]>([]);
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [monitoringConfigs, setMonitoringConfigs] = useState<MonitoringConfig[]>([]);
  const [costs, setCosts] = useState<CostRecord[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);

  const loadLogs = useCallback(async () => {
    const q = `?projectId=${encodeURIComponent(projectId)}`;
    const [la, cc] = await Promise.all([
      api<{
        result: {
          repeatedErrors?: Array<{
            errorMessage: string;
            count: number;
            firstSeen: string;
            lastSeen: string;
            severity: string;
            affectedEndpoints: string[];
          }>;
          anomalies?: Array<{
            type: string;
            description: string;
            severity: string;
            detectedAt: string;
          }>;
        };
      }>(`/api/v1/production-intelligence/logs/analyze${q}`, { method: 'POST' }),
      api<{ result: { chains?: CorrelationChain[] } }>(`/api/v1/production-intelligence/errors/correlate${q}`),
    ]);
    const analyses: LogAnalysis[] = [];
    for (const re of la.result?.repeatedErrors ?? []) {
      analyses.push({
        id: re.errorMessage,
        pattern: re.errorMessage,
        severity: re.severity,
        source: re.affectedEndpoints?.[0] ?? '',
        message: re.errorMessage,
        count: re.count,
        first_seen: re.firstSeen,
        last_seen: re.lastSeen,
      });
    }
    for (const an of la.result?.anomalies ?? []) {
      analyses.push({
        id: an.description,
        pattern: an.type,
        severity: an.severity,
        source: 'anomaly',
        message: an.description,
        count: 1,
        first_seen: an.detectedAt,
        last_seen: an.detectedAt,
      });
    }
    setLogAnalyses(analyses);
    setCorrelations(cc.result?.chains ?? []);
  }, [projectId]);

  const loadMonitoring = useCallback(async () => {
    const q = `?projectId=${encodeURIComponent(projectId)}`;
    const [rb, mc] = await Promise.all([
      api<{ runbooks: Runbook[] }>(`/api/v1/production-intelligence/runbooks${q}`),
      api<{
        config: {
          anomalyDetection?: { enabled: boolean; sensitivity: string; minDeviationPercent: number; minDurationMs: number };
          alertCorrelation?: { enabled: boolean; timeWindowMs: number; minConfidence: number };
          alertSuppression?: { enabled: boolean; duplicateWindowMs: number; correlationWindowMs: number };
          aiExplanation?: { enabled: boolean; detailLevel: string };
        };
      }>(`/api/v1/production-intelligence/monitoring/config${q}`),
    ]);
    setRunbooks(rb.runbooks ?? []);
    const cfg = mc.config;
    const configs: MonitoringConfig[] = [];
    if (cfg?.anomalyDetection) {
      configs.push({
        id: 'anomaly-detection',
        metric: 'Anomaly Detection',
        threshold: cfg.anomalyDetection.minDeviationPercent,
        window_seconds: Math.round(cfg.anomalyDetection.minDurationMs / 1000),
        action: cfg.anomalyDetection.sensitivity,
        enabled: cfg.anomalyDetection.enabled,
      });
    }
    if (cfg?.alertCorrelation) {
      configs.push({
        id: 'alert-correlation',
        metric: 'Alert Correlation',
        threshold: cfg.alertCorrelation.minConfidence,
        window_seconds: Math.round(cfg.alertCorrelation.timeWindowMs / 1000),
        action: 'correlate',
        enabled: cfg.alertCorrelation.enabled,
      });
    }
    if (cfg?.alertSuppression) {
      configs.push({
        id: 'alert-suppression',
        metric: 'Alert Suppression',
        threshold: cfg.alertSuppression.duplicateWindowMs,
        window_seconds: Math.round(cfg.alertSuppression.correlationWindowMs / 1000),
        action: 'suppress',
        enabled: cfg.alertSuppression.enabled,
      });
    }
    if (cfg?.aiExplanation) {
      configs.push({
        id: 'ai-explanation',
        metric: 'AI Explanation',
        threshold: 0,
        window_seconds: 0,
        action: cfg.aiExplanation.detailLevel,
        enabled: cfg.aiExplanation.enabled,
      });
    }
    setMonitoringConfigs(configs);
  }, [projectId]);

  const loadCost = useCallback(async () => {
    const q = `?projectId=${encodeURIComponent(projectId)}`;
    const [co, bu] = await Promise.all([
      api<{
        breakdown: {
          totalUsd: number;
          topCostDrivers?: Array<{
            category: string;
            provider?: string;
            usd: number;
            count: number;
            trend: string;
          }>;
        };
      }>(`/api/v1/production-intelligence/costs/breakdown${q}`),
      api<{ budgets: Budget[] }>(`/api/v1/production-intelligence/budgets${q}`),
    ]);
    const drivers = co.breakdown?.topCostDrivers ?? [];
    setCosts(
      drivers.map((d, i) => ({
        id: String(i),
        resource: d.provider ? `${d.category} (${d.provider})` : d.category,
        cost_usd: d.usd,
        period: d.trend,
        recorded_at: new Date().toISOString(),
      })),
    );
    setBudgets(bu.budgets ?? []);
  }, [projectId]);

  const load = useCallback(async () => {
    try {
      if (tab === 'logs') await loadLogs();
      else if (tab === 'monitoring') await loadMonitoring();
      else await loadCost();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  }, [tab, loadLogs, loadMonitoring, loadCost, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyProject = () => {
    const trimmed = projectInput.trim();
    if (trimmed && trimmed !== projectId) setProjectId(trimmed);
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'logs', label: 'Log Analysis' },
    { key: 'monitoring', label: 'Monitoring' },
    { key: 'cost', label: 'Cost Analysis' },
  ];

  return (
    <div className="cc-page">
      <h1>Production Intelligence</h1>
      <p className="cc-hint">
        Log analysis, correlation chains, monitoring configuration, runbooks, cost tracking and budgets for a project.
        All data is fetched server-side — no secrets are exposed to the client.
      </p>

      <div className="cc-card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="cc-input"
          style={{ flex: 1, minWidth: 180 }}
          aria-label="Project ID"
          placeholder="Project ID"
          value={projectInput}
          onChange={(e) => setProjectInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyProject(); }}
        />
        <button className="cc-btn cc-btn--sm" onClick={applyProject}>Load project</button>
        <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>Active: {projectId}</span>
      </div>

      <div className="cc-card" style={{ display: 'flex', gap: 0 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`cc-btn cc-btn--sm${tab === t.key ? '' : ' cc-btn--ghost'}`}
            style={{ borderRadius: 0 }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
        <button className="cc-btn cc-btn--ghost cc-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>
          Reload
        </button>
      </div>

      {tab === 'logs' && (
        <>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="pi-log-analyses">
            <h3 style={{ margin: 0 }}>Log analyses</h3>
            {logAnalyses.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No log analyses for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {logAnalyses.slice(0, 25).map((a) => (
                  <li key={a.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: a.severity === 'CRITICAL' ? '#dc2626' : a.severity === 'HIGH' ? '#ea580c' : '#334155', color: '#fff' }}>
                      {a.severity}
                    </span>
                    <span style={{ fontWeight: 600 }}>{a.pattern}</span>
                    <span className="cc-hint">{a.source}</span>
                    <span>{a.count}×</span>
                    <span className="cc-hint">{a.message.slice(0, 80)}{a.message.length > 80 ? '…' : ''}</span>
                    <span className="cc-hint">{new Date(a.first_seen).toLocaleString()} → {new Date(a.last_seen).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="pi-correlations">
            <h3 style={{ margin: 0 }}>Correlation chains</h3>
            {correlations.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No correlation chains for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {correlations.map((c) => (
                  <li key={c.correlationId} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10 }}>{c.userImpact.severity}</span>
                    <span>{c.userImpact.description}</span>
                    <span className="cc-hint">{c.chain.length} event(s)</span>
                    <span className="cc-hint">{c.userImpact.estimatedUsersAffected} user(s) affected</span>
                    {c.timeline[0] && <span className="cc-hint">{new Date(c.timeline[0].timestamp).toLocaleString()}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {tab === 'monitoring' && (
        <>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="pi-runbooks">
            <h3 style={{ margin: 0 }}>Runbooks</h3>
            {runbooks.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No runbooks for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {runbooks.map((r) => (
                  <li key={r.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: r.enabled ? '#16a34a' : '#64748b', color: '#fff' }}>
                      {r.enabled ? 'enabled' : 'disabled'}
                    </span>
                    <span style={{ fontWeight: 600 }}>{r.name}</span>
                    <span className="cc-hint">trigger: {r.trigger}</span>
                    <span className="cc-hint">{r.steps.length} step(s)</span>
                    {r.last_run && <span className="cc-hint">last run: {new Date(r.last_run).toLocaleString()}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="pi-monitoring-config">
            <h3 style={{ margin: 0 }}>Monitoring config</h3>
            {monitoringConfigs.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No monitoring configurations for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {monitoringConfigs.map((m) => (
                  <li key={m.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: m.enabled ? '#2563eb' : '#64748b', color: '#fff' }}>
                      {m.enabled ? 'active' : 'off'}
                    </span>
                    <span style={{ fontWeight: 600 }}>{m.metric}</span>
                    <span>threshold: {m.threshold}</span>
                    <span className="cc-hint">window: {m.window_seconds}s</span>
                    <span className="cc-hint">action: {m.action}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {tab === 'cost' && (
        <>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="pi-costs">
            <h3 style={{ margin: 0 }}>Costs</h3>
            {costs.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No cost records for this project.</p>
            ) : (
              <>
                <p className="cc-hint" style={{ margin: 0 }}>
                  Total: ${costs.reduce((s, c) => s + c.cost_usd, 0).toFixed(2)} across {costs.length} record(s)
                </p>
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
                  {costs.slice(0, 50).map((c) => (
                    <li key={c.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>{c.resource}</span>
                      <span>${c.cost_usd.toFixed(4)}</span>
                      <span className="cc-pill" style={{ fontSize: 10 }}>{c.period}</span>
                      <span className="cc-hint">{new Date(c.recorded_at).toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="pi-budgets">
            <h3 style={{ margin: 0 }}>Budgets</h3>
            {budgets.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No budgets for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {budgets.map((b) => {
                  const pct = b.limit_usd > 0 ? Math.min((b.spent_usd / b.limit_usd) * 100, 100) : 0;
                  const over = b.spent_usd > b.limit_usd;
                  return (
                    <li key={b.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{b.name}</span>
                        <span className="cc-pill" style={{ fontSize: 10, background: over ? '#dc2626' : '#334155', color: '#fff' }}>
                          ${b.spent_usd.toFixed(2)} / ${b.limit_usd.toFixed(2)}
                        </span>
                        <span className="cc-pill" style={{ fontSize: 10 }}>{b.period}</span>
                        <span className="cc-hint" style={{ fontSize: 11 }}>{new Date(b.starts_at).toLocaleDateString()} — {new Date(b.ends_at).toLocaleDateString()}</span>
                      </div>
                      <div className="cc-hint" style={{ width: '100%', height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: over ? '#dc2626' : '#3b82f6', borderRadius: 3 }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
