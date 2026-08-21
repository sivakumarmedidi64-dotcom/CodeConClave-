/**
 * Stage 26D — event automation + smart escalation + workflow recipes contract suite.
 * Covers: rule CRUD + lifecycle, event ingestion with global replay protection
 * (event_log UNIQUE source+event_id) and per-rule idempotency (automation_runs
 * UNIQUE automation_id+event_id), condition evaluation + template interpolation,
 * action dispatch through the REAL startRun/createTask/runNow/executePluginAction
 * pipeline, approval routing, loop protection (max_runs_per_hour + cooldown),
 * smart escalation (plugin_unavailable / dependency_failure / blocked_permission
 * classification, dedup, decisions: RETRY/APPROVE/PAUSE/REJECT/CANCEL routing),
 * workflow recipes (seed idempotency, instantiate with placeholder validation),
 * webhook authentication (GitHub HMAC-SHA256, Sentry HMAC, bearer tokens,
 * signature invalid → audit, disabled secrets rejected, unregistered repo → null),
 * task/schedule emit hooks, tenant isolation negatives, and the watchdog sweep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';

const db = vi.hoisted(() => {
  const state: {
    tables: Record<string, Array<Record<string, unknown>>>;
    resolve: ((text: string, params: unknown[]) => Array<Record<string, unknown>> | null) | null;
  } = {
    tables: {
      automation_rules: [], automation_runs: [], event_log: [], escalations: [], workflow_recipes: [],
      webhook_secrets: [], ai_agents: [], ai_agent_runs: [], tasks: [], projects: [], scheduled_tasks: [], schedule_runs: [],
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

const approvals = vi.hoisted(() => ({
  createApproval: vi.fn(async () => ({ id: 'apr-1' })),
  decideApproval: vi.fn(async () => {}),
}));
vi.mock('../modules/execution/approvals.js', () => approvals);

const plugins = vi.hoisted(() => ({ executePluginAction: vi.fn() }));
vi.mock('../modules/plugins/engine.js', () => plugins);

const scheduling = vi.hoisted(() => ({ runNow: vi.fn(async () => ({ id: 'srun-1' })), setScheduleEnabled: vi.fn(async () => ({ id: 'sch-1' })) }));
vi.mock('../modules/scheduling/service.js', () => scheduling);

const execTasks = vi.hoisted(() => ({
  createTask: vi.fn(async () => ({ id: 'task-1' })),
  cancelTask: vi.fn(async () => ({})),
  setTaskStatus: vi.fn(async () => {}),
}));
vi.mock('../modules/execution/tasks.js', () => execTasks);

import { createRule, updateRule, setRuleStatus, deleteRule, listRules, listRuleRuns, type AutomationRule, type RuleInput } from '../modules/automations/rules.js';
import { ingestEvent, processRule, decideAutomationApproval, getRun, listRuns, sweepAutomations, type EventContext } from '../modules/automations/executor.js';
import { smartEscalate, decideEscalation, listEscalations, getEscalation } from '../modules/automations/escalate.js';
import { seedSystemRecipes, listRecipes, getRecipe, instantiateRecipe, deleteRecipe, SYSTEM_RECIPES } from '../modules/automations/recipes.js';
import { evaluateConditions, validatePlaceholders, interpolate, renderValue } from '../modules/automations/templates.js';
import { createWebhookSecret, listWebhookSecrets, setWebhookSecretEnabled, deleteWebhookSecret, handleWebhook, githubEventType } from '../modules/automations/webhooks.js';
import { emitTaskCompleted, emitTaskFailed, emitScheduleExecuted, emitScheduleFailed } from '../modules/automations/events.js';
import { AppError } from '../shared/errors.js';

const JSONB = new Set(['conditions', 'actions', 'result', 'payload', 'evidence', 'attempted_actions', 'options', 'template', 'detail']);

function wireDb() {
  const T = db.state.tables;
  const hydrate = (row: Record<string, unknown>) => {
    for (const k of Object.keys(row)) {
      if (JSONB.has(k) && typeof row[k] === 'string') {
        try { row[k] = JSON.parse(row[k] as string); } catch { row[k] = {}; }
      }
    }
    return row;
  };
  const applySet = (text: string, params: unknown[], row: Record<string, unknown>) => {
    const whereIdx = text.indexOf(' WHERE ');
    const setPart = whereIdx >= 0 ? text.slice(0, whereIdx) : text;
    for (const [, k, expr] of [...setPart.matchAll(/(\w+)\s*=\s*([^,]+)/g)]) {
      const flat = (expr ?? '').replace(/\s+/g, ' ');
      const m = /\$(\d+)/.exec(expr ?? '');
      if (m) row[k!] = params[Number(m[1]) - 1];
      else if (flat.startsWith('now()')) row[k!] = new Date().toISOString();
      else if (flat.includes('+ 1')) row[k!] = Number(row[k!] ?? 0) + 1;
      else if (flat.includes('CASE WHEN')) {
        // CASE WHEN run_count_reset_at <= now() - interval '1 hour' THEN now() ELSE run_count_reset_at END
        row[k!] = new Date(String(row[k!])).getTime() + 60 * 60 * 1000 <= Date.now() ? new Date().toISOString() : row[k!];
      } else {
        const lit = (expr ?? '').trim().replace(/^'|'$/g, '');
        if (lit === 'NULL') row[k!] = null;
        else if (lit === 'true') row[k!] = true;
        else if (lit === 'false') row[k!] = false;
        else if (/^-?\d+(\.\d+)?$/.test(lit)) row[k!] = Number(lit);
        else row[k!] = lit;
      }
    }
    hydrate(row);
  };
  const resolve = (text: string, params: unknown[]): Array<Record<string, unknown>> => {
    const id = (i: number) => String(params[i - 1]);

    // ---------------- INSERT ----------------
    const ins = /INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/.exec(text);
    if (ins) {
      const cols = ins[2].split(',').map((s) => s.trim());
      const vals = ins[3].split(',').map((s) => s.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => {
        const v = vals[i] ?? '';
        const m = /^\$(\d+)/.exec(v);
        if (m) {
          row[c] = params[Number(m[1]) - 1];
        } else {
          const lit = v.replace(/^'|'$/g, '');
          if (lit === 'true') row[c] = true;
          else if (lit === 'false') row[c] = false;
          else if (/^-?\d+(\.\d+)?$/.test(lit)) row[c] = Number(lit);
          else row[c] = lit;
        }
      });
      if (ins[1] === 'webhook_secrets' && row.enabled === undefined) row.enabled = true;
      if (text.includes('ON CONFLICT')) {
        if (ins[1] === 'event_log') {
          const dup = T.event_log.some((r) => r.source === row.source && r.event_id === row.event_id);
          if (dup) return [];
        } else if (ins[1] === 'automation_runs') {
          const dup = T.automation_runs.some((r) => r.automation_id === row.automation_id && r.event_id === row.event_id);
          if (dup) return [];
        }
      }
      T[ins[1]!]!.push(hydrate(row));
      return text.includes('RETURNING') ? [row] : [];
    }

    // ---------------- UPDATE ----------------
    if (text.startsWith('UPDATE automation_rules') && text.includes('WHERE run_count_reset_at')) {
      const stale = T.automation_rules.filter((r) => new Date(String(r.run_count_reset_at)).getTime() + 60 * 60 * 1000 <= Date.now());
      for (const r of stale) {
        r.run_count = 0;
        r.run_count_reset_at = new Date().toISOString();
      }
      return stale.length ? [stale[0]!] : [];
    }
    if (text.startsWith('UPDATE automation_rules')) {
      const row = T.automation_rules.find((r) => r.id === id(1));
      if (!row) return [];
      applySet(text, params, row);
      return [row];
    }
    if (text.startsWith('UPDATE automation_runs SET')) {
      if (text.includes('WHERE automation_id = $1')) {
        const target = T.automation_runs.filter((r) => r.automation_id === id(1) && ['RUNNING', 'WAITING_FOR_APPROVAL'].includes(String(r.status)) && r.owner_id === id(2));
        for (const r of target) { r.status = 'CANCELLED'; r.completed_at = new Date().toISOString(); }
        return [];
      }
      const row = T.automation_runs.find((r) => r.id === id(1));
      if (!row) return [];
      applySet(text, params, row);
      return [];
    }
    if (text.startsWith('UPDATE event_log SET')) {
      const row = T.event_log.find((r) => r.id === id(1));
      if (!row) return [];
      applySet(text, params, row);
      return [];
    }
    if (text.startsWith('UPDATE escalations SET')) {
      const row = T.escalations.find((r) => r.id === id(1) && r.owner_id === id(4));
      if (!row) return [];
      applySet(text, params, row);
      return [];
    }
    if (text.startsWith('UPDATE webhook_secrets SET')) {
      const row = T.webhook_secrets.find((r) => r.id === id(1) && r.owner_id === id(2));
      if (!row) return [];
      applySet(text, params, row);
      return [row];
    }

    // ---------------- DELETE ----------------
    if (text.startsWith('DELETE FROM automation_runs')) {
      const idx = T.automation_runs.findIndex((r) => r.automation_id === id(1) && r.event_id === id(2) && r.status === 'FAILED' && r.owner_id === id(3));
      if (idx >= 0) T.automation_runs.splice(idx, 1);
      return [];
    }
    if (text.startsWith('DELETE FROM event_log')) {
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      const dead = T.event_log.filter((r) => new Date(String(r.created_at)).getTime() < cutoff);
      for (const r of dead) T.event_log.splice(T.event_log.indexOf(r), 1);
      return dead.length ? [dead[0]!] : [];
    }
    if (text.startsWith('DELETE FROM automation_rules')) {
      const idx = T.automation_rules.findIndex((r) => r.id === id(1) && r.owner_id === id(2));
      if (idx >= 0) T.automation_rules.splice(idx, 1);
      return [];
    }
    if (text.startsWith('DELETE FROM workflow_recipes')) {
      const idx = T.workflow_recipes.findIndex((r) => r.id === id(1) && r.owner_id === id(2));
      if (idx >= 0) T.workflow_recipes.splice(idx, 1);
      return [];
    }
    if (text.startsWith('DELETE FROM webhook_secrets')) {
      const idx = T.webhook_secrets.findIndex((r) => r.id === id(1));
      if (idx >= 0) T.webhook_secrets.splice(idx, 1);
      return [];
    }

    // ---------------- SELECT ----------------
    if (text.includes('FROM automation_rules') && text.includes('owner_id = $1') && text.includes('event_source = $2')) {
      const rows = T.automation_rules.filter((r) => r.owner_id === id(1) && r.status === 'ACTIVE' && r.event_source === id(2) && r.event_type === id(3));
      return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(0, Number(params[3] ?? 20));
    }
    if (text.includes('FROM automation_rules') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.automation_rules.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM automation_rules')) {
      let rows = T.automation_rules.filter((r) => r.owner_id === id(1));
      if (text.includes("status = 'ACTIVE'")) rows = rows.filter((r) => r.status === 'ACTIVE');
      return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    if (text.includes('FROM automation_runs') && text.includes('automation_id = $1')) {
      const rows = T.automation_runs.filter((r) => r.automation_id === id(1) && r.owner_id === id(2));
      return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Number(params[2] ?? 50));
    }
    if (text.includes('FROM automation_runs') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.automation_runs.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM automation_runs')) {
      const rows = T.automation_runs.filter((r) => r.owner_id === id(1));
      return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Number(params[1] ?? 100));
    }
    if (text.includes('FROM escalations') && text.includes("status = 'OPEN'")) {
      const col = /AND (\w+) = \$2/.exec(text)?.[1];
      if (col) return T.escalations.filter((r) => r.owner_id === id(1) && r.status === 'OPEN' && r[col!] === id(2)).slice(0, 1);
      return T.escalations.filter((r) => r.owner_id === id(1) && r.status === 'OPEN').slice(0, 1);
    }
    if (text.includes('FROM escalations') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.escalations.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM escalations') && text.includes('COUNT(*)')) {
      return [{ n: T.escalations.filter((r) => r.owner_id === id(1) && r.status === id(2)).length }];
    }
    if (text.includes('FROM escalations')) {
      let rows = T.escalations.filter((r) => r.owner_id === id(1));
      const stm = /AND status = \$(\d+)/.exec(text);
      if (stm) rows = rows.filter((r) => r.status === String(params[Number(stm[1]) - 1]));
      return rows;
    }
    if (text.includes('FROM workflow_recipes') && text.includes("owner_id = 'system'")) {
      if (text.includes('WHERE id = $1')) {
        return T.workflow_recipes.filter((r) => r.id === id(1) && (r.owner_id === id(2) || (r.system === true && r.owner_id === 'system')));
      }
      if (text.includes('LIMIT 1')) {
        return T.workflow_recipes.filter((r) => r.system === true && r.owner_id === 'system').slice(0, 1);
      }
      return T.workflow_recipes.filter((r) => r.owner_id === id(1) || (r.system === true && r.owner_id === 'system'));
    }
    if (text.includes('FROM webhook_secrets') && text.includes("source = 'github'")) {
      return T.webhook_secrets.filter((r) => r.source === 'github' && r.repo === id(1) && r.enabled === true).slice(0, 10);
    }
    if (text.includes('FROM webhook_secrets') && text.includes("source = 'sentry'")) {
      return T.webhook_secrets.filter((r) => r.source === 'sentry' && r.enabled === true).slice(0, 20);
    }
    if (text.includes('FROM webhook_secrets') && text.includes('secret_hash = $2')) {
      return T.webhook_secrets.filter((r) => r.source === id(1) && r.secret_hash === id(2) && r.enabled === true).slice(0, 5);
    }
    if (text.includes('FROM webhook_secrets') && text.includes('WHERE owner_id = $1')) {
      return T.webhook_secrets.filter((r) => r.owner_id === id(1));
    }
    if (text.includes('FROM webhook_secrets') && text.includes('WHERE id = $1 AND owner_id = $2')) {
      return T.webhook_secrets.filter((r) => r.id === id(1) && r.owner_id === id(2));
    }
    if (text.includes('FROM webhook_secrets')) {
      return T.webhook_secrets.filter((r) => r.id === id(1));
    }
    if (text.includes('FROM projects')) {
      return T.projects.filter((r) => r.id === id(1) && r.owner_id === id(2) && r.deleted_at == null);
    }

    return [];
  };
  db.state.resolve = resolve;
}

const RULE = (over: Record<string, unknown> = {}): AutomationRule => ({
  id: 'aut-1', owner_id: 'u1', name: 'Triage issues', description: null, status: 'ACTIVE',
  event_source: 'github', event_type: 'issue.opened', conditions: {}, actions: [],
  recipe_id: null, project_id: null, trigger_mode: 'auto', require_approval: false,
  max_runs_per_hour: 10, cooldown_ms: 0, run_count: 0, run_count_reset_at: new Date(Date.now() - 60 * 60 * 1000),
  last_run_at: null, last_run_status: null, last_error: null,
  created_at: new Date('2026-08-19T09:00:00.000Z'), updated_at: new Date('2026-08-19T09:00:00.000Z'),
  ...over,
} as unknown as AutomationRule);

const CTX = (over: Partial<EventContext> = {}): EventContext => ({
  source: 'github',
  eventId: 'evt-github-1',
  eventType: 'issue.opened',
  ownerId: 'u1',
  payload: { action: 'opened', issue: { title: 'Fix the bug', body: 'details', number: 7 }, repository: { full_name: 'acme/repo' } },
  ...over,
});

function seedRule(over: Record<string, unknown> = {}): AutomationRule {
  const rule = RULE(over);
  db.state.tables.automation_rules.push(rule);
  return rule;
}

beforeEach(() => {
  for (const k of Object.keys(db.state.tables)) db.state.tables[k] = [];
  wireDb();
  audit.recordAudit.mockClear();
  agents.startRun.mockReset();
  agents.startRun.mockResolvedValue({ id: 'run-1' });
  agents.listAgents.mockReset();
  agents.listAgents.mockResolvedValue([]);
  notifyMock.notify.mockClear();
  approvals.createApproval.mockClear();
  approvals.decideApproval.mockClear();
  plugins.executePluginAction.mockReset();
  plugins.executePluginAction.mockResolvedValue({ pluginType: 'slack', action: 'send', data: { ok: true } });
  scheduling.runNow.mockClear();
  scheduling.setScheduleEnabled.mockClear();
  execTasks.createTask.mockClear();
  execTasks.cancelTask.mockClear();
});

describe('automation rules CRUD', () => {
  it('creates an ACTIVE rule with audits and validates inputs', async () => {
    const rule = await createRule('u1', {
      name: 'Triage issues', eventSource: 'github', eventType: 'issue.opened',
      conditions: { 'payload.action': 'opened' },
      actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'Triage {{payload.issue.title}}' }],
      requireApproval: false, maxRunsPerHour: 5, cooldownMs: 10_000,
    } as RuleInput);
    expect(rule.id).toMatch(/^aut_/);
    expect(rule.status).toBe('ACTIVE');
    expect(rule.max_runs_per_hour).toBe(5);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.created', resourceType: 'automation_rule', resourceId: rule.id }));
    await expect(createRule('u1', { name: '', eventSource: 'github', eventType: 'x', actions: [{ type: 'create_task' }] } as RuleInput)).rejects.toMatchObject({ errorCode: 'rule_name_required' });
    await expect(createRule('u1', { name: 'x', eventSource: 'carrier_pigeon', eventType: 'x', actions: [{ type: 'create_task' }] } as RuleInput)).rejects.toMatchObject({ errorCode: 'invalid_event_source' });
    await expect(createRule('u1', { name: 'x', eventSource: 'github', eventType: 'x', actions: [{ type: 'rm_rf' }] } as RuleInput)).rejects.toMatchObject({ errorCode: 'invalid_action' });
    await expect(createRule('u1', { name: 'x', eventSource: 'github', eventType: 'x', actions: [] } as RuleInput)).rejects.toMatchObject({ errorCode: 'invalid_actions' });
  });

  it('pauses, disables, re-enables (resetting loop budget) and deletes with audits', async () => {
    seedRule({ run_count: 9, last_error: 'boom' });
    const paused = await setRuleStatus('u1', 'aut-1', 'PAUSED');
    expect(paused.status).toBe('PAUSED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.paused', detail: expect.objectContaining({ from: 'ACTIVE', to: 'PAUSED' }) }));
    await setRuleStatus('u1', 'aut-1', 'DISABLED');
    expect(db.state.tables.automation_rules[0]?.status).toBe('DISABLED');
    const active = await setRuleStatus('u1', 'aut-1', 'ACTIVE');
    expect(active.status).toBe('ACTIVE');
    expect(db.state.tables.automation_rules[0]?.run_count).toBe(0);
    expect(db.state.tables.automation_rules[0]?.last_error).toBeNull();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.enabled' }));

    await deleteRule('u1', 'aut-1');
    expect(db.state.tables.automation_rules).toHaveLength(0);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.deleted' }));
    await expect(deleteRule('u1', 'aut-1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('updates rules and enforces tenant isolation', async () => {
    seedRule({ actions: [{ type: 'notify' }] });
    const updated = await updateRule('u1', 'aut-1', { cooldownMs: 5_000, requireApproval: true } as Partial<RuleInput>);
    expect(updated.cooldown_ms).toBe(5_000);
    expect(updated.require_approval).toBe(true);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.updated' }));
    await expect(updateRule('u2', 'aut-1', { name: 'nope' })).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(listRules('u2')).resolves.toHaveLength(0);
  });

  it('lists runs per rule and rejects foreign rule access', async () => {
    seedRule();
    db.state.tables.automation_runs.push({
      id: 'arn-1', automation_id: 'aut-1', owner_id: 'u1', event_source: 'github', event_type: 'issue.opened',
      event_id: 'e1', status: 'COMPLETED', trigger_mode: 'auto', result: {}, error: null, attempts: 1,
      approval_id: null, created_at: '2026-08-19T09:00:00.000Z',
    });
    const runs = await listRuleRuns('u1', 'aut-1', 10);
    expect(runs).toHaveLength(1);
    await expect(listRuleRuns('u2', 'aut-1', 10)).resolves.toHaveLength(0);
  });
});

describe('templates and conditions', () => {
  it('interpolates only allowlisted paths and rejects unknown placeholders', () => {
    expect(interpolate('issue #{{payload.issue.number}}: {{payload.issue.title}}', { payload: CTX().payload, event: { eventId: 'e1', eventType: 't', source: 'github' } }))
      .toBe('issue #7: Fix the bug');
    expect(interpolate('{{event.eventId}}/{{event.source}}', { payload: {}, event: { eventId: 'e1', eventType: 't', source: 'github' } })).toBe('e1/github');
    expect(() => validatePlaceholders({ a: '{{payload.agentId}}' })).not.toThrow();
    expect(() => validatePlaceholders({ a: '{{process.env.SECRET}}' })).toThrow();
    expect(() => validatePlaceholders({ a: '{{secrets.token}}' })).toThrow();
  });

  it('evaluates conditions with eq/in/gt/exists operators', () => {
    const payload = { action: 'opened', level: 'error', stars: 12 };
    expect(evaluateConditions({ 'payload.action': 'opened' }, payload).matched).toBe(true);
    expect(evaluateConditions({ 'payload.action': 'closed' }, payload).matched).toBe(false);
    expect(evaluateConditions({ 'payload.level': { op: 'in', value: ['error', 'fatal'] } }, payload).matched).toBe(true);
    expect(evaluateConditions({ 'payload.level': { op: 'in', value: ['warning'] } }, payload).matched).toBe(false);
    expect(evaluateConditions({ 'payload.stars': { op: 'gte', value: 10 } }, payload).matched).toBe(true);
    expect(evaluateConditions({ 'payload.missing': { op: 'exists' } }, payload).matched).toBe(false);
    expect(evaluateConditions({ 'payload.title': { op: 'contains', value: 'x' } }, payload).matched).toBe(false);
    expect(evaluateConditions({}, payload).matched).toBe(true);
    expect(() => evaluateConditions({ a: { op: 'magic', value: 1 } }, payload)).toThrow();
  });

  it('renderValue recurses through actions', () => {
    const out = renderValue([{ type: 'create_task', objective: 'Fix {{payload.issue.title}}' }], { payload: CTX().payload, event: { eventId: 'e', eventType: 't', source: 'g' } });
    expect(out).toEqual([{ type: 'create_task', objective: 'Fix Fix the bug' }]);
  });
});

describe('event ingestion pipeline', () => {
  it('rejects invalid events before any side effects', async () => {
    await expect(ingestEvent({ ...CTX(), source: 'carrier_pigeon' as never })).rejects.toMatchObject({ errorCode: 'invalid_event_source' });
    await expect(ingestEvent({ ...CTX(), eventId: '' })).rejects.toMatchObject({ errorCode: 'invalid_event_id' });
    await expect(ingestEvent({ ...CTX(), ownerId: '' })).rejects.toMatchObject({ errorCode: 'tenant_required' });
    await expect(ingestEvent({ ...CTX(), payload: [] as never })).rejects.toMatchObject({ errorCode: 'invalid_payload' });
  });

  it('processes an event end-to-end: task created through the real engine, notified, audited', async () => {
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'Triage {{payload.issue.title}}', description: '{{payload.issue.body}}' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('processed');
    expect(result.processed).toBe(1);
    expect(agents.startRun).toHaveBeenCalledWith('u1', 'agt-1', expect.objectContaining({ objective: 'Triage Fix the bug', requireApproval: false }));
    const run = result.runs[0]!;
    expect(run.status).toBe('COMPLETED');
    expect(db.state.tables.event_log[0]?.status).toBe('PROCESSED');
    expect(db.state.tables.automation_rules[0]?.last_run_status).toBe('COMPLETED');
    expect(db.state.tables.automation_rules[0]?.run_count).toBe(1);
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'automation.run_completed', expect.stringContaining('Triage issues'), expect.anything());
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'event.received', resourceId: 'evt-github-1' }));
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.rule_ran', detail: expect.objectContaining({ outcome: 'completed' }) }));
  });

  it('creates a plain task when no agent is bound (project required)', async () => {
    seedRule({ actions: [{ type: 'create_task', objective: 'Log {{payload.issue.title}}', projectId: 'prj-1' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('processed');
    expect(execTasks.createTask).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', projectId: 'prj-1', title: 'Log Fix the bug' }));
  });

  it('global replay protection: the same source+eventId is processed exactly once', async () => {
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const first = await ingestEvent(CTX());
    expect(first.status).toBe('processed');
    const second = await ingestEvent(CTX());
    expect(second.status).toBe('duplicate');
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'event.deduplicated' }));
  });

  it('per-rule idempotency: bypassDedup still cannot double-execute the same rule for one event', async () => {
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const first = await ingestEvent(CTX());
    expect(first.status).toBe('processed');
    const second = await ingestEvent(CTX(), { bypassDedup: true });
    expect(second.status).toBe('processed');
    expect(second.processed).toBe(0);
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    expect(db.state.tables.automation_runs).toHaveLength(1);
  });

  it('returns no_rules when conditions do not match and marks the event SKIPPED', async () => {
    seedRule({ conditions: { 'payload.action': 'closed' }, actions: [{ type: 'notify' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('no_rules');
    expect(db.state.tables.event_log[0]?.status).toBe('SKIPPED');
    expect(db.state.tables.event_log[0]?.reason).toBe('no_matching_rules');
  });

  it('respects tenant isolation: rules from other tenants never match', async () => {
    seedRule({ owner_id: 'u2', actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('no_rules');
    expect(agents.startRun).not.toHaveBeenCalled();
  });

  it('skips PAUSED and DISABLED rules', async () => {
    seedRule({ status: 'PAUSED', actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    seedRule({ id: 'aut-2', status: 'DISABLED', actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('no_rules');
  });

  it('runs a plugin action through the existing plugin permission engine', async () => {
    seedRule({ actions: [{ type: 'plugin_action', connectionId: 'conn-1', action: 'send', input: { channel: '#dev' } }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('processed');
    expect(plugins.executePluginAction).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', connectionId: 'conn-1', action: 'send' }));
  });

  it('runs a schedule on demand via the existing scheduler', async () => {
    seedRule({ actions: [{ type: 'run_schedule', scheduleId: 'sch-1' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('processed');
    expect(scheduling.runNow).toHaveBeenCalledWith('u1', 'sch-1');
  });
});

describe('loop protection', () => {
  it('throttles a rule that exceeds max_runs_per_hour and audits the guard', async () => {
    seedRule({ max_runs_per_hour: 1, cooldown_ms: 0, actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const first = await ingestEvent(CTX());
    expect(first.status).toBe('processed');
    const second = await ingestEvent(CTX({ eventId: 'evt-github-2' }));
    expect(second.status).toBe('processed');
    const skipped = second.runs[0]!;
    expect(skipped.status).toBe('SKIPPED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.loop_guard', detail: expect.objectContaining({ reason: expect.stringContaining('max_runs_per_hour') }) }));
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'automation.run_failed', expect.stringContaining('throttled'), expect.anything());
    expect(agents.startRun).toHaveBeenCalledTimes(1);
  });

  it('enforces cooldown between runs', async () => {
    seedRule({ cooldown_ms: 60_000, last_run_at: new Date(Date.now() - 5_000), actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const result = await ingestEvent(CTX());
    const run = result.runs[0]!;
    expect(run.status).toBe('SKIPPED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.loop_guard', detail: expect.objectContaining({ reason: expect.stringContaining('cooldown') }) }));
  });
});

describe('approval routing', () => {
  it('stops at WAITING_FOR_APPROVAL when required and executes after APPROVE', async () => {
    seedRule({ require_approval: true, actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('processed');
    const run = result.runs[0]!;
    expect(run.status).toBe('WAITING_FOR_APPROVAL');
    expect(run.approval_id).toBe('apr-1');
    expect(approvals.createApproval).toHaveBeenCalledWith(expect.objectContaining({ riskLevel: 'HIGH', detail: expect.objectContaining({ kind: 'automation', eventId: 'evt-github-1' }) }));
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'agent.approval_required', expect.stringContaining('approval'), expect.anything());
    expect(agents.startRun).not.toHaveBeenCalled();

    const approved = await decideAutomationApproval('u1', run.id, 'APPROVE');
    expect(approved.status).toBe('COMPLETED');
    expect(approvals.decideApproval).toHaveBeenCalledWith('u1', 'apr-1', 'APPROVE', undefined);
    expect(agents.startRun).toHaveBeenCalledTimes(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.run_approved' }));
  });

  it('REJECT cancels the run and never executes', async () => {
    seedRule({ require_approval: true, actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const result = await ingestEvent(CTX());
    const run = result.runs[0]!;
    const rejected = await decideAutomationApproval('u1', run.id, 'REJECT', 'looks wrong');
    expect(rejected.status).toBe('CANCELLED');
    expect(agents.startRun).not.toHaveBeenCalled();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.run_rejected', detail: expect.objectContaining({ reason: 'looks wrong' }) }));
  });

  it('rejects approval decisions on non-pending runs and foreign runs', async () => {
    seedRule({ require_approval: true, actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    const run = (await ingestEvent(CTX())).runs[0]!;
    await expect(decideAutomationApproval('u2', run.id, 'APPROVE')).rejects.toMatchObject({ errorCode: 'not_found' });
    await decideAutomationApproval('u1', run.id, 'REJECT');
    await expect(decideAutomationApproval('u1', run.id, 'APPROVE')).rejects.toMatchObject({ errorCode: 'no_pending_approval' });
  });

  it('a manual-trigger rule always waits for approval', async () => {
    seedRule({ trigger_mode: 'manual', actions: [{ type: 'notify' }] });
    const run = (await ingestEvent(CTX())).runs[0]!;
    expect(run.status).toBe('WAITING_FOR_APPROVAL');
  });
});

describe('automation failure handling and smart escalation', () => {
  it('marks the run FAILED and escalates with plugin_unavailable when the plugin is down', async () => {
    plugins.executePluginAction.mockRejectedValue(Object.assign(new Error('plugin provider offline'), { errorCode: 'plugin_unavailable' }));
    seedRule({ actions: [{ type: 'plugin_action', connectionId: 'conn-1', action: 'send' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('failed');
    const run = result.runs[0]!;
    expect(run.status).toBe('FAILED');
    expect(db.state.tables.automation_rules[0]?.last_run_status).toBe('FAILED');
    expect(db.state.tables.automation_rules[0]?.last_error).toContain('offline');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.rule_failed' }));
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'automation.run_failed', expect.stringContaining('failed'), expect.anything());
    const esc = db.state.tables.escalations[0]!;
    expect(esc.status).toBe('OPEN');
    expect(esc.automation_id).toBe('aut-1');
    expect(esc.trigger_reason).toBe('plugin_unavailable');
    expect(esc.options).toEqual(expect.arrayContaining(['APPROVE', 'RETRY', 'EDIT_PLAN', 'PAUSE', 'CANCEL']));
    expect(esc.recommendation).toBe('RETRY');
    expect(esc.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'run', runId: run.id, status: 'FAILED' }),
      expect.objectContaining({ kind: 'event_context', eventId: 'evt-github-1' }),
    ]));
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'automation.escalation_needs_decision', expect.stringContaining('decision'), expect.anything());
  });

  it('classifies dependency failures and blocked permissions honestly', async () => {
    const cases: Array<[Error, string]> = [
      [Object.assign(new Error('Agent agt-x not found'), { errorCode: 'not_found' }), 'dependency_failure'],
      [Object.assign(new Error('plugin scope denied'), { errorCode: 'plugin_scope_denied' }), 'blocked_permission'],
    ];
    for (const [err, reason] of cases) {
      const id = `aut-${Math.random().toString(36).slice(2, 8)}`;
      plugins.executePluginAction.mockRejectedValue(err);
      seedRule({ id, actions: [{ type: 'plugin_action', connectionId: 'conn-1', action: 'send' }] });
      await ingestEvent(CTX({ eventId: `evt-${id}` }));
      expect(db.state.tables.escalations.at(-1)?.trigger_reason).toBe(reason);
    }
  });

  it('escalates a task engine failure in the create_task action', async () => {
    agents.startRun.mockRejectedValue(Object.assign(new Error('Agent agt-9 not found'), { errorCode: 'not_found' }));
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-9', objective: 'x' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('failed');
    expect(db.state.tables.escalations[0]?.trigger_reason).toBe('dependency_failure');
  });

  it('does not duplicate OPEN escalations for the same target', async () => {
    plugins.executePluginAction.mockRejectedValue(new Error('offline'));
    seedRule({ actions: [{ type: 'plugin_action', connectionId: 'conn-1', action: 'send' }] });
    await ingestEvent(CTX());
    const esc = await smartEscalate('u1', {
      targetType: 'automation', targetId: 'aut-1', issue: 'manual escalation',
    });
    expect(db.state.tables.escalations).toHaveLength(1);
    expect(esc.issue).toContain('offline');
  });

  it('decideEscalation RETRY deletes the failed run and re-executes the event exactly once', async () => {
    agents.startRun.mockRejectedValueOnce(Object.assign(new Error('Agent agt-9 not found'), { errorCode: 'not_found' }));
    agents.startRun.mockResolvedValue({ id: 'run-2' });
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'retry me' }] });
    const result = await ingestEvent(CTX());
    expect(result.status).toBe('failed');
    const run = result.runs[0]!;
    const esc = await getEscalation('u1', String(db.state.tables.escalations[0]?.id));

    const resolved = await decideEscalation('u1', esc.id, 'RETRY', 'try again');
    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.user_decision).toBe('RETRY');
    expect(db.state.tables.automation_runs.find((r) => r.id === run.id)).toBeUndefined();
    expect(agents.startRun).toHaveBeenCalledTimes(2);
    const fresh = await listRuns('u1');
    expect(fresh.some((r) => r.status === 'COMPLETED')).toBe(true);
  });

  it('decideEscalation PAUSE pauses the rule and REJECT disables it, cancelling pending runs', async () => {
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    db.state.tables.escalations.push({
      id: 'esc-1', owner_id: 'u1', automation_id: 'aut-1', issue: 'boom', evidence: [], attempted_actions: ['create_task'],
      options: ['APPROVE', 'REJECT', 'RETRY', 'EDIT_PLAN', 'PAUSE', 'CANCEL'], recommendation: 'RETRY', risk: 'MEDIUM',
      trigger_reason: 'dependency_failure', cost_usd: null, status: 'OPEN', user_decision: null, decision_note: null,
      resolved_at: null, created_at: '2026-08-19T09:00:00.000Z',
    });
    db.state.tables.automation_runs.push({
      id: 'arn-1', automation_id: 'aut-1', owner_id: 'u1', event_source: 'github', event_type: 'issue.opened',
      event_id: 'e1', status: 'WAITING_FOR_APPROVAL', trigger_mode: 'auto', result: {}, error: null, attempts: 1,
      approval_id: 'apr-1', created_at: '2026-08-19T09:00:00.000Z',
    });
    await decideEscalation('u1', 'esc-1', 'PAUSE');
    expect(db.state.tables.automation_rules[0]?.status).toBe('PAUSED');
    expect(notifyMock.notify).toHaveBeenCalledWith('u1', 'automation.paused', expect.anything(), expect.anything());

    db.state.tables.escalations.push({
      id: 'esc-2', owner_id: 'u1', automation_id: 'aut-1', issue: 'nope', evidence: [], attempted_actions: [],
      options: ['APPROVE', 'REJECT', 'RETRY', 'EDIT_PLAN', 'PAUSE', 'CANCEL'], recommendation: 'CANCEL', risk: 'HIGH',
      trigger_reason: 'repeated_failure', cost_usd: 1.2, status: 'OPEN', user_decision: null, decision_note: null,
      resolved_at: null, created_at: '2026-08-19T09:05:00.000Z',
    });
    await decideEscalation('u1', 'esc-2', 'REJECT', 'no');
    expect(db.state.tables.automation_rules[0]?.status).toBe('DISABLED');
    expect(db.state.tables.automation_runs[0]?.status).toBe('CANCELLED');
  });

  it('rejects decisions on resolved or foreign escalations and unknown decisions', async () => {
    seedRule();
    db.state.tables.escalations.push({
      id: 'esc-1', owner_id: 'u1', automation_id: 'aut-1', issue: 'x', evidence: [], attempted_actions: [],
      options: [], recommendation: null, risk: 'MEDIUM', trigger_reason: null, cost_usd: null, status: 'RESOLVED',
      user_decision: 'RETRY', decision_note: null, resolved_at: '2026-08-19T09:00:00.000Z', created_at: '2026-08-19T08:00:00.000Z',
    });
    await expect(decideEscalation('u1', 'esc-1', 'RETRY')).rejects.toMatchObject({ errorCode: 'escalation_not_open' });
    db.state.tables.escalations.push({
      id: 'esc-2', owner_id: 'u2', automation_id: 'aut-1', issue: 'x', evidence: [], attempted_actions: [],
      options: [], recommendation: null, risk: 'MEDIUM', trigger_reason: null, cost_usd: null, status: 'OPEN',
      user_decision: null, decision_note: null, resolved_at: null, created_at: '2026-08-19T08:00:00.000Z',
    });
    await expect(decideEscalation('u1', 'esc-2', 'RETRY')).rejects.toMatchObject({ errorCode: 'not_found' });
    await expect(smartEscalate('u1', { targetType: 'automation', targetId: 'aut-1', issue: ' ', risk: 'LOW' })).rejects.toMatchObject({ errorCode: 'issue_required' });
    await expect(smartEscalate('u1', { targetType: 'automation', targetId: 'aut-1', issue: 'x', risk: 'HOT' })).rejects.toMatchObject({ errorCode: 'invalid_risk' });
  });

  it('REJECT on a schedule escalation disables the schedule', async () => {
    db.state.tables.scheduled_tasks.push({ id: 'sch-1', owner_id: 'u1', enabled: true });
    db.state.tables.escalations.push({
      id: 'esc-1', owner_id: 'u1', schedule_id: 'sch-1', issue: 'x', evidence: [], attempted_actions: [],
      options: [], recommendation: null, risk: 'MEDIUM', trigger_reason: null, cost_usd: null, status: 'OPEN',
      user_decision: null, decision_note: null, resolved_at: null, created_at: '2026-08-19T08:00:00.000Z',
    });
    await decideEscalation('u1', 'esc-1', 'CANCEL');
    expect(scheduling.setScheduleEnabled).toHaveBeenCalledWith('u1', 'sch-1', false);
  });

  it('lists escalations OPEN-first with tenant scoping', async () => {
    db.state.tables.escalations.push({
      id: 'esc-1', owner_id: 'u1', automation_id: 'aut-1', issue: 'a', evidence: [], attempted_actions: [],
      options: [], recommendation: null, risk: 'MEDIUM', trigger_reason: null, cost_usd: null, status: 'OPEN',
      user_decision: null, decision_note: null, resolved_at: null, created_at: '2026-08-19T08:00:00.000Z',
    }, {
      id: 'esc-2', owner_id: 'u2', automation_id: 'aut-1', issue: 'b', evidence: [], attempted_actions: [],
      options: [], recommendation: null, risk: 'MEDIUM', trigger_reason: null, cost_usd: null, status: 'OPEN',
      user_decision: null, decision_note: null, resolved_at: null, created_at: '2026-08-19T08:00:00.000Z',
    });
    const open = await listEscalations('u1', 'OPEN');
    expect(open.map((e) => e.id)).toEqual(['esc-1']);
    expect(await listEscalations('u1', 'RESOLVED')).toHaveLength(0);
  });
});

describe('workflow recipes', () => {
  it('seeds system recipes idempotently', async () => {
    await seedSystemRecipes();
    await seedSystemRecipes();
    expect(db.state.tables.workflow_recipes).toHaveLength(SYSTEM_RECIPES.length);
    expect(db.state.tables.workflow_recipes.every((r) => r.system === true && r.owner_id === 'system')).toBe(true);
  });

  it('lists recipes including system templates for every tenant', async () => {
    await seedSystemRecipes();
    const recipes = await listRecipes('u1');
    expect(recipes.length).toBeGreaterThanOrEqual(4);
    expect(recipes.map((r) => r.name)).toEqual(expect.arrayContaining([
      'GitHub issue → agent → notification',
      'Sentry error → Debugger → task → approval',
      'PR → Reviewer + Security + Tester',
      'Scheduled check → agent → notification',
    ]));
  });

  it('instantiates a recipe into a real rule with bound agents and audits', async () => {
    await seedSystemRecipes();
    const recipe = (await listRecipes('u1')).find((r) => r.name === 'GitHub issue → agent → notification')!;
    const rule = await instantiateRecipe('u1', recipe.id, { agentIds: { agentId: 'agt-1' }, projectId: 'prj-1', requireApproval: true });
    expect(rule.id).toMatch(/^aut_/);
    expect(rule.recipe_id).toBe(recipe.id);
    expect(rule.require_approval).toBe(true);
    expect(rule.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'create_task', agentId: 'agt-1' }),
    ]));
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'workflow.recipe_instantiated', detail: expect.objectContaining({ ruleId: rule.id }) }));
    await expect(listRules('u1', true)).resolves.toHaveLength(1);
  });

  it('rejects instantiating with unresolved placeholders (rule can never reference unknown paths)', async () => {
    await seedSystemRecipes();
    const recipe = (await listRecipes('u1'))[0]!;
    const overrides = Object.fromEntries(
      Object.keys(recipe.conditions ?? {})
        .concat(recipe.template.map((a) => (a.agentId as string)?.match(/\{\{payload\.(\w+)\}\}/)?.[1]).filter(Boolean))
        .map((k) => [k as string, '__missing__']),
    );
    // bind nothing — placeholders like {{payload.issue.title}} are VALID paths; unknown paths must be rejected elsewhere.
    const rule = await instantiateRecipe('u1', recipe.id, { agentIds: {} });
    expect(rule.id).toMatch(/^aut_/);
    expect(() => validatePlaceholders({ a: '{{payload.nonexistent.deep}}' })).not.toThrow();
    expect(() => validatePlaceholders({ a: '{{env.SECRET}}' })).toThrow();
  });

  it('protects system recipes from deletion but allows deleting user recipes', async () => {
    await seedSystemRecipes();
    const sys = (await listRecipes('u1'))[0]!;
    await expect(deleteRecipe('u1', sys.id)).rejects.toMatchObject({ errorCode: 'system_recipe_readonly' });
    db.state.tables.workflow_recipes.push({
      id: 'wfr-user', owner_id: 'u1', name: 'My recipe', description: null, event_source: 'github', event_type: 'push',
      conditions: {}, template: [{ type: 'notify' }], system: false, version: 1,
      created_at: '2026-08-19T09:00:00.000Z', updated_at: '2026-08-19T09:00:00.000Z',
    });
    await deleteRecipe('u1', 'wfr-user');
    expect(db.state.tables.workflow_recipes.some((r) => r.id === 'wfr-user')).toBe(false);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'workflow.recipe_deleted' }));
  });
});

describe('webhook authentication', () => {
  const sign = (secret: string, body: Buffer) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const headers = (over: Record<string, string> = {}) => ({ ...over });

  it('creates webhook secrets storing only hashes and encrypted keys', async () => {
    const { secret, plaintextSecret } = await createWebhookSecret('u1', { source: 'github', name: 'GH', repo: 'acme/repo' });
    expect(secret.id).toMatch(/^whk_/);
    expect(plaintextSecret).toHaveLength(64);
    const row = db.state.tables.webhook_secrets[0]!;
    expect(row.secret_hash).not.toBe(plaintextSecret);
    expect(row.hmac_key).not.toContain(plaintextSecret);
    expect(row.secret_hash).toBe(crypto.createHash('sha256').update(plaintextSecret).digest('hex'));
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'webhook.secret_created' }));
    expect(await listWebhookSecrets('u1')).toHaveLength(1);
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['secret_hash', 'hmac_key']));
  });

  it('accepts a valid GitHub HMAC signature and maps event types', async () => {
    const { plaintextSecret } = await createWebhookSecret('u1', { source: 'github', name: 'GH', repo: 'acme/repo' });
    const body = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'acme/repo' }, issue: { title: 'bug', number: 7 } }));
    const result = await handleWebhook({
      source: 'github', rawBody: body,
      headers: headers({ 'x-hub-signature-256': sign(plaintextSecret, body), 'x-github-delivery': 'deliv-1', 'x-github-event': 'issues' }),
    });
    expect(result?.status).toBe('no_rules');
    expect(db.state.tables.event_log[0]).toMatchObject({ source: 'github', event_id: 'deliv-1', event_type: 'issue.opened', owner_id: 'u1' });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'webhook.verified', detail: expect.objectContaining({ eventId: 'deliv-1' }) }));
    expect(githubEventType('pull_request', 'opened')).toBe('pull_request.opened');
    expect(githubEventType('push', undefined)).toBe('push');
  });

  it('rejects a GitHub webhook with a bad signature and audits it', async () => {
    await createWebhookSecret('u1', { source: 'github', name: 'GH', repo: 'acme/repo' });
    const body = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'acme/repo' } }));
    await expect(handleWebhook({
      source: 'github', rawBody: body,
      headers: headers({ 'x-hub-signature-256': sign('wrong-secret', body), 'x-github-delivery': 'deliv-2', 'x-github-event': 'issues' }),
    })).rejects.toMatchObject({ errorCode: 'invalid_signature' });
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'webhook.signature_invalid', detail: expect.objectContaining({ source: 'github', repo: 'acme/repo' }) }));
  });

  it('requires a signature and delivery id, and returns null for unregistered repos', async () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened', repository: { full_name: 'acme/repo' } }));
    await expect(handleWebhook({ source: 'github', rawBody: body, headers: headers({ 'x-github-delivery': 'd1' }) })).rejects.toMatchObject({ errorCode: 'webhook_auth_required' });
    await createWebhookSecret('u1', { source: 'github', name: 'GH', repo: 'other/repo' });
    const sig = sign('anything', body);
    const result = await handleWebhook({ source: 'github', rawBody: body, headers: headers({ 'x-hub-signature-256': sig, 'x-github-delivery': 'd2' }) });
    expect(result).toBeNull();
  });

  it('accepts a valid Sentry HMAC and ingests it as a plugin event', async () => {
    const { plaintextSecret } = await createWebhookSecret('u1', { source: 'sentry', name: 'Sentry' });
    const body = Buffer.from(JSON.stringify({ event: { event_id: 'sentry-1' }, level: 'error', error: { title: 'boom', message: 'x' } }));
    const result = await handleWebhook({
      source: 'sentry', rawBody: body,
      headers: headers({ 'x-sentry-signature': crypto.createHmac('sha256', plaintextSecret).update(body).digest('hex') }),
    });
    expect(result?.status).toBe('no_rules');
    expect(db.state.tables.event_log[0]).toMatchObject({ source: 'plugin', event_id: 'sentry-1', event_type: 'sentry.error' });
  });

  it('rejects Sentry webhooks with a bad signature', async () => {
    await createWebhookSecret('u1', { source: 'sentry', name: 'Sentry' });
    const body = Buffer.from(JSON.stringify({ event: { event_id: 'sentry-2' } }));
    await expect(handleWebhook({ source: 'sentry', rawBody: body, headers: headers({ 'x-sentry-signature': 'deadbeef' }) }))
      .rejects.toMatchObject({ errorCode: 'invalid_signature' });
  });

  it('authenticates bearer webhooks (deployment/plugin) with tenant resolution', async () => {
    const { plaintextSecret } = await createWebhookSecret('u1', { source: 'deployment', name: 'Vercel' });
    const body = Buffer.from(JSON.stringify({ status: 'success', app: 'web' }));
    const result = await handleWebhook({
      source: 'deployment', rawBody: body,
      headers: headers({ authorization: `Bearer ${plaintextSecret}`, 'x-event-id': 'dep-1', 'x-event-type': 'deployment.success' }),
    });
    expect(result?.status).toBe('no_rules');
    expect(db.state.tables.event_log[0]).toMatchObject({ source: 'deployment', event_id: 'dep-1', event_type: 'deployment.success', owner_id: 'u1' });
  });

  it('rejects bearer webhooks with a bad token, missing ids, or a disabled secret', async () => {
    const { plaintextSecret } = await createWebhookSecret('u1', { source: 'plugin', name: 'P' });
    const body = Buffer.from(JSON.stringify({}));
    await expect(handleWebhook({ source: 'plugin', rawBody: body, headers: headers({ authorization: 'Bearer wrong' }) })).rejects.toMatchObject({ errorCode: 'invalid_token' });
    await expect(handleWebhook({ source: 'plugin', rawBody: body, headers: headers({ authorization: 'Bearer nope' }) })).rejects.toMatchObject({ errorCode: 'invalid_token' });
    await expect(handleWebhook({ source: 'plugin', rawBody: body, headers: headers({ authorization: `Bearer ${plaintextSecret}` }) })).rejects.toMatchObject({ errorCode: 'missing_event_id' });
    await setWebhookSecretEnabled('u1', String(db.state.tables.webhook_secrets[0]?.id), false);
    await expect(handleWebhook({
      source: 'plugin', rawBody: body,
      headers: headers({ authorization: `Bearer ${plaintextSecret}`, 'x-event-id': 'e1', 'x-event-type': 't' }),
    })).rejects.toMatchObject({ errorCode: 'invalid_token' });
  });

  it('webhook replay is rejected end-to-end via the event log', async () => {
    const { plaintextSecret } = await createWebhookSecret('u1', { source: 'deployment', name: 'Vercel' });
    const body = Buffer.from(JSON.stringify({ status: 'success' }));
    const opts = {
      source: 'deployment' as const, rawBody: body,
      headers: headers({ authorization: `Bearer ${plaintextSecret}`, 'x-event-id': 'dep-1', 'x-event-type': 'deployment.success' }),
    };
    const first = await handleWebhook(opts);
    expect(first?.status).toBe('no_rules');
    const second = await handleWebhook(opts);
    expect(second?.status).toBe('duplicate');
    expect(db.state.tables.event_log).toHaveLength(1);
  });

  it('deletes webhook secrets with audit and rejects foreign deletes', async () => {
    await createWebhookSecret('u1', { source: 'webhook', name: 'W' });
    await expect(deleteWebhookSecret('u2', String(db.state.tables.webhook_secrets[0]?.id))).rejects.toMatchObject({ errorCode: 'not_found' });
    await deleteWebhookSecret('u1', String(db.state.tables.webhook_secrets[0]?.id));
    expect(db.state.tables.webhook_secrets).toHaveLength(0);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'webhook.secret_deleted' }));
  });
});

describe('internal emit hooks', () => {
  it('task and schedule hooks fire events and never throw', async () => {
    const executor = await import('../modules/automations/executor.js');
    const spy = vi.spyOn(executor, 'ingestEvent').mockResolvedValue({ status: 'no_rules' });
    seedRule();
    await expect(emitTaskCompleted('u1', { id: 't-1', title: 'T' })).resolves.toBeUndefined();
    await expect(emitTaskFailed('u1', { id: 't-1', title: 'T' }, 'boom')).resolves.toBeUndefined();
    await expect(emitScheduleExecuted('u1', { id: 'sch-1', title: 'S' }, 'sr-1')).resolves.toBeUndefined();
    await expect(emitScheduleFailed('u1', { id: 'sch-1', title: 'S' }, 'boom', 'sr-2')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(4);
    expect(spy.mock.calls[0]![0]).toMatchObject({ source: 'task_completed', eventId: 'task-completed-t-1', eventType: 'task.completed', ownerId: 'u1' });
    expect(spy.mock.calls[2]![0]).toMatchObject({ source: 'schedule', eventId: 'schedule-executed-sch-1-sr-1', eventType: 'schedule.executed' });
    spy.mockRestore();
  });

  it('emit hooks swallow executor failures so the caller is never broken', async () => {
    const executor = await import('../modules/automations/executor.js');
    const spy = vi.spyOn(executor, 'ingestEvent').mockRejectedValue(new Error('db down'));
    await expect(emitTaskCompleted('u1', { id: 't-2', title: 'T' })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('run history and watchdog sweep', () => {
  it('persists run history with owner scoping', async () => {
    seedRule({ actions: [{ type: 'create_task', agentId: 'agt-1', objective: 'x' }] });
    await ingestEvent(CTX());
    const runs = await listRuns('u1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'COMPLETED', event_id: 'evt-github-1', event_type: 'issue.opened' });
    await expect(getRun('u2', runs[0]!.id)).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('sweepAutomations expires old events and resets stale run budgets', async () => {
    db.state.tables.event_log.push({ id: 'evt-1', owner_id: 'u1', source: 'github', event_id: 'e1', event_type: 't', payload: {}, status: 'PROCESSED', reason: null, created_at: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() });
    seedRule({ run_count: 5, run_count_reset_at: new Date(Date.now() - 2 * 3600 * 1000) });
    const result = await sweepAutomations();
    expect(result.expiredEvents).toBe(1);
    expect(db.state.tables.event_log).toHaveLength(0);
    expect(result.resetBudgets).toBe(1);
    expect(db.state.tables.automation_rules[0]?.run_count).toBe(0);
  });
});