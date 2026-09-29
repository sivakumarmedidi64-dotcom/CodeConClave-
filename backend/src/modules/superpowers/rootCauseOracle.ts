/**
 * CodeConClave — Superpowers: ROOT CAUSE ORACLE (Master Feature #19).
 *
 * Given any symptom, walks the entire causal chain — not "this error happens
 * at line 42" but "line 42 keeps failing because a decision six months ago
 * deferred validation to the background job, and that decision assumed X."
 * The chain is the answer.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type CausalHop = 'service' | 'function' | 'commit' | 'decision' | 'human';

export interface CausalClue {
  hop: CausalHop;
  label: string;
  note: string;
  confidence: number;
}

export interface CausalChainRow {
  id: string;
  owner_id: string;
  symptom: string;
  chain: CausalClue[];
  confidence: number;
  ruled_out: string[];
  verdict: string;
  status: 'OPEN' | 'RESOLVED';
  resolution: string | null;
  created_at: Date;
}

const HOP_ORDER: CausalHop[] = ['service', 'function', 'commit', 'decision', 'human'];

const rowOf = (r: Record<string, unknown>): CausalChainRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  symptom: String(r.symptom),
  chain: (r.chain ?? []) as CausalClue[],
  confidence: Number(r.confidence),
  ruled_out: (r.ruled_out ?? []) as string[],
  verdict: String(r.verdict),
  status: r.status as CausalChainRow['status'],
  resolution: r.resolution === null || r.resolution === undefined ? null : String(r.resolution),
  created_at: new Date(r.created_at as string),
});

/** Orders causal hops and computes a chain confidence. */
export function buildChain(clues: CausalClue[]): { chain: CausalClue[]; confidence: number; origin: string } {
  const ordered = [...clues].sort((a, b) => HOP_ORDER.indexOf(a.hop) - HOP_ORDER.indexOf(b.hop));
  const confidence = Math.round(ordered.reduce((p, c) => p * c.confidence, 1) * 1000) / 1000;
  const origin = ordered[ordered.length - 1];
  return { chain: ordered, confidence, origin: origin ? `${origin.hop}:${origin.label}` : 'unknown' };
}

export async function analyzeSymptom(
  userId: string,
  input: { symptom: string; clues: CausalClue[]; ruledOut?: string[] },
): Promise<CausalChainRow> {
  if (!input.symptom || typeof input.symptom !== 'string') throw AppError.badRequest('invalid_symptom', 'a symptom description is required');
  if (!Array.isArray(input.clues) || input.clues.length < 2) throw AppError.badRequest('too_few_clues', 'at least 2 causal clues are needed to build a chain');
  for (const c of input.clues) {
    if (!HOP_ORDER.includes(c.hop)) throw AppError.badRequest('invalid_hop', `${c.hop} is not a valid causal hop`);
    if (typeof c.confidence !== 'number' || c.confidence <= 0 || c.confidence > 1) throw AppError.badRequest('invalid_confidence', 'hop confidence must be between 0 and 1');
  }
  const { chain, confidence, origin } = buildChain(input.clues);
  const ruledOut = (input.ruledOut ?? []).map((r) => r.trim()).filter(Boolean);
  const verdict = `the true origin of "${input.symptom}" is ${origin} (chain confidence ${confidence})`;

  const id = newId(PREFIX.CAUSAL_CHAIN);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO causal_chains (id, owner_id, symptom, chain, confidence, ruled_out, verdict, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.symptom, chain, confidence, ruledOut, verdict, 'OPEN'],
  ));
  await recordAudit({
    action: AuditAction.CAUSAL_TRACE_COMPLETED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'causal_chains',
    resourceId: id,
    detail: { symptom: input.symptom, confidence, origin },
  });
  return getCausalChain(userId, id);
}

export async function resolveTrace(userId: string, id: string, resolution: string): Promise<CausalChainRow> {
  const chain = await getCausalChain(userId, id);
  if (chain.status !== 'OPEN') throw AppError.badRequest('trace_already_resolved', 'this causal trace is already resolved');
  if (!resolution || typeof resolution !== 'string') throw AppError.badRequest('invalid_resolution', 'a resolution note is required');
  await withTenant(userId, (q) => q.query('UPDATE causal_chains SET status = $2, resolution = $3, updated_at = now() WHERE id = $1 AND owner_id = $4', [id, 'RESOLVED', resolution, userId]));
  await recordAudit({
    action: AuditAction.CAUSAL_TRACE_RESOLVED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'causal_chains',
    resourceId: id,
    detail: { symptom: chain.symptom, resolution },
  });
  return getCausalChain(userId, id);
}

export async function getCausalChain(userId: string, id: string): Promise<CausalChainRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM causal_chains WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('causal_chain_not_found', 'no causal chain found for that id');
  return rowOf(row);
}

export async function listCausalChains(userId: string): Promise<CausalChainRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM causal_chains WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function rootCauseReport(userId: string): Promise<{ traces: number; open: number; resolved: number; avg_confidence: number }> {
  const chains = await listCausalChains(userId);
  return {
    traces: chains.length,
    open: chains.filter((c) => c.status === 'OPEN').length,
    resolved: chains.filter((c) => c.status === 'RESOLVED').length,
    avg_confidence: chains.length ? Math.round((chains.reduce((s, c) => s + c.confidence, 0) / chains.length) * 1000) / 1000 : 0,
  };
}