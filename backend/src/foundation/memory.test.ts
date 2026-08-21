/**
 * CodeConClave — memory foundation tests (Section: M&M memory).
 * Covers: tenant/project isolation, confidence defaults, no-fake-embeddings
 * guarantee, backfill honesty. DB interaction is mocked; the embedding
 * provider is never contacted (no key, and the code refuses to invent vectors).
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
  const queryOne = async (text: string, params: unknown[] = []) => {
    const result = await query(text, params);
    return result.rows[0] ?? null;
  };
  return {
    state,
    pool: { query },
    queryOne,
    queryMany: queryRows,
    withTenant: async (_userId: string | null, fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    withSystem: async (fn: (q: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  };
});

vi.mock('../shared/db.js', () => db);
const recordAudit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../modules/audit/service.js', () => ({ recordAudit }));

import { AppError } from '../shared/errors.js';
import { env } from '../config/env.js';
import { MemoryType as MT, MemorySource as MS } from '@codeconclave/shared';
import { createMemory, listMemories, embeddingFor, backfillEmbedding } from '../modules/memory/service.js';

function memoryRow(id: string): Record<string, unknown> {
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
    provenance: null,
    contradiction_state: 'NONE',
    superseded_by_id: null,
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

beforeEach(() => {
  db.state.calls = [];
  db.state.rows = [];
  db.state.rowCount = 0;
  db.state.resolve = null;
  recordAudit.mockClear();
  env.OPENAI_API_KEY = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMemory — isolation + confidence', () => {
  it('stores project/team/owner scoping and never an embedding column', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM memories')) return [memoryRow(String(params[0] ?? 'm1'))];
      return null;
    };
    const memory = await createMemory('u1', {
      projectId: 'p1',
      type: MT.SEMANTIC,
      source: MS.USER_STATED,
      content: 'the user prefers TypeScript',
    });
    expect(memory.id).toBeTruthy();
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO memories'))!;
    expect(insert.text).not.toContain('embedding');
    expect(insert.params[1]).toBe('p1'); // project_id
    expect(insert.params[3]).toBe('u1'); // owner_id
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'memory.created' }));
  });

  it('defaults confidence from source (USER_STATED 0.9, AI_INFERRED 0.3)', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM memories')) return [memoryRow(String(params[0]))];
      return null;
    };
    await createMemory('u1', { projectId: 'p1', type: MT.EPISODIC, source: MS.USER_STATED, content: 'x' });
    let insert = db.state.calls.find((c) => c.text.includes('INSERT INTO memories'))!;
    expect(insert.params[8]).toBe(0.9);

    await createMemory('u1', { projectId: 'p1', type: MT.EPISODIC, source: MS.AI_INFERRED, content: 'x' });
    insert = db.state.calls.filter((c) => c.text.includes('INSERT INTO memories')).at(-1)!;
    expect(insert.params[8]).toBe(0.3);
  });

  it('rejects writes to a project the user cannot access', async () => {
    db.state.resolve = (text) => (text.includes('SELECT 1 FROM projects') ? [] : null);
    await expect(
      createMemory('u1', { projectId: 'ghost', type: MT.SEMANTIC, source: MS.OBSERVED, content: 'x' }),
    ).rejects.toThrow(AppError);
  });

  it('honors explicit confidence and tenantId', async () => {
    db.state.resolve = (text, params) => {
      if (text.includes('SELECT 1 FROM projects')) return [{}];
      if (text.includes('FROM memories')) return [memoryRow(String(params[0]))];
      return null;
    };
    await createMemory('u1', {
      projectId: 'p1',
      tenantId: 'team-9',
      type: MT.TEAM,
      source: MS.RECOMMENDATION,
      content: 'x',
      confidence: 0.5,
    });
    const insert = db.state.calls.find((c) => c.text.includes('INSERT INTO memories'))!;
    expect(insert.params[2]).toBe('team-9'); // team_id
    expect(insert.params[8]).toBe(0.5);
  });
});

describe('listMemories — CURRENT PROJECT ONLY default', () => {
  it('defaults to personal scope (project_id IS NULL) when no project is given', async () => {
    db.state.rows = [];
    const result = await listMemories('u1', {});
    expect(result.items).toEqual([]);
    const select = db.state.calls.find((c) => c.text.includes('SELECT * FROM memories'))!;
    expect(select.text).toContain('project_id IS NULL');
    expect(select.text).toContain('deleted_at IS NULL');
    const count = db.state.calls.find((c) => c.text.includes('count(*)'))!;
    expect(count.params[0]).toBe('u1');
    // Stage 21 regression: the personal-scope branch binds no project param,
    // so the count query must receive exactly one value — over-binding a null
    // caused "bind message supplies 2 parameters, but prepared statement
    // requires 1" (HTTP 500 on GET /api/v1/memory).
    expect(count.params).toEqual(['u1']);
    expect(count.text).not.toContain('$2');
  });

  it('filters to the given project when provided', async () => {
    const result = await listMemories('u1', { projectId: 'p1' });
    expect(result.total).toBe(0);
    const select = db.state.calls.find((c) => c.text.includes('SELECT * FROM memories'))!;
    expect(select.text).toContain('project_id = $2');
    const count = db.state.calls.find((c) => c.text.includes('count(*)'))!;
    expect(count.params).toEqual(['u1', 'p1']);
  });

  it('supports type and search filters without losing isolation', async () => {
    const result = await listMemories('u1', { projectId: 'p1', type: MT.SEMANTIC, search: 'typescript' });
    expect(result.total).toBe(0);
    const select = db.state.calls.find((c) => c.text.includes('SELECT * FROM memories'))!;
    expect(select.text).toContain('project_id = $2');
    expect(select.text).toContain('content ILIKE $4 OR provenance ILIKE $4');
  });
});

describe('embeddings — honest, never fake', () => {
  it('returns null without an OpenAI key (no invented vectors)', async () => {
    env.OPENAI_API_KEY = undefined;
    await expect(embeddingFor('hello')).resolves.toBeNull();
  });

  it('returns null when the provider is unreachable or rejects', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    const fetchMock = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    await expect(embeddingFor('hello')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', expect.objectContaining({ method: 'POST' }));
  });

  it('returns null for malformed provider payloads', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) })) as unknown as typeof fetch,
    );
    await expect(embeddingFor('hello')).resolves.toBeNull();
  });

  it('accepts a valid 1536-dimension embedding', async () => {
    env.OPENAI_API_KEY = 'sk-test';
    const body = Array.from({ length: 1536 }, (_, i) => (i % 7) / 10);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ embedding: body }] }) })) as unknown as typeof fetch,
    );
    const embedding = await embeddingFor('hello');
    expect(embedding).toHaveLength(1536);
  });

  it('backfill skips the UPDATE when no embedding is available (no fake vectors)', async () => {
    env.OPENAI_API_KEY = undefined;
    db.state.resolve = (text, params) => {
      if (text.includes('FROM memories')) return [{ id: String(params[0]), content: 'some content' }];
      return null;
    };
    await backfillEmbedding('m1');
    expect(db.state.calls.some((c) => c.text.includes('UPDATE memories SET embedding'))).toBe(false);
    expect(db.state.resolve).toBeTruthy();
  });
});