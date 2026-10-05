/**
 * Artifact integrity on the real persistence path.
 *
 * saveCoworkerArtifact() is the only place a deliverable becomes durable, so the
 * SHA-256 and byte count it records must describe the exact bytes it stored, and
 * the artifact must come back byte-for-byte identical. A mocked store cannot
 * prove that, so these tests drive the real function against a DB double that
 * round-trips what was actually passed to the INSERT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const table = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

const db = vi.hoisted(() => {
  const calls: { text: string; params: unknown[] }[] = [];
  const query = async (text: string, params: unknown[] = []) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    const sql = text.replace(/\s+/g, ' ');
    if (/INSERT INTO coworker_artifacts/i.test(sql)) {
      const [id, runId, name, kind, content, sha256, sizeBytes, attemptId, verification] = params as unknown[];
      table.rows.push({ id, run_id: runId, name, kind, content, storage_key: null, sha256, size_bytes: sizeBytes, attempt_id: attemptId, verification, created_at: new Date() });
      return { rows: [] };
    }
    if (/WHERE id = \$1/i.test(sql)) {
      return { rows: table.rows.filter((r) => r.id === params[0]) };
    }
    if (/WHERE run_id = \$1/i.test(sql)) {
      return { rows: table.rows.filter((r) => r.run_id === params[0]) };
    }
    return { rows: [] };
  };
  return {
    calls,
    query,
    withTenant: async (_u: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});
vi.mock('../shared/db.js', () => db);

vi.mock('../modules/ai/gateway.js', () => ({ completeWithFallback: vi.fn(async () => ({ text: '', model: 'mock' })) }));
vi.mock('../modules/ai/router.js', () => ({ planRoute: vi.fn(async () => ({ selectedModel: 'mock' })) }));
vi.mock('../memorycoding/agentContext.js', () => ({ retrieveAgentContext: vi.fn(async () => '') }));
vi.mock('../audit/service.js', () => ({ recordAudit: vi.fn(async () => {}), AuditAction: {} }));

import { saveCoworkerArtifact, listCoworkerArtifacts } from '../modules/execution/coworkers.js';

const DELIVERABLE = '# Deploy checklist\n1. Health\n2. Migrations\n3. Rollback — café ✅\n';

/** What the DB was actually asked to store. */
const insertParams = () => db.calls.filter((c) => /INSERT INTO coworker_artifacts/i.test(c.text)).at(-1)!.params;

beforeEach(() => {
  table.rows.length = 0;
  db.calls.length = 0;
});

describe('artifact integrity — real save/list path', () => {
  it('records SHA-256 and byte count of the exact stored bytes', async () => {
    const row = await saveCoworkerArtifact({
      runId: 'crw_1', name: 'deploy-output.md', kind: 'output',
      content: DELIVERABLE, attemptId: 'atp_1', verification: 'PASS',
    });

    const expectedSha = createHash('sha256').update(DELIVERABLE).digest('hex');
    expect(row.sha256).toBe(expectedSha);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.size_bytes).toBe(Buffer.byteLength(DELIVERABLE, 'utf8'));
    // Byte length, not string length: the payload is multi-byte.
    expect(Buffer.byteLength(DELIVERABLE, 'utf8')).toBeGreaterThan(DELIVERABLE.length);

    // What reached the INSERT is exactly the content, not a JSON wrapper.
    expect(insertParams()[4]).toBe(DELIVERABLE);
    expect(insertParams()[5]).toBe(expectedSha);
    expect(insertParams()[6]).toBe(Buffer.byteLength(DELIVERABLE, 'utf8'));
  });

  it('returns the artifact byte-identical on retrieval', async () => {
    await saveCoworkerArtifact({ runId: 'crw_1', name: 'deploy-output.md', kind: 'output', content: DELIVERABLE, verification: 'PASS' });

    const [found] = await listCoworkerArtifacts('crw_1');

    expect(found!.content).toBe(DELIVERABLE);
    expect(found!.sha256).toBe(createHash('sha256').update(found!.content as string).digest('hex'));
    expect(found!.size_bytes).toBe(Buffer.byteLength(DELIVERABLE, 'utf8'));
    expect(found!.content).not.toBe('null');
  });

  it('keeps the deliverable and the review separately retrievable and hash-distinct', async () => {
    await saveCoworkerArtifact({ runId: 'crw_2', name: 'deploy-output.md', kind: 'output', content: DELIVERABLE, verification: 'PASS' });
    await saveCoworkerArtifact({ runId: 'crw_3', name: 'deploy-review.md', kind: 'review', content: 'PASS — looks good.', verification: 'PASS' });

    const deliverable = (await listCoworkerArtifacts('crw_2'))[0]!;
    const review = (await listCoworkerArtifacts('crw_3'))[0]!;

    expect(deliverable.content).toBe(DELIVERABLE);
    expect(review.content).toBe('PASS — looks good.');
    expect(deliverable.sha256).not.toBe(review.sha256);
  });

  it('hashes an empty body rather than skipping the digest', async () => {
    const row = await saveCoworkerArtifact({ runId: 'crw_4', name: 'empty.md', kind: 'output' });

    expect(row.content).toBeNull();
    expect(row.sha256).toBe(createHash('sha256').update('').digest('hex'));
    expect(row.size_bytes).toBe(0);
  });
});
