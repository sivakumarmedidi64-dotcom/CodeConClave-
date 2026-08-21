/**
 * CodeConClave — browser notification foundation tests.
 * The capability model must stay honest: no push infrastructure exists, so
 * notifications only fire when the Notification API exists AND permission is
 * granted AND the tab is visible. Unsupported/denied states report `false`
 * instead of pretending to deliver.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  browserNotificationCapability,
  requestBrowserNotificationPermission,
  showBrowserNotification,
  labelFor,
} from './browserNotifications.js';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  static instances: FakeNotification[] = [];
  readonly title: string;
  readonly options: NotificationOptions;
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options ?? {};
    FakeNotification.instances.push(this);
  }
}

function installFakeNotification() {
  (globalThis as Record<string, unknown>).Notification = FakeNotification;
}

function removeFakeNotification() {
  delete (globalThis as Record<string, unknown>).Notification;
}

afterEach(() => {
  removeFakeNotification();
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission.mockClear();
  FakeNotification.instances = [];
  vi.unstubAllGlobals();
});

const item = {
  id: 'ntf1',
  type: 'approval.pending',
  title: 'Approve deployment?',
  body: 'A HIGH-risk action needs review',
  read: false,
  readAt: null,
  metadata: {},
  resourceType: 'approval',
  resourceId: 'ap1',
  expiresAt: null,
  createdAt: '2026-08-15T10:00:00.000Z',
  deletedAt: null,
};

describe('capability detection (honest)', () => {
  it('reports unsupported with a reason when the Notification API is missing', () => {
    const cap = browserNotificationCapability();
    expect(cap.supported).toBe(false);
    expect(cap.permission).toBe('unsupported');
    expect(cap.reason).toContain('does not support');
  });

  it('reports granted permission when the API exists', () => {
    installFakeNotification();
    FakeNotification.permission = 'granted';
    const cap = browserNotificationCapability();
    expect(cap.supported).toBe(true);
    expect(cap.permission).toBe('granted');
    expect(cap.reason).toBeNull();
  });
});

describe('permission request', () => {
  it('returns the persisted permission without prompting when already decided', async () => {
    installFakeNotification();
    FakeNotification.permission = 'denied';
    await expect(requestBrowserNotificationPermission()).resolves.toBe('denied');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('requests permission from the default state', async () => {
    installFakeNotification();
    FakeNotification.permission = 'default';
    await expect(requestBrowserNotificationPermission()).resolves.toBe('granted');
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('never throws on unsupported environments', async () => {
    await expect(requestBrowserNotificationPermission()).resolves.toBe('unsupported');
  });
});

describe('showBrowserNotification', () => {
  it('returns false when the API is unsupported', () => {
    expect(showBrowserNotification(item)).toBe(false);
  });

  it('returns false when permission is not granted (never fakes delivery)', () => {
    installFakeNotification();
    FakeNotification.permission = 'denied';
    expect(showBrowserNotification(item)).toBe(false);
    FakeNotification.permission = 'default';
    expect(showBrowserNotification(item)).toBe(false);
  });

  it('shows native notifications even while the tab is hidden (browser-managed delivery)', () => {
    installFakeNotification();
    FakeNotification.permission = 'granted';
    vi.stubGlobal('document', { hidden: true });
    expect(showBrowserNotification(item)).toBe(true);
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('shows a native notification and wires activation when granted + visible', () => {
    installFakeNotification();
    FakeNotification.permission = 'granted';
    vi.stubGlobal('document', { hidden: false });
    const onActivate = vi.fn();
    expect(showBrowserNotification(item, onActivate)).toBe(true);
    const native = FakeNotification.instances[0]!;
    native.onclick?.();
    expect(native.close).toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('maps notification types to readable native titles', () => {
    expect(labelFor('approval.pending')).toBe('Approval pending');
    expect(labelFor('digest.daily')).toBe('Daily digest');
    expect(labelFor('unknown.type')).toBe('CodeConClave notification');
  });
});