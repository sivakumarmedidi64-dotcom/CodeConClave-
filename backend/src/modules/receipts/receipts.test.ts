/**
 * CodeConClave — Verified Execution Receipts + Spec-to-Proof tests.
 * shared/db is mocked with in-memory tables; hashing is real. Covers:
 * issue → verify ok, hash-chain tamper detection, chain-link validation,
 * proof verdicts (PASS needs a real verifier; otherwise SKIPPED/FAIL),
 * empty criteria → no proof rows, determinism of canonical hashing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const tables = vi.hoisted(() => ({
  receipts: [] as Record<string, unknown>[],
  proofs: [] as Record<string, unknown>[],
}));

vi.mock('../../shared/db.js', () => {
  const query = async (text: string, params: unknown[] = []) => {
    if (text.includes('INSERT INTO artifact_receipts')) {
      tables.receipts.push({
        id: params[0],
        task_id: params[1],
        attempt_id: params[2],
        project_id: params[3],
        owner_id: params[4],
        artifact_sha256: params[5],
        run_refs: JSON.parse(params[6] as string),
        input_hashes: JSON.parse(params[7] as string),
        verification: params[8],
        models: JSON.parse(params[9] as string),
        prev_receipt_hash: params[10],
        receipt_hash: params[11],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO spec_proofs')) {
      tables.proofs.push({
        id: params[0],
        receipt_id: params[1],
        task_id: params[2],
        criterion: params[3],
        verdict: params[4],
        evidence: JSON.parse(params[5] as string),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM artifact_receipts') && text.includes('LIMIT 1')) {
      const rows = tables.receipts
        .filter((r) => r.task_id === params[0])
        .sort((a, b) => String(a.id) < String(b.id) ? 1 : -1);
      return { rows: rows.slice(0, 1).map((r) => ({ receipt_hash: r.receipt_hash, id: r.id })), rowCount: 1 };
    }
    if (text.includes('FROM artifact_receipts')) {
      return { rows: tables.receipts.filter((r) => r.task_id === params[0]), rowCount: 1 };
    }
    if (text.includes('FROM spec_proofs')) {
      return { rows: tables.proofs.filter((p) => (params[0] !== undefined && text.includes('receipt_id') ? p.receipt_id === params[0] : p.task_id === params[0])), rowCount: 1 };
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return {
    pool: { query },
    queryOne: async (text: string, params: unknown[] = []) => (await query(text, params)).rows[0] ?? null,
    queryMany: async (text: string, params: unknown[] = []) => (await query(text, params)).rows,
    withTenant: async (_u: unknown, fn: (q: unknown) => unknown) => fn({ query }),
    withSystem: async (fn: (q: unknown) => unknown) => fn({ query }),
  };
});

import {
  issueReceipt,
  verifyReceiptChain,
  getProofMatrix,
  verdictFor,
  stableStringify,
  computeReceiptHash,
} from './service.js';

const base = {
  taskId: 'tsk-1',
  attemptId: 'atp-1',
  projectId: 'prj-1',
  ownerId: 'usr-1',
  artifactContent: '{"done":true}',
  verification: 'PASS',
  runs: [{ runId: 'crw-1', coworkerType: 'CODER', orderIndex: 0, verification: 'PASS', output: { files: 3 } }],
  criteria: ['output has 3 files'],
};

beforeEach(() => {
  tables.receipts = [];
  tables.proofs = [];
});

describe('Verified Execution Receipts', () => {
  it('issues a receipt and verifies the chain', async () => {
    const r = await issueReceipt(base);
    expect(r.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.prevReceiptHash).toBeNull();
    expect(r.proofVerdicts).toEqual([{ criterion: 'output has 3 files', verdict: 'PASS' }]);
    expect(await verifyReceiptChain('tsk-1')).toEqual({ ok: true, count: 1, brokenAt: null });
    const matrix = await getProofMatrix('tsk-1');
    expect(matrix.receiptId).toBe(r.id);
    expect(matrix.proofs).toHaveLength(1);
    expect(matrix.proofs[0]!.evidence).toMatchObject({ verification: 'PASS' });
  });

  it('chains a second receipt to the first', async () => {
    const first = await issueReceipt(base);
    const second = await issueReceipt({ ...base, attemptId: 'atp-2', artifactContent: '{"done":2}' });
    expect(second.prevReceiptHash).toBe(first.receiptHash);
    expect(await verifyReceiptChain('tsk-1')).toEqual({ ok: true, count: 2, brokenAt: null });
  });

  it('detects tampered bytes', async () => {
    const r = await issueReceipt(base);
    (tables.receipts.find((x) => x.id === r.id) as Record<string, unknown>).verification = 'PASS (edited)';
    const res = await verifyReceiptChain('tsk-1');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(r.id);
  });

  it('detects a broken chain link', async () => {
    const second = await issueReceipt({ ...base, attemptId: 'atp-2' });
    // forge: point second receipt at a wrong predecessor
    (tables.receipts.find((x) => x.id === second.id) as Record<string, unknown>).prev_receipt_hash = 'forged';
    const res = await verifyReceiptChain('tsk-1');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(second.id);
  });

  it('SKIPPED verdict when no verifier ran; FAIL only on real failure', async () => {
    const skipped = await issueReceipt({ ...base, taskId: 'tsk-s', verification: 'SKIPPED' });
    expect(skipped.proofVerdicts).toEqual([{ criterion: 'output has 3 files', verdict: 'SKIPPED' }]);
    const failed = await issueReceipt({ ...base, taskId: 'tsk-f', verification: 'FAIL: tests red' });
    expect(failed.proofVerdicts).toEqual([{ criterion: 'output has 3 files', verdict: 'FAIL' }]);
  });

  it('writes no proof rows without criteria', async () => {
    await issueReceipt({ ...base, taskId: 'tsk-n', criteria: [] });
    expect(tables.proofs.filter((p) => p.task_id === 'tsk-n')).toHaveLength(0);
    expect(await verifyReceiptChain('tsk-n')).toEqual({ ok: true, count: 1, brokenAt: null });
  });

  it('canonical hashing is key-order independent and deterministic', () => {
    expect(stableStringify({ b: 1, a: { y: 2, x: 1 } })).toBe(stableStringify({ a: { x: 1, y: 2 }, b: 1 }));
    expect(computeReceiptHash(null, 'x')).toMatch(/^[0-9a-f]{64}$/);
    expect(verdictFor('SKIPPED')).toBe('SKIPPED');
  });
});
