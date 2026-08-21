/**
 * CodeConClave — Ideas workspace (Phase 13): real idea CRUD with statuses,
 * priorities, tags, categories, voting, comments, assignment, archive/trash/
 * restore — plus the Brainstorming foundation (sessions, participants,
 * capture, AI generation gated strictly behind the configured AI gateway).
 * Explicit loading / error / empty states and confirmations for destructive
 * actions; AI generation reports `ai_unavailable` honestly when no provider
 * is configured.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import type {
  BrainstormIdea,
  BrainstormParticipant,
  BrainstormSession,
  BrainstormSessionDetail,
  Idea,
  IdeaComment,
  IdeaPriority,
  IdeaStatus,
  Project,
  ProjectMember,
} from '../lib/types';
import { useToast } from '../components/Toast';

const STATUSES: IdeaStatus[] = ['PROPOSED', 'IN_PROGRESS', 'ACCEPTED', 'PLANNED', 'REJECTED', 'DEFERRED', 'DEPRECATED'];
const PRIORITIES: IdeaPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

function statusLabel(s: string) {
  return s.toLowerCase().replaceAll('_', ' ');
}

export function IdeasPage() {
  const [tab, setTab] = useState<'ideas' | 'brainstorm'>('ideas');
  return (
    <div className="cc-page">
      <h1>Ideas</h1>
      <div className="cc-toggle">
        <button className={tab === 'ideas' ? 'on' : ''} onClick={() => setTab('ideas')}>
          Ideas
        </button>
        <button className={tab === 'brainstorm' ? 'on' : ''} onClick={() => setTab('brainstorm')}>
          Brainstorm
        </button>
      </div>
      {tab === 'ideas' ? <IdeasTab /> : <BrainstormTab />}
    </div>
  );
}

/* ---------------------------------------------------------------- ideas tab */

interface IdeaFilters {
  q: string;
  status: string;
  priority: string;
  tag: string;
  archived: boolean;
}

function IdeasTab() {
  const { toast } = useToast();
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [projects, setProjects] = useState<Project[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [filters, setFilters] = useState<IdeaFilters>({ q: '', status: '', priority: '', tag: '', archived: false });
  const [openIdeaId, setOpenIdeaId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, IdeaComment[]>>({});
  const [draft, setDraft] = useState({
    title: '',
    description: '',
    category: '',
    tags: '',
    priority: 'MEDIUM' as IdeaPriority,
    status: 'PROPOSED' as IdeaStatus,
    projectId: '',
    assigneeId: '',
  });

  const load = useCallback(async () => {
    setState('loading');
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.status) params.set('status', filters.status);
      if (filters.priority) params.set('priority', filters.priority);
      if (filters.tag) params.set('tag', filters.tag);
      if (filters.archived) params.set('archived', 'true');
      const res = await api<{ ideas: Idea[] }>(`/api/v1/ideas?${params.toString()}`);
      setIdeas(res.ideas ?? []);
      setState('ready');
    } catch {
      setIdeas([]);
      setState('error');
    }
  }, [filters]);

  const loadProjects = useCallback(async () => {
    try {
      const res = await api<{ projects: Project[] }>('/api/v1/projects?pageSize=100');
      setProjects(res.projects.filter((p) => !p.deleted_at));
    } catch {
      /* project scoping is optional */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadProjects();
  }, [load, loadProjects]);

  useEffect(() => {
    if (!draft.projectId) {
      setMembers([]);
      return;
    }
    void api<{ members: ProjectMember[] }>(`/api/v1/projects/${draft.projectId}/members`)
      .then((res) => setMembers(res.members))
      .catch(() => setMembers([]));
  }, [draft.projectId]);

  const create = async () => {
    if (!draft.title.trim()) return;
    try {
      await api('/api/v1/ideas', {
        method: 'POST',
        body: {
          title: draft.title.trim(),
          description: draft.description.trim() || undefined,
          category: draft.category.trim() || undefined,
          tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
          priority: draft.priority,
          status: draft.status,
          projectId: draft.projectId || undefined,
          assigneeId: draft.assigneeId || undefined,
        },
      });
      setDraft({ title: '', description: '', category: '', tags: '', priority: 'MEDIUM', status: 'PROPOSED', projectId: '', assigneeId: '' });
      await load();
      toast('Idea created');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      const res = await api<{ idea: Idea }>(`/api/v1/ideas/${id}`, { method: 'PATCH', body });
      setIdeas((prev) => prev.map((i) => (i.id === id ? res.idea : i)));
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
      return false;
    }
  };

  const vote = async (idea: Idea) => {
    try {
      const res = await api<{ idea: Idea }>(`/api/v1/ideas/${idea.id}/vote`, { method: 'POST', body: { on: true } });
      setIdeas((prev) => prev.map((i) => (i.id === idea.id ? res.idea : i)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'vote failed', 'error');
    }
  };

  const loadComments = async (ideaId: string) => {
    if (comments[ideaId]) return;
    try {
      const res = await api<{ comments: IdeaComment[] }>(`/api/v1/ideas/${ideaId}/comments`);
      setComments((prev) => ({ ...prev, [ideaId]: res.comments }));
    } catch {
      /* ignore */
    }
  };

  const addComment = async (ideaId: string, content: string) => {
    if (!content.trim()) return;
    try {
      const res = await api<{ comment: IdeaComment }>(`/api/v1/ideas/${ideaId}/comments`, {
        method: 'POST',
        body: { content: content.trim() },
      });
      setComments((prev) => ({ ...prev, [ideaId]: [...(prev[ideaId] ?? []), res.comment] }));
      setIdeas((prev) => prev.map((i) => (i.id === ideaId ? { ...i, commentCount: i.commentCount + 1 } : i)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'comment failed', 'error');
    }
  };

  const trash = async (idea: Idea) => {
    if (!window.confirm(`Move "${idea.title}" to trash?`)) return;
    try {
      await api(`/api/v1/ideas/${idea.id}/trash`, { method: 'POST', body: {} });
      await load();
      toast('Moved to trash');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'trash failed', 'error');
    }
  };

  const restore = async (idea: Idea) => {
    try {
      const res = await api<{ idea: Idea }>(`/api/v1/ideas/${idea.id}/restore`, { method: 'POST', body: {} });
      setIdeas((prev) => prev.map((i) => (i.id === idea.id ? res.idea : i)));
      toast('Restored');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'restore failed', 'error');
    }
  };

  const filtered = useMemo(() => ideas, [ideas]);

  return (
    <div>
      <div className="cc-card">
        <h3>New idea</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="cc-input"
            placeholder="Title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
            }}
          />
          <textarea
            className="cc-input"
            rows={2}
            placeholder="Description (optional)"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              className="cc-input"
              style={{ width: 140 }}
              placeholder="category"
              value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
            />
            <input
              className="cc-input"
              style={{ width: 180 }}
              placeholder="tags, comma separated"
              value={draft.tags}
              onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))}
            />
            <select
              className="cc-input"
              style={{ width: 130 }}
              value={draft.priority}
              onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value as IdeaPriority }))}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select
              className="cc-input"
              style={{ width: 150 }}
              value={draft.status}
              onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as IdeaStatus }))}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{statusLabel(s)}</option>
              ))}
            </select>
            <select
              className="cc-input"
              style={{ width: 160 }}
              value={draft.projectId}
              onChange={(e) => setDraft((d) => ({ ...d, projectId: e.target.value, assigneeId: '' }))}
            >
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              className="cc-input"
              style={{ width: 160 }}
              value={draft.assigneeId}
              onChange={(e) => setDraft((d) => ({ ...d, assigneeId: e.target.value }))}
              disabled={!draft.projectId}
            >
              <option value="">No assignee</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>{m.displayName ?? m.email}</option>
              ))}
            </select>
            <button className="cc-btn" disabled={!draft.title.trim()} onClick={() => void create()}>
              Create
            </button>
          </div>
          {!draft.projectId && (
            <p className="cc-hint">Pick a project to assign teammates. Ideas without a project stay private to you.</p>
          )}
        </div>
      </div>

      <div className="cc-card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            className="cc-input"
            style={{ width: 200 }}
            placeholder="Search…"
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
          />
          <select className="cc-input" style={{ width: 150 }} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
          <select className="cc-input" style={{ width: 130 }} value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
            <option value="">Any priority</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            className="cc-input"
            style={{ width: 120 }}
            placeholder="tag"
            value={filters.tag}
            onChange={(e) => setFilters((f) => ({ ...f, tag: e.target.value }))}
          />
          <label className="cc-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={filters.archived} onChange={(e) => setFilters((f) => ({ ...f, archived: e.target.checked }))} />
            archived
          </label>
        </div>
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading ideas…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load your ideas.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && filtered.length === 0 && <div className="cc-card cc-empty">No ideas match.</div>}
      {state === 'ready' &&
        filtered.map((idea) => (
          <div className="cc-card" key={idea.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{idea.title}</strong>
                  <span className="cc-pill">{statusLabel(idea.status)}</span>
                  <span className={`cc-pill${idea.priority === 'URGENT' ? ' cc-pill--urgent' : ''}`}>{idea.priority}</span>
                  {idea.aiGenerated && <span className="cc-pill" title={`generated by AI · ${idea.provenance ?? ''}`}>AI</span>}
                  {idea.archived && <span className="cc-pill">archived</span>}
                </div>
                {idea.description && (
                  <p className="cc-hint" style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>
                    {idea.description}
                  </p>
                )}
                <div className="cc-hint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                  {idea.category && <span className="cc-code">{idea.category}</span>}
                  {idea.tags.map((t) => (
                    <span key={t} className="cc-code">#{t}</span>
                  ))}
                  <span>votes {idea.voteCount}</span>
                  <span>comments {idea.commentCount}</span>
                  {idea.assigneeId && <span>assigned to {idea.assigneeId.slice(0, 8)}</span>}
                  <span>{new Date(idea.createdAt).toLocaleDateString()}</span>
                  {idea.provenance && <span className="cc-mono">{idea.provenance}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <select
                  className="cc-input"
                  style={{ width: 120, height: 30 }}
                  value={idea.status}
                  onChange={(e) => void patch(idea.id, { status: e.target.value })}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{statusLabel(s)}</option>
                  ))}
                </select>
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void vote(idea)} title="Vote">
                  ▲ {idea.voteCount}
                </button>
                <button
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  onClick={() => {
                    setOpenIdeaId((cur) => (cur === idea.id ? null : idea.id));
                    if (openIdeaId !== idea.id) void loadComments(idea.id);
                  }}
                >
                  💬 {idea.commentCount}
                </button>
                <button
                  className="cc-btn cc-btn--ghost cc-btn--sm"
                  onClick={() => void patch(idea.id, { archived: !idea.archived })}
                  title={idea.archived ? 'Unarchive' : 'Archive'}
                >
                  {idea.archived ? '↩' : '🗄'}
                </button>
                {idea.deletedAt ? (
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void restore(idea)}>
                    Restore
                  </button>
                ) : (
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void trash(idea)}>
                    Trash
                  </button>
                )}
              </div>
            </div>
            {openIdeaId === idea.id && (
              <div style={{ marginTop: 10, borderTop: '1px solid var(--cc-border)', paddingTop: 8 }}>
                <h4>Comments</h4>
                {(comments[idea.id] ?? []).length === 0 && <p className="cc-hint">No comments yet.</p>}
                {(comments[idea.id] ?? []).map((c) => (
                  <div key={c.id} className="cc-hint" style={{ padding: '2px 0', display: 'flex', gap: 6 }}>
                    <span className="cc-mono">{c.authorId.slice(0, 8)}</span>
                    <span>{c.content}</span>
                  </div>
                ))}
                <CommentBox ideaId={idea.id} onAdd={addComment} />
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

function CommentBox({ ideaId, onAdd }: { ideaId: string; onAdd: (id: string, content: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
      <input
        className="cc-input"
        placeholder="Add a comment…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            void onAdd(ideaId, value).then(() => setValue(''));
          }
        }}
      />
      <button
        className="cc-btn cc-btn--sm"
        disabled={!value.trim()}
        onClick={() => void onAdd(ideaId, value).then(() => setValue(''))}
      >
        Add
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ brainstorm tab */

function BrainstormTab() {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<BrainstormSession[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [draft, setDraft] = useState({ title: '', description: '', grouping: 'NONE' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrainstormSessionDetail | null>(null);
  const [proposal, setProposal] = useState('');
  const [generateTopic, setGenerateTopic] = useState('');
  const [generateCount, setGenerateCount] = useState(5);
  const [generating, setGenerating] = useState(false);
  const [inviteId, setInviteId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<{ sessions: BrainstormSession[] }>('/api/v1/brainstorming');
      setSessions(res.sessions);
      setState('ready');
    } catch {
      setSessions([]);
      setState('error');
    }
  }, []);

  const loadDetail = useCallback(async (sessionId: string) => {
    try {
      const res = await api<BrainstormSessionDetail>(`/api/v1/brainstorming/${sessionId}`);
      setDetail(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (activeId) void loadDetail(activeId);
  }, [activeId, loadDetail]);

  const create = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ session: BrainstormSession }>('/api/v1/brainstorming', {
        method: 'POST',
        body: {
          title: draft.title.trim(),
          description: draft.description.trim() || undefined,
          grouping: draft.grouping,
        },
      });
      setDraft({ title: '', description: '', grouping: 'NONE' });
      await load();
      setActiveId(res.session.id);
      toast('Session created');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const capture = async () => {
    if (!activeId || !proposal.trim()) return;
    try {
      await api(`/api/v1/brainstorming/${activeId}/capture`, { method: 'POST', body: { proposal: proposal.trim() } });
      setProposal('');
      await loadDetail(activeId);
      toast('Idea captured');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'capture failed', 'error');
    }
  };

  const generate = async () => {
    if (!activeId || !generateTopic.trim()) return;
    setGenerating(true);
    try {
      const res = await api<{ ideas: Array<{ idea: Idea; brainstormIdea: BrainstormIdea }> }>(
        `/api/v1/brainstorming/${activeId}/generate`,
        { method: 'POST', body: { topic: generateTopic.trim(), count: generateCount } },
      );
      toast(`Generated ${res.ideas.length} idea(s)`);
      await loadDetail(activeId);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'generation failed', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const invite = async () => {
    if (!activeId || !inviteId.trim()) return;
    try {
      await api(`/api/v1/brainstorming/${activeId}/participants`, {
        method: 'POST',
        body: { userId: inviteId.trim() },
      });
      setInviteId('');
      await loadDetail(activeId);
      toast('Invited');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'invite failed', 'error');
    }
  };

  const complete = async () => {
    if (!activeId) return;
    try {
      const res = await api<{ session: BrainstormSession }>(`/api/v1/brainstorming/${activeId}/complete`, {
        method: 'POST',
        body: {},
      });
      await load();
      setDetail((d) => (d ? { ...d, session: res.session } : d));
      toast('Session completed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'complete failed', 'error');
    }
  };

  const archive = async (id: string) => {
    if (!window.confirm('Archive this session?')) return;
    try {
      await api(`/api/v1/brainstorming/${id}/archive`, { method: 'POST', body: {} });
      await load();
      if (activeId === id) setDetail(null);
      toast('Archived');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'archive failed', 'error');
    }
  };

  const participants = detail?.participants ?? [];
  const sessionIdeas = detail?.ideas ?? [];

  return (
    <div>
      <div className="cc-card">
        <h3>New session</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="cc-input"
            style={{ width: 240 }}
            placeholder="Title"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          <input
            className="cc-input"
            style={{ width: 260 }}
            placeholder="Description (optional)"
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          />
          <select
            className="cc-input"
            style={{ width: 140 }}
            value={draft.grouping}
            onChange={(e) => setDraft((d) => ({ ...d, grouping: e.target.value }))}
          >
            <option value="NONE">No grouping</option>
            <option value="THEME">Group by theme</option>
            <option value="CUSTOM">Custom</option>
          </select>
          <button className="cc-btn" disabled={busy || !draft.title.trim()} onClick={() => void create()}>
            Start session
          </button>
        </div>
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading sessions…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load sessions.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && sessions.length === 0 && <div className="cc-card cc-empty">No sessions yet.</div>}
      {state === 'ready' &&
        sessions.map((s) => (
          <div className="cc-card" key={s.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <strong>{s.title}</strong>
                <span className="cc-pill" style={{ marginLeft: 8 }}>{s.status.toLowerCase()}</span>
                {s.grouping !== 'NONE' && <span className="cc-pill">grouped by {s.grouping.toLowerCase()}</span>}
                {s.description && <div className="cc-hint">{s.description}</div>}
                <div className="cc-hint">{new Date(s.createdAt).toLocaleString()}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setActiveId((cur) => (cur === s.id ? null : s.id))}>
                  {activeId === s.id ? 'Close' : 'Open'}
                </button>
                {s.status === 'ACTIVE' && (
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void archive(s.id)}>
                    Archive
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}

      {activeId && detail && (
        <div className="cc-card" data-testid="brainstorm-detail">
          <h3>{detail.session.title}</h3>
          <p className="cc-hint">
            Status {detail.session.status.toLowerCase()} · {participants.length} participant(s) · {sessionIdeas.length} idea(s)
          </p>

          <div className="cc-card" style={{ margin: '8px 0' }}>
            <h4>Capture an idea</h4>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="cc-input"
                placeholder="Your proposal…"
                value={proposal}
                onChange={(e) => setProposal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void capture();
                }}
              />
              <button className="cc-btn" disabled={!proposal.trim()} onClick={() => void capture()}>
                Capture
              </button>
            </div>
          </div>

          {detail.session.status === 'ACTIVE' && (
            <div className="cc-card" style={{ margin: '8px 0' }}>
              <h4>AI generate ideas</h4>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  className="cc-input"
                  style={{ width: 240 }}
                  placeholder="Topic"
                  value={generateTopic}
                  onChange={(e) => setGenerateTopic(e.target.value)}
                />
                <select className="cc-input" style={{ width: 80 }} value={generateCount} onChange={(e) => setGenerateCount(Number(e.target.value))}>
                  {[1, 3, 5, 8].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <button className="cc-btn" disabled={generating || !generateTopic.trim()} onClick={() => void generate()}>
                  {generating ? 'Generating…' : 'Generate'}
                </button>
              </div>
              <p className="cc-hint" style={{ marginTop: 6 }}>
                Generated ideas are validated against a strict schema before they become real ideas — raw model output is
                never trusted as workspace state.
              </p>
            </div>
          )}

          {sessionIdeas.length > 0 && (
            <div>
              <h4>Ideas ({sessionIdeas.length})</h4>
              {sessionIdeas.map((bi) => (
                <div key={bi.id} className="cc-hint" style={{ padding: '4px 0', borderTop: '1px solid var(--cc-border)', display: 'flex', gap: 6, alignItems: 'center' }}>
                  {bi.aiGenerated ? <span className="cc-pill">AI</span> : null}
                  <span>{bi.proposal}</span>
                  {bi.grouping && <span className="cc-mono"> · {bi.grouping}</span>}
                  {bi.ideaId && <span className="cc-mono"> · {bi.ideaId.slice(0, 8)}</span>}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 8 }}>
            <h4>Participants</h4>
            {participants.length === 0 && <p className="cc-hint">You are the host.</p>}
            {participants.map((p) => (
              <div key={p.id} className="cc-hint" style={{ padding: '2px 0' }}>
                {p.userId.slice(0, 8)} · {p.role.toLowerCase()}
              </div>
            ))}
            {detail.session.status === 'ACTIVE' && (
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <input
                  className="cc-input"
                  style={{ width: 220 }}
                  placeholder="User ID to invite"
                  value={inviteId}
                  onChange={(e) => setInviteId(e.target.value)}
                />
                <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={!inviteId.trim()} onClick={() => void invite()}>
                  Invite
                </button>
              </div>
            )}
          </div>

          {detail.session.status === 'ACTIVE' && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button className="cc-btn" onClick={() => void complete()}>
                Complete session
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}