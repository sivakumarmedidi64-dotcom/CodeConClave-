/**
 * CodeConClave — audit module.
 * Append-only security log. Written synchronously (single indexed insert,
 * never blocking the hot path for long). Never user-editable.
 */
import { pool, withSystem } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { AuditAction } from '@codeconclave/shared';

export interface AuditRecordInput {
  action: AuditAction | string;
  actorUserId?: string | null;
  scope: 'USER' | 'TEAM' | 'SYSTEM';
  tenantId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  success?: boolean;
}

export async function recordAudit(input: AuditRecordInput): Promise<void> {
  const id = newId(PREFIX.AUDIT);
  await withSystem(async (q) => {
    await q.query(
      `INSERT INTO audit_logs
         (id, actor_user_id, tenant_scope, tenant_id, action, resource_type, resource_id,
          detail, ip, user_agent, correlation_id, success)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        input.actorUserId ?? null,
        input.scope,
        input.tenantId ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.detail ? JSON.stringify(input.detail) : null,
        input.ip ?? null,
        input.userAgent ?? null,
        input.correlationId ?? null,
        input.success ?? true,
      ],
    );
  }).catch((err) => {
    // Audit must never take the request down; log and continue.
    // eslint-disable-next-line no-console
    console.error('[audit] write failed', err instanceof Error ? err.message : err);
  });
}

export interface AuditQuery {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
}

export async function listAudit(query: AuditQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const where = (cond: string, value: unknown) => {
    params.push(value);
    conditions.push(cond.replace('?', `$${params.length}`));
  };
  if (query.userId) where('actor_user_id = ?', query.userId);
  if (query.action) where('action = ?', query.action);
  if (query.resourceType) where('resource_type = ?', query.resourceType);
  if (query.resourceId) where('resource_id = ?', query.resourceId);
  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(query.limit ?? 50, 200);
  params.push(limit, query.offset ?? 0);
  const result = await pool.query(
    `SELECT id, actor_user_id, tenant_scope, tenant_id, action, resource_type, resource_id,
            detail, ip, correlation_id, created_at
     FROM audit_logs ${whereSql}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows;
}