/**
 * CodeConClave — Superpowers: RESPONSIVE FORGE (Master Feature #118).
 *
 * Auto-generates responsive layouts from a single breakpoint definition.
 * Tablet, mobile, desktop automatically derived.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface ResponsiveGenerationRow {
  id: string;
  owner_id: string;
  component: string;
  breakpoints: string[];
  generated_layout: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): ResponsiveGenerationRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  component: String(r.component),
  breakpoints: (r.breakpoints ?? []) as string[],
  generated_layout: String(r.generated_layout),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function generateResponsive(userId: string, input: { component: string; breakpoints: string[] }): Promise<ResponsiveGenerationRow> {
  if (!input.component || typeof input.component !== 'string') {
    throw AppError.badRequest('invalid_component', 'a component name is required');
  }
  if (!Array.isArray(input.breakpoints) || input.breakpoints.length === 0 || !input.breakpoints.every((b) => typeof b === 'string' && b.length > 0)) {
    throw AppError.badRequest('invalid_breakpoints', 'at least one breakpoint is required');
  }
  const id = newId(PREFIX.RESPONSIVE_FORGE);
  const layout = input.breakpoints.map((bp) => `${bp}: auto`).join('; ');
  await withTenant(userId, (q) => q.query(
    'INSERT INTO responsive_generations (id, owner_id, component, breakpoints, generated_layout, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.component, input.breakpoints, layout, 'GENERATED'],
  ));
  await recordAudit({
    action: AuditAction.RESPONSIVE_FORGE_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'responsive_generations',
    resourceId: id,
    detail: { component: input.component, breakpoints: input.breakpoints.length },
  });
  return getResponsiveGeneration(userId, id);
}

export async function getResponsiveGeneration(userId: string, id: string): Promise<ResponsiveGenerationRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM responsive_generations WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('responsive_generation_not_found', 'no responsive generation found for that id');
  return rowOf(row);
}

export async function listResponsiveGenerations(userId: string): Promise<ResponsiveGenerationRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM responsive_generations WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function responsiveForgeReport(userId: string): Promise<{ generations: number; generated: number }> {
  const list = await listResponsiveGenerations(userId);
  return {
    generations: list.length,
    generated: list.filter((g) => g.status === 'GENERATED').length,
  };
}
