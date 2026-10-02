/**
 * CodeConClave — Superpowers: PATTERN PROPHET (Master Feature #24).
 *
 * Watches how a team solves problems and pre-builds the scaffolding before it
 * is asked. A pattern is "learned" from a concrete team solution (the trigger
 * that matched it and the exact steps of the solution shape). On a matching
 * trigger, the pattern is offered/applied with a "team pattern applied" flag;
 * the team accepts or declines, feeding the certification state.
 *
 * Deterministic, owner-scoped, audited, one-per (owner, trigger_type, trigger).
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export type PatternTriggerType = 'SCHEMA_CHANGE' | 'ENDPOINT_ADD' | 'NEW_MODULE' | 'DEPENDENCY_UPGRADE';

export interface PatternInput {
  triggerType: PatternTriggerType;
  trigger: string;
  steps: string[];
  projectId?: string | null;
}

export interface PatternRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  trigger_type: PatternTriggerType;
  trigger: string;
  steps: string[];
  usage_count: number;
  certified: boolean;
  status: 'ENABLED' | 'DISABLED';
  created_at: Date;
  updated_at: Date;
}

const TRIGGER_TYPES: PatternTriggerType[] = ['SCHEMA_CHANGE', 'ENDPOINT_ADD', 'NEW_MODULE', 'DEPENDENCY_UPGRADE'];

export const rowOfPattern = (r: Record<string, unknown>): PatternRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  project_id: r.project_id ? String(r.project_id) : null,
  trigger_type: r.trigger_type as PatternTriggerType,
  trigger: String(r.trigger),
  steps: Array.isArray(r.steps) ? (r.steps as string[]) : [],
  usage_count: Number(r.usage_count),
  certified: Boolean(r.certified),
  status: r.status as PatternRow['status'],
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function findPatternById(userId: string, id: string): Promise<PatternRow> {
  const row = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM pattern_signatures WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null,
  );
  if (!row) throw AppError.notFound('pattern_not_found', 'no pattern found for that id');
  return rowOfPattern(row);
}

export async function learnPattern(userId: string, input: PatternInput): Promise<PatternRow> {
  const triggerType = String(input.triggerType ?? '').trim() as PatternTriggerType;
  const trigger = String(input.trigger ?? '').trim();
  const steps = Array.isArray(input.steps) ? input.steps.filter((s) => String(s).trim()) : [];
  if (!TRIGGER_TYPES.includes(triggerType)) throw AppError.badRequest('invalid_trigger_type', 'unknown trigger type');
  if (!trigger) throw AppError.badRequest('invalid_trigger', 'trigger is required');
  if (steps.length === 0) throw AppError.badRequest('invalid_steps', 'at least one scaffold step is required');

  const existing = await withTenant<Record<string, unknown> | null>(userId, async (q) =>
    (await q.query<Record<string, unknown>>(
      'SELECT * FROM pattern_signatures WHERE owner_id = $1 AND trigger_type = $2 AND trigger = $3',
      [userId, triggerType, trigger],
    )).rows[0] ?? null,
  );
  const id = existing ? String(existing.id) : newId(PREFIX.PATTERN_SIGNATURE);
  if (existing) {
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE pattern_signatures SET steps = $1, updated_at = now() WHERE id = $2 AND owner_id = $3',
        [JSON.stringify(steps), id, userId],
      ),
    );
  } else {
    await withTenant(userId, (q) =>
      q.query(
        'INSERT INTO pattern_signatures (id, owner_id, project_id, trigger_type, trigger, steps) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, userId, input.projectId ?? null, triggerType, trigger, JSON.stringify(steps)],
      ),
    );
  }
  await recordAudit({
    action: AuditAction.PATTERN_LEARNED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pattern_signatures',
    resourceId: id,
    detail: { triggerType, trigger },
  });
  return findPatternById(userId, id);
}

/** Find the ENABLED pattern whose trigger matches the incoming trigger_type. */
export async function matchPattern(userId: string, triggerType: PatternTriggerType, trigger?: string): Promise<PatternRow | null> {
  const rows = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM pattern_signatures WHERE owner_id = $1', [userId])).rows,
  );
  const enabled = rows.map(rowOfPattern).filter((p) => p.status === 'ENABLED' && p.trigger_type === triggerType);
  if (enabled.length === 0) return null;
  const term = String(trigger ?? '').toLowerCase();
  const byExact = enabled.find((p) => p.trigger.toLowerCase() === term) ?? null;
  if (byExact) return byExact;
  return enabled.sort((a, b) => b.usage_count - a.usage_count)[0] ?? null;
}

/** Apply the matched (or explicitly chosen) pattern. Returns the scaffold + the "team pattern applied" flag. */
export async function applyPattern(userId: string, id: string, input: { trigger: string }): Promise<{ pattern: PatternRow; scaffold: string[]; flagged: boolean }> {
  const pattern = await findPatternById(userId, id);
  if (pattern.status === 'DISABLED') throw AppError.conflict('pattern_disabled', 'a disabled pattern cannot be applied');
  await withTenant(userId, (q) =>
    q.query('UPDATE pattern_signatures SET usage_count = usage_count + 1, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, userId]),
  );
  await recordAudit({
    action: AuditAction.PATTERN_APPLIED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pattern_signatures',
    resourceId: id,
    detail: { trigger: String(input.trigger ?? '') },
  });
  const bumped = await findPatternById(userId, id);
  return { pattern: bumped, scaffold: [...bumped.steps], flagged: true };
}

export async function certifyPattern(userId: string, id: string, approve: boolean): Promise<PatternRow> {
  const pattern = await findPatternById(userId, id);
  const status: PatternRow['status'] = approve ? 'ENABLED' : 'DISABLED';
  const certified = status === 'ENABLED';
  if (pattern.status !== status || pattern.certified !== certified) {
    await withTenant(userId, (q) =>
      q.query(
        'UPDATE pattern_signatures SET status = $1, certified = $2, updated_at = now() WHERE id = $3 AND owner_id = $4',
        [status, certified, id, userId],
      ),
    );
  }
  await recordAudit({
    action: approve ? AuditAction.PATTERN_ACCEPTED : AuditAction.PATTERN_DECLINED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'pattern_signatures',
    resourceId: id,
    detail: { trigger: pattern.trigger },
  });
  return findPatternById(userId, id);
}

export async function listPatterns(userId: string, filter: { triggerType?: PatternTriggerType; status?: PatternRow['status'] } = {}): Promise<PatternRow[]> {
  const raw = await withTenant<Record<string, unknown>[]>(userId, async (q) =>
    (await q.query<Record<string, unknown>>('SELECT * FROM pattern_signatures WHERE owner_id = $1', [userId])).rows,
  );
  let rows = raw.map(rowOfPattern);
  if (filter.triggerType) rows = rows.filter((p) => p.trigger_type === filter.triggerType);
  if (filter.status) rows = rows.filter((p) => p.status === filter.status);
  return rows.sort((a, b) => (b.usage_count - a.usage_count) || b.id.localeCompare(a.id));
}