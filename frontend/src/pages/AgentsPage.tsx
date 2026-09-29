/**
 * CodeConClave — Multi-agent workspace (Stage 25.5).
 * Specialized agents (Architect, Coder, Debugger, Researcher, Reviewer,
 * Tester, Security, DevOps, UI/UX, Documentation) run through the existing
 * planner → task → permission → approval → execution → audit pipeline.
 * Bounds (tasks per run, retries, budget, deadline) are enforced server-side;
 * this page only renders server state. Model assignment is role-routed to the
 * eligible set; no agent may be pinned to a model that is unconfigured,
 * unhealthy or below entitlement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import {
  type Agent,
  type AgentRole,
  type AgentRoleEntry,
  type AgentRun,
  type AgentRunTask,
} from '../lib/types';
import { useToast } from '../components/Toast';
import { DebatePanel } from '../components/DebatePanel';
import { MarketplacePanel } from '../components/MarketplacePanel';

type AgentsTab = 'agents' | 'debate' | 'marketplace';

const ROLE_STATE_COLORS: Record<string, { label: string; color: string }> = {
  IDLE: { label: 'Idle', color: '#64748b' },
  THINKING: { label: 'Thinking', color: '#8A3FFC' },
  RUNNING: { label: 'Running', color: '#2563eb' },
  WAITING_FOR_APPROVAL: { label: 'Waiting for approval', color: '#b45309' },
  WAITING_FOR_DEPENDENCY: { label: 'Waiting for dependency', color: '#b45309' },
  COMPLETED: { label: 'Completed', color: '#1e7d46' },
  FAILED: { label: 'Failed', color: '#dc2626' },
  BLOCKED: { label: 'Blocked', color: '#dc2626' },
};

const RUN_STATES = new Set(['THINKING', 'RUNNING', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_DEPENDENCY']);

interface ModelOption {
  id: string;
  providerId: string;
  label: string;
  available: boolean;
  locked: boolean;
  computeClass: string;
}

export function AgentsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<AgentsTab>('agents');
  const [roles, setRoles] = useState<AgentRoleEntry[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentRole>('CODER');
  const [objective, setObjective] = useState('');
  const [modelId, setModelId] = useState<string>('');
  const [maxTasks, setMaxTasks] = useState(3);
  const [maxRetries, setMaxRetries] = useState(1);
  const [busy, setBusy] = useState(false);

  const [runAgent, setRunAgent] = useState<Agent | null>(null);
  const [runObjective, setRunObjective] = useState('');
  const [runSubtasks, setRunSubtasks] = useState('');
  const [runProject, setRunProject] = useState('');
  const [runBudget, setRunBudget] = useState('2');
  const [runDeadline, setRunDeadline] = useState('120');
  const [runRequireApproval, setRunRequireApproval] = useState(false);

  const [detail, setDetail] = useState<{ agent: Agent; runs: AgentRun[] } | null>(null);
  const [runDetail, setRunDetail] = useState<{ run: AgentRun; tasks: AgentRunTask[] } | null>(null);
  const [usage, setUsage] = useState<{ count: number; max: number; plan: string } | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [r, a, m, p, u] = await Promise.all([
        api<{ roles: AgentRoleEntry[] }>('/api/v1/agents/roles'),
        api<{ agents: Agent[] }>('/api/v1/agents'),
        api<{ models: ModelOption[] }>('/api/v1/ai/models'),
        api<{ projects: { id: string; name: string }[] }>('/api/v1/projects'),
        api<{ usage: { count: number; max: number; plan: string } }>('/api/v1/agents/limits'),
      ]);
      setRoles(r.roles);
      setAgents(a.agents);
      setModels(m.models);
      setProjects(p.projects);
      setUsage(u.usage);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Bounded live refresh: only while any run is active (10s), stops when idle.
  const activeRef = useRef(false);
  useEffect(() => {
    if (state !== 'ready') return;
    const active = agents.some((a) => RUN_STATES.has(a.status) || RUN_STATES.has(a.run_status ?? ''));
    if (active === activeRef.current) return;
    activeRef.current = active;
    if (!active) return;
    const timer = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [agents, state, load]);

  const eligibleForRole = useMemo(() => {
    const routing = roles.find((r) => r.role === role);
    const available = models.filter((m) => m.available);
    // Role compute class preference first (A for research/docs, B for coding,
    // C for architecture/review), then cheapest eligible.
    const preferredClass = routing?.computeClass === 'C' ? ['C', 'B', 'A'] : routing?.computeClass === 'A' ? ['A', 'B'] : ['B', 'A'];
    return [...available].sort((a, b) => {
      const ai = preferredClass.indexOf(a.computeClass);
      const bi = preferredClass.indexOf(b.computeClass);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [roles, role, models]);

  useEffect(() => {
    if (modelId && eligibleForRole.some((m) => m.id === modelId)) return;
    setModelId(eligibleForRole[0]?.id ?? '');
  }, [eligibleForRole, modelId]);

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/v1/agents', {
        method: 'POST',
        body: {
          name,
          role,
          objective: objective || undefined,
          modelId: modelId || null,
          maxTasksPerRun: maxTasks,
          maxRetries,
        },
      });
      setName('');
      setObjective('');
      setShowNew(false);
      await load();
      toast('Agent created');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Agent) => {
    try {
      await api(`/api/v1/agents/${a.id}`, { method: 'DELETE' });
      await load();
      toast('Agent deleted');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'delete failed', 'error');
    }
  };

  const openDetail = async (a: Agent) => {
    try {
      const res = await api<{ agent: Agent; runs: AgentRun[] }>(`/api/v1/agents/${a.id}`);
      setDetail(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  };

  const openRun = async (runId: string) => {
    try {
      const res = await api<{ run: AgentRun; tasks: AgentRunTask[] }>(`/api/v1/agents/runs/${runId}`);
      setRunDetail(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'load failed', 'error');
    }
  };

  const startRun = async () => {
    if (!runAgent) return;
    setBusy(true);
    try {
      const subtasks = runSubtasks
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((title) => ({ title }));
      const res = await api<{ run: AgentRun }>(`/api/v1/agents/${runAgent.id}/run`, {
        method: 'POST',
        body: {
          objective: runObjective,
          subtasks: subtasks.length ? subtasks : undefined,
          projectId: runProject || undefined,
          budgetUsd: Number(runBudget) || undefined,
          deadlineMinutes: Number(runDeadline) || undefined,
          requireApproval: runRequireApproval,
        },
      });
      setRunAgent(null);
      setRunObjective('');
      setRunSubtasks('');
      setRunRequireApproval(false);
      await load();
      await openDetail(runAgent);
      void openRun(res.run.id);
      toast('Agent run started — tasks created through the execution pipeline');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'run failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async (runId: string) => {
    try {
      const res = await api<{ run: AgentRun }>(`/api/v1/agents/runs/${runId}/cancel`, { method: 'POST' });
      setRunDetail((prev) => (prev ? { ...prev, run: res.run } : prev));
      await load();
      toast('Run cancelled');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'cancel failed', 'error');
    }
  };

  const badge = (status: string) => {
    const s = ROLE_STATE_COLORS[status] ?? { label: status, color: '#334155' };
    return (
      <span className="cc-pill" style={{ background: s.color, color: '#fff' }}>
        {s.label}
      </span>
    );
  };

  const trustBadge = (a: Agent) => {
    const stored = a.trust_level ?? 'L2';
    const effective = a.effective_trust_level ?? stored;
    const clamped = effective !== stored;
    return (
      <span className="cc-pill" style={{ background: clamped ? '#b45309' : '#0f766e', color: '#fff' }} title={clamped ? `Stored ${stored} — plan caps effective trust at ${effective}` : `Trust ${effective}`}>
        Trust {effective}{clamped ? ` (${stored})` : ''}
      </span>
    );
  };

  const changeTrust = async (a: Agent, level: string) => {
    try {
      await api<{ agent: Agent }>(`/api/v1/agents/${a.id}/trust`, { method: 'PATCH', body: { trustLevel: level } });
      await load();
      toast(`Trust set to ${level}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'trust change failed', 'error');
    }
  };

  if (state === 'loading') return <div className="cc-page"><div className="cc-card cc-empty">Loading agents…</div></div>;
  if (state === 'error') {
    return (
      <div className="cc-page">
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load the agent workspace.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cc-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Agents</h1>
          <p className="cc-hint" style={{ margin: 0 }}>
            Specialized agents run through the existing planner → task → permission → approval → execution → audit
            pipeline. Bounds (tasks per run, retries, budget, deadline) are enforced server-side.
          </p>
          {usage && (
            <p className="cc-hint" style={{ margin: '6px 0 0' }}>
              My Agents {usage.count}/{usage.max}
            </p>
          )}
        </div>
        {tab === 'agents' && <button className="cc-btn" onClick={() => setShowNew((s) => !s)}>+ New agent</button>}
      </div>

      <div className="cc-tabs" role="tablist" aria-label="Agent workspace sections">
        {([
          ['agents', 'Agents'],
          ['debate', 'Debate'],
          ['marketplace', 'Marketplace'],
        ] as [AgentsTab, string][]).map(([key, label]) => (
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

      {tab !== 'agents' && (
        <div className="cc-card">
          {tab === 'debate' ? <DebatePanel /> : <MarketplacePanel />}
        </div>
      )}

      {tab === 'agents' && (
      <>
      {showNew && (
        <div className="cc-card">
          <div className="cc-field">
            <label htmlFor="agent-name">Name</label>
            <input id="agent-name" className="cc-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="agent-role">Role</label>
            <select id="agent-role" className="cc-select" value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
              {roles.map((r) => (
                <option key={r.role} value={r.role}>
                  {r.label} — {r.description}
                </option>
              ))}
            </select>
          </div>
          <div className="cc-field">
            <label htmlFor="agent-objective">Standing objective</label>
            <textarea id="agent-objective" className="cc-textarea" rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="agent-model">Model (role-routed, eligible only)</label>
            <select id="agent-model" className="cc-select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              {eligibleForRole.length === 0 && <option value="">No eligible model (configure a provider)</option>}
              {eligibleForRole.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} ({m.providerId})
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="agent-max-tasks">Max tasks per run</label>
              <input id="agent-max-tasks" className="cc-input" type="number" min={1} max={20} value={maxTasks} onChange={(e) => setMaxTasks(Number(e.target.value))} />
            </div>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="agent-max-retries">Max retries</label>
              <input id="agent-max-retries" className="cc-input" type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(Number(e.target.value))} />
            </div>
          </div>
          <button className="cc-btn" disabled={busy || !name.trim()} onClick={() => void create()}>
            Create agent
          </button>
        </div>
      )}

      {agents.length === 0 && <div className="cc-card cc-empty">No agents yet — create one to start delegating work.</div>}

      {agents.map((a) => (
        <div className="cc-card" key={a.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h3 style={{ margin: 0 }}>
                {a.name} {badge(a.status)}
              </h3>
              <p className="cc-hint cc-mono" style={{ margin: '4px 0' }}>
                {a.role} · model {a.model_id ?? 'auto-routed'} · {a.max_tasks_per_run} tasks/run · {a.max_retries} retries
              </p>
              {a.objective && <p style={{ margin: '4px 0' }}>{a.objective}</p>}
              {a.run_status && RUN_STATES.has(a.run_status) && (
                <p className="cc-hint" style={{ margin: '4px 0' }}>
                  Active run: {a.completed_tasks ?? 0}/{a.total_tasks ?? 0} tasks · spent ${(a.spent_usd ?? 0).toFixed(4)}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignSelf: 'flex-start' }}>
              {trustBadge(a)}
              <select
                className="cc-select"
                style={{ width: 'auto' }}
                value={a.trust_level ?? 'L2'}
                title="Trust level (server-clamped by your plan)"
                aria-label={`Trust level for ${a.name}`}
                onChange={(e) => void changeTrust(a, e.target.value)}
              >
                {['L0', 'L1', 'L2', 'L3', 'L4'].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              {a.status === 'IDLE' && (
                <button className="cc-btn cc-btn--sm" onClick={() => setRunAgent(a)}>
                  Run
                </button>
              )}
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void openDetail(a)}>
                {detail?.agent.id === a.id ? 'Close' : 'Runs'}
              </button>
              <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void remove(a)} disabled={a.status !== 'IDLE'}>
                Delete
              </button>
            </div>
          </div>
          {runAgent?.id === a.id && (
            <div className="cc-card" style={{ marginTop: 12 }}>
              <h4 style={{ margin: '0 0 8px' }}>Start run — {runAgent.name}</h4>
              <div className="cc-field">
                <label htmlFor="run-objective">Objective</label>
                <textarea id="run-objective" className="cc-textarea" rows={2} value={runObjective} onChange={(e) => setRunObjective(e.target.value)} />
              </div>
              <div className="cc-field">
                <label htmlFor="run-subtasks">Subtasks (one per line, optional)</label>
                <textarea id="run-subtasks" className="cc-textarea" rows={3} value={runSubtasks} onChange={(e) => setRunSubtasks(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div className="cc-field" style={{ flex: 1 }}>
                  <label htmlFor="run-project">Project</label>
                  <select id="run-project" className="cc-select" value={runProject} onChange={(e) => setRunProject(e.target.value)}>
                    <option value="">Auto (first project)</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div className="cc-field" style={{ width: 110 }}>
                  <label htmlFor="run-budget">Budget USD</label>
                  <input id="run-budget" className="cc-input" type="number" min={0.1} step={0.1} value={runBudget} onChange={(e) => setRunBudget(e.target.value)} />
                </div>
                <div className="cc-field" style={{ width: 120 }}>
                  <label htmlFor="run-deadline">Deadline (min)</label>
                  <input id="run-deadline" className="cc-input" type="number" min={5} max={1440} value={runDeadline} onChange={(e) => setRunDeadline(e.target.value)} />
                </div>
              </div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0' }} className="cc-hint">
                <input type="checkbox" checked={runRequireApproval} onChange={(e) => setRunRequireApproval(e.target.checked)} />
                Require approval for high-risk tasks
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="cc-btn" disabled={busy || !runObjective.trim()} onClick={() => void startRun()}>
                  Start run
                </button>
                <button className="cc-btn cc-btn--ghost" onClick={() => setRunAgent(null)}>Cancel</button>
              </div>
            </div>
          )}
          {detail?.agent.id === a.id && (
            <div style={{ marginTop: 12 }}>
              {detail.runs.length === 0 && <p className="cc-hint">No runs yet.</p>}
              {detail.runs.map((r) => (
                <div key={r.id} className="cc-card" style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div>
                      <strong>{r.objective ?? r.id}</strong> {badge(r.status)}
                      <p className="cc-hint cc-mono" style={{ margin: '2px 0 0' }}>
                        {r.completed_tasks}/{r.total_tasks} tasks · {r.failed_tasks} failed · retries {r.retries_used} ·
                        spent ${Number(r.spent_usd ?? 0).toFixed(4)} · budget ${Number(r.budget_usd ?? 0).toFixed(2)} ·
                        deadline {r.deadline_at ? new Date(r.deadline_at).toLocaleString() : '—'}
                      </p>
                      {r.error && <p className="cc-hint" style={{ margin: '2px 0 0', color: '#dc2626' }}>{r.error}</p>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void openRun(r.id)}>Tasks</button>
                      {!['COMPLETED', 'FAILED', 'BLOCKED'].includes(r.status) && (
                        <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void cancelRun(r.id)}>Cancel</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {runDetail && (
        <div className="cc-card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Run tasks {badge(runDetail.run.status)}</h3>
            <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => setRunDetail(null)}>Close</button>
          </div>
          <p className="cc-hint" style={{ margin: '4px 0' }}>{runDetail.run.objective}</p>
          {runDetail.tasks.length === 0 && <p className="cc-hint">No tasks recorded yet.</p>}
          {runDetail.tasks.map((t) => (
            <div key={t.id} className="cc-hint" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' }}>
              <span className="cc-pill" style={{ fontSize: 11 }}>{t.status}</span>
              <span className="cc-mono" style={{ fontSize: 12 }}>{t.id}</span>
              <span>{t.title}</span>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}