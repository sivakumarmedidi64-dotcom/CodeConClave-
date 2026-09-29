/**
 * CodeConClave — First Win (Stage 26I): honest onboarding checklist.
 * The card shows real workspace state (projects, agents, task runs) fetched
 * from the API. Nothing is simulated: steps are checked only when the
 * server reports the corresponding records exist. "Set up demo" creates a
 * real project + agent through the normal APIs, then hands off to the agent
 * workspace.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';
import { useToast } from './Toast';
import { Icon } from './Icon';

interface FirstWinState {
  projects: number;
  agents: number;
  anyRun: boolean;
}

export function FirstWinCard() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [win, setWin] = useState<FirstWinState>({ projects: 0, agents: 0, anyRun: false });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const [p, a] = await Promise.all([
        api<{ projects: unknown[] }>('/api/v1/projects').catch(() => ({ projects: [] })),
        api<{ agents: Agent[] }>('/api/v1/agents').catch(() => ({ agents: [] })),
      ]);
      setWin({
        projects: (p.projects ?? []).length,
        agents: (a.agents ?? []).length,
        anyRun: (a.agents ?? []).some((x) => Number(x.total_tasks ?? 0) > 0),
      });
      setState('ready');
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const done = win.projects > 0 && win.agents > 0;
  if (state !== 'ready' || done) return null;

  const steps = [
    { label: 'Create your first project', done: win.projects > 0, to: '/projects' },
    { label: 'Create your first agent', done: win.agents > 0, to: '/agents' },
    { label: 'Run your first task', done: win.anyRun, to: '/agents' },
    { label: 'Watch it in the workspace', done: false, to: '/workspace' },
  ];

  const seedDemo = async () => {
    setBusy(true);
    try {
      await api('/api/v1/projects', {
        method: 'POST',
        body: { name: 'Demo Project', description: 'Seeded by the 60-second first win.' },
      });
      await api('/api/v1/agents', {
        method: 'POST',
        body: { name: 'Demo Coder', role: 'CODER', objective: 'Show what CodeConClave can do.', maxTasksPerRun: 3, maxRetries: 1 },
      });
      toast('Demo project + agent created — pick a task and run it');
      navigate('/agents');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'demo setup failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cc-card" data-testid="first-win">
      <h3 style={{ margin: 0 }}>Your 60-second first win</h3>
      <p className="cc-hint" style={{ margin: '6px 0' }}>
        Get from zero to a running agent in under a minute. Progress below is read from your real workspace — nothing
        is pre-checked.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '10px 0' }}>
        {steps.map((s) => (
          <button
            key={s.label}
            className="cc-hint"
            style={{ textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', gap: 8, alignItems: 'center' }}
            onClick={() => navigate(s.to)}
          >
            <span aria-hidden="true" style={{ color: s.done ? 'var(--cc-accent)' : 'var(--cc-text-muted)', fontWeight: 700, display: 'inline-flex' }}>
              <Icon name={s.done ? 'check' : 'sparkle'} size={12} />
            </span>
            <span style={{ textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--cc-text-muted)' : 'inherit' }}>
              {s.label}
            </span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="cc-btn" disabled={busy} onClick={() => void seedDemo()}>
          {busy ? 'Setting up…' : 'Set up a demo project'}
        </button>
        <button className="cc-btn cc-btn--ghost" onClick={() => navigate('/projects')}>Do it myself</button>
      </div>
    </div>
  );
}