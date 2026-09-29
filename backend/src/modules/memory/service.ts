/**
 * CodeConClave — memory module (M&M).
 * Episodic, semantic, procedural, project, team. Provenance + confidence +
 * contradiction enforcement. Default retrieval: CURRENT PROJECT ONLY.
 * Retrieval fallback: vector (pgvector) → keyword → recent context.
 */
import { withTenant, withSystem } from '../../shared/db.js';
import { AppError } from '../../shared/errors.js';
import { newId, PREFIX } from '../../shared/ids.js';
import type { Memory, MemorySource, MemoryType } from '@codeconclave/shared';
import { MemoryContradictionState, MemorySource as MS } from '@codeconclave/shared';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';
import { logger } from '../../shared/logger.js';
import { getEmbeddingProvider, isVectorValid } from '../ai/embeddings.js';
import { redactSecrets } from '../secretGuard/service.js';

export interface MemoryRow {
  id: string;
  project_id: string | null;
  team_id: string | null;
  owner_id: string;
  type: string;
  source: string;
  content: string;
  structured: Record<string, unknown> | null;
  confidence: number;
  provenance: string | null;
  contradiction_state: string;
  superseded_by_id: string | null;
  embedding_status?: string;
  embedding_model?: string | null;
  embedding_dimensions?: number | null;
  verification_state?: string;
  scope?: string;
  source_message_id?: string | null;
  source_file_id?: string | null;
  task_id?: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateMemoryInput {
  projectId?: string;
  tenantId?: string;
  type: MemoryType;
  source: MemorySource;
  content: string;
  confidence?: number;
  provenance?: string;
  structured?: Record<string, unknown> | null;
}

/**
 * Server-boundary sanitization: redact known secret material recursively from
 * structured values so writes can never persist secrets when a caller forgets
 * to redact. Idempotent — already-redacted input is unchanged.
 */
function redactStructuredValues(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStructuredValues);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactStructuredValues(v);
    return out;
  }
  return value;
}

function sanitizeStructured(patch: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (patch == null) return null;
  return redactStructuredValues(patch) as Record<string, unknown>;
}

export async function createMemory(userId: string, input: CreateMemoryInput): Promise<MemoryRow> {
  const projectId = input.projectId ?? null;
  const teamId = input.tenantId ?? null;
  const content = redactSecrets(input.content);
  await withTenant(userId, async (q) => {
    if (projectId) {
      const p = await q.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [projectId, userId]);
      if (!p.rows[0]) throw AppError.notFound('Project');
    }
    const baseConfidence =
      input.source === MS.USER_STATED
        ? 0.9
        : input.source === MS.OBSERVED
          ? 0.8
          : input.source === MS.RECOMMENDATION
            ? 0.4
            : 0.3; // AI_INFERRED
    await q.query(
      `INSERT INTO memories (id, project_id, team_id, owner_id, type, source, content, structured, confidence, provenance, contradiction_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'NONE')`,
      [
        newId(PREFIX.MEMORY),
        projectId,
        teamId,
        userId,
        input.type,
        input.source,
        content,
        input.structured ? JSON.stringify(sanitizeStructured(input.structured)) : null,
        input.confidence ?? baseConfidence,
        input.provenance ?? null,
      ],
    );
  });
  const rows = await withTenant(userId, async (q) => (
    await q.query<MemoryRow>('SELECT * FROM memories WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1', [userId])
  ).rows);
  const memory = rows[0]!;
  await recordAudit({
    action: AuditAction.MEMORY_CREATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: memory.id,
    detail: { source: memory.source, type: memory.type },
  });
  // Real embeddings: provider available → embed now; otherwise QUEUED for the
  // background queue. Never fabricates vectors; never blocks creation.
  await ensureEmbedding(memory.id).catch(() => undefined);
  return memory;
}

export async function listMemories(
  userId: string,
  opts: { projectId?: string; type?: MemoryType; search?: string; includeTeam?: boolean; limit?: number; offset?: number },
): Promise<{ items: MemoryRow[]; total: number }> {
  const conditions: string[] = ['owner_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [userId];
  if (opts.includeTeam) {
    params.push(opts.projectId ?? null);
    conditions.push(`(project_id = $${params.length} OR team_id IS NOT NULL)`);
  } else if (opts.projectId) {
    params.push(opts.projectId);
    conditions.push(`project_id = $${params.length}`);
  } else {
    // Default: CURRENT PROJECT ONLY is enforced by the caller; without a project
    // id we only show memories explicitly requested. Non-project memories are
    // personal scope.
    conditions.push('project_id IS NULL');
  }
  if (opts.type) {
    conditions.push(`type = $${params.length + 1}`);
    params.push(opts.type);
  }
  if (opts.search) {
    const idx = params.length + 1;
    conditions.push(`(content ILIKE $${idx} OR provenance ILIKE $${idx})`);
    params.push(`%${opts.search}%`);
  }
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  const countParams = [...params.slice(0, params.length - 2)];
  return withTenant(userId, async (q) => {
    const count = await q.query(
      `SELECT count(*)::int AS n FROM memories WHERE ${conditions.join(' AND ')}`,
      countParams,
    );
    const items = (
      await q.query<MemoryRow>(
        `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
         ORDER BY (CASE confidence WHEN 0 THEN 1 ELSE 0 END), created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    return { items, total: count.rows[0]?.n ?? 0 };
  });
}

export async function getMemory(userId: string, memoryId: string): Promise<MemoryRow> {
  const rows = await withTenant(userId, async (q) => (
    await q.query<MemoryRow>(
      `SELECT * FROM memories WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
      [memoryId, userId],
    )
  ).rows);
  if (!rows[0]) throw AppError.notFound('Memory');
  return rows[0];
}

export async function updateMemory(
  userId: string,
  memoryId: string,
  patch: { content?: string; confidence?: number; source?: MemorySource; structured?: Record<string, unknown> | null },
): Promise<MemoryRow> {
  const existing = await getMemory(userId, memoryId);
  const fields: string[] = [];
  const params: unknown[] = [memoryId];
  if (patch.content !== undefined) {
    fields.push(`content = $${params.length + 1}`);
    params.push(redactSecrets(patch.content));
  }
  if (patch.confidence !== undefined) {
    fields.push(`confidence = $${params.length + 1}`);
    params.push(Math.max(0, Math.min(1, patch.confidence)));
  }
  if (patch.source !== undefined) {
    fields.push(`source = $${params.length + 1}`);
    params.push(patch.source);
  }
  if (patch.structured !== undefined) {
    fields.push(`structured = $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(sanitizeStructured(patch.structured)));
  }
  if (!fields.length) return existing;
  await withTenant(userId, async (q) => {
    await q.query(`UPDATE memories SET ${fields.join(', ')} WHERE id = $1`, params);
  });
  await recordMemoryCorrection({ memoryId, kind: 'EDIT', actorUserId: userId });
  await recordAudit({
    action: AuditAction.MEMORY_UPDATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: memoryId,
  });
  return getMemory(userId, memoryId);
}

export async function softDeleteMemory(userId: string, memoryId: string): Promise<void> {
  await getMemory(userId, memoryId);
  await withTenant(userId, async (q) => {
    await q.query('UPDATE memories SET deleted_at = now() WHERE id = $1', [memoryId]);
  });
  await recordMemoryCorrection({ memoryId, kind: 'DELETE', actorUserId: userId });
  await recordAudit({
    action: AuditAction.MEMORY_DELETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: memoryId,
  });
}

export async function restoreMemory(userId: string, memoryId: string): Promise<MemoryRow> {
  const result = await withTenant(userId, async (q) =>
    q.query(
      'UPDATE memories SET deleted_at = NULL WHERE id = $1 AND owner_id = $2 RETURNING *',
      [memoryId, userId],
    ),
  );
  if (!result.rows[0]) throw AppError.notFound('Memory');
  await recordMemoryCorrection({ memoryId, kind: 'RESTORE', actorUserId: userId });
  return result.rows[0] as MemoryRow;
}

export async function trashMemories(userId: string): Promise<MemoryRow[]> {
  return withTenant(userId, async (q) => (
    await q.query<MemoryRow>(
      `SELECT * FROM memories WHERE owner_id = $1 AND deleted_at IS NOT NULL
       AND deleted_at > now() - interval '30 days' ORDER BY deleted_at DESC`,
      [userId],
    )
  ).rows);
}

/**
 * Correction: user flags a memory as wrong. We NEVER silently erase history;
 * we mark a confirmed contradiction, null confidence, and create a correction
 * memory linked via relationship.
 */
export async function flagMemoryWrong(userId: string, memoryId: string, note?: string): Promise<MemoryRow> {
  const existing = await getMemory(userId, memoryId);
  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE memories SET contradiction_state = 'CONFIRMED', confidence = 0,
         updated_at = now() WHERE id = $1`,
      [memoryId],
    );
  });
  const correction = await createMemory(userId, {
    projectId: existing.project_id ?? undefined,
    type: existing.type as MemoryType,
    source: MS.USER_STATED,
    content: note?.trim()
      ? `User correction: "${existing.content}" is wrong. ${note}`
      : `User correction: "${existing.content}" is wrong.`,
    confidence: 0.9,
    provenance: `memory://${memoryId}`,
  });
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO memory_relationships (id, source_memory_id, target_memory_id, relation, weight)
       VALUES ($1,$2,$3,'contradicts',0.95)`,
      [newId(PREFIX.MEMORY), memoryId, correction.id],
    );
  });
  await recordMemoryCorrection({
    memoryId,
    correctMemoryId: correction.id,
    kind: 'FLAG_WRONG',
    reason: note ?? null,
    actorUserId: userId,
  });
  await recordAudit({
    action: 'memory.flagged_wrong',
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: memoryId,
    detail: { note: note ?? null },
  });
  return getMemory(userId, memoryId);
}

export async function addMemorySource(userId: string, memoryId: string, sourceLabel: MemorySource, sourceRef: string): Promise<void> {
  await getMemory(userId, memoryId);
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO memory_sources (id, memory_id, source_label, source_ref, captured_at)
       VALUES ($1,$2,$3,$4, now())`,
      [newId(PREFIX.MEMORY), memoryId, sourceLabel, sourceRef],
    );
  });
}

export async function listMemorySources(userId: string, memoryId: string): Promise<unknown[]> {
  await getMemory(userId, memoryId);
  return withTenant(userId, async (q) => (
    await q.query(
      `SELECT id, source_label, source_ref, captured_at, confidence FROM memory_sources
       WHERE memory_id = $1 ORDER BY captured_at DESC`,
      [memoryId],
    )
  ).rows);
}

// ---------------------------------------------------------------- retrieval

function confidenceGate(m: MemoryRow): boolean {
  if (m.contradiction_state === MemoryContradictionState.CONFIRMED) return false;
  if (m.contradiction_state === MemoryContradictionState.CANDIDATE) return Number(m.confidence) >= 0.66;
  return true;
}

/**
 * Prompt-safe retrieval: tenant + project scoped, gated by confidence and
 * contradiction state, labeled by source type. Never silently injects
 * unverified or contradicted memory.
 */
export async function retrieveMemoriesForPrompt(userId: string, projectId?: string | null, limit = 8): Promise<string[]> {
  const rows = await withTenant(userId, async (q) => (
    await q.query<MemoryRow>(
      `SELECT * FROM memories
       WHERE owner_id = $1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR project_id = $2)
       ORDER BY (CASE WHEN confidence >= 0.8 THEN 0 WHEN confidence >= 0.5 THEN 1 ELSE 2 END), created_at DESC
       LIMIT $3`,
      [userId, projectId ?? null, limit * 2],
    )
  ).rows);
  const out: string[] = [];
  for (const m of rows) {
    if (!confidenceGate(m)) continue;
    out.push(`[${m.source} @ ${m.provenance ?? 'unknown'}]: ${m.content}`);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Phase 9 — team memory (shared). Membership-gated: any ACTIVE team member
 * can read the team's memories; retrieval is scoped to team_id and never
 * crosses tenant boundaries. Teams module is imported lazily so module load
 * stays free of cross-module side effects for non-team callers.
 */
export interface TeamMemoryFilters {
  projectId?: string;
  type?: MemoryType;
  search?: string;
  minConfidence?: number;
  limit?: number;
  offset?: number;
}

export async function listTeamMemories(
  userId: string,
  teamId: string,
  opts: TeamMemoryFilters = {},
): Promise<{ items: MemoryRow[]; total: number }> {
  const { teamRoleFor } = await import('../teams/service.js');
  const role = await teamRoleFor(userId, teamId);
  if (!role) throw AppError.forbidden('insufficient_permission');
  const conditions: string[] = ['team_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [teamId];
  if (opts.projectId) {
    params.push(opts.projectId);
    conditions.push(`project_id = $${params.length}`);
  }
  if (opts.type) {
    params.push(opts.type);
    conditions.push(`type = $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    conditions.push(`(content ILIKE $${params.length} OR provenance ILIKE $${params.length})`);
  }
  if (opts.minConfidence !== undefined) {
    params.push(Math.max(0, Math.min(1, opts.minConfidence)));
    conditions.push(`confidence >= $${params.length}`);
  }
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  return withTenant(userId, async (q) => {
    const count = await q.query(
      `SELECT count(*)::int AS n FROM memories WHERE ${conditions.join(' AND ')}`,
      params.slice(0, params.length - 2),
    );
    const items = (
      await q.query<MemoryRow>(
        `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
         ORDER BY (CASE confidence WHEN 0 THEN 1 ELSE 0 END), created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      )
    ).rows;
    return { items, total: count.rows[0]?.n ?? 0 };
  });
}

/** Prompt-safe team memory: membership-gated, confidence + contradiction gated. */
export async function retrieveTeamMemoriesForPrompt(userId: string, teamId: string, limit = 8): Promise<string[]> {
  const { teamRoleFor } = await import('../teams/service.js');
  const role = await teamRoleFor(userId, teamId);
  if (!role) throw AppError.forbidden('insufficient_permission');
  const rows = await withTenant(userId, async (q) => (
    await q.query<MemoryRow>(
      `SELECT * FROM memories
       WHERE team_id = $1 AND deleted_at IS NULL AND contradiction_state <> 'CONFIRMED'
       ORDER BY (CASE WHEN confidence >= 0.8 THEN 0 WHEN confidence >= 0.5 THEN 1 ELSE 2 END), created_at DESC
       LIMIT $2`,
      [teamId, limit * 2],
    )
  ).rows);
  const out: string[] = [];
  for (const m of rows) {
    if (!confidenceGate(m)) continue;
    out.push(`[${m.source} @ ${m.provenance ?? 'unknown'}]: ${m.content}`);
    if (out.length >= limit) break;
  }
  return out;
}

/** Semantic search: pgvector when embeddings exist, otherwise keyword + recency. */
export async function semanticSearch(userId: string, query: string, projectId?: string | null, limit = 10): Promise<MemoryRow[]> {
  try {
    const embedding = await embeddingFor(query);
    if (embedding) {
      const params: unknown[] = [userId, projectId ?? null, embedding, limit];
      const rows = await withTenant(userId, async (q) => (
        await q.query<MemoryRow>(
          `SELECT * FROM memories
           WHERE owner_id = $1 AND deleted_at IS NULL AND embedding IS NOT NULL
             AND ($2::text IS NULL OR project_id = $2)
           ORDER BY embedding <=> $3::vector
           LIMIT $4`,
          params,
        )
      ).rows);
      if (rows.length) return rows;
    }
  } catch (err) {
    logger.warn('vector search failed, falling back to keyword', { error: (err as Error).message });
  }
  return withTenant(userId, async (q) => (
    await q.query<MemoryRow>(
      `SELECT * FROM memories
       WHERE owner_id = $1 AND deleted_at IS NULL
         AND ($2::text IS NULL OR project_id = $2)
         AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $3)
       ORDER BY created_at DESC LIMIT $4`,
      [userId, projectId ?? null, query, limit],
    )
  ).rows);
}

/**
 * Embedding provider: OpenAI embeddings when configured; otherwise NULL
 * (honest — pgvector requires a real embedding pipeline).
 */
export async function embeddingFor(text: string): Promise<number[] | null> {
  const env = (await import('../../config/env.js')).env;
  if (!env.OPENAI_API_KEY) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
      // Hard deadline (mirrors the AI gateway's per-request timeout): an
      // unbounded fetch here would hang semantic search and memory creation.
      signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { data?: { embedding?: number[] }[] };
    if (!payload.data?.[0]?.embedding) return null;
    const embedding = payload.data[0].embedding;
    if (embedding.length !== 1536) return null;
    return embedding;
  } catch {
    return null;
  }
}

export async function backfillEmbedding(memoryId: string): Promise<void> {
  const rows = await withSystem(async (q) => (
    await q.query<{ id: string; content: string }>(
      'SELECT id, content FROM memories WHERE id = $1 AND embedding IS NULL',
      [memoryId],
    )
  ).rows);
  const memory = rows[0];
  if (!memory) return;
  const embedding = await embeddingFor(memory.content);
  if (!embedding) return;
  await withSystem(async (q) => {
    await q.query('UPDATE memories SET embedding = $1::vector WHERE id = $2', [JSON.stringify(embedding), memory.id]);
  });
}

// ---------------------------------------------------------------- Phase 6: real embeddings

/**
 * Ensure a memory has a real embedding. Provider missing → QUEUED (honest
 * backlog for the background queue). Provider failure → FAILED (never a fake
 * vector). Success → READY with model + dimensions recorded.
 */
export async function ensureEmbedding(memoryId: string): Promise<'QUEUED' | 'FAILED' | 'READY'> {
  const rows = await withSystem(async (q) => (
    await q.query<{ id: string; content: string; embedding_status: string }>(
      'SELECT id, content, embedding_status FROM memories WHERE id = $1 AND deleted_at IS NULL',
      [memoryId],
    )
  ).rows);
  const memory = rows[0];
  if (!memory) return 'QUEUED';
  if (memory.embedding_status === 'READY') return 'READY';
  const provider = getEmbeddingProvider();
  if (!provider) {
    await withSystem(async (q) => {
      await q.query("UPDATE memories SET embedding_status = 'QUEUED' WHERE id = $1", [memoryId]);
    });
    return 'QUEUED';
  }
  try {
    const embedding = await provider.embed(memory.content);
    if (!isVectorValid(embedding)) throw new Error('embedding provider returned an invalid vector');
    await withSystem(async (q) => {
      await q.query(
        `UPDATE memories SET embedding = $1::vector, embedding_status = 'READY',
           embedding_model = $2, embedding_dimensions = $3 WHERE id = $4`,
        [JSON.stringify(embedding), provider.model, provider.dimensions, memoryId],
      );
    });
    await recordAudit({
      action: AuditAction.MEMORY_EMBEDDED,
      actorUserId: null,
      scope: 'SYSTEM',
      tenantId: null,
      resourceType: 'memory',
      resourceId: memoryId,
      detail: { model: provider.model, dimensions: provider.dimensions },
    });
    return 'READY';
  } catch (err) {
    logger.warn('embedding failed', { memoryId, error: (err as Error).message });
    await withSystem(async (q) => {
      await q.query("UPDATE memories SET embedding_status = 'FAILED' WHERE id = $1", [memoryId]);
    });
    return 'FAILED';
  }
}

/** Background queue: embed QUEUED memories (bounded batch). Returns processed count. */
export async function processEmbeddingQueue(limit = 20): Promise<number> {
  const provider = getEmbeddingProvider();
  if (!provider) return 0;
  const rows = await withSystem(async (q) => (
    await q.query<{ id: string; content: string }>(
      `SELECT id, content FROM memories WHERE embedding_status = 'QUEUED' AND deleted_at IS NULL
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    )
  ).rows);
  let processed = 0;
  for (const row of rows) {
    try {
      const embedding = await provider.embed(row.content);
      if (!isVectorValid(embedding)) throw new Error('invalid embedding vector');
      await withSystem(async (q) => {
        await q.query(
          `UPDATE memories SET embedding = $1::vector, embedding_status = 'READY',
             embedding_model = $2, embedding_dimensions = $3 WHERE id = $4`,
          [JSON.stringify(embedding), provider.model, provider.dimensions, row.id],
        );
      });
      processed += 1;
    } catch (err) {
      logger.warn('queue embedding failed', { memoryId: row.id, error: (err as Error).message });
      await withSystem(async (q) => {
        await q.query("UPDATE memories SET embedding_status = 'FAILED' WHERE id = $1", [row.id]);
      });
    }
  }
  return processed;
}

// ---------------------------------------------------------------- Phase 6: real retrieval (search)

export interface SearchMemoriesOptions {
  query: string;
  mode?: 'VECTOR' | 'FULL_TEXT' | 'HYBRID';
  projectId?: string | null;
  searchAll?: boolean;
  type?: MemoryType | null;
  minConfidence?: number | null;
  verification?: string | null;
  contradiction?: string | null;
  limit?: number;
}

export interface SearchMemoriesResult {
  modeUsed: 'VECTOR' | 'FULL_TEXT' | 'HYBRID';
  items: MemoryRow[];
}

function buildSearchConditions(userId: string, opts: { projectId?: string | null; searchAll?: boolean; type?: MemoryType | null; minConfidence?: number | null; verification?: string | null; contradiction?: string | null }): {
  conditions: string[];
  params: unknown[];
} {
  const conditions: string[] = ['owner_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [userId];
  if (opts.searchAll) {
    conditions.push('($2::text IS NULL OR project_id = $2 OR team_id IS NOT NULL)');
    params.push(opts.projectId ?? null);
  } else if (opts.projectId) {
    conditions.push('project_id = $2');
    params.push(opts.projectId);
  } else {
    // Default: CURRENT PROJECT ONLY — without a project id, personal scope.
    conditions.push('project_id IS NULL');
  }
  if (opts.type) {
    conditions.push(`type = $${params.length + 1}`);
    params.push(opts.type);
  }
  if (opts.minConfidence !== undefined && opts.minConfidence !== null) {
    conditions.push(`confidence >= $${params.length + 1}`);
    params.push(opts.minConfidence);
  }
  if (opts.verification) {
    conditions.push(`verification_state = $${params.length + 1}`);
    params.push(opts.verification);
  }
  if (opts.contradiction) {
    conditions.push(`contradiction_state = $${params.length + 1}`);
    params.push(opts.contradiction);
  }
  return { conditions, params };
}

function fullTextSearch(
  cq: { query: (t: string, p?: unknown[]) => Promise<{ rows: MemoryRow[] }> },
  conditions: string[],
  params: unknown[],
  query: string,
  limit: number,
): Promise<MemoryRow[]> {
  const ftsParams = [...params, query, limit];
  return cq.query(
    `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
       AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $${params.length + 1})
     ORDER BY created_at DESC LIMIT $${params.length + 2}`,
    ftsParams,
  ).then((r) => r.rows);
}

/** Reciprocal-rank fusion for HYBRID results (k = 60, standard RRF). */
function mergeByReciprocalRank(vector: MemoryRow[], fts: MemoryRow[], limit: number): MemoryRow[] {
  const scores = new Map<string, number>();
  const byId = new Map<string, MemoryRow>();
  for (const m of [...vector, ...fts]) byId.set(m.id, m);
  const k = 60;
  vector.forEach((m, i) => scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + i + 1)));
  fts.forEach((m, i) => scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + i + 1)));
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id)!);
}

/**
 * Phase 6 real retrieval. Modes:
 *  - VECTOR:    pgvector cosine search (requires a configured embedding
 *               provider; honest fallback to FULL_TEXT if unavailable).
 *  - FULL_TEXT: Postgres FTS over content (always available).
 *  - HYBRID:    vector + FTS fused by reciprocal rank; degrades to FULL_TEXT
 *               when no embedding provider is configured.
 * Always owner-scoped; default scope is the current project only.
 */
export async function searchMemories(userId: string, opts: SearchMemoriesOptions): Promise<SearchMemoriesResult> {
  const mode = opts.mode ?? 'HYBRID';
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const { conditions, params } = buildSearchConditions(userId, opts);

  if (mode === 'VECTOR') {
    try {
      const embedding = await embedTextForSearch(opts.query);
      const vectorParams = [...params, embedding, limit];
      const rows = await withTenant(userId, async (q) => (
        await q.query<MemoryRow>(
          `SELECT * FROM memories WHERE ${conditions.join(' AND ')} AND embedding IS NOT NULL
           ORDER BY embedding <=> $${params.length + 1}::vector
           LIMIT $${params.length + 2}`,
          vectorParams,
        )
      ).rows);
      return { modeUsed: 'VECTOR', items: rows };
    } catch (err) {
      logger.warn('VECTOR search unavailable — honest fallback to FULL_TEXT', { error: (err as Error).message });
      return { modeUsed: 'FULL_TEXT', items: await withTenant(userId, (q) => fullTextSearch(q, conditions, params, opts.query, limit)) };
    }
  }

  if (mode === 'HYBRID') {
    try {
      const embedding = await embedTextForSearch(opts.query);
      const vectorRows = await withTenant(userId, async (q) => (
        await q.query<MemoryRow>(
          `SELECT * FROM memories WHERE ${conditions.join(' AND ')} AND embedding IS NOT NULL
           ORDER BY embedding <=> $${params.length + 1}::vector
           LIMIT $${params.length + 2}`,
          [...params, embedding, limit],
        )
      ).rows);
      const ftsRows = await withTenant(userId, (q) => fullTextSearch(q, conditions, params, opts.query, limit));
      return { modeUsed: 'HYBRID', items: mergeByReciprocalRank(vectorRows, ftsRows, limit) };
    } catch (err) {
      logger.warn('HYBRID search degraded to FULL_TEXT', { error: (err as Error).message });
      return { modeUsed: 'FULL_TEXT', items: await withTenant(userId, (q) => fullTextSearch(q, conditions, params, opts.query, limit)) };
    }
  }

  return { modeUsed: 'FULL_TEXT', items: await withTenant(userId, (q) => fullTextSearch(q, conditions, params, opts.query, limit)) };
}

async function embedTextForSearch(query: string): Promise<number[]> {
  const provider = getEmbeddingProvider();
  if (!provider) throw new Error('no embedding provider configured');
  const embedding = await provider.embed(query);
  if (!isVectorValid(embedding)) throw new Error('invalid embedding vector');
  return embedding;
}

// ---------------------------------------------------------------- Phase 6: corrections + relationships

export type CorrectionKind = 'FLAG_WRONG' | 'EDIT' | 'MERGE' | 'DELETE' | 'RESTORE';

/** Append-only provenance log; never rewritten. */
async function recordMemoryCorrection(input: {
  memoryId: string;
  correctMemoryId?: string | null;
  kind: CorrectionKind;
  reason?: string | null;
  actorUserId: string;
}): Promise<void> {
  await withTenant(input.actorUserId, async (q) => {
    await q.query(
      `INSERT INTO memory_corrections (id, memory_id, correct_memory_id, kind, reason, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [newId(PREFIX.MEMORY), input.memoryId, input.correctMemoryId ?? null, input.kind, input.reason ?? null, input.actorUserId],
    );
  });
}

/**
 * Explicit correction: mark a memory REJECTED + contradicted, create the
 * correction memory, link it via a supersedes relationship, and log the
 * correction. The superseded memory is never erased.
 */
export async function correctMemory(userId: string, memoryId: string, reason: string): Promise<MemoryRow> {
  const existing = await getMemory(userId, memoryId);
  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE memories SET contradiction_state = 'CONFIRMED', confidence = 0,
         verification_state = 'REJECTED', updated_at = now() WHERE id = $1`,
      [memoryId],
    );
  });
  const correction = await createMemory(userId, {
    projectId: existing.project_id ?? undefined,
    type: existing.type as MemoryType,
    source: MS.USER_STATED,
    content: `User correction: "${existing.content}" is wrong. ${reason}`.slice(0, 20_000),
    confidence: 0.9,
    provenance: `memory://${memoryId}`,
  });
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO memory_relationships (id, source_memory_id, target_memory_id, relation, weight)
       VALUES ($1,$2,$3,'supersedes',0.95)`,
      [newId(PREFIX.MEMORY), memoryId, correction.id],
    );
  });
  await recordMemoryCorrection({ memoryId, correctMemoryId: correction.id, kind: 'FLAG_WRONG', reason, actorUserId: userId });
  await recordAudit({
    action: AuditAction.MEMORY_CORRECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: memoryId,
    detail: { correctionId: correction.id, reason },
  });
  return getMemory(userId, memoryId);
}

/** Merge target into survivor: target is superseded, never erased. */
export async function mergeMemories(userId: string, targetId: string, intoId: string, note?: string): Promise<MemoryRow> {
  const target = await getMemory(userId, targetId);
  const into = await getMemory(userId, intoId);
  if (target.id === into.id) throw AppError.badRequest('merge_self', 'Cannot merge a memory into itself');
  await withTenant(userId, async (q) => {
    await q.query(
      `UPDATE memories SET superseded_by_id = $2, verification_state = 'REJECTED', updated_at = now() WHERE id = $1`,
      [target.id, into.id],
    );
    await q.query(
      `INSERT INTO memory_relationships (id, source_memory_id, target_memory_id, relation, weight)
       VALUES ($1,$2,$3,'supersedes',1)`,
      [newId(PREFIX.MEMORY), target.id, into.id],
    );
  });
  await recordMemoryCorrection({ memoryId: target.id, correctMemoryId: into.id, kind: 'MERGE', reason: note ?? null, actorUserId: userId });
  await recordAudit({
    action: AuditAction.MEMORY_MERGED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: target.id,
    detail: { intoId: into.id },
  });
  return getMemory(userId, target.id);
}

/** Verification state change (VERIFIED / REJECTED). */
export async function verifyMemory(userId: string, memoryId: string, state: 'VERIFIED' | 'REJECTED'): Promise<MemoryRow> {
  await getMemory(userId, memoryId);
  await withTenant(userId, async (q) => {
    await q.query(
      'UPDATE memories SET verification_state = $2, updated_at = now() WHERE id = $1',
      [memoryId, state],
    );
  });
  await recordAudit({
    action: state === 'VERIFIED' ? AuditAction.MEMORY_VERIFIED : AuditAction.MEMORY_REJECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: memoryId,
  });
  return getMemory(userId, memoryId);
}

export async function addMemoryRelationship(
  userId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  relation: string,
  weight = 0.5,
): Promise<void> {
  await getMemory(userId, sourceMemoryId);
  await getMemory(userId, targetMemoryId);
  await withTenant(userId, async (q) => {
    await q.query(
      `INSERT INTO memory_relationships (id, source_memory_id, target_memory_id, relation, weight)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId(PREFIX.MEMORY), sourceMemoryId, targetMemoryId, relation, Math.max(0, Math.min(1, weight))],
    );
  });
  await recordAudit({
    action: AuditAction.MEMORY_RELATIONSHIP_ADDED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'memory',
    resourceId: sourceMemoryId,
    detail: { targetId: targetMemoryId, relation },
  });
}

export async function listMemoryRelationships(userId: string, memoryId: string): Promise<unknown[]> {
  await getMemory(userId, memoryId);
  return withTenant(userId, async (q) => (
    await q.query(
      `SELECT id, source_memory_id, target_memory_id, relation, weight, created_at
       FROM memory_relationships WHERE source_memory_id = $1 OR target_memory_id = $1
       ORDER BY created_at DESC`,
      [memoryId],
    )
  ).rows);
}

/** Episodic memory extraction after each chat exchange (background, honest). */
export async function extractEpisodicMemory(input: {
  userId: string;
  conversationId: string;
  projectId?: string;
  content: string;
  response: string;
}): Promise<void> {
  const userMemory = `${input.content}`.slice(0, 5000);
  const summary = `${input.response}`.slice(0, 3000);
  const derived = `Exchange in conversation ${input.conversationId}: "${userMemory}" → ${summary}`.slice(0, 19000);
  await withTenant(input.userId, async (q) => {
    await q.query(
      `INSERT INTO memories (id, project_id, owner_id, type, source, content, confidence, provenance, contradiction_state)
       VALUES ($1,$2,$3,'EPISODIC','AI_INFERRED',$4,0.5,$5,'NONE')`,
      [
        newId(PREFIX.MEMORY),
        input.projectId ?? null,
        input.userId,
        redactSecrets(derived),
        `conversation://${input.conversationId}`,
      ],
    );
  }).catch((err) => logger.warn('episodic memory extract failed', { error: (err as Error).message }));
}

function toConfidence(value: number): Memory['confidence'] {
  const levels = [0.33, 0.66, 0.99] as const;
  let best: Memory['confidence'] = levels[0]!;
  for (const level of levels) {
    if (Math.abs(value - level) < Math.abs(value - best)) best = level;
  }
  return best;
}

export function toMemoryJson(m: MemoryRow): Memory {  return {
    id: m.id,
    projectId: m.project_id,
    teamId: m.team_id,
    ownerId: m.owner_id,
    type: m.type as Memory['type'],
    source: m.source as Memory['source'],
    content: m.content,
    structured: m.structured,
    confidence: toConfidence(Number(m.confidence)),
    provenance: m.provenance,
    contradictionState: m.contradiction_state as Memory['contradictionState'],
    supersededById: m.superseded_by_id,
    embeddingStatus: m.embedding_status as Memory['embeddingStatus'],
    embeddingModel: m.embedding_model ?? null,
    verificationState: m.verification_state as Memory['verificationState'],
    scope: m.scope as Memory['scope'],
    deletedAt: m.deleted_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}