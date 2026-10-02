/**
 * CodeConClave — Projects: list, create (also via ?new=1), status lifecycle
 * (ACTIVE/COMPLETED/ON_HOLD/ARCHIVED), favorite, deadline, tags, members,
 * activity and stats per project. ?focus=<id> scrolls to a project card.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { Project, ProjectActivity, ProjectMember, ProjectStatus } from '../lib/types';
import { useToast } from '../components/Toast';
import { PreviewPanel } from '../components/PreviewPanel';

const STATUS_STYLE: Record<ProjectStatus, { label: string; color: string }> = {
  ACTIVE: { label: 'Active', color: '#1e7d46' },
  ARCHIVED: { label: 'Archived', color: '#8a8a8a' },
  COMPLETED: { label: 'Completed', color: '#1d4ed8' },
  ON_HOLD: { label: 'On hold', color: '#b45309' },
};

export function ProjectsPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showNew, setShowNew] = useState(searchParams.get('new') === '1');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [deadline, setDeadline] = useState('');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [members, setMembers] = useState<Record<string, ProjectMember[]>>({});
  const [activity, setActivity] = useState<Record<string, ProjectActivity[]>>({});
  const [stats, setStats] = useState<Record<string, Record<string, number>>>({});
  const [loadingPanel, setLoadingPanel] = useState<Record<string, boolean>>({});
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const cardsRef = useRef<Record<string, HTMLDivElement | null>>({});

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<{ projects: Project[] }>('/api/v1/projects');
      setProjects(res.projects ?? []);
      setState('ready');
    } catch {
      setProjects([]);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const focusId = searchParams.get('focus');
    if (focusId && cardsRef.current[focusId]) {
      cardsRef.current[focusId]!.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, projects]);

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/v1/projects', {
        method: 'POST',
        body: {
          name,
          description,
          repoUrl,
          deadline: deadline ? new Date(deadline).toISOString() : undefined,
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
      });
      setName('');
      setDescription('');
      setRepoUrl('');
      setDeadline('');
      setTags('');
      setShowNew(false);
      setSearchParams({}, { replace: true });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async (path: string, method: string, successMessage?: string) => {
    try {
      await api(path, { method });
      await load();
      if (successMessage) toast(successMessage);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'action failed', 'error');
    }
  };

  const toggleFavorite = (p: Project) =>
    void act(`/api/v1/projects/${p.id}/favorite`, 'POST', p.is_favorite ? 'Removed from favorites' : 'Added to favorites');

  const togglePanel = async (id: string) => {
    const isOpen = Boolean(open[id]);
    setOpen((prev) => ({ ...prev, [id]: !isOpen }));
    if (!isOpen) {
      setLoadingPanel((prev) => ({ ...prev, [id]: true }));
      try {
        const [m, a, s] = await Promise.all([
          api<{ members: ProjectMember[] }>(`/api/v1/projects/${id}/members`),
          api<{ activity: ProjectActivity[] }>(`/api/v1/projects/${id}/activity`),
          api<{ stats: Record<string, number> }>(`/api/v1/projects/${id}/stats`),
        ]);
        setMembers((prev) => ({ ...prev, [id]: m.members }));
        setActivity((prev) => ({ ...prev, [id]: a.activity }));
        setStats((prev) => ({ ...prev, [id]: s.stats }));
      } catch {
        setMembers((prev) => ({ ...prev, [id]: [] }));
        setActivity((prev) => ({ ...prev, [id]: [] }));
        setStats((prev) => ({ ...prev, [id]: {} }));
      } finally {
        setLoadingPanel((prev) => ({ ...prev, [id]: false }));
      }
    }
  };

  const addMember = async (id: string) => {
    if (!memberEmail.trim()) return;
    try {
      await api(`/api/v1/projects/${id}/members`, {
        method: 'POST',
        body: { email: memberEmail.trim(), role: memberRole },
      });
      setMemberEmail('');
      toast('Member added');
      const res = await api<{ members: ProjectMember[] }>(`/api/v1/projects/${id}/members`);
      setMembers((prev) => ({ ...prev, [id]: res.members }));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'add failed', 'error');
    }
  };

  const removeMember = async (id: string, userId: string) => {
    try {
      await api(`/api/v1/projects/${id}/members/${userId}`, { method: 'DELETE' });
      const res = await api<{ members: ProjectMember[] }>(`/api/v1/projects/${id}/members`);
      setMembers((prev) => ({ ...prev, [id]: res.members }));
      toast('Member removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'remove failed', 'error');
    }
  };

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Projects</h1>
        <button className="cc-btn" onClick={() => setShowNew((s) => !s)}>
          + New project
        </button>
      </div>
      {showNew && (
        <div className="cc-card">
          <div className="cc-field">
            <label htmlFor="project-name">Name</label>
            <input id="project-name" className="cc-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="project-description">Description</label>
            <textarea id="project-description" className="cc-textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="project-repo">Repository URL</label>
            <input id="project-repo" className="cc-input" type="url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="project-deadline">Deadline</label>
            <input id="project-deadline" className="cc-input" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="project-tags">Tags (comma separated)</label>
            <input id="project-tags" className="cc-input" value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <button className="cc-btn" disabled={busy || !name.trim()} onClick={() => void create()}>
            Create
          </button>
        </div>
      )}
      {state === 'loading' && <div className="cc-card cc-empty">Loading projects…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load projects.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {state === 'ready' && projects.length === 0 && <div className="cc-card cc-empty">No projects yet.</div>}
      {state === 'ready' &&
        projects.map((p) => {
          const status = STATUS_STYLE[p.status] ?? STATUS_STYLE.ACTIVE;
          const projectStats = stats[p.id];
          return (
            <div className="cc-card" key={p.id} ref={(el) => { cardsRef.current[p.id] = el; }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <div>
                  <h3 style={{ margin: 0 }}>
                    {p.name}{' '}
                    <span className="cc-pill" style={{ background: status.color, color: '#fff' }}>
                      {status.label}
                    </span>
                  </h3>
                  {p.description && <p className="cc-hint" style={{ margin: '4px 0' }}>{p.description}</p>}
                  {p.repo_url && (
                    <p className="cc-hint">
                      <a href={p.repo_url} target="_blank" rel="noreferrer">{p.repo_url}</a>
                    </p>
                  )}
                  {p.deadline && (
                    <p className="cc-hint">
                      Deadline:{' '}
                      <strong>{new Date(p.deadline).toLocaleDateString()}</strong>
                    </p>
                  )}
                  {p.tags.length > 0 && (
                    <p style={{ margin: '6px 0 0' }}>
                      {p.tags.map((t) => (
                        <span key={t} className="cc-pill" style={{ marginRight: 6 }}>
                          {t}
                        </span>
                      ))}
                    </p>
                  )}
                  {projectStats && (
                    <p className="cc-hint" style={{ margin: '6px 0 0' }}>
                      files {projectStats.files ?? 0} · conversations {projectStats.conversations ?? 0} · tasks{' '}
                      {projectStats.tasks ?? 0} · members {projectStats.members ?? 0}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignSelf: 'flex-start', maxWidth: 260, justifyContent: 'flex-end' }}>
                  <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void togglePanel(p.id)}>
                    {open[p.id] ? 'Hide details' : 'Details'}
                  </button>
                  {p.status === 'ARCHIVED' ? (
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void act(`/api/v1/projects/${p.id}/archive`, 'POST', 'Project restored')}>
                      Restore
                    </button>
                  ) : (
                    <>
                      {p.status === 'ACTIVE' && (
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void act(`/api/v1/projects/${p.id}/complete`, 'POST', 'Marked completed')}>
                          Complete
                        </button>
                      )}
                      {(p.status === 'ACTIVE' || p.status === 'ON_HOLD') && (
                        <button
                          className="cc-btn cc-btn--ghost cc-btn--sm"
                          onClick={() =>
                            void act(
                              p.status === 'ON_HOLD' ? `/api/v1/projects/${p.id}/complete` : `/api/v1/projects/${p.id}/on-hold`,
                              'POST',
                              p.status === 'ON_HOLD' ? 'Back to active' : 'On hold',
                            )
                          }
                        >
                          {p.status === 'ON_HOLD' ? 'Resume' : 'On hold'}
                        </button>
                      )}
                      <button
                        className="cc-btn cc-btn--ghost cc-btn--sm"
                        onClick={() => void toggleFavorite(p)}
                        aria-label={p.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        {p.is_favorite ? '★ Favorite' : '☆ Favorite'}
                      </button>
                      <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void act(`/api/v1/projects/${p.id}/archive`, 'POST', 'Archived')}>
                        Archive
                      </button>
                    </>
                  )}
                </div>
              </div>
              <PreviewPanel projectId={p.id} />
              {open[p.id] && (
                <div className="cc-hint" style={{ marginTop: 12 }}>
                  {loadingPanel[p.id] && <p>Loading details…</p>}
                  {!loadingPanel[p.id] && (
                    <>
                      <h4 style={{ fontSize: 13, marginTop: 8 }}>Members</h4>
                      {members[p.id]?.length === 0 && <p>No members.</p>}
                      {members[p.id]?.map((m) => (
                        <div key={m.userId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                          <span>{m.displayName ?? m.email}</span>
                          <span className="cc-pill" style={{ fontSize: 11 }}>{m.role}</span>
                          {m.role !== 'owner' && (
                            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void removeMember(p.id, m.userId)}>
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <input
                          className="cc-input"
                          style={{ width: 220 }}
                          placeholder="member email"
                          value={memberEmail}
                          onChange={(e) => setMemberEmail(e.target.value)}
                        />
                        <select className="cc-select" style={{ width: 120 }} value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                          <option value="admin">admin</option>
                          <option value="editor">editor</option>
                          <option value="member">member</option>
                          <option value="viewer">viewer</option>
                        </select>
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={!memberEmail.trim()} onClick={() => void addMember(p.id)}>
                          Add
                        </button>
                      </div>
                      <h4 style={{ fontSize: 13, marginTop: 12 }}>Activity</h4>
                      {activity[p.id]?.length === 0 && <p>No activity yet.</p>}
                      {activity[p.id]?.map((a) => (
                        <div key={a.id} style={{ padding: '2px 0' }}>
                          {a.action} — <span className="cc-mono">{new Date(a.createdAt).toLocaleString()}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}