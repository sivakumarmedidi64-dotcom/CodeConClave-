/**
 * CodeConClave — Superpowers: INTENT MARKETPLACE (#154).
 *
 * Publish intents ("make onboarding 20% faster") instead of tasks; agents bid
 * with approaches, impact, confidence; you pick a bid.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface IntentBidRow {
  id: string;
  owner_id: string;
  intent_text: string;
  agent_name: string;
  approach: string;
  impact_score: number;
  confidence: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): IntentBidRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  intent_text: String(r.intent_text),
  agent_name: String(r.agent_name),
  approach: String(r.approach),
  impact_score: Number(r.impact_score),
  confidence: Number(r.confidence),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function createIntentBid(userId: string, input: { intent_text: string; agent_name: string; approach: string; impact_score: number; confidence: number }): Promise<IntentBidRow> {
  if (!input.intent_text || typeof input.intent_text !== 'string') throw AppError.badRequest('invalid_intent_text', 'intent text is required');
  if (!input.agent_name || typeof input.agent_name !== 'string') throw AppError.badRequest('invalid_agent_name', 'agent name is required');
  if (!input.approach || typeof input.approach !== 'string') throw AppError.badRequest('invalid_approach', 'approach is required');
  if (typeof input.impact_score !== 'number' || input.impact_score < 1) throw AppError.badRequest('invalid_impact_score', 'impact score must be at least 1');
  if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) throw AppError.badRequest('invalid_confidence', 'confidence must be between 0 and 1');
  const id = newId(PREFIX.INTENT_BID);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO intent_bids (id, owner_id, intent_text, agent_name, approach, impact_score, confidence, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, userId, input.intent_text, input.agent_name, input.approach, input.impact_score, input.confidence, 'PUBLISHED'],
  ));
  await recordAudit({
    action: AuditAction.INTENT_PUBLISHED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'intent_bids',
    resourceId: id,
    detail: { intent_text: input.intent_text, agent_name: input.agent_name },
  });
  return getIntentBid(userId, id);
}

export async function selectBid(userId: string, id: string): Promise<IntentBidRow> {
  const bid = await getIntentBid(userId, id);
  if (bid.status !== 'PUBLISHED') throw AppError.badRequest('bid_not_selectable', 'only published bids can be selected');
  await withTenant(userId, (q) => q.query(
    'UPDATE intent_bids SET status = $2, updated_at = now() WHERE id = $1 AND owner_id = $3',
    [id, 'SELECTED', userId],
  ));
  await recordAudit({
    action: AuditAction.INTENT_BID_SELECTED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'intent_bids',
    resourceId: id,
    detail: { intent_text: bid.intent_text, agent_name: bid.agent_name },
  });
  return getIntentBid(userId, id);
}

export async function getIntentBid(userId: string, id: string): Promise<IntentBidRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM intent_bids WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('intent_bid_not_found', 'no intent bid found for that id');
  return rowOf(row);
}

export async function listIntentBids(userId: string): Promise<IntentBidRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM intent_bids WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function intentMarketplaceReport(userId: string): Promise<{ bids: number; published: number; selected: number; withdrawn: number }> {
  const bids = await listIntentBids(userId);
  return {
    bids: bids.length,
    published: bids.filter((b) => b.status === 'PUBLISHED').length,
    selected: bids.filter((b) => b.status === 'SELECTED').length,
    withdrawn: bids.filter((b) => b.status === 'WITHDRAWN').length,
  };
}
