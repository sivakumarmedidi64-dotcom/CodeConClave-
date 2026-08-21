/**
 * CodeConClave — Teams workspace (Phase 9).
 * Full team collaboration UI: create/rename/archive teams, invitations,
 * member roles + suspend/remove, settings, stats, shared projects and
 * conversations, activity feed, and team DNA (create/branch/merge).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import type {
  Project,
  Team,
  TeamActivityItem,
  TeamInvitation,
  TeamMember,
  TeamStats,
} from '../lib/types';
import { useToast } from '../components/Toast';

const ROLES = ['owner', 'admin', 'editor', 'viewer', 'guest'];
const MANAGER_ROLES = new Set(['owner', 'admin']);

interface TeamDnaBlock {
  id: string;
  team_id: string;
  created_by: string;
  kind: string;
  scope: 'MAIN' | 'BRANCH';
  title: string;
  content: string;
  version: number;
  parent_version_id: string | null;
  conflict_state: string;
  status: string;
  change_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface TeamConv {
  id: string;
  title: string;
  owner_id: string;
  project_id: string | null;
  team_id: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export function TeamsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [myProjects, setMyProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<TeamConv[]>([]);
  const [activity, setActivity] = useState<TeamActivityItem[]>([]);
  const [dna, setDna] = useState<TeamDnaBlock[]>([]);
  const [stats, setStats] = useState<TeamStats | null>(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('editor');
  const [dnaTitle, setDnaTitle] = useState('');
  const [dnaContent, setDnaContent] = useState('');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');

  const current = useMemo(() => teams.find((t) => t.id === selected) ?? null, [teams, selected]);
  const myRole = useMemo(
    () => (user ? members.find((m) => m.user_id === user.id)?.role ?? null : null),
    [members, user],
  );
  const canManage = myRole !== null && MANAGER_ROLES.has(myRole);
  const canEdit = canManage || myRole === 'editor';

  const load = useCallback(async () => {
    try {
      const res = await api<{ teams: Team[] }>('/api/v1/teams');
      setTeams(res.teams);
      setSelected((prev) => prev ?? res.teams[0]?.id ?? null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  }, [toast]);

  const loadDetail = useCallback(async (teamId: string) => {
    try {
      const [m, i, p, c, a, d, s] = await Promise.all([
        api<{ members: TeamMember[] }>(`/api/v1/teams/${teamId}/members`),
        api<{ invitations: TeamInvitation[] }>(`/api/v1/teams/${teamId}/invitations`),
        api<{ projects: Project[] }>(`/api/v1/teams/${teamId}/projects`),
        api<{ conversations: TeamConv[] }>(`/api/v1/teams/${teamId}/conversations`),
        api<{ activity: TeamActivityItem[] }>(`/api/v1/teams/${teamId}/activity`),
        api<{ blocks: TeamDnaBlock[] }>(`/api/v1/dna/team/${teamId}`),
        api<TeamStats>(`/api/v1/teams/${teamId}/stats`),
      ]);
      setMembers(m.members);
      setInvitations(i.invitations);
      setProjects(p.projects);
      setConversations(c.conversations);
      setActivity(a.activity);
      setDna(d.blocks);
      setStats(s);
    } catch {
      /* detail load is best-effort */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    void loadDetail(selected);
    void api<{ projects: Project[] }>('/api/v1/projects')
      .then((res) => setMyProjects(res.projects))
      .catch(() => undefined);
  }, [selected, loadDetail]);

  const create = async () => {
    try {
      await api('/api/v1/teams', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim() || undefined },
      });
      setName('');
      setDescription('');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    }
  };

  const patchTeam = async (body: Record<string, unknown>) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}`, { method: 'PATCH', body });
      await load();
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
    }
  };

  const toggleArchive = async () => {
    if (!selected || !current) return;
    try {
      await api(`/api/v1/teams/${selected}/${current.archived_at ? 'restore' : 'archive'}`, { method: 'POST' });
      await load();
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'archive failed', 'error');
    }
  };

  const invite = async () => {
    if (!selected || !email.trim()) return;
    try {
      await api(`/api/v1/teams/${selected}/members`, {
        method: 'POST',
        body: { email: email.trim(), role: inviteRole },
      });
      setEmail('');
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'invite failed', 'error');
    }
  };

  const cancelInvitation = async (invitationId: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}/invitations/${invitationId}/cancel`, { method: 'POST' });
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'cancel failed', 'error');
    }
  };

  const changeRole = async (userId: string, role: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}/members/${userId}`, { method: 'PATCH', body: { role } });
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'role change failed', 'error');
    }
  };

  const suspendMember = async (userId: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}/members/${userId}/suspend`, { method: 'POST' });
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'suspend failed', 'error');
    }
  };

  const removeMember = async (userId: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}/members/${userId}`, { method: 'DELETE' });
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'remove failed', 'error');
    }
  };

  const attachProject = async (projectId: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}/projects/${projectId}`, { method: 'POST' });
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'attach failed', 'error');
    }
  };

  const detachProject = async (projectId: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/teams/${selected}/projects/${projectId}`, { method: 'DELETE' });
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'detach failed', 'error');
    }
  };

  const saveTeamDna = async (scope: 'MAIN' | 'BRANCH', baseId?: string) => {
    if (!selected || !dnaTitle.trim() || !dnaContent.trim()) return;
    try {
      if (scope === 'MAIN') {
        await api('/api/v1/dna/team', {
          method: 'POST',
          body: { teamId: selected, kind: 'DECISION', title: dnaTitle.trim(), content: dnaContent.trim() },
        });
      } else if (baseId) {
        await api(`/api/v1/dna/team/${selected}/branch`, {
          method: 'POST',
          body: { baseDnaId: baseId, title: dnaTitle.trim(), content: dnaContent.trim() },
        });
      }
      setDnaTitle('');
      setDnaContent('');
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'dna save failed', 'error');
    }
  };

  const mergeBranch = async (branchId: string, baseId: string) => {
    if (!selected) return;
    try {
      await api(`/api/v1/dna/team/${selected}/merge`, {
        method: 'POST',
        body: { branchId, baseId },
      });
      toast('Merged branch into MAIN', 'info');
      await loadDetail(selected);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'merge failed', 'error');
    }
  };

  const mainBlocks = dna.filter((b) => b.scope === 'MAIN');
  const branchBlocks = dna.filter((b) => b.scope === 'BRANCH');
  const unattached = myProjects.filter((p) => !projects.some((sp) => sp.id === p.id));

  return (
    <div className="cc-page">
      <h1>Teams</h1>
      <div className="cc-card">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="cc-input" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="cc-input" style={{ width: 280 }} placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          <button className="cc-btn" disabled={!name.trim()} onClick={() => void create()}>
            Create team
          </button>
        </div>
      </div>
      {teams.length === 0 && <div className="cc-card cc-empty">No teams yet.</div>}
      <div className="cc-grid" style={{ gridTemplateColumns: '240px 1fr' }}>
        <div className="cc-card" style={{ padding: 8 }}>
          {teams.map((t) => (
            <button
              key={t.id}
              className="cc-sidebar__item"
              style={{ color: '#111', fontWeight: t.id === selected ? 700 : 400 }}
              onClick={() => setSelected(t.id)}
            >
              {t.name}
              {t.archived_at ? ' (archived)' : ''}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {current && (
            <div className="cc-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  {editingName === current.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input className="cc-input" value={newName} onChange={(e) => setNewName(e.target.value)} />
                      <button
                        className="cc-btn cc-btn--sm"
                        onClick={() => {
                          void patchTeam({ name: newName.trim() });
                          setEditingName(null);
                        }}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <h3 style={{ margin: 0 }}>{current.name}</h3>
                  )}
                  {editingDescription === current.id ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <input className="cc-input" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
                      <button
                        className="cc-btn cc-btn--sm"
                        onClick={() => {
                          void patchTeam({ description: newDescription });
                          setEditingDescription(null);
                        }}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <p style={{ margin: '4px 0 0', color: '#666' }}>
                      {current.description ?? 'No description'}
                      <button
                        className="cc-btn cc-btn--ghost cc-btn--sm"
                        onClick={() => {
                          setNewDescription(current.description ?? '');
                          setEditingDescription(current.id);
                        }}
                      >
                        edit
                      </button>
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="cc-btn cc-btn--ghost cc-btn--sm"
                    onClick={() => {
                      setNewName(current.name);
                      setEditingName(current.id);
                    }}
                  >
                    Rename
                  </button>
                  {myRole === 'owner' && (
                    <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleArchive()}>
                      {current.archived_at ? 'Restore' : 'Archive'}
                    </button>
                  )}
                </div>
              </div>
              {stats && (
                <div className="cc-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 12 }}>
                  {[
                    ['Members', stats.members],
                    ['Projects', stats.projects],
                    ['Pending invites', stats.pendingInvitations],
                    ['Activities', stats.activities],
                  ].map(([label, value]) => (
                    <div key={label} className="cc-card" style={{ padding: 8, textAlign: 'center' }}>
                      <div style={{ fontWeight: 700 }}>{value}</div>
                      <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {selected && (
            <>
              <div className="cc-card">
                <h3>Members</h3>
                <table className="cc-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Joined</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.user_id}>
                        <td>{m.display_name ?? '—'}</td>
                        <td>{m.email}</td>
                        <td>
                          {canManage ? (
                            <select className="cc-select" value={m.role} onChange={(e) => void changeRole(m.user_id, e.target.value)}>
                              {ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </select>
                          ) : (
                            m.role
                          )}
                        </td>
                        <td>{m.status}</td>
                        <td>{new Date(m.joined_at).toLocaleDateString()}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {canManage && m.status === 'ACTIVE' && (
                            <>
                              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void suspendMember(m.user_id)}>
                                Suspend
                              </button>{' '}
                              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void removeMember(m.user_id)}>
                                Remove
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <input className="cc-input" placeholder="member@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <select className="cc-select" style={{ width: 140 }} value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <button className="cc-btn" disabled={!email.trim()} onClick={() => void invite()}>
                      Invite
                    </button>
                  </div>
                )}
              </div>

              {invitations.length > 0 && (
                <div className="cc-card">
                  <h3>Invitations</h3>
                  <table className="cc-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Role</th>
                        <th>State</th>
                        <th>Expires</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {invitations.map((inv) => (
                        <tr key={inv.id}>
                          <td>{inv.invitee_email}</td>
                          <td>{inv.role}</td>
                          <td>{inv.state}</td>
                          <td>{new Date(inv.expires_at).toLocaleDateString()}</td>
                          <td>
                            {inv.state === 'PENDING' && canManage && (
                              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void cancelInvitation(inv.id)}>
                                Cancel
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="cc-card">
                <h3>Shared projects</h3>
                {projects.length === 0 && <div className="cc-empty">No projects shared with this team yet.</div>}
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {projects.map((p) => (
                    <li key={p.id} style={{ marginBottom: 4 }}>
                      {p.name}
                      {canManage && (
                        <button className="cc-btn cc-btn--ghost cc-btn--sm" style={{ marginLeft: 8 }} onClick={() => void detachProject(p.id)}>
                          Unshare
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {canManage && unattached.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <select className="cc-select" defaultValue="" onChange={(e) => e.target.value && void attachProject(e.target.value)}>
                      <option value="" disabled>
                        Share a project…
                      </option>
                      {unattached.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              <div className="cc-card">
                <h3>Shared conversations</h3>
                {conversations.length === 0 && <div className="cc-empty">No conversations shared with this team yet.</div>}
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {conversations.map((c) => (
                    <li key={c.id} style={{ marginBottom: 4 }}>
                      {c.title}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="cc-card">
                <h3>Team DNA</h3>
                {canEdit && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                    <input className="cc-input" style={{ width: 220 }} placeholder="Title" value={dnaTitle} onChange={(e) => setDnaTitle(e.target.value)} />
                    <input className="cc-input" style={{ flex: 1 }} placeholder="Decision / context" value={dnaContent} onChange={(e) => setDnaContent(e.target.value)} />
                    <button className="cc-btn cc-btn--sm" disabled={!dnaTitle.trim() || !dnaContent.trim()} onClick={() => void saveTeamDna('MAIN')}>
                      Add MAIN
                    </button>
                  </div>
                )}
                {mainBlocks.map((b) => (
                  <div key={b.id} className="cc-card" style={{ padding: 8, marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong>
                        {b.title} <span className="cc-badge">{b.scope} v{b.version}</span>
                      </strong>
                      {canEdit && (
                        <button
                          className="cc-btn cc-btn--ghost cc-btn--sm"
                          onClick={() => {
                            setDnaTitle(`Branch of ${b.title}`);
                            setDnaContent(b.content);
                            void saveTeamDna('BRANCH', b.id);
                          }}
                        >
                          Branch
                        </button>
                      )}
                    </div>
                    <p style={{ margin: '4px 0 0', color: '#666', fontSize: 13 }}>{b.content}</p>
                    {b.conflict_state !== 'NONE' && <div className="cc-badge">conflict: {b.conflict_state}</div>}
                  </div>
                ))}
                {branchBlocks.length > 0 && (
                  <>
                    <h4 style={{ marginBottom: 8 }}>Branches</h4>
                    {branchBlocks.map((b) => (
                      <div key={b.id} className="cc-card" style={{ padding: 8, marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <strong>
                            {b.title} <span className="cc-badge">BRANCH v{b.version}</span>
                          </strong>
                          {canManage && (
                            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void mergeBranch(b.id, b.parent_version_id ?? b.id)}>
                              Merge to MAIN
                            </button>
                          )}
                        </div>
                        <p style={{ margin: '4px 0 0', color: '#666', fontSize: 13 }}>{b.content}</p>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="cc-card">
                <h3>Activity</h3>
                {activity.length === 0 && <div className="cc-empty">No activity yet.</div>}
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {activity.map((a) => (
                    <li key={a.id} style={{ marginBottom: 4 }}>
                      <strong>{a.display_name ?? a.actor_user_id}</strong> {a.action} — {new Date(a.created_at).toLocaleString()}
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}