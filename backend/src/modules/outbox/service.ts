/**
 * CodeConClave — outbox (transactional event delivery).
 * Outbox events are written in the same request as the change; the watchdog
 * flushes them. Email notifications are delivered through Resend when
 * configured (RESEND_API_KEY + RESEND_ENABLED); otherwise events stay PENDING
 * and are retried — delivery is never faked. Phase 14 adds: idempotent
 * enqueue (dedupe_key, no duplicate delivery for the same event), provider
 * error classification, exponential backoff, delivery failure state
 * (last_error) and audit of sensitive notification events on final failure.
 */
import { pool, queryMany } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import type { EmailErrorClass } from './deliver.js';

export interface OutboxEventRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  delivered_at: Date | null;
  created_at: Date;
  last_error: string | null;
  dedupe_key: string | null;
}

export interface EnqueueOutboxOptions {
  /** Idempotency: the same dedupe key for the same topic only ever enqueues once. */
  dedupeKey?: string;
}

/**
 * Enqueue an outbox event. Returns true when a new row was inserted and false
 * when the dedupe key already exists (the event was already queued — no
 * duplicate delivery).
 */
export async function enqueueOutbox(topic: string, payload: Record<string, unknown>, opts: EnqueueOutboxOptions = {}): Promise<boolean> {
  const dedupeKey = opts.dedupeKey?.trim() || null;
  if (dedupeKey) {
    const existing = await queryMany<{ id: string }>(
      `SELECT id FROM outbox_events WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    if (existing[0]) return false;
  }
  const result = await pool.query(
    `INSERT INTO outbox_events (id, topic, payload, dedupe_key) VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [newId(PREFIX.OUTBOX), topic, JSON.stringify(payload), dedupeKey],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Topics whose final delivery failure is audited (sensitive notification events). */
function isSensitiveTopic(topic: string): boolean {
  return topic.startsWith('auth.') || topic.startsWith('payment.') || topic.startsWith('security.');
}

/** Resolve the real recipient address: payload.userId → users.email, else payload.to. */
async function resolveRecipient(payload: Record<string, unknown>): Promise<string | null> {
  const userId = typeof payload.userId === 'string' ? payload.userId : null;
  if (userId) {
    const rows = await queryMany<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    if (rows[0]?.email) return rows[0].email;
  }
  const to = payload.to;
  return typeof to === 'string' && to.includes('@') ? to : null;
}

interface DeliveryOutcome {
  ok: boolean;
  errorClass: EmailErrorClass | null;
  message: string | null;
}

async function deliverNotification(row: OutboxEventRow): Promise<DeliveryOutcome> {
  const payload = row.payload as { channel?: string; to?: string; subject?: string; html?: string; message?: string };
  if (payload.channel === 'email') {
    if (!env.RESEND_API_KEY || env.RESEND_ENABLED !== 'true') {
      // Not configured: leave PENDING, retry later — never fake delivery.
      return { ok: false, errorClass: 'not_configured', message: 'email provider not configured' };
    }
    const to = await resolveRecipient(payload);
    if (!to) {
      return { ok: false, errorClass: 'invalid_request', message: 'no resolvable recipient address' };
    }
    try {
      const { resendFetch } = await import('./deliver.js');
      await resendFetch({
        from: env.RESEND_FROM_EMAIL,
        to: [to],
        subject: payload.subject ?? 'CodeConClave notification',
        html: payload.html ?? `<p>${escapeHtml(payload.message ?? '')}</p>`,
        idempotencyKey: row.dedupe_key ?? row.id,
      });
      return { ok: true, errorClass: null, message: null };
    } catch (err) {
      const code = err instanceof Error && 'code' in err && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: EmailErrorClass }).code
        : 'provider_unreachable';
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('notification delivery failed', { topic: row.topic, code });
      return { ok: false, errorClass: code, message };
    }
  }
  return { ok: true, errorClass: null, message: null }; // non-email events are internal records
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Permanent classes: retrying cannot succeed, fail fast and honestly. */
function isPermanent(code: EmailErrorClass): boolean {
  return code === 'auth_invalid' || code === 'invalid_request';
}

export async function flushOutbox(limit = 50): Promise<number> {
  const rows = await queryMany<OutboxEventRow>(
    `SELECT * FROM outbox_events
      WHERE status = 'PENDING' AND next_attempt_at <= now()
      ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  let delivered = 0;
  for (const row of rows) {
    const outcome = await deliverNotification(row);
    if (outcome.ok) {
      await pool.query(
        `UPDATE outbox_events SET status = 'DELIVERED', delivered_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`,
        [row.id],
      );
      delivered++;
      continue;
    }
    const attempts = row.attempts + 1;
    const permanent = isPermanent(outcome.errorClass ?? 'provider_unreachable');
    const failed = permanent || attempts >= row.max_attempts;
    const errorText = outcome.message ? `[${outcome.errorClass}] ${outcome.message}`.slice(0, 500) : null;
    if (failed) {
      await pool.query(
        `UPDATE outbox_events SET status = 'FAILED', attempts = $2, next_attempt_at = now() + interval '1 day', last_error = $3 WHERE id = $1`,
        [row.id, attempts, errorText],
      );
      if (isSensitiveTopic(row.topic)) {
        const payload = row.payload as { userId?: string };
        await recordAudit({
          action: AuditAction.EMAIL_DELIVERY_FAILED,
          actorUserId: payload.userId ?? null,
          scope: 'SYSTEM',
          tenantId: payload.userId ?? null,
          resourceType: 'outbox_event',
          resourceId: row.id,
          detail: { topic: row.topic, errorClass: outcome.errorClass, attempts },
        });
      }
    } else {
      // Exponential backoff: 2^attempts minutes, capped at 60.
      const backoffSecs = Math.min(Math.pow(2, attempts), 60) * 60;
      await pool.query(
        `UPDATE outbox_events
            SET status = $2, attempts = $3, last_error = $4,
                next_attempt_at = now() + make_interval(secs => $5)
          WHERE id = $1`,
        [row.id, 'PENDING', attempts, errorText, backoffSecs],
      );
    }
  }
  return delivered;
}