/**
 * CodeConClave — notifications (in-app, persistent).
 * Tenant/recipient isolation: every notification row is scoped to a
 * recipient user; read state, deletion and preferences are server-side.
 * Channel eligibility (in-app / email / push / digests / DND / quiet hours)
 * is derived from persisted notification_preferences — never the client.
 */
import { pool, queryMany } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { NotificationPreferenceKey, NotificationType, AuditAction } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { enqueueOutbox } from '../outbox/service.js';

export interface NotificationRow {
  id: string;
  recipient_id: string;
  type: string;
  title: string;
  body: string | null;
  read: boolean;
  read_at: Date | null;
  metadata: Record<string, unknown>;
  resource_type: string | null;
  resource_id: string | null;
  expires_at: Date | null;
  created_at: Date;
  deleted_at: Date | null;
}

export interface NotifyInput {
  recipientId: string;
  type: string;
  title: string;
  body?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
  email?: boolean;
}

export function toNotificationJson(n: NotificationRow) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    read: n.read,
    readAt: n.read_at ?? null,
    metadata: n.metadata ?? {},
    resourceType: n.resource_type ?? null,
    resourceId: n.resource_id ?? null,
    expiresAt: n.expires_at ?? null,
    createdAt: n.created_at,
    deletedAt: n.deleted_at ?? null,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------- preferences

export interface QuietHours {
  start: string;
  end: string;
  timezone?: string;
}

export interface NotificationPreferences {
  in_app?: boolean;
  push?: boolean;
  email?: boolean;
  daily_digest?: boolean;
  weekly_digest?: boolean;
  dnd?: boolean;
  quiet_hours?: QuietHours;
  /** IANA timezone used for quiet hours + digest scheduling. */
  timezone?: string;
}

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const rows = await queryMany<{ prefs: NotificationPreferences }>(
    'SELECT prefs FROM notification_preferences WHERE owner_id = $1',
    [userId],
  );
  return rows[0]?.prefs ?? {};
}

export async function getNotificationPreferencesDetailed(
  userId: string,
): Promise<{ prefs: NotificationPreferences; version: number; updatedAt: Date } | null> {
  const rows = await queryMany<{ prefs: NotificationPreferences; version: number; updated_at: Date }>(
    'SELECT prefs, version, updated_at FROM notification_preferences WHERE owner_id = $1',
    [userId],
  );
  if (!rows[0]) return null;
  return { prefs: rows[0].prefs, version: rows[0].version, updatedAt: rows[0].updated_at };
}

export async function updateNotificationPreferences(
  userId: string,
  prefs: NotificationPreferences,
  baseVersion?: number,
): Promise<NotificationPreferences> {
  const current = await getNotificationPreferencesDetailed(userId);
  if (baseVersion !== undefined && current && current.version !== baseVersion) {
    throw AppError.conflict('notification_preferences_conflict', 'Notification preferences changed on another device', {
      current: { prefs: current.prefs, version: current.version },
    });
  }
  const merged: NotificationPreferences = { ...(current?.prefs ?? {}), ...prefs };
  await pool.query(
    `INSERT INTO notification_preferences (id, owner_id, prefs, version) VALUES ($1,$2,$3::jsonb, 1)
     ON CONFLICT (owner_id) DO UPDATE
       SET prefs = EXCLUDED.prefs, version = notification_preferences.version + 1, updated_at = now()`,
    [newId(PREFIX.PREFERENCE), userId, JSON.stringify(merged)],
  );
  await recordAudit({
    action: AuditAction.NOTIFICATION_PREFERENCE_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'notification_preference',
  });
  return merged;
}

/** Local wall-clock minutes (0-1439) for an instant in the given IANA timezone (UTC fallback). */
export function localMinutes(now: Date, timezone?: string): number {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
      const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
      return hour * 60 + minute;
    } catch {
      /* invalid timezone: fall back to UTC */
    }
  }
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

export function inQuietHours(quietHours: QuietHours | undefined, now: Date): boolean {
  if (!quietHours?.start || !quietHours?.end) return false;
  const minutes = localMinutes(now, quietHours.timezone);
  const start = Number(quietHours.start.slice(0, 2)) * 60 + Number(quietHours.start.slice(3, 5));
  const end = Number(quietHours.end.slice(0, 2)) * 60 + Number(quietHours.end.slice(3, 5));
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

export interface ChannelEligibility {
  inApp: boolean;
  email: boolean;
  push: boolean;
  digest: 'none' | 'daily' | 'weekly';
  dnd: boolean;
}

/** Which delivery channels are allowed right now, per persisted preferences. */
export async function channelEligibility(userId: string, now = new Date()): Promise<ChannelEligibility> {
  const prefs = await getNotificationPreferences(userId);
  const quiet = inQuietHours(prefs.quiet_hours, now);
  const dnd = Boolean(prefs.dnd) || quiet;
  return {
    inApp: prefs.in_app !== false,
    email: prefs.email === true && !dnd,
    push: prefs.push === true && !dnd,
    digest: prefs.weekly_digest ? 'weekly' : prefs.daily_digest ? 'daily' : 'none',
    dnd,
  };
}

// ---------------------------------------------------------------- create / list / read / delete

export async function createNotification(input: NotifyInput): Promise<NotificationRow> {
  const id = newId(PREFIX.NOTIFICATION);
  const { recipientId, type, title, body, resourceType, resourceId, metadata, expiresAt } = input;
  const rows = await queryMany<NotificationRow>(
    `INSERT INTO notifications (id, recipient_id, type, title, body, metadata, resource_type, resource_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     RETURNING *`,
    [id, recipientId, type, title, body ?? null, JSON.stringify(metadata ?? {}), resourceType ?? null, resourceId ?? null, expiresAt ?? null],
  );
  const row = rows[0] as NotificationRow;
  await recordAudit({
    action: AuditAction.NOTIFICATION_CREATED,
    actorUserId: recipientId,
    scope: 'USER',
    tenantId: recipientId,
    resourceType: 'notification',
    resourceId: id,
    detail: { type },
  });
  return row;
}

export interface NotificationListFilters {
  unread?: boolean;
  type?: string;
  limit?: number;
}

export async function listNotifications(userId: string, filters: NotificationListFilters = {}): Promise<NotificationRow[]> {
  const params: unknown[] = [userId];
  const clauses: string[] = ['recipient_id = $1', 'deleted_at IS NULL'];
  if (filters.unread) clauses.push('read = false');
  if (filters.type) {
    params.push(filters.type);
    clauses.push(`type = $${params.length}`);
  }
  const limit = Math.min(filters.limit ?? 50, 100);
  params.push(limit);
  return queryMany<NotificationRow>(
    `SELECT * FROM notifications WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const rows = await queryMany<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications
     WHERE recipient_id = $1 AND deleted_at IS NULL AND read = false
       AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<NotificationRow> {
  const rows = await queryMany<NotificationRow>(
    `UPDATE notifications SET read = true, read_at = now()
     WHERE id = $1 AND recipient_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [notificationId, userId],
  );
  if (!rows[0]) throw AppError.notFound('Notification');
  await recordAudit({
    action: AuditAction.NOTIFICATION_READ,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'notification',
    resourceId: notificationId,
  });
  return rows[0];
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE notifications SET read = true, read_at = now()
     WHERE recipient_id = $1 AND deleted_at IS NULL AND read = false`,
    [userId],
  );
  if ((result.rowCount ?? 0) > 0) {
    await recordAudit({
      action: AuditAction.NOTIFICATION_ALL_READ,
      actorUserId: userId,
      scope: 'USER',
      tenantId: userId,
    });
  }
  return result.rowCount ?? 0;
}

export async function deleteNotification(userId: string, notificationId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE notifications SET deleted_at = now()
     WHERE id = $1 AND recipient_id = $2 AND deleted_at IS NULL`,
    [notificationId, userId],
  );
  if ((result.rowCount ?? 0) === 0) throw AppError.notFound('Notification');
  await recordAudit({
    action: AuditAction.NOTIFICATION_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'notification',
    resourceId: notificationId,
  });
}

/**
 * Notify a user honoring persisted preferences: always persists the in-app
 * row (unless in_app is disabled), and enqueues email delivery only when
 * email is enabled and DND/quiet hours do not apply.
 */
export async function notifyUser(input: NotifyInput): Promise<void> {
  const eligibility = await channelEligibility(input.recipientId);
  if (eligibility.inApp) {
    await createNotification(input);
  }
  if (input.email && eligibility.email) {
    await enqueueOutbox('notification.email', {
      channel: 'email',
      to: input.recipientId,
      userId: input.recipientId,
      subject: input.title,
      html: `<p>${escapeHtml(input.body ?? input.title)}</p>`,
      data: { userId: input.recipientId, type: input.type },
    });
  }
}

/** Convenience for internal callers: notify with a known notification type. */
export async function notify(
  recipientId: string,
  type: (typeof NotificationType)[keyof typeof NotificationType],
  title: string,
  input: Omit<NotifyInput, 'recipientId' | 'type' | 'title'> = {},
): Promise<void> {
  await notifyUser({ recipientId, type, title, ...input });
}

// ---------------------------------------------------------------- while you were away

/** While You Were Away: aggregate what changed since the user's last activity. */
export async function returnToWorkSummary(userId: string, sinceMs: number): Promise<Record<string, unknown>> {
  const since = new Date(sinceMs).toISOString();
  const [tasks, approvals, notifications] = await Promise.all([
    queryMany(
      `SELECT id, title, status FROM tasks WHERE owner_id = $1 AND updated_at > $2 ORDER BY updated_at DESC LIMIT 10`,
      [userId, since],
    ),
    queryMany(
      `SELECT id, task_id, risk_level, detail, status FROM approvals
        WHERE owner_id = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 10`,
      [userId, since],
    ),
    listNotifications(userId, { limit: 20 }),
  ]);
  return {
    since: new Date(sinceMs).toISOString(),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    approvals: approvals.map((a) => ({ id: a.id, risk: a.risk_level, status: a.status, detail: a.detail })),
    notifications: notifications.map(toNotificationJson),
    generatedAt: new Date().toISOString(),
  };
}