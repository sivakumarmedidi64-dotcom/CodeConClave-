/**
 * CodeConClave — Recovery (Stage 26I): failure autopsies + time travel.
 * Pick a task, run an autopsy (evidence-backed root cause + prevention),
 * snapshot checkpoints, branch or rewind to a checkpoint. Rewinds are
 * blocked when irreversible actions exist after the checkpoint — the server
 * reports that honestly. Renders server state only.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type {
  AutopsyRow,
  BranchResultRow,
  CheckpointRow,
  Project,
  RecoveryHistoryEntry,
  Task,
} from '../lib/types';
import { useToast } from '../components/Toast';

type RecoveryTab = 'autopsy' | 'timetravel';

export function RecoveryPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<RecoveryTab>('autopsy');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState('');
  const [tasksState, setTasksState] = useState<'loading' | 'ready' | 'error'>('loading');

  const loadProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>('/api/v1/projects');
      setProjects(res.projects);
      if (res.projects[0] && !projectId) setProjectId(res.projects[0].id);
    } catch {
      setProjects([]);
    }
  }, [projectId]);

  const loadTasks = useCallback(async () => {
    if (!projectId) {
      setTasks([]);
      setTasksState('ready');
      return;
    }
    setTasksState('loading');
    try {
      const res = await api<{ tasks: Task[] }>(`/api/v1/execution/tasks?projectId=${projectId}`);
      setTasks(res.tasks);
      setTasksState('ready');
    } catch {
      setTasks([]);
      setTasksState('error');
    }
  }, [projectId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const clear = () => setTaskId('');

  return (
    <div className="cc-page">
      <h1 style={{ marginBottom: 4 }}>Recovery</h1>
      <p className="cc-hint" style={{ marginTop: 0 }}>
        Failure autopsies and time travel for execution tasks. Every operation is recorded in the recovery history —
        nothing is invented.
      </p>

      <div className="cc-card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="cc-field" style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="recovery-project">Project</label>
            <select id="recovery-project" className="cc-select" value={projectId} onChange={(e) => { setProjectId(e.target.value); clear(); }}>
              <option value="">Select project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="cc-field" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="recovery-task">Task</label>
            <select id="recovery-task" className="cc-select" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">Select task…</option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>{t.title} ({t.status})</option>
              ))}
            </select>
          </div>
        </div>
        {tasksState === 'loading' && <p className="cc-hint">Loading tasks…</p>}
        {tasksState === 'error' && <p className="cc-hint" style={{ color: '#dc2626' }}>Could not load tasks — check the project.</p>}
        {tasksState === 'ready' && tasks.length === 0 && <p className="cc-hint">No tasks in this project yet.</p>}
      </div>

      <div className="cc-tabs" role="tablist" aria-label="Recovery sections">
        {([
          ['autopsy', 'Autopsy'],
          ['timetravel', 'Time travel'],
        ] as [RecoveryTab, string][]).map(([key, label]) => (
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

      {tab === 'autopsy' && <AutopsyTab taskId={taskId} />}
      {tab === 'timetravel' && <TimeTravelTab taskId={taskId} />}
    </div>
  );
}

function AutopsyTab({ taskId }: { taskId: string }) {
  const { toast } = useToast();
  const [autopsy, setAutopsy] = useState<AutopsyRow | null>(null);
  const [autopsies, setAutopsies] = useState<AutopsyRow[]>([]);
  const [history, setHistory] = useState<RecoveryHistoryEntry[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) {
      setState('idle');
      setAutopsy(null);
      setAutopsies([]);
      setHistory([]);
      return;
    }
    setState('loading');
    try {
      const [a, as, h] = await Promise.all([
        api<{ autopsy: AutopsyRow | null }>(`/api/v1/recovery/tasks/${taskId}/autopsy`).catch(() => ({ autopsy: null })),
        api<{ autopsies: AutopsyRow[] }>(`/api/v1/recovery/tasks/${taskId}/autopsies`).catch(() => ({ autopsies: [] })),
        api<{ history: RecoveryHistoryEntry[] }>(`/api/v1/recovery/tasks/${taskId}/history`).catch(() => ({ history: [] })),
      ]);
      setAutopsy(a.autopsy);
      setAutopsies(as.autopsies ?? []);
      setHistory(h.history ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setGenerating(true);
    try {
      const res = await api<{ autopsy: AutopsyRow }>(`/api/v1/recovery/tasks/${taskId}/autopsy`, { method: 'POST', body: {} });
      setAutopsy(res.autopsy);
      toast('Autopsy generated from recorded error evidence');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'autopsy failed', 'error');
    } finally {
      setGenerating(false);
    }
  };

  if (!taskId) return <div className="cc-card cc-empty">Select a task to inspect its failure record.</div>;
  if (state === 'loading') return <div className="cc-card cc-empty">Loading autopsy…</div>;
  if (state === 'error') {
    return (
      <div className="cc-card cc-error-state">
        <p className="cc-hint">Could not load the autopsy.</p>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div className="cc-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h4 style={{ margin: 0 }}>Failure autopsy</h4>
          <button className="cc-btn cc-btn--sm" disabled={generating} onClick={() => void generate()}>
            {generating ? 'Analyzing…' : '+ Generate autopsy'}
          </button>
        </div>
        <p className="cc-hint" style={{ margin: '6px 0' }}>
          Autopsies classify the root cause from stored error evidence (rule-based, no invention). Prevention is
          evidence-backed, and failure knowledge is stored as semantic memory.
        </p>
        {!autopsy && <p className="cc-hint">No autopsy recorded for this task yet.</p>}
        {autopsy && (
          <div style={{ marginTop: 8 }}>
            <p style={{ margin: '4px 0' }}>
              <span className="cc-pill" style={{ background: autopsy.status === 'RECOVERED' ? '#1e7d46' : '#dc2626', color: '#fff' }}>
                {autopsy.status}
              </span>{' '}
              <span className="cc-pill" style={{ background: '#0f766e', color: '#fff' }}>{autopsy.root_cause_code}</span>{' '}
              <span className="cc-hint cc-mono" style={{ fontSize: 12 }}>confidence {Number(autopsy.confidence).toFixed(2)}</span>
            </p>
            {autopsy.root_cause && <p style={{ margin: '4px 0' }}>{autopsy.root_cause}</p>}
{autopsy.successful_fix != null && (
              <p style={{ margin: '4px 0' }}>
                <strong>Fix:</strong>{' '}
                {String(typeof autopsy.successful_fix === 'string' ? autopsy.successful_fix : JSON.stringify(autopsy.successful_fix))}
              </p>
            )}
            {autopsy.prevention != null && (
              <p className="cc-hint" style={{ margin: '4px 0' }}>
                <strong>Prevention:</strong>{' '}
                {String(typeof autopsy.prevention === 'string' ? autopsy.prevention : JSON.stringify(autopsy.prevention))}
              </p>
            )}
            {autopsy.memory_id && (
              <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 12 }}>
                Failure knowledge stored as memory {autopsy.memory_id}
              </p>
            )}
            <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 11 }}>{new Date(autopsy.created_at).toLocaleString()}</p>
          </div>
        )}
      </div>

      {autopsies.length > 0 && (
        <div className="cc-card">
          <h4 style={{ margin: '0 0 8px' }}>All autopsies for this task</h4>
          {autopsies.map((a) => (
            <div key={a.id} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '6px 0' }}>
              <span className="cc-pill" style={{ fontSize: 11 }}>{a.status}</span>{' '}
              <span className="cc-pill" style={{ fontSize: 11, background: '#0f766e', color: '#fff' }}>{a.root_cause_code}</span>{' '}
              <span className="cc-mono" style={{ fontSize: 11 }}>{new Date(a.created_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Recovery history (immutable)</h4>
        {history.length === 0 && <p className="cc-hint">No recovery events recorded.</p>}
        {history.map((h) => (
          <div key={h.id} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '6px 0' }}>
            <span className="cc-pill" style={{ fontSize: 11 }}>{h.event}</span>{' '}
            <span className="cc-mono" style={{ fontSize: 12 }}>{new Date(h.created_at).toLocaleString()}</span>
            {h.detail != null && <span style={{ fontSize: 12 }}> — {String(typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail))}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TimeTravelTab({ taskId }: { taskId: string }) {
  const { toast } = useToast();
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [history, setHistory] = useState<RecoveryHistoryEntry[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [branchLabel, setBranchLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BranchResultRow | null>(null);

  const load = useCallback(async () => {
    if (!taskId) {
      setState('idle');
      setCheckpoints([]);
      setHistory([]);
      return;
    }
    setState('loading');
    try {
      const [c, h] = await Promise.all([
        api<{ checkpoints: CheckpointRow[] }>(`/api/v1/recovery/tasks/${taskId}/checkpoints`).catch(() => ({ checkpoints: [] })),
        api<{ history: RecoveryHistoryEntry[] }>(`/api/v1/recovery/tasks/${taskId}/history`).catch(() => ({ history: [] })),
      ]);
      setCheckpoints(c.checkpoints ?? []);
      setHistory(h.history ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const createCheckpoint = async () => {
    setBusy(true);
    try {
      await api(`/api/v1/recovery/tasks/${taskId}/checkpoints`, {
        method: 'POST',
        body: { label: label.trim() || undefined, reason: reason.trim() || undefined },
      });
      setLabel('');
      setReason('');
      toast('Checkpoint created — full task state snapshot');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'checkpoint failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const branch = async (checkpointId?: string) => {
    setBusy(true);
    try {
      const res = await api<BranchResultRow>(`/api/v1/recovery/tasks/${taskId}/branch`, {
        method: 'POST',
        body: { checkpointId, label: branchLabel.trim() || undefined },
      });
      setResult(res);
      toast('Task branched — new task created from checkpoint state');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'branch failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rewind = async (checkpointId: string) => {
    setBusy(true);
    try {
      const res = await api<BranchResultRow>(`/api/v1/recovery/tasks/${taskId}/rewind`, {
        method: 'POST',
        body: { checkpointId },
      });
      setResult(res);
      toast('Task rewound to checkpoint');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'rewind failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!taskId) return <div className="cc-card cc-empty">Select a task to snapshot, branch or rewind it.</div>;
  if (state === 'loading') return <div className="cc-card cc-empty">Loading checkpoints…</div>;
  if (state === 'error') {
    return (
      <div className="cc-card cc-error-state">
        <p className="cc-hint">Could not load checkpoints.</p>
        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Snapshot a checkpoint</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="Label (e.g. before changing the auth flow)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Checkpoint label"
          />
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="Checkpoint reason"
          />
          <button className="cc-btn" disabled={busy} onClick={() => void createCheckpoint()}>Create checkpoint</button>
        </div>
      </div>

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Checkpoints</h4>
        <p className="cc-hint" style={{ margin: '0 0 8px' }}>
          Branch forks a new task from a checkpoint; rewind restores it. Rewind is blocked if irreversible actions
          were recorded after the checkpoint — the server reports the blocker honestly.
        </p>
        {checkpoints.length === 0 && <p className="cc-hint">No checkpoints yet.</p>}
        {checkpoints.map((c) => (
          <div key={c.id} className="cc-hint" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid #1e293b', padding: '6px 0' }}>
            <span className="cc-mono" style={{ fontSize: 12 }}>{new Date(c.created_at).toLocaleString()}</span>
            <strong style={{ fontSize: 13 }}>{c.label ?? 'checkpoint'}</strong>
            {c.reason && <span style={{ fontSize: 12 }}>— {c.reason}</span>}
            <span className="cc-hint cc-mono" style={{ fontSize: 11 }}>stage {c.stage_index}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={busy} onClick={() => void branch(c.id)}>Branch</button>
              <button className="cc-btn cc-btn--danger cc-btn--sm" disabled={busy} onClick={() => void rewind(c.id)}>Rewind</button>
            </div>
          </div>
        ))}
      </div>

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Branch (no checkpoint = snapshot now)</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="cc-input"
            style={{ flex: 1, minWidth: 180 }}
            placeholder="Branch label (optional)"
            value={branchLabel}
            onChange={(e) => setBranchLabel(e.target.value)}
            aria-label="Branch label"
          />
          <button className="cc-btn cc-btn--ghost" disabled={busy} onClick={() => void branch()}>Branch now</button>
        </div>
        {result && (
          <p className="cc-hint" style={{ margin: '8px 0 0' }}>
            Created task <span className="cc-mono">{result.branchTask.id}</span> — {result.branchTask.title} ({result.branchTask.status})
          </p>
        )}
      </div>

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Recovery history (immutable)</h4>
        {history.length === 0 && <p className="cc-hint">No recovery events recorded.</p>}
        {history.map((h) => (
          <div key={h.id} className="cc-hint" style={{ borderTop: '1px solid #1e293b', padding: '6px 0' }}>
            <span className="cc-pill" style={{ fontSize: 11 }}>{h.event}</span>{' '}
            <span className="cc-mono" style={{ fontSize: 12 }}>{new Date(h.created_at).toLocaleString()}</span>
            {h.detail != null && <span style={{ fontSize: 12 }}> — {String(typeof h.detail === 'string' ? h.detail : JSON.stringify(h.detail))}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}