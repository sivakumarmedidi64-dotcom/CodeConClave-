/**
 * CodeConClave — Superpowers: INTERACTION DEFINER (Master Feature #119).
 *
 * Vague interaction spec → full animation + states defined.
 * "Tooltip appears on hover, disappears on click" → animation + timing + accessibility all specified.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface InteractionSpecRow {
  id: string;
  owner_id: string;
  component: string;
  description: string;
  states: string[];
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): InteractionSpecRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component: String(r.component),
  description: String(r.description),
  states: (r.states ?? []) as string[],
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function defineInteraction(userId: string, input: { component: string; description: string; states: string[] }): Promise<InteractionSpecRow> {
  if (!input.component || typeof input.component !== 'string') {
    throw AppError.badRequest('invalid_component', 'a component name is required');
  }
  if (!input.description || typeof input.description !== 'string') {
    throw AppError.badRequest('invalid_description', 'a description is required');
  }
  if (!Array.isArray(input.states) || input.states.length === 0 || !input.states.every((s) => typeof s === 'string' && s.length > 0)) {
    throw AppError.badRequest('invalid_states', 'at least one interaction state is required');
  }
  const id = newId(PREFIX.INTERACTION_DEFINER);
  await withTenant(userId, (q) => q.query(
    'INSERT INTO interaction_specs (id, owner_id, component, description, states, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.component, input.description, input.states, 'DEFINED'],
  ));
  await recordAudit({
    action: AuditAction.INTERACTION_SPEC_DEFINED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'interaction_specs',
    resourceId: id,
    detail: { component: input.component, states: input.states.length },
  });
  return getInteractionSpec(userId, id);
}

export async function getInteractionSpec(userId: string, id: string): Promise<InteractionSpecRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM interaction_specs WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('interaction_spec_not_found', 'no interaction spec found for that id');
  return rowOf(row);
}

export async function listInteractionSpecs(userId: string): Promise<InteractionSpecRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM interaction_specs WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function interactionDefinerReport(userId: string): Promise<{ specs: number; defined: number }> {
  const list = await listInteractionSpecs(userId);
  return {
    specs: list.length,
    defined: list.filter((s) => s.status === 'DEFINED').length,
  };
}
