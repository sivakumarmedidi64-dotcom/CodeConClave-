/**
 * CodeConClave — 24/7 autonomous project provisioning tests.
 * Verifies the wiring: when AIOS_P2_AUTONOMY=true a new project gets a
 * caretaker agent + recurring daily schedule; when disabled it is an inert
 * no-op; the kill switch and plan agent limits are respected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: { calls: { text: string; params: unknown[] }[]; rows: unknown[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = {
    calls: [],
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    return { rows: (state.resolve ? state.resolve(text, params) : null) ?? state.rows };
  };
  return {
    state,
    pool: { query },
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

const agents = vi.hoisted(() => ({
  listAgents: vi.fn(async () => []),
  createAgent: vi.fn(async (u: string, input: { name: string; role: string }) => ({ id: 'agt_caretaker', name: input.name, role: input.role })),
}));
vi.mock('../modules/agents/service.js', () => agents);

const scheduling = vi.hoisted(() => ({
  createSchedule: vi.fn(async (u: string, input: Record<string, unknown>) => ({ id: 'sch_autonomy', project_id: input.projectId, title: input.title })),
}));
vi.mock('../modules/scheduling/service.js', () => scheduling);

const killSwitch = vi.hoisted(() => ({ killSwitchActive: vi.fn(async () => false) }));
vi.mock('../modules/control/killSwitch.js', () => killSwitch);

const autonomyConfig = vi.hoisted(() => ({ enabled: false, role: 'ARCHITECT', taskTitle: '24/7 autonomous upkeep' }));
vi.mock('../modules/autonomy/config.js', () => ({
  autonomyEnabled: () => autonomyConfig.enabled,
  AUTONOMY_CARETAKER_ROLE: autonomyConfig.role,
  AUTONOMY_CARETAKER_TASK_TITLE: autonomyConfig.taskTitle,
}));

import { provisionAutonomousProject, listProjectAutonomyStatus } from '../modules/autonomy/provision.js';

const USER = 'usr_aut1';
const PROJECT = 'prj_24x7';

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.resolve = null;
  audit.recordAudit.mockClear();
  agents.listAgents.mockClear();
  agents.createAgent.mockClear();
  scheduling.createSchedule.mockClear();
  killSwitch.killSwitchActive.mockClear();
  autonomyConfig.enabled = false;
});

afterEach(() => {
  db.state.resolve = null;
});

describe('provisionAutonomousProject — with autonomy OFF', () => {
  it('is an inert no-op: no DB writes, no agents, no schedules', async () => {
    const result = await provisionAutonomousProject(USER, PROJECT, 'My App');
    expect(result).toEqual({ provisioned: false, reason: 'autonomy_disabled' });
    expect(db.state.calls).toHaveLength(0);
    expect(agents.createAgent).not.toHaveBeenCalled();
    expect(scheduling.createSchedule).not.toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.autonomy_provision_skipped', resourceId: PROJECT }),
    );
  });
});

describe('provisionAutonomousProject — with autonomy ON', () => {
  beforeEach(() => {
    autonomyConfig.enabled = true;
  });

  it('creates a caretaker agent and a recurring daily schedule', async () => {
    const result = await provisionAutonomousProject(USER, PROJECT, 'My App');
    expect(result.provisioned).toBe(true);
    expect(result.reason).toBe('provisioned');
    expect(result.scheduleId).toBe('sch_autonomy');
    expect(result.agentId).toBe('agt_caretaker');

    expect(agents.listAgents).toHaveBeenCalledWith(USER);
    expect(agents.createAgent).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ name: 'My App caretaker', role: 'ARCHITECT', trustLevel: 'L1' }),
    );
    expect(scheduling.createSchedule).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ projectId: PROJECT, agentId: 'agt_caretaker', recurrence: 'DAILY' }),
    );
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.autonomy_provisioned', resourceId: PROJECT }),
    );
  });

  it('reuses an existing caretaker agent instead of creating a duplicate', async () => {
    agents.listAgents.mockResolvedValueOnce([{ id: 'agt_existing', name: 'My App caretaker', role: 'ARCHITECT' }]);
    const result = await provisionAutonomousProject(USER, PROJECT, 'My App');
    expect(result.provisioned).toBe(true);
    expect(result.agentId).toBe('agt_existing');
    expect(agents.createAgent).not.toHaveBeenCalled();
    expect(scheduling.createSchedule).toHaveBeenCalled();
  });

  it('respects the kill switch (SCHEDULES scope)', async () => {
    killSwitch.killSwitchActive.mockResolvedValueOnce(true);
    const result = await provisionAutonomousProject(USER, PROJECT, 'My App');
    expect(result).toEqual({ provisioned: false, reason: 'kill_switch_suspended' });
    expect(agents.createAgent).not.toHaveBeenCalled();
  });

  it('respects the plan agent limit', async () => {
    agents.createAgent.mockRejectedValueOnce(Object.assign(new Error('plan limit'), { errorCode: 'agent_limit_reached', status: 400 }));
    const result = await provisionAutonomousProject(USER, PROJECT, 'My App');
    expect(result).toEqual({ provisioned: false, reason: 'agent_limit_reached' });
    expect(scheduling.createSchedule).not.toHaveBeenCalled();
  });
});

describe('listProjectAutonomyStatus', () => {
  it('lists schedules for the project', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    db.state.rows = [
      { id: 'sch_1', title: 'My App — 24/7 autonomous upkeep', enabled: true, next_run_at: now, last_run_at: null },
    ];
    const status = await listProjectAutonomyStatus(USER, PROJECT);
    expect(status.schedules).toHaveLength(1);
    expect(status.schedules[0]!.idle).toBe(true);
    const call = db.state.calls.find((c) => c.text.includes('FROM scheduled_tasks'));
    expect(call!.params).toEqual([USER, PROJECT]);
  });
});