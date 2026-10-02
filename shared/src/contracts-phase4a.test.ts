/**
 * CodeConClave — PHASE 4A contract tests.
 * Guards notifications, notification preferences and usage contracts.
 */
import { describe, expect, it } from 'vitest';
import {
  notificationPreferencesSchema,
  notificationListQuerySchema,
  quietHoursSchema,
  recordUsageSchema,
} from './contracts.js';
import {
  PlanId,
  NotificationType,
  NotificationPreferenceKey,
  UsageKind,
  UsageUnit,
} from './constants.js';

describe('phase 4a notification contracts', () => {
  it('notificationPreferencesSchema accepts channel toggles and quiet hours', () => {
    const input = notificationPreferencesSchema.parse({
      in_app: true,
      email: false,
      daily_digest: true,
      dnd: false,
      quiet_hours: { start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' },
    });
    expect(input.quiet_hours?.start).toBe('22:00');
    expect(() =>
      notificationPreferencesSchema.parse({ quiet_hours: { start: '25:00', end: '07:00' } }),
    ).toThrow();
    expect(() => notificationPreferencesSchema.parse({ in_app: 'yes' })).toThrow();
  });

  it('notificationListQuerySchema coerces limit and optional filters', () => {
    expect(notificationListQuerySchema.parse({}).limit).toBe(50);
    expect(notificationListQuerySchema.parse({ unread: 'true', type: 'task.failed', limit: '10' })).toMatchObject({
      unread: 'true',
      type: 'task.failed',
      limit: 10,
    });
    expect(() => notificationListQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it('notification types cover the mandated surface', () => {
    for (const t of [
      'task.completed',
      'approval.requested',
      'approval.resolved',
      'task.failed',
      'team.message',
      'payment.status',
      'research.completed',
      'reminder',
      'milestone',
      'mention',
      'system',
    ]) {
      expect(NotificationType[t.replace('.', '_').toUpperCase() as keyof typeof NotificationType]).toBe(t);
    }
  });

  it('preference keys cover in-app/push/email/digests/DND/quiet hours', () => {
    for (const k of ['in_app', 'push', 'email', 'daily_digest', 'weekly_digest', 'dnd', 'quiet_hours']) {
      expect(Object.values(NotificationPreferenceKey)).toContain(k);
    }
  });
});

describe('phase 4a usage contracts', () => {
  it('recordUsageSchema distinguishes measured from estimated', () => {
    const measured = recordUsageSchema.parse({ kind: 'messages', quantity: 1 });
    expect(measured.measured).toBe(true);
    expect(measured.unit).toBe('count');
    const estimated = recordUsageSchema.parse({ kind: 'compute', quantity: 0.0042, measured: false, unit: 'usd' });
    expect(estimated.measured).toBe(false);
    expect(estimated.unit).toBe('usd');
    expect(() => recordUsageSchema.parse({ kind: 'messages', quantity: -1 })).toThrow();
    expect(() => recordUsageSchema.parse({ kind: 'nonsense', quantity: 1 })).toThrow();
  });

  it('plan structure is FREE/PRO/TEAM/ENTERPRISE', () => {
    for (const [key, value] of [
      ['FREE', 'free'],
      ['PRO', 'pro'],
      ['TEAM', 'team'],
      ['ENTERPRISE', 'enterprise'],
    ]) {
      expect(PlanId[key as keyof typeof PlanId]).toBe(value);
    }
  });

  it('usage kinds and units are frozen constants', () => {
    expect(Object.values(UsageKind)).toEqual(['messages', 'storage', 'ai_tokens', 'compute', 'tasks', 'model_usage']);
    expect(Object.values(UsageUnit)).toEqual(['count', 'bytes', 'tokens', 'usd']);
  });
});

describe('phase 4a misc', () => {
  it('quietHoursSchema rejects malformed times', () => {
    expect(() => quietHoursSchema.parse({ start: '9:00', end: '17:00' })).toThrow();
    expect(() => quietHoursSchema.parse({ start: '09:00', end: '17:61' })).toThrow();
  });
});