/**
 * CodeConClave — tamper-evident audit chain.
 *
 * Each audit row joins a per-tenant hash chain:
 *   row_hash = sha256(prev_hash + "|" + chain_seq + "|" + canonicalJson(row))
 * Canonical JSON sorts object keys at every depth and drops undefined, so the
 * hash computed at write time can be recomputed from the stored row (jsonb
 * reorders keys; we never depend on its order).
 */
import { createHash } from 'node:crypto';

export const GENESIS = 'GENESIS';

export function chainKeyFor(scope: string, tenantId: string | null | undefined): string {
  return `${scope}:${tenantId ?? 'system'}`;
}

/** Deterministic JSON: sorted keys, no undefined, JSON-normalized values. */
export function canonicalJson(value: unknown): string {
  const norm = value === undefined ? null : JSON.parse(JSON.stringify(value));
  const walk = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${walk(o[k])}`)
      .join(',')}}`;
  };
  return walk(norm);
}

/** The fields a chain hash covers (everything a tamperer would want to change). */
export interface ChainedFields {
  id: string;
  actorUserId: string | null;
  scope: string;
  tenantId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  detail: unknown;
  success: boolean;
  createdAt: string;
}

export function rowHash(prevHash: string, seq: number, fields: ChainedFields): string {
  return createHash('sha256').update(`${prevHash}|${seq}|${canonicalJson(fields)}`).digest('hex');
}

export interface StoredChainRow {
  id: string;
  actor_user_id: string | null;
  tenant_scope: string;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  detail: unknown;
  success: boolean | null;
  created_at: Date | string;
  chain_seq: number | string;
  prev_hash: string;
  row_hash: string;
}

export interface ChainVerdict {
  ok: boolean;
  checked: number;
  /** First problem found, if any. */
  brokenAt: { seq: number; id: string; reason: 'gap' | 'link' | 'hash' | 'truncated' } | null;
  lastHash: string | null;
}

/**
 * Walk rows in chain_seq order and recompute every link. `head` is the
 * separately stored chain tip; rows ending before it means the newest rows
 * were deleted (which leaves no gap inside the chain).
 */
export function verifyRows(rows: StoredChainRow[], head?: { lastSeq: number; lastHash: string } | null): ChainVerdict {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    const seq = Number(r.chain_seq);
    if (seq !== expectedSeq) return { ok: false, checked: expectedSeq - 1, brokenAt: { seq, id: r.id, reason: 'gap' }, lastHash: prev };
    if (r.prev_hash !== prev) return { ok: false, checked: seq - 1, brokenAt: { seq, id: r.id, reason: 'link' }, lastHash: prev };
    const recomputed = rowHash(prev, seq, {
      id: r.id,
      actorUserId: r.actor_user_id,
      scope: r.tenant_scope,
      tenantId: r.tenant_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      detail: r.detail ?? null,
      success: r.success ?? true,
      createdAt: new Date(r.created_at).toISOString(),
    });
    if (recomputed !== r.row_hash) return { ok: false, checked: seq - 1, brokenAt: { seq, id: r.id, reason: 'hash' }, lastHash: prev };
    prev = r.row_hash;
    expectedSeq += 1;
  }
  if (head && (head.lastSeq !== rows.length || head.lastHash !== (rows.length ? prev : GENESIS))) {
    return { ok: false, checked: rows.length, brokenAt: { seq: rows.length + 1, id: '', reason: 'truncated' }, lastHash: rows.length ? prev : null };
  }
  return { ok: true, checked: rows.length, brokenAt: null, lastHash: rows.length ? prev : null };
}
