/**
 * CodeConClave — Data Centre (Phase 13): persisted metrics only — quota,
 * storage, entity counts, retention, honest backup state — plus cleanup
 * recommendations (never auto-applied; resolve/dismiss is explicit) and the
 * unified activity feed.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ActivityEvent, CleanupRecommendation, DataCentreReportV2 } from '../lib/types';
import { useToast } from '../components/Toast';

const MB = 1024 * 1024;

export function DataPage() {
  const { toast } = useToast();
  const [report, setReport] = useState<DataCentreReportV2 | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<DataCentreReportV2>('/api/v1/data-centre')
      .then(setReport)
      .catch((err) => setError(err instanceof Error ? err.message : 'load failed'));
    void api<{ events: ActivityEvent[] }>('/api/v1/activity?scope=home&limit=15')
      .then((res) => setActivity(res.events ?? []))
      .catch(() => {
        /* activity is best-effort */
      });
  }, []);

  const resolve = async (rec: CleanupRecommendation, status: 'RESOLVED' | 'DISMISSED') => {
    if (!report) return;
    try {
      const res = await api<{ recommendation: CleanupRecommendation }>(`/api/v1/cleanup/${rec.id}/resolve`, {
        method: 'POST',
        body: { status },
      });
      setReport({
        ...report,
        recommendations: report.recommendations.map((r) => (r.id === rec.id ? res.recommendation : r)),
      });
      toast(status === 'RESOLVED' ? 'Marked resolved' : 'Dismissed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
    }
  };

  const regenerate = async () => {
    if (!report) return;
    try {
      const res = await api<{ recommendations: CleanupRecommendation[]; generated: number }>('/api/v1/cleanup/generate', {
        method: 'POST',
        body: {},
      });
      setReport({ ...report, recommendations: res.recommendations });
      toast(`Scan complete — ${res.generated} candidate(s)`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'scan failed', 'error');
    }
  };

  return (
    <div className="cc-page">
      <h1>Data Centre</h1>
      {error && <div className="cc-card" style={{ color: '#b3261e' }}>{error}</div>}
      {report ? (
        <div className="cc-grid cc-grid-2">
          <div className="cc-card">
            <h3>Quota</h3>
            {[
              { k: 'Plan', v: report.quota.plan },
              { k: 'Used', v: `${report.quota.usedMb.toFixed(1)} MB` },
              { k: 'Limit', v: `${report.quota.limitMb.toFixed(0)} MB` },
              { k: 'Status', v: report.quota.overLimit ? 'OVER LIMIT' : 'OK' },
            ].map((r) => (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="cc-hint">{r.k}</span>
                <strong>{String(r.v)}</strong>
              </div>
            ))}
            <div style={{ marginTop: 6, background: 'var(--cc-border)', height: 8, borderRadius: 4 }}>
              <div
                style={{
                  height: 8,
                  width: `${Math.min(report.quota.percent, 100)}%`,
                  background: report.quota.overLimit ? '#b3261e' : '#2f6fdb',
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
          <div className="cc-card">
            <h3>Storage</h3>
            {[
              { k: 'Files', v: report.storage.fileCount },
              { k: 'Trashed', v: report.storage.trashedCount },
              { k: 'Versions', v: report.storage.versionCount },
              { k: 'Total', v: `${(report.storage.totalBytes / MB).toFixed(1)} MB` },
              { k: 'Encryption at rest', v: report.storage.encryptionEnabled ? 'on' : 'off' },
            ].map((r) => (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="cc-hint">{r.k}</span>
                <strong>{String(r.v)}</strong>
              </div>
            ))}
          </div>
          <div className="cc-card">
            <h3>Provider & backup</h3>
            {[
              { k: 'Mode', v: report.provider.mode },
              { k: 'Health', v: report.provider.healthy ? 'ok' : 'degraded' },
              { k: 'Last check', v: report.provider.lastHealthCheckAt ?? '—' },
            ].map((r) => (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="cc-hint">{r.k}</span>
                <strong>{String(r.v)}</strong>
              </div>
            ))}
            <p className="cc-hint" style={{ marginTop: 6 }}>
              Backup: <strong>{report.backup.available ? 'available' : 'not configured'}</strong> — {report.backup.note}
            </p>
          </div>
          <div className="cc-card">
            <h3>Entities</h3>
            {[
              { k: 'Projects', v: report.counts.projects },
              { k: 'Teams', v: report.counts.teams },
              { k: 'Conversations', v: report.counts.conversations },
              { k: 'Messages', v: report.counts.messages },
              { k: 'Memories', v: report.counts.memories },
              { k: 'DNA blocks', v: report.counts.dna },
              { k: 'DNA versions', v: report.counts.dnaVersions },
              { k: 'Tasks', v: report.counts.tasks },
              { k: 'Artifacts', v: report.counts.artifacts },
              { k: 'Ideas', v: report.counts.ideas },
              { k: 'Brainstorm sessions', v: report.counts.brainstormSessions },
              { k: 'Notifications', v: report.counts.notifications },
              { k: 'Audit events', v: report.counts.auditEvents },
            ].map((r) => (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="cc-hint">{r.k}</span>
                <strong>{String(r.v)}</strong>
              </div>
            ))}
          </div>
          <div className="cc-card">
            <h3>Retention & cleanup</h3>
            {[
              { k: 'Trash recovery window', v: `${report.retention.trashDays} days` },
              { k: 'Idea retention', v: `${report.retention.ideaRetentionDays} days` },
              { k: 'Notification retention', v: `${report.retention.notificationDays} days` },
            ].map((r) => (
              <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                <span className="cc-hint">{r.k}</span>
                <strong>{String(r.v)}</strong>
              </div>
            ))}
            <div className="cc-hint" style={{ marginTop: 6 }}>
              recommendations: {report.recommendationsByStatus.active} active ·{' '}
              {report.recommendationsByStatus.resolved} resolved · {report.recommendationsByStatus.dismissed} dismissed
            </div>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" style={{ marginTop: 8 }} onClick={() => void regenerate()}>
              Re-scan for cleanup candidates
            </button>
          </div>
          <div className="cc-card" style={{ gridColumn: '1 / -1' }}>
            <h3>Cleanup recommendations</h3>
            {report.recommendations.length === 0 && <div className="cc-empty">No recommendations yet — run a scan.</div>}
            {report.recommendations.map((rec) => (
              <div key={rec.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderTop: '1px solid var(--cc-border)' }}>
                <div style={{ minWidth: 0 }}>
                  <div>
                    <span className="cc-pill">{rec.candidateType}</span>{' '}
                    <span className="cc-pill">{rec.status.toLowerCase()}</span>
                    {rec.storageImpactBytes > 0 && (
                      <span className="cc-hint"> · {(rec.storageImpactBytes / 1024).toFixed(1)} KB</span>
                    )}
                  </div>
                  <p className="cc-hint" style={{ margin: '4px 0' }}>{rec.reason}</p>
                  <div className="cc-hint cc-mono">
                    {rec.affected.map((a) => `${a.name} (${a.id.slice(0, 8)})`).join(', ')}
                  </div>
                  {!rec.reversible && <div className="cc-hint">not reversible · needs {rec.authorizationLevel} authorization</div>}
                </div>
                {rec.status === 'ACTIVE' && (
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void resolve(rec, 'RESOLVED')}>
                      Mark resolved
                    </button>
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void resolve(rec, 'DISMISSED')}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
            <p className="cc-hint" style={{ marginTop: 6 }}>
              Recommendations are never applied automatically — acting on them is always an explicit choice.
            </p>
          </div>
          <div className="cc-card" style={{ gridColumn: '1 / -1' }}>
            <h3>Recent activity</h3>
            {activity.length === 0 && <div className="cc-empty">No recent activity.</div>}
            {activity.map((e) => (
              <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
                <span>
                  <span className="cc-pill">{e.source}</span> <span className="cc-pill">{e.action}</span>
                </span>
                <span className="cc-hint">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="cc-card cc-empty">Loading…</div>
      )}
    </div>
  );
}