/**
 * Code Thermostat panel — the project's measured temperature (0–100), its
 * history, the five measured parts and the hottest files. "Cool it down"
 * files a Plan-first Cowork task (nothing changes until you approve the plan).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { errMessage } from './shared';
import { Icon } from '../Icon';
import { PlanApprovalCard, asPlanSummary, type PlanSummary } from '../PlanApproval';

type Level = 'COOL' | 'WARM' | 'HOT' | 'CRITICAL';

interface Components {
  duplication: { value: number; duplicatedLines: number; totalLines: number };
  size: { value: number; linesInLargeFiles: number; largeFiles: number };
  nesting: { value: number; deepFiles: number; codeFiles: number };
  markers: { value: number; count: number; per1kLines: number };
  findings: { value: number; weighted: number; per1kLines: number; bySeverity: Record<string, number> };
}

interface HotFile {
  path: string;
  heat: number;
  lines: number;
  reasons: string[];
}

export interface Snapshot {
  id: string;
  temperature: number;
  level: Level;
  components: Components;
  hottest: HotFile[];
  codeFiles: number;
  lines: number;
  createdAt: string;
  source?: string;
  delta?: number | null;
  capped?: boolean;
}

const LEVEL_TEXT: Record<Level, string> = { COOL: 'Cool', WARM: 'Warm', HOT: 'Hot', CRITICAL: 'Critical' };

export function Gauge({ value, level }: { value: number; level: Level }) {
  // Semicircle from 180° to 0°; the needle points at the value.
  const angle = Math.PI * (1 - Math.max(0, Math.min(100, value)) / 100);
  const x = 60 + 46 * Math.cos(angle);
  const y = 60 - 46 * Math.sin(angle);
  return (
    <svg className={`bx-gauge bx-gauge--${level.toLowerCase()}`} viewBox="0 0 120 70" role="img" aria-label={`Temperature ${value} of 100, ${LEVEL_TEXT[level]}`}>
      <path d="M14 60 A46 46 0 0 1 106 60" className="bx-gauge__track" />
      <path d={`M14 60 A46 46 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}`} className="bx-gauge__fill" />
      <text x="60" y="54" textAnchor="middle" className="bx-gauge__value">
        {value}°
      </text>
      <text x="60" y="67" textAnchor="middle" className="bx-gauge__label">
        {LEVEL_TEXT[level]}
      </text>
    </svg>
  );
}

function Trend({ history }: { history: { temperature: number; createdAt: string }[] }) {
  const pts = [...history].reverse();
  if (pts.length < 2) return <p className="cc-hint">The trend line appears after the second measurement.</p>;
  const w = 220;
  const h = 44;
  const step = w / (pts.length - 1);
  const d = pts.map((p, i) => `${(i * step).toFixed(1)},${(h - (p.temperature / 100) * h).toFixed(1)}`).join(' ');
  return (
    <svg className="bx-trend" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Trend over ${pts.length} measurements`}>
      <polyline points={d} />
    </svg>
  );
}

const PARTS: { key: keyof Components; label: string; weight: number; describe: (c: Components) => string }[] = [
  { key: 'duplication', label: 'Duplication', weight: 0.3, describe: (c) => `${c.duplication.duplicatedLines} of ${c.duplication.totalLines} code lines are in repeated 6-line blocks` },
  { key: 'size', label: 'Size', weight: 0.2, describe: (c) => `${c.size.largeFiles} file${c.size.largeFiles === 1 ? '' : 's'} over 400 lines (${c.size.linesInLargeFiles} lines)` },
  { key: 'nesting', label: 'Nesting', weight: 0.15, describe: (c) => `${c.nesting.deepFiles} of ${c.nesting.codeFiles} files nested 6+ levels deep` },
  { key: 'markers', label: 'TODO/FIXME', weight: 0.1, describe: (c) => `${c.markers.count} marker${c.markers.count === 1 ? '' : 's'} (${c.markers.per1kLines} per 1,000 lines)` },
  { key: 'findings', label: 'Analyzer findings', weight: 0.25, describe: (c) => `${c.findings.per1kLines} weighted findings per 1,000 lines` },
];

export function ThermostatPanel({ projectId }: { projectId: string }) {
  const [history, setHistory] = useState<Snapshot[] | null>(null);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooling, setCooling] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ approvalId: string; plan: PlanSummary } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ history: Snapshot[] }>(`/api/v1/beyond/projects/${encodeURIComponent(projectId)}/thermostat`);
      const h = Array.isArray(res?.history) ? res.history : [];
      setHistory(h);
      setLatest(h[0] ? { ...h[0], delta: h[1] ? h[0].temperature - h[1].temperature : null } : null);
    } catch (err) {
      setHistory([]);
      setError(errMessage(err, 'Could not load the temperature history.'));
    }
  }, [projectId]);

  useEffect(() => {
    setPlan(null);
    void load();
  }, [load]);

  const measureNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ snapshot: Snapshot }>(`/api/v1/beyond/projects/${encodeURIComponent(projectId)}/thermostat`, { method: 'POST' });
      await load();
      // The fresh snapshot carries delta and the large-project note; keep it on top.
      setLatest(res.snapshot);
    } catch (err) {
      setError(errMessage(err, 'Measuring failed.'));
    } finally {
      setBusy(false);
    }
  };

  const coolDown = async (f: HotFile) => {
    setCooling(f.path);
    setError(null);
    try {
      const res = await api<{ approvalId: string; plan: unknown }>(`/api/v1/beyond/projects/${encodeURIComponent(projectId)}/thermostat/cool`, {
        method: 'POST',
        body: { path: f.path, reasons: f.reasons },
      });
      const summary = asPlanSummary(res.plan);
      if (summary) setPlan({ approvalId: res.approvalId, plan: summary });
    } catch (err) {
      setError(errMessage(err, 'Could not prepare the cool-down plan.'));
    } finally {
      setCooling(null);
    }
  };

  return (
    <section className="bx-panel" aria-label="Code Thermostat">
      <header className="bx-panel__head">
        <div>
          <h2>Code Thermostat</h2>
          <p className="cc-hint">Your code&apos;s health as a temperature, measured from the real files. Every part of the number is shown below.</p>
        </div>
        <button type="button" className="cc-btn cc-btn--primary cc-btn--sm" disabled={busy} onClick={() => void measureNow()}>
          {busy ? 'Measuring…' : 'Measure now'}
        </button>
      </header>
      {error && (
        <p className="cc-error" role="alert">
          {error}
        </p>
      )}
      {history === null ? (
        <p className="cc-hint">Loading…</p>
      ) : !latest ? (
        <p className="cc-hint" data-testid="thermo-empty">
          Not measured yet. Press <strong>Measure now</strong>.
        </p>
      ) : (
        <>
          <div className="bx-thermo__top">
            <Gauge value={latest.temperature} level={latest.level} />
            <div className="bx-thermo__facts">
              <p>
                <strong data-testid="thermo-temp">{latest.temperature}°</strong> · {LEVEL_TEXT[latest.level]}
                {typeof latest.delta === 'number' && latest.delta !== 0 && (
                  <span className={`cc-pill ${latest.delta > 0 ? 'bx-up' : 'bx-down'}`}>
                    {latest.delta > 0 ? '▲' : '▼'} {Math.abs(latest.delta)}° since last time
                  </span>
                )}
              </p>
              <p className="cc-hint">
                {latest.codeFiles} code files · {latest.lines.toLocaleString()} lines · measured {new Date(latest.createdAt).toLocaleString()}
                {latest.capped ? ' · large project: first 500 text files' : ''}
              </p>
              <Trend history={history} />
            </div>
          </div>

          <details className="bx-parts" open>
            <summary>How it&apos;s measured</summary>
            <ul>
              {PARTS.map((p) => (
                <li key={p.key}>
                  <span className="bx-parts__name">
                    {p.label} <span className="cc-muted">×{p.weight}</span>
                  </span>
                  <span className="bx-bar" aria-label={`${Math.round(latest.components[p.key].value * 100)}%`}>
                    <span style={{ width: `${Math.round(latest.components[p.key].value * 100)}%` }} />
                  </span>
                  <span className="cc-hint">{p.describe(latest.components)}</span>
                </li>
              ))}
            </ul>
          </details>

          <h3 className="bx-sub">Hottest files</h3>
          {latest.hottest.length === 0 ? (
            <p className="cc-hint">No hot files — nothing measurable is heating this project.</p>
          ) : (
            <ul className="bx-list">
              {latest.hottest.map((f) => (
                <li key={f.path}>
                  <div className="bx-list__row">
                    <code className="cc-md-code">{f.path}</code>
                    <span className="cc-pill">{f.heat}°</span>
                    <button type="button" className="cc-btn cc-btn--ghost cc-btn--sm" disabled={cooling !== null} onClick={() => void coolDown(f)}>
                      <Icon name="refresh" size={12} /> {cooling === f.path ? 'Planning…' : 'Cool it down'}
                    </button>
                  </div>
                  <span className="cc-hint">{f.reasons.join(' · ')}</span>
                </li>
              ))}
            </ul>
          )}
          {plan && <PlanApprovalCard approvalId={plan.approvalId} plan={plan.plan} />}
        </>
      )}
    </section>
  );
}
