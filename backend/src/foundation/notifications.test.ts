/**
 * CodeConClave — notifications foundation tests (PHASE 4A).
 * Covers: creation, tenant/recipient isolation, unread count, mark read,
 * mark all read, delete, preferences merge/conflict, DND/quiet hours and
 * channel eligibility. DB interaction mocked; no client-side authority.
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
const enqueueOutbox = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/outbox/service.js', () => ({ enqueueOutbox }));

import { AppError } from '../shared/errors.js';
import {
  createNotification,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  notifyUser,
  notify,
  getNotificationPreferences,
  getNotificationPreferencesDetailed,
  updateNotificationPreferences,
  channelEligibility,
  toNotificationJson,
} from '../modules/notifications/service.js';

function notifRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'n1',
    recipient_id: 'u1',
    type: 'task.completed',
    title: 'Task completed',
    body: null,
    read: false,
    read_at: null,
    metadata: {},
    resource_type: 'task',
    resource_id: 't1',
    expires_at: null,
    created_at: new Date(),
    deleted_at: null,
    ...overrides,
  };
}

function prefsRow(prefs: Record<string, unknown>, version = 1): Record<string, unknown> {
  return { prefs, version, updated_at: new Date() };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  enqueueOutbox.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notification creation + isolation', () => {
  it('persists a notification with type, resource and metadata', async () => {
    db.state.resolve = (text) => (text.includes('INSERT INTO notifications') ? [notifRow()] : null);
    const n = await createNotification({
      recipientId: 'u1',
      type: 'task.completed',
      title: 'Task completed',
      body: 'Your task is done',
      resourceType: 'task',
      resourceId: 't1',
      metadata: { status: 'COMPLETED' },
    });
    expect(n).toMatchObject({ recipient_id: 'u1', type: 'task.completed', resource_id: 't1' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO notifications'))!;
    expect(insert.params[1]).toBe('u1');
    expect(JSON.parse(String(insert.params[5]))).toEqual({ status: 'COMPLETED' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'notification.created' }));
  });

  it('lists only the recipient’s own non-deleted notifications', async () => {
    db.state.resolve = (text) => (text.includes('FROM notifications') ? [notifRow()] : null);
    const rows = await listNotifications('u1');
    expect(rows).toHaveLength(1);
    const call = db.state.calls.find((c) => c.text.includes('FROM notifications'))!;
    expect(call.text).toContain('recipient_id = $1');
    expect(call.text).toContain('deleted_at IS NULL');
    expect(call.text).toContain('ORDER BY created_at DESC');
  });

  it('supports unread and type filters', async () => {
    await listNotifications('u1', { unread: true, type: 'task.failed' });
    const call = db.state.calls.find((c) => c.text.includes('FROM notifications'))!;
    expect(call.text).toContain('read = false');
    expect(call.text).toContain('type = $2');
  });

  it('unread count is recipient-scoped and excludes expired notifications', async () => {
    db.state.resolve = (text) =>
      text.includes('count(*)::int AS n FROM notifications') ? [{ n: 3 }] : null;
    await expect(unreadNotificationCount('u1')).resolves.toBe(3);
    const call = db.state.calls.find((c) => c.text.includes('count(*)::int AS n FROM notifications'))!;
    expect(call.text).toContain('recipient_id = $1');
    expect(call.text).toContain('expires_at > now()');
  });

  it('toNotificationJson exposes the full client contract', () => {
    const json = toNotificationJson(notifRow({ read: true, read_at: new Date() }) as never);
    expect(json).toMatchObject({ id: 'n1', type: 'task.completed', read: true, resourceId: 't1' });
    expect(json.readAt).toBeInstanceOf(Date);
    expect(json.deletedAt).toBeNull();
  });
});

describe('mark read / mark all / delete', () => {
  it('marks one notification read, scoped to recipient', async () => {
    db.state.resolve = (text) => (text.includes('UPDATE notifications SET read = true, read_at = now()') ? [notifRow({ read: true })] : null);
    const n = await markNotificationRead('u1', 'n1');
    expect(n.read).toBe(true);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE notifications SET read = true'))!;
    expect(upd.params).toEqual(['n1', 'u1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'notification.read' }));
  });

  it('cannot mark a notification the caller does not own', async () => {
    db.state.resolve = (text) => (text.includes('UPDATE notifications SET read = true') ? [] : null);
    await expect(markNotificationRead('u2', 'n1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });

  it('mark all read only touches the caller’s unread rows', async () => {
    db.state.rowCount = 5;
    await expect(markAllNotificationsRead('u1')).resolves.toBe(5);
    const upd = db.state.calls.find((c) => c.text.includes('UPDATE notifications SET read = true, read_at = now()'))!;
    expect(upd.params).toEqual(['u1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'notification.all_read' }));
  });

  it('delete is a soft delete scoped to recipient', async () => {
    db.state.rowCount = 1;
    await deleteNotification('u1', 'n1');
    const del = db.state.calls.find((c) => c.text.includes('SET deleted_at = now()'))!;
    expect(del.params).toEqual(['n1', 'u1']);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'notification.deleted' }));
    db.state.rowCount = 0;
    await expect(deleteNotification('u2', 'n1')).rejects.toMatchObject({ errorCode: 'not_found' });
  });
});

describe('notification preferences', () => {
  it('defaults to empty prefs and null detailed state', async () => {
    await expect(getNotificationPreferences('u1')).resolves.toEqual({});
    await expect(getNotificationPreferencesDetailed('u1')).resolves.toBeNull();
  });

  it('merges preference updates and persists server-side', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT prefs, version, updated_at FROM notification_preferences')
        ? [prefsRow({ email: true, dnd: false })]
        : null;
    const merged = await updateNotificationPreferences('u1', { email: false, daily_digest: true });
    expect(merged).toEqual({ email: false, dnd: false, daily_digest: true });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO notification_preferences'))!;
    expect(insert.text).toContain('ON CONFLICT (owner_id)');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'notification_preference.updated' }));
  });

  it('stale baseVersion raises a conflict', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT prefs, version, updated_at FROM notification_preferences')
        ? [prefsRow({ email: true }, 4)]
        : null;
    await expect(updateNotificationPreferences('u1', { email: false }, 1)).rejects.toMatchObject({
      status: 409,
      errorCode: 'notification_preferences_conflict',
    });
  });

  it('channelEligibility honors prefs, DND and quiet hours', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT prefs FROM notification_preferences')
        ? [prefsRow({ in_app: false, email: true, push: true, daily_digest: true, quiet_hours: { start: '00:00', end: '23:59' } })]
        : null;
    const quiet = await channelEligibility('u1', new Date('2026-01-01T12:00:00.000Z'));
    expect(quiet).toMatchObject({ inApp: false, dnd: true, digest: 'daily' });
    expect(quiet.email).toBe(false);

    db.state.resolve = (text) =>
      text.includes('SELECT prefs FROM notification_preferences')
        ? [prefsRow({ in_app: true, email: true, weekly_digest: true })]
        : null;
    const open = await channelEligibility('u1', new Date('2026-01-01T12:00:00.000Z'));
    expect(open).toMatchObject({ inApp: true, email: true, dnd: false, digest: 'weekly' });
  });
});

describe('notifyUser dispatch', () => {
  it('persists in-app and enqueues email only when enabled and not in DND', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs FROM notification_preferences')) return [prefsRow({ email: true })];
      if (text.includes('INSERT INTO notifications')) return [notifRow()];
      return null;
    };
    await notifyUser({ recipientId: 'u1', type: 'payment.status', title: 'Payment verified', email: true });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO notifications'))).toBe(true);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(enqueueOutbox).toHaveBeenCalledWith('notification.email', expect.objectContaining({ to: 'u1' }));
  });

  it('skips email under DND but still persists the in-app row', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs FROM notification_preferences')) return [prefsRow({ email: true, dnd: true })];
      if (text.includes('INSERT INTO notifications')) return [notifRow()];
      return null;
    };
    await notifyUser({ recipientId: 'u1', type: 'task.failed', title: 'Failed', email: true });
    expect(enqueueOutbox).not.toHaveBeenCalled();
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO notifications'))).toBe(true);
  });

  it('respects in_app=false preference (no row, no read-side pollution)', async () => {
    db.state.resolve = (text) =>
      text.includes('SELECT prefs FROM notification_preferences') ? [prefsRow({ in_app: false })] : null;
    await notifyUser({ recipientId: 'u1', type: 'system', title: 'Sys' });
    expect(db.state.calls.some((c) => c.text.includes('INSERT INTO notifications'))).toBe(false);
  });

  it('notify() convenience helper routes to notifyUser with a type', async () => {
    db.state.resolve = (text) => {
      if (text.includes('SELECT prefs FROM notification_preferences')) return [prefsRow({})];
      if (text.includes('INSERT INTO notifications')) return [notifRow()];
      return null;
    };
    await notify('u1', 'task.completed', 'Done', { resourceId: 't1' });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO notifications'))!;
    expect(insert.params[2]).toBe('task.completed');
  });

  it('AppError is available for callers', () => {
    expect(AppError).toBeDefined();
  });
});