/**
 * CodeConClave — PHASE 14 digest foundation tests.
 * Covers: timezone-aware local date/week keys, digest plan selection
 * (daily/weekly/none, DND, quiet hours incl. timezone), period idempotency,
 * evidence aggregation SQL contract (real tables), deterministic summary,
 * evidence-only AI narrative (only with a configured provider), email
 * suppression under DND/quiet hours with the outbox dedupe key, in-app
 * notification, and the sweep.
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
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
const createNotification = vi.hoisted(() => vi.fn(async () => ({ id: 'ntf1' })));
vi.mock('../modules/notifications/service.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../modules/notifications/service.js')>();
  return { ...mod, createNotification };
});
const enqueueOutbox = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox }));
const configuredProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock('../modules/ai/registry.js', () => ({ configuredProviders }));
const completeWithFallback = vi.hoisted(() => vi.fn(async () => ({ text: '' })));
vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback }));

import {
  localDateKey,
  isoWeekKey,
  periodKeyFor,
  digestPlanFor,
  deterministicDigestText,
  deliverDigest,
  sweepDigests,
} from '../modules/digests/service.js';

function prefsRow(prefs: Record<string, unknown>): Record<string, unknown> {
  return { prefs, version: 1, updated_at: new Date() };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 1;
  db.state.resolve = null;
  recordAudit.mockClear();
  createNotification.mockClear();
  enqueueOutbox.mockClear();
  configuredProviders.mockReturnValue([]);
  completeWithFallback.mockResolvedValue({ text: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('timezone helpers', () => {
  const now = new Date('2026-08-15T18:30:00.000Z');

  it('computes local date keys per timezone', () => {
    expect(localDateKey(now, 'Asia/Kolkata')).toBe('2026-08-16'); // UTC+5:30
    expect(localDateKey(now, 'America/New_York')).toBe('2026-08-15'); // UTC-4
    expect(localDateKey(now, undefined)).toBe('2026-08-15'); // UTC fallback
    expect(localDateKey(now, 'Not/AZone')).toBe('2026-08-15'); // invalid tz → UTC
  });

  it('computes ISO week keys', () => {
    expect(isoWeekKey('2026-08-15')).toBe('2026-W33');
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
  });

  it('periodKeyFor respects the frequency', () => {
    expect(periodKeyFor('daily', now, 'Asia/Kolkata')).toBe('2026-08-16');
    expect(periodKeyFor('weekly', now, 'Asia/Kolkata')).toBe('2026-W33');
  });
});

describe('digest plan selection', () => {
  it('prefers weekly over daily; timezone from prefs then quiet hours', async () => {
    const plan = await digestPlanFor('u1', { weekly_digest: true, daily_digest: true, timezone: 'Asia/Kolkata' });
    expect(plan).toMatchObject({ frequency: 'weekly', timezone: 'Asia/Kolkata', dnd: false });
    const plan2 = await digestPlanFor('u1', { daily_digest: true, quiet_hours: { start: '22:00', end: '08:00', timezone: 'America/New_York' } });
    expect(plan2.frequency).toBe('daily');
    expect(plan2.timezone).toBe('America/New_York');
  });

  it('reports none when no digest preference is set', async () => {
    const plan = await digestPlanFor('u1', { email: true });
    expect(plan.frequency).toBe('none');
  });

  it('treats quiet hours in the user timezone as DND', async () => {
    // 22:00–08:00 Asia/Kolkata; the instant 2026-08-15T18:30Z = 16 Aug 00:00 IST → inside.
    const plan = await digestPlanFor(
      'u1',
      {
        quiet_hours: { start: '22:00', end: '08:00', timezone: 'Asia/Kolkata' },
      },
      new Date('2026-08-15T18:30:00.000Z'),
    );
    expect(plan.dnd).toBe(true);
    const planOutside = await digestPlanFor(
      'u1',
      {
        quiet_hours: { start: '22:00', end: '08:00', timezone: 'Asia/Kolkata' },
      },
      new Date('2026-08-15T10:30:00.000Z'), // 16:00 IST → outside quiet hours
    );
    expect(planOutside.dnd).toBe(false);
  });
});

describe('deterministic summary', () => {
  it('lists real evidence counts only', () => {
    const text = deterministicDigestText({
      completedTasks: [{ id: 't1', title: 'A' }],
      failedTasks: [{ id: 't2', title: 'B', recoveryStatus: 'retry_succeeded' }],
      pendingApprovals: [{ id: 'a1', riskLevel: 'HIGH' }],
      counts: {
        completed: 1, failed: 1, recovered: 1, pendingApprovals: 1, projectActivity: 3,
        teamActivity: 2, research: 0, memoryUpdates: 1, dnaUpdates: 0, unreadNotifications: 2,
        messages: 5, aiCalls: 4, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.0012,
      },
    });
    expect(text).toContain('1 task completed');
    expect(text).toContain('1 task failed');
    expect(text).toContain('1 task recovered');
    expect(text).toContain('1 approval awaiting review');
    expect(text).toContain('3 project activity events');
    expect(text).toContain('2 team activity events');
    expect(text).toContain('5 messages');
    expect(text).toContain('4 AI calls');
    expect(text).toContain('estimated compute $0.0012');
    expect(text).toContain('2 unread notifications waiting');
  });
});

describe('deliverDigest', () => {
  function fullResolve(periodKey: string) {
    return (text: string): unknown[] | null => {
      if (text.includes('SELECT prefs FROM notification_preferences')) return [prefsRow({ daily_digest: true, email: true, timezone: 'Asia/Kolkata' })];
      if (text.includes('SELECT period_key FROM digest_deliveries')) return [];
      if (text.includes('FROM tasks')) return [{ id: 't1', title: 'Ship it', recovery_status: null }];
      if (text.includes('FROM approvals')) return [{ id: 'a1', risk_level: 'HIGH' }];
      if (text.includes('count(*)::int AS n')) return [{ n: 2 }];
      if (text.includes('FROM model_usage_logs')) return [{ input_tokens: 100, output_tokens: 50, cost: 0.0012, calls: 4 }];
      if (text.includes('FROM usage_events')) return [{ n: 5 }];
      if (text.includes('FROM digest_deliveries WHERE id = $1')) {
        return [{ id: 'dig1', owner_id: 'u1', frequency: 'daily', period_key: periodKey, period_start: new Date(), period_end: new Date(), evidence: {}, summary_text: 'digest', ai_generated: false, delivered_at: new Date(), created_at: new Date() }];
      }
      return null;
    };
  }

  it('delivers the daily digest with persisted evidence + in-app notification + email dedupe key', async () => {
    const now = new Date('2026-08-15T18:30:00.000Z');
    db.state.resolve = fullResolve('2026-08-16');
    const row = await deliverDigest('u1', 'daily', now);
    expect(row).toBeTruthy();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO digest_deliveries'))!;
    expect(insert.text).toContain('ON CONFLICT (owner_id, frequency, period_key)');
    expect(insert.params[3]).toBe('2026-08-16');
    // evidence queries hit the real tables
    const joined = db.state.calls.map((c) => c.text).join('\n');
    expect(joined).toContain('FROM tasks');
    expect(joined).toContain('FROM approvals');
    expect(joined).toContain('FROM project_activity');
    expect(joined).toContain('FROM team_activity');
    expect(joined).toContain('FROM coworker_runs');
    expect(joined).toContain('FROM memories');
    expect(joined).toContain('FROM dna');
    expect(joined).toContain('FROM notifications');
    expect(joined).toContain('FROM model_usage_logs');
    expect(joined).toContain('FROM usage_events');
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'digest.daily' }));
    expect(enqueueOutbox).toHaveBeenCalledWith(
      'digest.email',
      expect.objectContaining({ userId: 'u1' }),
      { dedupeKey: 'digest:u1:daily:2026-08-16' },
    );
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'digest.delivered' }));
  });

  it('never delivers the same period twice (idempotency)', async () => {
    const now = new Date('2026-08-15T18:30:00.000Z');
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs FROM notification_preferences')) {
        return [prefsRow({ daily_digest: true, timezone: 'Asia/Kolkata' })];
      }
      if (text.includes('SELECT period_key FROM digest_deliveries')) return [{ period_key: '2026-08-16' }];
      return null;
    };
    await expect(deliverDigest('u1', 'daily', now)).resolves.toBeNull();
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO digest_deliveries'))).toBe(false);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('suppresses the email under DND/quiet hours but still persists + notifies in-app', async () => {
    const now = new Date('2026-08-15T18:30:00.000Z');
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs FROM notification_preferences')) {
        return [prefsRow({ daily_digest: true, email: true, quiet_hours: { start: '22:00', end: '08:00', timezone: 'Asia/Kolkata' } })];
      }
      if (text.includes('SELECT period_key FROM digest_deliveries')) return [];
      if (text.includes('count(*)::int AS n')) return [{ n: 1 }];
      if (text.includes('FROM model_usage_logs')) return [{ input_tokens: 0, output_tokens: 0, cost: 0, calls: 0 }];
      if (text.includes('FROM usage_events')) return [{ n: 0 }];
      if (text.includes('FROM digest_deliveries WHERE id = $1')) {
        return [{ id: 'dig2', owner_id: 'u1', frequency: 'daily', period_key: '2026-08-16', period_start: new Date(), period_end: new Date(), evidence: {}, summary_text: 's', ai_generated: false, delivered_at: new Date(), created_at: new Date() }];
      }
      return null;
    };
    const row = await deliverDigest('u1', 'daily', now);
    expect(row).toBeTruthy();
    expect(createNotification).toHaveBeenCalled();
    expect(enqueueOutbox).not.toHaveBeenCalled();
  });

  it('produces an AI narrative only when a provider is configured (evidence-only)', async () => {
    const now = new Date('2026-08-15T18:30:00.000Z');
    configuredProviders.mockReturnValue(['anthropic']);
    completeWithFallback.mockResolvedValue({ text: 'AI evidence-based narrative' });
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs FROM notification_preferences')) return [prefsRow({ daily_digest: true })];
      if (text.includes('SELECT plan_id FROM users')) return [{ plan_id: 'free' }];
      if (text.includes('SELECT period_key FROM digest_deliveries')) return [];
      if (text.includes('count(*)::int AS n')) return [{ n: 0 }];
      if (text.includes('FROM model_usage_logs')) return [{ input_tokens: 0, output_tokens: 0, cost: 0, calls: 0 }];
      if (text.includes('FROM usage_events')) return [{ n: 0 }];
      if (text.includes('FROM digest_deliveries WHERE id = $1')) {
        return [{ id: 'dig3', owner_id: 'u1', frequency: 'daily', period_key: '2026-08-16', period_start: new Date(), period_end: new Date(), evidence: {}, summary_text: 'AI evidence-based narrative', ai_generated: true, delivered_at: new Date(), created_at: new Date() }];
      }
      return null;
    };
    const row = await deliverDigest('u1', 'daily', now);
    expect(row?.ai_generated).toBe(true);
    expect(completeWithFallback).toHaveBeenCalledTimes(1);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO digest_deliveries'))!;
    expect(insert.params[8]).toBe(true);
  });
});

describe('sweepDigests', () => {
  it('delivers due digests for users with digest preferences only', async () => {
    const now = new Date('2026-08-15T18:30:00.000Z');
    db.state.resolve = (text, params) => {
      if (text.includes("prefs->>'daily_digest'")) {
        return [
          { owner_id: 'u1', prefs: { daily_digest: true, timezone: 'UTC' } },
          { owner_id: 'u2', prefs: { weekly_digest: true, timezone: 'UTC' } },
          { owner_id: 'u3', prefs: { email: true } },
        ];
      }
      if (text.includes('SELECT prefs FROM notification_preferences')) {
        if (params[0] === 'u1') return [prefsRow({ daily_digest: true, timezone: 'UTC' })];
        if (params[0] === 'u2') return [prefsRow({ weekly_digest: true, timezone: 'UTC' })];
        return [prefsRow({ email: true })];
      }
      if (text.includes('SELECT period_key FROM digest_deliveries')) return [];
      if (text.includes('count(*)::int AS n')) return [{ n: 0 }];
      if (text.includes('FROM model_usage_logs')) return [{ input_tokens: 0, output_tokens: 0, cost: 0, calls: 0 }];
      if (text.includes('FROM usage_events')) return [{ n: 0 }];
      if (text.includes('FROM digest_deliveries WHERE id = $1')) {
        return [{ id: 'dig', owner_id: 'u1', frequency: 'daily', period_key: '2026-08-15', period_start: new Date(), period_end: new Date(), evidence: {}, summary_text: 's', ai_generated: false, delivered_at: new Date(), created_at: new Date() }];
      }
      return null;
    };
    const delivered = await sweepDigests(now);
    expect(delivered).toBe(2); // u1 daily + u2 weekly
    expect(createNotification).toHaveBeenCalledTimes(2);
  });
});