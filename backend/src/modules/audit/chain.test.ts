import { describe, expect, it } from 'vitest';
import { GENESIS, canonicalJson, rowHash, verifyRows, type StoredChainRow } from './chain.js';

function chain(n: number): StoredChainRow[] {
  const rows: StoredChainRow[] = [];
  let prev = GENESIS;
  for (let i = 1; i <= n; i += 1) {
    const base = {
      id: `aud_${i}`,
      actor_user_id: 'u1',
      tenant_scope: 'USER',
      tenant_id: 'u1',
      action: i % 2 ? 'task.cancelled' : 'memory.created',
      resource_type: 'task',
      resource_id: `t${i}`,
      // jsonb hands keys back in its own order — the hash must not care.
      detail: { z: i, a: { y: [1, 2], b: 'x' } },
      success: true,
      created_at: new Date(Date.UTC(2026, 9, 21, 10, 0, i)).toISOString(),
    };
    const hash = rowHash(prev, i, {
      id: base.id,
      actorUserId: base.actor_user_id,
      scope: base.tenant_scope,
      tenantId: base.tenant_id,
      action: base.action,
      resourceType: base.resource_type,
      resourceId: base.resource_id,
      detail: { a: { b: 'x', y: [1, 2] }, z: i },
      success: true,
      createdAt: base.created_at,
    });
    rows.push({ ...base, chain_seq: i, prev_hash: prev, row_hash: hash });
    prev = hash;
  }
  return rows;
}

describe('audit hash chain', () => {
  it('canonical JSON ignores key order and undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { y: 1, x: 2 }] } })).toBe('{"a":{"c":[3,{"x":2,"y":1}]},"b":1}');
  });

  it('an untouched chain verifies', () => {
    expect(verifyRows(chain(5))).toMatchObject({ ok: true, checked: 5, brokenAt: null });
    expect(verifyRows([])).toMatchObject({ ok: true, checked: 0, lastHash: null });
  });

  it('detects an edited row', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, action: 'payment.verified' };
    expect(verifyRows(rows)).toMatchObject({ ok: false, checked: 2, brokenAt: { seq: 3, reason: 'hash' } });
  });

  it('detects edited details (e.g. a changed amount)', () => {
    const rows = chain(4);
    rows[1] = { ...rows[1]!, detail: { z: 999, a: { y: [1, 2], b: 'x' } } };
    expect(verifyRows(rows).brokenAt).toMatchObject({ seq: 2, reason: 'hash' });
  });

  it('detects a deleted row', () => {
    const rows = chain(5);
    rows.splice(1, 1);
    expect(verifyRows(rows).brokenAt).toMatchObject({ seq: 3, reason: 'gap' });
  });

  it('detects a truncated tail using the stored chain head', () => {
    const rows = chain(5);
    const head = { lastSeq: 5, lastHash: rows[4]!.row_hash };
    expect(verifyRows(rows, head).ok).toBe(true);
    expect(verifyRows(rows.slice(0, 4), head).brokenAt).toMatchObject({ seq: 5, reason: 'truncated' });
  });

  it('detects a re-linked (forged) row', () => {
    const rows = chain(3);
    rows[2] = { ...rows[2]!, prev_hash: 'f'.repeat(64) };
    expect(verifyRows(rows).brokenAt).toMatchObject({ seq: 3, reason: 'link' });
  });
});
