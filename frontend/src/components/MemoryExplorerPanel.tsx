/**
 * CodeConClave — Memory explorer (Stage 26I): decision replay + records,
 * conflict detection + resolution, and cross-project continuity (patterns,
 * handoffs, timeline). Every action hits the real backend; the panel renders
 * server state only. Conflicts are resolved with explicit resolutions
 * (KEEP / REPLACE / EXCEPTION / CANCEL), never silently overwritten.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { buildDecisionMarkdown, downloadDecisionMarkdown } from '../lib/continuity';
import type {
  ConflictRow,
  DecisionRow,
  DecisionStatus,
  DetectedConflict,
  HandoffRow,
  PatternRow,
  TimelineItem,
} from '../lib/types';
import { useToast } from './Toast';

type ExplorerTab = 'decisions' | 'conflicts' | 'continuity';

const IMPACT_COLORS: Record<string, string> = { LOW: '#0f766e', MEDIUM: '#b45309', HIGH: '#dc2626' };
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '#1e7d46',
  TENTATIVE: '#b45309',
  SUPERSEDED: '#64748b',
  REJECTED: '#dc2626',
  ARCHIVED: '#64748b',
};

export type { DecisionStatus };

export function MemoryExplorerPanel() {
  const { toast } = useToast();
  const [tab, setTab] = useState<ExplorerTab>('decisions');

  return (
    <div>
      <div className="cc-tabs" role="tablist" aria-label="Memory explorer sections">
        {([
          ['decisions', 'Decision replay'],
          ['conflicts', 'Conflicts'],
          ['continuity', 'Continuity'],
        ] as [ExplorerTab, string][]).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`cc-tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        {tab === 'decisions' && <DecisionsTab />}
        {tab === 'conflicts' && <ConflictsTab />}
        {tab === 'continuity' && <ContinuityTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decisions

function DecisionsTab() {
  const { toast } = useToast();
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [replay, setReplay] = useState<{ outcome: string; decision?: DecisionRow } | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [title, setTitle] = useState('');
  const [decision, setDecision] = useState('');
  const [impact, setImpact] = useState<'LOW' | 'MEDIUM' | 'HIGH'>('MEDIUM');
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState<DecisionStatus | ''>('');
  const [sources, setSources] = useState<Record<string, { id: string; content: string; createdAt: string }[]>>({});
  const [sourcesOpen, setSourcesOpen] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (status: DecisionStatus | '' = '') => {
    setState('loading');
    try {
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      const res = await api<{ decisions: DecisionRow[] }>(`/api/v1/memory/decisions${q}`);
      setDecisions(res.decisions);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load(statusFilter);
  }, [statusFilter, load]);

  const loadSources = async (id: string) => {
    setSourcesOpen((prev) => ({ ...prev, [id]: !prev[id] }));
    if (sources[id] || sourcesOpen[id]) return;
    try {
      const res = await api<{ sources: { id: string; content: string; createdAt: string }[] }>(
        `/api/v1/memory/decisions/${id}/sources`,
      );
      setSources((prev) => ({ ...prev, [id]: res.sources }));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'sources failed', 'error');
    }
  };

  const setStatus = async (id: string, status: DecisionStatus) => {
    try {
      await api(`/api/v1/memory/decisions/${id}/status`, { method: 'PATCH', body: { status } });
      toast(`Decision ${status.toLowerCase()}`);
      await load(statusFilter);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'status update failed', 'error');
    }
  };

  const exportMarkdown = async () => {
    setExporting(true);
    try {
      const res = await api<{ decisions: DecisionRow[] }>('/api/v1/memory/decisions');
      downloadDecisionMarkdown(buildDecisionMarkdown(res.decisions));
      toast('CodeConClave decision.md downloaded');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const replayNow = async () => {
    setReplaying(true);
    try {
      const res = await api<{ outcome: string; decision?: DecisionRow }>('/api/v1/memory/decisions/replay', {
        method: 'POST',
        body: { query: query.trim() },
      });
      setReplay(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'replay failed', 'error');
    } finally {
      setReplaying(false);
    }
  };

  const record = async () => {
    setBusy(true);
    try {
      await api('/api/v1/memory/decisions', {
        method: 'POST',
        body: { title: title.trim(), decision: decision.trim(), impact, rationale: rationale.trim() || undefined },
      });
      setTitle('');
      setDecision('');
      setRationale('');
      await load(statusFilter);
      toast('Decision recorded');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'record failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Replay — ask what was decided before</h4>
        <p className="cc-hint" style={{ margin: '0 0 8px' }}>
          Replay returns the historical record when it exists — it never invents an explanation. A miss returns
          HISTORICAL_EVIDENCE_NOT_FOUND honestly.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="e.g. why did we choose postgres for the billing service?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Replay query"
          />
          <button className="cc-btn" disabled={replaying || !query.trim()} onClick={() => void replayNow()}>
            {replaying ? 'Replaying…' : 'Replay'}
          </button>
        </div>
        {replay && (
          <div className="cc-hint" style={{ marginTop: 10 }}>
            {replay.outcome === 'FOUND' && replay.decision ? (
              <>
                <span className="cc-pill" style={{ background: IMPACT_COLORS[replay.decision.impact] ?? '#334155', color: '#fff' }}>
                  {replay.decision.impact}
                </span>{' '}
                <strong>{replay.decision.title}</strong>
                <p style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{replay.decision.decision}</p>
                {replay.decision.rationale && <p style={{ margin: '4px 0' }}>Rationale: {replay.decision.rationale}</p>}
              </>
            ) : (
              <p>HISTORICAL_EVIDENCE_NOT_FOUND — no recorded decision matches. Record one below.</p>
            )}
          </div>
        )}
      </div>

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Record a decision</h4>
        <div className="cc-field">
          <label htmlFor="decision-title">Title</label>
          <input id="decision-title" className="cc-input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="cc-field">
          <label htmlFor="decision-body">What was decided and why</label>
          <textarea id="decision-body" className="cc-textarea" rows={3} value={decision} onChange={(e) => setDecision(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="cc-field">
            <label htmlFor="decision-impact">Impact</label>
            <select id="decision-impact" className="cc-select" value={impact} onChange={(e) => setImpact(e.target.value as 'LOW' | 'MEDIUM' | 'HIGH')}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High (replacement needs explicit approval)</option>
            </select>
          </div>
          <div className="cc-field" style={{ flex: 1 }}>
            <label htmlFor="decision-rationale">Rationale (optional)</label>
            <input id="decision-rationale" className="cc-input" value={rationale} onChange={(e) => setRationale(e.target.value)} />
          </div>
        </div>
        <button className="cc-btn" disabled={busy || !title.trim() || !decision.trim()} onClick={() => void record()}>
          Record
        </button>
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading decisions…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load decisions.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load(statusFilter)}>Retry</button>
        </div>
      )}
      <div className="cc-card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="cc-hint">Status:</span>
            {(['', 'ACTIVE', 'TENTATIVE', 'SUPERSEDED', 'REJECTED', 'ARCHIVED'] as const).map((s) => (
              <button
                key={s}
                className={`cc-btn cc-btn--sm ${statusFilter === s ? 'cc-btn--primary' : 'cc-btn--ghost'}`}
                onClick={() => setStatusFilter(s as DecisionStatus | '')}
                aria-pressed={statusFilter === s}
              >
                {s === '' ? 'All' : s.toLowerCase()}
              </button>
            ))}
          </div>
          <button className="cc-btn cc-btn--sm" disabled={exporting} onClick={() => void exportMarkdown()}>
            {exporting ? 'Exporting…' : 'Export decision.md'}
          </button>
        </div>
      </div>
      {state === 'ready' && decisions.length === 0 && <div className="cc-card cc-empty">No decisions recorded yet.</div>}
      {decisions.map((d) => (
        <div className="cc-card" key={d.id}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="cc-pill" style={{ background: IMPACT_COLORS[d.impact] ?? '#334155', color: '#fff' }}>{d.impact}</span>
            <span className="cc-pill" style={{ background: STATUS_COLORS[d.status] ?? '#334155', color: '#fff' }}>{d.status}</span>
            {d.scope && <span className="cc-pill">{d.scope}</span>}
            <strong>{d.title}</strong>
            {d.superseded_by_id && d.status === 'SUPERSEDED' && <span className="cc-pill">superseded</span>}
            <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>{new Date(d.created_at).toLocaleString()}</span>
          </div>
          <p style={{ margin: '6px 0', whiteSpace: 'pre-wrap' }}>{d.decision}</p>
          {d.context && <p className="cc-hint" style={{ margin: '2px 0' }}>Context: {d.context}</p>}
          {d.rationale && <p className="cc-hint" style={{ margin: '2px 0' }}>Rationale: {d.rationale}</p>}
          {d.alternatives.length > 0 && (
            <p className="cc-hint" style={{ margin: '2px 0' }}>Alternatives considered: {d.alternatives.join(' · ')}</p>
          )}
          {d.consequences.length > 0 && (
            <p className="cc-hint" style={{ margin: '2px 0' }}>Consequences: {d.consequences.join(' · ')}</p>
          )}
          {d.source_message_ids.length > 0 && (
            <button
              className="cc-btn cc-btn--ghost cc-btn--sm"
              onClick={() => void loadSources(d.id)}
              aria-expanded={!!sourcesOpen[d.id]}
            >
              {sourcesOpen[d.id] ? 'Hide' : 'Show'} source messages ({d.source_message_ids.length})
            </button>
          )}
          {sourcesOpen[d.id] && (
            <div className="cc-hint" style={{ marginTop: 4 }}>
              {(sources[d.id] ?? []).length === 0 && <p>No source message text available.</p>}
              {(sources[d.id] ?? []).map((s, i) => (
                <p key={`${d.id}:${i}`} style={{ margin: '2px 0' }}>
                  <span className="cc-mono">{s.id}</span> — {s.content.slice(0, 120)}
                </p>
              ))}
            </div>
          )}
          {(d.status === 'ACTIVE' || d.status === 'TENTATIVE') && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void setStatus(d.id, 'REJECTED')}>
                Reject
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void setStatus(d.id, 'ARCHIVED')}>
                Archive
              </button>
              {d.status === 'TENTATIVE' && (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void setStatus(d.id, 'ACTIVE')}>
                  Confirm active
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflicts

function ConflictsTab() {
  const { toast } = useToast();
  const [conflicts, setConflicts] = useState<ConflictRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [requestText, setRequestText] = useState('');
  const [detected, setDetected] = useState<DetectedConflict[] | null>(null);
  const [detecting, setDetecting] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<{ conflicts: ConflictRow[] }>('/api/v1/memory/decisions/conflicts');
      setConflicts(res.conflicts);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const detect = async () => {
    setDetecting(true);
    try {
      const res = await api<{ conflicts: DetectedConflict[] }>('/api/v1/memory/decisions/conflicts/detect', {
        method: 'POST',
        body: { requestText: requestText.trim() },
      });
      setDetected(res.conflicts);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'detection failed', 'error');
    } finally {
      setDetecting(false);
    }
  };

  const resolve = async (conflictId: string, resolution: 'KEEP' | 'REPLACE' | 'EXCEPTION' | 'CANCEL', note?: string) => {
    try {
      await api(`/api/v1/memory/decisions/conflicts/${conflictId}/resolve`, {
        method: 'POST',
        body: { resolution, note: note?.trim() || undefined },
      });
      toast(`Conflict resolved (${resolution})`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'resolution failed', 'error');
    }
  };

  return (
    <div>
      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Detect conflicts</h4>
        <p className="cc-hint" style={{ margin: '0 0 8px' }}>
          Paste a new instruction or request; the engine matches it against recorded decisions (token overlap, fully
          deterministic) and opens a conflict when they collide.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="e.g. rewrite the auth flow to use magic links"
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            aria-label="Request to check"
          />
          <button className="cc-btn" disabled={detecting || !requestText.trim()} onClick={() => void detect()}>
            {detecting ? 'Checking…' : 'Detect'}
          </button>
        </div>
        {detected && (
          <div style={{ marginTop: 10 }}>
            {detected.length === 0 ? (
              <p className="cc-hint">No conflicts detected against recorded decisions.</p>
            ) : (
              detected.map((c) => (
                <div key={c.conflictId} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '8px 0' }}>
                  <strong>Conflict with: {c.affectedDecision.title}</strong> ({c.affectedDecision.impact})
                  <p style={{ margin: '4px 0' }}>{c.contradiction}</p>
                  {c.consequence.map((x, i) => (
                    <p key={i} style={{ margin: '2px 0', color: '#b45309' }}>Consequence: {x}</p>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading conflicts…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load conflicts.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {state === 'ready' && conflicts.length === 0 && <div className="cc-card cc-empty">No conflicts recorded.</div>}
      {conflicts.map((c) => (
        <div className="cc-card" key={c.id}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="cc-pill" style={{ background: c.status === 'OPEN' ? '#b45309' : '#1e7d46', color: '#fff' }}>{c.status}</span>
            <strong>{c.request_text}</strong>
            <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>{new Date(c.created_at).toLocaleString()}</span>
          </div>
          {c.resolution && <p className="cc-hint" style={{ margin: '4px 0' }}>Resolution: {c.resolution}{c.note ? ` — ${c.note}` : ''}</p>}
          {c.status === 'OPEN' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {(['KEEP', 'REPLACE', 'EXCEPTION', 'CANCEL'] as const).map((r) => (
                <button key={r} className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void resolve(c.id, r)}>
                  {r === 'KEEP' ? 'Keep decision' : r === 'REPLACE' ? 'Replace' : r === 'EXCEPTION' ? 'Exception' : 'Cancel request'}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Continuity

function ContinuityTab() {
  const { toast } = useToast();
  const [patterns, setPatterns] = useState<PatternRow[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRow[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [optIn, setOptIn] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [generating, setGenerating] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const pr = await api<{ projects: { id: string; name: string }[] }>('/api/v1/projects');
      setProjects(pr.projects);
      const suggestProject = projectId || pr.projects[0]?.id;
      if (suggestProject && suggestProject !== projectId) setProjectId(suggestProject);
      const [s, h, t, o] = await Promise.all([
        suggestProject
          ? api<{ suggestions: PatternRow[]; optIn: boolean }>(`/api/v1/memory/cross-project/patterns/suggest?projectId=${suggestProject}`)
          : Promise.resolve({ suggestions: [], optIn: false }),
        api<{ handoffs: HandoffRow[] }>('/api/v1/memory/handoffs').catch(() => ({ handoffs: [] })),
        api<{ items: TimelineItem[] }>('/api/v1/memory/timeline').catch(() => ({ items: [] })),
        api<{ optIn: boolean }>('/api/v1/memory/cross-project/opt-in').catch(() => ({ optIn: false })),
      ]);
      setPatterns(s.suggestions);
      setHandoffs(h.handoffs);
      setTimeline(t.items);
      setOptIn(o.optIn);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleOptIn = async (enabled: boolean) => {
    try {
      await api('/api/v1/memory/cross-project/opt-in', { method: 'POST', body: { enabled } });
      setOptIn(enabled);
      toast(enabled ? 'Cross-project memory enabled' : 'Cross-project memory disabled');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
    }
  };

  const generateHandoff = async () => {
    setGenerating(true);
    try {
      const res = await api<{ title: string; content: string }>(`/api/v1/memory/handoffs/generate${projectId ? `?projectId=${projectId}` : ''}`);
      const saved = await api<{ handoff: HandoffRow }>('/api/v1/memory/handoffs', {
        method: 'POST',
        body: { title: res.title, content: res.content },
      });
      // Replace-by-id, not blind prepend: the saved row may already be in the
      // list (list refetch racing the save), and a duplicate id both renders
      // the handoff twice and trips React's duplicate-key warning.
      setHandoffs((prev) => [saved.handoff, ...prev.filter((h) => h.id !== saved.handoff.id)]);
      toast('Handoff generated from live state');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'generate failed', 'error');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div>
      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Cross-project pattern memory</h4>
        <p className="cc-hint" style={{ margin: '0 0 8px' }}>
          Proven patterns from other projects are suggested read-only — never auto-applied. The engine only reads from
          projects you own, and only when you opt in.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="cc-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={optIn} onChange={(e) => void toggleOptIn(e.target.checked)} />
            Allow suggestions from my other projects
          </label>
          <select className="cc-select" style={{ width: 'auto' }} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Suggestions project">
            <option value="">No project selected</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {patterns.length === 0 && <p className="cc-hint" style={{ margin: '8px 0 0' }}>{optIn ? 'No pattern suggestions yet.' : 'Opt in to see patterns from your other projects.'}</p>}
        {patterns.map((p) => (
          <div key={p.id} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '8px 0' }}>
            <strong style={{ fontSize: 13 }}>{p.name}</strong>{' '}
            <span className="cc-pill" style={{ fontSize: 11 }}>{p.proven ? 'proven' : 'candidate'}</span>{' '}
            <span className="cc-mono" style={{ fontSize: 11 }}>applied {p.applied_count}x</span>
            {p.tag && <span className="cc-pill" style={{ fontSize: 11 }}>{p.tag}</span>}
            <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{p.pattern}</p>
          </div>
        ))}
      </div>

      <div className="cc-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <h4 style={{ margin: 0 }}>Handoffs</h4>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={generating} onClick={() => void generateHandoff()}>
            {generating ? 'Generating…' : '+ Generate handoff'}
          </button>
        </div>
        <p className="cc-hint" style={{ margin: '6px 0' }}>
          Handoffs are exported from REAL state (DNA, decisions, tasks, runs) — nothing here is invented.
        </p>
        {handoffs.length === 0 && <p className="cc-hint">No handoffs yet.</p>}
        {handoffs.map((h) => (
          <div key={h.id} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '8px 0' }}>
            <strong style={{ fontSize: 13 }}>{h.title}</strong>{' '}
            <span className="cc-mono" style={{ fontSize: 11 }}>{new Date(h.created_at).toLocaleString()}</span>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', fontSize: 12, maxHeight: 220, overflow: 'auto' }}>{h.content}</pre>
          </div>
        ))}
      </div>

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Timeline (last 24h, server-recorded events)</h4>
        {state === 'loading' && <p className="cc-hint">Loading…</p>}
        {state === 'error' && (
          <p className="cc-hint">Timeline unavailable.</p>
        )}
        {state === 'ready' && timeline.length === 0 && <p className="cc-hint">No events in the window.</p>}
        {timeline.slice(0, 50).map((t, i) => (
          <div key={`${t.type}:${t.id}:${i}`} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '6px 0' }}>
            <span className="cc-pill" style={{ fontSize: 11 }}>{t.type}</span>{' '}
            <strong style={{ fontSize: 13 }}>{t.title}</strong>
            {t.detail && <span className="cc-mono" style={{ fontSize: 11 }}> — {t.detail}</span>}
            <span className="cc-mono" style={{ fontSize: 11, float: 'right' }}>{new Date(t.at).toLocaleString()}</span>
          </div>
        ))}
        {timeline.length > 50 && (
          <p className="cc-hint" style={{ margin: '8px 0 0' }}>Showing the 50 most recent events ({timeline.length} in the window).</p>
        )}
      </div>
    </div>
  );
}