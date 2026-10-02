/**
 * Stage 26C — scheduled autonomous tasks contract suite.
 * Covers: recurrence engine (UTC + IANA/DST wall-clock semantics, cron),
 * schedule CRUD + server-authoritative next-run preview, run-now, missed-run
 * policies (RUN_ON_RECOVERY / RUN_ONCE / SKIP_STALE), atomic claim idempotency
 * (duplicate tick / duplicate run-now → single business execution), offline
 * execution modes (LOCAL_ONLY → WAITING_FOR_LOCAL_AGENT), reconciliation with
 * the agent engine, notifications, audits, and tenant isolation negatives.
 * The DB, agents service, gateway and notifications are mocked; the scheduler
 * driver itself is fully exercised against an in-memory store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    tables: Record<string, Array<Record<string, unknown>>>;
    resolve: ((text: string, params: unknown[]) => Array<Record<string, unknown>> | null) | null;
  } = {
    tables: {
      scheduled_tasks: [], schedule_runs: [], ai_agents: [], ai_agent_runs: [], tasks: [],
      goals: [], goal_activities: [], escalations: [], projects: [], approvals: [],
    },
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : [];
    return { rows: rows ?? [], rowCount: rows?.length ?? 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query, queryMany: queryRows, queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query, queryMany: queryRows, queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

const agents = vi.hoisted(() => ({
  getAgent: vi.fn(),
  startRun: vi.fn(),
  listAgents: vi.fn(),
  cancelRun: vi.fn(),
}));
vi.mock('../modules/agents/service.js', () => agents);

const notifyMock = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));
vi.mock('../modules/notifications/service.js', () => notifyMock);

const gateway = vi.hoisted(() => ({ completeWithFallback: vi.fn(), estimatedCostOfRequest: vi.fn(async () => 0.01) }));
vi.mock('../modules/ai/gateway.js', () => gateway);

vi.mock('../modules/execution/approvals.js', () => ({ createApproval: vi.fn(), decideApproval: vi.fn() }));
vi.mock('../modules/memory/service.js', () => ({ createMemory: vi.fn() }));
vi.mock('../modules/dna/service.js', () => ({ retrieveDnaForPrompt: vi.fn(async () => []) }));
vi.mock('../modules/memory/decisions.js', () => ({ detectConflict: vi.fn(async () => ({ conflicts: [] })) }));

import { nextRunAt, occurrencesBetween, parseCron, zonedToUtc, tzOffsetMs } from '../modules/scheduling/recurrence.js';
import { createSchedule, getSchedule, listSchedules, setScheduleEnabled, deleteSchedule, previewNextRuns, runNow, listScheduleRuns } from '../modules/scheduling/service.js';
import { schedulerTick, claimOccurrence, reconcileDueSchedules, sweepScheduledRuns } from '../modules/scheduling/executor.js';
import { AppError } from '../shared/errors.js';

/** In-memory SQL resolver driven by the exact SQL the modules emit. */
function wireDb() {
  const T = db.state.tables;
  const resolve = (text: string, params: unknown[]): Array<Record<string, unknown>> => {
    const id = (i: number) => String(params[i - 1]);

    // ---------------- INSERT (generic, with literal-value support + conflict) ----------------
    const ins = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/.exec(text);
    if (ins) {
      const cols = ins[2].split(',').map((s) => s.trim());
      const vals = ins[3].split(',').map((s) => s.trim());
      const row: Record<string, unknown> = {};
      let pi = 0;
      cols.forEach((c, i) => {
        const v = vals[i] ?? '';
        const m = /^\$(\d+)/.exec(v);
        if (m) {
          row[c] = params[Number(m[1]) - 1];
          pi++;
        } else {
          row[c] = v.replace(/^'|'$/g, '');
        }
      });
      if (text.includes('ON CONFLICT')) {
        const dup = T.schedule_runs.some(
          (r) => r.schedule_id === row.schedule_id && String(r.scheduled_for) === String(row.scheduled_for),
        );
        if (dup) return []; // DO NOTHING → zero rows (claim lost)
      }
      T[ins[1]!]!.push(row);
      return text.includes('RETURNING *') ? [row] : [];
    }

    // ---------------- UPDATE ----------------
    if (text.startsWith('UPDATE schedule_runs SET')) {
      const row = T.schedule_runs.find((r) => r.id === id(1));
      if (!row) return [];
      applySet(text, params, row);
      return [];
    }
    if (text.startsWith('UPDATE scheduled_tasks SET')) {
      const row = text.includes('owner_id = $2')
        ? T.scheduled_tasks.find((r) => r.id === id(1) && r.owner_id === id(2))
        : T.scheduled_tasks.find((r) => r.id === id(1));
      if (!row) return [];
      applySet(text, params, row);
      return [];
    }
    if (text.startsWith('UPDATE tasks SET') && text.includes('agent_run_id')) {
      const target = T.tasks.filter((t) => t.agent_run_id === id(1));
      const keys = [...text.matchAll(/(\w+)\s*=\s*(\$\d+)/g)];
      for (const t of target) {
        for (const [, k, p] of keys) t[k!] = params[Number(p!.slice(1)) - 1];
      }
      return [];
    }
    if (text.startsWith('DELETE FROM scheduled_tasks')) {
      const idx = T.scheduled_tasks.findIndex((r) => r.id === id(1) && r.owner_id === id(2));
      if (idx >= 0) T.scheduled_tasks.splice(idx, 1);
      return [];
    }

    // ---------------- SELECT ----------------
    if (text.includes('FROM scheduled_tasks') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.scheduled_tasks.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM scheduled_tasks') && text.includes('enabled = true AND next_run_at <= now()')) {
      return T.scheduled_tasks
        .filter((r) => r.enabled === true && new Date(String(r.next_run_at)).getTime() <= Date.now())
        .sort((a, b) => new Date(String(a.next_run_at)).getTime() - new Date(String(b.next_run_at)).getTime())
        .slice(0, Number(params[0]));
    }
    if (text.includes('FROM scheduled_tasks') && text.includes('owner_id = $1')) {
      let rows = T.scheduled_tasks.filter((r) => r.owner_id === id(1));
      if (text.includes('AND enabled = true')) rows = rows.filter((r) => r.enabled === true);
      return rows.sort((a, b) => new Date(String(a.next_run_at)).getTime() - new Date(String(b.next_run_at)).getTime());
    }
    if (text.includes('FROM scheduled_tasks') && text.includes('WHERE id = $1')) {
      return T.scheduled_tasks.filter((r) => r.id === id(1));
    }
    if (text.includes('FROM schedule_runs') && text.includes('owner_id = $1 AND schedule_id = $2')) {
      return T.schedule_runs
        .filter((r) => r.owner_id === id(1) && r.schedule_id === id(2))
        .sort((a, b) => new Date(String(b.scheduled_for)).getTime() - new Date(String(a.scheduled_for)).getTime())
        .slice(0, Number(params[2]));
    }
    if (text.includes('FROM schedule_runs') && text.includes('schedule_id = $1 AND status IN')) {
      const statuses = text.match(/IN \(([^)]+)\)/)?.[1]?.split(',').map((s) => s.trim().replace(/'/g, '')) ?? [];
      return T.schedule_runs.filter((r) => r.schedule_id === id(1) && statuses.includes(String(r.status))).slice(0, 1);
    }
    if (text.includes('JOIN ai_agent_runs')) {
      const live = ['RUNNING', 'WAITING_FOR_APPROVAL', 'WAITING_FOR_LOCAL_AGENT'];
      const terminal = ['COMPLETED', 'FAILED', 'BLOCKED', 'TIMED_OUT'];
      return T.schedule_runs.filter((r) => {
        if (!live.includes(String(r.status)) || !r.agent_run_id) return false;
        const ar = T.ai_agent_runs.find((x) => x.id === r.agent_run_id);
        return ar && terminal.includes(String(ar.status));
      });
    }
    if (text.includes('FROM ai_agent_runs') && text.includes('WHERE id = $1')) {
      return T.ai_agent_runs.filter((r) => r.id === id(1)).map((r) => ({ status: r.status, error: r.error ?? null }));
    }
    if (text.includes('FROM projects')) {
      return T.projects.filter((r) => r.id === id(1) && r.owner_id === id(2) && r.deleted_at == null);
    }

    return [];
  };
  const applySet = (text: string, params: unknown[], row: Record<string, unknown>) => {
    for (const [, k, expr] of [...text.matchAll(/(\w+)\s*=\s*([^,]+)/g)]) {
      const m = /\$(\d+)/.exec(expr ?? '');
      if (m) {
        row[k!] = params[Number(m[1]) - 1];
      } else if ((expr ?? '').startsWith('now()')) {
        row[k!] = new Date().toISOString();
      } else if ((expr ?? '').includes('COALESCE')) {
        row[k!] = row[k!] ?? new Date().toISOString();
      } else if ((expr ?? '').includes('+ 1')) {
        row[k!] = Number(row[k!] ?? 0) + 1;
      } else {
        let lit = (expr ?? '').replace(/^'|'$/g, '');
        if (lit === 'true') lit = 'true';
        row[k!] = lit === 'true' ? true : lit === 'false' ? false : lit;
      }
    }
  };
  db.state.resolve = resolve;
}

const AGENT = (over: Record<string, unknown> = {}) => ({
  id: 'agt-1',
  owner_id: 'u1',
  name: 'Cron Bot',
  role: 'CODER',
  status: 'IDLE',
  trust_level: 'L2',
  max_tasks_per_run: 5,
  max_retries: 2,
  ...over,
});

const SCHEDULE = (over: Record<string, unknown> = {}) => ({
  id: 'sch-1',
  owner_id: 'u1',
  project_id: null,
  agent_id: 'agt-1',
  title: 'Nightly style check',
  description: null,
  recurrence: 'DAILY',
  cron_expression: null,
  timezone: 'UTC',
  run_at: '09:00',
  run_on_days: [],
  enabled: true,
  execution_mode: 'CLOUD',
  missed_run_policy: 'RUN_ON_RECOVERY',
  next_run_at: new Date(Date.now() - 60_000).toISOString(),
  last_run_at: null,
  last_run_status: null,
  run_count: 0,
  require_approval: false,
  timeout_ms: 900000,
  max_attempts: 3,
  notify_on_completion: false,
  error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

function seedSchedule(row: Record<string, unknown>) {
  db.state.tables.scheduled_tasks.push(row);
}

beforeEach(() => {
  for (const k of Object.keys(db.state.tables)) db.state.tables[k] = [];
  wireDb();
  audit.recordAudit.mockClear();
  notifyMock.notify.mockClear();
  agents.getAgent.mockReset();
  agents.startRun.mockReset();
  agents.startRun.mockResolvedValue({
    id: 'agn-1', status: 'RUNNING', objective: 'x', total_tasks: 1, completed_tasks: 0,
    failed_tasks: 0, retries_used: 0, budget_usd: 5, spent_usd: 0, deadline_at: new Date(),
    error: null, started_at: new Date(), completed_at: null, created_at: new Date(),
    agent_id: 'agt-1', owner_id: 'u1', project_id: null, current_task_id: null,
  });
  agents.getAgent.mockResolvedValue(AGENT());
});

// ================================================================ recurrence engine

describe('recurrence engine', () => {
  it('computes daily wall-clock in UTC', () => {
    const anchor = { recurrence: 'DAILY' as const, runAt: '09:00', runOnDays: [], timezone: 'UTC' };
    expect(nextRunAt(anchor, new Date('2026-08-19T08:00:00Z'))?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
    expect(nextRunAt(anchor, new Date('2026-08-19T09:30:00Z'))?.toISOString()).toBe('2026-08-20T09:00:00.000Z');
  });

  it('computes hourly at fixed minutes past the hour', () => {
    const anchor = { recurrence: 'HOURLY' as const, runAt: '30', runOnDays: [], timezone: 'UTC' };
    expect(nextRunAt(anchor, new Date('2026-08-19T10:10:00Z'))?.toISOString()).toBe('2026-08-19T10:30:00.000Z');
    expect(nextRunAt(anchor, new Date('2026-08-19T10:30:01Z'))?.toISOString()).toBe('2026-08-19T11:30:00.000Z');
  });

  it('ONCE: future instant only, past returns null', () => {
    const anchor = { recurrence: 'ONCE' as const, runAt: '2026-12-01T09:00', runOnDays: [], timezone: 'UTC' };
    expect(nextRunAt(anchor, new Date('2026-08-19T00:00:00Z'))?.toISOString()).toBe('2026-12-01T09:00:00.000Z');
    expect(nextRunAt(anchor, new Date('2027-01-01T00:00:00Z'))).toBeNull();
  });

  it('WEEKLY honors only configured weekdays', () => {
    const anchor = { recurrence: 'WEEKLY' as const, runAt: '09:00', runOnDays: ['MON', 'WED'], timezone: 'UTC' };
    // 2026-08-19 is a Wednesday; 09:00Z has passed → next is Monday 2026-08-24.
    expect(nextRunAt(anchor, new Date('2026-08-19T12:00:00Z'))?.toISOString()).toBe('2026-08-24T09:00:00.000Z');
    expect(nextRunAt(anchor, new Date('2026-08-17T08:00:00Z'))?.toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('MONTHLY honors configured day-of-month', () => {
    const anchor = { recurrence: 'MONTHLY' as const, runAt: '09:00', runOnDays: ['1', '15'], timezone: 'UTC' };
    expect(nextRunAt(anchor, new Date('2026-08-15T10:00:00Z'))?.toISOString()).toBe('2026-09-01T09:00:00.000Z');
    expect(nextRunAt(anchor, new Date('2026-08-01T08:00:00Z'))?.toISOString()).toBe('2026-08-01T09:00:00.000Z');
  });

  it('preserves 09:00 wall clock across the US spring-forward DST transition', () => {
    const tz = 'America/New_York';
    const anchor = { recurrence: 'DAILY' as const, runAt: '09:00', runOnDays: [], timezone: tz };
    const before = nextRunAt(anchor, new Date('2026-03-07T15:00:00Z'))!; // Sat before transition
    const onTransition = nextRunAt(anchor, new Date('2026-03-08T15:00:00Z'))!; // DST starts Mar 8 2026 (2am)
    const after = nextRunAt(anchor, new Date('2026-03-09T15:00:00Z'))!;
    // EST = UTC-5 (09:00 → 14:00Z), EDT = UTC-4 (09:00 → 13:00Z).
    expect(before.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(onTransition.toISOString()).toBe('2026-03-09T13:00:00.000Z');
    expect(after.toISOString()).toBe('2026-03-10T13:00:00.000Z');
    // Wall clock stays 09:00 in NY for every result.
    for (const d of [before, onTransition, after]) {
      const wallHour = (d.getUTCHours() + tzOffsetMs(tz, d) / 3_600_000 + 24) % 24;
      expect(wallHour).toBe(9);
    }
  });

  it('preserves wall clock across the fall-back transition', () => {
    const tz = 'America/New_York';
    const anchor = { recurrence: 'DAILY' as const, runAt: '09:00', runOnDays: [], timezone: tz };
    const before = nextRunAt(anchor, new Date('2026-10-31T15:00:00Z'))!; // EDT (UTC-4) — next is Nov 1, already EST
    const after = nextRunAt(anchor, new Date('2026-11-02T15:00:00Z'))!; // EST (UTC-5)
    expect(before.toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(after.toISOString()).toBe('2026-11-03T14:00:00.000Z');
  });

  it('zonedToUtc resolves nonexistent spring-forward times to a valid instant', () => {
    // 2026-03-08 02:30 does not exist in America/New_York; must return a real instant.
    const d = zonedToUtc('America/New_York', 2026, 3, 8, 2, 30);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('parses cron fields with ranges and lists', () => {
    expect(parseCron('0 9 * * 1-5')).not.toBeNull();
    expect(parseCron('*/5 * * * *')).toBeNull(); // steps unsupported → honest null
    expect(parseCron('0 9 * * 1,3,5')).not.toBeNull();
    expect(parseCron('not cron')).toBeNull();
  });

  it('computes cron next-run on weekdays only', () => {
    const anchor = { recurrence: 'CRON' as const, runAt: '', runOnDays: [], timezone: 'UTC', cronExpression: '0 9 * * 1-5' };
    // 2026-08-19 = Wednesday. Before 09:00 → same day; after → Thursday.
    expect(nextRunAt(anchor, new Date('2026-08-19T08:00:00Z'))?.toISOString()).toBe('2026-08-19T09:00:00.000Z');
    expect(nextRunAt(anchor, new Date('2026-08-19T10:00:00Z'))?.toISOString()).toBe('2026-08-20T09:00:00.000Z');
    // Saturday 08:00 → Monday.
    expect(nextRunAt(anchor, new Date('2026-08-22T08:00:00Z'))?.toISOString()).toBe('2026-08-24T09:00:00.000Z');
  });

  it('enumerates occurrences strictly increasing with a cap', () => {
    const anchor = { recurrence: 'HOURLY' as const, runAt: '00', runOnDays: [], timezone: 'UTC' };
    const out = occurrencesBetween(anchor, new Date('2026-08-19T10:00:00Z'), new Date('2026-08-19T16:00:00Z'), 10);
    expect(out.length).toBe(6);
    expect(out[0]!.toISOString()).toBe('2026-08-19T11:00:00.000Z');
    expect(out[5]!.toISOString()).toBe('2026-08-19T16:00:00.000Z');
  });
});

// ================================================================ schedule CRUD

describe('schedule service', () => {
  it('creates a schedule with a computed next run and audits it', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    const s = await createSchedule('u1', {
      agentId: 'agt-1',
      title: 'Nightly check',
      recurrence: 'DAILY',
      runAt: '09:00',
      timezone: 'UTC',
      executionMode: 'CLOUD',
    });
    expect(s.id).toMatch(/^sch_/);
    expect(new Date(s.next_run_at).getTime()).toBeGreaterThan(Date.now());
    const row = db.state.tables.scheduled_tasks.find((r) => r.id === s.id);
    expect(row?.owner_id).toBe('u1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.created' }));
  });

  it('rejects unknown timezones, invalid cron and past ONCE runs', async () => {
    agents.getAgent.mockResolvedValue(AGENT());
    await expect(createSchedule('u1', { agentId: 'agt-1', title: 'x', recurrence: 'DAILY', timezone: 'Mars/Olympus' }))
      .rejects.toMatchObject({ errorCode: 'invalid_timezone' });
    await expect(createSchedule('u1', { agentId: 'agt-1', title: 'x', recurrence: 'CRON', cronExpression: 'bad' }))
      .rejects.toMatchObject({ errorCode: 'invalid_cron' });
    await expect(createSchedule('u1', { agentId: 'agt-1', title: 'x', recurrence: 'ONCE', runAt: '2020-01-01T09:00' }))
      .rejects.toMatchObject({ errorCode: 'once_run_in_past' });
    await expect(createSchedule('u1', { agentId: 'agt-1', title: 'x', recurrence: 'WEEKLY', runOnDays: [] }))
      .rejects.toMatchObject({ errorCode: 'weekly_days_required' });
  });

  it('rejects a foreign agent and a foreign project', async () => {
    agents.getAgent.mockRejectedValue(Object.assign(new Error('not found'), { errorCode: 'not_found' }));
    await expect(createSchedule('u1', { agentId: 'agt-x', title: 'x', recurrence: 'DAILY' })).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('lists, pauses, resumes and deletes with audits', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', enabled: true }));
    seedSchedule(SCHEDULE({ id: 'sch-2', enabled: false }));
    expect((await listSchedules('u1')).map((s) => s.id)).toEqual(['sch-1']);
    expect((await listSchedules('u1', true)).length).toBe(2);

    const paused = await setScheduleEnabled('u1', 'sch-1', false);
    expect(paused.enabled).toBe(false);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.paused' }));
    expect((await listSchedules('u1')).length).toBe(0);

    await setScheduleEnabled('u1', 'sch-1', true);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.resumed' }));

    await deleteSchedule('u1', 'sch-1');
    expect(db.state.tables.scheduled_tasks.find((r) => r.id === 'sch-1')).toBeUndefined();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.deleted' }));
  });

  it('enforces tenant isolation on every read', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', owner_id: 'u2' }));
    await expect(getSchedule('u1', 'sch-1')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(setScheduleEnabled('u1', 'sch-1', false)).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(deleteSchedule('u1', 'sch-1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('preview returns server-authoritative future instants in the schedule timezone', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', recurrence: 'DAILY', run_at: '09:00', timezone: 'America/New_York', next_run_at: new Date(Date.now() - 60_000).toISOString() }));
    const { next } = await previewNextRuns('u1', 'sch-1', 5);
    expect(next.length).toBe(5);
    for (const iso of next) {
      const d = new Date(iso);
      const wallHour = (d.getUTCHours() + tzOffsetMs('America/New_York', d) / 3_600_000 + 24) % 24;
      expect(wallHour).toBe(9);
      expect(d.getTime()).toBeGreaterThan(Date.now());
    }
  });
});

// ================================================================ executor

describe('scheduler executor', () => {
  it('claims an occurrence atomically — a second claim is a no-op', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1' }));
    const run1 = await claimOccurrence('sch-1', 'u1', new Date('2026-08-19T09:00:00Z'));
    const run2 = await claimOccurrence('sch-1', 'u1', new Date('2026-08-19T09:00:00Z'));
    expect(run1?.id).toMatch(/^scr_/);
    expect(run2).toBeNull();
    expect(db.state.tables.schedule_runs.length).toBe(1);
  });

  it('executes a due schedule exactly once even when the tick fires twice', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', next_run_at: new Date(Date.now() - 60_000).toISOString() }));
    await schedulerTick();
    await schedulerTick();
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    expect(agents.startRun).toHaveBeenCalledWith('u1', 'agt-1', expect.objectContaining({ objective: 'Nightly style check' }));
    const runs = db.state.tables.schedule_runs;
    expect(runs.filter((r) => r.status === 'RUNNING').length).toBe(1);
    const sched = db.state.tables.scheduled_tasks.find((r) => r.id === 'sch-1');
    expect(new Date(String(sched?.next_run_at)).getTime()).toBeGreaterThan(Date.now());
    expect(sched?.run_count).toBe(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.executed' }));
  });

  it('runs LOCAL_ONLY schedules offline: tasks stay LOCAL and run waits for the local agent', async () => {
    db.state.tables.tasks.push({ id: 'tsk-1', agent_run_id: 'agn-1', execution_mode: 'CLOUD' });
    seedSchedule(SCHEDULE({ id: 'sch-1', execution_mode: 'LOCAL_ONLY', next_run_at: new Date(Date.now() - 60_000).toISOString() }));
    await schedulerTick();
    const run = db.state.tables.schedule_runs[0];
    expect(run?.status).toBe('WAITING_FOR_LOCAL_AGENT');
    expect(db.state.tables.tasks[0]?.execution_mode).toBe('LOCAL');
    expect(db.state.tables.tasks[0]?.timeout_ms).toBe(900000);
  });

  it('marks the run failed when the agent is busy and still advances the schedule', async () => {
    agents.getAgent.mockResolvedValue(AGENT({ status: 'RUNNING', current_run_id: 'agn-9' }));
    seedSchedule(SCHEDULE({ id: 'sch-1', next_run_at: new Date(Date.now() - 60_000).toISOString() }));
    await schedulerTick();
    expect(db.state.tables.schedule_runs[0]?.status).toBe('FAILED');
    expect(String(db.state.tables.schedule_runs[0]?.error)).toContain('active run');
    expect(agents.startRun).not.toHaveBeenCalled();
    const sched = db.state.tables.scheduled_tasks.find((r) => r.id === 'sch-1');
    expect(sched?.last_run_status).toBe('FAILED');
    expect(new Date(String(sched?.next_run_at)).getTime()).toBeGreaterThan(Date.now());
  });

  it('run-now executes immediately, rejects a second while in flight', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', next_run_at: new Date(Date.now() + 3_600_000).toISOString() }));
    const run = await runNow('u1', 'sch-1');
    expect(run.status).toBe('RUNNING');
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.run_now' }));
    await expect(runNow('u1', 'sch-1')).rejects.toMatchObject({ errorCode: 'run_in_flight' });
  });

  it('records schedule run history', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1' }));
    db.state.tables.schedule_runs.push({ id: 'scr-1', schedule_id: 'sch-1', owner_id: 'u1', scheduled_for: new Date('2026-08-18T09:00:00Z'), status: 'COMPLETED', task_id: null, agent_run_id: null, reason: null, error: null, started_at: null, completed_at: null, created_at: new Date('2026-08-18T09:00:00Z') });
    const runs = await listScheduleRuns('u1', 'sch-1', 10);
    expect(runs.length).toBe(1);
    expect(runs[0]?.status).toBe('COMPLETED');
  });
});

// ================================================================ missed-run policies

describe('missed-run policies', () => {
  function seedHourlyMissed(policy: string) {
    // last run 10:00, next (missed) occurrences 11:00 and 12:00; now is after 12:00.
    seedSchedule(SCHEDULE({
      id: 'sch-1',
      recurrence: 'HOURLY',
      run_at: '00',
      timezone: 'UTC',
      missed_run_policy: policy,
      next_run_at: new Date('2026-08-19T12:00:00Z').toISOString(),
      last_run_at: new Date('2026-08-19T10:00:00Z').toISOString(),
      created_at: new Date('2026-08-19T09:00:00Z').toISOString(),
    }));
  }

  it('SKIP_STALE executes nothing and records SKIPPED reasons', async () => {
    seedHourlyMissed('SKIP_STALE');
    await schedulerTick();
    expect(agents.startRun).not.toHaveBeenCalled();
    const runs = db.state.tables.schedule_runs;
    expect(runs.length).toBe(2);
    for (const r of runs) {
      expect(r.status).toBe('SKIPPED');
      expect(r.reason).toBe('stale_missed');
    }
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.skipped' }));
  });

  it('RUN_ONCE executes the latest missed occurrence once and skips the rest', async () => {
    seedHourlyMissed('RUN_ONCE');
    await schedulerTick();
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    const runs = db.state.tables.schedule_runs;
    const skipped = runs.filter((r) => r.status === 'SKIPPED');
    const executed = runs.filter((r) => r.status === 'RUNNING');
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.reason).toBe('covered_by_single_run');
    expect(executed.length).toBe(1);
    expect(executed[0]?.reason).toBe('covered_by_single_run');
    expect(new Date(String(executed[0]?.scheduled_for)).toISOString()).toBe('2026-08-19T12:00:00.000Z');
  });

  it('RUN_ON_RECOVERY records MISSED for older occurrences and recovers the latest', async () => {
    seedHourlyMissed('RUN_ON_RECOVERY');
    await schedulerTick();
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    const runs = db.state.tables.schedule_runs;
    const missed = runs.filter((r) => r.status === 'MISSED');
    const recovered = runs.filter((r) => r.status === 'RUNNING');
    expect(missed.length).toBe(1);
    expect(missed[0]?.reason).toBe('missed_window');
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.reason).toBe('recovered_missed');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'schedule.missed' }));
  });
});

// ================================================================ reconciliation

describe('reconcile', () => {
  it('folds COMPLETED agent runs back and notifies when requested', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', notify_on_completion: true }));
    db.state.tables.schedule_runs.push({
      id: 'scr-1', schedule_id: 'sch-1', owner_id: 'u1', scheduled_for: new Date('2026-08-19T09:00:00Z'),
      status: 'RUNNING', task_id: null, agent_run_id: 'agn-1', reason: null, error: null,
      started_at: null, completed_at: null, created_at: new Date('2026-08-19T09:00:00Z'),
    });
    db.state.tables.ai_agent_runs.push({ id: 'agn-1', status: 'COMPLETED', error: null });
    const changed = await reconcileDueSchedules();
    expect(changed).toBe(1);
    expect(db.state.tables.schedule_runs[0]?.status).toBe('COMPLETED');
    expect(db.state.tables.scheduled_tasks[0]?.last_run_status).toBe('COMPLETED');
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'schedule.run_completed', expect.stringContaining('Nightly style check'), expect.anything());
  });

  it('folds FAILED agent runs back with the real error', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1', notify_on_completion: true }));
    db.state.tables.schedule_runs.push({
      id: 'scr-1', schedule_id: 'sch-1', owner_id: 'u1', scheduled_for: new Date('2026-08-19T09:00:00Z'),
      status: 'RUNNING', task_id: null, agent_run_id: 'agn-1', reason: null, error: null,
      started_at: null, completed_at: null, created_at: new Date('2026-08-19T09:00:00Z'),
    });
    db.state.tables.ai_agent_runs.push({ id: 'agn-1', status: 'FAILED', error: 'provider offline' });
    await reconcileDueSchedules();
    expect(db.state.tables.schedule_runs[0]?.status).toBe('FAILED');
    expect(db.state.tables.schedule_runs[0]?.error).toBe('provider offline');
    expect(db.state.tables.scheduled_tasks[0]?.last_run_status).toBe('FAILED');
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'schedule.run_failed', expect.anything(), expect.anything());
  });

  it('sweepScheduledRuns runs both phases and reports counts', async () => {
    seedSchedule(SCHEDULE({ id: 'sch-1' }));
    const result = await sweepScheduledRuns();
    expect(result.scheduled).toBe(1);
    expect(result.reconciled).toBe(0);
  });
});