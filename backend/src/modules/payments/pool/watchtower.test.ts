/**
 * CodeConClave — PAYMENT WATCHTOWER tests (globally unscoped, read-only).
 *
 * The watchtower is READ-ONLY and system-scoped: NO identity-based filtering.
 * These tests assert:
 *   - healthy pool -> all C1-C7 checks pass, no alert, no outbox event
 *   - a violation + configured alert email -> ONE outbox email alert to that
 *     address (delivery config only; inspection is global)
 *   - a violation + NO alert destination -> every C1-C7 check STILL executes
 *     and is recorded, no outgoing alert, and exactly one explicit
 *     ALERT_DESTINATION_UNCONFIGURED warning is emitted
 *   - storage that throws -> check is STATE_UNREADABLE (ok=false, unreadable)
 *     and the scan still completes
 *   - global unscoping: every query is a system-wide aggregate with no
 *     owner_id/user_id/workspace filter
 *   - the scan never issues a mutating statement (no INSERT/UPDATE/DELETE)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock DB: stateful handler shared/db.js (repo convention)
// ---------------------------------------------------------------------------
const mock = vi.hoisted(() => {
  const state: {
    liveReserved: number;
    activeLinks: number;
    poolRows: number;
    reservedOnInactive: number;
    expiredReserved: number;
    callbacksUnknownLink: number;
    outlierDuration: number;
    replayEvidence: number;
    throwOnQuery: string | null;
    queriesLogged: string[];
  } = {
    liveReserved: 0, activeLinks: 0, poolRows: 0, reservedOnInactive: 0, expiredReserved: 0,
    callbacksUnknownLink: 0, outlierDuration: 0, replayEvidence: 0, throwOnQuery: null, queriesLogged: [],
  };
  const reset = () => {
    state.liveReserved = 0;
    state.activeLinks = 0;
    state.poolRows = 0;
    state.reservedOnInactive = 0;
    state.expiredReserved = 0;
    state.callbacksUnknownLink = 0;
    state.outlierDuration = 0;
    state.replayEvidence = 0;
    state.throwOnQuery = null;
    state.queriesLogged = [];
  };
  const handler = (text: string, _params: unknown[]): Record<string, unknown>[] => {
    state.queriesLogged.push(text.replace(/\s+/g, ' ').trim());
    const t = text.trim();
    if (state.throwOnQuery && t.includes(state.throwOnQuery)) {
      throw new Error('storage unavailable (simulated)');
    }
    if (t.includes('FROM payment_link_pool WHERE is_active = true')) {
      return [{ n: state.activeLinks }];
    }
    if (t.includes('l.is_active = false')) {
      return Array.from({ length: state.reservedOnInactive }, () => ({ ref_id: 'x' }));
    }
    if (t.includes('reservations WHERE status = \'RESERVED\' AND expires_at < now()')) {
      return Array.from({ length: state.expiredReserved }, () => ({ id: 'r' }));
    }
    if (t.includes('callbacks c\n        LEFT JOIN')) {
      return Array.from({ length: state.callbacksUnknownLink }, () => ({ id: 'c' }));
    }
    if (t.includes('reservations WHERE status = \'RESERVED\'\n          AND expires_at - reserved_at')) {
      return Array.from({ length: state.outlierDuration }, () => ({ id: 'o' }));
    }
    if (t.includes('SELECT count(*)::int AS n FROM payment_link_pool')) {
      return [{ n: state.poolRows }];
    }
    if (t.includes('FROM payment_link_reservations WHERE status = \'RESERVED\'')) {
      return [{ n: state.liveReserved }];
    }
    if (t.includes('payment_pool_callbacks WHERE outcome IN')) {
      return [{ n: state.replayEvidence }];
    }
    return [];
  };
  const query = async (text: string, params: unknown[] = []) => {
    const rows = handler(text, params);
    return { rows, rowCount: rows.length };
  };
  const queryOne = async (text: string, params: unknown[] = []) => {
    const rows = handler(text, params);
    return rows[0] ?? null;
  };
  const queryMany = async (text: string, params: unknown[] = []) => handler(text, params);
  return {
    state,
    reset,
    pool: { query },
    queryOne,
    queryMany,
    withTenant: async (_u: string | null, fn: (q: unknown) => Promise<unknown>) => fn({ query, queryOne, queryMany }),
    withSystem: async (fn: (q: unknown) => Promise<unknown>) => fn({ query, queryOne, queryMany }),
  };
});

vi.mock('../../../shared/db.js', () => mock);
const enqueueOutbox = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../modules/outbox/service.js', () => ({ enqueueOutbox }));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../shared/logger.js', () => ({ logger }));

import { runPoolWatchtower } from './watchtower.js';

beforeEach(() => {
  mock.reset();
  enqueueOutbox.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pool watchtower: healthy pool', () => {
  it('passes every check (C1-C7 all execute), sends no alert, no outbox event', async () => {
    mock.state.liveReserved = 1;
    mock.state.activeLinks = 2;
    mock.state.poolRows = 2;

    const report = await runPoolWatchtower({ alertEmail: 'ops@example.com' });
    expect(report.failing).toBe(0);
    expect(report.alertSent).toBe(false);
    expect(report.checks.length).toBe(7);
    expect(enqueueOutbox).not.toHaveBeenCalled();
    for (const c of report.checks) {
      expect(c.ok).toBe(true);
    }
  });
});

describe('pool watchtower: alert delivery is destination-ONLY (global inspection)', () => {
  it('alerts ONCE to the configured email when a global check fails', async () => {
    mock.state.liveReserved = 3;
    mock.state.activeLinks = 2;
    mock.state.poolRows = 2;

    const report = await runPoolWatchtower({ alertEmail: 'ops@example.com' });
    expect(report.failing).toBeGreaterThan(0);
    expect(report.alertSent).toBe(true);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    const [topic, payload] = enqueueOutbox.mock.calls[0] as [string, Record<string, unknown>, unknown];
    expect(topic).toBe('payment.watchtower.alert');
    expect(payload.channel).toBe('email');
    expect(payload.to).toBe('ops@example.com');
    // Delivered regardless of which user/workspace owns the offending row —
    // the alert config never scopes inspection.
    expect(String(payload.message)).toContain('C1');
    expect(report.checks.length).toBe(7);
  });

  it('no alert destination + failing checks: every check still runs and is recorded, nothing skipped, ALERT_DESTINATION_UNCONFIGURED emitted exactly once', async () => {
    mock.state.liveReserved = 3;
    mock.state.activeLinks = 2;
    mock.state.poolRows = 2;

    const report = await runPoolWatchtower({ alertEmail: null });
    // 1) All C1-C7 checks executed and were recorded.
    expect(report.checks.length).toBe(7);
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) {
      expect(report.checks.some((c) => c.check === id)).toBe(true);
    }
    // 2) The complete monitoring result is present in the report.
    expect(report.failing).toBeGreaterThan(0);
    expect(report.unreadable).toBe(0);
    // 3) No alert was dispatched (destination missing) and coverage was NOT reduced.
    expect(report.alertSent).toBe(false);
    expect(enqueueOutbox).not.toHaveBeenCalled();
    // 4) Exactly one explicit ALERT_DESTINATION_UNCONFIGURED warning.
    const warnings = logger.warn.mock.calls.filter((c) => c[0] === 'payment.watchtower.alert_destination_unconfigured');
    expect(warnings.length).toBe(1);
    expect(JSON.stringify(warnings[0])).toContain('ALERT_DESTINATION_UNCONFIGURED');
    // 5) The report itself was written to the log.
    expect(logger.warn.mock.calls.some((c) => c[0] === 'payment.watchtower.report')).toBe(true);
  });
});

describe('pool watchtower: globally unscoped inspection', () => {
  it('issues only system-wide aggregates with NO owner/user/workspace filter', async () => {
    mock.state.liveReserved = 2;
    mock.state.activeLinks = 3;
    mock.state.poolRows = 4;

    await runPoolWatchtower({ alertEmail: null });
    const allQueryLog = mock.state.queriesLogged.join('\n');
    // Inspection must span all tenants: no identity scoping in any query.
    expect(allQueryLog).not.toMatch(/WHERE\s+(r\.)?owner_id\s*=/i);
    expect(allQueryLog).not.toMatch(/WHERE\s+(r\.)?user_id\s*=/i);
    expect(allQueryLog).not.toMatch(/workspace_id/i);
    // Every check is global aggregation or cross-table scan (observability across users).
    expect(mock.state.queriesLogged.length).toBeGreaterThanOrEqual(7);
  });

  it('flags a replay/duplicate/ambiguous evidence attempt globally (C7)', async () => {
    mock.state.liveReserved = 1;
    mock.state.activeLinks = 2;
    mock.state.poolRows = 2;
    mock.state.replayEvidence = 1;

    const report = await runPoolWatchtower({ alertEmail: 'ops@example.com' });
    const c7 = report.checks.find((c) => c.check === 'C7');
    expect(c7).toBeDefined();
    expect(c7!.ok).toBe(false);
    expect(c7!.detail).toContain('replay/duplicate/ambiguous');
    expect(report.alertSent).toBe(true);
  });
});

describe('pool watchtower: STATE_UNREADABLE', () => {
  it('marks an unreadable check, still completes the full scan, still alerts', async () => {
    mock.state.liveReserved = 1;
    mock.state.activeLinks = 2;
    mock.state.poolRows = 2;
    mock.state.throwOnQuery = `reservations WHERE status = 'RESERVED' AND expires_at < now()`;

    const report = await runPoolWatchtower({ alertEmail: 'ops@example.com' });
    const c2 = report.checks.find((c) => c.check === 'C2');
    expect(c2).toBeDefined();
    expect(c2!.ok).toBe(false);
    expect(c2!.unreadable).toBe(true);
    expect(c2!.detail).toContain('expired-reservations unreadable');
    expect(c2!.detail).toContain('storage unavailable (simulated)');
    // The scan completes (no crash), every other check still ran (7 total).
    expect(report.checks.length).toBe(7);
    expect(report.checks.filter((c) => c.ok).length).toBe(6);
    // A failing check forces an alert even when the cause is unreadability.
    expect(report.alertSent).toBe(true);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
  });
});

describe('pool watchtower: read-only invariant', () => {
  it('never issues a mutating SQL statement', async () => {
    mock.state.liveReserved = 4;
    mock.state.activeLinks = 2;
    mock.state.poolRows = 1;
    await runPoolWatchtower({ alertEmail: 'ops@example.com' });

    const all = mock.state.queriesLogged.join(' ');
    expect(all).not.toMatch(/\bINSERT\b/i);
    expect(all).not.toMatch(/\bUPDATE\b/i);
    expect(all).not.toMatch(/\bDELETE\b/i);
    expect(all).not.toMatch(/\bDROP\b/i);
    expect(all).not.toMatch(/\bALTER\b/i);
    expect(all).not.toMatch(/\bTRUNCATE\b/i);
  });
});