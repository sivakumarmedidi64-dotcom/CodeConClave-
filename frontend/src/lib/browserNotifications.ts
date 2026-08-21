/**
 * CodeConClave — browser notification foundation (Phase 14).
 * HONEST capability model: CodeConClave has no push-infrastructure service,
 * so native notifications can only ever be shown while this tab is open and
 * only after the user grants permission. Nothing here claims offline/push
 * delivery. Unsupported environments report why instead of failing silently.
 */
import type { Notification } from './types.js';

export type BrowserNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported';

export interface BrowserNotificationCapability {
  supported: boolean;
  permission: BrowserNotificationPermission;
  reason: string | null;
}

const NATIVE_TYPE_LABELS: Record<string, string> = {
  'approval.pending': 'Approval pending',
  'approval.approved': 'Approval approved',
  'approval.rejected': 'Approval rejected',
  'task.completed': 'Task completed',
  'task.failed': 'Task failed',
  'digest.daily': 'Daily digest',
  'digest.weekly': 'Weekly digest',
  'mention': 'Mention',
  'team.invitation': 'Team invitation',
  'payment.pending': 'Payment pending',
  'payment.verified': 'Payment verified',
  'security.alert': 'Security alert',
};

export function browserNotificationCapability(): BrowserNotificationCapability {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    return {
      supported: false,
      permission: 'unsupported',
      reason: 'This browser does not support the Notification API',
    };
  }
  const permission = window.Notification.permission;
  if (permission === 'granted' || permission === 'denied' || permission === 'default') {
    return { supported: true, permission, reason: null };
  }
  return { supported: true, permission: 'unsupported', reason: 'Notification permission is unavailable' };
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  const cap = browserNotificationCapability();
  if (!cap.supported) return cap.permission;
  if (cap.permission !== 'default') return cap.permission;
  try {
    const result = await window.Notification.requestPermission();
    return result === 'granted' || result === 'denied' || result === 'default' ? result : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Show a native notification for an in-app notification item. Returns false
 * (never throws) when the environment cannot show it — e.g. permission is not
 * granted or the API is unsupported. Native notifications are browser-managed
 * and display even while the tab is hidden; there is no push infrastructure,
 * so the app must be open for this to work — the UI never claims otherwise.
 */
export function showBrowserNotification(item: Notification, onActivate?: () => void): boolean {
  const cap = browserNotificationCapability();
  if (!cap.supported || cap.permission !== 'granted') return false;
  try {
    const native = new window.Notification(labelFor(item.type), {
      body: item.body ?? item.title,
      tag: `codeconclave-${item.id}`,
    });
    if (onActivate) {
      native.onclick = () => {
        native.close();
        window.focus();
        onActivate();
      };
    }
    return true;
  } catch {
    return false;
  }
}

export function labelFor(type: string): string {
  return NATIVE_TYPE_LABELS[type] ?? 'CodeConClave notification';
}