/**
 * CodeConClave — main workspace (Stage 26G).
 * CHAT + CODE + PREVIEW in one project-scoped workspace. CHAT composes real
 * tasks through the execution engine; CODE shows the real file tree, change
 * heatmap and proof-of-work reports; PREVIEW reuses the live PreviewPanel and
 * adds review comments (each comment creates a real task), snapshot capture
 * and the honest visual diff (no fabricated before/after).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { PreviewPanel } from '../components/PreviewPanel';
import { useToast } from '../components/Toast';
import type {
  FileTreeNode,
  HeatmapCell,
  PreviewCommentRow,
  ProofOfWorkRow,
  Task,
  VisualDiff,
} from '../lib/types';

const TABS = ['CHAT', 'CODE', 'PREVIEW'] as const;
type Tab = (typeof TABS)[number];

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const RISK_COLORS: Record<string, string> = {
  LOW: '#16a34a',
  MEDIUM: '#f59e0b',
  HIGH: '#d97706',
  CRITICAL: '#dc2626',
};

function TreeView({ nodes, depth }: { nodes: FileTreeNode[]; depth: number }) {
  if (nodes.length === 0) return <p className="cc-hint" style={{ margin: 0 }}>No files in this project yet.</p>;
  return (
    <ul style={{ margin: 0, paddingLeft: depth > 0 ? 14 : 0, listStyle: 'none' }}>
      {nodes.map((n) => (
        <li key={`${depth}-${n.path}`} style={{ marginBottom: 2 }}>
          <span className="cc-mono" style={{ fontSize: 12 }}>
            {n.type === 'folder' ? '▸ ' : '· '}
            {n.name}
          </span>
          {n.children && <TreeView nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function WorkspacePage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('CHAT');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapCell[]>([]);
  const [comments, setComments] = useState<PreviewCommentRow[]>([]);
  const [diff, setDiff] = useState<VisualDiff | null>(null);
  const [proof, setProof] = useState<ProofOfWorkRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [riskLevel, setRiskLevel] = useState<(typeof RISK_LEVELS)[number]>('MEDIUM');

  const [selector, setSelector] = useState('');
  const [commentText, setCommentText] = useState('');

  const loadProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Array<{ id: string; name: string }> }>('/api/v1/projects');
      setProjects(res.projects);
      setProjectId((prev) => prev || (res.projects[0]?.id ?? ''));
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const loadTasks = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api<{ tasks: Task[] }>(`/api/v1/execution/tasks?projectId=${encodeURIComponent(projectId)}`);
      setTasks(res.tasks);
    } catch {
      setTasks([]);
    }
  }, [projectId]);

  const loadTree = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api<{ tree: FileTreeNode[] }>(`/api/v1/files/tree?projectId=${encodeURIComponent(projectId)}`);
      setTree(res.tree);
    } catch {
      setTree([]);
    }
  }, [projectId]);

  const loadHeatmap = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api<{ heatmap: HeatmapCell[] }>(`/api/v1/control/activity/heatmap/${encodeURIComponent(projectId)}`);
      setHeatmap(res.heatmap);
    } catch {
      setHeatmap([]);
    }
  }, [projectId]);

  const loadComments = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api<{ comments: PreviewCommentRow[] }>(`/api/v1/preview/${encodeURIComponent(projectId)}/comments`);
      setComments(res.comments);
    } catch {
      setComments([]);
    }
  }, [projectId]);

  const loadDiff = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api<{ diff: VisualDiff }>(`/api/v1/preview/${encodeURIComponent(projectId)}/diff`);
      setDiff(res.diff);
    } catch {
      setDiff(null);
    }
  }, [projectId]);

  useEffect(() => {
    void loadTasks();
    void loadTree();
    void loadHeatmap();
    void loadComments();
    void loadDiff();
  }, [projectId, loadTasks, loadTree, loadHeatmap, loadComments, loadDiff]);

  const createTask = async () => {
    if (!projectId || !title.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ task: Task }>('/api/v1/execution/tasks', {
        method: 'POST',
        body: { projectId, title: title.trim(), description: description.trim() || undefined, riskLevel },
      });
      setTitle('');
      setDescription('');
      toast(`Task queued: ${res.task.title}`);
      await loadTasks();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'task creation failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const addComment = async () => {
    if (!projectId || !selector.trim() || !commentText.trim()) return;
    try {
      const res = await api<{ comment: PreviewCommentRow }>(`/api/v1/preview/${encodeURIComponent(projectId)}/comments`, {
        method: 'POST',
        body: { selector: selector.trim(), comment: commentText.trim() },
      });
      setSelector('');
      setCommentText('');
      toast(`Comment queued as task ${res.comment.task_id}`);
      await Promise.all([loadComments(), loadTasks()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'comment failed', 'error');
    }
  };

  const resolveComment = async (id: string) => {
    try {
      await api(`/api/v1/preview/${encodeURIComponent(projectId)}/comments/${id}/resolve`, { method: 'POST' });
      await loadComments();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'resolve failed', 'error');
    }
  };

  const captureSnapshot = async () => {
    try {
      const res = await api<{ snapshot: { version: number } | null }>(
        `/api/v1/preview/${encodeURIComponent(projectId)}/snapshots`,
        { method: 'POST' },
      );
      toast(res.snapshot ? `Snapshot captured (v${res.snapshot.version})` : 'Snapshot unavailable (no session)');
      await loadDiff();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'snapshot failed', 'error');
    }
  };

  const generateProof = async () => {
    const task = tasks.find((t) => t.id === proofTaskId);
    if (!task) return;
    try {
      const res = await api<{ proof: ProofOfWorkRow }>('/api/v1/control/pow', { method: 'POST', body: { taskId: task.id } });
      setProof(res.proof);
      toast('Proof of work generated from real persisted state');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'proof generation failed', 'error');
    }
  };

  const [proofTaskId, setProofTaskId] = useState('');

  useEffect(() => {
    setProofTaskId((prev) => prev || (tasks[0]?.id ?? ''));
  }, [tasks]);

  const loadProof = useCallback(async () => {
    if (!proofTaskId) return;
    try {
      const res = await api<{ proof: ProofOfWorkRow }>(`/api/v1/control/pow/${proofTaskId}`);
      setProof(res.proof);
    } catch {
      setProof(null);
    }
  }, [proofTaskId]);

  useEffect(() => {
    void loadProof();
  }, [loadProof]);

  const maxHeat = useMemo(() => Math.max(1, ...heatmap.map((h) => h.changes)), [heatmap]);

  const projectName = useMemo(() => projects.find((p) => p.id === projectId)?.name ?? projectId, [projects, projectId]);

  return (
    <div className="cc-page">
      <h1>Workspace</h1>
      <p className="cc-hint">
        One project, three views: compose real tasks (CHAT), inspect the real file tree, change heatmap and proof of work
        (CODE), and review the live preview (PREVIEW) with comments that create tracked tasks.
      </p>

      <div className="cc-card" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="cc-hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          Project
          <select className="cc-select" aria-label="Workspace project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <div className="cc-tabs" role="tablist" aria-label="Workspace views">
          {TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`cc-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === 'CHAT' && (
        <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="workspace-chat">
          <h3 style={{ margin: 0 }}>Compose a task</h3>
          <p className="cc-hint" style={{ margin: 0 }}>
            Tasks are created through the execution engine and governed by control-plane policies and the kill switch — the
            server reports policy blocks or suspensions honestly.
          </p>
          <input
            className="cc-input"
            aria-label="Task title"
            placeholder="Task title (e.g. Fix the login flow)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="cc-input"
            aria-label="Task description"
            placeholder="Description (optional)"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="cc-select" aria-label="Task risk level" value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as typeof riskLevel)}>
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
            <button className="cc-btn cc-btn--sm" disabled={busy || !projectId || !title.trim()} onClick={() => void createTask()}>
              Queue task
            </button>
          </div>

          <h3 style={{ margin: '14px 0 0' }}>Recent tasks</h3>
          {tasks.length === 0 ? (
            <p className="cc-hint" style={{ margin: 0 }}>No tasks in this project yet.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {tasks.slice(0, 20).map((t) => (
                <li key={t.id} className="cc-mono" style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="cc-pill" style={{ background: RISK_COLORS[t.riskLevel] ?? '#334155', color: '#fff' }}>{t.riskLevel}</span>
                  <span>{t.status}</span>
                  <span>{t.title}</span>
                  <span className="cc-hint">{t.id}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'CODE' && (
        <div className="cc-grid cc-grid-2" data-testid="workspace-code">
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 style={{ margin: 0 }}>File tree</h3>
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              <TreeView nodes={tree} depth={0} />
            </div>
          </div>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 style={{ margin: 0 }}>Change heatmap (last 14 days)</h3>
            {heatmap.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No file activity recorded yet.</p>
            ) : (
              <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', flexWrap: 'wrap' }} data-testid="heatmap">
                {heatmap.map((h) => (
                  <div key={h.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }} title={`${h.date}: ${h.changes} change(s)`}>
                    <div
                      style={{
                        width: 22,
                        height: Math.max(4, Math.round((h.changes / maxHeat) * 90)),
                        background: '#7c3aed',
                        borderRadius: '3px 3px 0 0',
                      }}
                    />
                    <span className="cc-hint cc-mono" style={{ fontSize: 9 }}>{h.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
            <h3 style={{ margin: '14px 0 0' }}>Proof of work</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="cc-select" aria-label="Proof of work task" value={proofTaskId} onChange={(e) => setProofTaskId(e.target.value)}>
                {tasks.length === 0 && <option value="">No tasks</option>}
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>{t.title} ({t.status})</option>
                ))}
              </select>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={!proofTaskId} onClick={() => void generateProof()}>
                Generate
              </button>
            </div>
            {proof ? (
              <div className="cc-mono" style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="proof-report">
                <span>status: {proof.report.request.title} — plan {proof.report.plan?.status ?? 'none'}, files {proof.report.files.length}, attempts {proof.report.evidence.attempts}</span>
                <span>ai: {proof.report.ai.calls} call(s), {proof.report.ai.inputTokens} in / {proof.report.ai.outputTokens} out, ${proof.report.ai.costUsd.toFixed(4)}</span>
                <span>total cost ${proof.report.cost.totalUsd.toFixed(4)} · generated {new Date(proof.report.generatedAt).toLocaleString()}</span>
                {proof.report.preview && <span>preview v{proof.report.preview.version} ({proof.report.preview.state})</span>}
                {proof.report.approvals.length > 0 && (
                  <span>approvals: {proof.report.approvals.map((a) => `${a.risk_level}:${a.status}`).join(', ')}</span>
                )}
              </div>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>No proof-of-work report for the selected task. Generate one to see the honest evidence from persisted state.</p>
            )}
          </div>
        </div>
      )}

      {tab === 'PREVIEW' && (
        <div className="cc-grid cc-grid-2" data-testid="workspace-preview">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PreviewPanel projectId={projectId} projectName={projectName} />
          </div>
          <div className="cc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <h3 style={{ margin: 0 }}>Review comments</h3>
            <p className="cc-hint" style={{ margin: 0 }}>
              Each comment creates a real MEDIUM-risk task in the project — nothing is fabricated.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="cc-input"
                style={{ flex: 1, minWidth: 160 }}
                aria-label="Element selector"
                placeholder="Selector (e.g. .submit-btn)"
                value={selector}
                onChange={(e) => setSelector(e.target.value)}
              />
              <input
                className="cc-input"
                style={{ flex: 2, minWidth: 220 }}
                aria-label="Comment"
                placeholder="What should change?"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
              />
              <button className="cc-btn cc-btn--sm" disabled={!projectId || !selector.trim() || !commentText.trim()} onClick={() => void addComment()}>
                Add
              </button>
            </div>
            {comments.length === 0 ? (
              <p className="cc-hint" style={{ margin: 0 }}>No comments yet.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {comments.map((c) => (
                  <li key={c.id} className="cc-card" style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span className="cc-pill" style={{ fontSize: 10 }}>{c.status}</span>
                      <span className="cc-mono" style={{ fontSize: 11 }}>v{c.preview_version} · {c.selector}</span>
                      <span className="cc-hint cc-mono" style={{ fontSize: 10 }}>task {c.task_id}</span>
                      {c.status === 'OPEN' && (
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void resolveComment(c.id)}>
                          Resolve
                        </button>
                      )}
                    </div>
                    <p style={{ margin: 0, fontSize: 13 }}>{c.comment}</p>
                  </li>
                ))}
              </ul>
            )}
            <h3 style={{ margin: '14px 0 0' }}>Visual diff</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void captureSnapshot()}>
                Capture snapshot
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void loadDiff()}>
                Refresh diff
              </button>
            </div>
            {!diff ? (
              <p className="cc-hint" style={{ margin: 0 }}>Diff unavailable for this project.</p>
            ) : diff.available ? (
              <div className="cc-mono" style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>before: v{diff.before?.version ?? '—'} ({diff.before?.state ?? 'none'})</span>
                <span>after: v{diff.after?.version ?? '—'} ({diff.after?.state ?? 'none'})</span>
                <span className="cc-hint">Captured from real session snapshots — changes are shown as snapshot versions, not fabricated screenshots.</span>
              </div>
            ) : (
              <p className="cc-hint" style={{ margin: 0 }}>Fewer than two snapshots exist — capture snapshots across build versions to see a diff.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}