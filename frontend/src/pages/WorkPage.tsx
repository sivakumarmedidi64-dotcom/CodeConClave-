/**
 * CodeConClave — 24/7 Work: the task queue (create, cancel, poll status)
 * plus the Artifact Center (artifacts produced by tasks and coworkers).
 * Approvals surface separately under Approvals.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { ArtifactInfo, PreviewSession, Task, TaskTimeline } from '../lib/types';
import { useToast } from '../components/Toast';

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: '#1e7d46',
  VERIFIED: '#1e7d46',
  FAILED: '#b3261e',
  TIMED_OUT: '#b3261e',
  CANCELLED: '#6b675e',
  WAITING_APPROVAL: '#c15f3c',
  RUNNING: '#2f6fdb',
  WAITING_FOR_LOCAL_AGENT: '#b1ada1',
};

const PREVIEW_COLOR: Record<string, { label: string; color: string }> = {
  BUILDING: { label: 'Building', color: '#2f6fdb' },
  UPDATING: { label: 'Updating', color: '#2f6fdb' },
  READY: { label: 'Ready', color: '#1e7d46' },
  ERROR: { label: 'Build error', color: '#b3261e' },
  OFFLINE: { label: 'Offline', color: '#6b675e' },
  NOT_CONFIGURED: { label: 'Not configured', color: '#6b675e' },
};

const PREVIEW_ACTIVE = new Set(['BUILDING', 'UPDATING']);

export function WorkPage() {
  const { toast } = useToast();
  const [projectId, setProjectId] = useState<string>('');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [riskLevel, setRiskLevel] = useState('MEDIUM');
  const [executionMode, setExecutionMode] = useState('CLOUD');
  const [busy, setBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [artifactForm, setArtifactForm] = useState<{ taskId: string; name: string; kind: string; content: string; verification: string }>({
    taskId: '',
    name: '',
    kind: 'report',
    content: '',
    verification: '',
  });
  const [downloaded, setDownloaded] = useState<Record<string, { content: string | null; encoding: string }>>({});
  const [tasksState, setTasksState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [detailOpen, setDetailOpen] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<Record<string, TaskTimeline | null>>({});
  const [loadingDetail, setLoadingDetail] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<PreviewSession | null>(null);
  const [previewConfigured, setPreviewConfigured] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ projects: { id: string; name: string }[] }>('/api/v1/projects')
      .then((res) => {
        setProjects(res.projects);
        if (res.projects.length > 0) setProjectId(res.projects[0]!.id);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setTasks([]);
      setTasksState('ready');
      return;
    }
    setTasksState('loading');
    try {
      const res = await api<{ tasks: Task[] }>(`/api/v1/execution/tasks?projectId=${encodeURIComponent(projectId)}`);
      setTasks(res.tasks);
      setTasksState('ready');
    } catch (err) {
      setTasks([]);
      setTasksState('error');
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  }, [projectId, toast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const loadPreview = useCallback(async () => {
    if (!projectId) {
      setPreview(null);
      return;
    }
    try {
      const res = await api<{ session: PreviewSession; configured: boolean }>(`/api/v1/preview/${encodeURIComponent(projectId)}`);
      setPreview(res.session);
      setPreviewConfigured(res.configured);
      setPreviewError(null);
    } catch {
      setPreviewError('Preview status unavailable for this project.');
    }
  }, [projectId]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  // Bounded live refresh: only while a build is actually running.
  useEffect(() => {
    if (!projectId || !preview || !PREVIEW_ACTIVE.has(preview.state)) return;
    const timer = window.setInterval(() => void loadPreview(), 5000);
    return () => window.clearInterval(timer);
  }, [projectId, preview, loadPreview]);

  const refreshPreview = async () => {
    if (!projectId) return;
    setPreviewLoading(true);
    try {
      const res = await api<{ session: PreviewSession }>(`/api/v1/preview/${encodeURIComponent(projectId)}/refresh`, { method: 'POST' });
      setPreview(res.session);
      setPreviewError(null);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Preview refresh failed.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const openPreview = () => {
    if (!projectId) return;
    window.open(`/api/v1/preview/${encodeURIComponent(projectId)}/content`, '_blank', 'noopener');
  };

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/v1/execution/tasks', {
        method: 'POST',
        body: {
          projectId,
          title: title.trim(),
          description,
          riskLevel,
          executionMode,
        },
      });
      setTitle('');
      setDescription('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await api(`/api/v1/execution/tasks/${id}/cancel`, { method: 'POST', body: { reason: 'Cancelled from UI' } });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'cancel failed', 'error');
    }
  };

  const loadArtifacts = useCallback(async () => {
    if (!projectId) {
      setArtifacts([]);
      return;
    }
    try {
      const res = await api<{ artifacts: ArtifactInfo[] }>(`/api/v1/artifacts?projectId=${encodeURIComponent(projectId)}`);
      setArtifacts(res.artifacts);
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    void loadArtifacts();
  }, [loadArtifacts]);

  const createArtifact = async () => {
    if (!artifactForm.taskId || !artifactForm.name.trim()) {
      toast('taskId and name are required', 'error');
      return;
    }
    setBusy(true);
    try {
      await api('/api/v1/artifacts', {
        method: 'POST',
        body: {
          taskId: artifactForm.taskId,
          name: artifactForm.name.trim(),
          kind: artifactForm.kind,
          content: artifactForm.content || undefined,
          verification: artifactForm.verification || undefined,
        },
      });
      setArtifactForm((prev) => ({ ...prev, name: '', content: '' }));
      await loadArtifacts();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'artifact failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const download = async (id: string) => {
    try {
      const res = await api<{ artifact: { content: string | null; encoding: string } }>(`/api/v1/artifacts/${id}/download`);
      setDownloaded((prev) => ({ ...prev, [id]: res.artifact }));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'download failed', 'error');
    }
  };

  const toggleDetail = async (id: string) => {
    const isOpen = Boolean(detailOpen[id]);
    setDetailOpen((prev) => ({ ...prev, [id]: !isOpen }));
    if (!isOpen) {
      setLoadingDetail((prev) => ({ ...prev, [id]: true }));
      try {
        const res = await api<TaskTimeline>(`/api/v1/execution/tasks/${id}`);
        setDetails((prev) => ({ ...prev, [id]: res }));
      } catch {
        setDetails((prev) => ({ ...prev, [id]: null }));
      } finally {
        setLoadingDetail((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  const retry = async (id: string) => {
    try {
      await api(`/api/v1/execution/tasks/${id}/retry`, { method: 'POST', body: { reason: 'Retried from 24/7 Work' } });
      toast('Task re-queued');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'retry failed', 'error');
    }
  };

  return (
    <div className="cc-page">
      <h1>24/7 Work</h1>
      <div className="cc-card">
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 140px 140px', marginBottom: 8 }}>
          <input className="cc-input" placeholder="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className="cc-select" value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
            <option value="LOW">LOW</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="HIGH">HIGH</option>
            <option value="CRITICAL">CRITICAL</option>
          </select>
          <select className="cc-select" value={executionMode} onChange={(e) => setExecutionMode(e.target.value)}>
            <option value="CLOUD">CLOUD</option>
            <option value="HYBRID">HYBRID</option>
            <option value="LOCAL">LOCAL</option>
          </select>
        </div>
        <textarea
          className="cc-textarea"
          rows={2}
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <select className="cc-select" style={{ width: 260 }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button className="cc-btn" disabled={busy || !title.trim() || !projectId} onClick={() => void create()}>
            Dispatch task
          </button>
        </div>
      </div>
      <div className="cc-hint">
        HIGH/CRITICAL tasks wait for human approval (Approvals) before any tool runs.
        LOCAL mode waits for a paired Local Agent.
      </div>
      {tasksState === 'loading' && <div className="cc-card cc-empty">Loading tasks…</div>}
      {tasksState === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load the task queue.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {tasksState === 'ready' && tasks.length === 0 && <div className="cc-card cc-empty">No tasks yet.</div>}
      {tasks.map((t) => (
        <div className="cc-card" key={t.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <strong>{t.title}</strong>
              {t.description && <div className="cc-hint">{t.description}</div>}
              <div className="cc-hint" style={{ marginTop: 4 }}>
                {t.executionMode} · {t.riskLevel} · pipeline: {t.coworkerPipeline.join(' → ') || 'default'}
              </div>
              {t.executionMode === 'LOCAL' && t.status === 'WAITING_FOR_LOCAL_AGENT' && (
                <div className="cc-hint" style={{ marginTop: 4 }}>
                  This task is waiting for a paired Local Agent and cannot run until one is online.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              <span className="cc-pill" style={{ borderColor: STATUS_COLOR[t.status] ?? '#ccc', color: STATUS_COLOR[t.status] ?? '#111' }}>
                {t.status}
              </span>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleDetail(t.id)}>
                {detailOpen[t.id] ? 'Hide details' : 'Details'}
              </button>
              {!['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(t.status) && (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void cancel(t.id)}>
                  Cancel
                </button>
              )}
              {['FAILED', 'TIMED_OUT'].includes(t.status) && (
                <button className="cc-btn cc-btn--sm" onClick={() => void retry(t.id)}>
                  Retry
                </button>
              )}
            </div>
          </div>
          {detailOpen[t.id] && (
            <div className="cc-timeline" style={{ marginTop: 12 }}>
              {loadingDetail[t.id] && <p className="cc-hint">Loading timeline…</p>}
              {!loadingDetail[t.id] && details[t.id] === null && <p className="cc-hint">Timeline unavailable.</p>}
              {!loadingDetail[t.id] && details[t.id] && (
                <>
                  <h4 style={{ marginTop: 8 }}>Steps</h4>
                  {details[t.id]!.steps.length === 0 && <p className="cc-hint">No steps recorded.</p>}
                  {details[t.id]!.steps.map((s) => (
                    <div className="cc-timeline__item" key={s.id}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <strong>{s.title}</strong>
                        <span className="cc-pill" style={{ fontSize: 11 }}>{s.status}</span>
                      </div>
                      {s.output && <div className="cc-hint">{s.output}</div>}
                      {s.error_code && <div className="cc-error">{s.error_code}</div>}
                      <div className="cc-timeline__time">
                        {s.started_at ? new Date(s.started_at).toLocaleString() : ''}
                        {s.completed_at ? ` → ${new Date(s.completed_at).toLocaleString()}` : ''}
                      </div>
                    </div>
                  ))}
                  <h4 style={{ marginTop: 12 }}>Attempts</h4>
                  {details[t.id]!.attempts.length === 0 && <p className="cc-hint">No attempts recorded.</p>}
                  {details[t.id]!.attempts.map((a) => (
                    <div className="cc-timeline__item" key={a.id}>
                      attempt {a.attempt_number} — {a.result ?? 'running'}
                      {a.error_code ? ` · ${a.error_code}` : ''}
                      {a.output_summary ? <div className="cc-hint">{a.output_summary}</div> : null}
                      <div className="cc-timeline__time">
                        {new Date(a.started_at).toLocaleString()}
                        {a.finished_at ? ` → ${new Date(a.finished_at).toLocaleString()}` : ''}
                      </div>
                    </div>
                  ))}
                  <h4 style={{ marginTop: 12 }}>Tool calls</h4>
                  {details[t.id]!.toolCalls.length === 0 && <p className="cc-hint">No tool calls recorded.</p>}
                  {details[t.id]!.toolCalls.map((tc) => (
                    <div className="cc-timeline__item" key={tc.id}>
                      <span className="cc-code">{tc.tool}</span> — {tc.decision}
                      {tc.error_code ? <span className="cc-error"> · {tc.error_code}</span> : null}
                    </div>
                  ))}
                  <h4 style={{ marginTop: 12 }}>Coworker runs</h4>
                  {details[t.id]!.coworkerRuns.length === 0 && <p className="cc-hint">No coworker runs yet.</p>}
                  {details[t.id]!.coworkerRuns.map((r) => (
                    <div className="cc-timeline__item" key={r.id}>
                      <strong>{r.coworkerType}</strong> — <span className="cc-pill" style={{ fontSize: 11 }}>{r.state}</span>
                      {r.handoffTo && <span className="cc-hint"> → {r.handoffTo}</span>}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      ))}
      <h2 style={{ marginTop: 20 }}>Live Preview</h2>
      <div className="cc-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <strong>Project preview</strong>
            {preview && (
              <span
                className="cc-pill"
                style={{ marginLeft: 8, borderColor: PREVIEW_COLOR[preview.state]?.color ?? '#ccc', color: PREVIEW_COLOR[preview.state]?.color ?? '#111' }}
              >
                {PREVIEW_COLOR[preview.state]?.label ?? preview.state} · v{preview.version}
              </span>
            )}
            {preview?.task_id && <div className="cc-hint" style={{ marginTop: 4 }}>built for task {preview.task_id}</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={previewLoading || !projectId} onClick={() => void refreshPreview()}>
              {previewLoading ? 'Building…' : 'Rebuild'}
            </button>
            <button className="cc-btn cc-btn--sm" disabled={!projectId} onClick={openPreview}>
              Open in new tab
            </button>
          </div>
        </div>
        {!projectId && <div className="cc-hint" style={{ marginTop: 8 }}>Select a project to see its preview.</div>}
        {projectId && previewError && <div className="cc-error" style={{ marginTop: 8 }}>{previewError}</div>}
        {projectId && !previewError && preview && (
          <div style={{ marginTop: 8 }}>
            {preview.state === 'NOT_CONFIGURED' && (
              <p className="cc-hint">
                Preview tooling is not configured on this deployment — the session is honestly NOT_CONFIGURED (no fake render). Set
                PREVIEW_BUILD_ENABLED + a build command to enable local builds.
              </p>
            )}
            {preview.state === 'OFFLINE' && <p className="cc-hint">Preview tooling is configured but the build host is offline.</p>}
            {PREVIEW_ACTIVE.has(preview.state) && <p className="cc-hint">A build is running…</p>}
            {preview.state === 'READY' && (
              <p className="cc-hint">Build succeeded. Open it in a new tab (strict CSP — it cannot be embedded).</p>
            )}
            {preview.state === 'ERROR' && <div className="cc-error">{preview.error ?? 'Build failed.'}</div>}
            {preview.build_log.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary className="cc-hint">Build log ({preview.build_log.length} lines)</summary>
                <pre className="cc-mono" style={{ background: 'var(--cc-bg)', padding: 8, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {preview.build_log.slice(-30).join('\n')}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
      <h2 style={{ marginTop: 20 }}>Artifact Center</h2>
      <div className="cc-card">
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 140px 1fr', marginBottom: 8 }}>
          <input
            className="cc-input"
            placeholder="Task id"
            value={artifactForm.taskId}
            onChange={(e) => setArtifactForm((prev) => ({ ...prev, taskId: e.target.value }))}
          />
          <select
            className="cc-select"
            value={artifactForm.kind}
            onChange={(e) => setArtifactForm((prev) => ({ ...prev, kind: e.target.value }))}
          >
            <option value="report">report</option>
            <option value="log">log</option>
            <option value="patch">patch</option>
            <option value="test">test</option>
            <option value="analysis">analysis</option>
          </select>
          <select
            className="cc-select"
            value={artifactForm.verification}
            onChange={(e) => setArtifactForm((prev) => ({ ...prev, verification: e.target.value }))}
          >
            <option value="">no verification</option>
            <option value="PASS">PASS</option>
            <option value="FAIL">FAIL</option>
            <option value="SKIPPED">SKIPPED</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="cc-input"
            placeholder="Artifact name"
            value={artifactForm.name}
            onChange={(e) => setArtifactForm((prev) => ({ ...prev, name: e.target.value }))}
          />
          <button className="cc-btn" disabled={busy} onClick={() => void createArtifact()}>
            Record artifact
          </button>
        </div>
        <textarea
          className="cc-textarea"
          rows={2}
          style={{ marginTop: 8 }}
          placeholder="Content (optional; stored inline)"
          value={artifactForm.content}
          onChange={(e) => setArtifactForm((prev) => ({ ...prev, content: e.target.value }))}
        />
      </div>
      {artifacts.length === 0 && <div className="cc-card cc-empty">No artifacts yet.</div>}
      {artifacts.map((a) => (
        <div className="cc-card" key={a.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <strong>{a.name}</strong>
              <div className="cc-hint">
                {a.source} · {a.kind} · {(a.sizeBytes / 1024).toFixed(1)} KB · sha {a.sha256.slice(0, 12)} ·{' '}
                {new Date(a.createdAt).toLocaleString()}
              </div>
              {a.taskTitle && <div className="cc-hint">task: {a.taskTitle}</div>}
              {a.verification && <div className="cc-hint">verification: {a.verification}</div>}
              {downloaded[a.id] && (
                <pre className="cc-mono" style={{ background: 'var(--cc-bg)', padding: 8, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {downloaded[a.id]!.content === null
                    ? '(empty)'
                    : downloaded[a.id]!.encoding === 'base64'
                      ? `[base64, ${downloaded[a.id]!.content!.length} chars]`
                      : downloaded[a.id]!.content}
                </pre>
              )}
            </div>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void download(a.id)}>
              Download
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}