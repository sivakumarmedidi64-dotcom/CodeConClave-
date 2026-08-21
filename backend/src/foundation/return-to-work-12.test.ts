/**
 * CodeConClave — Phase 12 continuity tests: workspace multi-device
 * reconciliation + the "While You Were Away" return-to-work experience.
 * DB mocked; gateway/registry mocked (AI summarization is optional and must
 * degrade to a deterministic narrative without providers).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback: vi.fn() }));
vi.mock('../modules/ai/registry.js', () => ({ configuredProviders: vi.fn() }));

import { completeWithFallback } from '../modules/ai/gateway.js';
import { configuredProviders } from '../modules/ai/registry.js';
import {
  mergeWorkspaceValues,
  reconcileWorkspaceState,
  restoreWorkspaceState,
} from '../modules/workspace/service.js';
import {
  getReturnToWorkConfig,
  updateReturnToWorkConfig,
  getReturnToWork,
  markReturnToWorkRead,
  dismissReturnToWork,
} from '../modules/returnToWork/service.js';

const stateRow = (key: string, value: Record<string, unknown>, version: number) => ({
  key,
  value,
  version,
  updated_at: new Date(),
});

function summaryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'rtw1',
    owner_id: 'u1',
    generated_at: new Date(Date.now() - 2 * 3600e3),
    absence_start: new Date(Date.now() - 30 * 3600e3),
    absence_end: new Date(),
    project_id: null,
    frequency: 'daily',
    completed_count: 1,
    failed_count: 0,
    pending_approval_count: 0,
    modified_file_count: 0,
    discovery_count: 0,
    memory_update_count: 0,
    dna_update_count: 0,
    project_activity_count: 0,
    unread_notification_count: 0,
    evidence: { recommendedActions: [] },
    summary_text: 'While you were away: 1 task completed.',
    ai_generated: false,
    read: false,
    dismissed: false,
    ...over,
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  vi.mocked(configuredProviders).mockReturnValue([]);
  vi.mocked(completeWithFallback).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------- deterministic merge

describe('mergeWorkspaceValues — deterministic reconciliation', () => {
  it('keeps the server value on scalar conflicts and reports the dropped path', () => {
    const { merged, dropped } = mergeWorkspaceValues(
      { mode: 'COWORK', count: 5 },
      { mode: 'CHAT' },
    );
    expect(merged).toEqual({ mode: 'COWORK', count: 5 });
    expect(dropped).toEqual(['mode']);
  });

  it('adopts client-only keys without dropping them', () => {
    const { merged, dropped } = mergeWorkspaceValues({ mode: 'COWORK' }, { color: 'red' });
    expect(merged).toEqual({ mode: 'COWORK', color: 'red' });
    expect(dropped).toEqual([]);
  });

  it('merges nested plain objects recursively', () => {
    const { merged, dropped } = mergeWorkspaceValues(
      { nested: { x: 1, y: 2 } },
      { nested: { x: 9, z: 3 } },
    );
    expect(merged).toEqual({ nested: { x: 1, y: 2, z: 3 } });
    expect(dropped.sort()).toEqual(['nested.x']);
  });

  it('treats arrays as atomic — server wins', () => {
    const { merged, dropped } = mergeWorkspaceValues(
      { tabs: ['a', 'b'] },
      { tabs: ['c'] },
    );
    expect(merged).toEqual({ tabs: ['a', 'b'] });
    expect(dropped).toEqual(['tabs']);
  });
});

// ---------------------------------------------------------------- workspace reconcile / restore

describe('reconcileWorkspaceState — multi-device writes', () => {
  it('applies directly when the base version matches', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM workspace_state')) return [stateRow('k', { mode: 'COWORK' }, 1)];
      if (text.includes('UPDATE workspace_state')) return [stateRow('k', { mode: 'COWORK', count: 5 }, 2)];
      return null;
    };
    const result = await reconcileWorkspaceState('u1', 'k', { mode: 'COWORK', count: 5 }, 1);
    expect(result.reconciled).toBe(false);
    expect(result.entry.version).toBe(2);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE workspace_state'))!;
    expect(update.text).toContain('WHERE owner_id = $1 AND key = $2 AND version = $4');
    expect(update.params[3]).toBe(1);
  });

  it('preserves the server state and merges the client version on mismatch', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM workspace_state')) {
        return [stateRow('k', { mode: 'COWORK', count: 5, nested: { x: 1 } }, 2)];
      }
      if (text.includes('INSERT INTO workspace_state')) {
        return [stateRow('k', { mode: 'COWORK', count: 5, color: 'red', nested: { x: 1 } }, 3)];
      }
      return null;
    };
    const result = await reconcileWorkspaceState('u1', 'k', { mode: 'CHAT', color: 'red', nested: { x: 9 } }, 1);
    expect(result.reconciled).toBe(true);
    expect(result.currentVersion).toBe(2);
    expect(result.dropped.sort()).toEqual(['mode', 'nested.x']);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO workspace_state'))!;
    const stored = JSON.parse(insert.params[3] as string);
    expect(stored).toEqual({ mode: 'COWORK', count: 5, color: 'red', nested: { x: 1 } });
  });

  it('never silently overwrites — every dropped path is reported', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM workspace_state')) return [stateRow('k', { mode: 'COWORK' }, 4)];
      if (text.includes('INSERT INTO workspace_state')) return [stateRow('k', { mode: 'COWORK' }, 5)];
      return null;
    };
    const result = await reconcileWorkspaceState('u1', 'k', { mode: 'CHAT' }, 3);
    expect(result.reconciled).toBe(true);
    expect(result.dropped).toEqual(['mode']);
  });

  it('both devices preserve the server value and lose nothing (deterministic merge)', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM workspace_state')) return [stateRow('k', { mode: 'COWORK' }, 2)];
      if (text.includes('INSERT INTO workspace_state')) return [stateRow('k', JSON.parse(params[3] as string), 3)];
      return null;
    };
    const a = await reconcileWorkspaceState('u1', 'k', { color: 'red' }, 1);
    const b = await reconcileWorkspaceState('u1', 'k', { volume: 9 }, 1);
    expect(a.entry.value).toEqual({ mode: 'COWORK', color: 'red' });
    expect(b.entry.value).toEqual({ mode: 'COWORK', volume: 9 });
  });
});

describe('restoreWorkspaceState — bulk snapshot restore', () => {
  it('applies every entry and reports only reconciled conflicts', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM workspace_state') && text.includes('key = $2')) {
        return [stateRow('mode', { mode: 'COWORK' }, 2)];
      }
      if (text.includes('INSERT INTO workspace_state')) {
        return [stateRow('mode', { mode: 'COWORK', color: 'red' }, 3)];
      }
      return null;
    };
    const result = await restoreWorkspaceState('u1', [
      { key: 'mode', value: { mode: 'CHAT' }, baseVersion: 1 },
      { key: 'scroll', value: { top: 420 }, baseVersion: undefined },
    ]);
    expect(result.applied.length).toBe(2);
    expect(result.conflicts).toEqual([{ key: 'mode', currentVersion: 2 }]);
  });
});

// ---------------------------------------------------------------- return-to-work config

describe('return-to-work configuration', () => {
  it('defaults to daily, 6h threshold, no project scope', async () => {
    db.state.resolve = (text) => (text.includes('FROM user_preferences') ? [{ prefs: {} }] : null);
    await expect(getReturnToWorkConfig('u1')).resolves.toEqual({
      frequency: 'daily',
      thresholdHours: 6,
      projectScope: null,
    });
  });

  it('reads persisted frequency / threshold / scope', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM user_preferences')
        ? [{ prefs: { return_to_work: { frequency: 'weekly', thresholdHours: 12, projectScope: 'p1' } } }]
        : null;
    await expect(getReturnToWorkConfig('u1')).resolves.toEqual({
      frequency: 'weekly',
      thresholdHours: 12,
      projectScope: 'p1',
    });
  });

  it('updates the persisted config', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM user_preferences')
        ? [{ prefs: { return_to_work: { frequency: 'daily', thresholdHours: 6, projectScope: null } }, version: 1, updated_at: new Date() }]
        : null;
    const config = await updateReturnToWorkConfig('u1', { frequency: 'off' });
    expect(config.frequency).toBe('off');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO user_preferences'))!;
    const stored = JSON.parse(insert.params[2] as string);
    expect(stored.return_to_work).toEqual({ frequency: 'off', thresholdHours: 6, projectScope: null });
  });
});

// ---------------------------------------------------------------- while you were away

describe('while you were away — eligibility + evidence', () => {
  const absentHours = (h: number) => ({ value: { at: new Date(Date.now() - h * 3600e3).toISOString() } });

  function evidenceResolve(latest: unknown[] = [], absentAt: Record<string, unknown> | null = absentHours(10)) {
    return (text: string, params: unknown[]): unknown[] | null => {
      if (text.includes('FROM return_to_work_summaries') && text.includes('ORDER BY generated_at DESC')) return latest;
      if (text.includes('FROM return_to_work_summaries')) {
        const insertCall = db.state.calls.find((c) => c.text.includes('INSERT INTO return_to_work_summaries'));
        if (!insertCall) return [];
        const p = insertCall.params;
        return [
          {
            id: p[0],
            owner_id: p[1],
            generated_at: p[2],
            absence_start: p[3],
            absence_end: p[4],
            project_id: p[5],
            frequency: p[6],
            completed_count: p[7],
            failed_count: p[8],
            pending_approval_count: p[9],
            modified_file_count: p[10],
            discovery_count: p[11],
            memory_update_count: p[12],
            dna_update_count: p[13],
            project_activity_count: p[14],
            unread_notification_count: p[15],
            evidence: JSON.parse(p[16] as string),
            summary_text: p[17],
            ai_generated: p[18],
            read: false,
            dismissed: false,
          },
        ];
      }
      if (text.includes('FROM workspace_state')) return absentAt ? [absentAt] : [];
      if (text.includes("status = 'COMPLETED'")) {
        return [
          { id: 't1', title: 'Fix login', project_id: 'p1', attempt_count: 1 },
          { id: 't2', title: 'Retry deploy', project_id: 'p1', attempt_count: 2 },
        ];
      }
      if (text.includes("status IN ('FAILED','TIMED_OUT')")) {
        return [{ id: 't3', title: 'Deploy', status: 'FAILED', recovery_status: 'NONE' }];
      }
      if (text.includes('FROM approvals a')) return [{ id: 'a1', task_id: 't1', risk_level: 'MEDIUM' }];
      if (text.includes('FROM file_versions')) return [{ n: 3 }];
      if (text.includes('FROM coworker_runs')) {
        return [{ id: 'cr1', coworker_type: 'RESEARCH', completed_at: new Date(), task_id: 't1' }];
      }
      if (text.includes('FROM memories')) return [{ n: 2 }];
      if (text.includes('FROM dna')) return [{ n: 1 }];
      if (text.includes('FROM project_activity')) return [{ n: 4 }];
      if (text.includes('FROM notifications')) return [{ n: 5 }];
      if (text.includes('FROM tasks')) return [{ id: 't9', title: 'Build' }];
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      return null;
    };
  }

  it('is disabled entirely when frequency is off', async () => {
    db.state.resolve = (text) =>
      text.includes('FROM user_preferences') ? [{ prefs: { return_to_work: { frequency: 'off' } } }] : null;
    const res = await getReturnToWork('u1');
    expect(res.summary).toBeNull();
    expect(res.eligibility).toEqual({ eligible: false, reason: 'disabled' });
  });

  it('returns nothing below the absence threshold', async () => {
    db.state.resolve = evidenceResolve([], absentHours(1));
    const res = await getReturnToWork('u1');
    expect(res.summary).toBeNull();
    expect(res.eligibility.reason).toBe('absence_below_threshold');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO return_to_work_summaries'))).toBe(false);
  });

  it('generates a summary from persisted evidence only when absent long enough', async () => {
    db.state.resolve = evidenceResolve([], absentHours(10));
    const res = await getReturnToWork('u1');
    expect(res.eligibility).toEqual({ eligible: true, reason: 'generated' });
    expect(res.summary).not.toBeNull();
    expect(res.summary!.counts).toEqual({
      completed: 2,
      failed: 1,
      pendingApprovals: 1,
      modifiedFiles: 3,
      discoveries: 1,
      memoryUpdates: 2,
      dnaUpdates: 1,
      projectActivity: 4,
      unreadNotifications: 5,
    });
    expect(res.summary!.evidence).toMatchObject({
      completedTasks: [{ id: 't1', recovered: false }, { id: 't2', recovered: true }],
      failedTasks: [{ id: 't3' }],
      pendingApprovals: [{ id: 'a1' }],
      discoveries: [{ id: 'cr1', coworkerType: 'RESEARCH' }],
    });
    expect(res.summary!.recommendedActions.map((a) => a.type)).toEqual([
      'open_approvals',
      'review_failures',
      'review_completed',
      'review_research',
      'resume_task',
    ]);
    expect(res.summary!.aiGenerated).toBe(false);
    expect(res.summary!.summaryText).toContain('While you were away');
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO return_to_work_summaries'))!;
    expect(insert).toBeDefined();
  });

  it('serves the recent summary instead of regenerating within the daily cap', async () => {
    const latest = [summaryRow({ generated_at: new Date(Date.now() - 10 * 3600e3) })];
    db.state.resolve = evidenceResolve(latest, absentHours(10));
    const res = await getReturnToWork('u1');
    expect(res.eligibility.reason).toBe('recent_summary');
    expect(res.summary!.id).toBe('rtw1');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO return_to_work_summaries'))).toBe(false);
  });

  it('regenerates when the weekly window has elapsed', async () => {
    const latest = [summaryRow({ generated_at: new Date(Date.now() - 8 * 24 * 3600e3), frequency: 'weekly' })];
    db.state.resolve = (text) => {
      if (text.includes('FROM user_preferences')) {
        return [{ prefs: { return_to_work: { frequency: 'weekly', thresholdHours: 6, projectScope: null } } }];
      }
      return evidenceResolve(latest, absentHours(10))(text);
    };
    const res = await getReturnToWork('u1');
    expect(res.eligibility.reason).toBe('generated');
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO return_to_work_summaries'))).toBe(true);
  });

  it('never shows a dismissed summary again', async () => {
    const latest = [summaryRow({ dismissed: true })];
    db.state.resolve = evidenceResolve(latest, absentHours(10));
    const res = await getReturnToWork('u1');
    expect(res.summary).toBeNull();
  });

  it('scopes evidence to the configured project', async () => {
    db.state.resolve = (text) => {
      if (text.includes('FROM user_preferences')) {
        return [{ prefs: { return_to_work: { frequency: 'daily', thresholdHours: 6, projectScope: 'p1' } } }];
      }
      return evidenceResolve([], absentHours(10))(text);
    };
    await getReturnToWork('u1');
    const completed = db.state.calls.find((c) => c.text.includes("status = 'COMPLETED'"))!;
    expect(completed.params).toContain('p1');
    const files = db.state.calls.find((c) => c.text.includes('FROM file_versions'))!;
    expect(files.text).toContain('f.project_id = $3');
  });

  it('falls back to the deterministic narrative when AI is unavailable', async () => {
    vi.mocked(configuredProviders).mockReturnValue(['anthropic']);
    vi.mocked(completeWithFallback).mockRejectedValue(new Error('provider down'));
    db.state.resolve = evidenceResolve([], absentHours(10));
    const res = await getReturnToWork('u1');
    expect(res.summary!.aiGenerated).toBe(false);
    expect(res.summary!.summaryText).toContain('While you were away');
  });

  it('uses the AI narrative when a provider responds — evidence only', async () => {
    vi.mocked(configuredProviders).mockReturnValue(['anthropic']);
    vi.mocked(completeWithFallback).mockResolvedValue({
      text: 'AI narrative of your absence',
      modelId: 'm',
      providerId: 'anthropic',
      inputTokens: 10,
      outputTokens: 20,
      estimatedCostUsd: 0,
      durationMs: 5,
      usedFallback: false,
      fallbackReason: null,
    });
    db.state.resolve = evidenceResolve([], absentHours(10));
    const res = await getReturnToWork('u1');
    expect(res.summary!.aiGenerated).toBe(true);
    expect(res.summary!.summaryText).toBe('AI narrative of your absence');
    const call = vi.mocked(completeWithFallback).mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    expect(call.messages[0]!.content).toContain('ONLY the evidence provided');
  });

  it('marks a summary read (server-authoritative)', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE return_to_work_summaries')) return [summaryRow({ read: true })];
      return null;
    };
    const summary = await markReturnToWorkRead('u1', 'rtw1');
    expect(summary.read).toBe(true);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE return_to_work_summaries'))!;
    expect(update.text).toContain('WHERE id = $1 AND owner_id = $2');
  });

  it('dismisses a summary and never serves it again', async () => {
    db.state.resolve = (text) => {
      if (text.includes('UPDATE return_to_work_summaries')) return [summaryRow({ dismissed: true })];
      return null;
    };
    const summary = await dismissReturnToWork('u1', 'rtw1');
    expect(summary.dismissed).toBe(true);
    const update = db.state.calls.find((c) => c.text.includes('UPDATE return_to_work_summaries'))!;
    expect(update.text).toContain('dismissed = true');
  });
});