/**
 * CodeConClave — Automation (Stage 26I): scheduled tasks, goals, escalations.
 * Everything here drives the real scheduling engine: schedules create agent
 * runs through the planner pipeline, goals build plans and execute through
 * the same bounded execution path, escalations surface blocked work for a
 * human decision. The page renders server state only.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type {
  Agent,
  EscalationRow,
  GoalRow,
  Project,
  ScheduleRow,
  ScheduleRunRow,
} from '../lib/types';
import { useToast } from '../components/Toast';

type AutomationTab = 'schedules' | 'goals' | 'escalations';

const SCHEDULE_STATE_COLORS: Record<string, string> = {
  COMPLETED: '#1e7d46',
  FAILED: '#dc2626',
  RUNNING: '#2563eb',
  SKIPPED: '#64748b',
  CANCELLED: '#64748b',
};

const GOAL_STATE_COLORS: Record<string, string> = {
  DRAFT: '#64748b',
  PLANNING: '#2563eb',
  PLAN_READY: '#0f766e',
  WAITING_FOR_APPROVAL: '#b45309',
  RUNNING: '#2563eb',
  PAUSED: '#b45309',
  BLOCKED: '#dc2626',
  WAITING_FOR_HUMAN_DECISION: '#b45309',
  COMPLETED: '#1e7d46',
  FAILED: '#dc2626',
  CANCELLED: '#64748b',
};

const ESCALATION_COLORS: Record<string, string> = {
  OPEN: '#dc2626',
  ACKNOWLEDGED: '#b45309',
  RESOLVED: '#1e7d46',
  DISMISSED: '#64748b',
};

export function AutomationPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<AutomationTab>('schedules');

  return (
    <div className="cc-page">
      <h1 style={{ marginBottom: 4 }}>Automation</h1>
      <p className="cc-hint" style={{ marginTop: 0 }}>
        Scheduled tasks, goal-mode execution and escalations — all run through the same planner → task → permission →
        approval → execution → audit pipeline, gated by the control plane and kill switch.
      </p>
      <div className="cc-tabs" role="tablist" aria-label="Automation sections">
        {([
          ['schedules', 'Schedules'],
          ['goals', 'Goals'],
          ['escalations', 'Escalations'],
        ] as [AutomationTab, string][]).map(([key, label]) => (
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
      {tab === 'schedules' && <SchedulesTab />}
      {tab === 'goals' && <GoalsTab />}
      {tab === 'escalations' && <EscalationsTab />}
    </div>
  );
}

function SchedulesTab() {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [agentId, setAgentId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [recurrence, setRecurrence] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'HOURLY' | 'ONCE' | 'CRON'>('DAILY');
  const [runAt, setRunAt] = useState('09:00');
  const [runOnDays, setRunOnDays] = useState<string[]>([]);
  const [cronExpression, setCronExpression] = useState('');
  const [mode, setMode] = useState<'CLOUD' | 'LOCAL_ONLY' | 'HYBRID'>('CLOUD');
  const [missed, setMissed] = useState<'RUN_ON_RECOVERY' | 'SKIP_STALE' | 'RUN_ONCE'>('RUN_ON_RECOVERY');
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<Record<string, ScheduleRunRow[]>>({});
  const [loadingRuns, setLoadingRuns] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [s, a, p] = await Promise.all([
        api<{ schedules: ScheduleRow[] }>('/api/v1/scheduling/schedules?includeDisabled=1'),
        api<{ agents: Agent[] }>('/api/v1/agents'),
        api<{ projects: Project[] }>('/api/v1/projects'),
      ]);
      setSchedules(s.schedules ?? []);
      setAgents(a.agents ?? []);
      setProjects(p.projects ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDay = (d: string) => {
    setRunOnDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  };

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/v1/scheduling/schedules', {
        method: 'POST',
        body: {
          title: title.trim(),
          taskPrompt: taskPrompt.trim(),
          agentId,
          projectId: projectId || undefined,
          recurrence,
          runAt: recurrence === 'ONCE' ? runAt : undefined,
          runOnDays: runOnDays.length ? runOnDays : undefined,
          cronExpression: recurrence === 'CRON' ? cronExpression : undefined,
          executionMode: mode,
          missedRunPolicy: missed,
        },
      });
      setTitle('');
      setTaskPrompt('');
      setShowNew(false);
      await load();
      toast('Schedule created — first run is server-scheduled');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (s: ScheduleRow) => {
    try {
      await api(`/api/v1/scheduling/schedules/${s.id}/${s.enabled ? 'pause' : 'resume'}`, { method: 'POST', body: {} });
      await load();
      toast(s.enabled ? 'Schedule paused' : 'Schedule resumed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'update failed', 'error');
    }
  };

  const runNow = async (s: ScheduleRow) => {
    try {
      await api(`/api/v1/scheduling/schedules/${s.id}/run-now`, { method: 'POST', body: {} });
      toast('Run requested — the executor picks it up');
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'run failed', 'error');
    }
  };

  const remove = async (s: ScheduleRow) => {
    try {
      await api(`/api/v1/scheduling/schedules/${s.id}`, { method: 'DELETE' });
      await load();
      toast('Schedule deleted');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'delete failed', 'error');
    }
  };

  const loadRuns = async (s: ScheduleRow) => {
    setLoadingRuns((prev) => ({ ...prev, [s.id]: true }));
    try {
      const res = await api<{ runs: ScheduleRunRow[] }>(`/api/v1/scheduling/schedules/${s.id}/runs?limit=10`);
      setRuns((prev) => ({ ...prev, [s.id]: res.runs }));
    } catch {
      setRuns((prev) => ({ ...prev, [s.id]: [] }));
    } finally {
      setLoadingRuns((prev) => ({ ...prev, [s.id]: false }));
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p className="cc-hint" style={{ margin: 0 }}>
          Recurring agent runs. Missed-run policies and execution modes are enforced server-side; disabled schedules
          are kept for audit.
        </p>
        <button className="cc-btn" onClick={() => setShowNew((s) => !s)}>+ New schedule</button>
      </div>

      {showNew && (
        <div className="cc-card">
          <div className="cc-field">
            <label htmlFor="sched-title">Title</label>
            <input id="sched-title" className="cc-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="sched-prompt">Task prompt</label>
            <textarea id="sched-prompt" className="cc-textarea" rows={2} value={taskPrompt} onChange={(e) => setTaskPrompt(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="sched-agent">Agent</label>
              <select id="sched-agent" className="cc-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Select agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.role})</option>
                ))}
              </select>
            </div>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="sched-project">Project</label>
              <select id="sched-project" className="cc-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="cc-field">
              <label htmlFor="sched-recurrence">Recurrence</label>
              <select id="sched-recurrence" className="cc-select" value={recurrence} onChange={(e) => setRecurrence(e.target.value as typeof recurrence)}>
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
                <option value="HOURLY">Hourly</option>
                <option value="ONCE">Once</option>
                <option value="CRON">Cron</option>
              </select>
            </div>
            <div className="cc-field">
              <label htmlFor="sched-runat">Run at</label>
              <input id="sched-runat" className="cc-input" type={recurrence === 'ONCE' ? 'datetime-local' : 'time'} value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </div>
            {recurrence === 'CRON' && (
              <div className="cc-field" style={{ flex: 1 }}>
                <label htmlFor="sched-cron">Cron expression</label>
                <input id="sched-cron" className="cc-input cc-mono" value={cronExpression} onChange={(e) => setCronExpression(e.target.value)} placeholder="0 9 * * 1-5" />
              </div>
            )}
            {recurrence === 'WEEKLY' && (
              <div className="cc-field">
                <label>Days</label>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="cc-pill"
                      style={{ cursor: 'pointer', background: runOnDays.includes(d) ? '#0f766e' : '#1e293b', color: '#fff' }}
                      aria-pressed={runOnDays.includes(d)}
                      onClick={() => toggleDay(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="cc-field">
              <label htmlFor="sched-mode">Execution mode</label>
              <select id="sched-mode" className="cc-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="CLOUD">Cloud</option>
                <option value="LOCAL_ONLY">Local only</option>
                <option value="HYBRID">Hybrid</option>
              </select>
            </div>
            <div className="cc-field">
              <label htmlFor="sched-missed">Missed-run policy</label>
              <select id="sched-missed" className="cc-select" value={missed} onChange={(e) => setMissed(e.target.value as typeof missed)}>
                <option value="RUN_ON_RECOVERY">Run on recovery</option>
                <option value="SKIP_STALE">Skip stale</option>
                <option value="RUN_ONCE">Run once</option>
              </select>
            </div>
          </div>
          <button className="cc-btn" disabled={busy || !title.trim() || !taskPrompt.trim() || !agentId} onClick={() => void create()}>
            Create schedule
          </button>
        </div>
      )}

      {state === 'loading' && <div className="cc-card cc-empty">Loading schedules…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load schedules.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {state === 'ready' && schedules.length === 0 && <div className="cc-card cc-empty">No schedules yet — create one to run agents on a cadence.</div>}

      {schedules.map((s) => (
        <div className="cc-card" key={s.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h4 style={{ margin: 0 }}>
                {s.title} {!s.enabled && <span className="cc-pill" style={{ background: '#b45309', color: '#fff' }}>paused</span>}
              </h4>
              {s.description ? (
                <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 12 }}>{s.description}</p>
              ) : (
                <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 12 }}>
                  {s.recurrence}{s.cron_expression ? ` · ${s.cron_expression}` : ''} · {s.run_at} · {s.timezone}
                </p>
              )}
              <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 12 }}>
                {s.execution_mode} · missed: {s.missed_run_policy} · runs: {s.run_count} · next:{' '}
                {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : '—'} · last:{' '}
                {s.last_run_at ? `${new Date(s.last_run_at).toLocaleString()} (${s.last_run_status ?? '?'})` : '—'}
              </p>
              {s.error && <p className="cc-hint" style={{ margin: '2px 0', color: '#dc2626' }}>{s.error}</p>}
            </div>
            <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void runNow(s)}>Run now</button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void toggleEnabled(s)}>
                {s.enabled ? 'Pause' : 'Resume'}
              </button>
              <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void loadRuns(s)}>
                {runs[s.id] ? 'Hide runs' : 'Runs'}
              </button>
              <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void remove(s)}>Delete</button>
            </div>
          </div>
          {runs[s.id] && (
            <div className="cc-hint" style={{ marginTop: 10 }}>
              {loadingRuns[s.id] && <p>Loading runs…</p>}
              {!loadingRuns[s.id] && runs[s.id]!.length === 0 && <p>No runs recorded yet.</p>}
              {!loadingRuns[s.id] && runs[s.id]!.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                  <span className="cc-pill" style={{ background: SCHEDULE_STATE_COLORS[r.status] ?? '#334155', color: '#fff', fontSize: 11 }}>
                    {r.status}
                  </span>
                  <span className="cc-mono" style={{ fontSize: 12 }}>{new Date(r.scheduled_for).toLocaleString()}</span>
                  {r.reason && <span style={{ fontSize: 12 }}>{r.reason}</span>}
                  {r.error && <span style={{ fontSize: 12, color: '#dc2626' }}>{r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function GoalsTab() {
  const { toast } = useToast();
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [constraints, setConstraints] = useState('');
  const [projectId, setProjectId] = useState('');
  const [budget, setBudget] = useState('5');
  const [requireApproval, setRequireApproval] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [g, p] = await Promise.all([
        api<{ goals: GoalRow[] }>('/api/v1/scheduling/goals'),
        api<{ projects: Project[] }>('/api/v1/projects'),
      ]);
      setGoals(g.goals ?? []);
      setProjects(p.projects ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ goal: GoalRow }>('/api/v1/scheduling/goals', {
        method: 'POST',
        body: {
          title: title.trim(),
          objective: objective.trim(),
          successCriteria: successCriteria.split('\n').map((s) => s.trim()).filter(Boolean),
          constraints: constraints.split('\n').map((s) => s.trim()).filter(Boolean),
          projectId: projectId || null,
          budgetUsd: Number(budget) || undefined,
          requireApproval,
        },
      });
      setTitle('');
      setObjective('');
      setSuccessCriteria('');
      setConstraints('');
      setShowNew(false);
      await load();
      void generatePlan(res.goal.id);
      toast('Goal created');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const generatePlan = async (id: string) => {
    setPlanning(id);
    try {
      const res = await api<{ goal: GoalRow }>(`/api/v1/scheduling/goals/${id}/plan`, { method: 'POST', body: {} });
      setGoals((prev) => prev.map((g) => (g.id === id ? res.goal : g)));
      toast('Plan generated');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'plan failed', 'error');
    } finally {
      setPlanning(null);
    }
  };

  const action = async (id: string, path: string, okMsg: string) => {
    try {
      const res = await api<{ goal: GoalRow }>(`/api/v1/scheduling/goals/${id}/${path}`, { method: 'POST', body: {} });
      setGoals((prev) => prev.map((g) => (g.id === id ? res.goal : g)));
      toast(okMsg);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'action failed', 'error');
    }
  };

  const approve = async (id: string, decision: 'APPROVE' | 'REJECT') => {
    try {
      const res = await api<{ goal: GoalRow }>(`/api/v1/scheduling/goals/${id}/approve`, {
        method: 'POST',
        body: { decision },
      });
      setGoals((prev) => prev.map((g) => (g.id === id ? res.goal : g)));
      toast(decision === 'APPROVE' ? 'Goal approved' : 'Goal rejected');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'decision failed', 'error');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p className="cc-hint" style={{ margin: 0 }}>
          Goal mode: a plan is generated, approved when required, then executed step-by-step through the same bounded
          pipeline as manual tasks.
        </p>
        <button className="cc-btn" onClick={() => setShowNew((s) => !s)}>+ New goal</button>
      </div>

      {showNew && (
        <div className="cc-card">
          <div className="cc-field">
            <label htmlFor="goal-title">Title</label>
            <input id="goal-title" className="cc-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="cc-field">
            <label htmlFor="goal-objective">Objective</label>
            <textarea id="goal-objective" className="cc-textarea" rows={2} value={objective} onChange={(e) => setObjective(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="goal-criteria">Success criteria (one per line)</label>
              <textarea id="goal-criteria" className="cc-textarea" rows={3} value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} />
            </div>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="goal-constraints">Constraints (one per line)</label>
              <textarea id="goal-constraints" className="cc-textarea" rows={3} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="cc-field" style={{ flex: 1 }}>
              <label htmlFor="goal-project">Project</label>
              <select id="goal-project" className="cc-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="cc-field" style={{ width: 120 }}>
              <label htmlFor="goal-budget">Budget USD</label>
              <input id="goal-budget" className="cc-input" type="number" min={0.1} step={0.1} value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0' }} className="cc-hint">
            <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
            Require approval before executing
          </label>
          <button className="cc-btn" disabled={busy || !title.trim() || !objective.trim()} onClick={() => void create()}>
            Create goal
          </button>
        </div>
      )}

      {state === 'loading' && <div className="cc-card cc-empty">Loading goals…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load goals.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {state === 'ready' && goals.length === 0 && <div className="cc-card cc-empty">No goals yet — create one and the planner builds a step plan.</div>}

      {goals.map((g) => (
        <div className="cc-card" key={g.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h4 style={{ margin: 0 }}>
                {g.title}{' '}
                <span className="cc-pill" style={{ background: GOAL_STATE_COLORS[g.status] ?? '#334155', color: '#fff' }}>{g.status}</span>
              </h4>
              <p className="cc-hint" style={{ margin: '4px 0' }}>{g.objective}</p>
              <p className="cc-hint cc-mono" style={{ margin: '4px 0', fontSize: 12 }}>
                spent ${Number(g.spent_usd).toFixed(4)} / ${Number(g.budget_usd).toFixed(2)} · plan {g.plan.length} steps ·{' '}
                {g.deadline_at ? `deadline ${new Date(g.deadline_at).toLocaleString()}` : 'no deadline'}
              </p>
              {g.error && <p className="cc-hint" style={{ margin: '2px 0', color: '#dc2626' }}>{g.error}</p>}
              {g.plan.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {g.plan.map((e) => (
                    <div key={e.id} className="cc-hint" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                      <span className="cc-pill" style={{ fontSize: 11, background: e.risk === 'CRITICAL' || e.risk === 'HIGH' ? '#b45309' : '#0f766e', color: '#fff' }}>
                        {e.risk}
                      </span>
                      <span className="cc-pill" style={{ fontSize: 11 }}>{e.status}</span>
                      <span style={{ fontSize: 13 }}>{e.title}</span>
                      {e.error && <span style={{ fontSize: 12, color: '#dc2626' }}>{e.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              {['DRAFT', 'PLANNING', 'PLAN_READY'].includes(g.status) && (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" disabled={planning === g.id} onClick={() => void generatePlan(g.id)}>
                  {planning === g.id ? 'Planning…' : 'Generate plan'}
                </button>
              )}
              {g.status === 'PLAN_READY' && (
                <button className="cc-btn cc-btn--sm" onClick={() => void action(g.id, 'start', 'Goal started')}>Start</button>
              )}
              {g.status === 'WAITING_FOR_APPROVAL' && (
                <>
                  <button className="cc-btn cc-btn--sm" onClick={() => void approve(g.id, 'APPROVE')}>Approve</button>
                  <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void approve(g.id, 'REJECT')}>Reject</button>
                </>
              )}
              {g.status === 'RUNNING' && (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void action(g.id, 'pause', 'Goal paused')}>Pause</button>
              )}
              {g.status === 'PAUSED' && (
                <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void action(g.id, 'resume', 'Goal resumed')}>Resume</button>
              )}
              {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(g.status) && (
                <button className="cc-btn cc-btn--danger cc-btn--sm" onClick={() => void action(g.id, 'cancel', 'Goal cancelled')}>Cancel</button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EscalationsTab() {
  const { toast } = useToast();
  const [escalations, setEscalations] = useState<EscalationRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [issue, setIssue] = useState('');
  const [risk, setRisk] = useState('MEDIUM');
  const [recommendation, setRecommendation] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await api<{ escalations: EscalationRow[] }>('/api/v1/scheduling/escalations');
      setEscalations(res.escalations ?? []);
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      await api('/api/v1/scheduling/escalations', {
        method: 'POST',
        body: { issue: issue.trim(), risk, recommendation: recommendation.trim() || undefined },
      });
      setIssue('');
      setRecommendation('');
      await load();
      toast('Escalation raised');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'create failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, decision: 'APPROVE' | 'REJECT' | 'EDIT_PLAN' | 'RETRY' | 'PAUSE' | 'CANCEL') => {
    try {
      const res = await api<{ escalation: EscalationRow }>(`/api/v1/scheduling/escalations/${id}/decide`, {
        method: 'POST',
        body: { decision },
      });
      setEscalations((prev) => prev.map((e) => (e.id === id ? res.escalation : e)));
      toast(`Decision recorded: ${decision}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'decision failed', 'error');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p className="cc-hint" style={{ margin: 0 }}>
          Blocked or risky automation surfaces here for a human decision. Every decision is recorded with full audit.
        </p>
      </div>

      <div className="cc-card">
        <h4 style={{ margin: '0 0 8px' }}>Raise an escalation</h4>
        <div className="cc-field">
          <label htmlFor="esc-issue">Issue</label>
          <textarea id="esc-issue" className="cc-textarea" rows={2} value={issue} onChange={(e) => setIssue(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div className="cc-field">
            <label htmlFor="esc-risk">Risk</label>
            <select id="esc-risk" className="cc-select" value={risk} onChange={(e) => setRisk(e.target.value)}>
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
              <option value="CRITICAL">Critical</option>
            </select>
          </div>
          <div className="cc-field" style={{ flex: 1 }}>
            <label htmlFor="esc-rec">Recommended action (optional)</label>
            <input id="esc-rec" className="cc-input" value={recommendation} onChange={(e) => setRecommendation(e.target.value)} />
          </div>
        </div>
        <button className="cc-btn" disabled={busy || !issue.trim()} onClick={() => void create()}>Raise</button>
      </div>

      {state === 'loading' && <div className="cc-card cc-empty">Loading escalations…</div>}
      {state === 'error' && (
        <div className="cc-card cc-error-state">
          <p className="cc-hint">Could not load escalations.</p>
          <button className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {state === 'ready' && escalations.length === 0 && <div className="cc-card cc-empty">No escalations.</div>}

      {escalations.map((e) => (
        <div className="cc-card" key={e.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h4 style={{ margin: 0 }}>
                {e.issue}{' '}
                <span className="cc-pill" style={{ background: ESCALATION_COLORS[e.status] ?? '#334155', color: '#fff' }}>{e.status}</span>{' '}
                <span className="cc-pill" style={{ background: e.risk === 'CRITICAL' ? '#dc2626' : e.risk === 'HIGH' ? '#b45309' : '#0f766e', color: '#fff' }}>{e.risk}</span>
              </h4>
              {e.recommendation && <p className="cc-hint" style={{ margin: '4px 0' }}>Recommended: {e.recommendation}</p>}
              {e.attempted_actions.length > 0 && (
                <p className="cc-hint" style={{ margin: '2px 0' }}>Attempted: {e.attempted_actions.join(' · ')}</p>
              )}
              {e.options.length > 0 && (
                <p className="cc-hint" style={{ margin: '2px 0' }}>Options: {e.options.join(' · ')}</p>
              )}
              {e.user_decision && (
                <p className="cc-hint" style={{ margin: '2px 0' }}>
                  Decision: {e.user_decision}{e.decision_note ? ` — ${e.decision_note}` : ''}
                </p>
              )}
              <p className="cc-hint cc-mono" style={{ margin: '2px 0', fontSize: 11 }}>{new Date(e.created_at).toLocaleString()}</p>
            </div>
            {e.status === 'OPEN' && (
              <div style={{ display: 'flex', gap: 6, alignSelf: 'flex-start', flexWrap: 'wrap' }}>
                {(['APPROVE', 'RETRY', 'EDIT_PLAN', 'PAUSE', 'CANCEL', 'REJECT'] as const).map((d) => (
                  <button key={d} className="cc-btn cc-btn--ghost cc-btn--sm" onClick={() => void decide(e.id, d)}>{d}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}