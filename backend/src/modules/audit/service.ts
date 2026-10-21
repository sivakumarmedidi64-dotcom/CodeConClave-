/**
 * CodeConClave — audit module.
 * Append-only security log. Written synchronously (one short transaction,
 * never blocking the hot path for long). Never user-editable.
 *
 * Tamper-evident: every row joins its tenant's hash chain (see chain.ts). A
 * per-chain advisory lock serializes writers so the chain never forks; the
 * unique (chain_key, chain_seq) index rejects anything that tries.
 */
import { pool, withSystem } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { AuditAction } from '@codeconclave/shared';
import { GENESIS, chainKeyFor, rowHash, verifyRows, type ChainVerdict, type StoredChainRow } from './chain.js';

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
  const chainKey = chainKeyFor(input.scope, input.tenantId);
  const createdAt = new Date().toISOString();
  const detail = input.detail ? (JSON.parse(JSON.stringify(input.detail)) as unknown) : null;
  await withSystem(async (q) => {
    // Serialize writers on this chain, then read its tip inside the lock.
    await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [chainKey]);
    const tip = (
      await q.query<{ chain_seq: string | number; row_hash: string }>(
        'SELECT chain_seq, row_hash FROM audit_logs WHERE chain_key = $1 ORDER BY chain_seq DESC LIMIT 1',
        [chainKey],
      )
    ).rows[0];
    const seq = tip ? Number(tip.chain_seq) + 1 : 1;
    const prevHash = tip?.row_hash ?? GENESIS;
    const hash = rowHash(prevHash, seq, {
      id,
      actorUserId: input.actorUserId ?? null,
      scope: input.scope,
      tenantId: input.tenantId ?? null,
      action: String(input.action),
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      detail,
      success: input.success ?? true,
      createdAt,
    });
    await q.query(
      `INSERT INTO audit_logs
         (id, actor_user_id, tenant_scope, tenant_id, action, resource_type, resource_id,
          detail, ip, user_agent, correlation_id, success,
          chain_key, chain_seq, prev_hash, row_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        input.actorUserId ?? null,
        input.scope,
        input.tenantId ?? null,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        detail === null ? null : JSON.stringify(detail),
        input.ip ?? null,
        input.userAgent ?? null,
        input.correlationId ?? null,
        input.success ?? true,
        chainKey,
        seq,
        prevHash,
        hash,
        createdAt,
      ],
    );
    await q.query(
      `INSERT INTO audit_chain_heads (chain_key, last_seq, last_hash) VALUES ($1, $2, $3)
       ON CONFLICT (chain_key) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash, updated_at = now()`,
      [chainKey, seq, hash],
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
export interface AuditChainReport extends ChainVerdict {
  chainKey: string;
  /** Audit rows for this tenant written before the chain existed. */
  legacyRows: number;
  checkedAt: string;
}

/**
 * Verify the signed-in user's own audit chain end to end (bounded). The chain
 * key is derived from the authenticated user id only, and it includes system
 * actions taken on their account, so it is read in system scope.
 */
export async function verifyUserAuditChain(userId: string, limit = 20_000): Promise<AuditChainReport> {
  const chainKey = chainKeyFor('USER', userId);
  const { rows, legacy, head } = await withSystem(async (q) => {
    const r = await q.query<StoredChainRow>(
      `SELECT id, actor_user_id, tenant_scope, tenant_id, action, resource_type, resource_id,
              detail, success, created_at, chain_seq, prev_hash, row_hash
         FROM audit_logs WHERE chain_key = $1 ORDER BY chain_seq ASC LIMIT $2`,
      [chainKey, limit],
    );
    const l = await q.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM audit_logs WHERE tenant_scope = 'USER' AND tenant_id = $1 AND chain_key IS NULL`,
      [userId],
    );
    const h = await q.query<{ last_seq: string | number; last_hash: string }>(
      'SELECT last_seq, last_hash FROM audit_chain_heads WHERE chain_key = $1',
      [chainKey],
    );
    const headRow = h.rows[0];
    return {
      rows: r.rows,
      legacy: Number(l.rows[0]?.n ?? 0),
      head: headRow ? { lastSeq: Number(headRow.last_seq), lastHash: headRow.last_hash } : null,
    };
  });
  // A bounded read can't prove the tail, so only compare the head when we read it all.
  const complete = rows.length < limit;
  return { chainKey, ...verifyRows(rows, complete ? head : null), legacyRows: legacy, checkedAt: new Date().toISOString() };
}
