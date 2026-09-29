/**
 * Stage 26 — decision memory, cross-project patterns, handoffs, timeline.
 * Covers: decision replay (historical evidence only — NEVER generated),
 * deterministic conflict detection, high-impact replacement approval gate,
 * cross-project opt-in + tenant-scoped suggestions, handoff export from
 * REAL state, and the aggregate timeline. DB is mocked; this suite validates
 * the Stage 26B drivers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditAction } from '@codeconclave/shared';

const db = vi.hoisted(() => {
  const state: { rows: unknown[]; resolve: ((text: string, params: unknown[]) => unknown[] | null) | null } = {
    rows: [],
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = state.resolve ? state.resolve(text, params) : state.rows;
    return { rows: rows ?? [], rowCount: 0 };
  };
  const queryRows = async (text: string, params: unknown[] = []) => (await query(text, params)).rows;
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    withTenant: async (_u: string, fn: (q: { query: typeof query }) => Promise<unknown> | unknown) => fn?.({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown> | unknown) => fn?.({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock('../modules/audit/service.js', () => audit);

import {
  recordDecision,
  replayDecision,
  detectConflict,
  resolveConflict,
  listConflicts,
  listDecisions,
  getDecision,
} from '../modules/memory/decisions.js';
import {
  getCrossProjectOptIn,
  setCrossProjectOptIn,
  addPattern,
  suggestPatterns,
  generateHandoff,
  saveHandoff,
  listHandoffs,
  getHandoff,
  deleteHandoff,
  getTimeline,
} from '../modules/memory/continuity.js';
import { AppError } from '../shared/errors.js';

const DECISION = (over: Record<string, unknown> = {}) => ({
  id: 'dec-1',
  owner_id: 'u1',
  project_id: 'p1',
  title: 'Adopt Redis cache strategy',
  decision: 'Use Redis for session caching',
  context: null,
  alternatives: ['memcached'],
  rationale: null,
  consequences: ['redis dependency'],
  source_conversation_id: null,
  source_task_id: null,
  evidence_ref: null,
  impact: 'MEDIUM',
  superseded_by_id: null,
  deleted_at: null,
  created_at: new Date('2026-02-01T00:00:00Z'),
  updated_at: new Date('2026-02-01T00:00:00Z'),
  ...over,
});

beforeEach(() => {
  audit.recordAudit.mockClear();
  db.state.rows = [];
  db.state.resolve = null;
});

describe('DECISION REPLAY — historical evidence only', () => {
  it('finds a matching recorded decision by significant-token overlap', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM agent_decisions') ? [DECISION()] : null);
    const result = await replayDecision('u1', 'Should we adopt redis cache now?');
    expect(result.outcome).toBe('FOUND');
    expect(result.decision?.title).toBe('Adopt Redis cache strategy');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.DECISION_REPLAYED,
      detail: expect.objectContaining({ outcome: 'FOUND' }),
    }));
  });

  it('returns HISTORICAL_EVIDENCE_NOT_FOUND instead of inventing an answer', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM agent_decisions') ? [DECISION()] : null);
    const result = await replayDecision('u1', 'Should we migrate to postgres streaming?');
    expect(result.outcome).toBe('HISTORICAL_EVIDENCE_NOT_FOUND');
    expect(result.decision).toBeUndefined();
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ outcome: 'HISTORICAL_EVIDENCE_NOT_FOUND' }),
    }));
  });

  it('requires a query', async () => {
    await expect(replayDecision('u1', '  ')).rejects.toMatchObject({ errorCode: 'query_required' });
  });
});

describe('DECISION RECORDING', () => {
  it('records a decision with audit and returns the row', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('INSERT INTO agent_decisions')) return [];
      if (text.includes('FROM agent_decisions')) return [DECISION({ id: 'dec-new' })];
      return null;
    };
    const d = await recordDecision('u1', {
      title: 'Adopt Redis cache strategy',
      decision: 'Use Redis for session caching',
      projectId: 'p1',
      impact: 'HIGH',
    });
    expect(d.id).toBe('dec-new');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: AuditAction.DECISION_RECORDED,
      detail: expect.objectContaining({ impact: 'HIGH' }),
    }));
  });

  it('rejects empty titles and decisions', async () => {
    await expect(recordDecision('u1', { title: '', decision: 'x' })).rejects.toMatchObject({ errorCode: 'decision_title_required' });
    await expect(recordDecision('u1', { title: 't', decision: ' ' })).rejects.toMatchObject({ errorCode: 'decision_required' });
  });
});

describe('CONFLICT DETECTION — deterministic overlap', () => {
  it('flags a request contradicting a recorded decision (3+ shared tokens)', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM agent_decisions') ? [DECISION()] : null);
    const { conflicts } = await detectConflict('u1', 'Adopt redis cache for sessions immediately');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].affectedDecision.id).toBe('dec-1');
    expect(conflicts[0].contradiction).toContain('Adopt Redis cache strategy');
    expect(db.state.resolve).not.toBeNull();
  });

  it('does not flag unrelated requests', async () => {
    db.state.resolve = (text: string) => (text.includes('FROM agent_decisions') ? [DECISION()] : null);
    const { conflicts } = await detectConflict('u1', 'Add stripe payment integration');
    expect(conflicts).toHaveLength(0);
  });
});

describe('CONFLICT RESOLUTION — audited, approved replacements', () => {
  function wireConflict(over: Record<string, unknown> = {}) {
    const conflict: Record<string, unknown> = { id: 'cnf-1', owner_id: 'u1', decision_id: 'dec-1', request_text: 'x', status: 'OPEN', resolution: null, note: null, new_decision_id: null, resolved_at: null, created_at: new Date(), ...over };
    db.state.resolve = (text: string, params: unknown[] = []) => {
      if (text.includes('SELECT * FROM decision_conflicts')) return [conflict];
      if (text.includes('UPDATE decision_conflicts')) {
        conflict.status = 'RESOLVED';
        conflict.resolution = String(params[0]);
        conflict.note = params[1] === null ? null : String(params[1]);
        conflict.new_decision_id = params[2] === null ? null : String(params[2]);
        conflict.resolved_at = new Date();
        return [];
      }
      if (text.includes('UPDATE agent_decisions')) return [];
      if (text.includes('FROM agent_decisions')) return [DECISION({ impact: over.impact ?? 'MEDIUM' })];
      return null;
    };
    return conflict;
  }

  it('KEEP resolves the open conflict without side effects', async () => {
    wireConflict();
    const conflict = await resolveConflict('u1', 'cnf-1', { resolution: 'KEEP' });
    expect(conflict.resolution).toBe('KEEP');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DECISION_CONFLICT_RESOLVED }));
  });

  it('replacing a HIGH-impact decision requires explicit approval', async () => {
    wireConflict({ impact: 'HIGH' });
    await expect(
      resolveConflict('u1', 'cnf-1', { resolution: 'REPLACE', replacement: { title: 'New', decision: 'Body' } }),
    ).rejects.toMatchObject({ errorCode: 'approval_required' });
  });

  it('REPLACE with approval supersedes the old decision', async () => {
    const conflict = wireConflict({ impact: 'HIGH' });
    const resolved = await resolveConflict('u1', 'cnf-1', {
      resolution: 'REPLACE',
      approved: true,
      replacement: { title: 'Use Postgres', decision: 'Switch to Postgres', impact: 'HIGH' },
    });
    expect(resolved.resolution).toBe('REPLACE');
    expect(conflict.status).toBe('RESOLVED');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.DECISION_CONFLICT_RESOLVED }));
  });
});

describe('DECISION READS', () => {
  it('lists and gets decisions scoped to the owner', async () => {
    db.state.rows = [DECISION()];
    const list = await listDecisions('u1');
    expect(list).toHaveLength(1);
    db.state.rows = [];
    await expect(getDecision('u1', 'missing')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});
describe('CROSS-PROJECT PATTERNS — opt-in, tenant-scoped', () => {
  it('opt-in defaults to off and toggling is audited', async () => {
    db.state.resolve = (text: string) => (text.includes('SELECT cross_project_memory_opt_in') ? [{ cross_project_memory_opt_in: false }] : null);
    expect(await getCrossProjectOptIn('u1')).toBe(false);
    db.state.resolve = (text: string) => (text.includes('UPDATE users') ? [] : null);
    expect(await setCrossProjectOptIn('u1', true)).toBe(true);
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.CROSS_PROJECT_OPT_IN_CHANGED, detail: { enabled: true } }));
  });

  it('suggests nothing while opt-out (no data leakage)', async () => {
    db.state.resolve = (text: string) => (text.includes('SELECT cross_project_memory_opt_in') ? [{ cross_project_memory_opt_in: false }] : null);
    const { suggestions, optIn } = await suggestPatterns('u1', 'p1');
    expect(suggestions).toHaveLength(0);
    expect(optIn).toBe(false);
  });

  it('suggests only patterns from OTHER projects when opted in', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('SELECT cross_project_memory_opt_in')) return [{ cross_project_memory_opt_in: true }];
      if (text.includes('FROM cross_project_patterns')) {
        return [{ id: 'xpp-1', owner_id: 'u1', source_project_id: 'p2', name: 'Retry with backoff', pattern: 'Use exponential backoff', tag: 'resilience', proven: true, applied_count: 3, created_at: new Date() }];
      }
      return null;
    };
    const { suggestions, optIn } = await suggestPatterns('u1', 'p1', 'resilience');
    expect(optIn).toBe(true);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].source_project_id).toBe('p2');
    expect(audit.recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.CROSS_PROJECT_SUGGESTED }));
  });

  it('validates pattern input', async () => {
    await expect(addPattern('u1', { sourceProjectId: 'p1', name: '  ', pattern: 'x' })).rejects.toMatchObject({ errorCode: 'pattern_required' });
  });
});

describe('HANDOFFS — exported from real state, saved for review', () => {
  it('generates a handoff from DNA, decisions, tasks and runs — audited', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM projects')) return [{ name: 'Acme' }];
      if (text.includes('FROM dna')) return [{ kind: 'DECISION', title: 'Redis', content: 'Use Redis', updated_at: '2026-02-01' }];
      if (text.includes('FROM agent_decisions')) return [{ title: 'Adopt Redis cache strategy', decision: 'Use Redis', impact: 'MEDIUM', created_at: '2026-02-01' }];
      if (text.includes('FROM tasks')) return [{ title: 'Wire Redis', status: 'RUNNING', created_at: '2026-02-01' }];
      if (text.includes('FROM ai_agent_runs')) return [{ objective: 'Ship cache', status: 'RUNNING', created_at: '2026-02-01' }];
      return null;
    };
    const handoff = await generateHandoff('u1', 'p1');
    expect(handoff.title).toContain('Acme');
    expect(handoff.content).toContain('Wire Redis');
    expect(handoff.content).toContain('Adopt Redis cache strategy');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.HANDOFF_EXPORTED }));
  });

  it('saves, lists, gets and deletes handoffs (owner-scoped)', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('INSERT INTO handoffs')) return [];
      if (text.includes('FROM handoffs')) return [{ id: 'hnd-1', owner_id: 'u1', project_id: 'p1', title: 'Handoff', content: 'body', created_at: new Date() }];
      return null;
    };
    const saved = await saveHandoff('u1', { projectId: 'p1', title: 'Handoff', content: 'body' });
    expect(saved.id).toBe('hnd-1');
    expect(audit.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: AuditAction.HANDOFF_SAVED }));
    const list = await listHandoffs('u1');
    expect(list).toHaveLength(1);
    const one = await getHandoff('u1', 'hnd-1');
    expect(one.title).toBe('Handoff');
    await deleteHandoff('u1', 'hnd-1');
  });
});

describe('TIMELINE — aggregates existing tables, newest first', () => {
  it('merges tasks, runs, decisions, previews, debates and audit events sorted desc', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM tasks')) return [{ id: 'tsk-1', title: 'Fix bug', status: 'COMPLETED', created_at: '2026-02-01T10:00:00Z' }];
      if (text.includes('FROM ai_agent_runs')) return [{ id: 'run-1', objective: 'Ship', status: 'COMPLETED', created_at: '2026-02-01T12:00:00Z' }];
      if (text.includes('FROM preview_sessions')) return [{ id: 'pv-1', state: 'READY', created_at: '2026-02-01T09:00:00Z' }];
      if (text.includes('FROM agent_decisions')) return [{ id: 'dec-1', title: 'Adopt Redis', impact: 'MEDIUM', created_at: '2026-02-01T11:00:00Z' }];
      if (text.includes('FROM agent_debates')) return [{ id: 'dbt-1', prompt: 'Which cache', status: 'COMPLETED', created_at: '2026-02-01T08:00:00Z' }];
      if (text.includes('FROM audit_logs')) return [{ id: 'log-1', action: 'marketplace.installed', created_at: '2026-02-01T13:00:00Z' }];
      return null;
    };
    const items = await getTimeline('u1', { since: '2026-02-01T00:00:00Z' });
    expect(items).toHaveLength(6);
    expect(items[0].type).toBe('audit');
    expect(items[0].at).toBe('2026-02-01T13:00:00Z');
    const ats = items.map((i) => i.at);
    expect(ats).toEqual([...ats].sort().reverse());
  });

  it('respects the limit', async () => {
    db.state.resolve = (text: string) => {
      if (text.includes('FROM tasks')) return [{ id: 'tsk-1', title: 'A', status: 'RUNNING', created_at: '2026-02-01T10:00:00Z' }];
      if (text.includes('FROM ai_agent_runs')) return [{ id: 'run-1', objective: 'B', status: 'RUNNING', created_at: '2026-02-01T11:00:00Z' }];
      return null;
    };
    const items = await getTimeline('u1', { since: '2026-02-01T00:00:00Z', limit: 1 });
    expect(items).toHaveLength(1);
  });
});