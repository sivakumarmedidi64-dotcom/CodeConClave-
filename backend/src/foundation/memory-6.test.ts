/**
 * CodeConClave — Phase 6 memory foundation tests.
 * Covers: REAL embeddings (provider honesty, dimension validation, status
 * pipeline QUEUED/FAILED/READY, background queue), search modes
 * (FULL_TEXT / VECTOR / HYBRID with honest degradation + reciprocal-rank
 * fusion), filters + scoping, corrections (wrong/correct/edit/merge/delete/
 * restore provenance trail), relationships, verification states, scoped chat
 * context, and Phase 6 fields in the JSON contract. DB + provider are mocked;
 * no real provider is contacted; no vector is ever fabricated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const state: {
    calls: { text: string; params: unknown[] }[];
    rows: unknown[];
    rowCount: number;
    resolve: ((text: string, params: unknown[]) => unknown[] | null) | null;
  } = {
    calls: [],
    rows: [],
    rowCount: 0,
    resolve: null,
  };
  const query = async (text: string, params: unknown[] = []) => {
    state.calls.push({ text, params });
    const rows = state.resolve ? state.resolve(text, params) : null;
    return { rows: rows ?? state.rows, rowCount: state.rowCount };
  };
  const queryRows = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows;
  };
  return {
    state,
    pool: { query },
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));
vi.mock('../modules/dna/service.js', () => ({
  retrieveDnaForPrompt: vi.fn(async () => ['[DECISION v1]: Use Postgres'] as string[]),
}));

import { AppError } from '../shared/errors.js';
import { env } from '../config/env.js';
import { MemoryType as MT, MemorySource as MS } from '@codeconclave/shared';
import {
  addMemoryRelationship,
  correctMemory,
  ensureEmbedding,
  flagMemoryWrong,
  listMemoryRelationships,
  mergeMemories,
  processEmbeddingQueue,
  searchMemories,
  toMemoryJson,
  verifyMemory,
} from '../modules/memory/service.js';
import {
  embedText,
  getEmbeddingProvider,
  isVectorValid,
  resetEmbeddingProvider,
} from '../modules/ai/embeddings.js';
import { retrieveScopedContext } from '../modules/memory/context.js';

const vector1536 = () => Array.from({ length: 1536 }, (_, i) => i / 1536);

function memoryRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_id: 'p1',
    team_id: null,
    owner_id: 'u1',
    type: MT.SEMANTIC,
    source: MS.USER_STATED,
    content: 'the user prefers TypeScript',
    structured: null,
    confidence: 0.9,
    provenance: 'conversation://c1',
    contradiction_state: 'NONE',
    superseded_by_id: null,
    embedding_status: 'NONE',
    embedding_model: null,
    embedding_dimensions: null,
    verification_state: 'UNVERIFIED',
    scope: 'PROJECT',
    deleted_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fetchOk(vector: number[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: vector }] }) }));
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  env.OPENAI_API_KEY = undefined;
  resetEmbeddingProvider();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('real embeddings — provider honesty + dimension validation', () => {
  it('returns null when no API key is configured (never fakes a provider)', () => {
    expect(getEmbeddingProvider()).toBeNull();
  });

  it('returns an OpenAI provider with the documented model + dimensions when configured', () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    const provider = getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider!.id).toBe('openai');
    expect(provider!.model).toBe('text-embedding-3-small');
    expect(provider!.dimensions).toBe(1536);
  });

  it('isVectorValid rejects wrong dimensions and non-finite values', () => {
    expect(isVectorValid(vector1536())).toBe(true);
    expect(isVectorValid(Array.from({ length: 128 }, () => 0.5))).toBe(false);
    const bad = vector1536();
    bad[0] = Number.NaN;
    expect(isVectorValid(bad)).toBe(false);
  });

  it('embedText embeds through the provider and rejects dimension mismatches', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', fetchOk(vector1536()));
    const embedding = await embedText('hello');
    expect(embedding).toHaveLength(1536);

    vi.stubGlobal('fetch', fetchOk(Array.from({ length: 64 }, () => 0.5)));
    await expect(embedText('hello')).rejects.toThrow(/dimension mismatch/);
  });

  it('embedText throws when no provider is configured', async () => {
    await expect(embedText('hello')).rejects.toThrow('no embedding provider configured');
  });
});

describe('ensureEmbedding — QUEUED / FAILED / READY status pipeline', () => {
  it('marks QUEUED when no provider is configured and never invents a vector', async () => {
    db.state.resolve = (text) => (text.includes('FROM memories') ? [memoryRow('m1')] : null);
    const status = await ensureEmbedding('m1');
    expect(status).toBe('QUEUED');
    const update = db.state.calls.find((c) => c.text.includes("embedding_status = 'QUEUED'"))!;
    expect(update).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes('embedding = $1::vector'))).toBe(false);
  });

  it('stores a real vector + model + dimensions and marks READY', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', fetchOk(vector1536()));
    db.state.resolve = (text) => (text.includes('FROM memories') ? [memoryRow('m1')] : null);
    const status = await ensureEmbedding('m1');
    expect(status).toBe('READY');
    const update = db.state.calls.find((c) => c.text.includes('embedding_status = \'READY\''))!;
    expect(update).toBeDefined();
    expect(update.text).toContain('embedding = $1::vector');
    expect(update.text).toContain('embedding_model = $2');
    expect(update.text).toContain('embedding_dimensions = $3');
    const vectorParam = JSON.parse(String(update.params[0]));
    expect(vectorParam).toHaveLength(1536);
    expect(update.params[1]).toBe('text-embedding-3-small');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.embedded' }));
  });

  it('marks FAILED when the provider call fails and never stores a vector', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    db.state.resolve = (text) => (text.includes('FROM memories') ? [memoryRow('m1')] : null);
    const status = await ensureEmbedding('m1');
    expect(status).toBe('FAILED');
    expect(db.state.calls.find((c) => c.text.includes("embedding_status = 'FAILED'"))).toBeDefined();
    expect(db.state.calls.some((c) => c.text.includes('embedding = $1::vector'))).toBe(false);
  });

  it('is a no-op for already-READY memories', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    db.state.resolve = (text) => (text.includes('FROM memories') ? [memoryRow('m1', { embedding_status: 'READY' })] : null);
    const status = await ensureEmbedding('m1');
    expect(status).toBe('READY');
    expect(db.state.calls.filter((c) => c.text.startsWith('UPDATE')).length).toBe(0);
  });
});

describe('processEmbeddingQueue — bounded background batch', () => {
  it('returns 0 without a provider (nothing to process)', async () => {
    expect(await processEmbeddingQueue()).toBe(0);
  });

  it('embeds queued memories and counts successes', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', fetchOk(vector1536()));
    db.state.resolve = (text) => {
      if (text.includes("embedding_status = 'QUEUED'")) return [memoryRow('m1'), memoryRow('m2')];
      return null;
    };
    const processed = await processEmbeddingQueue(5);
    expect(processed).toBe(2);
    const readyUpdates = db.state.calls.filter((c) => c.text.includes('embedding_status = \'READY\''));
    expect(readyUpdates).toHaveLength(2);
  });

  it('marks failures FAILED without aborting the batch', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    db.state.resolve = (text) => {
      if (text.includes("embedding_status = 'QUEUED'")) return [memoryRow('m1'), memoryRow('m2')];
      return null;
    };
    const processed = await processEmbeddingQueue(5);
    expect(processed).toBe(0);
    expect(db.state.calls.filter((c) => c.text.includes("embedding_status = 'FAILED'"))).toHaveLength(2);
  });
});

describe('searchMemories — FULL_TEXT', () => {
  it('is owner-scoped, defaults to current-project-only, and uses FTS', async () => {
    db.state.resolve = (text) => (text.includes('to_tsvector') ? [memoryRow('m1')] : null);
    const result = await searchMemories('u1', { query: 'typescript', mode: 'FULL_TEXT' });
    expect(result.modeUsed).toBe('FULL_TEXT');
    expect(result.items.map((m) => m.id)).toEqual(['m1']);
    const fts = db.state.calls.find((c) => c.text.includes('to_tsvector'))!;
    expect(fts.text).toContain('owner_id = $1');
    expect(fts.text).toContain('project_id IS NULL');
    expect(fts.text).toContain("to_tsvector('simple', content) @@ plainto_tsquery('simple', $2)");
  });

  it('applies type, confidence, verification, contradiction filters and project scoping', async () => {
    db.state.resolve = (text) => (text.includes('to_tsvector') ? [memoryRow('m1')] : null);
    await searchMemories('u1', {
      query: 'x',
      mode: 'FULL_TEXT',
      projectId: 'p1',
      type: MT.SEMANTIC,
      minConfidence: 0.6,
      verification: 'VERIFIED',
      contradiction: 'NONE',
    });
    const fts = db.state.calls.find((c) => c.text.includes('to_tsvector'))!;
    expect(fts.text).toContain('project_id = $2');
    expect(fts.text).toContain('type = $3');
    expect(fts.text).toContain('confidence >= $4');
    expect(fts.text).toContain('verification_state = $5');
    expect(fts.text).toContain('contradiction_state = $6');
    expect(fts.params[1]).toBe('p1');
    expect(fts.params[2]).toBe(MT.SEMANTIC);
    expect(fts.params[3]).toBe(0.6);
  });

  it('searchAll widens scope to project OR team memories', async () => {
    db.state.resolve = (text) => (text.includes('to_tsvector') ? [] : null);
    await searchMemories('u1', { query: 'x', mode: 'FULL_TEXT', searchAll: true });
    const fts = db.state.calls.find((c) => c.text.includes('to_tsvector'))!;
    expect(fts.text).toContain('($2::text IS NULL OR project_id = $2 OR team_id IS NOT NULL)');
  });
});

describe('searchMemories — VECTOR', () => {
  it('uses pgvector cosine search when a provider is configured', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', fetchOk(vector1536()));
    db.state.resolve = (text) => (text.includes('embedding <=>') ? [memoryRow('m2')] : null);
    const result = await searchMemories('u1', { query: 'typescript', mode: 'VECTOR' });
    expect(result.modeUsed).toBe('VECTOR');
    expect(result.items.map((m) => m.id)).toEqual(['m2']);
    const vectorCall = db.state.calls.find((c) => c.text.includes('embedding <=>'))!;
    expect(vectorCall.text).toContain('embedding <=> $2::vector');
    expect(vectorCall.text).toContain('embedding IS NOT NULL');
    const embedding = vectorCall.params[1] as number[];
    expect(embedding).toHaveLength(1536);
  });

  it('degrades honestly to FULL_TEXT when no provider is configured', async () => {
    db.state.resolve = (text) => (text.includes('to_tsvector') ? [memoryRow('m1')] : null);
    const result = await searchMemories('u1', { query: 'typescript', mode: 'VECTOR' });
    expect(result.modeUsed).toBe('FULL_TEXT');
    expect(db.state.calls.some((c) => c.text.includes('embedding <=>'))).toBe(false);
  });
});

describe('searchMemories — HYBRID', () => {
  it('degrades to FULL_TEXT without a provider', async () => {
    db.state.resolve = (text) => (text.includes('to_tsvector') ? [memoryRow('m1')] : null);
    const result = await searchMemories('u1', { query: 'typescript', mode: 'HYBRID' });
    expect(result.modeUsed).toBe('FULL_TEXT');
  });

  it('fuses vector + FTS results by reciprocal rank', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    resetEmbeddingProvider();
    vi.stubGlobal('fetch', fetchOk(vector1536()));
    db.state.resolve = (text) => {
      if (text.includes('embedding <=>')) return [memoryRow('b'), memoryRow('a')];
      if (text.includes('to_tsvector')) return [memoryRow('b'), memoryRow('c')];
      return null;
    };
    const result = await searchMemories('u1', { query: 'typescript', mode: 'HYBRID' });
    expect(result.modeUsed).toBe('HYBRID');
    const vectorCall = db.state.calls.find((c) => c.text.includes('embedding <=>'))!;
    expect(vectorCall).toBeDefined();
    const ftsCall = db.state.calls.find((c) => c.text.includes('to_tsvector'))!;
    expect(ftsCall).toBeDefined();
    expect(result.items[0]?.id).toBe('b');
    expect(result.items).toHaveLength(3);
  });
});

describe('corrections — wrong / correct / merge provenance trail', () => {
  it('correctMemory marks REJECTED + contradicted, creates the correction memory and logs the trail', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'), { verification_state: 'REJECTED', contradiction_state: 'CONFIRMED' })];
      return null;
    };
    const result = await correctMemory('u1', 'm1', 'the user actually prefers Python');
    expect(result.verification_state).toBe('REJECTED');
    const mark = db.state.calls.find((c) => c.text.includes("contradiction_state = 'CONFIRMED'"))!;
    expect(mark.text).toContain('confidence = 0');
    expect(mark.text).toContain("verification_state = 'REJECTED'");
    expect(db.state.calls.some((c) => c.text.includes("'supersedes'"))).toBe(true);
    const correction = db.state.calls.find((c) => c.text.includes('INSERT INTO memory_corrections'))!;
    expect(correction.params[3]).toBe('FLAG_WRONG');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.corrected' }));
  });

  it('flagMemoryWrong records the FLAG_WRONG provenance row', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'))];
      return null;
    };
    await flagMemoryWrong('u1', 'm1', 'stale info');
    const correction = db.state.calls.find((c) => c.text.includes('INSERT INTO memory_corrections'))!;
    expect(correction).toBeDefined();
    expect(correction.params[3]).toBe('FLAG_WRONG');
    expect(correction.params[4]).toBe('stale info');
  });

  it('mergeMemories supersedes the target, links it, and refuses self-merge', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'), { superseded_by_id: 'm2', verification_state: 'REJECTED' })];
      return null;
    };
    const merged = await mergeMemories('u1', 'm1', 'm2', 'duplicate');
    expect(merged.superseded_by_id).toBe('m2');
    const update = db.state.calls.find((c) => c.text.includes('superseded_by_id = $2'))!;
    expect(update.text).toContain("verification_state = 'REJECTED'");
    const correction = db.state.calls.find((c) => c.text.includes('INSERT INTO memory_corrections'))!;
    expect(correction.params[3]).toBe('MERGE');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.merged' }));
    await expect(mergeMemories('u1', 'm1', 'm1')).rejects.toThrow(AppError);
  });

  it('verifyMemory flips VERIFIED / REJECTED with audit', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'), { verification_state: 'VERIFIED' })];
      return null;
    };
    const verified = await verifyMemory('u1', 'm1', 'VERIFIED');
    expect(verified.verification_state).toBe('VERIFIED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.verified' }));
    await verifyMemory('u1', 'm1', 'REJECTED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.rejected' }));
  });
});

describe('relationships', () => {
  it('adds a weighted relationship and clamps the weight', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'))];
      return null;
    };
    await addMemoryRelationship('u1', 'm1', 'm2', 'supports', 1.5);
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO memory_relationships'))!;
    expect(insert.params[3]).toBe('supports');
    expect(insert.params[4]).toBe(1);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.relationship_added' }));
  });

  it('lists relationships for either endpoint', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('FROM memory_relationships')) return [{ id: 'r1', source_memory_id: 'm1', target_memory_id: 'm2', relation: 'supports', weight: 0.5, created_at: new Date() }];
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'))];
      return null;
    };
    const rows = await listMemoryRelationships('u1', 'm1');
    expect(rows).toHaveLength(1);
    expect(db.state.calls.find((c) => c.text.includes('source_memory_id = $1 OR target_memory_id = $1'))).toBeDefined();
  });
});

describe('scoped chat context', () => {
  it('combines project memory + MAIN DNA for the prompt', async () => {
    db.state.resolve = (text) => (text.includes('FROM memories') ? [memoryRow('m1')] : null);
    const ctx = await retrieveScopedContext('u1', { projectId: 'p1' });
    expect(ctx.memories.length).toBeGreaterThan(0);
    expect(ctx.memories[0]).toContain('[USER_STATED @ conversation://c1]');
    expect(ctx.dna).toEqual(['[DECISION v1]: Use Postgres']);
  });
});

describe('memory JSON contract (Phase 6 fields)', () => {
  it('exposes embeddingStatus, verificationState and scope', () => {
    const json = toMemoryJson(memoryRow('m1') as never);
    expect(json.embeddingStatus).toBe('NONE');
    expect(json.embeddingModel).toBeNull();
    expect(json.verificationState).toBe('UNVERIFIED');
    expect(json.scope).toBe('PROJECT');
  });
});