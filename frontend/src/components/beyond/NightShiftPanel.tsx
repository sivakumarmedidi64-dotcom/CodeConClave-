/**
 * Night Shift panel — while you sleep, CodeConClave measures your active
 * projects, has the Council review files changed that day and runs every
 * vaccine. In the morning there is one report (and a notification).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { errMessage } from './shared';

export interface NightShiftSummary {
  projects: { id: string; name: string; temperature: number; level: string; delta: number | null; hottest: { path: string; heat: number; reasons: string[] }[] }[];
  council: { projectId: string; projectName: string; path: string; verdict: string; top: string[] }[];
  immunity: { vaccineId: string; name: string; matches: number }[];
  filesReviewed: number;
  durationMs: number;
  headline: string;
  errors: string[];
}

export interface NightShiftReport {
  id: string;
  trigger: 'manual' | 'schedule';
  startedAt: string;
  finishedAt: string | null;
  summary: Partial<NightShiftSummary>;
}

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

function ReportBody({ s }: { s: Partial<NightShiftSummary> }) {
  return (
    <div className="bx-report">
      {(s.projects ?? []).length > 0 && (
        <>
          <h4>Temperature</h4>
          <ul className="bx-list bx-list--tight">
            {s.projects!.map((p) => (
              <li key={p.id}>
                <strong>{p.name}</strong> {p.temperature}° <span className="cc-muted">{p.level.toLowerCase()}</span>
                {typeof p.delta === 'number' && p.delta !== 0 && (
                  <span className={`cc-pill ${p.delta > 0 ? 'bx-up' : 'bx-down'}`}>
                    {p.delta > 0 ? '▲' : '▼'} {Math.abs(p.delta)}°
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {((s.filesReviewed ?? 0) > 0 || (s.council ?? []).length > 0) && (
        <>
          <h4>
            Council reviewed {s.filesReviewed ?? s.council!.length} file{(s.filesReviewed ?? s.council!.length) === 1 ? '' : 's'} changed today
          </h4>
          {(s.filesReviewed ?? 0) > (s.council ?? []).length && (
            <p className="cc-hint">
              {(s.filesReviewed ?? 0) - (s.council ?? []).length} passed with nothing to fix
              {(s.council ?? []).length > 0 ? '; these need attention:' : '.'}
            </p>
          )}
          <ul className="bx-list bx-list--tight">
            {(s.council ?? []).map((c) => (
              <li key={`${c.projectId}:${c.path}`}>
                <span className={`cc-pill bx-consensus-pill bx-consensus-pill--${c.verdict.toLowerCase()}`}>{c.verdict.replace(/_/g, ' ').toLowerCase()}</span>{' '}
                <code className="cc-md-code">{c.path}</code> <span className="cc-muted">{c.projectName}</span>
                {c.top.length > 0 && <span className="cc-hint"> — {c.top.join('; ')}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {(s.immunity ?? []).length > 0 && (
        <>
          <h4>Immunity</h4>
          <ul className="bx-list bx-list--tight">
            {s.immunity!.map((v) => (
              <li key={v.vaccineId}>
                {v.name}: <strong>{v.matches}</strong> match{v.matches === 1 ? '' : 'es'}
              </li>
            ))}
          </ul>
        </>
      )}
      {(s.errors ?? []).length > 0 && (
        <>
          <h4>Could not finish</h4>
          <ul className="bx-list bx-list--tight">
            {s.errors!.map((e) => (
              <li key={e} className="cc-error">
                {e}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function NightShiftPanel() {
  const [reports, setReports] = useState<NightShiftReport[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(2);
  const [saved, setSaved] = useState<{ enabled: boolean; hour: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ reports: NightShiftReport[]; settings: { enabled: boolean; hour: number } }>('/api/v1/beyond/night-shift');
      setReports(res.reports ?? []);
      setEnabled(res.settings.enabled);
      setHour(res.settings.hour);
      setSaved(res.settings);
    } catch (err) {
      setReports([]);
      setError(errMessage(err, 'Could not load Night Shift.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ settings: { enabled: boolean; hour: number } }>('/api/v1/beyond/night-shift/settings', { method: 'PUT', body: { enabled, hour } });
      setSaved(res.settings);
    } catch (err) {
      setError(errMessage(err, 'Could not save the schedule.'));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await api<{ report: NightShiftReport }>('/api/v1/beyond/night-shift/run', { method: 'POST' });
      setReports((r) => [res.report, ...(r ?? [])]);
    } catch (err) {
      setError(errMessage(err, 'The Night Shift did not finish.'));
    } finally {
      setRunning(false);
    }
  };

  const dirty = saved !== null && (saved.enabled !== enabled || saved.hour !== hour);

  return (
    <section className="bx-panel" aria-label="Night Shift">
      <header className="bx-panel__head">
        <div>
          <h2>Night Shift</h2>
          <p className="cc-hint">
            While you sleep: measure your active projects, have the Council review files changed that day, and run every vaccine. One report and one notification in the morning. It reads only — nothing is changed in your code.
          </p>
        </div>
        <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={running} onClick={() => void runNow()}>
          {running ? 'Working…' : 'Run now'}
        </button>
      </header>
      <div className="bx-row">
        <label className="bx-check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="night-enabled" />
          Run every night
        </label>
        <label className="bx-field">
          <span>At</span>
          <select className="cc-input" value={hour} onChange={(e) => setHour(Number(e.target.value))} disabled={!enabled}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="cc-btn cc-btn--sm" disabled={!dirty || saving} onClick={() => void saveSettings()}>
          {saving ? 'Saving…' : dirty ? 'Save schedule' : 'Saved'}
        </button>
        <span className="cc-hint">Same clock as your weekly usage reset.</span>
      </div>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      {reports === null ? (
        <p className="cc-hint">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="cc-hint" data-testid="night-empty">
          No reports yet. Press <strong>Run now</strong> to see what a morning report looks like for your projects.
        </p>
      ) : (
        <ul className="bx-list">
          {reports.map((r, i) => (
            <li key={r.id} data-testid="night-report">
              <details open={i === 0}>
                <summary>
                  <strong>{r.summary.headline ?? (r.finishedAt ? 'Report' : 'Did not finish')}</strong>{' '}
                  <span className="cc-muted">
                    {new Date(r.startedAt).toLocaleString()} · {r.trigger === 'schedule' ? 'scheduled' : 'run by you'}
                    {typeof r.summary.durationMs === 'number' ? ` · ${(r.summary.durationMs / 1000).toFixed(1)}s` : ''}
                  </span>
                </summary>
                <ReportBody s={r.summary} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
