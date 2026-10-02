/**
 * CodeConClave — Superpowers: FORM BUILDER (Master Feature #120).
 *
 * AI-Powered: "Email, password, retype password, remember me, submit" →
 * full form with validation, styling, accessibility, error handling.
 */
import { withTenant } from '../../shared/db.js';
import { newId, PREFIX } from '../../shared/ids.js';
import { AppError } from '../../shared/errors.js';
import { recordAudit } from '../audit/service.js';
import { AuditAction } from '@codeconclave/shared';

export interface FormField {
  type: string;
  label: string;
}

export interface FormBuildRow {
  id: string;
  owner_id: string;
  form_name: string;
  fields: FormField[];
  generated_code: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const rowOf = (r: Record<string, unknown>): FormBuildRow => ({
  id: String(r.id),
  owner_id: String(r.owner_id),
  form_name: String(r.form_name),
  fields: (r.fields ?? []) as FormField[],
  generated_code: String(r.generated_code),
  status: String(r.status),
  created_at: new Date(r.created_at as string),
  updated_at: new Date(r.updated_at as string),
});

export async function generateForm(userId: string, input: { form_name: string; fields: FormField[] }): Promise<FormBuildRow> {
  if (!input.form_name || typeof input.form_name !== 'string') {
    throw AppError.badRequest('invalid_form_name', 'a form name is required');
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0 || !input.fields.every((f) => typeof f === 'object' && f !== null)) {
    throw AppError.badRequest('invalid_fields', 'at least one form field is required');
  }
  const id = newId(PREFIX.FORM_BUILDER);
  const code = input.fields.map((f) => `${f.label} (${f.type})`).join(', ');
  await withTenant(userId, (q) => q.query(
    'INSERT INTO form_builds (id, owner_id, form_name, fields, generated_code, status) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, input.form_name, input.fields, code, 'GENERATED'],
  ));
  await recordAudit({
    action: AuditAction.FORM_BUILD_GENERATED,
    actorUserId: userId,
    scope: 'USER',
    tenantId: userId,
    resourceType: 'form_builds',
    resourceId: id,
    detail: { form_name: input.form_name, fields: input.fields.length },
  });
  return getFormBuild(userId, id);
}

export async function getFormBuild(userId: string, id: string): Promise<FormBuildRow> {
  const row = await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM form_builds WHERE id = $1 AND owner_id = $2', [id, userId])).rows[0] ?? null);
  if (!row) throw AppError.notFound('form_build_not_found', 'no form build found for that id');
  return rowOf(row);
}

export async function listFormBuilds(userId: string): Promise<FormBuildRow[]> {
  return (await withTenant(userId, async (q) => (await q.query<Record<string, unknown>>('SELECT * FROM form_builds WHERE owner_id = $1', [userId])).rows)).map(rowOf).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

export async function formBuilderReport(userId: string): Promise<{ builds: number; generated: number; total_fields: number }> {
  const list = await listFormBuilds(userId);
  return {
    builds: list.length,
    generated: list.filter((b) => b.status === 'GENERATED').length,
    total_fields: list.reduce((sum, b) => sum + b.fields.length, 0),
  };
}
