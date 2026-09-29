/**
 * CodeConClave — Intelligence plane (V4A / V4B / V4C).
 * Engineering Intelligence, Developer Productivity, and Security Intelligence
 * modules. All data is server-derived; no client-side secret handling.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';

type Tab = 'engineering' | 'developer' | 'security';
const TABS: { key: Tab; label: string }[] = [
  { key: 'engineering', label: 'Engineering Intelligence' },
  { key: 'developer', label: 'Developer Productivity' },
  { key: 'security', label: 'Security Intelligence' },
];

interface RefactoringPlan {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  estimated_hours: number | null;
  created_at: string;
}

interface TechnicalDebt {
  id: string;
  category: string;
  description: string;
  severity: string;
  file_path: string | null;
  created_at: string;
}

interface PerformanceMetric {
  id: string;
  name: string;
  value: number;
  unit: string;
  threshold: number | null;
  status: string;
  measured_at: string;
}

interface CodeReview {
  id: string;
  pr_number: number;
  title: string;
  author: string;
  status: string;
  review_time_hours: number | null;
  comments: number;
  created_at: string;
}

interface VelocityEntry {
  id: string;
  period: string;
  commits: number;
  lines_added: number;
  lines_removed: number;
  prs_merged: number;
  avg_review_hours: number | null;
}

interface Vulnerability {
  id: string;
  severity: string;
  title: string;
  file_path: string | null;
  line: number | null;
  description: string;
  status: string;
  detected_at: string;
}

interface SecretScan {
  id: string;
  target_type: string;
  target_ref: string | null;
  matched: boolean;
  findings: { kind: string; location: string; confidence: number }[];
  created_at: string;
}

export function IntelligencePage() {
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('engineering');
  const [projectId, setProjectId] = useState('default');
  const [inputProjectId, setInputProjectId] = useState('default');

  const [refactoringPlans, setRefactoringPlans] = useState<RefactoringPlan[]>([]);
  const [technicalDebt, setTechnicalDebt] = useState<TechnicalDebt[]>([]);
  const [perfMetrics, setPerfMetrics] = useState<PerformanceMetric[]>([]);
  const [codeReviews, setCodeReviews] = useState<CodeReview[]>([]);
  const [velocity, setVelocity] = useState<VelocityEntry[]>([]);
  const [vulnerabilities, setVulnerabilities] = useState<Vulnerability[]>([]);
  const [secretScans, setSecretScans] = useState<SecretScan[]>([]);

  const loadEngineering = useCallback(async (pid: string) => {
    const q = `?projectId=${encodeURIComponent(pid)}`;
    const [plansResp, debtResp, perfResp] = await Promise.all([
      api<{ plans: RefactoringPlan[] }>(`/api/v1/engineering-intelligence/refactor/plans${q}`),
      api<{ result: { items?: TechnicalDebt[] } }>(`/api/v1/engineering-intelligence/debt/analyze${q}`),
      api<{ report: any }>(`/api/v1/engineering-intelligence/performance/report${q}`),
    ]);
    setRefactoringPlans(plansResp.plans ?? []);
    setTechnicalDebt(debtResp.result?.items ?? []);
    const r = perfResp.report;
    const now = new Date().toISOString();
    const metrics: PerformanceMetric[] = [];
    if (r?.summary) {
      const s = r.summary;
      metrics.push(
        { id: 'overall-score', name: 'Overall Score', value: s.overallScore, unit: 'score', threshold: null, status: s.overallScore > 70 ? 'OK' : 'WARN', measured_at: now },
        { id: 'critical-issues', name: 'Critical Issues', value: s.criticalIssues, unit: 'count', threshold: 0, status: s.criticalIssues > 0 ? 'CRITICAL' : 'OK', measured_at: now },
        { id: 'high-issues', name: 'High Issues', value: s.highIssues, unit: 'count', threshold: 5, status: s.highIssues > 5 ? 'HIGH' : 'OK', measured_at: now },
        { id: 'medium-issues', name: 'Medium Issues', value: s.mediumIssues, unit: 'count', threshold: 10, status: s.mediumIssues > 10 ? 'MEDIUM' : 'OK', measured_at: now },
        { id: 'optimization-hours', name: 'Est. Optimization Hours', value: s.estimatedOptimizationHours, unit: 'h', threshold: null, status: 'INFO', measured_at: now },
      );
    }
    metrics.push(
      { id: 'slow-functions', name: 'Slow Functions', value: r?.slowFunctions?.length ?? 0, unit: 'count', threshold: null, status: 'INFO', measured_at: now },
      { id: 'n-plus-ones', name: 'N+1 Query Issues', value: r?.nPlusOnes?.length ?? 0, unit: 'count', threshold: 0, status: (r?.nPlusOnes?.length ?? 0) > 0 ? 'HIGH' : 'OK', measured_at: now },
      { id: 'db-risks', name: 'DB Query Risks', value: r?.dbQueryRisks?.length ?? 0, unit: 'count', threshold: 0, status: (r?.dbQueryRisks?.length ?? 0) > 0 ? 'MEDIUM' : 'OK', measured_at: now },
      { id: 'caching-opps', name: 'Caching Opportunities', value: r?.cachingOpportunities?.length ?? 0, unit: 'count', threshold: null, status: 'INFO', measured_at: now },
    );
    setPerfMetrics(metrics);
  }, []);

  const loadDeveloper = useCallback(async (pid: string) => {
    const q = `?projectId=${encodeURIComponent(pid)}`;
    const histResp = await api<{
      history: {
        commits: Array<{
          hash: string;
          author: string;
          date: string;
          message: string;
          stats: { additions: number; deletions: number; files: number };
        }>;
        total: number;
      };
    }>(`/api/v1/developer-productivity/git/history${q}`);
    const commits = histResp.history?.commits ?? [];
    setCodeReviews(
      commits.map((c) => ({
        id: c.hash,
        pr_number: 0,
        title: c.message,
        author: c.author,
        status: 'merged',
        review_time_hours: null,
        comments: 0,
        created_at: c.date,
      })),
    );
    setVelocity(
      commits.map((c) => ({
        id: c.hash,
        period: c.date,
        commits: 1,
        lines_added: c.stats.additions,
        lines_removed: c.stats.deletions,
        prs_merged: 0,
        avg_review_hours: null,
      })),
    );
  }, []);

  const loadSecurity = useCallback(async (pid: string) => {
    const q = `?projectId=${encodeURIComponent(pid)}`;
    const [vulnsResp, scansResp] = await Promise.all([
      api<{ findings: Vulnerability[] }>(`/api/v1/security-intelligence/vulnerabilities${q}`),
      api<{ exposures: SecretScan[] }>(`/api/v1/security-intelligence/secrets/exposures${q}`),
    ]);
    setVulnerabilities(vulnsResp.findings ?? []);
    setSecretScans(scansResp.exposures ?? []);
  }, []);

  const load = useCallback(async (pid: string) => {
    try {
      if (tab === 'engineering') await loadEngineering(pid);
      else if (tab === 'developer') await loadDeveloper(pid);
      else await loadSecurity(pid);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Load failed', 'error');
    }
  }, [tab, loadEngineering, loadDeveloper, loadSecurity, toast]);

  useEffect(() => {
    void load(projectId);
  }, [load, projectId]);

  const applyProjectId = () => {
    const trimmed = inputProjectId.trim();
    if (!trimmed) return;
    setProjectId(trimmed);
  };

  const severityColor = (sev: string) => {
    const s = sev.toUpperCase();
    if (s === 'CRITICAL' || s === 'HIGH') return '#dc2626';
    if (s === 'MEDIUM') return '#d97706';
    return '#334155';
  };

  return (
    <div className="cc-page">
      <h1>Intelligence</h1>
      <p className="cc-hint">
        Engineering intelligence (V4A), developer productivity (V4B), and security intelligence (V4C).
        All metrics are server-derived from repository and pipeline data.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          className="cc-input"
          aria-label="Project ID"
          placeholder="Project ID"
          value={inputProjectId}
          onChange={(e) => setInputProjectId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') applyProjectId(); }}
          style={{ width: 220 }}
        />
        <button className="cc-btn cc-btn--sm" onClick={applyProjectId}>Load</button>
        <span className="cc-hint cc-mono">project: {projectId}</span>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #334155', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`cc-btn ${tab === t.key ? '' : 'cc-btn--ghost'}`}
            style={{ borderBottom: tab === t.key ? '2px solid #3b82f6' : '2px solid transparent', borderRadius: '4px 4px 0 0' }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'engineering' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="cc-card" data-testid="intel-refactoring">
            <h3 style={{ margin: '0 0 8px' }}>Refactoring Plans</h3>
            {refactoringPlans.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No refactoring plans for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {refactoringPlans.map((p) => (
                  <li key={p.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: severityColor(p.priority), color: '#fff' }}>{p.priority}</span>
                    <span style={{ fontWeight: 600 }}>{p.title}</span>
                    <span className="cc-pill" style={{ fontSize: 10 }}>{p.status}</span>
                    {p.estimated_hours != null && <span className="cc-hint">{p.estimated_hours}h est.</span>}
                    <span className="cc-hint">{new Date(p.created_at).toLocaleDateString()}</span>
                    {p.description && <span className="cc-hint" style={{ flexBasis: '100%' }}>{p.description}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cc-card" data-testid="intel-debt">
            <h3 style={{ margin: '0 0 8px' }}>Technical Debt</h3>
            {technicalDebt.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No technical debt items recorded.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {technicalDebt.map((d) => (
                  <li key={d.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: severityColor(d.severity), color: '#fff' }}>{d.severity}</span>
                    <span className="cc-pill" style={{ fontSize: 10 }}>{d.category}</span>
                    <span>{d.description}</span>
                    {d.file_path && <span className="cc-hint">{d.file_path}</span>}
                    <span className="cc-hint">{new Date(d.created_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cc-card" data-testid="intel-perf">
            <h3 style={{ margin: '0 0 8px' }}>Performance Metrics</h3>
            {perfMetrics.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No performance metrics available.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {perfMetrics.map((m) => (
                  <li key={m.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, minWidth: 160 }}>{m.name}</span>
                    <span>{m.value} {m.unit}</span>
                    {m.threshold != null && <span className="cc-hint">threshold: {m.threshold} {m.unit}</span>}
                    <span className="cc-pill" style={{ fontSize: 10, background: m.status === 'OK' ? '#16a34a' : severityColor(m.status), color: '#fff' }}>{m.status}</span>
                    <span className="cc-hint">{new Date(m.measured_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'developer' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="cc-card" data-testid="intel-code-review">
            <h3 style={{ margin: '0 0 8px' }}>Code Reviews</h3>
            {codeReviews.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No code reviews recorded for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {codeReviews.map((r) => (
                  <li key={r.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10 }}>PR #{r.pr_number}</span>
                    <span style={{ fontWeight: 600 }}>{r.title}</span>
                    <span className="cc-pill" style={{ fontSize: 10 }}>{r.status}</span>
                    <span>{r.author}</span>
                    {r.review_time_hours != null && <span className="cc-hint">{r.review_time_hours}h review</span>}
                    <span className="cc-hint">{r.comments} comment(s)</span>
                    <span className="cc-hint">{new Date(r.created_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cc-card" data-testid="intel-velocity">
            <h3 style={{ margin: '0 0 8px' }}>Velocity</h3>
            {velocity.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No velocity data available.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {velocity.map((v) => (
                  <li key={v.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10 }}>{v.period}</span>
                    <span>{v.commits} commit(s)</span>
                    <span className="cc-hint">+{v.lines_added} / -{v.lines_removed}</span>
                    <span>{v.prs_merged} PR(s) merged</span>
                    {v.avg_review_hours != null && <span className="cc-hint">avg {v.avg_review_hours}h review</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === 'security' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="cc-card" data-testid="intel-vulns">
            <h3 style={{ margin: '0 0 8px' }}>Vulnerabilities</h3>
            {vulnerabilities.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No vulnerabilities detected for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {vulnerabilities.map((v) => (
                  <li key={v.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: severityColor(v.severity), color: '#fff' }}>{v.severity}</span>
                    <span style={{ fontWeight: 600 }}>{v.title}</span>
                    <span className="cc-pill" style={{ fontSize: 10 }}>{v.status}</span>
                    {v.file_path && <span className="cc-hint">{v.file_path}{v.line ? `:${v.line}` : ''}</span>}
                    <span className="cc-hint">{new Date(v.detected_at).toLocaleDateString()}</span>
                    <span className="cc-hint" style={{ flexBasis: '100%' }}>{v.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="cc-card" data-testid="intel-secret-scans">
            <h3 style={{ margin: '0 0 8px' }}>Secret Scans</h3>
            {secretScans.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No secret scans recorded for this project.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {secretScans.map((s) => (
                  <li key={s.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="cc-pill" style={{ fontSize: 10, background: s.matched ? '#dc2626' : '#334155', color: '#fff' }}>
                      {s.matched ? `${s.findings.length} finding(s)` : 'clean'}
                    </span>
                    <span>{s.target_type}{s.target_ref ? ` · ${s.target_ref}` : ''}</span>
                    <span className="cc-hint">{new Date(s.created_at).toLocaleString()}</span>
                    {s.findings.map((f, i) => (
                      <span key={i} className="cc-hint">[{f.kind} @ {f.location} · {(f.confidence * 100).toFixed(0)}%]</span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
