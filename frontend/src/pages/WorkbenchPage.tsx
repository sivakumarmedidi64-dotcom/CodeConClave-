/**
 * CodeConClave — Live Development Workbench.
 * A six-point surface over REAL backend data:
 *   left   explorer · center code / diff / preview · right task / agents /
 *          verification / artifacts / memory · bottom terminal / runtime /
 *          activity / audit.
 * Events arrive over the existing project SSE stream (task/coworker/preview/
 * capture); short polling is the transport fallback and the step-granularity
 * catch-up. No data here is fabricated — every panel renders server payloads
 * or an honest unavailable state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import {
  fetchProjects,
  fetchFileTree,
  fetchTasks,
  fetchTimeline,
  fetchArtifacts,
  fetchMemories,
  fetchHandoffs,
  fetchReviews,
  fetchActivity,
  fetchAudit,
  fileContentText,
  workbenchStream,
  parseUnifiedDiff,
  statusMeta,
  isActiveTaskStatus,
  loadWorkbenchLayout,
  saveWorkbenchLayout,
  normalizeCoworkerRuns,
  normalizeArtifacts,
  type WorkbenchLayout,
  type WorkbenchEvent,
} from '../lib/workbench';
import type { FileTreeNode, Memory, Project, Task, TaskTimeline } from '../lib/types';
import { ProjectExplorer, type FileChangeStatus } from '../components/workbench/ProjectExplorer';
import { CodeViewer } from '../components/workbench/CodeViewer';
import { DiffViewer } from '../components/workbench/DiffViewer';
import { PreviewPanel } from '../components/PreviewPanel';
import { IntegratedTerminalPanel } from '../components/IntegratedTerminalPanel';
import { RuntimeWorkspacePanel } from '../components/RuntimeWorkspacePanel';
import {
  TaskPanel,
  AgentPanel,
  VerificationPanel,
  ArtifactPanel,
  MemoryPanel,
  ActivityPanel,
  AuditPanel,
} from '../components/workbench/WorkbenchPanels';
import type { ActivityEvent, AuditEvent, CoworkerHandoff, ReviewDiff } from '../lib/workbench';

type CenterTab = 'code' | 'diff' | 'preview';
type RightTab = 'task' | 'agents' | 'verification' | 'artifact' | 'memory';
type BottomTab = 'terminal' | 'runtime' | 'activity' | 'audit';

const ACTIVE_POLL_MS = 8_000;
const FALLBACK_POLL_MS = 25_000;

function Splitter({ direction, onDrag, onDragEnd }: { direction: 'v' | 'h'; onDrag: (d: number) => void; onDragEnd: () => void }) {
  return (
    <div
      className={`wb-splitter wb-splitter--${direction}`}
      data-testid={`splitter-${direction}`}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        const start = direction === 'v' ? e.clientX : e.clientY;
        const onMove = (ev: PointerEvent) => {
          ev.preventDefault();
          onDrag((direction === 'v' ? ev.clientX : ev.clientY) - start);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          onDragEnd();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      }}
    />
  );
}

function TabBar<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="wb-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={`wb-tabs__tab${active === tab.id ? ' active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function WorkbenchPage() {
  const params = useParams<{ projectId?: string }>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(params.projectId ?? null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);

  const [timeline, setTimeline] = useState<TaskTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  const [reviews, setReviews] = useState<ReviewDiff[]>([]);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, unknown>[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [handoffs, setHandoffs] = useState<CoworkerHandoff[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [panelsLoading, setPanelsLoading] = useState(false);

  const [selectedFile, setSelectedFile] = useState<{ id: string; path: string } | null>(null);
  const [codeContent, setCodeContent] = useState<string | null>(null);
  const [codeBinary, setCodeBinary] = useState(false);
  const [codeLoading, setCodeLoading] = useState(false);
  const [filter, setFilter] = useState('');

  const [centerTab, setCenterTab] = useState<CenterTab>('code');
  const [rightTab, setRightTab] = useState<RightTab>('task');
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal');
  const [layout, setLayout] = useState<WorkbenchLayout>(() => loadWorkbenchLayout(params.projectId ?? 'default'));
  const [transport, setTransport] = useState<'sse' | 'poll' | 'none'>('none');
  const [awayCount, setAwayCount] = useState(0);
  const [mobile, setMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= 768 : false));

  const refreshTick = useRef(0);

  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    void fetchProjects()
      .then((list) => {
        setProjects(list);
        setProjectId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => {
        /* handled per-surface; header shows project dropdown empty */
      });
  }, []);

  const bumpRefresh = useCallback(() => {
    refreshTick.current += 1;
  }, []);

  /* ------------------------------- project scope ------------------------------- */
  useEffect(() => {
    if (!projectId) return;
    setTree([]);
    setTimeline(null);
    setTasks([]);
    setSelectedTaskId(null);
    setTreeLoading(true);
    setTreeError(null);
    void fetchFileTree(projectId)
      .then(setTree)
      .catch((e) => setTreeError(e instanceof ApiError ? e.message : 'Failed to load files'))
      .finally(() => setTreeLoading(false));
    void fetchTasks(projectId)
      .then((list) => {
        setTasks(list);
        setSelectedTaskId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => undefined);
    void fetchReviews(projectId).then(setReviews).catch(() => setReviews([]));
    setPanelsLoading(true);
    void fetchMemories(projectId).then(setMemories).catch(() => setMemories([]));
    void fetchHandoffs(projectId).then(setHandoffs).catch(() => setHandoffs([]));
    void fetchActivity(projectId).then(setActivity).catch(() => setActivity([]));
    void fetchAudit().then(setAudit).catch(() => setAudit([]));
    void Promise.all([]).then(() => setPanelsLoading(false));
    setLayout(loadWorkbenchLayout(projectId));
  }, [projectId]);

  /* ------------------------------- selected task ------------------------------- */
  const loadTimeline = useCallback(async (taskId: string) => {
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      const tl = await fetchTimeline(taskId);
      setTimeline(tl);
    } catch (e) {
      setTimelineError(e instanceof ApiError ? e.message : 'Failed to load task');
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      setTimeline(null);
      setArtifacts([]);
      setSelectedReviewId(null);
      return;
    }
    void loadTimeline(selectedTaskId);
    setArtifactsLoading(true);
    void fetchArtifacts(selectedTaskId)
      .then((a) => setArtifacts(normalizeArtifacts(a)))
      .catch(() => setArtifacts([]))
      .finally(() => setArtifactsLoading(false));
    setSelectedReviewId((prev) => prev ?? null);
  }, [selectedTaskId, loadTimeline]);

  /* ------------------------------- event stream ------------------------------- */
  useEffect(() => {
    if (!projectId) return;
    const stream = workbenchStream(projectId, {
      onEvent: (event: WorkbenchEvent) => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          setAwayCount((n) => n + 1);
        }
        if (event.type === 'preview' || event.type === 'capture' || event.type === 'background' || event.type === 'execution') {
          bumpRefresh();
          return;
        }
        if (event.type === 'task') {
          bumpRefresh();
          setSelectedTaskId((prev) => prev ?? event.id);
        }
        if (event.type === 'coworker') {
          bumpRefresh();
        }
      },
      onState: (connected) => setTransport(connected ? 'sse' : 'poll'),
    });
    return () => stream.close();
  }, [projectId, bumpRefresh]);

  /* ------------------------------- polling ------------------------------- */
  useEffect(() => {
    if (!projectId || !selectedTaskId) return;
    const active = timeline ? isActiveTaskStatus(timeline.task?.status) : true;
    const ms = active ? ACTIVE_POLL_MS : FALLBACK_POLL_MS;
    const id = window.setInterval(() => {
      if (selectedTaskId) void loadTimeline(selectedTaskId).catch(() => undefined);
      if (!active) bumpRefresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [projectId, selectedTaskId, timeline, loadTimeline, bumpRefresh]);

  /* ------------------------------- file select ------------------------------- */
  const openFile = useCallback(
    async (file: { id: string; path: string }) => {
      if (!projectId) return;
      setSelectedFile(file);
      setCenterTab('code');
      setCodeLoading(true);
      setCodeBinary(false);
      setCodeContent(null);
      try {
        const text = await fileContentText(projectId, file.id);
        if (text === null) setCodeBinary(true);
        else setCodeContent(text);
      } catch {
        setCodeContent(null);
      } finally {
        setCodeLoading(false);
      }
    },
    [projectId],
  );

  const reloadTree = useCallback(() => {
    if (!projectId) return;
    setTreeLoading(true);
    void fetchFileTree(projectId)
      .then(setTree)
      .catch((e) => setTreeError(e instanceof ApiError ? e.message : 'Failed to load files'))
      .finally(() => setTreeLoading(false));
  }, [projectId]);

  /* ------------------------------- changed files (from real reviews) ------------------------------- */
  const changedFiles = useMemo(() => {
    const map = new Map<string, FileChangeStatus>();
    if (!selectedTaskId || !reviews.length) return map;
    for (const review of reviews) {
      const taskId = (review as Record<string, unknown>).task_id ?? (review as Record<string, unknown>).taskId;
      if (taskId !== selectedTaskId) continue;
      for (const file of parseUnifiedDiff(review.diffText).files) {
        if (file.path && file.path !== '(no file)') map.set(file.path, file.deletions === 0 && file.additions > 0 ? 'created' : 'modified');
      }
    }
    return map;
  }, [reviews, selectedTaskId]);

  const candidateReviews = useMemo(
    () =>
      reviews.filter((r) => {
        const taskId = (r as Record<string, unknown>).task_id ?? (r as Record<string, unknown>).taskId;
        return !selectedTaskId || taskId === selectedTaskId || taskId == null;
      }),
    [reviews, selectedTaskId],
  );
  const activeReview = candidateReviews.find((r) => r.id === selectedReviewId) ?? candidateReviews[0] ?? null;

  /* ------------------------------- actions ------------------------------- */
  const cancelTask = useCallback(() => {
    if (!selectedTaskId) return;
    void api(`/api/v1/execution/tasks/${encodeURIComponent(selectedTaskId)}/cancel`, { method: 'POST', body: { reason: 'cancelled_from_workbench' } })
      .then(() => loadTimeline(selectedTaskId))
      .catch(() => undefined);
  }, [selectedTaskId, loadTimeline]);

  const retryTask = useCallback(() => {
    if (!selectedTaskId) return;
    void api(`/api/v1/execution/tasks/${encodeURIComponent(selectedTaskId)}/retry`, { method: 'POST', body: { reason: 'retry_from_workbench' } })
      .then(() => loadTimeline(selectedTaskId))
      .catch(() => undefined);
  }, [selectedTaskId, loadTimeline]);

  const commitLayout = useCallback(() => {
    if (projectId) saveWorkbenchLayout(projectId, layoutRef.current);
  }, [projectId]);

  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const coworkerRuns = useMemo(() => (timeline ? normalizeCoworkerRuns(timeline.coworkerRuns ?? []) : []), [timeline]);
  const taskMeta = timeline?.task ? statusMeta(timeline.task.status) : null;
  const taskActive = timeline?.task ? isActiveTaskStatus(timeline.task.status) : false;

  if (!projectId && !projects.length) {
    return (
      <div className="cc-card wb-page" data-testid="workbench-page">
        <p className="cc-hint">No accessible projects.</p>
      </div>
    );
  }

  const diffTabLabel = activeReview ? 'Diff' : 'Diff';

  return (
    <div className="wb-page" data-testid="workbench-page">
      <header className="wb-toolbar" data-testid="workbench-toolbar">
        <strong className="wb-toolbar__title">Workbench</strong>
        <select
          className="cc-select cc-select--sm"
          aria-label="Project"
          value={projectId ?? ''}
          onChange={(e) => {
            const next = e.target.value || null;
            setProjectId(next);
            if (next) setLayout(loadWorkbenchLayout(next));
          }}
        >
          {projects.length === 0 && <option value="">No projects</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name ?? p.id}
            </option>
          ))}
        </select>
        <select
          className="cc-select cc-select--sm"
          aria-label="Task"
          value={selectedTaskId ?? ''}
          onChange={(e) => setSelectedTaskId(e.target.value || null)}
          disabled={!tasks.length}
        >
          {tasks.length === 0 && <option value="">No tasks</option>}
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
        {taskMeta ? (
          <span className="cc-pill" style={{ background: taskMeta.color, color: '#fff', fontWeight: 700 }} data-testid="workbench-task-status">
            {taskMeta.label}
          </span>
        ) : null}
        <span className={`wb-transport wb-transport--${transport}`} data-testid="workbench-transport">
          {transport === 'sse' ? 'live stream' : transport === 'poll' ? 'polling' : 'connecting'}
        </span>
        <span className="wb-toolbar__spacer" />
        <button className="cc-btn cc-btn--sm" onClick={() => void loadTimeline(selectedTaskId!)} disabled={!selectedTaskId}>
          Refresh
        </button>
        {taskActive && (
          <button className="cc-btn cc-btn--sm" onClick={cancelTask} disabled={!selectedTaskId}>
            Cancel
          </button>
        )}
        {timeline?.task?.status === 'FAILED' || timeline?.task?.status === 'TIMED_OUT' ? (
          <button className="cc-btn cc-btn--sm" onClick={retryTask} disabled={!selectedTaskId}>
            Retry
          </button>
        ) : null}
      </header>

      {awayCount > 0 && (
        <div className="wb-away" role="status" data-testid="workbench-away" onClick={() => setAwayCount(0)}>
          {awayCount} event{awayCount === 1 ? '' : 's'} arrived while you were away — click to dismiss.
        </div>
      )}

      {mobile ? (
        <div className="wb-mobile">
          <section className="wb-stack-card">
            <TabBar
              tabs={[
                { id: 'code', label: 'Code' },
                { id: 'diff', label: 'Diff' },
                { id: 'preview', label: 'Preview' },
              ]}
              active={centerTab}
              onChange={setCenterTab}
            />
            <div className="wb-content">
              {centerTab === 'code' &&
                (codeLoading ? (
                  <div className="cc-card wb-pane">
                    <p className="cc-hint">Loading…</p>
                  </div>
                ) : selectedFile ? (
                  <CodeViewer path={selectedFile.path} content={codeContent} binary={codeBinary} />
                ) : (
                  <div className="cc-card wb-pane">
                    <p className="cc-hint">Select a file in the explorer.</p>
                  </div>
                ))}
              {centerTab === 'diff' && <DiffViewer diffText={activeReview?.diffText ?? ''} emptyLabel="No review diff for this task yet." />}
              {centerTab === 'preview' && projectId && <PreviewPanel projectId={projectId} />}
            </div>
          </section>
          <section className="wb-stack-card">
            <TabBar
              tabs={[
                { id: 'task', label: 'Task' },
                { id: 'agents', label: 'Agents' },
                { id: 'verification', label: 'Verify' },
                { id: 'artifact', label: 'Artifacts' },
                { id: 'memory', label: 'Memory' },
              ]}
              active={rightTab}
              onChange={setRightTab}
            />
            <div className="wb-content">
              {rightTab === 'task' && <TaskPanel timeline={timeline} loading={timelineLoading} error={timelineError} />}
              {rightTab === 'agents' && <AgentPanel coworkerRuns={coworkerRuns} handoffs={handoffs} />}
              {rightTab === 'verification' && <VerificationPanel coworkerRuns={coworkerRuns} failureInfo={timeline?.failureInfo ?? null} />}
              {rightTab === 'artifact' && <ArtifactPanel artifacts={artifacts} loading={artifactsLoading} />}
              {rightTab === 'memory' && <MemoryPanel memories={memories} handoffs={handoffs} loading={panelsLoading} />}
            </div>
          </section>
        </div>
      ) : (
        <div className="wb-grid">
          <div className="wb-pane--explorer" style={{ width: layout.leftPx }}>
            <ProjectExplorer
              projectId={projectId ?? ''}
              tree={tree}
              selectedPath={selectedFile?.path ?? null}
              statuses={changedFiles}
              loading={treeLoading}
              error={treeError}
              filter={filter}
              onFilterChange={setFilter}
              onSelect={openFile}
              onReload={reloadTree}
            />
          </div>
          <Splitter direction="v" onDrag={(d) => setLayout((l) => ({ ...l, leftPx: clamp(d + l.leftPx, 140, 620) }))} onDragEnd={commitLayout} />
          <div className="wb-pane--center">
            <TabBar
              tabs={[
                { id: 'code', label: 'Code' },
                { id: 'diff', label: diffTabLabel },
                { id: 'preview', label: 'Preview' },
              ]}
              active={centerTab}
              onChange={setCenterTab}
            />
            <div className="wb-content">
              {centerTab === 'code' &&
                (codeLoading ? (
                  <div className="cc-card wb-pane">
                    <p className="cc-hint">Loading…</p>
                  </div>
                ) : selectedFile ? (
                  <CodeViewer path={selectedFile.path} content={codeContent} binary={codeBinary} />
                ) : (
                  <div className="cc-card wb-pane">
                    <p className="cc-hint">Select a file in the explorer.</p>
                  </div>
                ))}
              {centerTab === 'diff' && <DiffViewer diffText={activeReview?.diffText ?? ''} emptyLabel="No review diff for this task yet." />}
              {centerTab === 'preview' && projectId && <PreviewPanel projectId={projectId} />}
            </div>
          </div>
          <Splitter direction="v" onDrag={(d) => setLayout((l) => ({ ...l, rightPx: clamp(l.rightPx - d, 200, 640) }))} onDragEnd={commitLayout} />
          <div className="wb-pane--right" style={{ width: layout.rightPx }}>
            <TabBar
              tabs={[
                { id: 'task', label: 'Task' },
                { id: 'agents', label: 'Agents' },
                { id: 'verification', label: 'Verify' },
                { id: 'artifact', label: 'Artifacts' },
                { id: 'memory', label: 'Memory' },
              ]}
              active={rightTab}
              onChange={setRightTab}
            />
            <div className="wb-content">
              {rightTab === 'task' && <TaskPanel timeline={timeline} loading={timelineLoading} error={timelineError} />}
              {rightTab === 'agents' && <AgentPanel coworkerRuns={coworkerRuns} handoffs={handoffs} />}
              {rightTab === 'verification' && <VerificationPanel coworkerRuns={coworkerRuns} failureInfo={timeline?.failureInfo ?? null} />}
              {rightTab === 'artifact' && <ArtifactPanel artifacts={artifacts} loading={artifactsLoading} />}
              {rightTab === 'memory' && <MemoryPanel memories={memories} handoffs={handoffs} loading={panelsLoading} />}
            </div>
          </div>

          <div className="wb-pane--bottom" style={{ height: layout.bottomPx }}>
            <TabBar
              tabs={[
                { id: 'terminal', label: 'Terminal' },
                { id: 'runtime', label: 'Runtime' },
                { id: 'activity', label: 'Activity' },
                { id: 'audit', label: 'Audit' },
              ]}
              active={bottomTab}
              onChange={setBottomTab}
            />
            <div className="wb-content wb-content--bottom">
              {bottomTab === 'terminal' &&
                (projectId ? (
                  <div className="cc-card wb-pane" style={{ overflow: 'hidden' }}>
                    <IntegratedTerminalPanel projectId={projectId} />
                  </div>
                ) : (
                  <p className="cc-hint">Select a project.</p>
                ))}
              {bottomTab === 'runtime' &&
                (projectId ? (
                  <div className="cc-card wb-pane" style={{ overflow: 'hidden' }}>
                    <RuntimeWorkspacePanel projectId={projectId} />
                  </div>
                ) : (
                  <p className="cc-hint">Select a project.</p>
                ))}
              {bottomTab === 'activity' && <ActivityPanel events={activity} loading={panelsLoading} />}
              {bottomTab === 'audit' && <AuditPanel events={audit} loading={panelsLoading} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}