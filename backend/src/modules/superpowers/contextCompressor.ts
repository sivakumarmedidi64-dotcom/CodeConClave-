/**
 * CodeConClave — Superpowers: CONTEXT COMPRESSOR (Master Feature #27).
 *
 * Turns 10,000 lines of discussion, 50 commits, and 3 postmortems into one
 * dense, accurate, cited paragraph. Each surviving sentence cites the source
 * it came from, so the compressed context loads in milliseconds instead of
 * parsing history.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ContextCompressionRow {
  id: string;
  owner_id: string;
  topic: string;
  source_count: number;
  density: number;
  summary: string;
  citations: string[];
  created_at: Date;
}

const DOMAIN_WORDS = ['commit', 'error', 'bug', 'fix', 'release', 'decided', 'assumed', 'latency', 'security', 'review', 'broke', 'deploy', 'validation', 'migration'];
const MAX_SENTENCES = 5;

const rowOf = (r: Record<string, unknown>): ContextCompressionRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  topic: String(r.topic),
  source_count: Number(r.source_count),
  density: Number(r.density),
  summary: String(r.summary),
  citations: (r.citations ?? []) as string[],
  created_at: new Date(r.created_at as string),
});

const words = (t: string) => t.split(/\s+/).filter((w) => w.length > 0);

function sentenceImpact(topic: string, sentence: string): number {
  let score = words(sentence).length > 4 ? 2 : 1;
  const lower = sentence.toLowerCase();
  const topicTerms = words(topic).filter((w) => w.length > 3);
  for (const term of topicTerms) if (new RegExp(`\\b${term}`).test(lower)) score += 1;
  for (const term of DOMAIN_WORDS) if (new RegExp(`\\b${term}`).test(lower)) score += 1;
  return score;
}

/** Picks the single most informative sentence per source and cites it. */
export function compressText(topic: string, sources: string[]): { summary: string; density: number; citations: string[] } {
  const selected: Array<{ sentence: string; citation: string }> = [];
  const seen = new Set<string>();
  let totalWords = 0;

  sources.forEach((source, i) => {
    totalWords += words(source).length;
    const sentences = source.split(/[.!?]+\s+/).map((s) => s.trim().replace(/[.!?]+$/, '')).filter((s) => s.length > 0);
    let best: { sentence: string; score: number } | null = null;
    for (const s of sentences) {
      const score = sentenceImpact(topic, s);
      if (!best || score > best.score) best = { sentence: s, score };
    }
    if (best && !seen.has(best.sentence)) {
      seen.add(best.sentence);
      selected.push({ sentence: best.sentence, citation: `source ${i + 1}` });
    }
    if (selected.length >= MAX_SENTENCES) return;
  });

  const summary = selected.map((s, idx) => `${s.sentence} [${idx + 1}]`).join(' ');
  const summaryWords = words(summary).length;
  const density = totalWords > 0 ? Math.round((summaryWords / totalWords) * 100) : 0;
  return { summary, density, citations: selected.map((s) => s.citation) };
}

export async function compressContext(userId: string, input: { topic: string; sources: string[] }): Promise<ContextCompressionRow> {
  if (!input.topic || typeof input.topic !== 'string') throw AppError.badRequest('invalid_topic', 'a topic is required');
  if (!Array.isArray(input.sources) || input.sources.length === 0) throw AppError.badRequest('empty_sources', 'at least one source is required to compress');
  const { summary, density, citations } = compressText(input.topic, input.sources);
  const id = newId(PREFIX.CONTEXT_COMPRESSION);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO context_compressions (id, owner_id, topic, source_count, density, summary, citations) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, input.topic, input.sources.length, density, summary, citations],
  ));
  await recordAudit({
    action: AuditAction.CONTEXT_COMPRESSED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'context_compressions',
    resourceId: id,
    detail: { topic: input.topic, sources: input.sources.length, density },
  });
  return getCompression(userId, id);
}

export async function getCompression(userId: string, id: string): Promise<ContextCompressionRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM context_compressions WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('context_compression_not_found', 'no context compression found for that id');
  return rowOf(row);
}

export async function listCompressions(userId: string): Promise<ContextCompressionRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM context_compressions WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function contextCompressorReport(userId: string): Promise<{ compressions: number; avg_density: number; total_sources: number }> {
  const compressions = await listCompressions(userId);
  return {
    compressions: compressions.length,
    avg_density: compressions.length ? Math.round(compressions.reduce((s, c) => s + c.density, 0) / compressions.length) : 0,
    total_sources: compressions.reduce((s, c) => s + c.source_count, 0),
  };
}